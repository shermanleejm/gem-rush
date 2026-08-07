/**
 * The five fixed arenas.
 *
 * The point of fixed maps is that players learn them, which only holds if they
 * genuinely never change. They are stored as generator seeds rather than tile
 * dumps, so an innocent-looking edit to `scatterTerrain` would silently turn
 * all five into different places. The checksums below exist to make that fail
 * loudly: if one trips, either revert the generator change or re-bless the
 * numbers deliberately, knowing every arena just changed.
 */

import { describe, expect, it } from 'vitest';

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

/** Pinned on the curated seeds. Regenerate only on a deliberate change. */
const EXPECTED: Record<MapId, number> = {
  quarry: 959906205,
  crossroads: 1066321964,
  basin: 2132829555,
  thicket: 266986803,
  foundry: 847522436,
};

describe('the five arenas', () => {
  it('are stable for a given player count', () => {
    for (const id of MAP_IDS) {
      const a = buildArena(id, 8);
      const b = buildArena(id, 8);
      expect(checksum(a.tiles), `${id} is not deterministic`).toBe(checksum(b.tiles));
    }
  });

  it('do not change when the generator does', () => {
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

  it('are all distinct places, not reshuffles of one', () => {
    // Jaccard distance over interior walls. Measured on walls because only ~12%
    // of the arena is rock, and measured on the interior because the border is
    // structural and identical in every map — include either and two unrelated
    // layouts come out looking 70% the same.
    const walls = (id: MapId): Uint8Array => buildArena(id, 8).tiles;
    for (let i = 0; i < MAP_IDS.length; i++) {
      for (let j = i + 1; j < MAP_IDS.length; j++) {
        const a = walls(MAP_IDS[i]!);
        const b = walls(MAP_IDS[j]!);
        let both = 0;
        let either = 0;
        for (let y = 1; y < MAP.size - 1; y++) {
          for (let x = 1; x < MAP.size - 1; x++) {
            const k = tileIndex(x, y, MAP.size);
            const wa = a[k] === TILE_WALL;
            const wb = b[k] === TILE_WALL;
            if (wa && wb) both++;
            if (wa || wb) either++;
          }
        }
        const distance = 1 - both / either;
        expect(distance, `${MAP_IDS[i]} and ${MAP_IDS[j]} are too alike`).toBeGreaterThan(0.85);
      }
    }
  });

  it('are fair: balanced quadrants and reachable pads', () => {
    for (const id of MAP_IDS) {
      const { tiles, homePads } = buildArena(id, 8);

      // No quadrant may be appreciably rockier than another, or whoever spawns
      // on the open side gets a free run at the contested centre.
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
      expect(Math.max(...fracs) - Math.min(...fracs), `${id} is lopsided`).toBeLessThan(0.05);

      // Every pad must stand on clear ground and reach the middle on foot.
      const reach = reachable(tiles);
      for (const pad of homePads) {
        const k = tileIndex(Math.floor(pad.x), Math.floor(pad.y), MAP.size);
        expect(tiles[k], `${id}: a pad is inside rock`).not.toBe(TILE_WALL);
        expect(reach[k], `${id}: a pad cannot reach the centre`).toBe(1);
      }
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
      // Enough rock to make chokepoints, not so much it becomes corridors.
      expect(wall / interior, `${id} cover`).toBeGreaterThan(0.06);
      expect(wall / interior, `${id} cover`).toBeLessThan(0.2);
      // Grass has to be worth routing around to justify slowing anyone down.
      expect(grass / interior, `${id} grass`).toBeGreaterThan(0.04);
    }
  });

  it('names every arena it declares', () => {
    for (const id of MAP_IDS) {
      expect(ARENAS[id].id).toBe(id);
      expect(ARENAS[id].name.length).toBeGreaterThan(0);
    }
    const seeds = MAP_IDS.map((id) => ARENAS[id].seed);
    expect(new Set(seeds).size, 'two arenas share a seed').toBe(seeds.length);
  });
});

/** Flood fill from the arena centre over anything walkable. */
function reachable(tiles: Uint8Array): Uint8Array {
  const size = MAP.size;
  const seen = new Uint8Array(size * size);
  const start = tileIndex(size >> 1, size >> 1, size);
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
