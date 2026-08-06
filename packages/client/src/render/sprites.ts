/**
 * Sprite atlas (brief §M7: "original art, no licensed or recognizable
 * characters").
 *
 * Every texture is drawn procedurally at boot rather than shipped as an image.
 * That makes the art original by construction, keeps the bundle tiny (§5
 * budgets 2MB including the atlas — this contributes zero bytes), and lets a
 * silhouette change be a code edit rather than an asset pipeline.
 *
 * Bodies are drawn white so the renderer can tint them per archetype and per
 * team; role glyphs are drawn in translucent black, so tinting darkens them
 * with the body and they stay legible against any hue.
 */

import { Graphics, type Renderer, type Texture } from 'pixi.js';

import { UNIT_TYPES, type UnitType } from '@gem-rush/shared';

/** Texture resolution. Sprites render around 30px, so 64 is ample. */
const S = 64;
const C = S / 2;
const GLYPH = { color: 0x000000, alpha: 0.42 };

export type SpriteKey =
  | UnitType
  | 'leader'
  | 'creep'
  | 'gem'
  | 'prop'
  | 'node'
  | 'chest'
  | 'ring'
  | 'spark';

export type SpriteAtlas = Record<SpriteKey, Texture>;

// ── silhouettes ─────────────────────────────────────────────────────────────

function circleBody(g: Graphics, r = 27): Graphics {
  return g.circle(C, C, r).fill(0xffffff);
}

function diamondBody(g: Graphics, r = 29): Graphics {
  return g.poly([C, C - r, C + r, C, C, C + r, C - r, C]).fill(0xffffff);
}

function shieldBody(g: Graphics): Graphics {
  // Flat-topped shield: reads as "tank" at a glance, distinct from a circle.
  return g
    .poly([C - 25, C - 22, C + 25, C - 22, C + 25, C + 6, C, C + 28, C - 25, C + 6])
    .fill(0xffffff);
}

function hexBody(g: Graphics, r = 27): Graphics {
  const pts: number[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 - Math.PI / 2;
    pts.push(C + Math.cos(a) * r, C + Math.sin(a) * r);
  }
  return g.poly(pts).fill(0xffffff);
}

function triangleBody(g: Graphics, r = 29): Graphics {
  return g.poly([C, C - r, C + r * 0.9, C + r * 0.7, C - r * 0.9, C + r * 0.7]).fill(0xffffff);
}

function roundedBody(g: Graphics, r = 24): Graphics {
  return g.roundRect(C - r, C - r, r * 2, r * 2, 8).fill(0xffffff);
}

// ── role glyphs ─────────────────────────────────────────────────────────────

function glyphSlash(g: Graphics): void {
  g.poly([C - 11, C + 9, C + 8, C - 12, C + 12, C - 8, C - 7, C + 13]).fill(GLYPH);
}

function glyphChevron(g: Graphics): void {
  g.poly([C - 10, C + 2, C, C - 9, C + 10, C + 2, C + 10, C + 8, C, C - 3, C - 10, C + 8]).fill(
    GLYPH,
  );
}

function glyphBar(g: Graphics): void {
  g.roundRect(C - 12, C - 5, 24, 8, 3).fill(GLYPH);
}

function glyphCross(g: Graphics): void {
  g.roundRect(C - 4, C - 12, 8, 24, 2).fill(GLYPH);
  g.roundRect(C - 12, C - 4, 24, 8, 2).fill(GLYPH);
}

function glyphBurst(g: Graphics): void {
  g.circle(C, C, 5).fill(GLYPH);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    g.circle(C + Math.cos(a) * 13, C + Math.sin(a) * 13, 3.5).fill(GLYPH);
  }
}

function glyphGem(g: Graphics): void {
  g.poly([C, C - 11, C + 9, C - 2, C, C + 12, C - 9, C - 2]).fill(GLYPH);
}

function glyphArrow(g: Graphics): void {
  g.poly([C, C - 4, C + 9, C + 10, C, C + 5, C - 9, C + 10]).fill(GLYPH);
}

function glyphRing(g: Graphics): void {
  g.circle(C, C, 11).fill(GLYPH);
  g.circle(C, C, 6).cut();
}

/** Silhouette + glyph per archetype. Shape carries role before colour does. */
const UNIT_ART: Record<UnitType, (g: Graphics) => void> = {
  striker: (g) => {
    circleBody(g);
    glyphSlash(g);
  },
  marksman: (g) => {
    diamondBody(g);
    glyphChevron(g);
  },
  guard: (g) => {
    shieldBody(g);
    glyphBar(g);
  },
  mender: (g) => {
    circleBody(g, 25);
    glyphCross(g);
  },
  blaster: (g) => {
    circleBody(g, 28);
    glyphBurst(g);
  },
  harvester: (g) => {
    roundedBody(g);
    glyphGem(g);
  },
  scout: (g) => {
    triangleBody(g);
    glyphArrow(g);
  },
  warden: (g) => {
    hexBody(g);
    glyphRing(g);
  },
};

// ── world objects ───────────────────────────────────────────────────────────

function leaderArt(g: Graphics): void {
  // A ring so the leader reads as a cursor rather than another unit, with a
  // solid core so it stays visible when the squad crowds around it.
  g.circle(C, C, 28).fill(0xffffff);
  g.circle(C, C, 20).cut();
  g.circle(C, C, 11).fill(0xffffff);
}

function creepArt(g: Graphics): void {
  // Jagged so neutrals never read as somebody's unit.
  const pts: number[] = [];
  const spikes = 9;
  for (let i = 0; i < spikes * 2; i++) {
    const a = (i / (spikes * 2)) * Math.PI * 2 - Math.PI / 2;
    const r = i % 2 === 0 ? 27 : 18;
    pts.push(C + Math.cos(a) * r, C + Math.sin(a) * r);
  }
  g.poly(pts).fill(0xffffff);
  g.circle(C, C, 7).fill(GLYPH);
}

function gemArt(g: Graphics): void {
  g.poly([C, C - 26, C + 20, C - 4, C, C + 26, C - 20, C - 4]).fill(0xffffff);
  // Facet line gives it a read of depth at 12px on screen.
  g.poly([C, C - 26, C + 20, C - 4, C, C + 2, C - 20, C - 4]).fill({
    color: 0xffffff,
    alpha: 0.45,
  });
}

function propArt(g: Graphics): void {
  g.roundRect(6, 6, S - 12, S - 12, 6).fill(0xffffff);
  g.rect(6, C - 3, S - 12, 6).fill(GLYPH);
  g.rect(C - 3, 6, 6, S - 12).fill(GLYPH);
}

function nodeArt(g: Graphics): void {
  // Crystal cluster: three shards, so it is distinguishable from a loose gem.
  g.poly([C, 4, C + 14, C + 6, C, C + 22, C - 14, C + 6]).fill(0xffffff);
  g.poly([C - 20, C + 2, C - 10, C + 20, C - 26, C + 20]).fill({ color: 0xffffff, alpha: 0.8 });
  g.poly([C + 20, C + 2, C + 26, C + 20, C + 10, C + 20]).fill({ color: 0xffffff, alpha: 0.8 });
}

function chestArt(g: Graphics): void {
  g.roundRect(6, 14, S - 12, S - 22, 5).fill(0xffffff);
  g.rect(6, 24, S - 12, 6).fill(GLYPH);
  g.roundRect(C - 6, C + 2, 12, 12, 2).fill(GLYPH);
}

function ringArt(g: Graphics): void {
  // Tier indicator drawn around fused and elite units.
  g.circle(C, C, 30).fill(0xffffff);
  g.circle(C, C, 25).cut();
}

function sparkArt(g: Graphics): void {
  g.circle(C, C, 14).fill(0xffffff);
}

// ── build ───────────────────────────────────────────────────────────────────

function bake(renderer: Renderer, draw: (g: Graphics) => void): Texture {
  const g = new Graphics();
  draw(g);
  const tex = renderer.generateTexture({ target: g, resolution: 2 });
  g.destroy();
  return tex;
}

export function buildSpriteAtlas(renderer: Renderer): SpriteAtlas {
  const atlas = {} as SpriteAtlas;
  for (const type of UNIT_TYPES) {
    atlas[type] = bake(renderer, UNIT_ART[type]);
  }
  atlas.leader = bake(renderer, leaderArt);
  atlas.creep = bake(renderer, creepArt);
  atlas.gem = bake(renderer, gemArt);
  atlas.prop = bake(renderer, propArt);
  atlas.node = bake(renderer, nodeArt);
  atlas.chest = bake(renderer, chestArt);
  atlas.ring = bake(renderer, ringArt);
  atlas.spark = bake(renderer, sparkArt);
  return atlas;
}
