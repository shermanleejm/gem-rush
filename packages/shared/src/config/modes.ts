/**
 * The game mode.
 *
 * Gem Hunt only, and the structure is kept even though there is exactly one
 * entry: the sim reads mode *flags* rather than branching on a mode name, so
 * the tick's fixed step order stays a single code path. Adding a second mode
 * later is a data entry plus whatever new flag it needs, not a fork of the
 * simulation.
 *
 * Duo Gem Hunt, Showdown and Hatchling Run were built and then removed, along
 * with everything that only served them — pooled team scores, the closing ring,
 * rescue collectibles, PvE targeting. They are in the history if they are ever
 * wanted back; carrying unreachable flags for them here would just be four
 * lies about what the sim does.
 */

export const GAME_MODE_IDS = ['gemHunt'] as const;
export type GameModeId = (typeof GAME_MODE_IDS)[number];

export interface GameMode {
  id: GameModeId;
  label: string;
  /** One line shown on the loading card and in the HUD. */
  tagline: string;
  /** Longer objective text for the pre-match card. */
  objective: string;
  matchSeconds: number;
  lastCallSeconds: number;
  /** Multiplier on every gem and coin source, for pacing. */
  economyScale: number;
}

export const GAME_MODES: Record<GameModeId, GameMode> = {
  gemHunt: {
    id: 'gemHunt',
    label: 'Gem Hunt',
    tagline: 'Most gems in four minutes wins',
    objective:
      'Smash crates, clear camps and bust rival squads. Lose your whole squad and you are out with whatever you were holding. Most gems when the clock stops wins.',
    matchSeconds: 240,
    lastCallSeconds: 30,
    economyScale: 1,
  },
};

export const DEFAULT_MODE: GameModeId = 'gemHunt';

/**
 * Modes playable at this headcount.
 *
 * Everything is legal at every size right now, so this always returns Gem Hunt.
 * It stays because the caller picks at random from whatever it returns, and
 * that is the seam a second mode would slot into.
 */
export function eligibleModes(playerCount: number): GameModeId[] {
  void playerCount;
  return [...GAME_MODE_IDS];
}
