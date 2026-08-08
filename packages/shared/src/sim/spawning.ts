/**
 * Populating the arena and creating units (brief §1.8).
 *
 * Placement is biased toward the centre so the contested zone is genuinely
 * richer — that bias plus zoneYieldMultiplier is what stops turtling on the
 * rim from out-earning a fight for the middle (§4, known failure mode).
 */

import type { ArenaObjects } from '../config/arenaData.ts';
import { COIN_YIELD, GEM_YIELD, MATCH } from '../config/match.ts';
import type { BattleMod } from '../config/battleMods.ts';
import { MAP, TILE_WALL, zoneAt } from '../config/map.ts';
import {
  MAX_TIER,
  RARITIES,
  UNIT_DEFS,
  unitsOfRarity,
  type Rarity,
  unitMaxHp,
  type UnitTier,
  type UnitType,
} from '../config/units.ts';
import type { Rng } from '../math/rng.ts';
import { TEAM_NEUTRAL, type Entity, type EntityStore } from './entities.ts';
import { untilFusion } from './fusion.ts';
import { findOpenTile, isWallAt, tileIndex } from './mapgen.ts';

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

/**
 * The gem mine that sits at the centre of every arena.
 *
 * It is the one landmark the source maps all share, and it does the job the
 * zone yield multiplier was doing alone: give the middle of the map a reason to
 * be worth standing in. A multiplier is invisible — you have to be told it
 * exists — whereas a mine that visibly coughs gems onto the floor every few
 * seconds teaches itself, and the pile that builds up while nobody is there is
 * an open invitation to go and contest it.
 *
 * The blow at the end is the second half. Matches were decided well before the
 * whistle once a leader was far enough ahead, so the closing minute had nothing
 * in it; a payout worth several minutes of farming, at a spot everyone can
 * reach and on a clock everyone can see, means the last thirty seconds are the
 * ones people fight over.
 */
export const MINE = {
  radius: 2.2,
  /** Seconds between ordinary drops, and how many gems each drop scatters. */
  interval: 10,
  gemsPerDrop: 3,
  gemValue: 3,
  /** Gems flung by the detonation, and what each is worth. */
  blastGems: 24,
  blastGemValue: 5,
  /** How far gems are thrown. The blast reaches further, so it needs contesting. */
  scatterRadius: 2.6,
  blastScatterRadius: 7,
  /** The warning window before the blast, in seconds before the match ends. */
  warningSeconds: 20,
  /** When the blast lands, in seconds before the match ends. */
  blastSeconds: 8,
} as const;

export function spawnMine(store: EntityStore, x: number, y: number): Entity {
  const e = store.spawn('mine');
  e.x = x;
  e.y = y;
  e.team = TEAM_NEUTRAL;
  e.radius = MINE.radius;
  // Indestructible: the mine is scenery on a timer, not something to be farmed
  // down early by whoever gets there first.
  e.maxHp = 1;
  e.hp = 1;
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

export function spawnChest(
  store: EntityStore,
  x: number,
  y: number,
  rarity: Rarity = 'common',
): Entity {
  const e = store.spawn('chest');
  e.rarity = rarity;
  e.x = x;
  e.y = y;
  e.team = TEAM_NEUTRAL;
  e.radius = 0.5;
  e.maxHp = 1;
  e.hp = 1;
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

/**
 * An authored placement, snapped to standable ground.
 *
 * The source art places objects on tiles that this sim then seals off — a crate
 * on a decorative islet, or one the arena's unreachable-pocket pass turned to
 * void. Rather than dropping those (which would quietly thin out whole corners
 * of a map), each is nudged to the nearest open tile within a couple of tiles.
 */
function snap(
  tiles: Uint8Array,
  size: number,
  x: number,
  y: number,
  footprint: number,
): { x: number; y: number } | null {
  for (let r = 0; r <= 2; r++) {
    for (let oy = -r; oy <= r; oy++) {
      for (let ox = -r; ox <= r; ox++) {
        if (Math.max(Math.abs(ox), Math.abs(oy)) !== r) continue;
        const px = x + ox;
        const py = y + oy;
        if (px < 1 || py < 1 || px >= size - 1 || py >= size - 1) continue;
        if (tiles[tileIndex(px, py, size)] === TILE_WALL) continue;
        if (!hasClearance(tiles, px + 0.5, py + 0.5, footprint, size)) continue;
        return { x: px + 0.5, y: py + 0.5 };
      }
    }
  }
  return null;
}

/**
 * Fill the world with the arena's props, nodes, camps and chest pads.
 *
 * Placements come from the map data — these arenas are transcriptions, and half
 * of what makes one recognisable is *where the crates are*, not just where the
 * walls are. Fields are the one exception: the source art has no distinct
 * farmable-crop object, so they are still scattered, seeded off the match rng.
 */
export function populateArena(
  store: EntityStore,
  tiles: Uint8Array,
  rng: Rng,
  objects: ArenaObjects,
): { camps: CreepCamp[]; chestSpots: { x: number; y: number }[] } {
  const size = MAP.size;

  for (const [x, y] of objects.props) {
    const spot = snap(tiles, size, x, y, 0.6);
    if (spot) spawnProp(store, spot.x, spot.y);
  }

  for (const [x, y] of objects.nodes) {
    const spot = snap(tiles, size, x, y, 0.85);
    if (spot) spawnNode(store, spot.x, spot.y);
  }

  const camps: CreepCamp[] = [];
  for (const [x, y] of objects.camps) {
    const spot = snap(tiles, size, x, y, 1.4);
    if (!spot) continue;
    const strength = creepStrengthAt(spot.x, spot.y);
    const id = camps.length;
    camps.push({
      id,
      x: spot.x,
      y: spot.y,
      respawnIn: 0,
      bonus: Math.round(GEM_YIELD.creepCampBonus * strength),
      coinBonus: Math.round(COIN_YIELD.creepCampBonus * strength),
      strength,
    });
    for (let k = 0; k < MAP.creepsPerCamp; k++) {
      const angle = (k / MAP.creepsPerCamp) * Math.PI * 2;
      spawnCreep(store, spot.x + Math.cos(angle) * 0.9, spot.y + Math.sin(angle) * 0.9, id, strength);
    }
  }

  for (const [x, y] of objects.trees) {
    const spot = snap(tiles, size, x, y, 1.1);
    if (spot) spawnFarmable(store, 'tree', spot.x, spot.y);
  }
  for (let i = 0; i < MAP.fields; i++) {
    const spot = centreBiasedSpot(tiles, rng, size, 1.2, store, 0.8);
    spawnFarmable(store, 'field', spot.x, spot.y);
  }

  const chestSpots: { x: number; y: number }[] = [];
  for (const [x, y] of objects.chests) {
    const spot = snap(tiles, size, x, y, 0.85);
    if (!spot) continue;
    chestSpots.push(spot);
    spawnChest(store, spot.x, spot.y, 'common');
  }

  return { camps, chestSpots };
}

/** Which rarities can appear at this point in the match. */
export function unlockedRarities(elapsedSeconds: number): Rarity[] {
  return RARITIES.filter((r) => elapsedSeconds >= MATCH.rarityUnlockSeconds[r]);
}

/**
 * Pick the rarity a freshly-placed chest deals from.
 *
 * Weighted rather than uniform, and weighted toward Common, so the cheap
 * rebuild stays available all match instead of the map filling with Epics
 * nobody can afford after the last unlock.
 */
export function rollChestRarity(rng: Rng, elapsedSeconds: number): Rarity {
  const open = unlockedRarities(elapsedSeconds);
  let total = 0;
  for (const r of open) total += MATCH.rarityWeight[r];
  let roll = rng.float() * total;
  for (const r of open) {
    roll -= MATCH.rarityWeight[r];
    if (roll <= 0) return r;
  }
  return open[open.length - 1] ?? 'common';
}

/**
 * What a chest of this rarity can offer.
 *
 * Summoned helpers are excluded by construction — `PLAYABLE_UNIT_TYPES` filters
 * them — so a chest can never offer a Skeleton, which would be a dead pick and
 * would let a player bypass the Summoner that is supposed to earn it.
 */
export function chestPool(rarity: Rarity): UnitType[] {
  const pool = unitsOfRarity(rarity);
  // Never hand back an empty pool: a chest with nothing to offer would consume
  // the player's walk-up and silently do nothing.
  return pool.length > 0 ? pool : unitsOfRarity('common');
}

/**
 * How badly this player wants to be offered `type`, relative to the rest.
 *
 * Chests used to deal a flat shuffle of the rarity's roster, which meant the
 * most common thing a chest could do was hand you a fourth Brute when you
 * already had a maxed one — a strictly dead pick, since a topped-out unit
 * cannot fuse again. Three offers drawn uniformly from a dozen types made that
 * happen constantly, and the fusion system is the most interesting decision in
 * the game to be routing players away from.
 *
 * So the weights follow how much closer the pick would take you to a fusion:
 *
 *  - **one short of fusing** is the pick that actually completes something, and
 *    is what should turn up when you are sitting on two of a kind.
 *  - **no mega of this type yet** is the general case the request is about —
 *    anything you have not topped out is still a live fusion line.
 *  - **already maxed** stays possible, because a spare body still fights and
 *    still soaks damage; it just stops crowding out the picks that build.
 *
 * Read off the *current* squad rather than a per-match history, so losing a
 * mega in a fight puts that type back in rotation — which is the behaviour you
 * want when you are rebuilding.
 */
export function chestOfferWeight(
  squad: Entity[],
  type: UnitType,
  maxTier: UnitTier = MAX_TIER,
): number {
  for (const u of squad) {
    if (u.alive && u.unitType === type && u.tier >= maxTier) return 1;
  }
  for (let tier = 0; tier < maxTier; tier++) {
    if (untilFusion(squad, type, tier as UnitTier) === 1) return 8;
  }
  return 4;
}

/**
 * Draw `count` distinct types for a chest, weighted toward unfinished fusions.
 *
 * Weighted sampling without replacement: each draw picks proportionally, then
 * removes the winner so a chest never offers the same unit twice.
 */
export function buildChestOffer(
  rng: Rng,
  pool: readonly UnitType[],
  squad: Entity[],
  count: number,
  maxTier: UnitTier = MAX_TIER,
): UnitType[] {
  const remaining = pool.slice();
  const weights = remaining.map((t) => chestOfferWeight(squad, t, maxTier));
  const offer: UnitType[] = [];

  while (offer.length < count && remaining.length > 0) {
    let total = 0;
    for (const w of weights) total += w;
    let roll = rng.float() * total;
    let i = 0;
    // The final index is the guard against float error leaving `roll` just
    // above the running total.
    while (i < remaining.length - 1 && (roll -= weights[i]!) > 0) i++;
    offer.push(remaining[i]!);
    remaining.splice(i, 1);
    weights.splice(i, 1);
  }
  return offer;
}

/**
 * Extra population a Battle Mod asks for, laid down after the normal arena.
 *
 * Kept here rather than in `World` so all placement rules — clearance from
 * rock, centre bias, not landing on top of something else — stay in one file.
 */
export function applyBattleModTerrain(
  store: EntityStore,
  tiles: Uint8Array,
  rng: Rng,
  mod: BattleMod,
): void {
  const size = MAP.size;

  for (let i = 0; i < mod.extraProps; i++) {
    const spot = centreBiasedSpot(tiles, rng, size, 0.7, store, 0.6);
    spawnProp(store, spot.x, spot.y);
  }
  for (let i = 0; i < mod.extraTrees; i++) {
    const spot = centreBiasedSpot(tiles, rng, size, 1.2, store, 1.1);
    spawnFarmable(store, 'tree', spot.x, spot.y);
  }
  for (let i = 0; i < mod.extraCentreNodes; i++) {
    // Deliberately jammed into the middle: the point of a richer mine is that
    // it is somewhere you have to contest, not more ore on your own doorstep.
    const spot = centreSpot(tiles, rng, size, store);
    spawnNode(store, spot.x, spot.y);
  }
  for (let i = 0; i < mod.giants; i++) {
    const spot = centreBiasedSpot(tiles, rng, size, 3.0, store, 1.6);
    spawnGiant(store, spot.x, spot.y);
  }
  for (let i = 0; i < mod.lootGoblins; i++) {
    const spot = centreBiasedSpot(tiles, rng, size, 1.5, store, 0.9);
    spawnLootGoblin(store, spot.x, spot.y);
  }
}

/** A spot inside the contested centre ring. */
function centreSpot(
  tiles: Uint8Array,
  rng: Rng,
  size: number,
  store: EntityStore,
): { x: number; y: number } {
  for (let attempt = 0; attempt < 200; attempt++) {
    const spot = findOpenTile(tiles, rng, size, 40);
    if (zoneAt(spot.x, spot.y) > 1) continue;
    if (!hasClearance(tiles, spot.x, spot.y, 0.85, size)) continue;
    if (isOccupied(store, spot.x, spot.y, 1.3)) continue;
    return spot;
  }
  return centreBiasedSpot(tiles, rng, size, 1.3, store, 0.85);
}

/**
 * A lone, very tough monster worth a large payout.
 * Not part of a camp, so clearing it pays no camp bonus — the value is all in
 * the kill itself.
 */
export function spawnGiant(store: EntityStore, x: number, y: number): Entity {
  const e = spawnCreep(store, x, y, -1, 1);
  e.maxHp = CREEP_HP * 9;
  e.hp = e.maxHp;
  e.radius = 0.7;
  e.value = GEM_YIELD.creep * 14;
  e.coinValue = COIN_YIELD.creep * 8;
  return e;
}

/** A fragile monster stuffed with coins. Worth chasing, easy to kill. */
export function spawnLootGoblin(store: EntityStore, x: number, y: number): Entity {
  const e = spawnCreep(store, x, y, -1, 1);
  e.maxHp = CREEP_HP * 0.5;
  e.hp = e.maxHp;
  e.radius = 0.26;
  e.value = GEM_YIELD.creep;
  e.coinValue = COIN_YIELD.creep * 10;
  return e;
}
