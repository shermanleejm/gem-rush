/** Arena layout constants (brief §1.8). */

export const MAP = {
  /** Tiles per side. World units == tiles; 1 tile is 1 unit. */
  size: 64,
  /** Radius from centre, in tiles, of each concentric zone. */
  zoneRadii: [10, 20, 30] as const,
  /**
   * Breakables are deliberately dense.
   *
   * You now start with a single unit, and a lone unit only lands a hit when the
   * squad happens to pass within about 1.5 tiles of something. On a sparse map
   * that meant a four-minute match where one crate got broken and nobody could
   * afford a chest — the economy never cold-started at all. A busy arena is
   * what makes the opening minute productive with one unit.
   */
  props: 110,
  resourceNodes: 22,
  /** Farmable clusters. Only the matching Supplier can work them. */
  trees: 14,
  fields: 12,
  farmRespawnSeconds: 30,
  /** Fraction of the interior painted as tall grass. */
  grassDensity: 0.14,
  resourceRespawnSeconds: 25,
  creepCamps: 6,
  creepsPerCamp: 4,
  creepCampRespawnSeconds: 45,
  chestSpawns: 42,
  /**
   * Target fraction of the *interior* that is impassable rock.
   *
   * This used to be a scaling factor on a cluster count, which was misleading:
   * it read as a density but produced about 1.4% actual cover, so every arena
   * was a near-empty field with a wall around it and terrain never created the
   * chokepoints §1.8 asks for. It is now the real target and the generator
   * derives a cluster count from it. Interior only — the solid border is
   * structural and would otherwise account for most of the "density".
   */
  terrainDensity: 0.13,
  /** Home pads sit this far from the centre, on the rim. */
  homePadRadius: 28,
} as const;

export type TileKind = 0 | 1 | 2;
export const TILE_FLOOR: TileKind = 0;
export const TILE_WALL: TileKind = 1;
/**
 * Tall grass. Walkable, but it drags — see `GRASS_SPEED_MULT`.
 *
 * The point is to make the shortest line across the arena not always the
 * fastest one, so the terrain influences routing without blocking it. A wall
 * says "no"; grass says "are you sure?".
 */
export const TILE_GRASS: TileKind = 2;

/** Movement multiplier for anything standing in tall grass. */
export const GRASS_SPEED_MULT = 0.72;

/** Zone index 0 is the contested centre; higher is safer and lower-yield. */
export function zoneAt(x: number, y: number): number {
  const cx = MAP.size / 2;
  const cy = MAP.size / 2;
  const d = Math.hypot(x - cx, y - cy);
  for (let i = 0; i < MAP.zoneRadii.length; i++) {
    if (d <= MAP.zoneRadii[i]!) return i;
  }
  return MAP.zoneRadii.length;
}

/** Richer toward the middle — this is the pull that makes the centre contested. */
export function zoneYieldMultiplier(zone: number): number {
  switch (zone) {
    case 0:
      // The middle pays roughly double the rim. Pushing it higher was tried and
      // did not help: it lifts everyone who visits the centre, including the
      // rim-farmer who dips in once, so the *relative* incentive barely moves.
      return 2.4;
    case 1:
      return 1.7;
    case 2:
      return 1.25;
    default:
      return 1.0;
  }
}
