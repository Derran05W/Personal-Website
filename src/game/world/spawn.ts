// Deterministic player spawn point (Phase 4 Task 3; road-aligned facing added at Phase 5
// integration). getSpawnPose() picks the road tile nearest the map's center and returns a
// pose sitting on it, FACING ALONG the road — buildings have colliders from Phase 5 on,
// so spawning nose-first into the wall across the street would make the first W press a
// crash. Consumed by game/index.tsx (PlayerVehicle's spawn position) and
// core/debugBridge.ts (the dev reset default).

import type { VehiclePose } from '../vehicles/IVehicleModel';
import { WORLD } from '../config';
import { tileCenter, tileIndex, type WorldData } from './types';

const IDENTITY_ROTATION = { x: 0, y: 0, z: 0, w: 1 } as const; // faces +Z (south)
// Quaternion for a +90-degree yaw about +Y: forward becomes +X (east). Used when the
// spawn road runs east-west. (sin 45, cos 45 halves — axis-angle about Y.)
const FACE_EAST_ROTATION = { x: 0, y: 0.7071067811865476, z: 0, w: 0.7071067811865476 } as const;
// Just above the measured suspension settle height (~0.837 m): the wheel rays are in
// ground contact from the very first physics step, so even a stalled first frame's
// catch-up burst (see BOUNDARY.fellOutResetY) can't drop the chassis past the ray reach.
// Spawning a full meter up — the old TestPlane default — left a ~0.2 m airborne window
// that a 30-step burst could blow straight through.
const SPAWN_HEIGHT_M = 0.85;

type IsRoadAt = (col: number, row: number) => boolean;

/** Pose at a tile, yawed to face along the local road: east if the east/west neighbours
 * are road (east-west street), otherwise south (north-south street / intersection —
 * either axis is drivable there, and south keeps the old default). */
function poseAt(col: number, row: number, isRoadAt: IsRoadAt): VehiclePose {
  const { x, z } = tileCenter(col, row);
  const eastWest = isRoadAt(col + 1, row) || isRoadAt(col - 1, row);
  const northSouth = isRoadAt(col, row + 1) || isRoadAt(col, row - 1);
  const rotation = eastWest && !northSouth ? FACE_EAST_ROTATION : IDENTITY_ROTATION;
  return { position: { x, y: SPAWN_HEIGHT_M, z }, rotation };
}

/**
 * The tile (col,row) of the road tile nearest the map's center, found by an expanding
 * square-ring (Chebyshev) search outward from the center tile. Deterministic scan order
 * within each ring (top row left→right, then sides top→bottom, then bottom row left→right)
 * makes the chosen tile reproducible — the road skeleton never changes between calls for a
 * seed. `isRoadAt` is supplied by the caller (out-of-bounds must return false), so this is
 * pure and reusable: getSpawnPose() passes a WorldData-backed predicate, and world/generate.ts
 * reuses it (over its in-flight `type` array) to compute the spawn district WITHOUT
 * duplicating this search — the two can never drift.
 */
export function findSpawnTile(
  isRoadAt: (col: number, row: number) => boolean,
): { col: number; row: number } {
  const n = WORLD.tiles;
  const centerCol = Math.floor((n - 1) / 2);
  const centerRow = Math.floor((n - 1) / 2);

  if (isRoadAt(centerCol, centerRow)) return { col: centerCol, row: centerRow };

  for (let radius = 1; radius < n; radius++) {
    const top = centerRow - radius;
    const bottom = centerRow + radius;
    const left = centerCol - radius;
    const right = centerCol + radius;

    for (let col = left; col <= right; col++) {
      if (isRoadAt(col, top)) return { col, row: top };
    }
    for (let row = top + 1; row < bottom; row++) {
      if (isRoadAt(left, row)) return { col: left, row };
      if (isRoadAt(right, row)) return { col: right, row };
    }
    for (let col = left; col <= right; col++) {
      if (isRoadAt(col, bottom)) return { col, row: bottom };
    }
  }

  // Unreachable given the generator's guaranteed ring road (world/generate.ts always
  // stamps col/row 0 and N-1 as road), but a defensive throw beats silently returning a
  // bogus tile if that invariant is ever broken.
  throw new Error('findSpawnTile: no road tiles');
}

/** The player's spawn pose: sitting on the center-nearest road tile (see findSpawnTile),
 * yawed to face along the local road. */
export function getSpawnPose(world: WorldData): VehiclePose {
  const n = WORLD.tiles;
  const isRoadAt = (col: number, row: number): boolean => {
    if (col < 0 || row < 0 || col >= n || row >= n) return false;
    return world.tiles[tileIndex(col, row)].type === 'road';
  };
  const { col, row } = findSpawnTile(isRoadAt);
  return poseAt(col, row, isRoadAt);
}

/** Module-scope handle to the current run's spawn pose, mirroring vehicles/playerRef.ts's
 * pattern: debug tooling (dev reset, future respawn-after-BUSTED) needs a whole-object
 * read outside React's props tree. Set by the city root (world/CityScape.tsx) once
 * `getSpawnPose()` resolves for the current WorldData; reassigned wholesale on every
 * regenerate, never mutated in place. Initialized to the old TestPlane-era default
 * ({0,1,0}, identity) so early readers (before the first world generates) get a sane pose
 * instead of undefined. */
export const spawnPoseRef: { current: VehiclePose } = {
  current: { position: { x: 0, y: SPAWN_HEIGHT_M, z: 0 }, rotation: IDENTITY_ROTATION },
};
