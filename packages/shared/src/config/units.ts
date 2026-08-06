/**
 * Unit archetypes (brief §1.5) and stacking rules (§1.6).
 *
 * Pure data. Nothing here is code the sim branches on by name — the sim reads
 * these fields generically, so retuning is a data edit and adding a ninth
 * archetype is a data edit plus art.
 */

export const UNIT_TYPES = [
  'striker',
  'marksman',
  'guard',
  'mender',
  'blaster',
  'harvester',
  'scout',
  'warden',
] as const;

export type UnitType = (typeof UNIT_TYPES)[number];

/** Fusion tiers: base -> fused -> elite (§1.4, second and final tier). */
export type UnitTier = 0 | 1 | 2;

export interface UnitDef {
  type: UnitType;
  label: string;
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
  /** Collision radius; Guards are fatter so they absorb contact first. */
  radius: number;
  /** Splash radius, 0 for single-target. */
  splashRadius: number;
  /** HP restored per second to the lowest-HP squadmate in range. */
  healPerSecond: number;
  /** Fractional slow applied on hit, and its duration in seconds. */
  slowFactor: number;
  slowDuration: number;
  /** Formation preference: lower sorts closer to the front rank. */
  formationRank: number;
  /** Placeholder art colour until M7 replaces it with an atlas. */
  color: number;
  /** Available from match start, or only after the unlock time (§1.5). */
  earlyPool: boolean;
}

/**
 * DPS figures in the brief are damage-per-second; attackInterval is chosen per
 * archetype for feel and `damage` derived so DPS lands on the brief's number.
 * Blaster deliberately has a long interval ("slow attack rate, hits clusters").
 */
export const UNIT_DEFS: Record<UnitType, UnitDef> = {
  striker: {
    type: 'striker',
    label: 'Striker',
    role: 'Basic melee',
    hp: 100,
    damage: 22,
    attackInterval: 1.0,
    attackRange: 0.8,
    speed: 1.0,
    radius: 0.28,
    splashRadius: 0,
    healPerSecond: 0,
    slowFactor: 0,
    slowDuration: 0,
    formationRank: 40,
    color: 0xe4572e,
    earlyPool: true,
  },
  marksman: {
    type: 'marksman',
    label: 'Marksman',
    role: 'Ranged single-target',
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
    formationRank: 80,
    color: 0xf5c518,
    earlyPool: true,
  },
  guard: {
    type: 'guard',
    label: 'Guard',
    role: 'Tank',
    hp: 300,
    damage: 10,
    attackInterval: 1.0,
    attackRange: 1.0,
    speed: 0.85,
    // Larger radius is load-bearing: §1.5 says Guards body-block and absorb
    // squad collisions first, which falls out of contact resolution ordering
    // by radius rather than needing a special case.
    radius: 0.42,
    splashRadius: 0,
    healPerSecond: 0,
    slowFactor: 0,
    slowDuration: 0,
    formationRank: 10,
    color: 0x4d7ea8,
    earlyPool: true,
  },
  mender: {
    type: 'mender',
    label: 'Mender',
    role: 'Support',
    hp: 80,
    damage: 0,
    attackInterval: 1.0,
    attackRange: 4.0,
    speed: 1.0,
    radius: 0.26,
    splashRadius: 0,
    healPerSecond: 15,
    slowFactor: 0,
    slowDuration: 0,
    formationRank: 90,
    color: 0x5cb85c,
    earlyPool: false,
  },
  blaster: {
    type: 'blaster',
    label: 'Blaster',
    role: 'Ranged AoE',
    hp: 70,
    // 18 DPS at a 1.6s interval => 28.8 per shot.
    damage: 28.8,
    attackInterval: 1.6,
    attackRange: 4.0,
    speed: 0.95,
    radius: 0.3,
    splashRadius: 1.5,
    healPerSecond: 0,
    slowFactor: 0,
    slowDuration: 0,
    formationRank: 70,
    color: 0xb565d8,
    earlyPool: false,
  },
  harvester: {
    type: 'harvester',
    label: 'Harvester',
    role: 'Economy',
    hp: 90,
    damage: 12,
    attackInterval: 1.0,
    attackRange: 0.8,
    speed: 1.0,
    radius: 0.28,
    splashRadius: 0,
    healPerSecond: 0,
    slowFactor: 0,
    slowDuration: 0,
    formationRank: 60,
    color: 0x2ec4b6,
    earlyPool: false,
  },
  scout: {
    type: 'scout',
    label: 'Scout',
    role: 'Utility',
    hp: 70,
    damage: 14,
    attackInterval: 1.0,
    attackRange: 0.8,
    speed: 1.0,
    radius: 0.24,
    splashRadius: 0,
    healPerSecond: 0,
    slowFactor: 0,
    slowDuration: 0,
    formationRank: 50,
    color: 0xffa552,
    earlyPool: false,
  },
  warden: {
    type: 'warden',
    label: 'Warden',
    role: 'Control',
    hp: 120,
    damage: 8,
    attackInterval: 1.0,
    attackRange: 2.5,
    speed: 0.9,
    radius: 0.32,
    splashRadius: 0,
    healPerSecond: 0,
    slowFactor: 0.3,
    slowDuration: 1.5,
    formationRank: 30,
    color: 0x8d99ae,
    earlyPool: false,
  },
};

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
 * Harvester gem bonus (§1.6): 1 + 0.35 * (1 - 0.75^n) / 0.25, capped at +100%.
 * Returns a multiplier, so 0 Harvesters gives exactly 1.
 */
export function harvesterMultiplier(n: number): number {
  if (n <= 0) return 1;
  const bonus = (0.35 * (1 - Math.pow(0.75, n))) / 0.25;
  return 1 + Math.min(bonus, 1.0);
}

/** Scout aura (§1.6): min(0.25, 0.06 * n). Returns the additive fraction. */
export function scoutSpeedBonus(n: number): number {
  return Math.min(0.25, 0.06 * Math.max(0, n));
}
