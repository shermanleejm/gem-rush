/**
 * 3D sprite baking (brief §M7: "original art, no licensed or recognizable
 * characters").
 *
 * Every sprite is a real 3D model — actual geometry, actual lights, actual
 * perspective — rendered once at boot into a texture that the 2D scene then
 * draws. This is the pre-rendered-sprite approach that isometric games have
 * used for decades: you get the volume and lighting of 3D without paying for a
 * 3D renderer every frame, and Pixi still batches everything as flat quads.
 *
 * Three constraints shape the setup:
 *
 * - **Models are built from primitives in code**, so the art stays original by
 *   construction and a redesign is a code edit rather than an asset pipeline.
 * - **Materials are near-white.** Sprites are tinted per team and per archetype
 *   at draw time, and tint multiplies, so the lighting has to carry all the
 *   form and the colour arrives later. A coloured material would multiply
 *   against the tint and turn muddy.
 * - **One fixed camera for every model**, angled to match the game's top-down
 *   three-quarter view, so all sprites share a consistent light direction and
 *   sit in the same imaginary world.
 */

import type { BufferGeometry } from 'three';
import {
  AmbientLight,
  BoxGeometry,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  Group,
  IcosahedronGeometry,
  Mesh,
  MeshStandardMaterial,
  OctahedronGeometry,
  OrthographicCamera,
  Scene,
  SphereGeometry,
  TorusGeometry,
  Vector3,
  WebGLRenderer,
} from 'three';

import { UNIT_TYPES, type UnitType } from '@gem-rush/shared';
import { bodyMat, buildUnitModel, darkMat, gemMat, trimMat } from './models.ts';
import { Texture } from 'pixi.js';

/** Baked texture size. Sprites draw around 30-45px, so this has headroom. */
const TEX = 192;
/** Slack around each model's fitted frame, so nothing touches the texture edge. */
const FRAME_MARGIN = 1.06;

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

// ── materials ───────────────────────────────────────────────────────────────
// Unit materials are shared with the recipe system in models.ts, so a unit and
// a world prop lit side by side agree about what a surface is. Only the rough
// crate/chest timber is local, since nothing else uses it.

const woodMat = new MeshStandardMaterial({ color: 0xe8e8e8, roughness: 0.85, metalness: 0.0 });

function mesh(geo: BufferGeometry, mat: MeshStandardMaterial): Mesh {
  return new Mesh(geo, mat);
}

// ── models ──────────────────────────────────────────────────────────────────
// Each returns a Group centred on the origin, roughly 1.6 units tall so it
// frames consistently. Role is carried by silhouette first, as before.

function leaderModel(): Group {
  const g = new Group();
  // A hovering ring with a core: reads as a cursor, not a unit.
  const ring = mesh(new TorusGeometry(0.6, 0.14, 12, 24), bodyMat);
  ring.rotation.x = Math.PI / 2;
  g.add(ring);
  const core = mesh(new SphereGeometry(0.3, 18, 14), bodyMat);
  g.add(core);
  return g;
}

function creepModel(): Group {
  const g = new Group();
  // Faceted and lumpy so neutrals never read as somebody's unit.
  const body = mesh(new IcosahedronGeometry(0.52, 0), bodyMat);
  g.add(body);
  for (const sx of [-1, 1]) {
    const eye = mesh(new SphereGeometry(0.11, 10, 8), darkMat);
    eye.position.set(0.18 * sx, 0.12, 0.44);
    g.add(eye);
  }
  return g;
}

function gemModel(): Group {
  const g = new Group();
  const gem = mesh(new OctahedronGeometry(0.62), gemMat);
  gem.rotation.y = 0.5;
  g.add(gem);
  return g;
}

function propModel(): Group {
  const g = new Group();
  g.add(mesh(new BoxGeometry(1.05, 1.0, 1.05), woodMat));
  // Banding around the crate so it isn't a featureless cube.
  for (const axis of ['x', 'z'] as const) {
    const band = mesh(
      axis === 'x' ? new BoxGeometry(1.1, 0.16, 0.2) : new BoxGeometry(0.2, 0.16, 1.1),
      darkMat,
    );
    band.position.y = 0.06;
    g.add(band);
  }
  return g;
}

function nodeModel(): Group {
  const g = new Group();
  // Upright prisms rather than a heap of octahedra. Loose blobs at varying
  // heights overlapped into an unreadable jumble once baked; tapered spires,
  // tilted apart so their silhouettes stay separate, read as a crystal
  // formation growing out of the ground — clearly a deposit, not dropped loot.
  for (const [x, z, r, h, tilt] of [
    [0.0, 0.02, 0.3, 1.35, 0.0],
    [-0.42, -0.1, 0.21, 0.9, -0.3],
    [0.38, -0.22, 0.18, 0.72, 0.34],
  ] as const) {
    const shard = mesh(new ConeGeometry(r, h, 5), gemMat);
    shard.position.set(x, h / 2 - 0.5, z);
    shard.rotation.z = tilt;
    g.add(shard);
  }
  return g;
}

function chestModel(): Group {
  const g = new Group();
  const base = mesh(new BoxGeometry(1.0, 0.6, 0.78), woodMat);
  base.position.y = -0.16;
  g.add(base);
  // Half-cylinder lid, which is what makes a box read as a chest.
  const lid = mesh(new CylinderGeometry(0.39, 0.39, 1.0, 16, 1, false, 0, Math.PI), woodMat);
  lid.rotation.set(0, 0, Math.PI / 2);
  lid.position.y = 0.14;
  g.add(lid);
  const lock = mesh(new BoxGeometry(0.2, 0.26, 0.12), trimMat);
  lock.position.set(0, -0.06, 0.42);
  g.add(lock);
  return g;
}

// ── baking ──────────────────────────────────────────────────────────────────

/**
 * Renders one model and snapshots it into a Pixi texture.
 *
 * The camera frame is fitted to each model rather than being fixed. Hand-tuning
 * sixteen models to a shared frame meant some clipped at the edges while others
 * floated in empty space, and since the scene scales every sprite on draw
 * anyway, the only thing the bake owes it is a texture the model fills.
 *
 * The fit measures every *vertex* projected into camera space. Two cheaper
 * shortcuts both fail on the same shape: a bounding sphere circumscribes the
 * model's longest diagonal, and a bounding box is, for an octahedron, a cube
 * twice the size of the thing inside it. Either way the gem baked out small and
 * ringed by dead pixels while a crate of the same nominal size filled its
 * frame. Vertices give the true silhouette, so every sprite carries the same
 * visual weight. The models are a few hundred vertices each and this runs once
 * at boot, so the exact answer costs nothing worth saving.
 *
 * The three.js canvas is reused across every bake, so each result has to be
 * copied out into its own 2D canvas before the next render overwrites it.
 */
function bakeModel(
  renderer: WebGLRenderer,
  scene: Scene,
  camera: OrthographicCamera,
  model: Group,
): Texture {
  model.updateMatrixWorld(true);

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  const v = new Vector3();
  model.traverse((child) => {
    if (!(child instanceof Mesh)) return;
    const pos = (child.geometry as BufferGeometry).attributes.position;
    if (!pos) return;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i)
        .applyMatrix4(child.matrixWorld)
        .applyMatrix4(camera.matrixWorldInverse);
      minX = Math.min(minX, v.x);
      maxX = Math.max(maxX, v.x);
      minY = Math.min(minY, v.y);
      maxY = Math.max(maxY, v.y);
    }
  });

  // Square and centred on the model's projected middle, so a model with an
  // offset part (the harvester's gem, the mender's cross) sits centred instead
  // of drifting toward one edge.
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const half = (Math.max(maxX - minX, maxY - minY) / 2) * FRAME_MARGIN;
  camera.left = cx - half;
  camera.right = cx + half;
  camera.top = cy + half;
  camera.bottom = cy - half;
  camera.updateProjectionMatrix();

  scene.add(model);
  renderer.render(scene, camera);
  scene.remove(model);

  const snapshot = document.createElement('canvas');
  snapshot.width = TEX;
  snapshot.height = TEX;
  snapshot.getContext('2d')!.drawImage(renderer.domElement, 0, 0);
  return Texture.from(snapshot);
}

/** Flat 2D helpers that would gain nothing from being modelled. */
function bakeFlat(draw: (ctx: CanvasRenderingContext2D) => void): Texture {
  const c = document.createElement('canvas');
  c.width = TEX;
  c.height = TEX;
  draw(c.getContext('2d')!);
  return Texture.from(c);
}

/**
 * The tier ring, hit spark and ground shadow.
 *
 * These stay flat in both paths: they are overlays on the world rather than
 * objects in it, and lighting them as solids would read as clutter — a shaded
 * "shadow" is a contradiction, and a shaded ring competes with the unit it is
 * meant to annotate.
 */
function overlayArt(): Pick<SpriteAtlas, 'ring' | 'spark' | 'shadow'> {
  const c = TEX / 2;
  return {
    ring: bakeFlat((ctx) => {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = TEX * 0.055;
      ctx.beginPath();
      ctx.arc(c, c, c - ctx.lineWidth, 0, Math.PI * 2);
      ctx.stroke();
    }),
    spark: bakeFlat((ctx) => {
      const grad = ctx.createRadialGradient(c, c, 0, c, c, c);
      grad.addColorStop(0, 'rgba(255,255,255,1)');
      grad.addColorStop(0.45, 'rgba(255,255,255,0.75)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, TEX, TEX);
    }),
    shadow: bakeFlat((ctx) => {
      // Soft radial falloff, squashed by the draw call into a ground ellipse.
      const grad = ctx.createRadialGradient(c, c, 0, c, c, c);
      grad.addColorStop(0, 'rgba(0,0,0,0.55)');
      grad.addColorStop(0.55, 'rgba(0,0,0,0.22)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, TEX, TEX);
    }),
  };
}

/**
 * Flat stand-in art, used only when the 3D bake cannot run.
 *
 * Pixi falls back to a canvas renderer when WebGL is unavailable, so before the
 * models existed those devices could still play. Baking needs a GL context, and
 * without this they would get a white screen instead of a game — trading a
 * whole class of device for nicer art is not a trade worth making silently.
 * These are deliberately crude: distinct silhouettes, one highlight, no
 * pretence at volume. Playable, not pretty.
 */
function fallbackAtlas(): SpriteAtlas {
  const c = TEX / 2;
  const disc = (ctx: CanvasRenderingContext2D, r: number) => {
    const grad = ctx.createRadialGradient(c - r * 0.3, c - r * 0.35, r * 0.1, c, c, r);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(1, '#909090');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(c, c, r, 0, Math.PI * 2);
    ctx.fill();
  };
  const boxy = (ctx: CanvasRenderingContext2D, r: number) => {
    const grad = ctx.createLinearGradient(c - r, c - r, c + r, c + r);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(1, '#8a8a8a');
    ctx.fillStyle = grad;
    ctx.fillRect(c - r, c - r, r * 2, r * 2);
  };

  const atlas = {} as SpriteAtlas;
  for (const type of UNIT_TYPES) atlas[type] = bakeFlat((ctx) => disc(ctx, c * 0.82));
  atlas.leader = bakeFlat((ctx) => disc(ctx, c * 0.9));
  atlas.creep = bakeFlat((ctx) => disc(ctx, c * 0.78));
  atlas.gem = bakeFlat((ctx) => {
    ctx.save();
    ctx.translate(c, c);
    ctx.rotate(Math.PI / 4);
    ctx.translate(-c, -c);
    boxy(ctx, c * 0.6);
    ctx.restore();
  });
  atlas.prop = bakeFlat((ctx) => boxy(ctx, c * 0.78));
  atlas.node = bakeFlat((ctx) => boxy(ctx, c * 0.7));
  atlas.chest = bakeFlat((ctx) => boxy(ctx, c * 0.82));
  return atlas;
}

export function buildSpriteAtlas(): SpriteAtlas {
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ antialias: true, alpha: true });
  } catch (err) {
    console.warn('[sprites] 3D bake unavailable, using flat art', err);
    return { ...fallbackAtlas(), ...overlayArt() };
  }
  renderer.setSize(TEX, TEX, false);
  renderer.setClearColor(0x000000, 0);

  const scene = new Scene();

  // Orthographic, and crucially *yawed* as well as pitched — a classic
  // three-quarter view. Looking straight down the Z axis presents a box its
  // flat front face and nothing else, so crates and chests baked out as plain
  // rectangles with no read of depth at all. Coming in over one shoulder shows
  // two side faces and the top, which is what makes a cube look like a cube.
  // Pitched about 40° to match how the game reads its own floor.
  //
  // Orthographic rather than perspective: a perspective camera gives each
  // sprite its own vanishing point, which looks wrong the moment they are
  // scattered across a shared flat map and each one implies a different eye.
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 60);
  camera.position.set(2.6, 3.1, 3.4);
  camera.lookAt(0, 0, 0);
  // The per-model fit projects into camera space, so this has to be current
  // before the first bake rather than at the next render.
  camera.updateMatrixWorld(true);

  // Key from the upper left, fill from the right, and a dim underlight so the
  // shaded side never goes fully black once tinted.
  const key = new DirectionalLight(0xffffff, 2.7);
  key.position.set(-2.4, 4.2, 3.0);
  const fill = new DirectionalLight(0xffffff, 0.85);
  fill.position.set(3.0, 1.0, 1.6);
  const under = new DirectionalLight(0xffffff, 0.28);
  under.position.set(0.4, -2.2, 1.0);
  scene.add(key, fill, under, new AmbientLight(0xffffff, 0.55));

  const atlas = {} as SpriteAtlas;
  for (const type of UNIT_TYPES) {
    atlas[type] = bakeModel(renderer, scene, camera, buildUnitModel(type));
  }
  atlas.leader = bakeModel(renderer, scene, camera, leaderModel());
  atlas.creep = bakeModel(renderer, scene, camera, creepModel());
  atlas.gem = bakeModel(renderer, scene, camera, gemModel());
  atlas.prop = bakeModel(renderer, scene, camera, propModel());
  atlas.node = bakeModel(renderer, scene, camera, nodeModel());
  atlas.chest = bakeModel(renderer, scene, camera, chestModel());

  Object.assign(atlas, overlayArt());

  // The GL context has done its job; releasing it frees the extra canvas and
  // its buffers rather than leaving a second context alive for the whole match.
  renderer.dispose();
  renderer.forceContextLoss();

  return atlas;
}
