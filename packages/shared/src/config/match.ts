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
  startingUnitCount: 1,
  draftSeconds: 15,
  draftOfferCount: 3,
  chestBasePrice: 6,
  chestPriceStep: 3,
  chestOfferCount: 3,
  fusionThreshold: 3,
  respawnSeconds: 5,
  respawnUnitCount: 2,
  gemLossFraction: 0.2,
  lateUnlockSeconds: 120,
  leaderSpeed: 4.2,
  squadCatchupSpeed: 1.35,
  reconnectGraceSeconds: 30,
  regenPerSecond: 6,
  regenDelaySeconds: 4,
};

/** Gem yields per source (§1.3). Multiplied by Harvester bonus and last call. */
export const GEM_YIELD = {
  prop: 1,
  resourceNode: 4,
  creep: 2,
  creepCampBonus: 6,
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
