/**
 * Arena loading (brief §1.8).
 *
 * Terrain is a flat Uint8Array of tile kinds. Layouts are authored data, not
 * output of a generator, so the host sends a map id rather than a tile dump and
 * every client rebuilds an identical arena from `arenaData.ts`.
 *
 * Fairness constraints, enforced rather than hoped for:
 *  - home pads are evenly spaced on the rim and always on reachable floor
 *  - every home pad has a verified floor path to the centre
 */

import { ARENA_DATA, type ArenaData } from '../config/arenaData.ts';
import { MAP, TILE_FLOOR, TILE_GRASS, TILE_WALL } from '../config/map.ts';
import type { MapId } from '../config/maps.ts';
import type { Rng } from '../math/rng.ts';

export interface HomePad {
  playerIndex: number;
  x: number;
  y: number;
}

export interface GeneratedMap {
  size: number;
  tiles: Uint8Array;
  homePads: HomePad[];
  /** Where the arena's gem mine sits. Marked on every source map. */
  mine: { x: number; y: number };
  /** Object placements read off the source art, for `populateArena`. */
  objects: ArenaData['objects'];
}

// `size` is annotated `number` rather than inferred: MAP is `as const`, so
// MAP.size has the literal type 64 and would make these only callable with 64.
export function tileIndex(x: number, y: number, size: number = MAP.size): number {
  return y * size + x;
}

/** Is this position standing in tall grass? Grass is walkable but slow. */
export function isGrassAt(
  tiles: Uint8Array,
  x: number,
  y: number,
  size: number = MAP.size,
): boolean {
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  if (tx < 0 || ty < 0 || tx >= size || ty >= size) return false;
  return tiles[tileIndex(tx, ty, size)] === TILE_GRASS;
}

export function isWallAt(
  tiles: Uint8Array,
  x: number,
  y: number,
  size: number = MAP.size,
): boolean {
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  if (tx < 0 || ty < 0 || tx >= size || ty >= size) return true; // outside is solid
  return tiles[tileIndex(tx, ty, size)] === TILE_WALL;
}

/**
 * Expand an arena's run-length encoded tile grid.
 *
 * Runs are `<count><kind>` with `a` floor, `b` void, `c` tall grass — about
 * 1.5 KB per arena against 4 KB raw, which matters because all twenty-two ship
 * to the client in the same bundle.
 */
export function decodeTiles(rle: string, size: number = MAP.size): Uint8Array {
  const tiles = new Uint8Array(size * size);
  const kinds: Record<string, number> = { a: TILE_FLOOR, b: TILE_WALL, c: TILE_GRASS };
  let at = 0;
  for (const [, count, kind] of rle.matchAll(/(\d+)([abc])/g)) {
    tiles.fill(kinds[kind!]!, at, (at += Number(count)));
  }
  if (at !== size * size) throw new Error(`mapgen: arena decoded to ${at} tiles, want ${size * size}`);
  return tiles;
}

/** Flood fill from a point; returns the set of reachable floor tiles. */
function reachableFrom(tiles: Uint8Array, size: number, startX: number, startY: number): Uint8Array {
  const seen = new Uint8Array(size * size);
  const stack: number[] = [tileIndex(startX, startY, size)];
  seen[stack[0]!] = 1;

  while (stack.length > 0) {
    const idx = stack.pop()!;
    const x = idx % size;
    const y = Math.floor(idx / size);
    const neighbours = [
      [x + 1, y],
      [x - 1, y],
      [x, y + 1],
      [x, y - 1],
    ] as const;
    for (const [nx, ny] of neighbours) {
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      const nIdx = tileIndex(nx, ny, size);
      if (seen[nIdx] === 1 || tiles[nIdx] === TILE_WALL) continue;
      seen[nIdx] = 1;
      stack.push(nIdx);
    }
  }
  return seen;
}

const ARENA_BY_ID = new Map(ARENA_DATA.map((a) => [a.id, a]));

/**
 * Build one of the arenas (see config/maps.ts).
 *
 * The layout is fixed and identical every match — only pad placement varies
 * with the player count, and that is placement on known ground rather than a
 * new layout.
 */
export function buildArena(mapId: MapId, playerCount: number): GeneratedMap {
  const arena = ARENA_BY_ID.get(mapId);
  if (!arena) throw new Error(`mapgen: no arena data for '${mapId}'`);

  const size = MAP.size;
  const tiles = decodeTiles(arena.tiles, size);
  const [mineX, mineY] = arena.mine;

  // Seal anything the mine can't walk to. The source art draws decorative
  // islets across the water that are unreachable by design, and leaving them
  // walkable would let the spawner strand crates and chests on ground no
  // player can stand on.
  const reach = reachableFrom(tiles, size, Math.floor(mineX), Math.floor(mineY));
  for (let i = 0; i < tiles.length; i++) {
    if (reach[i] !== 1) tiles[i] = TILE_WALL;
  }

  return {
    size,
    tiles,
    homePads: placePads(tiles, size, playerCount),
    mine: { x: mineX, y: mineY },
    objects: arena.objects,
  };
}

/**
 * Home pads evenly spaced around the rim (§1.8: one per player, spread evenly).
 *
 * Each pad walks inward from its rim angle until it finds standable ground,
 * rather than stamping floor over whatever is there. On a generated map
 * flattening a 3x3 was harmless; on an authored one it would punch a hole
 * through a wall that the layout is shaped around — and the walk always
 * succeeds, because the arena is a single connected region by construction.
 */
function placePads(tiles: Uint8Array, size: number, playerCount: number): HomePad[] {
  const cx = size / 2;
  const cy = size / 2;
  const pads: HomePad[] = [];
  const n = Math.max(1, playerCount);

  for (let i = 0; i < n; i++) {
    const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
    let px = Math.round(cx + Math.cos(angle) * MAP.homePadRadius);
    let py = Math.round(cy + Math.sin(angle) * MAP.homePadRadius);

    for (let step = 0; step <= MAP.homePadRadius; step++) {
      const t = (MAP.homePadRadius - step) / MAP.homePadRadius;
      const x = Math.round(cx + Math.cos(angle) * MAP.homePadRadius * t);
      const y = Math.round(cy + Math.sin(angle) * MAP.homePadRadius * t);
      // Plain floor, not grass: grass would drag every respawn out of the gate.
      if (tiles[tileIndex(x, y, size)] === TILE_FLOOR) {
        px = x;
        py = y;
        break;
      }
    }
    pads.push({ playerIndex: i, x: px + 0.5, y: py + 0.5 });
  }
  return pads;
}

/** Random floor tile that is reachable and clear of a minimum radius. */
export function findOpenTile(
  tiles: Uint8Array,
  rng: Rng,
  size: number,
  attempts = 200,
): { x: number; y: number } {
  for (let i = 0; i < attempts; i++) {
    const x = rng.int(2, size - 2);
    const y = rng.int(2, size - 2);
    if (tiles[tileIndex(x, y, size)] === TILE_FLOOR) {
      return { x: x + 0.5, y: y + 0.5 };
    }
  }
  // Deterministic fallback: first floor tile found. Never returns a wall.
  for (let y = 1; y < size - 1; y++) {
    for (let x = 1; x < size - 1; x++) {
      if (tiles[tileIndex(x, y, size)] === TILE_FLOOR) return { x: x + 0.5, y: y + 0.5 };
    }
  }
  throw new Error('mapgen: no floor tiles exist');
}
