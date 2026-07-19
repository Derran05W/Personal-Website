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
import { mapToWorld, scaleBaseY, ZONE_BOUNDARIES, type MapPoint } from './projection';
import { scaleAboutYonge, ZONE_X_EXTENTS } from './polygon';
import type { MapRect } from './streets';

/** The §1 "thermometer" carved into its three drivable rectangles, in MAP space (= world XZ).
 * capsule → fold corridor → downtown block (down to the shoreline; the water band below is
 * sensor-only). Extents re-derived from polygon.ts's ZONE_X_EXTENTS / projection.ts's
 * ZONE_BOUNDARIES (Part-8 D2 — never re-literalized). All corners lie on or inside
 * PLAYABLE_POLYGON (asserted in the test). */
export const GROUND_RECTS: readonly MapRect[] = [
  { minX: ZONE_X_EXTENTS.capsule[0], minY: ZONE_BOUNDARIES[0], maxX: ZONE_X_EXTENTS.capsule[1], maxY: ZONE_BOUNDARIES[1] }, // North York capsule
  { minX: ZONE_X_EXTENTS.fold[0], minY: ZONE_BOUNDARIES[1], maxX: ZONE_X_EXTENTS.fold[1], maxY: ZONE_BOUNDARIES[2] }, // midtown fold corridor
  { minX: ZONE_X_EXTENTS.downtown[0], minY: ZONE_BOUNDARIES[2], maxX: ZONE_X_EXTENTS.downtown[1], maxY: ZONE_BOUNDARIES[3] }, // downtown block (to shore)
] as const;

/** The south lakefront band (§1): visual lake + a WATER-group sensor. Shore → polygon bottom
 * edge, full downtown width. */
export const WATER_RECT: MapRect = {
  minX: ZONE_X_EXTENTS.downtown[0],
  minY: ZONE_BOUNDARIES[3],
  maxX: ZONE_X_EXTENTS.downtown[1],
  maxY: ZONE_BOUNDARIES[4],
} as const;

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
 * lower. Positions are a hair inside the polygon so the post never straddles the void edge.
 * Part-8 (D2): BASE (pre-compaction) x/y literals re-derived via scaleAboutYonge/scaleBaseY —
 * the original spec anchors (1500,30) / (30,2900) / (2370,2450) / (2370,3300), never restated
 * as fresh literals. */
export const SIGNPOSTS: readonly Signpost[] = [
  { id: 'steeles', label: '↑ Steeles Ave', x: scaleAboutYonge(1500), y: scaleBaseY(30) },
  { id: 'liberty', label: '← Liberty Village', x: scaleAboutYonge(30), y: scaleBaseY(2900) },
  { id: 'danforth', label: '→ The Danforth', x: scaleAboutYonge(2370), y: scaleBaseY(2450) },
  { id: 'distillery', label: '→ Distillery District', x: scaleAboutYonge(2370), y: scaleBaseY(3300) },
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
