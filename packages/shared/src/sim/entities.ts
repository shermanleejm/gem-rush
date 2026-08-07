/**
 * Entity storage.
 *
 * One flat array of plain objects with a free-list, per brief §2.4. Entities
 * are never spliced out — they are marked dead and their slot is recycled — so
 * ids stay stable within a match and the hot path allocates nothing.
 *
 * A single struct with per-kind fields (rather than one array per kind) keeps
 * targeting simple: combat scans one list and filters by kind.
 */

import type { UnitTier, UnitType } from '../config/units.ts';

export type EntityId = number;

export const ENTITY_KINDS = [
  'leader',
  'unit',
  'creep',
  'prop',
  'node',
  'tree',
  'field',
  'chest',
  'gem',
  'coin',
  'hatchling',
] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

/** Teams: each player is their own team; creeps and props are neutral. */
export const TEAM_NEUTRAL = -1;

export interface Entity {
  id: EntityId;
  kind: EntityKind;
  alive: boolean;
  /** Owning player index, or TEAM_NEUTRAL. */
  team: number;
  /**
   * Who this entity counts as *on the side of*, which is not always who owns
   * it. In a free-for-all alliance equals team, but duos put two players on one
   * alliance and co-op puts everyone on one, and hostility is decided by
   * alliance alone. Keeping the two separate means "whose unit is this" (team,
   * used for squads, colour and scoring) never has to be conflated with "may I
   * shoot it" (alliance) — which is exactly the conflation that would otherwise
   * make teammates shoot each other.
   */
  alliance: number;

  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;

  hp: number;
  maxHp: number;

  // ── unit / creep ────────────────────────────────────────────────────────
  unitType: UnitType | null;
  tier: UnitTier;
  /** Seconds until this entity can attack again. */
  cooldown: number;
  /** Current target, or 0 for none. */
  targetId: EntityId;
  /** Index of this unit's formation slot within its squad. */
  slot: number;
  /** Remaining slow duration in seconds, and its strength. */
  slowRemaining: number;
  slowFactor: number;
  /** Remaining stun in seconds. A stunned unit neither moves nor attacks. */
  stunRemaining: number;
  /**
   * Focus-fire ramp: which target the streak is against, and how many
   * consecutive hits it has landed. Switching target resets it, which is what
   * makes the ramp a reward for holding a target rather than a flat buff.
   */
  rampTargetId: EntityId;
  rampStacks: number;
  /** Seconds until this unit may field its next summon. */
  summonCooldown: number;
  /** For summoned helpers: the unit that fielded them, so caps can be counted. */
  ownerId: EntityId;
  /** Debounce for Mender heals (§1.6: one heal tick per target per 0.5s). */
  lastHealedAt: number;
  /** Match time of the last damage taken; gates out-of-combat regen. */
  lastDamagedAt: number;

  // ── gem / pickup ────────────────────────────────────────────────────────
  /** Gem value for a destructible, or the pickup's own value once dropped. */
  value: number;
  /**
   * Coins this destructible pays out. Separate from `value` because the two
   * currencies are tuned independently — a resource node is worth more coins
   * than gems, a creep camp the reverse.
   */
  coinValue: number;
  /** Seconds until a consumed node or camp comes back. */
  respawnIn: number;
  /** Small delay before a dropped gem can be picked up, so it isn't instant. */
  pickupDelay: number;

  /** Creep camp grouping, so clearing a camp can pay a bonus. */
  campId: number;
}

function blankEntity(id: EntityId): Entity {
  return {
    id,
    kind: 'prop',
    alive: false,
    team: TEAM_NEUTRAL,
    alliance: TEAM_NEUTRAL,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    radius: 0.3,
    hp: 0,
    maxHp: 0,
    unitType: null,
    tier: 0,
    cooldown: 0,
    targetId: 0,
    slot: 0,
    slowRemaining: 0,
    slowFactor: 0,
    stunRemaining: 0,
    rampTargetId: 0,
    rampStacks: 0,
    summonCooldown: 0,
    ownerId: 0,
    lastHealedAt: -1,
    lastDamagedAt: -999,
    value: 0,
    coinValue: 0,
    respawnIn: 0,
    pickupDelay: 0,
    campId: -1,
  };
}

export class EntityStore {
  /** Dense array; index is not the id. Entity ids start at 1 so 0 means "none". */
  readonly items: Entity[] = [];
  private readonly byId = new Map<EntityId, Entity>();
  private readonly free: Entity[] = [];
  private nextId: EntityId = 1;

  get(id: EntityId): Entity | undefined {
    const e = this.byId.get(id);
    return e && e.alive ? e : undefined;
  }

  /** Recycle a dead slot if one is available, otherwise grow. */
  spawn(kind: EntityKind): Entity {
    const recycled = this.free.pop();
    const e = recycled ?? blankEntity(0);
    const id = this.nextId++;

    // Reset every field: a recycled entity must not leak state from its
    // previous life. Cheaper and far less bug-prone than remembering to clear
    // the handful of fields each kind happens to use.
    const fresh = blankEntity(id);
    Object.assign(e, fresh);
    e.kind = kind;
    e.alive = true;

    if (!recycled) this.items.push(e);
    this.byId.set(id, e);
    return e;
  }

  /** Mark dead and return the slot to the free list. */
  despawn(e: Entity): void {
    if (!e.alive) return;
    e.alive = false;
    this.byId.delete(e.id);
    this.free.push(e);
  }

  /** Live entities of a kind. Allocates — call outside the hot path. */
  ofKind(kind: EntityKind): Entity[] {
    const out: Entity[] = [];
    for (const e of this.items) if (e.alive && e.kind === kind) out.push(e);
    return out;
  }

  count(kind: EntityKind): number {
    let n = 0;
    for (const e of this.items) if (e.alive && e.kind === kind) n++;
    return n;
  }

  get liveCount(): number {
    let n = 0;
    for (const e of this.items) if (e.alive) n++;
    return n;
  }
}
