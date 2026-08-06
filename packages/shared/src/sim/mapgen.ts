/**
 * Seeded arena generation (brief §1.8).
 *
 * Terrain is a flat Uint8Array of tile kinds. Generation is driven entirely by
 * the world's seed, so the host sends a seed rather than a tile dump and every
 * client rebuilds an identical map.
 *
 * Fairness constraints, enforced rather than hoped for:
 *  - home pads are evenly spaced on the rim and always on floor
 *  - the centre is kept open so the contested zone can't be walled off
 *  - every home pad has a verified floor path to the centre
 */

import { MAP, TILE_FLOOR, TILE_WALL } from '../config/map.ts';
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
}

// `size` is annotated `number` rather than inferred: MAP is `as const`, so
// MAP.size has the literal type 64 and would make these only callable with 64.
export function tileIndex(x: number, y: number, size: number = MAP.size): number {
  return y * size + x;
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
 * Blobby rock clusters rather than uniform noise — single scattered tiles read
 * as visual noise and don't create the chokepoints the brief asks for.
 */
function scatterTerrain(tiles: Uint8Array, rng: Rng, size: number): void {
  const cx = size / 2;
  const cy = size / 2;
  const keepOpen = MAP.zoneRadii[0]! * 0.55; // centre stays fightable
  const clusters = Math.floor(size * size * MAP.terrainDensity * 0.06);

  for (let c = 0; c < clusters; c++) {
    const bx = rng.int(2, size - 2);
    const by = rng.int(2, size - 2);
    const blobSize = rng.int(3, 9);
    let px = bx;
    let py = by;
    for (let i = 0; i < blobSize; i++) {
      const d = Math.hypot(px - cx, py - cy);
      const nearRim = px < 2 || py < 2 || px >= size - 2 || py >= size - 2;
      if (d > keepOpen && !nearRim) {
        tiles[tileIndex(px, py, size)] = TILE_WALL;
      }
      // Random walk keeps blobs organic and connected.
      px = Math.max(1, Math.min(size - 2, px + rng.int(-1, 2)));
      py = Math.max(1, Math.min(size - 2, py + rng.int(-1, 2)));
    }
  }

  // Solid border so nothing can leave the arena.
  for (let i = 0; i < size; i++) {
    tiles[tileIndex(i, 0, size)] = TILE_WALL;
    tiles[tileIndex(i, size - 1, size)] = TILE_WALL;
    tiles[tileIndex(0, i, size)] = TILE_WALL;
    tiles[tileIndex(size - 1, i, size)] = TILE_WALL;
  }
}

/** Flood fill from the centre; returns the set of reachable floor tiles. */
function reachableFromCentre(tiles: Uint8Array, size: number): Uint8Array {
  const seen = new Uint8Array(size * size);
  const startX = Math.floor(size / 2);
  const startY = Math.floor(size / 2);
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

/**
 * Carve a straight corridor between two points.
 * Used to guarantee home-pad connectivity rather than rejecting and retrying
 * the whole map, which could loop for a long time on an unlucky seed.
 */
function carveCorridor(
  tiles: Uint8Array,
  size: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): void {
  let x = Math.floor(ax);
  let y = Math.floor(ay);
  const tx = Math.floor(bx);
  const ty = Math.floor(by);
  let guard = 0;
  while ((x !== tx || y !== ty) && guard++ < size * 4) {
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        const cx2 = x + ox;
        const cy2 = y + oy;
        if (cx2 > 0 && cy2 > 0 && cx2 < size - 1 && cy2 < size - 1) {
          tiles[tileIndex(cx2, cy2, size)] = TILE_FLOOR;
        }
      }
    }
    if (x !== tx) x += Math.sign(tx - x);
    else if (y !== ty) y += Math.sign(ty - y);
  }
}

export function generateMap(rng: Rng, playerCount: number): GeneratedMap {
  const size = MAP.size;
  const tiles = new Uint8Array(size * size).fill(TILE_FLOOR);
  scatterTerrain(tiles, rng, size);

  // Home pads evenly spaced around the rim (§1.8: one per player, spread evenly).
  const cx = size / 2;
  const cy = size / 2;
  const pads: HomePad[] = [];
  const n = Math.max(1, playerCount);
  for (let i = 0; i < n; i++) {
    const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
    const px = Math.round(cx + Math.cos(angle) * MAP.homePadRadius);
    const py = Math.round(cy + Math.sin(angle) * MAP.homePadRadius);
    const clampedX = Math.max(2, Math.min(size - 3, px));
    const clampedY = Math.max(2, Math.min(size - 3, py));

    // A pad must never spawn inside rock.
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        tiles[tileIndex(clampedX + ox, clampedY + oy, size)] = TILE_FLOOR;
      }
    }
    pads.push({ playerIndex: i, x: clampedX + 0.5, y: clampedY + 0.5 });
  }

  // Guarantee every pad can actually reach the centre.
  let reach = reachableFromCentre(tiles, size);
  for (const pad of pads) {
    if (reach[tileIndex(Math.floor(pad.x), Math.floor(pad.y), size)] !== 1) {
      carveCorridor(tiles, size, pad.x, pad.y, cx, cy);
      reach = reachableFromCentre(tiles, size);
    }
  }

  return { size, tiles, homePads: pads };
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
