/**
 * The five arenas.
 *
 * Every match used to generate a fresh layout from the match seed, so no two
 * games were ever played on the same ground and there was nothing to learn.
 * Five fixed arenas give players map knowledge — where the chokepoints are,
 * which camp is worth contesting, where a chest usually sits — which is most of
 * what makes a session-based game deepen with play.
 *
 * They are stored as **seeds, not tile dumps**. The generator is already
 * written and tested, a 64x64 arena regenerates in well under a millisecond,
 * and this keeps the repo free of binary blobs. The catch is that the layouts
 * are only stable as long as the generator is: edit `scatterTerrain` and all
 * five silently become different maps. `maps.test.ts` pins a checksum of each
 * so that change fails loudly and has to be re-blessed on purpose.
 *
 * The seeds are not arbitrary. 4000 candidates were scored on interior wall
 * density, per-quadrant balance (so no spawn faces a walled-off run to the
 * centre while another has open ground), spread of path distance from each home
 * pad to the middle, and isolated-floor fraction. These five are the best
 * scoring set that are also mutually distinct — every pair differs in over 91%
 * of its rock, so they read as different places rather than reshuffles.
 */

export const MAP_IDS = ['quarry', 'crossroads', 'basin', 'thicket', 'foundry'] as const;
export type MapId = (typeof MAP_IDS)[number];

export interface ArenaDef {
  id: MapId;
  name: string;
  /** Seed fed to the terrain generator. Changing this changes the arena. */
  seed: number;
}

export const ARENAS: Record<MapId, ArenaDef> = {
  quarry: { id: 'quarry', name: 'Quarry', seed: 1910 },
  crossroads: { id: 'crossroads', name: 'Crossroads', seed: 3921 },
  basin: { id: 'basin', name: 'Basin', seed: 3741 },
  thicket: { id: 'thicket', name: 'Thicket', seed: 2488 },
  foundry: { id: 'foundry', name: 'Foundry', seed: 3501 },
};

export const DEFAULT_MAP: MapId = 'quarry';
