/** Match rules (brief §1.4) and the tick contract (§2.4). All tunable data. */

import type { Rarity } from './units.ts';

export const TICK_RATE = 20;
export const TICK_DT = 1 / TICK_RATE;
export const INPUT_RATE = 30;

export interface MatchConfig {
  minPlayers: number;
  maxPlayers: number;
  /** Total match length in seconds, last-call included. */
  matchSeconds: number;
  /** Length of the closing double-value phase, inside matchSeconds. */
  lastCallSeconds: number;
  /** Multiplier applied to every gem source during last call. */
  lastCallMultiplier: number;
  squadCap: number;
  startingGems: number;
  startingCoins: number;
  /**
   * Units granted once the opening draft resolves. One, of the character the
   * player picked — the whole point of the draft is that your first unit is a
   * decision rather than a default, so handing out two of something would
   * dilute it before the match starts.
   */
  startingUnitCount: number;
  /** Seconds players get to pick their starting character before auto-pick. */
  draftSeconds: number;
  /** How many characters the opening draft offers. */
  draftOfferCount: number;
  /** Chest price, in coins. */
  chestBasePrice: number;
  /** Added to that player's next chest price each time they buy (§1.4). */
  chestPriceStep: number;
  chestOfferCount: number;
  fusionThreshold: number;
  /** Fraction of banked gems scattered when you lose a squad fight. */
  gemLossFraction: number;
  /**
   * Fraction of carried coins dropped on a wipe.
   *
   * Higher than the gem loss on purpose: coins are recoverable spending money,
   * so losing a fight should set back what you were saving for without also
   * gutting the score you have already earned.
   */
  coinLossFraction: number;

  /**
   * The leader's own harvesting attack.
   *
   * Leaders are invulnerable and take no part in fights (§1.7), but making them
   * completely inert broke the opening: you start with one unit, a lone unit
   * only connects when the squad happens to sweep within ~1.5 tiles of
   * something, and the harness measured squads that never grew past 1.1 units
   * because nobody could earn the coins for a first chest. The one thing the
   * player directly aims has to be able to start the economy.
   *
   * Scope is deliberately narrow: crates and ore only. Not units or creeps, so
   * leaders still never fight; not trees or fields, so a Supplier stays the
   * only key to those.
   */
  leaderHarvestDamage: number;
  leaderHarvestInterval: number;
  leaderHarvestRange: number;

  /**
   * Dash: a short burst of speed on a cooldown, and the only action the player
   * has besides moving. It exists so there is something to do in a fight that
   * is not "hold a direction" — closing on a fleeing leader, or breaking away
   * from a losing one.
   */
  dashSpeed: number;
  dashSeconds: number;
  dashCooldownSeconds: number;
  /**
   * When each rarity starts appearing in chests.
   *
   * Commons from the opening whistle, Rares partway in, Epics late. The window
   * where only Commons exist is what keeps an economy opening viable: nobody
   * can buy their way to a stat lead in the first minute, so farming crates and
   * felling trees is a real strategy rather than a slower way to lose.
   */
  rarityUnlockSeconds: Record<Rarity, number>;
  /**
   * Price multiplier per rarity. An Epic chest is a genuine investment, not the
   * same coin as a Goblin.
   */
  rarityPriceMultiplier: Record<Rarity, number>;
  /** Relative odds of each unlocked rarity appearing on a chest. */
  rarityWeight: Record<Rarity, number>;
  /** Base leader move speed, world units per second. */
  leaderSpeed: number;
  /** Squad units move slightly faster than the leader so they can catch up. */
  squadCatchupSpeed: number;
  /** How long a disconnected player's squad is held for reconnect. */
  reconnectGraceSeconds: number;
  /**
   * Out-of-combat regeneration.
   *
   * Without this, units only ever lose HP: they hold formation rather than
   * chasing (§1.7), so they collect chip damage brushing past creep camps and
   * never recover it. Over a four-minute match that is pure attrition — the
   * bench harness measured 92 unit deaths against 3 creep kills — which makes
   * buying units strictly bad and collapses the economy the game is built on.
   * Regen keeps real fights decisive while making incidental damage survivable.
   */
  regenPerSecond: number;
  regenDelaySeconds: number;

  /**
   * Diminishing gem returns per extra squad member.
   *
   * A bigger squad is better at everything — more damage, more reach, more
   * hands picking things up — so gem income scaled with squad size and the
   * hoarding opening simply could not keep pace. Raising what scenery paid did
   * not help, because a big squad farms scenery faster too.
   *
   * This is the dial that separates the two. A squad is still strictly better
   * in a fight and still clears camps a lone leader cannot touch; it just does
   * not bank proportionally more, so patiently farming with a small squad and
   * snowballing into a large one come out about even.
   */
  squadGemFalloff: number;

  /**
   * Opening window in which a wipe rebuilds you instead of ending your run.
   *
   * Being busted is meant to be the stake that makes fights matter, but with a
   * one-unit opening squad it was landing twenty seconds into a four-minute
   * match — and then there is nothing to do but watch. A short grace means the
   * first mistake costs you tempo rather than the whole round, and the rule
   * still bites for the rest of the match where the gems actually are.
   */
  bustGraceSeconds: number;
  /** Units handed back on an early rebuild. */
  rebuildUnitCount: number;
}

export const MATCH: MatchConfig = {
  minPlayers: 1,
  maxPlayers: 8,
  matchSeconds: 240,
  lastCallSeconds: 30,
  lastCallMultiplier: 2,
  squadCap: 15,
  startingGems: 0,
  startingCoins: 6,
  startingUnitCount: 1,
  draftSeconds: 15,
  draftOfferCount: 3,
  chestBasePrice: 10,
  chestPriceStep: 5,
  chestOfferCount: 3,
  fusionThreshold: 3,
  gemLossFraction: 0.2,
  coinLossFraction: 0.35,
  leaderHarvestDamage: 7,
  leaderHarvestInterval: 0.6,
  leaderHarvestRange: 1.15,
  dashSpeed: 3.2,
  dashSeconds: 0.22,
  dashCooldownSeconds: 4.5,
  rarityUnlockSeconds: { common: 0, rare: 70, epic: 145 },
  rarityPriceMultiplier: { common: 1, rare: 1.7, epic: 2.6 },
  // Commons stay the common case even once the others unlock, so the cheap
  // rebuild is always on the table.
  rarityWeight: { common: 3, rare: 2, epic: 1 },
  leaderSpeed: 4.2,
  squadCatchupSpeed: 1.35,
  reconnectGraceSeconds: 30,
  regenPerSecond: 6,
  regenDelaySeconds: 4,
  squadGemFalloff: 0.13,
  bustGraceSeconds: 60,
  rebuildUnitCount: 2,
};

/**
 * What each source drops.
 *
 * Two currencies, and the split is the point. **Gems are score and nothing
 * else; coins are spending money and nothing else.** Previously one pile was
 * both, which meant every purchase was literally a subtraction from your score
 * and buying anything felt like losing — the harness showed the heaviest buyer
 * winning 1.3% of matches. Separating them lets a player build a squad without
 * paying for it out of the thing they are being ranked on, and lets the two be
 * tuned independently: coins pace how fast squads grow, gems pace the score.
 *
 * Both are multiplied by zone yield and last call; only gems take the Supplier
 * bonus, so an economy squad out-scores rather than out-spends.
 */
export const COIN_YIELD = {
  prop: 14,
  resourceNode: 34,
  creep: 16,
  creepCampBonus: 55,
  // Farmables pay several times a crate. They have to: only one unit in the
  // squad can work them, so the payout is what justifies spending a slot.
  tree: 90,
  field: 72,
};

export const GEM_YIELD = {
  // The split between scenery and camps is the dial between the two viable
  // openings. Camps need a squad, so weighting score onto them makes buying
  // pay; scenery can be worked by a lone leader, so weighting score onto that
  // makes hoarding pay. Both should win about equally often, so this sits
  // between the extremes rather than at either end.
  prop: 3,
  resourceNode: 11,
  creep: 6,
  creepCampBonus: 24,
  tree: 30,
  field: 25,
};

/**
 * Match phases, in order.
 *
 * `draft` sits between the lobby and play: the world exists and the map is
 * generated, but no squads have spawned yet because nobody has chosen what
 * they are starting with.
 */
export const PHASES = ['lobby', 'draft', 'playing', 'lastCall', 'ended'] as const;
export type Phase = (typeof PHASES)[number];
