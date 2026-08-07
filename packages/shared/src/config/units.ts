/**
 * The unit roster and its stacking rules (brief §1.5, §1.6).
 *
 * Pure data. Nothing here is code the sim branches on by name — the sim reads
 * these fields generically, so retuning is a data edit and adding a unit is a
 * data edit plus a model recipe. That property is load-bearing now that there
 * are 38 units: any ability expressed as a name check would have to be written
 * 38 times and would rot the moment the roster changed.
 *
 * Every ability in the design is therefore expressed as a *number on a unit*
 * that some generic system already consumes:
 *
 *   - squad-wide economy      -> `gemBonus`, summed and curved
 *   - squad-wide speed        -> `speedAura`, summed and capped
 *   - squad-wide toughness    -> `squadHpBonus`, summed and capped
 *   - heals                   -> `healPerSecond` (+ `splashRadius` for burst)
 *   - crowd control           -> `slowFactor`/`slowDuration`, `stunDuration`
 *   - displacement            -> `knockback`
 *   - sustain                 -> `lifesteal`
 *   - focus-fire ramp         -> `rampPerHit`/`rampMax`
 *   - pets and turrets        -> `summonType`/`summonInterval`/`summonCap`
 *
 * A unit whose flavour needs a mechanic the arena does not have (piloting map
 * vehicles, holding two spell pickups) is mapped onto the nearest mechanic that
 * does exist rather than given a bespoke code path; those cases are commented
 * individually.
 *
 * Naming: these are original names. The design references a roster of existing
 * commercial characters, and §1.9 rules out licensed or recognisable IP, so
 * each unit keeps its class, role and kit while carrying a name of its own.
 */

export const UNIT_CLASSES = [
  'fighter',
  'hotshot',
  'supplier',
  'healer',
  'speedster',
  'summoner',
  'allrounder',
] as const;

export type UnitClass = (typeof UNIT_CLASSES)[number];

/**
 * How hard a unit is to pull from a chest.
 *
 * Rarity does two jobs. It gates *when* a unit can appear — chests only offer
 * Commons for the opening stretch, then Rares, then Epics — and it sets what a
 * chest costs, so an Epic pull is a real investment rather than the same price
 * as a Goblin.
 *
 * The opening Common-only window is the load-bearing part: it means an economy
 * opening (farm crates, fell trees, bank coins) stays viable, because nobody
 * can rush an Epic on minute one and simply out-stat you.
 */
export const RARITIES = ['common', 'rare', 'epic'] as const;
export type Rarity = (typeof RARITIES)[number];

export const RARITY_LABELS: Record<Rarity, string> = {
  common: 'Common',
  rare: 'Rare',
  epic: 'Epic',
};

/** Farmable resources, each worked by exactly one specialist. */
export const HARVEST_KINDS = ['tree', 'field'] as const;
export type HarvestKind = (typeof HARVEST_KINDS)[number];

export const UNIT_CLASS_LABELS: Record<UnitClass, string> = {
  fighter: 'Fighter',
  hotshot: 'Hotshot',
  supplier: 'Supplier',
  healer: 'Healer',
  speedster: 'Speedster',
  summoner: 'Summoner',
  allrounder: 'All-rounder',
};

export const UNIT_TYPES = [
  // Fighters — melee, balanced HP and damage.
  'brute',
  'bombardier',
  'gunner',
  'trapper',
  'rifleman',
  'golem',
  'grappler',
  // Hotshots — ranged, high damage, low HP.
  'deadeye',
  'chassis',
  'pyromancer',
  'cryomancer',
  'archer',
  // Suppliers — economy.
  'pilferer',
  'farmhand',
  'colonel',
  'wisp',
  'buccaneer',
  'trader',
  // Healers.
  'medic',
  'bannerman',
  'tinker',
  'minstrel',
  // Speedsters.
  'fowl',
  'boarrider',
  'sprinter',
  'chameleon',
  // Summoners.
  'engineer',
  'necromancer',
  'beekeeper',
  'professor',
  'beastmaster',
  'pilot',
  'aviator',
  // All-rounders.
  'duelist',
  'titan',
  'digger',
  'bruiser',
  // Mixed fighter/hotshot.
  'scattergun',
  // Summoned helpers. Not offered in chests and not draftable — they only
  // enter the world through a Summoner, but they are units like any other so
  // combat, formation and rendering treat them generically.
  'turret',
  'skeleton',
  'bear',
  'drone',
] as const;

export type UnitType = (typeof UNIT_TYPES)[number];

/** Fusion tiers: base -> fused -> elite (§1.4, second and final tier). */
export type UnitTier = 0 | 1 | 2;

export interface UnitDef {
  type: UnitType;
  label: string;
  unitClass: UnitClass;
  /** One-line description of what this unit does, shown in draft and chests. */
  role: string;
  hp: number;
  /** Damage per attack. DPS in the brief is damage/attackInterval. */
  damage: number;
  /** Seconds between attacks. */
  attackInterval: number;
  /** World units. */
  attackRange: number;
  /** Multiplier on the base squad move speed. */
  speed: number;
  /** Collision radius; tanks are fatter so they absorb contact first. */
  radius: number;
  /** Splash radius, 0 for single-target. */
  splashRadius: number;
  /** HP restored per second to the lowest-HP squadmate in range. */
  healPerSecond: number;
  /** Fractional slow applied on hit, and its duration in seconds. */
  slowFactor: number;
  slowDuration: number;
  /** Seconds a hit target is unable to act. Small numbers; it is very strong. */
  stunDuration: number;
  /** World units a hit target is pushed away from the attacker. */
  knockback: number;
  /** Fraction of damage dealt that the attacker heals back. */
  lifesteal: number;
  /** Damage multiplier gained per consecutive hit on the same target. */
  rampPerHit: number;
  /** Cap on that ramp, as a multiplier. 1 means no ramp. */
  rampMax: number;
  /** Additive contribution to the squad gem multiplier, before the curve. */
  gemBonus: number;
  /** Additive fraction added to squad move speed, before the cap. */
  speedAura: number;
  /** Additive fraction added to every squadmate's max HP, before the cap. */
  squadHpBonus: number;
  /** Reduces this player's next chest price. Suppliers only. */
  chestDiscount: number;
  /**
   * A farmable this unit — and only this unit — can work.
   *
   * Trees and carrot fields are worth far more than a crate, but they are inert
   * to everyone except the specialist who can harvest them. That makes a
   * Supplier a genuine key rather than a passive percentage: a squad without a
   * Farmhand simply cannot open the orchards, so the map has value on it that
   * your composition decides whether you can reach.
   */
  harvests: HarvestKind | null;
  /** Helper this unit fields, or null. */
  summonType: UnitType | null;
  /** Seconds between summons, and how many may be alive at once. */
  summonInterval: number;
  summonCap: number;
  /** Formation preference: lower sorts closer to the front rank. */
  formationRank: number;
  /** Team-independent accent colour, used for the HUD swatch and sprite tint. */
  color: number;
  rarity: Rarity;
  /** Offered in the opening character draft (§ start-of-match pick of three). */
  starter: boolean;
  /** Summoned helpers are never offered anywhere. */
  summonedOnly: boolean;
}

/**
 * Per-class baselines.
 *
 * Every unit is written as a baseline plus the handful of numbers that make it
 * itself. Spelling out 38 full literals would bury the two or three fields that
 * actually distinguish each unit in forty lines of identical boilerplate, and
 * rebalancing a whole class would mean 38 synchronised edits instead of one.
 */
const CLASS_BASE: Record<UnitClass, Omit<UnitDef, 'type' | 'label' | 'role' | 'color'>> = {
  fighter: {
    unitClass: 'fighter',
    hp: 110,
    damage: 22,
    attackInterval: 1.0,
    attackRange: 0.85,
    speed: 1.0,
    radius: 0.28,
    splashRadius: 0,
    healPerSecond: 0,
    slowFactor: 0,
    slowDuration: 0,
    stunDuration: 0,
    knockback: 0,
    lifesteal: 0,
    rampPerHit: 0,
    rampMax: 1,
    gemBonus: 0,
    speedAura: 0,
    squadHpBonus: 0,
    chestDiscount: 0,
    harvests: null,
    summonType: null,
    summonInterval: 0,
    summonCap: 0,
    formationRank: 40,
    rarity: 'common',
    starter: true,
    summonedOnly: false,
  },
  hotshot: {
    unitClass: 'hotshot',
    hp: 60,
    damage: 26,
    attackInterval: 1.0,
    attackRange: 5.0,
    speed: 1.0,
    radius: 0.26,
    splashRadius: 0,
    healPerSecond: 0,
    slowFactor: 0,
    slowDuration: 0,
    stunDuration: 0,
    knockback: 0,
    lifesteal: 0,
    rampPerHit: 0,
    rampMax: 1,
    gemBonus: 0,
    speedAura: 0,
    squadHpBonus: 0,
    chestDiscount: 0,
    harvests: null,
    summonType: null,
    summonInterval: 0,
    summonCap: 0,
    formationRank: 80,
    rarity: 'common',
    starter: true,
    summonedOnly: false,
  },
  supplier: {
    unitClass: 'supplier',
    // Suppliers pay in gems, not damage, so they are deliberately poor fighters.
    hp: 85,
    damage: 6,
    attackInterval: 1.2,
    attackRange: 0.85,
    speed: 1.0,
    radius: 0.27,
    splashRadius: 0,
    healPerSecond: 0,
    slowFactor: 0,
    slowDuration: 0,
    stunDuration: 0,
    knockback: 0,
    lifesteal: 0,
    rampPerHit: 0,
    rampMax: 1,
    gemBonus: 0.3,
    speedAura: 0,
    squadHpBonus: 0,
    chestDiscount: 0,
    harvests: null,
    summonType: null,
    summonInterval: 0,
    summonCap: 0,
    formationRank: 95,
    rarity: 'common',
    starter: false,
    summonedOnly: false,
  },
  healer: {
    unitClass: 'healer',
    hp: 80,
    damage: 0,
    attackInterval: 1.0,
    attackRange: 4.0,
    speed: 1.0,
    radius: 0.26,
    splashRadius: 0,
    healPerSecond: 14,
    slowFactor: 0,
    slowDuration: 0,
    stunDuration: 0,
    knockback: 0,
    lifesteal: 0,
    rampPerHit: 0,
    rampMax: 1,
    gemBonus: 0,
    speedAura: 0,
    squadHpBonus: 0,
    chestDiscount: 0,
    harvests: null,
    summonType: null,
    summonInterval: 0,
    summonCap: 0,
    formationRank: 90,
    rarity: 'common',
    starter: false,
    summonedOnly: false,
  },
  speedster: {
    unitClass: 'speedster',
    hp: 75,
    damage: 12,
    attackInterval: 1.0,
    attackRange: 0.85,
    speed: 1.15,
    radius: 0.24,
    splashRadius: 0,
    healPerSecond: 0,
    slowFactor: 0,
    slowDuration: 0,
    stunDuration: 0,
    knockback: 0,
    lifesteal: 0,
    rampPerHit: 0,
    rampMax: 1,
    gemBonus: 0,
    speedAura: 0.05,
    squadHpBonus: 0,
    chestDiscount: 0,
    harvests: null,
    summonType: null,
    summonInterval: 0,
    summonCap: 0,
    formationRank: 50,
    rarity: 'common',
    starter: false,
    summonedOnly: false,
  },
  summoner: {
    unitClass: 'summoner',
    hp: 80,
    damage: 10,
    attackInterval: 1.2,
    attackRange: 3.5,
    speed: 0.95,
    radius: 0.27,
    splashRadius: 0,
    healPerSecond: 0,
    slowFactor: 0,
    slowDuration: 0,
    stunDuration: 0,
    knockback: 0,
    lifesteal: 0,
    rampPerHit: 0,
    rampMax: 1,
    gemBonus: 0,
    speedAura: 0,
    squadHpBonus: 0,
    chestDiscount: 0,
    harvests: null,
    summonType: null,
    summonInterval: 9,
    summonCap: 1,
    formationRank: 85,
    rarity: 'common',
    starter: false,
    summonedOnly: false,
  },
  allrounder: {
    unitClass: 'allrounder',
    hp: 130,
    damage: 18,
    attackInterval: 1.0,
    attackRange: 0.9,
    speed: 1.0,
    radius: 0.3,
    splashRadius: 0,
    healPerSecond: 0,
    slowFactor: 0,
    slowDuration: 0,
    stunDuration: 0,
    knockback: 0,
    lifesteal: 0,
    rampPerHit: 0,
    rampMax: 1,
    gemBonus: 0,
    speedAura: 0,
    squadHpBonus: 0,
    chestDiscount: 0,
    harvests: null,
    summonType: null,
    summonInterval: 0,
    summonCap: 0,
    formationRank: 45,
    rarity: 'common',
    starter: false,
    summonedOnly: false,
  },
};

function def(
  type: UnitType,
  label: string,
  unitClass: UnitClass,
  role: string,
  color: number,
  overrides: Partial<UnitDef> = {},
): UnitDef {
  return { ...CLASS_BASE[unitClass], type, label, role, color, ...overrides };
}

export const UNIT_DEFS: Record<UnitType, UnitDef> = {
  // ── Fighters ──────────────────────────────────────────────────────────────
  brute: def('brute', 'Brute', 'fighter', 'Reliable melee damage', 0xe4572e),
  bombardier: def(
    'bombardier',
    'Bombardier',
    'fighter',
    'Lobs explosives, hits clusters',
    0xff7043,
    // Slow swing, wide splash: the anti-clump fighter. The long interval is the
    // balance lever — burst that lands every 1.6s is dodgeable by moving.
    {
      damage: 30,
      attackInterval: 1.6,
      attackRange: 3.2,
      splashRadius: 1.5,
      formationRank: 65,
      rarity: 'rare',
    },
  ),
  gunner: def(
    'gunner',
    'Gunner',
    'fighter',
    'Tanky suppressing fire, toughens the squad',
    0x8d6e63,
    {
      hp: 210,
      damage: 9,
      attackInterval: 0.45,
      attackRange: 2.6,
      speed: 0.88,
      radius: 0.34,
      slowFactor: 0.25,
      slowDuration: 0.8,
      squadHpBonus: 0.06,
      formationRank: 20,
    },
  ),
  trapper: def('trapper', 'Trapper', 'fighter', 'Melee and ranged hybrid', 0x6d9773, {
    attackRange: 2.2,
    damage: 18,
    formationRank: 55,
    rarity: 'common',
  }),
  rifleman: def('rifleman', 'Rifleman', 'fighter', 'Steady ranged damage', 0xc9ada7, {
    hp: 90,
    damage: 20,
    attackRange: 4.4,
    formationRank: 75,
    rarity: 'common',
  }),
  golem: def('golem', 'Golem', 'fighter', 'Slow, very tanky, stuns on impact', 0x7d8491, {
    hp: 330,
    damage: 26,
    attackInterval: 1.9,
    speed: 0.72,
    radius: 0.44,
    splashRadius: 1.3,
    stunDuration: 0.6,
    formationRank: 10,
    rarity: 'epic',
  }),
  grappler: def('grappler', 'Grappler', 'fighter', 'Tanky slam, heals off its hits', 0xef476f, {
    hp: 300,
    damage: 14,
    attackInterval: 1.5,
    speed: 0.9,
    radius: 0.4,
    splashRadius: 1.1,
    stunDuration: 0.45,
    lifesteal: 0.35,
    formationRank: 15,
    rarity: 'common',
  }),

  // ── Hotshots ──────────────────────────────────────────────────────────────
  deadeye: def('deadeye', 'Deadeye', 'hotshot', 'Burst single-target damage', 0xf5c518, {
    damage: 15,
    attackInterval: 0.5,
    rarity: 'rare',
  }),
  chassis: def('chassis', 'Chassis', 'hotshot', 'Sustained robotic fire', 0xe8a0bf, {
    hp: 75,
    damage: 22,
    attackInterval: 0.85,
    rarity: 'rare',
  }),
  pyromancer: def('pyromancer', 'Pyromancer', 'hotshot', 'Ranged fire, small splash', 0x3f8efc, {
    damage: 28,
    attackInterval: 1.3,
    splashRadius: 1.0,
    rarity: 'epic',
  }),
  cryomancer: def('cryomancer', 'Cryomancer', 'hotshot', 'Ranged frost, chills enemies', 0x8ecae6, {
    damage: 16,
    attackInterval: 1.1,
    slowFactor: 0.4,
    slowDuration: 1.8,
    rarity: 'epic',
  }),
  archer: def('archer', 'Archer', 'hotshot', 'Steady backline damage', 0x52b788, {
    damage: 18,
    attackInterval: 0.75,
    attackRange: 5.5,
    rarity: 'rare',
  }),

  // ── Suppliers ─────────────────────────────────────────────────────────────
  pilferer: def('pilferer', 'Pilferer', 'supplier', 'Boosts gem income', 0x80b918, {
    speed: 1.08,
    rarity: 'common',
  }),
  farmhand: def('farmhand', 'Farmhand', 'supplier', 'Fells trees for a big haul', 0xd4a373, {
    gemBonus: 0.32,
    harvests: 'tree',
    // Needs to actually chop, so unlike other Suppliers it can hit things.
    damage: 16,
    attackInterval: 1.0,
    rarity: 'common',
  }),
  colonel: def('colonel', 'Colonel', 'supplier', 'Strong gem income', 0x606c38, {
    gemBonus: 0.42,
    hp: 100,
    rarity: 'epic',
  }),
  wisp: def('wisp', 'Wisp', 'supplier', 'Harvests carrot fields', 0x9d4edd, {
    gemBonus: 0.28,
    speed: 1.05,
    harvests: 'field',
    damage: 14,
    attackInterval: 1.0,
    rarity: 'epic',
  }),
  buccaneer: def('buccaneer', 'Buccaneer', 'supplier', 'Makes chests cheaper', 0xffb703, {
    // The design's "chance of bonus chest keys" has no analogue here — there are
    // no keys, chests are bought with gems. A standing discount on this player's
    // next chest is the same idea expressed in the currency this game has.
    gemBonus: 0.15,
    chestDiscount: 1.2,
    damage: 10,
    rarity: 'epic',
  }),
  trader: def('trader', 'Trader', 'supplier', 'Top-tier gem income', 0xfca311, {
    gemBonus: 0.55,
    hp: 95,
    rarity: 'rare',
  }),

  // ── Healers ───────────────────────────────────────────────────────────────
  medic: def('medic', 'Medic', 'healer', 'Heals allies, chips enemies', 0xff5d8f, {
    // Throws a kit: it damages on impact and heals the splash, so it is the one
    // healer that is not dead weight when the squad is at full HP.
    damage: 9,
    attackInterval: 1.4,
    splashRadius: 1.2,
    healPerSecond: 12,
    rarity: 'common',
  }),
  bannerman: def('bannerman', 'Bannerman', 'healer', 'Group heal over time', 0xc1121f, {
    hp: 130,
    healPerSecond: 11,
    attackRange: 5.0,
    formationRank: 35,
    rarity: 'epic',
  }),
  tinker: def('tinker', 'Tinker', 'healer', 'Passive area heal, fields a drone', 0x00b4d8, {
    healPerSecond: 10,
    summonType: 'drone',
    summonInterval: 14,
    summonCap: 1,
    rarity: 'rare',
  }),
  minstrel: def('minstrel', 'Minstrel', 'healer', 'Burst area heal', 0xf72585, {
    healPerSecond: 19,
    attackInterval: 2.2,
    attackRange: 4.6,
    rarity: 'rare',
  }),

  // ── Speedsters ────────────────────────────────────────────────────────────
  fowl: def('fowl', 'Fowl', 'speedster', 'Speeds up the squad, barely fights', 0xfaf3dd, {
    damage: 3,
    speedAura: 0.07,
    hp: 60,
    rarity: 'common',
  }),
  boarrider: def('boarrider', 'Boar Rider', 'speedster', 'Fast and hits hard', 0x9c6644, {
    hp: 150,
    damage: 26,
    speed: 1.25,
    speedAura: 0.04,
    radius: 0.3,
    formationRank: 25,
    rarity: 'rare',
  }),
  sprinter: def('sprinter', 'Sprinter', 'speedster', 'Strong squad speed buff', 0x48cae4, {
    speedAura: 0.08,
    rarity: 'rare',
  }),
  chameleon: def('chameleon', 'Chameleon', 'speedster', 'Fast flanker', 0x2d6a4f, {
    speed: 1.3,
    damage: 17,
    speedAura: 0.03,
    rarity: 'epic',
  }),

  // ── Summoners ─────────────────────────────────────────────────────────────
  engineer: def('engineer', 'Engineer', 'summoner', 'Deploys a turret', 0xffd166, {
    summonType: 'turret',
    summonInterval: 11,
    summonCap: 1,
    rarity: 'epic',
  }),
  necromancer: def('necromancer', 'Necromancer', 'summoner', 'Raises skeletons to soak hits', 0x7b2cbf, {
    summonType: 'skeleton',
    summonInterval: 5,
    summonCap: 3,
    rarity: 'epic',
  }),
  beekeeper: def('beekeeper', 'Beekeeper', 'summoner', 'Damage ramps on a held target', 0xffca3a, {
    // No summon: the design's Bea is filed as a Summoner but her actual kit is
    // ramping single-target damage, so that is what she gets.
    damage: 8,
    attackInterval: 0.6,
    rampPerHit: 0.18,
    rampMax: 2.6,
    summonInterval: 0,
    summonCap: 0,
    rarity: 'epic',
  }),
  professor: def('professor', 'Professor', 'summoner', 'Fields a hovering companion', 0xadb5bd, {
    summonType: 'drone',
    summonInterval: 10,
    summonCap: 2,
    rarity: 'epic',
  }),
  beastmaster: def('beastmaster', 'Beastmaster', 'summoner', 'Summons a bear that tanks', 0x774936, {
    summonType: 'bear',
    summonInterval: 16,
    summonCap: 1,
    rarity: 'epic',
  }),
  pilot: def('pilot', 'Pilot', 'summoner', 'Deploys a heavy walker', 0x3a5a40, {
    // The design's Tank hijacks vehicles that spawn on the map. There are none,
    // so the same fantasy — occasionally commanding something much bigger than
    // itself — is delivered as a rare, powerful, short-lived summon.
    summonType: 'bear',
    summonInterval: 20,
    summonCap: 1,
    damage: 14,
    rarity: 'epic',
  }),
  aviator: def('aviator', 'Aviator', 'summoner', 'Support companion, quick on its feet', 0xf4a261, {
    summonType: 'drone',
    summonInterval: 12,
    summonCap: 1,
    speed: 1.12,
    rarity: 'rare',
  }),

  // ── All-rounders ──────────────────────────────────────────────────────────
  duelist: def('duelist', 'Duelist', 'allrounder', 'Fast melee, closes distance', 0x5a189a, {
    hp: 110,
    damage: 24,
    attackInterval: 0.8,
    speed: 1.18,
    rarity: 'rare',
  }),
  titan: def('titan', 'Titan', 'allrounder', 'Durable, well-rounded melee', 0x1d3557, {
    hp: 200,
    damage: 24,
    radius: 0.36,
    speed: 0.92,
    formationRank: 20,
    rarity: 'epic',
  }),
  digger: def('digger', 'Digger', 'allrounder', 'Slippery melee, hard to pin', 0xbc6c25, {
    // "Burrows to become untargetable" needs a targeting exception the sim does
    // not have. Being genuinely hard to kill — high speed, small profile, real
    // HP — lands in the same place without a special case in target selection.
    hp: 140,
    damage: 20,
    speed: 1.2,
    radius: 0.24,
    rarity: 'epic',
  }),
  bruiser: def('bruiser', 'Bruiser', 'allrounder', 'Straightforward melee brawler', 0xd00000, {
    hp: 165,
    damage: 26,
    attackInterval: 1.1,
    rarity: 'epic',
  }),

  // ── Mixed ─────────────────────────────────────────────────────────────────
  scattergun: def(
    'scattergun',
    'Scattergun',
    'fighter',
    'Close-range blast, knocks enemies back',
    0xe76f51,
    {
      hp: 120,
      damage: 34,
      attackInterval: 1.5,
      attackRange: 2.2,
      splashRadius: 1.2,
      knockback: 1.1,
      formationRank: 30,
      rarity: 'epic',
    },
  ),

  // ── Summoned helpers ──────────────────────────────────────────────────────
  turret: def('turret', 'Turret', 'hotshot', 'Deployed turret', 0xffd166, {
    hp: 70,
    damage: 14,
    attackInterval: 0.9,
    attackRange: 4.5,
    // Stationary in spirit: it keeps up only barely, so it trails the squad.
    speed: 0.55,
    formationRank: 98,
    rarity: 'common',
    starter: false,
    summonedOnly: true,
  }),
  skeleton: def('skeleton', 'Skeleton', 'fighter', 'Fragile summoned minion', 0xe9ecef, {
    hp: 30,
    damage: 8,
    speed: 1.1,
    radius: 0.2,
    formationRank: 5,
    rarity: 'common',
    starter: false,
    summonedOnly: true,
  }),
  bear: def('bear', 'Bear', 'fighter', 'Summoned bruiser', 0x774936, {
    hp: 190,
    damage: 22,
    attackInterval: 1.2,
    radius: 0.36,
    formationRank: 18,
    rarity: 'common',
    starter: false,
    summonedOnly: true,
  }),
  drone: def('drone', 'Drone', 'healer', 'Summoned repair drone', 0x00b4d8, {
    hp: 45,
    healPerSecond: 7,
    speed: 1.15,
    radius: 0.18,
    formationRank: 92,
    rarity: 'common',
    starter: false,
    summonedOnly: true,
  }),
};

/** Every unit a player can actually acquire, in roster order. */
export const PLAYABLE_UNIT_TYPES: readonly UnitType[] = UNIT_TYPES.filter(
  (t) => !UNIT_DEFS[t].summonedOnly,
);

/**
 * The pool the opening character draft picks from.
 *
 * Commons only. Chests are Common-only for the opening stretch, so handing
 * somebody an Epic before the match has started would hand them a stat lead
 * nobody else can answer for two minutes.
 */
export const STARTER_UNIT_TYPES: readonly UnitType[] = UNIT_TYPES.filter(
  (t) => UNIT_DEFS[t].starter && UNIT_DEFS[t].rarity === 'common',
);

/** Playable units of a given rarity. */
export function unitsOfRarity(rarity: Rarity): UnitType[] {
  return PLAYABLE_UNIT_TYPES.filter((t) => UNIT_DEFS[t].rarity === rarity);
}

/** Per-tier multipliers (§1.4: fused ~2.6x HP, ~2.4x damage). */
export const TIER_HP_MULT: readonly number[] = [1, 2.6, 2.6 * 2.6];
export const TIER_DAMAGE_MULT: readonly number[] = [1, 2.4, 2.4 * 2.4];
export const MAX_TIER: UnitTier = 2;

export function unitMaxHp(type: UnitType, tier: UnitTier): number {
  return UNIT_DEFS[type].hp * (TIER_HP_MULT[tier] ?? 1);
}

export function unitDamage(type: UnitType, tier: UnitTier): number {
  return UNIT_DEFS[type].damage * (TIER_DAMAGE_MULT[tier] ?? 1);
}

export function unitHealPerSecond(type: UnitType, tier: UnitTier): number {
  return UNIT_DEFS[type].healPerSecond * (TIER_DAMAGE_MULT[tier] ?? 1);
}

/**
 * Squad gem multiplier from Suppliers (§1.6).
 *
 * Diminishing returns on the summed `gemBonus`, so an all-Supplier squad is a
 * real strategy rather than the only strategy: the same curve as the original
 * single-archetype rule, generalised over a weight so a Trader counts for
 * nearly twice a Wisp. Capped at +100%.
 */
export function gemMultiplier(totalGemBonus: number): number {
  if (totalGemBonus <= 0) return 1;
  // Effective count, where the baseline Supplier contributes 0.3.
  const n = totalGemBonus / 0.3;
  const bonus = (0.35 * (1 - Math.pow(0.75, n))) / 0.25;
  return 1 + Math.min(bonus, 1.0);
}

/** Squad speed bonus from Speedsters (§1.6). Additive fractions, capped. */
export function speedBonus(totalSpeedAura: number): number {
  return Math.min(0.25, Math.max(0, totalSpeedAura));
}

/** Squad max-HP bonus from units that toughen the group. Capped at +40%. */
export function squadHpMultiplier(totalHpBonus: number): number {
  return 1 + Math.min(0.4, Math.max(0, totalHpBonus));
}
