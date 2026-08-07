/**
 * Battle Mods: one rule twist rolled per match.
 *
 * Gem Hunt is the only mode now, so the variety that used to come from picking
 * between four modes has to come from somewhere else. A Mod is drawn at the
 * start of every match and changes one thing about how the round plays — how
 * chests behave, what spawns, what a kill is worth.
 *
 * Same discipline as everything else in `config/`: a Mod is a **set of numbers
 * the existing systems already read**, never a branch on a Mod name. The tick
 * has a fixed step order and forking it per Mod would turn one simulation into
 * a dozen. Everything here is a multiplier, a count, or an override, and the
 * step that consults it does not know which Mod put it there.
 *
 * The design this is taken from lists roughly thirty Mods across six worlds.
 * The ones implemented are those that land on systems this game actually has.
 * Several are deliberately absent because the mechanic they twist does not
 * exist here — Spell Overload, Turbo Overload and Golden Boots need spell and
 * turbo pickups; Doppelgangers, Monster Pets and Royal Haunt need squad
 * mutation and monster recruitment; Angry Vines needs the closing ring that
 * went with Showdown. Adding any of them means building the underlying system
 * first, not adding a flag here.
 */

export const BATTLE_MOD_IDS = [
  'none',
  'doubleTrouble',
  'fusionStart',
  'gemOverload',
  'pinataParty',
  'treeGiants',
  'epicOverload',
  'oneCoinChests',
  'lootSurge',
  'superGemMine',
  'babyBattle',
  'golemMeteors',
  'crystalForest',
  'chestImposter',
  'lootGoblins',
] as const;

export type BattleModId = (typeof BATTLE_MOD_IDS)[number];

export interface BattleMod {
  id: BattleModId;
  label: string;
  /** One line, shown on the pre-match card. Must say what actually changes. */
  blurb: string;

  // ── chests ───────────────────────────────────────────────────────────────
  /** Units granted per purchase. 2 = the same pick twice. */
  chestUnitsPerBuy: number;
  /** Force every chest to a rarity, ignoring the unlock schedule. */
  forceRarity: 'common' | 'rare' | 'epic' | null;
  /** Flat coin price for any chest, ignoring squad size and rarity. */
  flatChestPrice: number | null;
  /** Chance a chest is a dud that pays nothing. */
  fakeChestChance: number;

  // ── squad ────────────────────────────────────────────────────────────────
  /** Tier the drafted starter begins at. */
  startingTier: 0 | 1 | 2;
  /** Ceiling on fusion. 0 locks everything to its base form. */
  maxTier: 0 | 1 | 2;

  // ── the map ──────────────────────────────────────────────────────────────
  /** Multipliers on what each source pays out. */
  creepGemMultiplier: number;
  lootMultiplier: number;
  /** Extra scenery beyond the map's normal population. */
  extraProps: number;
  extraTrees: number;
  /** Extra resource nodes, placed in the contested middle. */
  extraCentreNodes: number;
  /** Lone, fat, high-value monsters scattered at match start. */
  giants: number;
  /** Lone, low-HP monsters carrying a big coin payout. */
  lootGoblins: number;
  /** Seconds between meteor monsters dropping in. 0 disables. */
  meteorIntervalSeconds: number;
}

const BASE: Omit<BattleMod, 'id' | 'label' | 'blurb'> = {
  chestUnitsPerBuy: 1,
  forceRarity: null,
  flatChestPrice: null,
  fakeChestChance: 0,
  startingTier: 0,
  maxTier: 2,
  creepGemMultiplier: 1,
  lootMultiplier: 1,
  extraProps: 0,
  extraTrees: 0,
  extraCentreNodes: 0,
  giants: 0,
  lootGoblins: 0,
  meteorIntervalSeconds: 0,
};

export const BATTLE_MODS: Record<BattleModId, BattleMod> = {
  none: {
    ...BASE,
    id: 'none',
    label: 'Straight Up',
    blurb: 'No twist. Standard Gem Hunt rules.',
  },
  doubleTrouble: {
    ...BASE,
    id: 'doubleTrouble',
    label: 'Double Trouble',
    blurb: 'Every chest gives two of whatever you pick.',
    chestUnitsPerBuy: 2,
  },
  fusionStart: {
    ...BASE,
    id: 'fusionStart',
    label: 'Fusion Start',
    blurb: 'Your starting character begins already fused.',
    startingTier: 1,
  },
  gemOverload: {
    ...BASE,
    id: 'gemOverload',
    label: 'Gem Overload',
    blurb: 'Monsters drop far more gems. Fighting early pays.',
    creepGemMultiplier: 3.5,
  },
  pinataParty: {
    ...BASE,
    id: 'pinataParty',
    label: 'Piñata Party',
    blurb: 'The map is littered with extra breakables.',
    extraProps: 90,
    lootMultiplier: 1.15,
  },
  treeGiants: {
    ...BASE,
    id: 'treeGiants',
    label: 'Tree Giants',
    blurb: 'Huge, slow monsters roam. Hard to fell, worth a fortune.',
    giants: 7,
  },
  epicOverload: {
    ...BASE,
    id: 'epicOverload',
    label: 'Epic Overload',
    blurb: 'Every chest deals Epics — and charges Epic prices.',
    forceRarity: 'epic',
  },
  oneCoinChests: {
    ...BASE,
    id: 'oneCoinChests',
    label: '1-Coin Chests',
    blurb: 'Every chest costs a single coin. Squads balloon.',
    flatChestPrice: 1,
  },
  lootSurge: {
    ...BASE,
    id: 'lootSurge',
    label: 'Loot Surge',
    blurb: 'Everything on the map pays out more.',
    lootMultiplier: 1.9,
  },
  superGemMine: {
    ...BASE,
    id: 'superGemMine',
    label: 'Super Gem Mine',
    blurb: 'The middle is packed with rich ore. Go and take it.',
    extraCentreNodes: 16,
  },
  babyBattle: {
    ...BASE,
    id: 'babyBattle',
    label: 'Baby Battle',
    blurb: 'Nothing can fuse. Everyone stays in their base form.',
    maxTier: 0,
  },
  golemMeteors: {
    ...BASE,
    id: 'golemMeteors',
    label: 'Golem Meteors',
    blurb: 'Golems keep crashing down across the arena.',
    meteorIntervalSeconds: 11,
  },
  crystalForest: {
    ...BASE,
    id: 'crystalForest',
    label: 'Crystal Forest',
    blurb: 'The map is thick with trees. Bring someone who can fell them.',
    extraTrees: 34,
  },
  chestImposter: {
    ...BASE,
    id: 'chestImposter',
    label: 'Chest Imposter',
    blurb: 'Some chests are fakes. You find out after you pay.',
    fakeChestChance: 0.3,
  },
  lootGoblins: {
    ...BASE,
    id: 'lootGoblins',
    label: 'Loot Goblin Rush',
    blurb: 'Coin-stuffed goblins are loose. Run them down.',
    lootGoblins: 12,
  },
};

export const DEFAULT_BATTLE_MOD: BattleModId = 'none';

/**
 * Mods that can be rolled.
 *
 * `none` is excluded: it exists so code always has a valid Mod to read from
 * (tests, the lobby before a match, a client that has not been told yet)
 * without every consumer needing a null check, but a real match should always
 * have a twist.
 */
export const ROLLABLE_BATTLE_MODS: readonly BattleModId[] = BATTLE_MOD_IDS.filter(
  (id) => id !== 'none',
);
