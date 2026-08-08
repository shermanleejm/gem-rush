/**
 * The arenas.
 *
 * The point of fixed maps is that players learn them, which only holds if they
 * genuinely never change. They are transcribed from the source art by
 * `tools/import-maps.py`, so a re-import with a changed classifier would
 * silently turn every arena into a different place. The checksums below exist
 * to make that fail loudly: if one trips, either revert the importer change or
 * re-bless the numbers deliberately, knowing that arena just changed.
 */

import { describe, expect, it } from 'vitest';

import { ARENA_DATA } from '../config/arenaData.ts';
import { MAP, TILE_FLOOR, TILE_GRASS, TILE_WALL } from '../config/map.ts';
import { ARENAS, MAP_IDS, type MapId } from '../config/maps.ts';
import { buildArena, tileIndex } from './mapgen.ts';

/** Order-sensitive rolling hash over the tile array. */
function checksum(tiles: Uint8Array): number {
  let h = 2166136261;
  for (let i = 0; i < tiles.length; i++) {
    h ^= tiles[i]! + i * 3;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** Pinned on the imported layouts. Regenerate only on a deliberate change. */
const EXPECTED: Record<MapId, number> = {
  arcadealley: 2096023570,
  boilerroom: 3183340960,
  bustervalley: 2088903292,
  dustybadlands: 4085497409,
  emeraldgrove: 3074663737,
  frozenmarsh: 2687461204,
  greenhillzone: 837392608,
  hauntedgarden: 2294850868,
  invasionisland: 2452084525,
  lavaspa: 1148660364,
  midnightmortuary: 86817805,
  pekkasplayground: 1700475989,
  provinggrounds: 1747885060,
  rowdyrink: 2197590265,
  royalrumbleyard: 2702522557,
  scavengersshore: 439522376,
  steelgauntlet: 1167883939,
  thesandpit: 3956204445,
  troublesomegulch: 3654681088,
  twistingtrails: 1628009117,
  waterwayblitz: 3269086137,
  yetipeak: 1323576148,
};

describe('the arenas', () => {
  it('are stable for a given player count', () => {
    for (const id of MAP_IDS) {
      const a = buildArena(id, 8);
      const b = buildArena(id, 8);
      expect(checksum(a.tiles), `${id} is not deterministic`).toBe(checksum(b.tiles));
    }
  });

  it('do not change when the importer does', () => {
    const actual: Record<string, number> = {};
    for (const id of MAP_IDS) actual[id] = checksum(buildArena(id, 8).tiles);

    // A zeroed baseline means the checksums have never been recorded. Print
    // them rather than failing cryptically, so blessing them is a copy-paste.
    if (Object.values(EXPECTED).every((v) => v === 0)) {
      throw new Error(
        `Arena checksums are unset. Paste these into EXPECTED:\n${JSON.stringify(actual, null, 2)}`,
      );
    }
    for (const id of MAP_IDS) {
      expect(actual[id], `arena "${id}" changed — every player's map knowledge just broke`).toBe(
        EXPECTED[id],
      );
    }
  });

  /**
   * Pairs that share a layout in the source, re-skinned into another world.
   *
   * Not an import bug — Supercell built three of these maps twice. They stay in
   * as separate arenas because they *play* the same but *read* differently, and
   * cutting one would mean shipping fewer maps than the game has.
   */
  const RESKINS = [
    ['greenhillzone', 'scavengersshore'],
    ['hauntedgarden', 'twistingtrails'],
    ['dustybadlands', 'midnightmortuary'],
  ];

  it('are all distinct places, not reshuffles of one', () => {
    // Jaccard distance over interior void. Measured on the interior because the
    // outer band is structural and similar in every map — include it and two
    // unrelated layouts come out looking most of the way identical.
    const voids = (id: MapId): Uint8Array => buildArena(id, 8).tiles;
    for (let i = 0; i < MAP_IDS.length; i++) {
      for (let j = i + 1; j < MAP_IDS.length; j++) {
        const [idA, idB] = [MAP_IDS[i]!, MAP_IDS[j]!];
        if (RESKINS.some(([p, q]) => (p === idA && q === idB) || (p === idB && q === idA))) continue;
        const a = voids(idA);
        const b = voids(idB);
        let both = 0;
        let either = 0;
        for (let y = 6; y < MAP.size - 6; y++) {
          for (let x = 6; x < MAP.size - 6; x++) {
            const k = tileIndex(x, y, MAP.size);
            const wa = a[k] === TILE_WALL;
            const wb = b[k] === TILE_WALL;
            if (wa && wb) both++;
            if (wa || wb) either++;
          }
        }
        expect(1 - both / either, `${idA} and ${idB} are too alike`).toBeGreaterThan(0.5);
      }
    }
  });

  it('are fair: balanced quadrants and reachable pads', () => {
    for (const id of MAP_IDS) {
      const { tiles, homePads, mine } = buildArena(id, 8);

      // No quadrant may be appreciably more walled off than another, or whoever
      // spawns on the open side gets a free run at the contested centre.
      const walls = [0, 0, 0, 0];
      const counts = [0, 0, 0, 0];
      for (let y = 1; y < MAP.size - 1; y++) {
        for (let x = 1; x < MAP.size - 1; x++) {
          const q = (x < MAP.size / 2 ? 0 : 1) + (y < MAP.size / 2 ? 0 : 2);
          counts[q]!++;
          if (tiles[tileIndex(x, y, MAP.size)] === TILE_WALL) walls[q]!++;
        }
      }
      const fracs = walls.map((w, i) => w / counts[i]!);
      expect(Math.max(...fracs) - Math.min(...fracs), `${id} is lopsided`).toBeLessThan(0.12);

      // Every pad must stand on clear ground and reach the mine on foot.
      const reach = reachable(tiles, Math.floor(mine.x), Math.floor(mine.y));
      for (const pad of homePads) {
        const k = tileIndex(Math.floor(pad.x), Math.floor(pad.y), MAP.size);
        expect(tiles[k], `${id}: a pad is in the void`).toBe(TILE_FLOOR);
        expect(reach[k], `${id}: a pad cannot reach the mine`).toBe(1);
      }
    }
  });

  it('are a single connected region', () => {
    // The importer seals unreachable pockets, so anything walkable must be
    // walkable *from the mine* — otherwise the spawner can strand crates and
    // chests on ground no player can ever stand on.
    for (const id of MAP_IDS) {
      const { tiles, mine } = buildArena(id, 8);
      const reach = reachable(tiles, Math.floor(mine.x), Math.floor(mine.y));
      let walkable = 0;
      let reached = 0;
      for (let i = 0; i < tiles.length; i++) {
        if (tiles[i] === TILE_WALL) continue;
        walkable++;
        if (reach[i] === 1) reached++;
      }
      expect(reached, `${id} has a marooned pocket`).toBe(walkable);
    }
  });

  it('carry real cover and real grass', () => {
    for (const id of MAP_IDS) {
      const tiles = buildArena(id, 8).tiles;
      let wall = 0;
      let grass = 0;
      let interior = 0;
      for (let y = 1; y < MAP.size - 1; y++) {
        for (let x = 1; x < MAP.size - 1; x++) {
          interior++;
          const t = tiles[tileIndex(x, y, MAP.size)];
          if (t === TILE_WALL) wall++;
          else if (t === TILE_GRASS) grass++;
        }
      }
      // Enough void to make chokepoints, not so much it becomes corridors.
      expect(wall / interior, `${id} cover`).toBeGreaterThan(0.1);
      expect(wall / interior, `${id} cover`).toBeLessThan(0.45);
      // Grass has to be worth routing around to justify slowing anyone down.
      expect(grass / interior, `${id} grass`).toBeGreaterThan(0.04);
    }
  });

  it('puts a gem mine at the centre of every arena', () => {
    for (const id of MAP_IDS) {
      const { mine, tiles } = buildArena(id, 8);
      expect(Math.hypot(mine.x - MAP.size / 2, mine.y - MAP.size / 2), `${id} mine`).toBeLessThan(2);
      expect(tiles[tileIndex(Math.floor(mine.x), Math.floor(mine.y), MAP.size)]).not.toBe(TILE_WALL);
    }
  });

  it('names every arena it declares', () => {
    // MAP_IDS is hand-written and arenaData.ts is generated; this is what stops
    // the two halves drifting after a re-import adds or renames a map.
    expect(ARENA_DATA.map((a) => a.id).sort()).toEqual([...MAP_IDS].sort());
    for (const id of MAP_IDS) {
      expect(ARENAS[id].id).toBe(id);
      expect(ARENAS[id].name.length).toBeGreaterThan(0);
      expect(ARENAS[id].world.length).toBeGreaterThan(0);
    }
  });
});

/** Flood fill from a point over anything walkable. */
function reachable(tiles: Uint8Array, startX: number, startY: number): Uint8Array {
  const size = MAP.size;
  const seen = new Uint8Array(size * size);
  const start = tileIndex(startX, startY, size);
  const stack = [start];
  seen[start] = 1;
  while (stack.length > 0) {
    const idx = stack.pop()!;
    const x = idx % size;
    const y = (idx / size) | 0;
    for (const [nx, ny] of [
      [x + 1, y],
      [x - 1, y],
      [x, y + 1],
      [x, y - 1],
    ] as const) {
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      const n = tileIndex(nx, ny, size);
      // Grass is walkable — slow, but never a barrier.
      if (seen[n] === 1 || tiles[n] === TILE_WALL) continue;
      if (tiles[n] !== TILE_FLOOR && tiles[n] !== TILE_GRASS) continue;
      seen[n] = 1;
      stack.push(n);
    }
  }
  return seen;
}
