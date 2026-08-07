/**
 * Game modes.
 *
 * One mode is drawn at random at the start of every match, so the roster and
 * the map have to hold up under all of them. They are expressed as data the
 * sim reads — not as branches on a mode name — for the same reason unit
 * abilities are: the tick already has a fixed ten-step order, and adding
 * `if (mode === 'showdown')` to each step would fork the simulation into four
 * subtly different simulations that all have to be debugged separately.
 *
 * Instead each mode sets flags that existing steps consult:
 *
 *   - `timed` / `matchSeconds`   -> the phase clock
 *   - `winBy`                    -> how standings are sorted and when it ends
 *   - `teamSize`                 -> how players are grouped and scores pooled
 *   - `elimination`              -> whether a wiped squad is out for good
 *   - `ring`                     -> whether a closing boundary damages stragglers
 *   - `collectibles`             -> whether rescue objectives spawn
 *   - `pve`                      -> whether squads can damage each other at all
 *
 * The four here are the pre-Heroes modes. The ranked variant of the default is
 * deliberately absent: it is the same rules against a trophy ladder, and there
 * is no persistent account in this game for a ladder to live on.
 */

export const GAME_MODE_IDS = ['gemHunt', 'duoGemHunt', 'showdown', 'hatchlingRun'] as const;
export type GameModeId = (typeof GAME_MODE_IDS)[number];

/** What decides the winner. */
export type WinCondition =
  /** Most gems banked when the clock runs out. */
  | 'gems'
  /** Last squad alive; no clock. */
  | 'survival'
  /** Most collectibles recovered before the clock runs out. */
  | 'collect';

export interface GameMode {
  id: GameModeId;
  label: string;
  /** One line shown on the loading card and in the HUD. */
  tagline: string;
  /** Longer objective text for the pre-match card. */
  objective: string;
  winBy: WinCondition;
  /** False for modes that run until a winner emerges. */
  timed: boolean;
  matchSeconds: number;
  lastCallSeconds: number;
  /** 1 = free-for-all. 2 = duos: pairs share a score and a colour. */
  teamSize: number;
  /** Wiped squads are eliminated instead of respawning. */
  elimination: boolean;
  /** A boundary closes in, damaging anything outside it. */
  ring: boolean;
  /** Seconds before the ring starts closing, and how long it takes to finish. */
  ringDelaySeconds: number;
  ringCloseSeconds: number;
  /** Damage per second taken outside the ring. */
  ringDamagePerSecond: number;
  /** Number of rescue collectibles to scatter, 0 for none. */
  collectibles: number;
  /** Squads cannot damage each other; the map is the opponent. */
  pve: boolean;
  /** Multiplier on gems from every source, to keep pacing even across modes. */
  economyScale: number;
}

const BASE: Omit<GameMode, 'id' | 'label' | 'tagline' | 'objective'> = {
  winBy: 'gems',
  timed: true,
  matchSeconds: 240,
  lastCallSeconds: 30,
  teamSize: 1,
  elimination: false,
  ring: false,
  ringDelaySeconds: 0,
  ringCloseSeconds: 0,
  ringDamagePerSecond: 0,
  collectibles: 0,
  pve: false,
  economyScale: 1,
};

export const GAME_MODES: Record<GameModeId, GameMode> = {
  gemHunt: {
    ...BASE,
    id: 'gemHunt',
    label: 'Gem Hunt',
    tagline: 'Most gems in four minutes wins',
    objective:
      'Smash props, clear camps and bust rival squads. Lose your whole squad and you are out with whatever you were holding. Most gems when the clock stops wins.',
    // Losing your squad ends your run. Respawning made a wipe cost five idle
    // seconds and two free units, so being busted was an inconvenience rather
    // than the thing the whole PvP layer is for.
    elimination: true,
  },

  duoGemHunt: {
    ...BASE,
    id: 'duoGemHunt',
    label: 'Duo Gem Hunt',
    tagline: 'Pairs share one gem count',
    objective:
      'Same hunt, but you are in a pair. Your gems and your partner’s go into one pot, and you are only out when both of you are.',
    teamSize: 2,
    // Deliberately *not* elimination: a busted partner rebuilds and rejoins,
    // and the pair is only finished when both are down. That is what makes
    // duos a different game rather than solo with a shared scoreboard.
    elimination: false,
  },

  showdown: {
    ...BASE,
    id: 'showdown',
    label: 'Showdown',
    tagline: 'Last squad standing',
    objective:
      'No clock and no respawns. Grow your squad, bust everyone else, and stay inside the closing ring.',
    winBy: 'survival',
    timed: false,
    // A generous ceiling rather than a real timer: a stalemate between two
    // turtling squads still has to end, and the ring will normally decide it
    // long before this.
    matchSeconds: 420,
    lastCallSeconds: 0,
    elimination: true,
    ring: true,
    ringDelaySeconds: 45,
    ringCloseSeconds: 210,
    ringDamagePerSecond: 14,
    // Nothing is banked for score here, so gems are purely squad-building
    // currency. Paying out faster keeps squads growing without a scoring clock.
    economyScale: 1.35,
  },

  hatchlingRun: {
    ...BASE,
    id: 'hatchlingRun',
    label: 'Hatchling Run',
    tagline: 'Rescue the hatchlings together',
    objective:
      'No rivals — just the map. Fight through the camps and carry every stray hatchling home before time runs out.',
    winBy: 'collect',
    matchSeconds: 210,
    lastCallSeconds: 20,
    collectibles: 14,
    pve: true,
    economyScale: 1.2,
  },
};

export const DEFAULT_MODE: GameModeId = 'gemHunt';

/**
 * Which modes can actually run with this many players.
 *
 * Duos need an even count of at least four, or one player is left partnerless
 * and the pooled-score rule silently becomes a free-for-all with extra steps.
 * Showdown needs a crowd to be worth the name. Everything else is always legal,
 * which guarantees this never returns an empty list.
 */
export function eligibleModes(playerCount: number): GameModeId[] {
  return GAME_MODE_IDS.filter((id) => {
    const mode = GAME_MODES[id];
    if (mode.teamSize > 1) return playerCount >= 4 && playerCount % mode.teamSize === 0;
    if (id === 'showdown') return playerCount >= 3;
    return true;
  });
}
