/**
 * Unit fusion (brief §1.4).
 *
 * Three identical units (same type AND same tier) fuse into one of the next
 * tier. Base -> fused -> elite, and elite is final.
 *
 * Fusion is checked after any squad addition. It cascades: adding a third base
 * unit can create a third fused unit, which immediately becomes an elite.
 */

import { MATCH } from '../config/match.ts';
import { MAX_TIER, unitMaxHp, type UnitTier, type UnitType } from '../config/units.ts';
import type { Entity, EntityStore } from './entities.ts';

export interface FusionResult {
  type: UnitType;
  fromTier: UnitTier;
  toTier: UnitTier;
  consumedIds: number[];
  resultId: number;
  x: number;
  y: number;
}

/**
 * Fuse everything fusable in one squad, repeatedly, until no group of
 * `fusionThreshold` identical units remains below max tier.
 *
 * Consumed units are despawned and one survivor is promoted in place — that
 * keeps the promoted unit's formation slot and position, so a fusion reads as
 * "these three merged" rather than the squad reshuffling.
 */
export function applyFusions(
  store: EntityStore,
  squad: Entity[],
  out: FusionResult[],
): Entity[] {
  let working = squad.filter((u) => u.alive);
  let fusedSomething = true;

  while (fusedSomething) {
    fusedSomething = false;

    // Group by type+tier. Only groups at or over the threshold can fuse.
    const groups = new Map<string, Entity[]>();
    for (const unit of working) {
      if (!unit.unitType || unit.tier >= MAX_TIER) continue;
      const key = `${unit.unitType}:${unit.tier}`;
      let list = groups.get(key);
      if (!list) {
        list = [];
        groups.set(key, list);
      }
      list.push(unit);
    }

    for (const group of groups.values()) {
      if (group.length < MATCH.fusionThreshold) continue;

      // Deterministic pick: oldest ids first, so host and any replay agree.
      group.sort((a, b) => a.id - b.id);
      const consumed = group.slice(0, MATCH.fusionThreshold);
      const survivor = consumed[0]!;
      const removed = consumed.slice(1);

      const type = survivor.unitType!;
      const fromTier = survivor.tier;
      const toTier = (fromTier + 1) as UnitTier;

      survivor.tier = toTier;
      survivor.maxHp = unitMaxHp(type, toTier);
      survivor.hp = survivor.maxHp; // fusing heals — it should feel like a reward
      survivor.cooldown = 0;

      for (const unit of removed) store.despawn(unit);

      out.push({
        type,
        fromTier,
        toTier,
        consumedIds: consumed.map((u) => u.id),
        resultId: survivor.id,
        x: survivor.x,
        y: survivor.y,
      });

      working = working.filter((u) => u.alive);
      fusedSomething = true;
      break; // regroup from scratch so cascades are handled cleanly
    }
  }

  return working;
}

/** How many more of `type` at `tier` this squad needs to trigger a fusion. */
export function untilFusion(squad: Entity[], type: UnitType, tier: UnitTier): number {
  let n = 0;
  for (const u of squad) if (u.alive && u.unitType === type && u.tier === tier) n++;
  return Math.max(0, MATCH.fusionThreshold - (n % MATCH.fusionThreshold));
}
