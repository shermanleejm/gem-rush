/**
 * Unit models, as recipes rather than hand-built meshes.
 *
 * There are 38 units. Writing a bespoke `function brute(): Group` for each one
 * would be some 1200 lines in which the interesting part of any unit — that it
 * is a stocky body with a mohawk holding an axe — is buried in mesh
 * bookkeeping, and a change to how, say, every held weapon sits would be 20
 * synchronised edits.
 *
 * So a unit is a **recipe**: a body, optional headgear, an optional held item,
 * and an optional accessory. Each part is built once, positioned relative to a
 * body of roughly unit size, and shared by every unit that uses it. Adding a
 * character is one line; restyling every hat is one function.
 *
 * Silhouette does the work (§1.5: role must be readable before colour is), so
 * parts are deliberately oversized and pushed clear of the body — at 35px on a
 * phone, a tastefully proportioned weapon is invisible.
 */

import {
  BoxGeometry,
  CapsuleGeometry,
  ConeGeometry,
  CylinderGeometry,
  DodecahedronGeometry,
  Group,
  IcosahedronGeometry,
  Mesh,
  MeshStandardMaterial,
  OctahedronGeometry,
  SphereGeometry,
  TorusGeometry,
  type BufferGeometry,
} from 'three';

import type { UnitType } from '@gem-rush/shared';

// ── materials ───────────────────────────────────────────────────────────────
// Near-white, because sprites are tinted per team and tint multiplies: the
// lighting has to carry the form and the colour arrives at draw time.

// Everything sits high on the value scale. The first pass used a mid grey for
// trim and a near-black for detail, which looked fine untinted but turned
// muddy and grim the moment a team colour multiplied through it — tint can only
// ever darken. Keeping every material bright means the tint lands as a
// saturated colour rather than a dark one, which is what makes the toy-like,
// cheerful look the game is going for.
export const bodyMat = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.48, metalness: 0.02 });
export const darkMat = new MeshStandardMaterial({ color: 0xb0b0b0, roughness: 0.42, metalness: 0.08 });
export const trimMat = new MeshStandardMaterial({ color: 0xdcdcdc, roughness: 0.3, metalness: 0.18 });
export const gemMat = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.08, metalness: 0.05 });

function mesh(geo: BufferGeometry, mat: MeshStandardMaterial): Mesh {
  return new Mesh(geo, mat);
}

// ── bodies ──────────────────────────────────────────────────────────────────

export type BodyShape =
  | 'capsule'
  | 'stocky'
  | 'sphere'
  | 'box'
  | 'drum'
  | 'cone'
  | 'prism'
  | 'rock'
  | 'ring'
  | 'crystal'
  | 'blob';

/**
 * Where the head sits, in local units. Every hat is positioned against this
 * rather than against the body, so a hat looks worn rather than impaled no
 * matter which body shape is underneath it.
 */
export const HEAD_Y = 0.52;

/**
 * Which bodies get an actual head.
 *
 * The first pass hung hats straight off a torso and every unit read as a blob
 * wearing a mushroom: with no neck, a brim as wide as the shoulders simply
 * swallowed the model. A smaller, distinct head sphere gives hats something to
 * sit on and gives the silhouette the head-and-shoulders shape that is most of
 * what makes a shape read as a character at all.
 */
const HUMANOID = new Set<BodyShape>(['capsule', 'stocky', 'box', 'drum', 'prism']);

const BODIES: Record<BodyShape, () => Mesh> = {
  capsule: () => at(mesh(new CapsuleGeometry(0.34, 0.32, 6, 16), bodyMat), 0, -0.16, 0),
  stocky: () => at(mesh(new CapsuleGeometry(0.44, 0.2, 6, 16), bodyMat), 0, -0.14, 0),
  sphere: () => mesh(new SphereGeometry(0.46, 18, 14), bodyMat),
  box: () => at(mesh(new BoxGeometry(0.74, 0.66, 0.74), bodyMat), 0, -0.18, 0),
  drum: () => at(mesh(new CylinderGeometry(0.42, 0.48, 0.66, 14), bodyMat), 0, -0.18, 0),
  cone: () => mesh(new ConeGeometry(0.46, 1.0, 14), bodyMat),
  prism: () => at(mesh(new CylinderGeometry(0.42, 0.42, 0.68, 6), bodyMat), 0, -0.18, 0),
  rock: () => mesh(new IcosahedronGeometry(0.52, 0), bodyMat),
  ring: () => mesh(new TorusGeometry(0.5, 0.16, 12, 22), bodyMat),
  crystal: () => mesh(new OctahedronGeometry(0.56), gemMat),
  blob: () => mesh(new DodecahedronGeometry(0.5), bodyMat),
};

// ── headgear ────────────────────────────────────────────────────────────────
// Everything sits around y = +0.5, on top of a body about 1 unit tall.

export type Hat =
  | 'none'
  | 'mohawk'
  | 'brim'
  | 'pointed'
  | 'hood'
  | 'helmet'
  | 'cap'
  | 'tricorn'
  | 'beak'
  | 'antenna'
  | 'goggles'
  | 'crown'
  | 'ears';

const HATS: Record<Hat, (g: Group) => void> = {
  none: () => {},
  mohawk: (g) => {
    // A row of blades along the crown — reads as a crest at any size.
    for (let i = 0; i < 4; i++) {
      const spike = mesh(new ConeGeometry(0.07, 0.28 - Math.abs(i - 1.5) * 0.05, 5), darkMat);
      spike.position.set(0, HEAD_Y + 0.22, 0.16 - i * 0.11);
      g.add(spike);
    }
  },
  brim: (g) => {
    g.add(at(mesh(new CylinderGeometry(0.44, 0.44, 0.045, 16), darkMat), 0, HEAD_Y + 0.1, 0));
    g.add(at(mesh(new CylinderGeometry(0.2, 0.23, 0.24, 14), darkMat), 0, HEAD_Y + 0.22, 0));
  },
  pointed: (g) => {
    g.add(at(mesh(new ConeGeometry(0.3, 0.6, 14), darkMat), 0, HEAD_Y + 0.38, 0));
    g.add(at(mesh(new CylinderGeometry(0.34, 0.34, 0.05, 16), darkMat), 0, HEAD_Y + 0.1, 0));
  },
  hood: (g) => {
    const hood = mesh(new SphereGeometry(0.31, 14, 12, 0, Math.PI * 2, 0, Math.PI * 0.7), darkMat);
    g.add(at(hood, 0, HEAD_Y + 0.05, -0.03));
  },
  helmet: (g) => {
    const dome = mesh(new SphereGeometry(0.29, 14, 12, 0, Math.PI * 2, 0, Math.PI * 0.58), trimMat);
    g.add(at(dome, 0, HEAD_Y + 0.04, 0));
  },
  cap: (g) => {
    g.add(at(mesh(new CylinderGeometry(0.25, 0.27, 0.16, 14), darkMat), 0, HEAD_Y + 0.14, 0));
    g.add(at(mesh(new BoxGeometry(0.32, 0.045, 0.26), darkMat), 0, HEAD_Y + 0.07, 0.26));
  },
  tricorn: (g) => {
    // Three upturned corners: a distinct star-ish silhouette from above.
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      const corner = mesh(new BoxGeometry(0.28, 0.06, 0.16), darkMat);
      corner.position.set(Math.cos(a) * 0.24, HEAD_Y + 0.1, Math.sin(a) * 0.24);
      corner.rotation.y = -a;
      g.add(corner);
    }
    g.add(at(mesh(new CylinderGeometry(0.19, 0.22, 0.2, 12), darkMat), 0, HEAD_Y + 0.18, 0));
  },
  beak: (g) => {
    g.add(at(mesh(new ConeGeometry(0.13, 0.32, 8), trimMat), 0, 0.1, 0.48, Math.PI / 2));
    g.add(at(mesh(new BoxGeometry(0.07, 0.18, 0.24), darkMat), 0, 0.56, 0.08));
  },
  antenna: (g) => {
    g.add(at(mesh(new CylinderGeometry(0.03, 0.03, 0.34, 8), trimMat), 0.1, HEAD_Y + 0.22, 0));
    g.add(at(mesh(new SphereGeometry(0.09, 10, 8), darkMat), 0.1, HEAD_Y + 0.4, 0));
  },
  goggles: (g) => {
    for (const sx of [-1, 1]) {
      const lens = mesh(new CylinderGeometry(0.11, 0.11, 0.09, 12), darkMat);
      g.add(at(lens, 0.13 * sx, HEAD_Y + 0.02, 0.23, Math.PI / 2));
    }
  },
  crown: (g) => {
    g.add(at(mesh(new CylinderGeometry(0.27, 0.27, 0.1, 14), trimMat), 0, HEAD_Y + 0.1, 0));
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      const point = mesh(new ConeGeometry(0.06, 0.22, 6), trimMat);
      point.position.set(Math.cos(a) * 0.22, HEAD_Y + 0.24, Math.sin(a) * 0.22);
      g.add(point);
    }
  },
  ears: (g) => {
    for (const sx of [-1, 1]) {
      const ear = mesh(new ConeGeometry(0.13, 0.3, 7), bodyMat);
      ear.position.set(0.2 * sx, HEAD_Y + 0.18, 0);
      ear.rotation.z = 0.4 * sx;
      g.add(ear);
    }
  },
};

// ── held items ──────────────────────────────────────────────────────────────
// Held out to the unit's right and forward, well clear of the body.

export type Weapon =
  | 'none'
  | 'axe'
  | 'blade'
  | 'dagger'
  | 'gun'
  | 'longgun'
  | 'bow'
  | 'staff'
  | 'hammer'
  | 'shield'
  | 'pick'
  | 'banner'
  | 'cross'
  | 'wrench'
  | 'lute'
  | 'bomb'
  | 'net';

const HX = 0.5;
const HZ = 0.24;

const WEAPONS: Record<Weapon, (g: Group) => void> = {
  none: () => {},
  axe: (g) => {
    g.add(at(mesh(new CylinderGeometry(0.06, 0.06, 0.9, 8), darkMat), HX, 0.1, HZ, 0, 0, -0.3));
    const head = mesh(new BoxGeometry(0.14, 0.36, 0.4), trimMat);
    g.add(at(head, HX + 0.14, 0.46, HZ));
  },
  blade: (g) => {
    g.add(at(mesh(new BoxGeometry(0.1, 0.92, 0.07), trimMat), HX, 0.18, HZ, 0, 0, -0.35));
    g.add(at(mesh(new BoxGeometry(0.3, 0.08, 0.12), darkMat), HX - 0.14, -0.2, HZ));
  },
  dagger: (g) => {
    for (const sx of [-1, 1]) {
      g.add(at(mesh(new ConeGeometry(0.07, 0.46, 6), trimMat), 0.46 * sx, 0.08, 0.2, 0, 0, -0.6 * sx));
    }
  },
  gun: (g) => {
    g.add(at(mesh(new CylinderGeometry(0.11, 0.11, 0.78, 12), darkMat), HX, 0.06, HZ + 0.22, Math.PI / 2));
    g.add(at(mesh(new BoxGeometry(0.14, 0.26, 0.16), darkMat), HX, -0.14, HZ));
  },
  longgun: (g) => {
    g.add(at(mesh(new CylinderGeometry(0.09, 0.09, 1.25, 12), darkMat), HX - 0.06, 0.16, HZ + 0.3, Math.PI / 2, 0, 0.25));
    g.add(at(mesh(new BoxGeometry(0.16, 0.3, 0.2), trimMat), HX - 0.16, -0.16, HZ - 0.16));
  },
  bow: (g) => {
    const bow = mesh(new TorusGeometry(0.44, 0.055, 8, 18, Math.PI * 1.25), trimMat);
    g.add(at(bow, HX, 0.06, HZ, 0, Math.PI / 2, 0.4));
    g.add(at(mesh(new CylinderGeometry(0.025, 0.025, 0.8, 6), darkMat), HX, 0.06, HZ, 0, 0, 0.4));
  },
  staff: (g) => {
    g.add(at(mesh(new CylinderGeometry(0.055, 0.055, 1.1, 8), darkMat), HX, 0.12, HZ, 0, 0, -0.18));
    g.add(at(mesh(new OctahedronGeometry(0.17), gemMat), HX + 0.13, 0.64, HZ));
  },
  hammer: (g) => {
    g.add(at(mesh(new CylinderGeometry(0.07, 0.07, 0.86, 8), darkMat), HX, 0.06, HZ, 0, 0, -0.25));
    g.add(at(mesh(new BoxGeometry(0.36, 0.34, 0.34), trimMat), HX + 0.12, 0.46, HZ));
  },
  shield: (g) => {
    g.add(at(mesh(new BoxGeometry(0.92, 0.86, 0.14), trimMat), 0, 0.04, 0.48));
    g.add(at(mesh(new SphereGeometry(0.15, 12, 10), darkMat), 0, 0.04, 0.6));
  },
  pick: (g) => {
    g.add(at(mesh(new CylinderGeometry(0.06, 0.06, 0.84, 8), darkMat), HX, 0.06, HZ, 0, 0, -0.2));
    g.add(at(mesh(new ConeGeometry(0.13, 0.5, 8), trimMat), HX + 0.08, 0.46, HZ, Math.PI / 2, 0, 0.3));
  },
  banner: (g) => {
    g.add(at(mesh(new CylinderGeometry(0.05, 0.05, 1.3, 8), darkMat), HX, 0.24, HZ));
    g.add(at(mesh(new BoxGeometry(0.05, 0.46, 0.42), trimMat), HX + 0.02, 0.62, HZ + 0.22));
  },
  cross: (g) => {
    g.add(at(mesh(new BoxGeometry(0.72, 0.2, 0.2), trimMat), 0, 0.74, 0));
    g.add(at(mesh(new BoxGeometry(0.2, 0.72, 0.2), trimMat), 0, 0.74, 0));
  },
  wrench: (g) => {
    g.add(at(mesh(new BoxGeometry(0.12, 0.66, 0.1), trimMat), HX, 0.1, HZ, 0, 0, -0.3));
    g.add(at(mesh(new TorusGeometry(0.15, 0.055, 8, 12), trimMat), HX + 0.12, 0.44, HZ));
  },
  lute: (g) => {
    g.add(at(mesh(new SphereGeometry(0.3, 14, 12), trimMat), HX - 0.04, -0.02, HZ + 0.18));
    g.add(at(mesh(new BoxGeometry(0.1, 0.62, 0.08), darkMat), HX + 0.1, 0.32, HZ + 0.18, 0, 0, -0.35));
  },
  bomb: (g) => {
    g.add(at(mesh(new SphereGeometry(0.28, 14, 12), darkMat), HX, 0.0, HZ + 0.1));
    g.add(at(mesh(new CylinderGeometry(0.04, 0.04, 0.24, 6), trimMat), HX, 0.32, HZ + 0.1, 0, 0, 0.4));
  },
  net: (g) => {
    g.add(at(mesh(new TorusGeometry(0.3, 0.05, 8, 14), trimMat), HX, 0.2, HZ + 0.1, Math.PI / 2.4));
    g.add(at(mesh(new CylinderGeometry(0.045, 0.045, 0.7, 8), darkMat), HX, -0.12, HZ, 0, 0, -0.2));
  },
};

// ── accessories ─────────────────────────────────────────────────────────────

export type Accessory =
  | 'none'
  | 'orbs'
  | 'halo'
  | 'wings'
  | 'cape'
  | 'tail'
  | 'sack'
  | 'gem'
  | 'pet'
  | 'turretbase'
  | 'wheels'
  | 'tuft';

const ACCESSORIES: Record<Accessory, (g: Group) => void> = {
  none: () => {},
  orbs: (g) => {
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      g.add(at(mesh(new SphereGeometry(0.15, 12, 10), darkMat), Math.cos(a) * 0.62, 0.16, Math.sin(a) * 0.62));
    }
  },
  halo: (g) => {
    g.add(at(mesh(new TorusGeometry(0.4, 0.06, 10, 20), trimMat), 0, 0.72, 0, Math.PI / 2));
  },
  wings: (g) => {
    for (const sx of [-1, 1]) {
      const wing = mesh(new BoxGeometry(0.52, 0.08, 0.34), trimMat);
      wing.position.set(0.5 * sx, 0.16, -0.22);
      wing.rotation.set(0, -0.5 * sx, 0.3 * sx);
      g.add(wing);
    }
  },
  cape: (g) => {
    const cape = mesh(new ConeGeometry(0.46, 0.9, 12, 1, true), trimMat);
    g.add(at(cape, 0, -0.02, -0.3, 0.28));
  },
  tail: (g) => {
    for (const sx of [-1, 1]) {
      const t = mesh(new ConeGeometry(0.14, 0.6, 8), bodyMat);
      t.position.set(0.16 * sx, 0.1, -0.5);
      t.rotation.set(-1.1, 0, 0.3 * sx);
      g.add(t);
    }
  },
  sack: (g) => {
    g.add(at(mesh(new SphereGeometry(0.3, 12, 10), trimMat), -0.42, -0.1, -0.2));
    g.add(at(mesh(new CylinderGeometry(0.1, 0.14, 0.16, 8), darkMat), -0.42, 0.16, -0.2));
  },
  gem: (g) => {
    g.add(at(mesh(new OctahedronGeometry(0.26), gemMat), 0, 0.7, 0));
  },
  pet: (g) => {
    g.add(at(mesh(new SphereGeometry(0.24, 12, 10), trimMat), -0.55, 0.3, 0.1));
    g.add(at(mesh(new SphereGeometry(0.09, 8, 8), darkMat), -0.55, 0.52, 0.1));
  },
  turretbase: (g) => {
    g.add(at(mesh(new CylinderGeometry(0.5, 0.58, 0.2, 14), trimMat), 0, -0.44, 0));
    g.add(at(mesh(new CylinderGeometry(0.1, 0.1, 0.6, 10), darkMat), 0.1, 0.1, 0.4, Math.PI / 2));
  },
  wheels: (g) => {
    for (const sx of [-1, 1]) {
      g.add(at(mesh(new CylinderGeometry(0.24, 0.24, 0.14, 12), darkMat), 0.44 * sx, -0.34, 0, 0, 0, Math.PI / 2));
    }
  },
  tuft: (g) => {
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      const t = mesh(new ConeGeometry(0.11, 0.36, 6), bodyMat);
      t.position.set(Math.cos(a) * 0.16, 0.62, Math.sin(a) * 0.16);
      t.rotation.set(0.3 * Math.sin(a), 0, 0.3 * Math.cos(a));
      g.add(t);
    }
  },
};

/** Position and rotate a mesh in one call, to keep the tables above readable. */
function at(m: Mesh, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): Mesh {
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  return m;
}

// ── recipes ─────────────────────────────────────────────────────────────────

/**
 * No scale field, deliberately. The bake fits the camera to each model so every
 * sprite fills its own texture, which makes a uniform scale here a no-op —
 * relative size on screen comes from each unit's `radius` in the shared unit
 * definitions, which is also the number collision already uses. Two sources of
 * truth for "how big is a Golem" would drift apart immediately.
 */
export interface Recipe {
  body: BodyShape;
  hat?: Hat;
  weapon?: Weapon;
  accessory?: Accessory;
}

export const UNIT_RECIPES: Record<UnitType, Recipe> = {
  // Fighters
  brute: { body: 'stocky', hat: 'mohawk', weapon: 'axe' },
  bombardier: { body: 'capsule', hat: 'cap', weapon: 'bomb' },
  gunner: { body: 'drum', hat: 'helmet', weapon: 'gun' },
  trapper: { body: 'capsule', hat: 'hood', weapon: 'net' },
  rifleman: { body: 'capsule', hat: 'tricorn', weapon: 'longgun', accessory: 'cape' },
  golem: { body: 'rock', hat: 'none', weapon: 'hammer' },
  grappler: { body: 'stocky', hat: 'helmet', weapon: 'none', accessory: 'cape' },

  // Hotshots
  deadeye: { body: 'capsule', hat: 'brim', weapon: 'gun' },
  chassis: { body: 'capsule', hat: 'antenna', weapon: 'gun', accessory: 'wings' },
  pyromancer: { body: 'capsule', hat: 'pointed', weapon: 'staff' },
  cryomancer: { body: 'capsule', hat: 'pointed', weapon: 'staff', accessory: 'halo' },
  archer: { body: 'capsule', hat: 'hood', weapon: 'bow' },

  // Suppliers
  pilferer: { body: 'blob', hat: 'ears', weapon: 'none', accessory: 'sack' },
  farmhand: { body: 'capsule', hat: 'brim', weapon: 'pick', accessory: 'sack' },
  colonel: { body: 'drum', hat: 'cap', weapon: 'none', accessory: 'cape' },
  wisp: { body: 'sphere', hat: 'none', weapon: 'none', accessory: 'halo' },
  buccaneer: { body: 'capsule', hat: 'tricorn', weapon: 'gun', accessory: 'sack' },
  trader: { body: 'capsule', hat: 'hood', weapon: 'none', accessory: 'sack' },

  // Healers
  medic: { body: 'capsule', hat: 'helmet', weapon: 'cross' },
  bannerman: { body: 'drum', hat: 'helmet', weapon: 'banner' },
  tinker: { body: 'stocky', hat: 'goggles', weapon: 'wrench', accessory: 'pet' },
  minstrel: { body: 'capsule', hat: 'brim', weapon: 'lute' },

  // Speedsters
  fowl: { body: 'sphere', hat: 'beak', weapon: 'none', accessory: 'tail' },
  boarrider: { body: 'stocky', hat: 'mohawk', weapon: 'hammer', accessory: 'wheels' },
  sprinter: { body: 'capsule', hat: 'cap', weapon: 'none', accessory: 'wings' },
  chameleon: { body: 'capsule', hat: 'hood', weapon: 'dagger', accessory: 'tail' },

  // Summoners
  engineer: { body: 'capsule', hat: 'goggles', weapon: 'wrench', accessory: 'turretbase' },
  necromancer: { body: 'capsule', hat: 'pointed', weapon: 'staff', accessory: 'cape' },
  beekeeper: { body: 'capsule', hat: 'helmet', weapon: 'net', accessory: 'orbs' },
  professor: { body: 'capsule', hat: 'goggles', weapon: 'none', accessory: 'pet' },
  beastmaster: { body: 'capsule', hat: 'crown', weapon: 'staff', accessory: 'pet' },
  pilot: { body: 'drum', hat: 'cap', weapon: 'none', accessory: 'wheels' },
  aviator: { body: 'capsule', hat: 'goggles', weapon: 'none', accessory: 'wings' },

  // All-rounders
  duelist: { body: 'capsule', hat: 'brim', weapon: 'dagger', accessory: 'cape' },
  titan: { body: 'box', hat: 'helmet', weapon: 'blade' },
  digger: { body: 'stocky', hat: 'helmet', weapon: 'pick' },
  bruiser: { body: 'stocky', hat: 'none', weapon: 'none', accessory: 'orbs' },

  // Mixed
  scattergun: { body: 'capsule', hat: 'none', weapon: 'gun', accessory: 'tuft' },

  // Summoned helpers — read as equipment and animals, never as people.
  turret: { body: 'prism', hat: 'none', weapon: 'none', accessory: 'turretbase' },
  skeleton: { body: 'capsule', hat: 'none', weapon: 'blade' },
  bear: { body: 'stocky', hat: 'ears', weapon: 'none' },
  drone: { body: 'sphere', hat: 'antenna', weapon: 'none', accessory: 'wings' },
};

/** Build the model for one unit from its recipe. */
export function buildUnitModel(type: UnitType): Group {
  const recipe = UNIT_RECIPES[type];
  const g = new Group();

  g.add(BODIES[recipe.body]());
  if (HUMANOID.has(recipe.body)) {
    g.add(at(mesh(new SphereGeometry(0.27, 16, 12), bodyMat), 0, HEAD_Y, 0));
  }
  HATS[recipe.hat ?? 'none'](g);
  WEAPONS[recipe.weapon ?? 'none'](g);
  ACCESSORIES[recipe.accessory ?? 'none'](g);

  return g;
}
