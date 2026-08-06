/**
 * Sprite atlas (brief §M7: "original art, no licensed or recognizable
 * characters").
 *
 * Every texture is drawn procedurally at boot rather than shipped as an image.
 * That makes the art original by construction, keeps the bundle tiny (§5
 * budgets 2MB including the atlas — this contributes zero bytes), and lets a
 * silhouette change be a code edit rather than an asset pipeline.
 *
 * Shading survives tinting because tint *multiplies*. Bodies are drawn in a
 * mid grey rather than white, so a lighter top highlight and a darker bottom
 * shade both survive the multiply and every unit reads as a rounded form in
 * whatever colour its team happens to be. Drawing the body white would flatten
 * all of that to a single flat fill.
 *
 * Role glyphs stay translucent black so they darken with the body and remain
 * legible against any hue.
 */

import { Graphics, type Renderer, type Texture } from 'pixi.js';

import { UNIT_TYPES, type UnitType } from '@gem-rush/shared';

/** Texture resolution. Sprites render around 30px, so 64 is ample. */
const S = 64;
const C = S / 2;
const GLYPH = { color: 0x000000, alpha: 0.45 };

/**
 * Shading ramp. BASE is deliberately below white so HILIGHT can read as
 * brighter than the tint and SHADE as darker — the whole reason the sprites
 * have any sense of volume.
 */
const BASE = 0xc8c8c8;
const HILIGHT = 0xffffff;
const SHADE = 0x8a8a8a;
const OUTLINE = { color: 0x2b2b2b, alpha: 0.55 };

/** Lower half darkened, upper arc lit — a cheap stand-in for a light from above. */
function shadeRound(g: Graphics, r: number): void {
  g.circle(C, C + r * 0.26, r * 0.82).fill({ color: SHADE, alpha: 0.55 });
  g.circle(C, C - r * 0.3, r * 0.6).fill({ color: HILIGHT, alpha: 0.5 });
}

export type SpriteKey =
  | UnitType
  | 'leader'
  | 'creep'
  | 'gem'
  | 'prop'
  | 'node'
  | 'chest'
  | 'ring'
  | 'spark'
  | 'shadow';

export type SpriteAtlas = Record<SpriteKey, Texture>;

// ── silhouettes ─────────────────────────────────────────────────────────────

function circleBody(g: Graphics, r = 27): Graphics {
  g.circle(C, C, r).fill(BASE);
  shadeRound(g, r);
  g.circle(C, C, r).stroke({ ...OUTLINE, width: 2.5, alignment: 0.5 });
  return g;
}

function diamondBody(g: Graphics, r = 29): Graphics {
  const pts = [C, C - r, C + r, C, C, C + r, C - r, C];
  g.poly(pts).fill(BASE);
  g.poly([C, C, C + r, C, C, C + r, C - r, C]).fill({ color: SHADE, alpha: 0.5 });
  g.poly([C, C - r, C + r * 0.5, C - r * 0.5, C, C, C - r * 0.5, C - r * 0.5]).fill({
    color: HILIGHT,
    alpha: 0.45,
  });
  g.poly(pts).stroke({ ...OUTLINE, width: 2.5, alignment: 0.5 });
  return g;
}

function shieldBody(g: Graphics): Graphics {
  // Flat-topped shield: reads as "tank" at a glance, distinct from a circle.
  const pts = [C - 25, C - 22, C + 25, C - 22, C + 25, C + 6, C, C + 28, C - 25, C + 6];
  g.poly(pts).fill(BASE);
  g.poly([C - 25, C + 2, C + 25, C + 2, C + 25, C + 6, C, C + 28, C - 25, C + 6]).fill({
    color: SHADE,
    alpha: 0.55,
  });
  g.rect(C - 25, C - 22, 50, 9).fill({ color: HILIGHT, alpha: 0.4 });
  g.poly(pts).stroke({ ...OUTLINE, width: 2.5, alignment: 0.5 });
  return g;
}

function hexBody(g: Graphics, r = 27): Graphics {
  const pts: number[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 - Math.PI / 2;
    pts.push(C + Math.cos(a) * r, C + Math.sin(a) * r);
  }
  g.poly(pts).fill(BASE);
  shadeRound(g, r);
  g.poly(pts).stroke({ ...OUTLINE, width: 2.5, alignment: 0.5 });
  return g;
}

function triangleBody(g: Graphics, r = 29): Graphics {
  const pts = [C, C - r, C + r * 0.9, C + r * 0.7, C - r * 0.9, C + r * 0.7];
  g.poly(pts).fill(BASE);
  g.poly([C, C + r * 0.1, C + r * 0.9, C + r * 0.7, C - r * 0.9, C + r * 0.7]).fill({
    color: SHADE,
    alpha: 0.5,
  });
  g.poly([C, C - r, C + r * 0.35, C - r * 0.2, C - r * 0.35, C - r * 0.2]).fill({
    color: HILIGHT,
    alpha: 0.45,
  });
  g.poly(pts).stroke({ ...OUTLINE, width: 2.5, alignment: 0.5 });
  return g;
}

function roundedBody(g: Graphics, r = 24): Graphics {
  g.roundRect(C - r, C - r, r * 2, r * 2, 8).fill(BASE);
  g.roundRect(C - r, C + r * 0.15, r * 2, r * 0.85, 8).fill({ color: SHADE, alpha: 0.5 });
  g.roundRect(C - r * 0.8, C - r * 0.8, r * 1.6, r * 0.5, 6).fill({
    color: HILIGHT,
    alpha: 0.42,
  });
  g.roundRect(C - r, C - r, r * 2, r * 2, 8).stroke({ ...OUTLINE, width: 2.5, alignment: 0.5 });
  return g;
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
  // solid core so it stays visible when the squad crowds around it. Kept near
  // white — this one wants to be the brightest thing on screen.
  g.circle(C, C, 29).stroke({ ...OUTLINE, width: 3, alignment: 0.5 });
  g.circle(C, C, 28).fill(HILIGHT);
  g.circle(C, C, 20).cut();
  g.circle(C, C, 12).stroke({ ...OUTLINE, width: 3, alignment: 0.5 });
  g.circle(C, C, 11).fill(HILIGHT);
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
  g.poly(pts).fill(BASE);
  g.circle(C, C + 5, 16).fill({ color: SHADE, alpha: 0.55 });
  g.circle(C, C - 6, 12).fill({ color: HILIGHT, alpha: 0.45 });
  g.poly(pts).stroke({ ...OUTLINE, width: 2, alignment: 0.5 });
  // Two eyes rather than one blob: reads as a creature, not a cog.
  g.circle(C - 6, C - 2, 3.4).fill(GLYPH);
  g.circle(C + 6, C - 2, 3.4).fill(GLYPH);
}

function gemArt(g: Graphics): void {
  const outline = [C, C - 26, C + 20, C - 4, C, C + 26, C - 20, C - 4];
  g.poly(outline).fill(BASE);
  // Cut facets: left face shaded, right face lit, crown brightest. A gem is the
  // thing the whole game is about, so it gets the most attention per pixel.
  g.poly([C, C - 26, C, C + 26, C - 20, C - 4]).fill({ color: SHADE, alpha: 0.55 });
  g.poly([C, C - 26, C + 20, C - 4, C, C + 2]).fill({ color: HILIGHT, alpha: 0.75 });
  g.poly([C, C - 26, C + 8, C - 12, C - 8, C - 12]).fill({ color: HILIGHT, alpha: 0.95 });
  g.poly(outline).stroke({ ...OUTLINE, width: 2.5, alignment: 0.5 });
}

function propArt(g: Graphics): void {
  // A crate: planks, a lit top edge, and a shaded base.
  g.roundRect(6, 6, S - 12, S - 12, 6).fill(BASE);
  g.roundRect(6, C, S - 12, C - 6, 6).fill({ color: SHADE, alpha: 0.45 });
  g.roundRect(9, 9, S - 18, 12, 4).fill({ color: HILIGHT, alpha: 0.35 });
  g.rect(6, C - 4, S - 12, 8).fill({ color: 0x000000, alpha: 0.32 });
  g.rect(C - 4, 6, 8, S - 12).fill({ color: 0x000000, alpha: 0.32 });
  g.roundRect(6, 6, S - 12, S - 12, 6).stroke({ ...OUTLINE, width: 3, alignment: 0.5 });
}

function nodeArt(g: Graphics): void {
  // Crystal cluster: three faceted shards, distinguishable from a loose gem.
  const side = (x: number, dir: number): void => {
    const pts = [x, C + 2, x + 6 * dir, C + 20, x - 6 * dir, C + 20];
    g.poly(pts).fill(BASE);
    g.poly(pts).stroke({ ...OUTLINE, width: 2, alignment: 0.5 });
    g.poly([x, C + 2, x + 6 * dir, C + 20, x, C + 20]).fill({ color: SHADE, alpha: 0.5 });
  };
  side(C - 20, -1);
  side(C + 20, 1);

  const main = [C, 4, C + 14, C + 6, C, C + 22, C - 14, C + 6];
  g.poly(main).fill(BASE);
  g.poly([C, 4, C, C + 22, C - 14, C + 6]).fill({ color: SHADE, alpha: 0.5 });
  g.poly([C, 4, C + 14, C + 6, C, C + 12]).fill({ color: HILIGHT, alpha: 0.7 });
  g.poly(main).stroke({ ...OUTLINE, width: 2.5, alignment: 0.5 });
}

function chestArt(g: Graphics): void {
  // Domed lid, banded body, keyhole plate.
  g.roundRect(6, 20, S - 12, S - 26, 5).fill(BASE);
  g.roundRect(6, C + 6, S - 12, C - 12, 5).fill({ color: SHADE, alpha: 0.45 });
  g.roundRect(4, 12, S - 8, 18, 8).fill(BASE);
  g.roundRect(7, 14, S - 14, 7, 5).fill({ color: HILIGHT, alpha: 0.5 });
  g.rect(6, 30, S - 12, 5).fill({ color: 0x000000, alpha: 0.35 });
  g.roundRect(C - 7, C + 4, 14, 14, 3).fill({ color: HILIGHT, alpha: 0.55 });
  g.circle(C, C + 11, 3.2).fill(GLYPH);
  g.roundRect(4, 12, S - 8, S - 18, 6).stroke({ ...OUTLINE, width: 3, alignment: 0.5 });
}

function ringArt(g: Graphics): void {
  // Tier indicator drawn around fused and elite units.
  g.circle(C, C, 30).fill(0xffffff);
  g.circle(C, C, 25).cut();
}

function sparkArt(g: Graphics): void {
  g.circle(C, C, 14).fill(0xffffff);
}

/**
 * Contact shadow, drawn under every mobile entity.
 *
 * Concentric rings of decreasing alpha rather than a single ellipse: a hard
 * edged blob reads as a black disc stuck to the floor, whereas a soft falloff
 * grounds the sprite. Cheap enough to bake once and reuse for everything.
 */
function shadowArt(g: Graphics): void {
  for (let i = 6; i >= 1; i--) {
    const t = i / 6;
    g.ellipse(C, C, 26 * t, 13 * t).fill({ color: 0x000000, alpha: 0.075 });
  }
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
  atlas.shadow = bake(renderer, shadowArt);
  return atlas;
}
