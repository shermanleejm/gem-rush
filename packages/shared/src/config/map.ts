/** Arena layout constants (brief §1.8). */

export const MAP = {
  /** Tiles per side. World units == tiles; 1 tile is 1 unit. */
  size: 64,
  /** Radius from centre, in tiles, of each concentric zone. */
  zoneRadii: [10, 20, 30] as const,
  props: 40,
  resourceNodes: 12,
  resourceRespawnSeconds: 25,
  creepCamps: 6,
  creepsPerCamp: 4,
  creepCampRespawnSeconds: 45,
  chestSpawns: 10,
  /** Fraction of non-zone tiles turned into impassable terrain. */
  terrainDensity: 0.06,
  /** Home pads sit this far from the centre, on the rim. */
  homePadRadius: 28,
} as const;

export type TileKind = 0 | 1;
export const TILE_FLOOR: TileKind = 0;
export const TILE_WALL: TileKind = 1;

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
      return 2.0;
    case 1:
      return 1.5;
    case 2:
      return 1.2;
    default:
      return 1.0;
  }
}
