// Thin re-export seam for the Phase 19 Toronto landmark layer (world/types.ts's `LandmarkData`
// / `WorldData.landmarks`, Task 1's concurrent landing) — every Task 2 consumer
// (CnTower.tsx/Stadium.tsx/Flatiron.tsx, propPlacements.ts's market/critter placements) reads
// through THIS module instead of poking `world.landmarks` directly, so there is exactly one
// place documenting "optional on the type, read defensively, always populated by generate()"
// (world/types.ts's own doc comment on `LandmarkData`).

import { WORLD } from '../../config';
import { districtIdAt, type LandmarkData, type WorldData } from '../types';

export type { CnTowerLandmark, FlatironLandmark, LandmarkData, LandmarkPoint, StadiumLandmark } from '../types';

/** Defensive accessor — see file header. Undefined only for a WorldData that predates Phase
 * 19 generation (older mocks/fixtures); a real generate()'d world always has it. */
export function getLandmarks(world: WorldData): LandmarkData | undefined {
  return world.landmarks;
}

const HALF_MAP_M = (WORLD.tiles * WORLD.tileSize) / 2;

/** Which district a world-space (x,z) point falls in — the inverse of types.ts's tileCenter,
 * clamped to the map's tile grid (a landmark sitting exactly on/near the map edge still
 * resolves to a real district instead of an out-of-range index). Used to give the landmark
 * colliders' EntityEntry a real districtId (registry.ts's -1 "not districted" is reserved for
 * entities that genuinely have no spatial home, which these do). */
export function districtIdAtWorldPos(x: number, z: number): number {
  const col = Math.min(WORLD.tiles - 1, Math.max(0, Math.floor((x + HALF_MAP_M) / WORLD.tileSize)));
  const row = Math.min(WORLD.tiles - 1, Math.max(0, Math.floor((z + HALF_MAP_M) / WORLD.tileSize)));
  return districtIdAt(col, row);
}
