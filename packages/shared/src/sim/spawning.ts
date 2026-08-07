/**
 * Populating the arena and creating units (brief §1.8).
 *
 * Placement is biased toward the centre so the contested zone is genuinely
 * richer — that bias plus zoneYieldMultiplier is what stops turtling on the
 * rim from out-earning a fight for the middle (§4, known failure mode).
 */

import { COIN_YIELD, GEM_YIELD, MATCH } from '../config/match.ts';
import { MAP, zoneAt } from '../config/map.ts';
import {
  PLAYABLE_UNIT_TYPES,
  UNIT_DEFS,
  unitMaxHp,
  type UnitTier,
  type UnitType,
} from '../config/units.ts';
import type { Rng } from '../math/rng.ts';
import { TEAM_NEUTRAL, type Entity, type EntityStore } from './entities.ts';
import { findOpenTile, isWallAt } from './mapgen.ts';

/**
 * Crates are deliberately flimsy.
 *
 * The leader chips at 7 damage every 0.6s, so a 40 HP crate took three and a
 * half seconds of standing still — which a moving player never spends, and a
 * measured four-minute match broke exactly one crate across four players. At 18
 * a passing leader gets one in about 1.5s and a single unit takes two swings,
 * which is what makes the map feel smashable.
 */
export const PROP_HP = 18;
export const NODE_HP = 120;
export const CREEP_HP = 70;
export const CREEP_DAMAGE = 8;
export const CREEP_RANGE = 1.0;
export const CREEP_INTERVAL = 1.2;

/**
 * Pick a spot, preferring the centre.
 * Rejection sampling with a zone-weighted accept test: simple, seeded, and it
 * degrades to "anywhere open" rather than looping forever on a dense map.
 */
/**
 * Is every tile within `footprint` of this point free of rock?
 *
 * Placement used to test the single tile under an object's centre, which is
 * fine for a point but wrong for anything that draws bigger than one tile — a
 * tree renders about 1.5 tiles across, so one placed beside a wall came out
 * visibly buried in it. Objects are checked against the space they actually
 * occupy instead.
 */
function hasClearance(tiles: Uint8Array, x: number, y: number, footprint: number, size: number): boolean {
  const steps = Math.max(1, Math.ceil(footprint));
  for (let oy = -steps; oy <= steps; oy++) {
    for (let ox = -steps; ox <= steps; ox++) {
      const px = x + (ox / steps) * footprint;
      const py = y + (oy / steps) * footprint;
      if (isWallAt(tiles, px, py, size)) return false;
    }
  }
  return true;
}

function centreBiasedSpot(
  tiles: Uint8Array,
  rng: Rng,
  size: number,
  clearRadius: number,
  store: EntityStore,
  footprint = 0.6,
): { x: number; y: number } {
  for (let attempt = 0; attempt < 160; attempt++) {
    const spot = findOpenTile(tiles, rng, size, 40);
    const zone = zoneAt(spot.x, spot.y);
    // Zone 0 always accepted; each ring out is progressively less likely.
    const acceptance = [1.0, 0.7, 0.45, 0.3][zone] ?? 0.3;
    if (!rng.chance(acceptance)) continue;
    if (!hasClearance(tiles, spot.x, spot.y, footprint, size)) continue;
    if (isOccupied(store, spot.x, spot.y, clearRadius)) continue;
    return spot;
  }
  // Last resort: relax the zone bias but never the clearance, because a buried
  // object is worse than a badly-placed one.
  for (let attempt = 0; attempt < 200; attempt++) {
    const spot = findOpenTile(tiles, rng, size, 40);
    if (hasClearance(tiles, spot.x, spot.y, footprint, size)) return spot;
  }
  return findOpenTile(tiles, rng, size);
}

function isOccupied(store: EntityStore, x: number, y: number, radius: number): boolean {
  const rSq = radius * radius;
  for (const e of store.items) {
    if (!e.alive) continue;
    if (e.kind === 'gem') continue;
    const dx = e.x - x;
    const dy = e.y - y;
    if (dx * dx + dy * dy < rSq) return true;
  }
  return false;
}

export function spawnProp(store: EntityStore, x: number, y: number): Entity {
  const e = store.spawn('prop');
  e.x = x;
  e.y = y;
  e.team = TEAM_NEUTRAL;
  e.radius = 0.4;
  e.maxHp = PROP_HP;
  e.hp = PROP_HP;
  e.value = GEM_YIELD.prop;
  e.coinValue = COIN_YIELD.prop;
  return e;
}

export function spawnNode(store: EntityStore, x: number, y: number): Entity {
  const e = store.spawn('node');
  e.x = x;
  e.y = y;
  e.team = TEAM_NEUTRAL;
  e.radius = 0.5;
  e.maxHp = NODE_HP;
  e.hp = NODE_HP;
  e.value = GEM_YIELD.resourceNode;
  e.coinValue = COIN_YIELD.resourceNode;
  return e;
}

/**
 * Camp difficulty by zone (§1.8: outer zones are safe, the centre holds the
 * toughest camp). Identical camps everywhere meant a starting squad of two
 * Strikers could not clear any of them — the bench harness measured 3 creep
 * kills against 92 unit deaths across a full match — so nobody ever farmed
 * camps and squad size never paid for itself.
 */
export const CREEP_ZONE_STRENGTH: readonly number[] = [1.6, 1.15, 0.8, 0.6];

export function creepStrengthAt(x: number, y: number): number {
  const zone = zoneAt(x, y);
  return CREEP_ZONE_STRENGTH[zone] ?? CREEP_ZONE_STRENGTH[CREEP_ZONE_STRENGTH.length - 1]!;
}

export function spawnCreep(
  store: EntityStore,
  x: number,
  y: number,
  campId: number,
  strength = 1,
): Entity {
  const e = store.spawn('creep');
  e.x = x;
  e.y = y;
  e.team = TEAM_NEUTRAL;
  e.radius = 0.3;
  e.maxHp = CREEP_HP * strength;
  e.hp = e.maxHp;
  // Tougher camps are worth more, so contesting the centre pays for its risk.
  e.value = Math.max(1, Math.round(GEM_YIELD.creep * strength));
  e.coinValue = Math.max(1, Math.round(COIN_YIELD.creep * strength));
  e.campId = campId;
  e.unitType = 'brute'; // creeps reuse the Brute attack profile
  e.tier = 0;
  return e;
}

export const TREE_HP = 90;
export const FIELD_HP = 60;

/**
 * A farmable. Worth several times a crate, but only the matching specialist can
 * touch it — so these are the reason to draft a Supplier rather than a
 * percentage that quietly accrues.
 */
export function spawnFarmable(
  store: EntityStore,
  kind: 'tree' | 'field',
  x: number,
  y: number,
): Entity {
  const e = store.spawn(kind);
  e.x = x;
  e.y = y;
  e.team = TEAM_NEUTRAL;
  e.radius = kind === 'tree' ? 0.5 : 0.45;
  e.maxHp = kind === 'tree' ? TREE_HP : FIELD_HP;
  e.hp = e.maxHp;
  e.value = kind === 'tree' ? GEM_YIELD.tree : GEM_YIELD.field;
  e.coinValue = kind === 'tree' ? COIN_YIELD.tree : COIN_YIELD.field;
  return e;
}

export function spawnChest(store: EntityStore, x: number, y: number): Entity {
  const e = store.spawn('chest');
  e.x = x;
  e.y = y;
  e.team = TEAM_NEUTRAL;
  e.radius = 0.5;
  e.maxHp = 1;
  e.hp = 1;
  return e;
}

/** A rescue collectible for Hatchling Run: walk over it to bank it. */
export function spawnHatchling(store: EntityStore, x: number, y: number): Entity {
  const e = store.spawn('hatchling');
  e.x = x;
  e.y = y;
  e.team = TEAM_NEUTRAL;
  e.radius = 0.3;
  e.maxHp = 1;
  e.hp = 1;
  e.value = 1;
  return e;
}

/** A dropped coin: spending money, never score. */
export function spawnCoin(
  store: EntityStore,
  x: number,
  y: number,
  value: number,
  pickupDelay = 0.25,
): Entity {
  const e = store.spawn('coin');
  e.x = x;
  e.y = y;
  e.team = TEAM_NEUTRAL;
  e.radius = 0.24;
  e.value = value;
  e.pickupDelay = pickupDelay;
  return e;
}

export function spawnGem(
  store: EntityStore,
  x: number,
  y: number,
  value: number,
  pickupDelay = 0.25,
): Entity {
  const e = store.spawn('gem');
  e.x = x;
  e.y = y;
  e.team = TEAM_NEUTRAL;
  e.radius = 0.25;
  e.value = value;
  e.pickupDelay = pickupDelay;
  return e;
}

export function spawnUnit(
  store: EntityStore,
  team: number,
  type: UnitType,
  tier: UnitTier,
  x: number,
  y: number,
): Entity {
  const def = UNIT_DEFS[type];
  const e = store.spawn('unit');
  e.team = team;
  // Callers that put a unit on a shared side override this straight after.
  e.alliance = team;
  e.unitType = type;
  e.tier = tier;
  e.x = x;
  e.y = y;
  e.radius = def.radius;
  e.maxHp = unitMaxHp(type, tier);
  e.hp = e.maxHp;
  e.cooldown = 0;
  return e;
}

export function spawnLeader(store: EntityStore, team: number, x: number, y: number): Entity {
  const e = store.spawn('leader');
  e.team = team;
  e.alliance = team;
  e.x = x;
  e.y = y;
  e.radius = 0.35;
  // Leaders are invulnerable (§1.4) — they carry HP only so the field exists.
  e.maxHp = 1;
  e.hp = 1;
  return e;
}

export interface CreepCamp {
  id: number;
  x: number;
  y: number;
  respawnIn: number;
  /** Bonus paid once when the last creep in the camp dies. */
  bonus: number;
  coinBonus: number;
  /** Zone-derived difficulty multiplier, reused when the camp respawns. */
  strength: number;
}

/** Fill an empty world with props, nodes, camps and chest pads. */
export function populateArena(
  store: EntityStore,
  tiles: Uint8Array,
  rng: Rng,
): { camps: CreepCamp[]; chestSpots: { x: number; y: number }[] } {
  const size = MAP.size;

  for (let i = 0; i < MAP.props; i++) {
    const spot = centreBiasedSpot(tiles, rng, size, 0.9, store, 0.6);
    spawnProp(store, spot.x, spot.y);
  }

  for (let i = 0; i < MAP.resourceNodes; i++) {
    const spot = centreBiasedSpot(tiles, rng, size, 1.4, store, 0.85);
    spawnNode(store, spot.x, spot.y);
  }

  const camps: CreepCamp[] = [];
  for (let c = 0; c < MAP.creepCamps; c++) {
    const spot = centreBiasedSpot(tiles, rng, size, 3.0, store, 1.4);
    const strength = creepStrengthAt(spot.x, spot.y);
    camps.push({
      id: c,
      x: spot.x,
      y: spot.y,
      respawnIn: 0,
      bonus: Math.round(GEM_YIELD.creepCampBonus * strength),
      coinBonus: Math.round(COIN_YIELD.creepCampBonus * strength),
      strength,
    });
    for (let k = 0; k < MAP.creepsPerCamp; k++) {
      const angle = (k / MAP.creepsPerCamp) * Math.PI * 2;
      const cx = spot.x + Math.cos(angle) * 0.9;
      const cy = spot.y + Math.sin(angle) * 0.9;
      spawnCreep(store, cx, cy, c, strength);
    }
  }

  for (let i = 0; i < MAP.trees; i++) {
    const spot = centreBiasedSpot(tiles, rng, size, 1.2, store, 1.1);
    spawnFarmable(store, 'tree', spot.x, spot.y);
  }
  for (let i = 0; i < MAP.fields; i++) {
    const spot = centreBiasedSpot(tiles, rng, size, 1.2, store, 0.8);
    spawnFarmable(store, 'field', spot.x, spot.y);
  }

  const chestSpots: { x: number; y: number }[] = [];
  for (let i = 0; i < MAP.chestSpawns; i++) {
    const spot = centreBiasedSpot(tiles, rng, size, 2.0, store, 0.85);
    chestSpots.push(spot);
    spawnChest(store, spot.x, spot.y);
  }

  return { camps, chestSpots };
}

/**
 * Chest offer pool, gated by match time (§1.5).
 *
 * Summoned helpers are excluded by construction — `PLAYABLE_UNIT_TYPES` filters
 * them — so a chest can never offer a Skeleton, which would be a dead pick and
 * would let a player bypass the Summoner that is supposed to earn it.
 */
export function chestPool(elapsedSeconds: number): UnitType[] {
  if (elapsedSeconds < MATCH.lateUnlockSeconds) {
    return PLAYABLE_UNIT_TYPES.filter((t) => UNIT_DEFS[t].earlyPool);
  }
  return PLAYABLE_UNIT_TYPES.slice();
}
