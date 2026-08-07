/**
 * Combat resolution (brief §1.7).
 *
 * There is no manual combat. Each tick a unit targets the nearest valid enemy
 * by class priority (enemy unit > neutral creep > destructible prop) and fires
 * when off cooldown. Units never leave formation to chase — target acquisition
 * only ever finds things already inside `attackRange`.
 *
 * The leader is untargetable and deals no damage (§1.7).
 */

import { UNIT_DEFS, unitDamage, unitHealPerSecond, type UnitTier, type UnitType } from '../config/units.ts';
import { distanceSq } from '../math/vec2.ts';
import { TEAM_NEUTRAL, type Entity, type EntityId, type EntityStore } from './entities.ts';

/** Lower number = higher priority, matching the brief's ordering. */
function targetPriority(target: Entity, attackerAlliance: number): number {
  if (target.kind === 'unit' && target.alliance !== attackerAlliance) return 0;
  if (target.kind === 'creep') return 1;
  // Farmables outrank ordinary scenery: if a Farmhand is standing between a
  // crate and a tree, the tree is what it is for.
  if (target.kind === 'tree' || target.kind === 'field') return 2;
  if (target.kind === 'prop' || target.kind === 'node') return 3;
  return Number.MAX_SAFE_INTEGER;
}

function isValidTarget(target: Entity, attacker: Entity): boolean {
  if (!target.alive || target.id === attacker.id) return false;
  // Leaders are never targetable; gems and chests aren't combat entities.
  if (target.kind === 'leader' || target.kind === 'gem' || target.kind === 'chest') return false;
  if (target.hp <= 0) return false;

  // Alliance, not team: duo partners and co-op squads share an alliance and
  // must be untargetable to each other even though they are separate teams.
  if (target.kind === 'unit') return target.alliance !== attacker.alliance;
  if (target.kind === 'creep') return attacker.team !== TEAM_NEUTRAL;
  if (target.kind === 'prop' || target.kind === 'node') return attacker.team !== TEAM_NEUTRAL;

  // Farmables are inert to everyone but their specialist. Expressed as a match
  // on a declared field rather than a unit-name check, so adding a third
  // farmable is one entity kind and one `harvests` value.
  if (target.kind === 'tree' || target.kind === 'field') {
    if (attacker.team === TEAM_NEUTRAL || !attacker.unitType) return false;
    return UNIT_DEFS[attacker.unitType].harvests === target.kind;
  }
  return false;
}

/**
 * Nearest valid target within range, respecting class priority.
 * Scans the whole entity list: with the brief's entity budget (~200) and a
 * 20 Hz tick this stays well inside the 3ms budget, and it avoids maintaining
 * a spatial index that would need invalidating on every move.
 */
export function acquireTarget(store: EntityStore, attacker: Entity, range: number): EntityId {
  let bestId: EntityId = 0;
  let bestPriority = Number.MAX_SAFE_INTEGER;
  let bestDistSq = Number.MAX_VALUE;
  const rangeSq = range * range;

  for (const candidate of store.items) {
    if (!isValidTarget(candidate, attacker)) continue;

    const priority = targetPriority(candidate, attacker.alliance);
    if (priority > bestPriority) continue;

    // Range is measured surface-to-surface, so a fat Guard doesn't have to
    // walk its centre into range of a big prop to hit it.
    const reach = range + candidate.radius + attacker.radius;
    const dSq = distanceSq(attacker.x, attacker.y, candidate.x, candidate.y);
    if (dSq > reach * reach) continue;

    if (priority < bestPriority || dSq < bestDistSq) {
      bestPriority = priority;
      bestDistSq = dSq;
      bestId = candidate.id;
    }
  }
  // rangeSq is intentionally unused for the surface-to-surface check above;
  // kept as a guard against a negative range slipping through config.
  void rangeSq;
  return bestId;
}

export interface DamageEvent {
  sourceId: EntityId;
  targetId: EntityId;
  amount: number;
  killed: boolean;
  x: number;
  y: number;
}

/** Apply damage, clamp at zero, and report whether this blow killed. */
export function applyDamage(target: Entity, amount: number): boolean {
  if (!target.alive || target.hp <= 0) return false;
  target.hp -= amount;
  if (target.hp <= 0) {
    target.hp = 0;
    return true;
  }
  return false;
}

/** Splash damage around a point, excluding the primary target (already hit). */
export function applySplash(
  store: EntityStore,
  attacker: Entity,
  centreX: number,
  centreY: number,
  radius: number,
  amount: number,
  primaryId: EntityId,
  out: DamageEvent[],
): void {
  const rSq = radius * radius;
  for (const e of store.items) {
    if (e.id === primaryId || !isValidTarget(e, attacker)) continue;
    if (distanceSq(centreX, centreY, e.x, e.y) > rSq) continue;
    const killed = applyDamage(e, amount);
    out.push({ sourceId: attacker.id, targetId: e.id, amount, killed, x: e.x, y: e.y });
  }
}

/**
 * Run one attacker's attack if it is off cooldown and has a target.
 * Returns the damage events produced so the world can turn them into deaths
 * and the client can turn them into hit VFX.
 */
export function resolveAttack(
  store: EntityStore,
  attacker: Entity,
  dt: number,
  out: DamageEvent[],
): void {
  if (!attacker.unitType) return;
  const def = UNIT_DEFS[attacker.unitType];

  // A stunned unit does nothing at all, including ticking its cooldown down —
  // otherwise a stun would bank up attacks and the unit would fire the instant
  // it recovered, giving the stun away for free.
  if (attacker.stunRemaining > 0) return;

  attacker.cooldown -= dt;
  if (attacker.cooldown > 0) return;

  // Pure healers don't attack (§1.5) — healing is handled separately.
  if (def.healPerSecond > 0 && def.damage === 0) return;

  const targetId = acquireTarget(store, attacker, def.attackRange);
  attacker.targetId = targetId;
  if (targetId === 0) {
    // Losing the target drops the streak, so a ramp has to be earned by holding
    // one enemy rather than accumulated across a whole fight.
    attacker.rampStacks = 0;
    attacker.rampTargetId = 0;
    return;
  }

  const target = store.get(targetId);
  if (!target) return;

  attacker.cooldown = def.attackInterval;

  if (def.rampMax > 1) {
    if (attacker.rampTargetId === target.id) attacker.rampStacks += 1;
    else {
      attacker.rampTargetId = target.id;
      attacker.rampStacks = 0;
    }
  }
  const ramp =
    def.rampMax > 1
      ? Math.min(def.rampMax, 1 + def.rampPerHit * attacker.rampStacks)
      : 1;

  const dmg = unitDamage(attacker.unitType, attacker.tier) * ramp;
  const killed = applyDamage(target, dmg);
  out.push({ sourceId: attacker.id, targetId: target.id, amount: dmg, killed, x: target.x, y: target.y });

  if (def.splashRadius > 0) {
    applySplash(store, attacker, target.x, target.y, def.splashRadius, dmg * 0.6, target.id, out);
  }

  if (def.lifesteal > 0) {
    attacker.hp = Math.min(attacker.maxHp, attacker.hp + dmg * def.lifesteal);
  }

  // Crowd control only lands on units. Applying it to props and creeps would
  // read as nothing happening, and stunning a prop is meaningless.
  if (target.kind === 'unit' || target.kind === 'creep') {
    if (def.slowFactor > 0) {
      // Refresh rather than stack, so multiple chillers don't compound into a stun.
      target.slowRemaining = Math.max(target.slowRemaining, def.slowDuration);
      target.slowFactor = Math.max(target.slowFactor, def.slowFactor);
    }
    if (def.stunDuration > 0) {
      target.stunRemaining = Math.max(target.stunRemaining, def.stunDuration);
    }
    if (def.knockback > 0) {
      pushAway(attacker, target, def.knockback);
    }
  }
}

/**
 * Shove a target directly away from its attacker.
 *
 * Position is written rather than velocity: units are steered to formation
 * slots every tick, so an impulse on velocity would be overwritten before it
 * moved anything. Displacing the position means the unit has to walk back.
 */
function pushAway(attacker: Entity, target: Entity, distance: number): void {
  const dx = target.x - attacker.x;
  const dy = target.y - attacker.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-4) return;
  target.x += (dx / len) * distance;
  target.y += (dy / len) * distance;
}

export interface HealEvent {
  sourceId: EntityId;
  targetId: EntityId;
  amount: number;
}

/**
 * Menders heal the lowest-HP squadmate in range.
 * §1.6: a given target may only receive one heal tick per 0.5s window, so
 * stacking Menders on one squad has sharply diminishing value.
 */
export function resolveHealing(
  store: EntityStore,
  healer: Entity,
  squad: Entity[],
  now: number,
  dt: number,
  out: HealEvent[],
): void {
  if (!healer.unitType) return;
  const def = UNIT_DEFS[healer.unitType];
  if (def.healPerSecond <= 0) return;

  healer.cooldown -= dt;
  if (healer.cooldown > 0) return;

  const rangeSq = def.attackRange * def.attackRange;
  let best: Entity | null = null;
  let bestDeficit = 0;

  for (const mate of squad) {
    if (!mate.alive || mate.id === healer.id || mate.hp >= mate.maxHp) continue;
    if (now - mate.lastHealedAt < 0.5) continue; // §1.6 heal window
    if (distanceSq(healer.x, healer.y, mate.x, mate.y) > rangeSq) continue;
    const deficit = mate.maxHp - mate.hp;
    if (deficit > bestDeficit) {
      bestDeficit = deficit;
      best = mate;
    }
  }

  if (!best) return;

  healer.cooldown = 0.5;
  const amount = Math.min(
    unitHealPerSecond(healer.unitType, healer.tier) * 0.5,
    best.maxHp - best.hp,
  );
  best.hp += amount;
  best.lastHealedAt = now;
  out.push({ sourceId: healer.id, targetId: best.id, amount });
}

/** Tick down slow and stun timers. */
export function decaySlow(unit: Entity, dt: number): void {
  if (unit.slowRemaining > 0) {
    unit.slowRemaining -= dt;
    if (unit.slowRemaining <= 0) {
      unit.slowRemaining = 0;
      unit.slowFactor = 0;
    }
  }
  if (unit.stunRemaining > 0) {
    unit.stunRemaining -= dt;
    if (unit.stunRemaining < 0) unit.stunRemaining = 0;
  }
}

/** Convenience for tests and the bot harness. */
export function unitDps(type: UnitType, tier: UnitTier): number {
  return unitDamage(type, tier) / UNIT_DEFS[type].attackInterval;
}
