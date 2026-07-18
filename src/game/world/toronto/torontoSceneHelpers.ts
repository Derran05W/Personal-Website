// Pure placement math for the Phase 22 drivable Toronto dev slice (world/toronto/TorontoScene.tsx).
// No three / react here — just the map-space rectangles, signpost anchors, and the player spawn
// pose the R3F scene renders from, so the geometry can be unit-tested (every rect corner and
// every signpost inside the §1 polygon) without a live canvas. The scene component stays thin:
// it consumes these and turns them into meshes/colliders.
//
// Map convention (projection.ts): map (x, y) with y-DOWN = south; mapToWorld is the identity
// swap map(x,y) -> world[x, z] (map south = world +Z). Every rect below is therefore ALSO its
// world XZ rectangle (minX..maxX = world x, minY..maxY = world z).

import type { VehiclePose } from '../../vehicles/IVehicleModel';
import { TORONTO_SPAWN } from '../../config/torontoMap';
import { mapToWorld, type MapPoint } from './projection';
import type { MapRect } from './streets';

/** The §1 "thermometer" carved into its three drivable rectangles, in MAP space (= world XZ).
 * capsule (x1100–1900, y0–1170) → fold corridor (x1200–1800, y1170–1830) → downtown block
 * (x0–2400, y1830–3700, i.e. down to the shoreline; the water band below is sensor-only). All
 * corners lie on or inside PLAYABLE_POLYGON (asserted in the test). */
export const GROUND_RECTS: readonly MapRect[] = [
  { minX: 1100, minY: 0, maxX: 1900, maxY: 1170 }, // North York capsule
  { minX: 1200, minY: 1170, maxX: 1800, maxY: 1830 }, // midtown fold corridor
  { minX: 0, minY: 1830, maxX: 2400, maxY: 3700 }, // downtown block (to shore)
] as const;

/** The south lakefront band (§1): visual lake + a WATER-group sensor. y 3700 (shore) → 4100
 * (polygon bottom edge), full downtown width. */
export const WATER_RECT: MapRect = { minX: 0, minY: 3700, maxX: 2400, maxY: 4100 } as const;

/** A named §1 exit signpost: its display label and MAP-space anchor (just inside the polygon
 * near the edge it points off of). Placement is asserted inside PLAYABLE_POLYGON in the test. */
export interface Signpost {
  readonly id: string;
  readonly label: string;
  /** MAP x (= world x). */
  readonly x: number;
  /** MAP y (= world z). */
  readonly y: number;
}

/** The four spec §1 exits (TORONTO-MAP-SPEC-v2.md §1): capsule top, west/east downtown, east
 * lower. Positions are a hair inside the polygon so the post never straddles the void edge. */
export const SIGNPOSTS: readonly Signpost[] = [
  { id: 'steeles', label: '↑ Steeles Ave', x: 1500, y: 30 },
  { id: 'liberty', label: '← Liberty Village', x: 30, y: 2900 },
  { id: 'danforth', label: '→ The Danforth', x: 2370, y: 2450 },
  { id: 'distillery', label: '→ Distillery District', x: 2370, y: 3300 },
] as const;

/** Chassis settle height at spawn — kept in sync with world/spawn.ts's SPAWN_HEIGHT_M (0.85 m,
 * just above the raycast-suspension rest so the wheels are in ground contact from the first
 * physics step). Duplicated (not imported) only because spawn.ts keeps it module-private. */
const SPAWN_HEIGHT_M = 0.85;

/** Identity quaternion — faces world +Z, which is map +y = SOUTH (world/spawn.ts convention).
 * TORONTO_SPAWN.heading is {x:0,y:1} (map +y), so the player spawns facing south down Yonge and
 * needs no extra yaw. PlayerVehicle.create() itself always spawns at identity rotation, so this
 * matches the chassis it will actually get. */
const IDENTITY_ROTATION = { x: 0, y: 0, z: 0, w: 1 } as const;

/** The Yonge-just-south-of-Finch spawn pose (§2), MAP TORONTO_SPAWN routed through mapToWorld.
 * Same {position, rotation} shape world/spawn.ts's getSpawnPose returns, so index.tsx and the
 * spawnPoseRef teleport path consume it identically to the legacy pose. */
export const TORONTO_SPAWN_POSE: VehiclePose = (() => {
  const [wx, wz] = mapToWorld({ x: TORONTO_SPAWN.x, y: TORONTO_SPAWN.y });
  return {
    position: { x: wx, y: SPAWN_HEIGHT_M, z: wz },
    rotation: IDENTITY_ROTATION,
  };
})();

/** The four MAP-space corners of a rect (for in-polygon assertions / geometry building). */
export function rectCorners(rect: MapRect): readonly MapPoint[] {
  return [
    { x: rect.minX, y: rect.minY },
    { x: rect.maxX, y: rect.minY },
    { x: rect.maxX, y: rect.maxY },
    { x: rect.minX, y: rect.maxY },
  ];
}

/** A map rect's WORLD box: center (cx,cz) + half-extents (hx,hz). mapToWorld is the identity
 * swap, so this is a pure rename of the rect's own centre/half-size — but routed through
 * mapToWorld so the axis seam stays single-sourced. */
export function rectWorldBox(rect: MapRect): {
  cx: number;
  cz: number;
  hx: number;
  hz: number;
} {
  const [minWx, minWz] = mapToWorld({ x: rect.minX, y: rect.minY });
  const [maxWx, maxWz] = mapToWorld({ x: rect.maxX, y: rect.maxY });
  return {
    cx: (minWx + maxWx) / 2,
    cz: (minWz + maxWz) / 2,
    hx: Math.abs(maxWx - minWx) / 2,
    hz: Math.abs(maxWz - minWz) / 2,
  };
}
