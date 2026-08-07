/** Match rules (brief §1.4) and the tick contract (§2.4). All tunable data. */

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
  /** Seconds before a wiped squad respawns at its home pad. */
  respawnSeconds: number;
  /** Free copies of the player's starting character granted on respawn. */
  respawnUnitCount: number;
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
  /** Seconds after match start before the late-unlock archetypes enter chests. */
  lateUnlockSeconds: number;
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
  chestPriceStep: 3,
  chestOfferCount: 3,
  fusionThreshold: 3,
  respawnSeconds: 5,
  respawnUnitCount: 2,
  gemLossFraction: 0.2,
  coinLossFraction: 0.35,
  leaderHarvestDamage: 7,
  leaderHarvestInterval: 0.6,
  leaderHarvestRange: 1.15,
  dashSpeed: 3.2,
  dashSeconds: 0.22,
  dashCooldownSeconds: 4.5,
  lateUnlockSeconds: 120,
  leaderSpeed: 4.2,
  squadCatchupSpeed: 1.35,
  reconnectGraceSeconds: 30,
  regenPerSecond: 6,
  regenDelaySeconds: 4,
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
  // Scenery pays coins, not score. Score lives on the creep camps, which a
  // lone leader cannot touch — that is the link that makes squad size worth
  // paying for. Without it, never buying scored as well as buying.
  prop: 1,
  resourceNode: 4,
  creep: 9,
  creepCampBonus: 50,
  tree: 18,
  field: 15,
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
