/**
 * Summoner helpers (brief §1.5, Summoner class).
 *
 * A Summoner fields a helper unit on a timer, up to a cap. The helpers are
 * ordinary units — they fight, hold formation slots, take damage and render
 * exactly like bought units — which is why this file is thirty lines rather
 * than a subsystem: everything downstream already handles them.
 *
 * Two rules keep summons from breaking the economy:
 *
 *   - Helpers never count against the squad cap, or a Necromancer would spend
 *     three of your fifteen slots on skeletons and be strictly bad.
 *   - Helpers are not `PLAYABLE_UNIT_TYPES`, so they can never appear in a
 *     chest offer or the opening draft. The only way to get one is to field
 *     the Summoner that makes it.
 */

import { UNIT_DEFS } from '../config/units.ts';
import type { Entity, EntityStore } from './entities.ts';
import { spawnUnit } from './spawning.ts';

/**
 * Advance every Summoner's timer and field helpers that are due.
 * Returns the units created, so the world can announce them.
 */
export function updateSummons(
  store: EntityStore,
  squad: readonly Entity[],
  teamIndex: number,
  dt: number,
): Entity[] {
  const created: Entity[] = [];

  for (const unit of squad) {
    if (!unit.alive || !unit.unitType) continue;
    const def = UNIT_DEFS[unit.unitType];
    if (!def.summonType || def.summonCap <= 0 || def.summonInterval <= 0) continue;

    // A stunned summoner is fully out of the fight, timers included.
    if (unit.stunRemaining > 0) continue;

    unit.summonCooldown -= dt;
    if (unit.summonCooldown > 0) continue;

    // Count only this summoner's own live helpers. Counting by type would let
    // two Engineers share one turret budget, so the second would be worthless.
    let alive = 0;
    for (const e of store.items) {
      if (e.alive && e.kind === 'unit' && e.ownerId === unit.id) alive++;
    }
    if (alive >= def.summonCap) {
      // Re-check soon rather than resetting the full interval: the helper may
      // die a moment from now, and a fresh full cooldown would punish the
      // summoner for having been at cap at the wrong instant.
      unit.summonCooldown = 1;
      continue;
    }

    unit.summonCooldown = def.summonInterval;
    const helper = spawnUnit(store, teamIndex, def.summonType, unit.tier, unit.x, unit.y + 0.4);
    helper.ownerId = unit.id;
    created.push(helper);
  }

  return created;
}

/** Is this unit a summoned helper rather than something the player bought? */
export function isSummoned(unit: Entity): boolean {
  return unit.ownerId !== 0;
}
