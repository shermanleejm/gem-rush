/**
 * The arenas.
 *
 * These are the twenty-two Squad Busters Gem Hunt maps, transcribed tile for
 * tile from the published map art rather than generated. They used to be five
 * terrain seeds: the generator was tuned until its output scored well on
 * density and quadrant balance, which produced arenas that were *fair* but not
 * *places* — no map had a shape you could learn, because none of them had been
 * designed, only sampled.
 *
 * The layouts live in `arenaData.ts`, written by `tools/import-maps.py`. That
 * file is generated, so the id list below is the hand-kept half of the pair;
 * `maps.test.ts` fails if the two ever drift.
 */

import { ARENA_DATA, type ArenaPalette } from './arenaData.ts';

export const MAP_IDS = [
  'arcadealley',
  'boilerroom',
  'bustervalley',
  'dustybadlands',
  'emeraldgrove',
  'frozenmarsh',
  'greenhillzone',
  'hauntedgarden',
  'invasionisland',
  'lavaspa',
  'midnightmortuary',
  'pekkasplayground',
  'provinggrounds',
  'rowdyrink',
  'royalrumbleyard',
  'scavengersshore',
  'steelgauntlet',
  'thesandpit',
  'troublesomegulch',
  'twistingtrails',
  'waterwayblitz',
  'yetipeak',
] as const;
export type MapId = (typeof MAP_IDS)[number];

export interface ArenaDef {
  id: MapId;
  name: string;
  /** Which Squad Busters world it comes from. */
  world: string;
  /** Colours lifted from the arena's own art, so each world looks like itself. */
  palette: ArenaPalette;
}

export const ARENAS: Record<MapId, ArenaDef> = Object.fromEntries(
  ARENA_DATA.map((a) => [
    a.id,
    { id: a.id as MapId, name: a.name, world: a.world, palette: a.palette },
  ]),
) as Record<MapId, ArenaDef>;

export const DEFAULT_MAP: MapId = 'bustervalley';
