/**
 * Squad-wide effects (brief §1.6).
 *
 * Several classes do their work by existing rather than by acting: Suppliers
 * raise gem income, Speedsters raise squad speed, some Fighters toughen the
 * whole group. All of that is a sum over the squad of a number on the unit
 * definition, curved or capped once at the end.
 *
 * Summing declared fields rather than counting units by name is what keeps a
 * 38-unit roster tractable: a new economy unit is one number in `units.ts`, and
 * a Trader can be worth nearly twice a Wisp without the sim knowing either
 * exists. It is also why stacking rules stay honest — the cap applies to the
 * total, so ten Suppliers cannot outrun the curve.
 */

import {
  UNIT_DEFS,
  gemMultiplier,
  speedBonus,
  squadHpMultiplier,
  unitMaxHp,
} from '../config/units.ts';
import type { Entity } from './entities.ts';

export interface SquadAuras {
  /** Multiplier on every gem this squad's owner banks. */
  gemMultiplier: number;
  /** Additive fraction on squad and leader move speed. */
  speedBonus: number;
  /** Multiplier on every squadmate's max HP. */
  hpMultiplier: number;
  /** Flat reduction on this player's next chest price. */
  chestDiscount: number;
}

export const NO_AURAS: SquadAuras = {
  gemMultiplier: 1,
  speedBonus: 0,
  hpMultiplier: 1,
  chestDiscount: 0,
};

/**
 * Fusing a unit strengthens its aura as well as its stats.
 *
 * Sub-linear in tier on purpose: fusion already multiplies HP by 2.6 and damage
 * by 2.4, so matching that on a squad-wide economy multiplier would make a
 * single fused Trader worth more than the rest of the squad combined.
 */
function tierScale(tier: number): number {
  return 1 + 0.6 * tier;
}

export function squadAuras(squad: readonly Entity[]): SquadAuras {
  let gem = 0;
  let speed = 0;
  let hp = 0;
  let discount = 0;

  for (const unit of squad) {
    if (!unit.alive || !unit.unitType) continue;
    const def = UNIT_DEFS[unit.unitType];
    const scale = tierScale(unit.tier);
    gem += def.gemBonus * scale;
    speed += def.speedAura * scale;
    hp += def.squadHpBonus * scale;
    discount += def.chestDiscount * scale;
  }

  return {
    gemMultiplier: gemMultiplier(gem),
    speedBonus: speedBonus(speed),
    hpMultiplier: squadHpMultiplier(hp),
    chestDiscount: discount,
  };
}

/**
 * Re-derive every squadmate's max HP for the current squad composition.
 *
 * Max HP is normally fixed at spawn, but a squad HP aura changes it whenever
 * the squad does — buying a Gunner has to toughen units that already exist, and
 * losing it has to take that back. Current HP is carried across as a
 * *fraction*, so gaining the aura tops a unit up proportionally instead of
 * healing it outright, and losing it cannot kill anyone by dropping max HP
 * below current.
 */
export function applyHpAura(squad: readonly Entity[], hpMultiplier: number): void {
  for (const unit of squad) {
    if (!unit.alive || !unit.unitType) continue;
    const target = unitMaxHp(unit.unitType, unit.tier) * hpMultiplier;
    if (Math.abs(target - unit.maxHp) < 1e-6) continue;
    const fraction = unit.maxHp > 0 ? unit.hp / unit.maxHp : 1;
    unit.maxHp = target;
    unit.hp = Math.min(target, target * fraction);
  }
}
