/**
 * The authoritative simulation (brief §2.4).
 *
 * `World.tick(inputs)` is the entire contract: it mutates world state and
 * returns nothing. All randomness comes from `this.rng`, never Math.random(),
 * so a seed plus an input stream fully determines a match.
 *
 * The tick order in `tick()` is fixed and documented in the brief. Reordering
 * it changes game feel in subtle ways (e.g. resolving pickups before deaths
 * means gems dropped this tick can't be collected this tick) — do not shuffle
 * it casually.
 */

import { MATCH, TICK_DT, type Phase } from '../config/match.ts';
import { MAP, zoneAt, zoneYieldMultiplier } from '../config/map.ts';
import {
  UNIT_DEFS,
  harvesterMultiplier,
  scoutSpeedBonus,
  type UnitTier,
  type UnitType,
} from '../config/units.ts';
import { Rng } from '../math/rng.ts';
import { clamp, distanceSq, normalizeInto, type Vec2 } from '../math/vec2.ts';
import {
  decaySlow,
  resolveAttack,
  resolveHealing,
  type DamageEvent,
  type HealEvent,
} from './combat.ts';
import { TEAM_NEUTRAL, EntityStore, type Entity, type EntityId } from './entities.ts';
import { assignSlots, separate, slotPosition, steerToSlot, unitMoveSpeed } from './formation.ts';
import { applyFusions, type FusionResult } from './fusion.ts';
import { generateMap, isWallAt, type GeneratedMap } from './mapgen.ts';
import {
  CREEP_DAMAGE,
  CREEP_INTERVAL,
  CREEP_RANGE,
  chestPool,
  populateArena,
  spawnChest,
  spawnCreep,
  spawnGem,
  spawnLeader,
  spawnNode,
  spawnUnit,
  type CreepCamp,
} from './spawning.ts';

export type PlayerId = number;

export interface InputCommand {
  seq: number;
  dirX: number;
  dirY: number;
  /** Set when the player confirms a chest purchase choice (index into offer). */
  chestChoice?: number;
}

export interface PlayerState {
  id: PlayerId;
  index: number;
  name: string;
  leaderId: EntityId;
  gems: number;
  chestsOpened: number;
  nextChestPrice: number;
  respawnIn: number;
  connected: boolean;
  /** Radians; drives formation orientation. */
  facing: number;
  lastAckSeq: number;
  /** Pending chest offer awaiting a choice, if any. */
  offer: UnitType[] | null;
  offerChestId: EntityId;
  /** Set while the squad is wiped and waiting to respawn. */
  wiped: boolean;
}

export type WorldEvent =
  | { t: 'hit'; x: number; y: number; targetId: EntityId; amount: number }
  | { t: 'death'; x: number; y: number; id: EntityId; kind: string }
  | { t: 'gem'; x: number; y: number; player: PlayerId; value: number }
  | { t: 'fusion'; x: number; y: number; player: PlayerId; unit: UnitType; tier: UnitTier }
  | { t: 'chestOffer'; player: PlayerId; options: UnitType[]; price: number }
  | { t: 'chestOpen'; x: number; y: number; player: PlayerId; unit: UnitType }
  | { t: 'squadFight'; x: number; y: number; winner: PlayerId; loser: PlayerId; dropped: number }
  | { t: 'respawn'; player: PlayerId }
  | { t: 'phase'; phase: Phase };

const scratchVec: Vec2 = { x: 0, y: 0 };
const scratchSlot: Vec2 = { x: 0, y: 0 };

export class World {
  readonly store = new EntityStore();
  readonly players = new Map<PlayerId, PlayerState>();
  readonly rng: Rng;
  readonly map: GeneratedMap;

  tickNumber = 0;
  /** Seconds elapsed in the match. */
  elapsed = 0;
  phase: Phase = 'lobby';

  camps: CreepCamp[] = [];
  chestSpots: { x: number; y: number }[] = [];

  /** Events produced by the current tick; consumed and cleared by the host. */
  events: WorldEvent[] = [];

  private readonly damageBuf: DamageEvent[] = [];
  private readonly healBuf: HealEvent[] = [];
  /** Squad membership cache, rebuilt each tick. Reused to avoid allocation. */
  private readonly squads = new Map<PlayerId, Entity[]>();
  private nodeRespawns: { x: number; y: number; in: number }[] = [];
  private chestRespawns: { x: number; y: number; in: number }[] = [];

  constructor(seed: number, playerCount: number) {
    this.rng = new Rng(seed);
    this.map = generateMap(this.rng, playerCount);
    const populated = populateArena(this.store, this.map.tiles, this.rng);
    this.camps = populated.camps;
    this.chestSpots = populated.chestSpots;
  }

  // ── players ───────────────────────────────────────────────────────────────

  addPlayer(id: PlayerId, name: string): PlayerState {
    const index = this.players.size;
    const pad = this.map.homePads[index % this.map.homePads.length]!;
    const leader = spawnLeader(this.store, index, pad.x, pad.y);

    const state: PlayerState = {
      id,
      index,
      name,
      leaderId: leader.id,
      gems: MATCH.startingGems,
      chestsOpened: 0,
      nextChestPrice: MATCH.chestBasePrice,
      respawnIn: 0,
      connected: true,
      facing: 0,
      lastAckSeq: 0,
      offer: null,
      offerChestId: 0,
      wiped: false,
    };
    this.players.set(id, state);

    for (const group of MATCH.startingSquad) {
      for (let i = 0; i < group.count; i++) {
        spawnUnit(this.store, index, group.type as UnitType, 0, pad.x, pad.y + 0.6 + i * 0.3);
      }
    }
    return state;
  }

  removePlayer(id: PlayerId): void {
    const p = this.players.get(id);
    if (!p) return;
    for (const e of this.store.items) {
      if (e.alive && e.team === p.index && (e.kind === 'unit' || e.kind === 'leader')) {
        this.store.despawn(e);
      }
    }
    this.players.delete(id);
  }

  squadOf(playerIndex: number): Entity[] {
    const out: Entity[] = [];
    for (const e of this.store.items) {
      if (e.alive && e.kind === 'unit' && e.team === playerIndex) out.push(e);
    }
    return out;
  }

  leaderOf(player: PlayerState): Entity | undefined {
    return this.store.get(player.leaderId);
  }

  start(): void {
    this.phase = 'playing';
    this.elapsed = 0;
    this.tickNumber = 0;
  }

  // ── the tick ──────────────────────────────────────────────────────────────

  tick(inputs: Map<PlayerId, InputCommand>): void {
    const dt = TICK_DT;
    this.events.length = 0;
    this.damageBuf.length = 0;
    this.healBuf.length = 0;

    if (this.phase === 'lobby' || this.phase === 'ended') {
      this.tickNumber++;
      return;
    }

    this.rebuildSquads();

    // 1. Apply player inputs -> leader velocities
    this.applyInputs(inputs, dt);
    // 2. Move leaders (collide with terrain)
    this.moveLeaders(dt);
    // 3. Formation slots -> move squad units toward slots
    this.updateFormations(dt);
    // 4 + 5. Acquire targets, resolve attacks and healing
    this.resolveCombat(dt);
    // 6. Resolve deaths, drop gems
    this.resolveDeaths();
    // 7. Resolve pickups (gems, chests)
    this.resolvePickups(inputs, dt);
    // 8. Squad-vs-squad collision outcomes
    this.resolveSquadCollisions();
    // 9. Respawn timers, node respawns, creep camp respawns
    this.resolveRespawns(dt);
    // 10. Phase/timer update
    this.updatePhase(dt);

    this.tickNumber++;
  }

  private rebuildSquads(): void {
    this.squads.clear();
    for (const player of this.players.values()) this.squads.set(player.id, []);
    for (const e of this.store.items) {
      if (!e.alive || e.kind !== 'unit') continue;
      for (const player of this.players.values()) {
        if (player.index === e.team) {
          this.squads.get(player.id)!.push(e);
          break;
        }
      }
    }
  }

  private applyInputs(inputs: Map<PlayerId, InputCommand>, dt: number): void {
    for (const player of this.players.values()) {
      const leader = this.leaderOf(player);
      if (!leader) continue;

      const input = inputs.get(player.id);
      if (!input || player.wiped) {
        leader.vx = 0;
        leader.vy = 0;
        continue;
      }
      player.lastAckSeq = input.seq;

      normalizeInto(scratchVec, input.dirX, input.dirY);
      const squad = this.squads.get(player.id) ?? [];
      const scouts = squad.filter((u) => u.unitType === 'scout').length;
      const speed = MATCH.leaderSpeed * (1 + scoutSpeedBonus(scouts));

      leader.vx = scratchVec.x * speed;
      leader.vy = scratchVec.y * speed;
      if (scratchVec.x !== 0 || scratchVec.y !== 0) {
        player.facing = Math.atan2(scratchVec.y, scratchVec.x);
      }
      void dt;
    }
  }

  private moveLeaders(dt: number): void {
    for (const player of this.players.values()) {
      const leader = this.leaderOf(player);
      if (!leader) continue;
      this.moveWithCollision(leader, dt);
    }
  }

  /**
   * Circle-vs-tile collision, resolved per axis.
   * Axis separation means sliding along a wall works naturally instead of the
   * player sticking when they push into a corner diagonally.
   */
  private moveWithCollision(e: Entity, dt: number): void {
    const size = this.map.size;
    const tiles = this.map.tiles;
    const r = e.radius;

    const nextX = e.x + e.vx * dt;
    if (!this.circleHitsWall(tiles, size, nextX, e.y, r)) {
      e.x = nextX;
    }
    const nextY = e.y + e.vy * dt;
    if (!this.circleHitsWall(tiles, size, e.x, nextY, r)) {
      e.y = nextY;
    }

    e.x = clamp(e.x, r, size - r);
    e.y = clamp(e.y, r, size - r);
  }

  private circleHitsWall(
    tiles: Uint8Array,
    size: number,
    x: number,
    y: number,
    r: number,
  ): boolean {
    // Sample the four extremes of the circle's bounding box plus its centre.
    // At tile scale 1 and radii under 0.5 this is exact enough and far cheaper
    // than a true circle-AABB test per candidate tile.
    return (
      isWallAt(tiles, x - r, y, size) ||
      isWallAt(tiles, x + r, y, size) ||
      isWallAt(tiles, x, y - r, size) ||
      isWallAt(tiles, x, y + r, size) ||
      isWallAt(tiles, x, y, size)
    );
  }

  private updateFormations(dt: number): void {
    for (const player of this.players.values()) {
      const squad = this.squads.get(player.id);
      const leader = this.leaderOf(player);
      if (!squad || !leader || squad.length === 0) continue;

      assignSlots(squad);
      const scouts = squad.filter((u) => u.unitType === 'scout').length;
      const scoutBonus = scoutSpeedBonus(scouts);
      const baseSpeed = MATCH.leaderSpeed * MATCH.squadCatchupSpeed;

      for (const unit of squad) {
        decaySlow(unit, dt);
        slotPosition(scratchSlot, leader.x, leader.y, player.facing, unit.slot);
        const speed = unitMoveSpeed(unit, baseSpeed, scoutBonus);
        steerToSlot(unit, scratchSlot.x, scratchSlot.y, speed);
        this.moveWithCollision(unit, dt);
      }
      separate(squad, 6, dt);
    }
  }

  private resolveCombat(dt: number): void {
    const now = this.elapsed;

    for (const player of this.players.values()) {
      const squad = this.squads.get(player.id);
      if (!squad) continue;
      for (const unit of squad) {
        if (!unit.unitType) continue;
        const def = UNIT_DEFS[unit.unitType];
        if (def.healPerSecond > 0 && def.damage === 0) {
          resolveHealing(this.store, unit, squad, now, dt, this.healBuf);
        } else {
          resolveAttack(this.store, unit, dt, this.damageBuf);
        }
      }
    }

    // Creeps defend their camp: they attack anything in reach but never leave.
    for (const e of this.store.items) {
      if (!e.alive || e.kind !== 'creep') continue;
      decaySlow(e, dt);
      e.cooldown -= dt;
      if (e.cooldown > 0) continue;
      const targetId = acquireTargetForCreep(this.store, e);
      e.targetId = targetId;
      if (targetId === 0) continue;
      const target = this.store.get(targetId);
      if (!target) continue;
      e.cooldown = CREEP_INTERVAL;
      target.hp -= CREEP_DAMAGE;
      const killed = target.hp <= 0;
      if (killed) target.hp = 0;
      this.damageBuf.push({
        sourceId: e.id,
        targetId: target.id,
        amount: CREEP_DAMAGE,
        killed,
        x: target.x,
        y: target.y,
      });
    }

    // Stamp damage time before regen runs, so anything hit this tick is
    // correctly considered in combat.
    for (const d of this.damageBuf) {
      const target = this.store.get(d.targetId);
      if (target) target.lastDamagedAt = now;
      this.events.push({ t: 'hit', x: d.x, y: d.y, targetId: d.targetId, amount: d.amount });
    }

    this.applyRegen(dt, now);
  }

  /**
   * Out-of-combat regeneration for squad units.
   *
   * Only units regenerate: creeps healing would make camps unclearable by a
   * squad that has to hold formation, and props/nodes are meant to stay broken
   * until their respawn timer.
   */
  private applyRegen(dt: number, now: number): void {
    const rate = MATCH.regenPerSecond;
    if (rate <= 0) return;

    for (const e of this.store.items) {
      if (!e.alive || e.kind !== 'unit') continue;
      if (e.hp <= 0 || e.hp >= e.maxHp) continue;
      if (now - e.lastDamagedAt < MATCH.regenDelaySeconds) continue;
      e.hp = Math.min(e.maxHp, e.hp + rate * dt);
    }
  }

  /** Gems awarded for destroying `source`, after Harvester, zone and phase multipliers. */
  private gemValueFor(source: Entity, killerTeam: number): number {
    let base = source.value;
    if (base <= 0) return 0;

    const zone = zoneAt(source.x, source.y);
    base *= zoneYieldMultiplier(zone);

    if (killerTeam !== TEAM_NEUTRAL) {
      const owner = this.playerByIndex(killerTeam);
      if (owner) {
        const squad = this.squads.get(owner.id) ?? [];
        const harvesters = squad.filter((u) => u.unitType === 'harvester').length;
        // §1.5: the Harvester bonus applies to nodes and props, not to kills.
        if (source.kind === 'node' || source.kind === 'prop') {
          base *= harvesterMultiplier(harvesters);
        }
      }
    }

    if (this.phase === 'lastCall') base *= MATCH.lastCallMultiplier;
    return Math.max(1, Math.round(base));
  }

  private playerByIndex(index: number): PlayerState | undefined {
    for (const p of this.players.values()) if (p.index === index) return p;
    return undefined;
  }

  private resolveDeaths(): void {
    const killerByTarget = new Map<EntityId, number>();
    for (const d of this.damageBuf) {
      if (!d.killed) continue;
      const src = this.store.get(d.sourceId);
      killerByTarget.set(d.targetId, src ? src.team : TEAM_NEUTRAL);
    }

    for (const e of this.store.items) {
      if (!e.alive || e.hp > 0) continue;
      if (e.kind === 'leader' || e.kind === 'gem' || e.kind === 'chest') continue;

      const killerTeam = killerByTarget.get(e.id) ?? TEAM_NEUTRAL;
      this.events.push({ t: 'death', x: e.x, y: e.y, id: e.id, kind: e.kind });

      if (e.kind === 'prop' || e.kind === 'node' || e.kind === 'creep') {
        const value = this.gemValueFor(e, killerTeam);
        this.scatterGems(e.x, e.y, value);

        if (e.kind === 'node') {
          this.nodeRespawns.push({ x: e.x, y: e.y, in: MAP.resourceRespawnSeconds });
        }
        if (e.kind === 'creep') this.checkCampCleared(e.campId, killerTeam);
      }

      this.store.despawn(e);
    }
  }

  /** Split a payout into individual gem pickups so collecting feels physical. */
  private scatterGems(x: number, y: number, total: number, spread = 0.6): void {
    let remaining = total;
    const count = clamp(Math.ceil(total / 3), 1, 6);
    for (let i = 0; i < count; i++) {
      const chunk = i === count - 1 ? remaining : Math.max(1, Math.round(total / count));
      remaining -= chunk;
      if (chunk <= 0) continue;
      const angle = this.rng.float() * Math.PI * 2;
      const dist = this.rng.float() * spread;
      spawnGem(this.store, x + Math.cos(angle) * dist, y + Math.sin(angle) * dist, chunk);
      if (remaining <= 0) break;
    }
  }

  private checkCampCleared(campId: number, killerTeam: number): void {
    if (campId < 0) return;
    let remaining = 0;
    for (const e of this.store.items) {
      if (e.alive && e.kind === 'creep' && e.campId === campId && e.hp > 0) remaining++;
    }
    if (remaining > 0) return;

    const camp = this.camps.find((c) => c.id === campId);
    if (!camp) return;
    camp.respawnIn = MAP.creepCampRespawnSeconds;

    let bonus = camp.bonus * zoneYieldMultiplier(zoneAt(camp.x, camp.y));
    if (this.phase === 'lastCall') bonus *= MATCH.lastCallMultiplier;
    void killerTeam; // camp bonus is dropped as loot, not awarded directly
    this.scatterGems(camp.x, camp.y, Math.round(bonus), 1.2);
  }

  private resolvePickups(inputs: Map<PlayerId, InputCommand>, dt: number): void {
    for (const e of this.store.items) {
      if (e.alive && e.kind === 'gem' && e.pickupDelay > 0) e.pickupDelay -= dt;
    }

    for (const player of this.players.values()) {
      const leader = this.leaderOf(player);
      if (!leader || player.wiped) continue;

      // Gems — the leader hoovers them up within a generous radius so
      // collection doesn't demand pixel-accurate steering on a phone.
      //
      // Squad units collect too, at a shorter reach. This is what makes squad
      // size pay for itself: farming is bottlenecked on travel time, not kill
      // speed, so without it a bigger squad earned nothing extra and buying
      // chests was pure cost. The bench harness measured identical gross income
      // (~73 gems) for a bot that bought five chests and one that bought none.
      const leaderPickupSq = 1.1 * 1.1;
      const unitPickupSq = 0.75 * 0.75;
      const squad = this.squads.get(player.id) ?? [];

      for (const e of this.store.items) {
        if (!e.alive || e.kind !== 'gem' || e.pickupDelay > 0) continue;

        let collected = distanceSq(leader.x, leader.y, e.x, e.y) <= leaderPickupSq;
        if (!collected) {
          for (const unit of squad) {
            if (distanceSq(unit.x, unit.y, e.x, e.y) <= unitPickupSq) {
              collected = true;
              break;
            }
          }
        }
        if (!collected) continue;

        player.gems += e.value;
        this.events.push({ t: 'gem', x: e.x, y: e.y, player: player.id, value: e.value });
        this.store.despawn(e);
      }

      // Chests — walking onto one generates an offer; the choice arrives as a
      // later input, so the player isn't forced to decide instantly.
      const input = inputs.get(player.id);
      if (player.offer && input && typeof input.chestChoice === 'number') {
        this.completeChestPurchase(player, input.chestChoice);
        continue;
      }
      if (player.offer) continue;

      for (const e of this.store.items) {
        if (!e.alive || e.kind !== 'chest') continue;
        const reach = leader.radius + e.radius + 0.3;
        if (distanceSq(leader.x, leader.y, e.x, e.y) > reach * reach) continue;
        if (player.gems < player.nextChestPrice) continue;

        const pool = chestPool(this.elapsed);
        const options: UnitType[] = [];
        const shuffled = this.rng.shuffle(pool.slice());
        for (const t of shuffled) {
          if (options.length >= MATCH.chestOfferCount) break;
          options.push(t);
        }
        player.offer = options;
        player.offerChestId = e.id;
        this.events.push({
          t: 'chestOffer',
          player: player.id,
          options,
          price: player.nextChestPrice,
        });
        break;
      }
    }
  }

  private completeChestPurchase(player: PlayerState, choiceIndex: number): void {
    const offer = player.offer;
    if (!offer) return;
    const chest = this.store.get(player.offerChestId);
    const choice = offer[clamp(choiceIndex, 0, offer.length - 1)];

    player.offer = null;
    player.offerChestId = 0;
    if (!choice || !chest) return;
    if (player.gems < player.nextChestPrice) return;

    const squad = this.squadOf(player.index);
    if (squad.length >= MATCH.squadCap) return;

    // Spending is a real score sacrifice (§1.4) — gems leave the bank for good.
    player.gems -= player.nextChestPrice;
    player.chestsOpened += 1;
    player.nextChestPrice += MATCH.chestPriceStep;

    const leader = this.leaderOf(player);
    const sx = leader ? leader.x : chest.x;
    const sy = leader ? leader.y : chest.y;
    spawnUnit(this.store, player.index, choice, 0, sx, sy);

    this.events.push({ t: 'chestOpen', x: chest.x, y: chest.y, player: player.id, unit: choice });

    // Consume the chest and queue a replacement elsewhere, so chest locations
    // move around the map over a match instead of becoming fixed camps.
    this.store.despawn(chest);
    const spot = this.rng.pick(this.chestSpots);
    this.chestRespawns.push({ x: spot.x, y: spot.y, in: 12 });

    const fusions: FusionResult[] = [];
    applyFusions(this.store, this.squadOf(player.index), fusions);
    for (const f of fusions) {
      this.events.push({
        t: 'fusion',
        x: f.x,
        y: f.y,
        player: player.id,
        unit: f.type,
        tier: f.toTier,
      });
    }
  }

  /**
   * Squad-vs-squad (§1.7).
   *
   * Combat itself is already emergent from unit attacks. This step only detects
   * the *outcome*: when one player's squad is wiped while an enemy squad was in
   * contact, the loser scatters a share of their bank.
   */
  private resolveSquadCollisions(): void {
    const contact = 2.5;
    const contactSq = contact * contact;

    for (const loser of this.players.values()) {
      if (loser.wiped) continue;
      const squad = this.squads.get(loser.id) ?? [];
      const stillAlive = squad.filter((u) => u.alive && u.hp > 0);
      if (stillAlive.length > 0) continue;

      const loserLeader = this.leaderOf(loser);
      if (!loserLeader) continue;

      // Who was nearby when it happened? Nearest enemy leader with a live squad.
      let winner: PlayerState | null = null;
      let bestDistSq = contactSq;
      for (const other of this.players.values()) {
        if (other.id === loser.id) continue;
        const otherSquad = this.squads.get(other.id) ?? [];
        if (otherSquad.length === 0) continue;
        const otherLeader = this.leaderOf(other);
        if (!otherLeader) continue;
        const dSq = distanceSq(loserLeader.x, loserLeader.y, otherLeader.x, otherLeader.y);
        if (dSq < bestDistSq) {
          bestDistSq = dSq;
          winner = other;
        }
      }

      loser.wiped = true;
      loser.respawnIn = MATCH.respawnSeconds;

      const dropped = Math.floor(loser.gems * MATCH.gemLossFraction);
      if (dropped > 0) {
        loser.gems -= dropped;
        this.scatterGems(loserLeader.x, loserLeader.y, dropped, 1.8);
      }

      if (winner) {
        this.events.push({
          t: 'squadFight',
          x: loserLeader.x,
          y: loserLeader.y,
          winner: winner.id,
          loser: loser.id,
          dropped,
        });
      }
    }
  }

  private resolveRespawns(dt: number): void {
    for (const player of this.players.values()) {
      if (!player.wiped) continue;
      player.respawnIn -= dt;
      if (player.respawnIn > 0) continue;

      const pad = this.map.homePads[player.index % this.map.homePads.length]!;
      const leader = this.leaderOf(player);
      if (leader) {
        leader.x = pad.x;
        leader.y = pad.y;
        leader.vx = 0;
        leader.vy = 0;
      }
      for (const group of MATCH.respawnSquad) {
        for (let i = 0; i < group.count; i++) {
          spawnUnit(this.store, player.index, group.type as UnitType, 0, pad.x, pad.y + 0.5);
        }
      }
      player.wiped = false;
      player.respawnIn = 0;
      this.events.push({ t: 'respawn', player: player.id });
    }

    for (let i = this.nodeRespawns.length - 1; i >= 0; i--) {
      const r = this.nodeRespawns[i]!;
      r.in -= dt;
      if (r.in <= 0) {
        spawnNode(this.store, r.x, r.y);
        this.nodeRespawns.splice(i, 1);
      }
    }

    for (let i = this.chestRespawns.length - 1; i >= 0; i--) {
      const r = this.chestRespawns[i]!;
      r.in -= dt;
      if (r.in <= 0) {
        spawnChest(this.store, r.x, r.y);
        this.chestRespawns.splice(i, 1);
      }
    }

    for (const camp of this.camps) {
      if (camp.respawnIn <= 0) continue;
      camp.respawnIn -= dt;
      if (camp.respawnIn > 0) continue;
      for (let k = 0; k < MAP.creepsPerCamp; k++) {
        const angle = (k / MAP.creepsPerCamp) * Math.PI * 2;
        spawnCreep(
          this.store,
          camp.x + Math.cos(angle) * 0.9,
          camp.y + Math.sin(angle) * 0.9,
          camp.id,
          camp.strength,
        );
      }
    }
  }

  private updatePhase(dt: number): void {
    this.elapsed += dt;
    const remaining = MATCH.matchSeconds - this.elapsed;

    if (this.phase === 'playing' && remaining <= MATCH.lastCallSeconds) {
      this.phase = 'lastCall';
      this.events.push({ t: 'phase', phase: 'lastCall' });
    }
    if (remaining <= 0 && this.phase !== 'ended') {
      this.phase = 'ended';
      this.events.push({ t: 'phase', phase: 'ended' });
    }
  }

  /** Seconds left in the match, floored at zero. */
  get timeRemaining(): number {
    return Math.max(0, MATCH.matchSeconds - this.elapsed);
  }

  /** Standings, highest gems first. */
  standings(): { id: PlayerId; name: string; gems: number }[] {
    return [...this.players.values()]
      .map((p) => ({ id: p.id, name: p.name, gems: p.gems }))
      .sort((a, b) => b.gems - a.gems);
  }
}

/** Creeps only retaliate against player units in reach; they never roam. */
function acquireTargetForCreep(store: EntityStore, creep: Entity): EntityId {
  let bestId: EntityId = 0;
  let bestDistSq = Number.MAX_VALUE;
  const reach = CREEP_RANGE + creep.radius;
  const reachSq = reach * reach;

  for (const e of store.items) {
    if (!e.alive || e.kind !== 'unit' || e.team === TEAM_NEUTRAL) continue;
    if (e.hp <= 0) continue;
    const dSq = distanceSq(creep.x, creep.y, e.x, e.y);
    if (dSq > reachSq + e.radius * e.radius) continue;
    if (dSq < bestDistSq) {
      bestDistSq = dSq;
      bestId = e.id;
    }
  }
  return bestId;
}
