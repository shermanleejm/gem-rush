/**
 * Renders every baked sprite into one contact sheet (see sprites.html).
 *
 * Dev-only: not an entry point of the production build. The point is to judge
 * the 3D models at a size where lighting and proportion are actually visible,
 * and to check the two things that only go wrong in context — whether a sprite
 * still reads once tinted, and whether it holds its silhouette against the dark
 * game floor rather than dissolving into it.
 */

import { buildSpriteAtlas, type SpriteKey } from '../render/sprites3d.ts';

const CELL = 128;
const PAD = 14;
const LABEL = 20;
/** Mid-blue, close to a real team colour, to prove tinting keeps the shading. */
const TINT = '#4d8dff';
const FLOOR = '#181c26';

const atlas = buildSpriteAtlas();
const keys = Object.keys(atlas) as SpriteKey[];

const canvas = document.getElementById('sheet') as HTMLCanvasElement;
const cols = keys.length;
const rows = 3;
const dpr = Math.min(devicePixelRatio || 1, 2);

canvas.width = (cols * (CELL + PAD) + PAD) * dpr;
canvas.height = (rows * (CELL + PAD + LABEL) + PAD) * dpr;
canvas.style.width = `${canvas.width / dpr}px`;
canvas.style.height = `${canvas.height / dpr}px`;

const ctx = canvas.getContext('2d')!;
ctx.scale(dpr, dpr);

/**
 * Pixi textures wrap the canvas each sprite was baked into, so the raw image is
 * reachable without going through a renderer.
 */
function imageFor(key: SpriteKey): CanvasImageSource {
  return atlas[key].source.resource as CanvasImageSource;
}

/** Multiply a sprite by a flat colour, the same operation Pixi's tint performs. */
function drawTinted(img: CanvasImageSource, x: number, y: number, tint: string): void {
  const off = document.createElement('canvas');
  off.width = CELL;
  off.height = CELL;
  const o = off.getContext('2d')!;
  o.drawImage(img, 0, 0, CELL, CELL);
  o.globalCompositeOperation = 'multiply';
  o.fillStyle = tint;
  o.fillRect(0, 0, CELL, CELL);
  // Multiply also paints the transparent margin, so mask back to the silhouette.
  o.globalCompositeOperation = 'destination-in';
  o.drawImage(img, 0, 0, CELL, CELL);
  ctx.drawImage(off, x, y);
}

ctx.fillStyle = FLOOR;
ctx.fillRect(0, 0, canvas.width, canvas.height);

keys.forEach((key, i) => {
  const x = PAD + i * (CELL + PAD);
  const img = imageFor(key);

  for (let row = 0; row < rows; row++) {
    const y = PAD + row * (CELL + PAD + LABEL);

    if (row === 2) {
      ctx.fillStyle = '#d8dbe2';
      ctx.fillRect(x, y, CELL, CELL);
    }

    if (row === 1) drawTinted(img, x, y, TINT);
    else ctx.drawImage(img, x, y, CELL, CELL);

    if (row === 0) {
      ctx.fillStyle = '#8b93a7';
      ctx.font = '12px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(key, x + CELL / 2, y + CELL + 14);
    }
  }
});

// ── gameplay-scale strip ────────────────────────────────────────────────────
// The contact sheet above shows the models at 128px, which flatters them. What
// actually matters is whether they still read at the size they are drawn in a
// match, so this reproduces the scene's own numbers: BASE_SCALE px per world
// tile, times each entity's world size, with the ground shadow underneath and
// the real floor colour behind. If a detail disappears here, it does not exist.

const BASE_SCALE = 44;
/** World-space sizes, mirroring the per-kind branches in render/scene.ts. */
const PLAY_SIZES: [SpriteKey, number][] = [
  ['leader', 0.95],
  ['striker', 0.3 * 2.5],
  ['guard', 0.34 * 2.5],
  ['scout', 0.26 * 2.5],
  ['creep', 0.68],
  ['gem', 0.46],
  ['prop', 0.86],
  ['node', 1.1],
  ['chest', 1.05],
];

const strip = document.createElement('canvas');
strip.style.marginTop = '20px';
document.body.appendChild(strip);

const SCELL = 96;
strip.width = (PLAY_SIZES.length * SCELL + PAD) * dpr;
strip.height = (SCELL + LABEL + PAD * 2) * dpr;
strip.style.width = `${strip.width / dpr}px`;
strip.style.height = `${strip.height / dpr}px`;
const sctx = strip.getContext('2d')!;
sctx.scale(dpr, dpr);
sctx.fillStyle = FLOOR;
sctx.fillRect(0, 0, strip.width, strip.height);

PLAY_SIZES.forEach(([key, world], i) => {
  const px = world * BASE_SCALE;
  const cx = PAD + i * SCELL + SCELL / 2;
  const cy = PAD + SCELL / 2;

  const shadow = imageFor('shadow');
  sctx.drawImage(shadow, cx - px * 0.425, cy + px * 0.38 - px * 0.21, px * 0.85, px * 0.42);
  sctx.drawImage(imageFor(key), cx - px / 2, cy - px / 2, px, px);

  sctx.fillStyle = '#8b93a7';
  sctx.font = '11px ui-monospace, monospace';
  sctx.textAlign = 'center';
  sctx.fillText(`${key} ${Math.round(px)}px`, cx, PAD + SCELL + 14);
});

// Exposed so a screenshot isn't the only way to inspect the result — the sheets
// can be pulled out of a headless or backgrounded tab as data URLs.
Object.assign(window, {
  sheetPng: () => canvas.toDataURL('image/png'),
  stripPng: () => strip.toDataURL('image/png'),
});
