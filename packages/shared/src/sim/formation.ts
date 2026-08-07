/**
 * Squad formation (brief §2.5).
 *
 * Units occupy slots on concentric rings behind the leader's facing. Guards
 * take the front-most slots, Menders and Marksmen the rear-most, everything
 * else fills the middle — driven by each archetype's `formationRank` so it is
 * data, not a switch statement.
 *
 * Units steer toward their slot with seek + separation. They never path-find
 * and never leave formation to chase (§1.7) — that is what keeps a squad
 * readable as one blob and makes positioning the player's only decision.
 */

import { UNIT_DEFS } from '../config/units.ts';
import { clamp, normalizeInto, type Vec2 } from '../math/vec2.ts';
import type { Entity } from './entities.ts';

/** Ring capacities from the brief. Beyond this, extra units share the outer ring. */
export const RING_CAPACITY = [6, 8, 10] as const;
export const RING_RADIUS = [1.1, 1.9, 2.7] as const;

const scratch: Vec2 = { x: 0, y: 0 };

/**
 * Assign formation slots by role.
 * Sorting is stable on (formationRank, id) so a squad's layout doesn't churn
 * every tick — visual stability matters more here than a perfect packing.
 */
export function assignSlots(units: Entity[]): void {
  const ordered = units.slice().sort((a, b) => {
    const ra = a.unitType ? UNIT_DEFS[a.unitType].formationRank : 50;
    const rb = b.unitType ? UNIT_DEFS[b.unitType].formationRank : 50;
    return ra !== rb ? ra - rb : a.id - b.id;
  });
  for (let i = 0; i < ordered.length; i++) {
    ordered[i]!.slot = i;
  }
}

/** Which ring a slot index falls on, and its index within that ring. */
function ringFor(slot: number): { ring: number; indexInRing: number; ringSize: number } {
  let remaining = slot;
  for (let r = 0; r < RING_CAPACITY.length; r++) {
    const cap = RING_CAPACITY[r]!;
    if (remaining < cap) return { ring: r, indexInRing: remaining, ringSize: cap };
    remaining -= cap;
  }
  // Overflow past the defined rings: keep stacking on the outermost one.
  const last = RING_CAPACITY.length - 1;
  const cap = RING_CAPACITY[last]!;
  return { ring: last, indexInRing: remaining % cap, ringSize: cap };
}

/**
 * World position of a formation slot.
 * Slots sit on an arc *behind* the leader's facing so the squad trails rather
 * than surrounding — that reads as "following" and keeps the leader visible.
 */
export function slotPosition(
  out: Vec2,
  leaderX: number,
  leaderY: number,
  facing: number,
  slot: number,
): Vec2 {
  const { ring, indexInRing, ringSize } = ringFor(slot);
  const radius = RING_RADIUS[ring] ?? RING_RADIUS[RING_RADIUS.length - 1]!;

  // Spread across a 200° arc centred directly behind the leader.
  const arc = Math.PI * 1.11;
  const behind = facing + Math.PI;
  const t = ringSize <= 1 ? 0.5 : indexInRing / (ringSize - 1);
  const angle = behind - arc / 2 + arc * t;

  out.x = leaderX + Math.cos(angle) * radius;
  out.y = leaderY + Math.sin(angle) * radius;
  return out;
}

/**
 * Steer one unit toward its slot.
 *
 * Arrival damping inside `slowRadius` stops units jittering on the spot when
 * the leader is stationary, which was very visible without it.
 */
export function steerToSlot(
  unit: Entity,
  targetX: number,
  targetY: number,
  maxSpeed: number,
): void {
  // Sets velocity only — integration and terrain collision happen in
  // World.moveWithCollision, so there is deliberately no dt here.
  const dx = targetX - unit.x;
  const dy = targetY - unit.y;
  const dist = Math.hypot(dx, dy);

  const slowRadius = 0.6;
  const deadZone = 0.05;

  if (dist < deadZone) {
    unit.vx = 0;
    unit.vy = 0;
    return;
  }

  const speed = dist < slowRadius ? maxSpeed * (dist / slowRadius) : maxSpeed;
  normalizeInto(scratch, dx, dy);
  unit.vx = scratch.x * speed;
  unit.vy = scratch.y * speed;
}

/**
 * Push overlapping squadmates apart.
 *
 * O(n^2) over one squad, but a squad is capped at 15 units (§1.4) so that is
 * at most 105 pairs per squad per tick — far cheaper than a spatial index and
 * its bookkeeping at this size.
 */
export function separate(units: Entity[], strength: number, dt: number): void {
  for (let i = 0; i < units.length; i++) {
    const a = units[i]!;
    for (let j = i + 1; j < units.length; j++) {
      const b = units[j]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const minDist = a.radius + b.radius;
      const distSq = dx * dx + dy * dy;
      if (distSq >= minDist * minDist || distSq < 1e-9) continue;

      const dist = Math.sqrt(distSq);
      const overlap = (minDist - dist) * 0.5 * strength;
      const nx = dx / dist;
      const ny = dy / dist;
      a.x -= nx * overlap * dt;
      a.y -= ny * overlap * dt;
      b.x += nx * overlap * dt;
      b.y += ny * overlap * dt;
    }
  }
}

/** Effective move speed after archetype modifier, Scout aura and any slow. */
export function unitMoveSpeed(
  unit: Entity,
  baseSpeed: number,
  squadSpeedBonus: number,
  terrainMult = 1,
): number {
  const def = unit.unitType ? UNIT_DEFS[unit.unitType] : null;
  const archetype = def ? def.speed : 1;
  const slow = unit.slowRemaining > 0 ? 1 - unit.slowFactor : 1;
  return baseSpeed * archetype * (1 + squadSpeedBonus) * clamp(slow, 0.1, 1) * terrainMult;
}
