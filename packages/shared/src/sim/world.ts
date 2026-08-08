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
import { DEFAULT_MODE, GAME_MODES, type GameMode, type GameModeId } from '../config/modes.ts';
import {
  BATTLE_MODS,
  DEFAULT_BATTLE_MOD,
  type BattleMod,
  type BattleModId,
} from '../config/battleMods.ts';
import { MAP_IDS, type MapId } from '../config/maps.ts';
import { GRASS_SPEED_MULT, MAP, zoneAt, zoneYieldMultiplier } from '../config/map.ts';
import {
  STARTER_UNIT_TYPES,
  UNIT_DEFS,
  type Rarity,
  type UnitTier,
  type UnitType,
} from '../config/units.ts';
import { Rng } from '../math/rng.ts';
import { clamp, distanceSq, normalizeInto, type Vec2 } from '../math/vec2.ts';
import { NO_AURAS, applyHpAura, squadAuras, type SquadAuras } from './auras.ts';
import { updateSummons } from './summons.ts';
import {
  applyDamage,
  decaySlow,
  resolveAttack,
  resolveHealing,
  type DamageEvent,
  type HealEvent,
} from './combat.ts';
import { TEAM_NEUTRAL, EntityStore, type Entity, type EntityId } from './entities.ts';
import { assignSlots, separate, slotPosition, steerToSlot, unitMoveSpeed } from './formation.ts';
import { applyFusions, type FusionResult } from './fusion.ts';
import { buildArena, findOpenTile, isGrassAt, isWallAt, type GeneratedMap } from './mapgen.ts';
import {
  CREEP_DAMAGE,
  CREEP_INTERVAL,
  CREEP_RANGE,
  MINE,
  applyBattleModTerrain,
  chestPool,
  populateArena,
  rollChestRarity,
  spawnGiant,
  spawnChest,
  spawnCoin,
  spawnCreep,
  spawnFarmable,
  spawnGem,
  spawnLeader,
  spawnMine,
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
  /** Set when the player picks their starting character during the draft. */
  draftChoice?: number;
  /** Set on the tick the player taps dash. Ignored while on cooldown. */
  dash?: boolean;
}

export interface PlayerState {
  id: PlayerId;
  index: number;
  name: string;
  leaderId: EntityId;
  gems: number;
  /** Spending money. Buys chests; never counts toward score. */
  coins: number;
  chestsOpened: number;
  connected: boolean;
  /** Radians; drives formation orientation. */
  facing: number;
  lastAckSeq: number;
  /**
   * Live mirror of `World.chestPriceFor`, refreshed every tick.
   *
   * Derived, never assigned by anyone else: the price now moves with squad size
   * rather than accumulating on purchase, and the bots and the wire both want
   * to read it without holding a `World`.
   */
  nextChestPrice: number;
  /** Pending chest offer awaiting a choice, if any. */
  offer: UnitType[] | null;
  offerChestId: EntityId;
  /** Alliance index: equals `index` in a free-for-all, shared in duos/co-op. */
  alliance: number;
  /** The three characters offered in the opening draft, until one is taken. */
  draftOffer: UnitType[] | null;
  /** Whether that offer has been announced to the client yet. */
  draftAnnounced: boolean;
  /** The character this player drafted; also what they respawn with. */
  starterType: UnitType | null;
  /** Knocked out for good. Only ever set in elimination modes. */
  eliminated: boolean;
  /** Seconds until dash is available again, and how long the burst has left. */
  dashCooldown: number;
  dashRemaining: number;
}

export type WorldEvent =
  /**
   * A landed hit. Carries the attacker's position and reach as well as the
   * target's, because the client draws the shot: a ranged attack needs
   * somewhere to fly *from*, and a melee swing needs a direction to lunge in.
   * Without the source, every attack could only be rendered as a puff on the
   * victim.
   */
  | {
      t: 'hit';
      x: number;
      y: number;
      sx: number;
      sy: number;
      /** True when the attacker's reach makes this a shot rather than a swing. */
      ranged: boolean;
      targetId: EntityId;
      amount: number;
    }
  | { t: 'death'; x: number; y: number; id: EntityId; kind: string }
  | { t: 'gem'; x: number; y: number; player: PlayerId; value: number }
  | { t: 'coin'; x: number; y: number; player: PlayerId; value: number }
  | { t: 'dash'; x: number; y: number; player: PlayerId }
  | { t: 'meteor'; x: number; y: number }
  | { t: 'fusion'; x: number; y: number; player: PlayerId; unit: UnitType; tier: UnitTier }
  | { t: 'chestOffer'; player: PlayerId; options: UnitType[]; price: number; rarity: Rarity }
  | { t: 'chestOpen'; x: number; y: number; player: PlayerId; unit: UnitType; dud: boolean }
  | { t: 'summon'; x: number; y: number; player: PlayerId; unit: UnitType }
  | { t: 'squadFight'; x: number; y: number; winner: PlayerId; loser: PlayerId; dropped: number }
  | { t: 'eliminated'; player: PlayerId }
  | { t: 'rebuilt'; player: PlayerId }
  | { t: 'draftOffer'; player: PlayerId; options: UnitType[] }
  | { t: 'draftPick'; player: PlayerId; unit: UnitType }
  /** The centre mine coughed up its periodic gems. */
  | { t: 'mineDrop'; x: number; y: number; gems: number }
  /** The mine is about to blow; `seconds` is how long the client should count. */
  | { t: 'mineWarning'; x: number; y: number; seconds: number }
  | { t: 'mineBlast'; x: number; y: number; gems: number }
  | { t: 'phase'; phase: Phase };

/** How close a leader must be before loose pickups start flying to it. */
const MAGNET_RADIUS = 3.6;
/** Pull speed at the edge of the magnet field, and right on top of it. */
const MAGNET_MIN_SPEED = 2.5;
const MAGNET_MAX_SPEED = 15;

/** How far a unit will notice an enemy and step out to meet it. */
const ENGAGE_RADIUS = 6;
/** How far it may stray from its formation slot while doing so. */
const LEASH_RADIUS = 7;

const scratchVec: Vec2 = { x: 0, y: 0 };
const scratchSlot: Vec2 = { x: 0, y: 0 };

export class World {
  readonly store = new EntityStore();
  readonly players = new Map<PlayerId, PlayerState>();
  readonly rng: Rng;
  readonly map: GeneratedMap;

  readonly mode: GameMode;
  readonly mapId: MapId;
  /** The twist rolled for this match. Read as data; never branched on by id. */
  readonly battleMod: BattleMod;

  tickNumber = 0;
  /** Seconds elapsed in the match. */
  elapsed = 0;
  phase: Phase = 'lobby';
  /** Seconds left in the opening draft. */
  draftRemaining = 0;
  /** How many sides the match started with; fixed at `start()`. */
  private initialAlliances = 0;
  private meteorCooldown = 0;

  camps: CreepCamp[] = [];
  chestSpots: { x: number; y: number }[] = [];

  /** The central gem mine. Present on every arena. */
  readonly mine: Entity;
  private mineCooldown = MINE.interval;
  /** Set once the mine has blown, so it only ever does so once. */
  private mineBlown = false;
  private mineWarned = false;

  /** Events produced by the current tick; consumed and cleared by the host. */
  events: WorldEvent[] = [];

  private readonly damageBuf: DamageEvent[] = [];
  private readonly healBuf: HealEvent[] = [];
  /** Squad membership cache, rebuilt each tick. Reused to avoid allocation. */
  private readonly squads = new Map<PlayerId, Entity[]>();
  /** Squad aura totals, recomputed each tick alongside `squads`. */
  private readonly auras = new Map<PlayerId, SquadAuras>();
  private nodeRespawns: { x: number; y: number; in: number }[] = [];
  private farmRespawns: { x: number; y: number; kind: 'tree' | 'field'; in: number }[] = [];
  private chestRespawns: { x: number; y: number; in: number }[] = [];

  constructor(
    seed: number,
    playerCount: number,
    modeId: GameModeId = DEFAULT_MODE,
    mapId?: MapId,
    battleModId: BattleModId = DEFAULT_BATTLE_MOD,
  ) {
    this.rng = new Rng(seed);
    this.mode = GAME_MODES[modeId];
    this.battleMod = BATTLE_MODS[battleModId];
    // Drawn from the match seed when the caller does not name one, so a replay
    // of the same seed lands on the same ground.
    this.mapId = mapId ?? MAP_IDS[this.rng.int(0, MAP_IDS.length)]!;
    this.map = buildArena(this.mapId, playerCount);
    const populated = populateArena(this.store, this.map.tiles, this.rng, this.map.objects);
    this.camps = populated.camps;
    this.chestSpots = populated.chestSpots;
    applyBattleModTerrain(this.store, this.map.tiles, this.rng, this.battleMod);
    this.mine = spawnMine(this.store, this.map.mine.x, this.map.mine.y);
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
      coins: MATCH.startingCoins,
      chestsOpened: 0,
      nextChestPrice: MATCH.chestBasePrice,
      connected: true,
      facing: 0,
      lastAckSeq: 0,
      offer: null,
      offerChestId: 0,
      // Every player is their own side. Alliance stays a separate concept from
      // team because combat asks "may I shoot this" and squads ask "whose is
      // this", and collapsing the two is what would make teammates shoot each
      // other the moment any shared-side mode returns.
      alliance: index,
      draftOffer: null,
      draftAnnounced: false,
      starterType: null,
      eliminated: false,
      dashCooldown: 0,
      dashRemaining: 0,
    };
    this.players.set(id, state);
    leader.alliance = state.alliance;

    // No squad yet. Units arrive when the draft resolves and the player has
    // actually chosen what they are starting with.
    return state;
  }

  /** Everyone sharing an alliance with this player, including themselves. */
  alliesOf(player: PlayerState): PlayerState[] {
    const out: PlayerState[] = [];
    for (const p of this.players.values()) if (p.alliance === player.alliance) out.push(p);
    return out;
  }

  /** Pooled score for a player's side: their own in FFA, the pair's in duos. */
  allianceScore(player: PlayerState): number {
    let total = 0;
    for (const p of this.alliesOf(player)) {
      total += p.gems;
    }
    return total;
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

  /**
   * Squad size for the purposes of the cap and the HUD.
   *
   * Summoned helpers are excluded. Counting them would mean a Necromancer
   * silently spent four of your fifteen slots, making every Summoner strictly
   * worse than the unit it competes with — the class would be unpickable.
   */
  squadSize(playerIndex: number): number {
    let n = 0;
    for (const e of this.store.items) {
      if (e.alive && e.kind === 'unit' && e.team === playerIndex && e.ownerId === 0) n++;
    }
    return n;
  }

  /**
   * What this player's next chest costs.
   *
   * Priced off **squad size**, not off how many chests they have bought. Those
   * came apart the moment units started dying: a player who bought six and lost
   * five was still being charged as though they had six, so recovering from a
   * bad fight was priced like extending a winning streak. Pricing the slot you
   * are about to fill keeps the curve honest in both directions — rebuilding is
   * cheap, and running away with a huge squad gets steadily more expensive.
   */
  chestPriceFor(player: PlayerState, rarity: Rarity = 'common'): number {
    const size = this.squadSize(player.index);
    const discount = this.aurasOf(player.id).chestDiscount;
    if (this.battleMod.flatChestPrice !== null) return this.battleMod.flatChestPrice;
    const base = MATCH.chestBasePrice + size * MATCH.chestPriceStep;
    return Math.max(1, Math.round(base * MATCH.rarityPriceMultiplier[rarity] - discount));
  }

  leaderOf(player: PlayerState): Entity | undefined {
    return this.store.get(player.leaderId);
  }

  /**
   * Open the character draft.
   *
   * Every player is offered `draftOfferCount` starters drawn independently, so
   * two players can be offered the same character — a shared pool would mean
   * the last player to be dealt got whatever nobody else wanted, which is a
   * worse experience than an occasional mirror match.
   */
  beginDraft(): void {
    this.phase = 'draft';
    this.elapsed = 0;
    this.tickNumber = 0;
    this.draftRemaining = MATCH.draftSeconds;

    for (const player of this.players.values()) {
      const pool = this.rng.shuffle(STARTER_UNIT_TYPES.slice());
      player.draftOffer = pool.slice(0, MATCH.draftOfferCount);
      player.draftAnnounced = false;
    }
    // No events emitted here. `beginDraft` is called from outside the tick, and
    // `tick()` clears the event buffer before it does anything else, so
    // anything queued now would be thrown away before it could be broadcast.
    // The first draft tick announces instead.
  }

  /** Lock in a player's starting character. Ignored once they have one. */
  chooseStarter(player: PlayerState, choiceIndex: number): void {
    if (player.starterType || !player.draftOffer) return;
    const pick = player.draftOffer[clamp(choiceIndex, 0, player.draftOffer.length - 1)];
    if (!pick) return;
    player.starterType = pick;
    this.events.push({ t: 'draftPick', player: player.id, unit: pick });
  }

  /**
   * Leave the draft and spawn everyone's opening squad.
   *
   * Anyone who never picked is given the first character they were offered.
   * Starting them with nothing would be a strictly worse outcome for a player
   * who tabbed away for fifteen seconds, and an empty squad has no recovery
   * path — you need units to earn the gems to buy units.
   */
  start(): void {
    this.phase = 'playing';
    this.elapsed = 0;
    this.tickNumber = 0;
    this.initialAlliances = new Set([...this.players.values()].map((p) => p.alliance)).size;

    for (const player of this.players.values()) {
      if (!player.starterType) this.chooseStarter(player, 0);
      // Record the resolved type rather than only spawning it. A caller that
      // skips the draft entirely (tests, a rematch shortcut) left this null,
      // and anything downstream that rebuilds around "your character" then had
      // nothing to read.
      const type = player.starterType ?? STARTER_UNIT_TYPES[0]!;
      player.starterType = type;
      const pad = this.map.homePads[player.index % this.map.homePads.length]!;
      const tier = Math.min(this.battleMod.startingTier, this.battleMod.maxTier) as UnitTier;
      for (let i = 0; i < MATCH.startingUnitCount; i++) {
        const unit = spawnUnit(this.store, player.index, type, tier, pad.x, pad.y + 0.6 + i * 0.3);
        unit.alliance = player.alliance;
      }
    }
    this.events.push({ t: 'phase', phase: 'playing' });
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

    if (this.phase === 'draft') {
      this.tickDraft(inputs, dt);
      this.tickNumber++;
      return;
    }

    this.rebuildSquads();
    // Squad-wide auras are derived once per tick and cached, because six later
    // steps read them and recomputing per read would mean six passes over every
    // squad. They must be refreshed *after* rebuildSquads and *before* anything
    // that moves or fights, so a unit bought last tick is already contributing.
    this.refreshAuras();

    // 1. Apply player inputs -> leader velocities
    this.applyInputs(inputs, dt);
    // 2. Move leaders (collide with terrain)
    this.moveLeaders(dt);
    // 3. Formation slots -> move squad units toward slots
    this.updateFormations(dt);
    // 4 + 5. Acquire targets, resolve attacks and healing
    this.resolveCombat(dt);
    // 4b. Battle-mod spawns that arrive over time.
    this.updateMeteors(dt);
    // 5a. Leaders chip away at scenery they are standing on.
    this.resolveLeaderHarvest(dt);
    // 5b. Summoners field their helpers.
    this.resolveSummons(dt);
    // 6. Resolve deaths, drop gems
    this.resolveDeaths();
    // 7. Resolve pickups (gems, chests)
    this.resolvePickups(inputs, dt);
    // 8. Squad-vs-squad collision outcomes
    this.resolveSquadCollisions();
    // 9. Respawn timers, node respawns, creep camp respawns
    this.resolveRespawns(dt);
    // 9b. The centre mine coughs up gems, and eventually blows.
    this.updateMine(dt);
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

  /**
   * The draft: collect picks, and leave as soon as everyone has chosen.
   *
   * Ending early on unanimous picks matters more than it looks — with a full
   * lobby of people who all pick instantly, sitting through the remaining
   * twelve seconds of an empty timer is the first thing anyone notices about
   * the game.
   */
  private tickDraft(inputs: Map<PlayerId, InputCommand>, dt: number): void {
    // Announce offers from inside the tick, so they land in the buffer that
    // actually gets broadcast. Doing it per-player-once rather than on the
    // first tick alone also covers a player who joins mid-draft.
    for (const player of this.players.values()) {
      if (player.draftAnnounced || !player.draftOffer) continue;
      player.draftAnnounced = true;
      this.events.push({ t: 'draftOffer', player: player.id, options: player.draftOffer });
    }

    for (const [id, input] of inputs) {
      if (typeof input.draftChoice !== 'number') continue;
      const player = this.players.get(id);
      if (player) this.chooseStarter(player, input.draftChoice);
    }

    this.draftRemaining -= dt;
    const everyonePicked = [...this.players.values()].every((p) => p.starterType !== null);
    if (everyonePicked || this.draftRemaining <= 0) this.start();
  }

  /**
   * The closest hostile unit worth stepping out of formation for.
   *
   * Two radii do the work. `ENGAGE_RADIUS` is how far a unit will notice an
   * enemy, comfortably wider than any attack range so squads commit to a fight
   * rather than trading one hit in passing. `LEASH_RADIUS` is measured from the
   * unit's formation slot, not from the unit, so the squad's centre of mass
   * stays with the leader however long the fight runs.
   */
  private nearestFoe(unit: Entity, slotX: number, slotY: number): Entity | null {
    let best: Entity | null = null;
    let bestDistSq = ENGAGE_RADIUS * ENGAGE_RADIUS;
    const leashSq = LEASH_RADIUS * LEASH_RADIUS;

    for (const e of this.store.items) {
      if (!e.alive || e.hp <= 0) continue;
      // Rival units only. Creeps deliberately do not pull anyone out of
      // formation: they sit in camps and never roam, so a unit that walks out
      // to meet one walks into all four of its campmates. With a one-unit
      // opening squad that was a death sentence within seconds of leaving
      // spawn — camps have to be something the player chooses to attack, not
      // something their squad wanders into on its behalf.
      if (e.kind !== 'unit') continue;
      if (e.alliance === unit.alliance) continue;
      if (distanceSq(slotX, slotY, e.x, e.y) > leashSq) continue;

      const dSq = distanceSq(unit.x, unit.y, e.x, e.y);
      if (dSq >= bestDistSq) continue;
      bestDistSq = dSq;
      best = e;
    }
    return best;
  }

  /** Speed multiplier for whatever is underfoot at this position. */
  private terrainMultAt(x: number, y: number): number {
    return isGrassAt(this.map.tiles, x, y, this.map.size) ? GRASS_SPEED_MULT : 1;
  }

  /** Recompute each squad's aura totals and apply the HP aura to its members. */
  private refreshAuras(): void {
    for (const player of this.players.values()) {
      const squad = this.squads.get(player.id) ?? [];
      const auras = squadAuras(squad);
      this.auras.set(player.id, auras);
      applyHpAura(squad, auras.hpMultiplier);
      // Refresh the mirrored price now that both squad size and the Supplier
      // discount for this tick are known.
      player.nextChestPrice = this.chestPriceFor(player);
    }
  }

  /** Auras for a player, or the neutral defaults if they have no squad yet. */
  aurasOf(playerId: PlayerId): SquadAuras {
    return this.auras.get(playerId) ?? NO_AURAS;
  }

  /**
   * Leaders break crates and ore they walk into.
   *
   * Crates and ore only — never units or creeps, so the rule that leaders do
   * not fight (§1.7) still holds; and never trees or fields, so drafting the
   * Supplier who can work those remains a real decision.
   */
  private resolveLeaderHarvest(dt: number): void {
    for (const player of this.players.values()) {
      if (player.eliminated) continue;
      const leader = this.leaderOf(player);
      if (!leader) continue;

      leader.cooldown -= dt;
      if (leader.cooldown > 0) continue;

      let best: Entity | null = null;
      let bestDistSq = Number.MAX_VALUE;
      for (const e of this.store.items) {
        if (!e.alive || e.hp <= 0) continue;
        if (e.kind !== 'prop' && e.kind !== 'node') continue;
        const reach = MATCH.leaderHarvestRange + e.radius + leader.radius;
        const dSq = distanceSq(leader.x, leader.y, e.x, e.y);
        if (dSq > reach * reach || dSq >= bestDistSq) continue;
        bestDistSq = dSq;
        best = e;
      }
      if (!best) continue;

      leader.cooldown = MATCH.leaderHarvestInterval;
      const killed = applyDamage(best, MATCH.leaderHarvestDamage);
      this.damageBuf.push({
        sourceId: leader.id,
        targetId: best.id,
        amount: MATCH.leaderHarvestDamage,
        killed,
        x: best.x,
        y: best.y,
      });
    }
  }

  /**
   * Drop in a monster on a timer, for Mods that keep seeding the map.
   * Placed anywhere open rather than centre-biased: the point is that they
   * land on top of you wherever you happen to be farming.
   */
  private updateMeteors(dt: number): void {
    const every = this.battleMod.meteorIntervalSeconds;
    if (every <= 0) return;
    this.meteorCooldown -= dt;
    if (this.meteorCooldown > 0) return;
    this.meteorCooldown = every;

    const spot = findOpenTile(this.map.tiles, this.rng, this.map.size);
    const giant = spawnGiant(this.store, spot.x, spot.y);
    this.events.push({ t: 'meteor', x: giant.x, y: giant.y });
  }

  private resolveSummons(dt: number): void {
    for (const player of this.players.values()) {
      const squad = this.squads.get(player.id) ?? [];
      const created = updateSummons(this.store, squad, player.index, dt);
      for (const helper of created) {
        this.events.push({
          t: 'summon',
          x: helper.x,
          y: helper.y,
          player: player.id,
          unit: helper.unitType!,
        });
      }
    }
  }

  private applyInputs(inputs: Map<PlayerId, InputCommand>, dt: number): void {
    for (const player of this.players.values()) {
      // Dash timers run for everyone, every tick, before the early exits below.
      // Ticking them further down would freeze the cooldown while a player is
      // wiped or momentarily has no input, and they would respawn holding a
      // dash they should have been recharging through.
      player.dashCooldown = Math.max(0, player.dashCooldown - dt);
      player.dashRemaining = Math.max(0, player.dashRemaining - dt);

      const leader = this.leaderOf(player);
      if (!leader) continue;

      const input = inputs.get(player.id);
      if (!input || player.eliminated) {
        leader.vx = 0;
        leader.vy = 0;
        continue;
      }
      player.lastAckSeq = input.seq;

      normalizeInto(scratchVec, input.dirX, input.dirY);

      // Dash. Tapping it starts a short burst in the direction you are already
      // heading; it is a commitment, not a teleport, so it cannot be used to
      // cross a wall and it does not change where you were going.
      if (input.dash && player.dashCooldown <= 0 && (scratchVec.x !== 0 || scratchVec.y !== 0)) {
        player.dashRemaining = MATCH.dashSeconds;
        player.dashCooldown = MATCH.dashCooldownSeconds;
        this.events.push({ t: 'dash', x: leader.x, y: leader.y, player: player.id });
      }

      const dashMult = player.dashRemaining > 0 ? MATCH.dashSpeed : 1;
      // Grass drags on the leader as well as the squad, so wading through it is
      // a real routing decision rather than something only the AI-driven
      // followers have to care about.
      const terrain = this.terrainMultAt(leader.x, leader.y);
      const speed =
        MATCH.leaderSpeed * (1 + this.aurasOf(player.id).speedBonus) * dashMult * terrain;

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

    // Squad separation can shove a unit into geometry, and once its centre is
    // inside rock every axis test below fails and it is stuck there for the
    // rest of the match. Eject first, then move.
    if (this.circleHitsWall(tiles, size, e.x, e.y, r)) {
      this.ejectFromWall(e);
    }

    const startX = e.x;
    const startY = e.y;

    // Axis-separated so a diagonal into a wall slides along it rather than
    // stopping dead.
    const nextX = e.x + e.vx * dt;
    if (!this.circleHitsWall(tiles, size, nextX, e.y, r)) {
      e.x = nextX;
    }
    const nextY = e.y + e.vy * dt;
    if (!this.circleHitsWall(tiles, size, e.x, nextY, r)) {
      e.y = nextY;
    }

    // One axis blocked, the other free, is already handled above — that is the
    // ordinary case of sliding along a wall. This handles the narrower one of
    // being wedged on a corner with both axes blocked: a single sideways step
    // rounds it off.
    //
    // Deliberately no more than that. An earlier attempt escalated through ever
    // wider angles until something was walkable, which sounds strictly better
    // and is not: pushing into a dead end is a situation where stopping is the
    // correct answer, and a search that keeps widening eventually turns the
    // player around and walks them back out of a pocket they were deliberately
    // driving into. Sliding round corners is help; steering for them is not.
    if (e.x === startX && e.y === startY && (e.vx !== 0 || e.vy !== 0)) {
      const speed = Math.hypot(e.vx, e.vy);
      const perpX = -e.vy / speed;
      const perpY = e.vx / speed;
      const step = speed * dt;
      for (const sign of [1, -1]) {
        const tx = e.x + perpX * sign * step;
        const ty = e.y + perpY * sign * step;
        if (this.circleHitsWall(tiles, size, tx, ty, r)) continue;
        e.x = tx;
        e.y = ty;
        break;
      }
    }

    e.x = clamp(e.x, r, size - r);
    e.y = clamp(e.y, r, size - r);
  }

  /** Push an entity whose centre ended up inside rock out to the nearest gap. */
  private ejectFromWall(e: Entity): void {
    const size = this.map.size;
    const tiles = this.map.tiles;
    const r = e.radius;
    for (let ring = 1; ring <= 4; ring++) {
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const tx = e.x + Math.cos(a) * ring * 0.6;
        const ty = e.y + Math.sin(a) * ring * 0.6;
        if (this.circleHitsWall(tiles, size, tx, ty, r)) continue;
        e.x = tx;
        e.y = ty;
        return;
      }
    }
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
      const squadSpeedBonus = this.aurasOf(player.id).speedBonus;
      const baseSpeed = MATCH.leaderSpeed * MATCH.squadCatchupSpeed;

      for (const unit of squad) {
        decaySlow(unit, dt);
        // A stunned unit is rooted. Decaying the timer above but skipping the
        // move keeps the stun visible — the squad walks off and leaves it.
        if (unit.stunRemaining > 0) {
          unit.vx = 0;
          unit.vy = 0;
          continue;
        }
        slotPosition(scratchSlot, leader.x, leader.y, player.facing, unit.slot);

        // Engage, don't just brush past. Units used to hold formation
        // absolutely and only swing at whatever happened to fall inside attack
        // range, so two squads could walk through each other trading almost no
        // blows and squad-vs-squad barely existed. A unit will now step out to
        // meet a nearby enemy — but only as far as the leash allows, measured
        // from its slot, so the squad still moves as a squad and cannot be
        // pulled apart across the map by bait.
        const foe = this.nearestFoe(unit, scratchSlot.x, scratchSlot.y);
        const targetX = foe ? foe.x : scratchSlot.x;
        const targetY = foe ? foe.y : scratchSlot.y;

        const speed = unitMoveSpeed(
          unit,
          baseSpeed,
          squadSpeedBonus,
          this.terrainMultAt(unit.x, unit.y),
        );
        steerToSlot(unit, targetX, targetY, speed);
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

      // Where the blow came from, so the client can draw a projectile or a
      // lunge. The source may already be dead this tick, in which case fall
      // back to the impact point and the client just draws the puff.
      const src = this.store.get(d.sourceId);
      const def = src?.unitType ? UNIT_DEFS[src.unitType] : null;
      this.events.push({
        t: 'hit',
        x: d.x,
        y: d.y,
        sx: src ? src.x : d.x,
        sy: src ? src.y : d.y,
        // Reach, not class: a Bombardier lobbing from 3.2 tiles should read as
        // a shot even though it is filed as a Fighter.
        ranged: (def?.attackRange ?? 0) > 1.6,
        targetId: d.targetId,
        amount: d.amount,
      });
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

  /** Gems awarded for destroying `source`, after Supplier, zone and phase multipliers. */
  private gemValueFor(source: Entity, killerTeam: number): number {
    let base = source.value;
    if (base <= 0) return 0;

    const zone = zoneAt(source.x, source.y);
    base *= zoneYieldMultiplier(zone);

    if (killerTeam !== TEAM_NEUTRAL) {
      const owner = this.playerByIndex(killerTeam);
      // §1.5: the Supplier bonus applies to harvested nodes and props, not to
      // kills — otherwise an economy squad would also be paid for winning
      // fights it is deliberately bad at.
      const harvested =
        source.kind === 'node' ||
        source.kind === 'prop' ||
        source.kind === 'tree' ||
        source.kind === 'field';
      if (owner && harvested) {
        base *= this.aurasOf(owner.id).gemMultiplier;
      }
      if (owner) base *= squadGemScale(this.squadSize(owner.index));
    }

    base *= this.mode.economyScale * this.battleMod.lootMultiplier;
    if (source.kind === 'creep') base *= this.battleMod.creepGemMultiplier;
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
      if (e.kind === 'leader' || e.kind === 'gem' || e.kind === 'coin') continue;
      if (e.kind === 'chest') continue;

      const killerTeam = killerByTarget.get(e.id) ?? TEAM_NEUTRAL;
      this.events.push({ t: 'death', x: e.x, y: e.y, id: e.id, kind: e.kind });

      // Narrowed to the literal union so the respawn record stays typed.
      const farmKind: 'tree' | 'field' | null =
        e.kind === 'tree' ? 'tree' : e.kind === 'field' ? 'field' : null;
      const farmable = farmKind !== null;
      if (e.kind === 'prop' || e.kind === 'node' || e.kind === 'creep' || farmable) {
        // Farmables burst wider — they pay several times a crate, and the drop
        // should look like the haul it is.
        const spread = farmable ? 1.5 : 0.7;
        this.scatterGems(e.x, e.y, this.gemValueFor(e, killerTeam), spread);
        this.scatterCoins(e.x, e.y, this.coinValueFor(e), spread + 0.3);

        if (e.kind === 'node') {
          this.nodeRespawns.push({ x: e.x, y: e.y, in: MAP.resourceRespawnSeconds });
        }
        if (farmKind) {
          this.farmRespawns.push({ x: e.x, y: e.y, kind: farmKind, in: MAP.farmRespawnSeconds });
        }
        if (e.kind === 'creep') this.checkCampCleared(e.campId, killerTeam);
      }

      this.store.despawn(e);
    }
  }

  /**
   * Split a payout into individual pickups so collecting feels physical.
   *
   * Deliberately more, smaller drops than the payout strictly needs: a smashed
   * crate that bursts into a scatter of pickups reads as a reward, where one
   * lump reads as a counter ticking up.
   */
  private scatter(
    kind: 'gem' | 'coin',
    x: number,
    y: number,
    total: number,
    spread: number,
  ): void {
    if (total <= 0) return;
    let remaining = total;
    const count = clamp(Math.ceil(total / 2), 1, 9);
    for (let i = 0; i < count; i++) {
      const chunk = i === count - 1 ? remaining : Math.max(1, Math.round(total / count));
      remaining -= chunk;
      if (chunk <= 0) continue;
      const angle = this.rng.float() * Math.PI * 2;
      const dist = this.rng.float() * spread;
      const px = x + Math.cos(angle) * dist;
      const py = y + Math.sin(angle) * dist;
      if (kind === 'gem') spawnGem(this.store, px, py, chunk);
      else spawnCoin(this.store, px, py, chunk);
      if (remaining <= 0) break;
    }
  }

  private scatterGems(x: number, y: number, total: number, spread = 0.7): void {
    this.scatter('gem', x, y, total, spread);
  }

  private scatterCoins(x: number, y: number, total: number, spread = 0.9): void {
    this.scatter('coin', x, y, total, spread);
  }

  /** Coins awarded for destroying `source`. Zone and last call apply; auras do not. */
  private coinValueFor(source: Entity): number {
    let base = source.coinValue;
    if (base <= 0) return 0;
    base *=
      zoneYieldMultiplier(zoneAt(source.x, source.y)) *
      this.mode.economyScale *
      this.battleMod.lootMultiplier;
    if (this.phase === 'lastCall') base *= MATCH.lastCallMultiplier;
    return Math.max(1, Math.round(base));
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

    const zone = zoneYieldMultiplier(zoneAt(camp.x, camp.y));
    const mult = zone * this.mode.economyScale * (this.phase === 'lastCall' ? MATCH.lastCallMultiplier : 1);
    void killerTeam; // camp bonus is dropped as loot, not awarded directly
    this.scatterGems(camp.x, camp.y, Math.round(camp.bonus * mult), 1.2);
    this.scatterCoins(camp.x, camp.y, Math.round(camp.coinBonus * mult), 1.4);
  }

  /**
   * Put a busted player back on their pad with a small squad.
   *
   * Only ever called inside the opening grace window. Rebuilds around the
   * character they drafted, because that pick is their identity for the match
   * and handing them somebody else's unit would quietly undo it.
   */
  private rebuild(player: PlayerState): void {
    const pad = this.map.homePads[player.index % this.map.homePads.length]!;
    const leader = this.leaderOf(player);
    if (leader) {
      leader.x = pad.x;
      leader.y = pad.y;
      leader.vx = 0;
      leader.vy = 0;
    }
    const type = player.starterType ?? STARTER_UNIT_TYPES[0]!;
    for (let i = 0; i < MATCH.rebuildUnitCount; i++) {
      const unit = spawnUnit(this.store, player.index, type, 0, pad.x, pad.y + 0.5 + i * 0.3);
      unit.alliance = player.alliance;
    }
    this.events.push({ t: 'rebuilt', player: player.id });
  }

  /**
   * Loose gems and coins fly to whoever is nearest.
   *
   * This is the single biggest thing separating "walk over the pickups" from a
   * collection loop that feels good. A gem that sits still has to be steered
   * onto; a gem that leaps toward you the moment you are close rewards getting
   * *near*, which is a far more forgiving target on a phone and turns clearing
   * a crate into a little burst of things rushing at you.
   *
   * Pull accelerates as it closes, so a pickup snaps in decisively at the end
   * rather than drifting alongside you. Collection itself is unchanged — this
   * only moves things into reach, so the existing pickup radii still decide how
   * much a squad can hoover and the economy balance holds.
   */
  private magnetisePickups(dt: number): void {
    const radiusSq = MAGNET_RADIUS * MAGNET_RADIUS;

    for (const e of this.store.items) {
      if (!e.alive || e.pickupDelay > 0) continue;
      if (e.kind !== 'gem' && e.kind !== 'coin') continue;

      // Nearest eligible leader. Pickups stay neutral until collected, so they
      // are pulled by whoever gets close first — which makes a contested drop
      // an actual race.
      let bestX = 0;
      let bestY = 0;
      let bestDistSq = radiusSq;
      let found = false;
      for (const player of this.players.values()) {
        if (player.eliminated) continue;
        const leader = this.leaderOf(player);
        if (!leader) continue;
        const dSq = distanceSq(leader.x, leader.y, e.x, e.y);
        if (dSq >= bestDistSq) continue;
        bestDistSq = dSq;
        bestX = leader.x;
        bestY = leader.y;
        found = true;
      }
      if (!found) continue;

      const dist = Math.sqrt(bestDistSq) || 1e-4;
      // Ramp from a gentle tug at the rim of the field to a hard snap up close.
      const closeness = 1 - dist / MAGNET_RADIUS;
      const speed =
        MAGNET_MIN_SPEED + (MAGNET_MAX_SPEED - MAGNET_MIN_SPEED) * closeness * closeness;
      const step = Math.min(dist, speed * dt);
      e.x += ((bestX - e.x) / dist) * step;
      e.y += ((bestY - e.y) / dist) * step;
    }
  }

  private resolvePickups(inputs: Map<PlayerId, InputCommand>, dt: number): void {
    for (const e of this.store.items) {
      // Coins as well as gems. Ticking only gems left every dropped coin
      // permanently un-collectible, so no player could ever afford a chest.
      if (!e.alive || e.pickupDelay <= 0) continue;
      if (e.kind === 'gem' || e.kind === 'coin') e.pickupDelay -= dt;
    }

    this.magnetisePickups(dt);

    for (const player of this.players.values()) {
      const leader = this.leaderOf(player);
      if (!leader || player.eliminated) continue;

      // Gems — the leader hoovers them up within a generous radius so
      // collection doesn't demand pixel-accurate steering on a phone.
      //
      // Squad units collect too, at a shorter reach. This is what makes squad
      // size pay for itself: farming is bottlenecked on travel time, not kill
      // speed, so without it a bigger squad earned nothing extra and buying
      // chests was pure cost. The bench harness measured identical gross income
      // (~73 gems) for a bot that bought five chests and one that bought none.
      const leaderPickupSq = 1.1 * 1.1;
      // Squadmates only sweep up what they are practically standing on. The
      // leader is the one carrying the bag, and its reach does not grow with
      // the squad — which is what stops a big squad banking proportionally
      // faster than a lone farmer and keeps the hoarding opening competitive.
      const unitPickupSq = 0.5 * 0.5;
      const squad = this.squads.get(player.id) ?? [];

      for (const e of this.store.items) {
        if (!e.alive || e.pickupDelay > 0) continue;
        const isGem = e.kind === 'gem';
        if (!isGem && e.kind !== 'coin') continue;

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

        if (isGem) {
          player.gems += e.value;
          this.events.push({ t: 'gem', x: e.x, y: e.y, player: player.id, value: e.value });
        } else {
          player.coins += e.value;
          this.events.push({ t: 'coin', x: e.x, y: e.y, player: player.id, value: e.value });
        }
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
        const rarity = this.battleMod.forceRarity ?? e.rarity ?? 'common';
        if (player.coins < this.chestPriceFor(player, rarity)) continue;

        const pool = chestPool(rarity);
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
          price: this.chestPriceFor(player, rarity),
          rarity,
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

    const price = this.chestPriceFor(player, chest?.rarity ?? 'common');
    player.offer = null;
    player.offerChestId = 0;
    if (!choice || !chest) return;
    if (player.coins < price) return;
    if (this.squadSize(player.index) >= MATCH.squadCap) return;

    // Coins, not gems. Buying a unit must never cost score, or every purchase
    // is a self-inflicted setback and the whole economy reads as a trap.
    player.coins -= price;
    player.chestsOpened += 1;

    const leader = this.leaderOf(player);
    const sx = leader ? leader.x : chest.x;
    const sy = leader ? leader.y : chest.y;

    // A dud pays nothing, but the coins are gone and the chest is consumed —
    // that is the whole gamble. Decided here rather than at spawn so a player
    // cannot tell a fake from a real one before committing.
    const dud = this.battleMod.fakeChestChance > 0 && this.rng.chance(this.battleMod.fakeChestChance);
    if (!dud) {
      const copies = Math.max(1, this.battleMod.chestUnitsPerBuy);
      for (let i = 0; i < copies; i++) {
        if (this.squadSize(player.index) >= MATCH.squadCap) break;
        spawnUnit(this.store, player.index, choice, 0, sx + i * 0.3, sy);
      }
    }

    this.events.push({
      t: 'chestOpen',
      x: chest.x,
      y: chest.y,
      player: player.id,
      unit: choice,
      dud,
    });

    // Consume the chest and queue a replacement elsewhere, so chest locations
    // move around the map over a match instead of becoming fixed camps.
    this.store.despawn(chest);
    const spot = this.rng.pick(this.chestSpots);
    this.chestRespawns.push({ x: spot.x, y: spot.y, in: 6 });

    const fusions: FusionResult[] = [];
    applyFusions(this.store, this.squadOf(player.index), fusions, this.battleMod.maxTier);
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
      if (loser.eliminated) continue;
      const squad = this.squads.get(loser.id) ?? [];
      const stillAlive = squad.filter((u) => u.alive && u.hp > 0);
      if (stillAlive.length > 0) continue;

      const loserLeader = this.leaderOf(loser);
      if (!loserLeader) continue;

      // Who was nearby when it happened? Nearest hostile leader with a live
      // squad — allies are skipped, or a duo partner standing over their
      // teammate's wipe would be credited with busting them.
      let winner: PlayerState | null = null;
      let bestDistSq = contactSq;
      for (const other of this.players.values()) {
        if (other.id === loser.id || other.alliance === loser.alliance) continue;
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

      // Losing your squad ends your run, and it does not matter who finished
      // it off — a creep camp counts the same as a rival. Only a rival used to,
      // so you could be wiped by the map and simply carry on.
      //
      // Except in the opening minute, where it rebuilds you instead. A bust at
      // twenty seconds is three and a half minutes of watching, which is a
      // worse outcome for the player than the rule is worth that early.
      if (this.elapsed < MATCH.bustGraceSeconds) {
        this.rebuild(loser);
        continue;
      }

      loser.eliminated = true;
      this.events.push({ t: 'eliminated', player: loser.id });

      const dropped = Math.floor(loser.gems * MATCH.gemLossFraction);
      if (dropped > 0) {
        loser.gems -= dropped;
        this.scatterGems(loserLeader.x, loserLeader.y, dropped, 1.8);
      }
      const coinsDropped = Math.floor(loser.coins * MATCH.coinLossFraction);
      if (coinsDropped > 0) {
        loser.coins -= coinsDropped;
        this.scatterCoins(loserLeader.x, loserLeader.y, coinsDropped, 2.1);
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

    for (let i = this.nodeRespawns.length - 1; i >= 0; i--) {
      const r = this.nodeRespawns[i]!;
      r.in -= dt;
      if (r.in <= 0) {
        spawnNode(this.store, r.x, r.y);
        this.nodeRespawns.splice(i, 1);
      }
    }

    for (let i = this.farmRespawns.length - 1; i >= 0; i--) {
      const r = this.farmRespawns[i]!;
      r.in -= dt;
      if (r.in <= 0) {
        spawnFarmable(this.store, r.kind, r.x, r.y);
        this.farmRespawns.splice(i, 1);
      }
    }

    for (let i = this.chestRespawns.length - 1; i >= 0; i--) {
      const r = this.chestRespawns[i]!;
      r.in -= dt;
      if (r.in <= 0) {
        // Roll rarity at respawn time, so the map's mix drifts toward the
        // richer chests as the match goes on rather than being fixed at build.
        spawnChest(this.store, r.x, r.y, rollChestRarity(this.rng, this.elapsed));
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

  /**
   * The centre mine: a steady trickle all match, then one detonation at the end.
   *
   * Gems land on the floor as ordinary pickups rather than being credited to
   * whoever is nearest, so the mine pays *presence*, not proximity at the
   * instant it fires — you have to still be there to collect, which is what
   * makes standing on it a commitment rather than a drive-by.
   */
  private updateMine(dt: number): void {
    const remaining = this.timeRemaining;

    if (!this.mineWarned && remaining <= MINE.warningSeconds) {
      this.mineWarned = true;
      this.events.push({ t: 'mineWarning', x: this.mine.x, y: this.mine.y, seconds: remaining - MINE.blastSeconds });
    }

    if (!this.mineBlown && remaining <= MINE.blastSeconds) {
      this.mineBlown = true;
      this.scatterMineGems(MINE.blastGems, MINE.blastGemValue, MINE.blastScatterRadius);
      this.events.push({ t: 'mineBlast', x: this.mine.x, y: this.mine.y, gems: MINE.blastGems });
      return;
    }
    if (this.mineBlown) return;

    this.mineCooldown -= dt;
    if (this.mineCooldown > 0) return;
    this.mineCooldown += MINE.interval;
    this.scatterMineGems(MINE.gemsPerDrop, MINE.gemValue, MINE.scatterRadius);
    this.events.push({ t: 'mineDrop', x: this.mine.x, y: this.mine.y, gems: MINE.gemsPerDrop });
  }

  private scatterMineGems(count: number, value: number, radius: number): void {
    const scaled = Math.max(1, Math.round(value * this.mode.economyScale));
    for (let i = 0; i < count; i++) {
      // Spread over the disc rather than a ring, so a big scatter reads as a
      // pile spilling outward instead of a suspiciously neat circle.
      const angle = this.rng.float() * Math.PI * 2;
      const dist = Math.sqrt(this.rng.float()) * radius;
      const x = this.mine.x + Math.cos(angle) * dist;
      const y = this.mine.y + Math.sin(angle) * dist;
      // Gems that land in rock are unreachable; drop those on the mine instead.
      const clear = !isWallAt(this.map.tiles, x, y, this.map.size);
      spawnGem(this.store, clear ? x : this.mine.x, clear ? y : this.mine.y, scaled);
    }
  }

  private updatePhase(dt: number): void {
    this.elapsed += dt;
    const remaining = this.mode.matchSeconds - this.elapsed;

    if (this.phase === 'playing' && remaining <= this.mode.lastCallSeconds) {
      this.phase = 'lastCall';
      this.events.push({ t: 'phase', phase: 'lastCall' });
    }

    if (this.phase !== 'ended' && this.isOver(remaining)) {
      this.phase = 'ended';
      this.events.push({ t: 'phase', phase: 'ended' });
    }
  }

  /** Has this mode's win condition been met? */
  private isOver(remaining: number): boolean {
    // Every mode has a hard ceiling, timed or not, so nothing can run forever.
    if (remaining <= 0) return true;

    // One side left standing ends any mode that can eliminate at all. Without
    // this a Gem Hunt where everyone has been busted would keep running, and
    // the last survivor would farm an empty map until the clock expired.
    //
    // Guarded on there having been more than one side to begin with, or a solo
    // match satisfies "one side remains" on its very first tick and ends
    // instantly.
    if (this.initialAlliances > 1) {
      const sides = new Set<number>();
      for (const p of this.players.values()) if (!p.eliminated) sides.add(p.alliance);
      if (sides.size <= 1) return true;
    }

    return false;
  }

  /** Seconds left in the match, floored at zero. */
  get timeRemaining(): number {
    return Math.max(0, this.mode.matchSeconds - this.elapsed);
  }

  /**
   * Standings, best first.
   *
   * `score` is whatever the mode counts, so the results screen never has to
   * know which mode it is showing. Survival ranks by who is still alive first
   * and gems second, which is the only sensible tiebreak when the winner is
   * decided by elimination rather than by a number.
   */
  standings(): { id: PlayerId; name: string; gems: number; score: number; eliminated: boolean }[] {
    const rows = [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      gems: p.gems,
      score: this.allianceScore(p),
      eliminated: p.eliminated,
    }));

    // Survivors above the busted, then by gems. Being eliminated with a big
    // bank should still beat surviving with nothing, but only among equals —
    // finishing the match is worth something.
    return rows.sort((a, b) => b.score - a.score);
  }
}

/**
 * Gem income multiplier for a squad of this size.
 *
 * Hyperbolic rather than linear, so the first few units barely cost anything
 * and a very large squad gives up a meaningful slice of its banking rate. See
 * `MATCH.squadGemFalloff` for why this exists at all.
 */
export function squadGemScale(squadSize: number): number {
  return 1 / (1 + MATCH.squadGemFalloff * Math.max(0, squadSize - 1));
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
