/**
 * Arena layout contact sheet (see arenas.html).
 *
 * Dev-only. Dumps all 22 tile maps at once, which is how you check a
 * transcription: whole shapes, spawn placement, whether an islet got sealed off
 * or a world's void colour reads as walkable ground. None of that is catchable
 * from a diff of run-length-encoded tiles.
 *
 * This does redraw the tile rules rather than driving the real renderer, which
 * is the right trade *here* — the layout data is the thing under test and a
 * plain dump is the clearest way to see it. For "does this actually look right
 * with sprites on it", see arena.html, which drives the real `Scene`.
 */

import { ARENAS, MAP_IDS, TILE_GRASS, TILE_WALL, buildArena, type MapId } from '@gem-rush/shared';

/** Blend two packed RGB colours, matching the scene's own grass derivation. */
function mix(a: number, b: number, t: number): string {
  const ch = (s: number): number => Math.round(((a >> s) & 0xff) * (1 - t) + ((b >> s) & 0xff) * t);
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}

const hex = (c: number): string => `#${c.toString(16).padStart(6, '0')}`;

function drawLayout(id: MapId): HTMLCanvasElement {
  const { tiles, size, homePads, mine } = buildArena(id, 8);
  const palette = ARENAS[id].palette;
  const px = 4;

  const canvas = document.createElement('canvas');
  canvas.width = size * px;
  canvas.height = size * px;
  const ctx = canvas.getContext('2d')!;

  const grass = mix(palette.floor, 0x000000, 0.32);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const t = tiles[y * size + x];
      ctx.fillStyle =
        t === TILE_WALL
          ? hex(palette.void)
          : t === TILE_GRASS
            ? grass
            : ((x >> 1) + (y >> 1)) % 2 === 0
              ? hex(palette.floorAlt)
              : hex(palette.floor);
      ctx.fillRect(x * px, y * px, px, px);
    }
  }

  // Spawns and the mine, so a layout that strands a player is obvious here
  // rather than three minutes into a match.
  for (const pad of homePads) {
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(pad.x * px, pad.y * px, px * 1.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.strokeStyle = '#ff3b6b';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.arc(mine.x * px, mine.y * px, px * 2.6, 0, Math.PI * 2);
  ctx.stroke();

  return canvas;
}

const grid = document.getElementById('grid')!;
for (const id of MAP_IDS as readonly MapId[]) {
  const cell = document.createElement('figure');
  cell.className = 'cell';
  const cap = document.createElement('figcaption');
  cap.innerHTML = `${ARENAS[id].name}<br /><span>${ARENAS[id].world}</span>`;
  const link = document.createElement('a');
  link.href = `/arena.html#${id}`;
  link.appendChild(drawLayout(id));
  cell.append(link, cap);
  grid.appendChild(cell);
}

document.body.dataset.ready = 'true';
