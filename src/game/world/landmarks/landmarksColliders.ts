// Pure collider-placement math for the Phase 19 landmark colliders — split out of the .tsx
// components (world/landmarks/Stadium.tsx, Flatiron.tsx) so it's directly unit-testable with
// no React/Rapier mounting required, mirroring world/worldCollidersLogic.ts's split from
// world/CityColliders.tsx.
//
// CN Tower needs no pure helper here: its collider is one CylinderCollider whose
// radius/halfHeight/position fall straight out of PROP_DIMS.cnTower + the landmark's own
// (x,z) — see CnTower.tsx.

import { PROP_DIMS } from '../../config';
import { stadiumRadii } from '../geometry/landmarks';
import type { FlatironLandmark, StadiumLandmark } from './landmarksData';

export interface RingColliderSegment {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly rotationY: number;
  readonly halfExtents: readonly [number, number, number];
}

// A ring of 8 tangential cuboids approximating the stadium's round outer wall (CLAUDE.md's
// convex-primitives-only rule — cuboids only, no round collider shape). Slightly overlapped
// (OVERLAP_FACTOR > 1) so consecutive segments' corners don't leave a gap a car could clip
// through at the seams.
const STADIUM_COLLIDER_SEGMENTS = 8;
const OVERLAP_FACTOR = 1.08;
const STADIUM_WALL_THICKNESS_M = 1.5;

/**
 * 8 tangential cuboid colliders around the stadium's outer wall shell, at the wall's own
 * radius/height (not the podium or the flared rim) — `stadiumRadii(center.w, center.h)`
 * (world/geometry/landmarks.ts) is the SAME derivation buildStadiumGeometry uses, so the
 * collider ring can never disagree with the rendered shell (mirrors worldCollidersLogic.ts's
 * buildingColliderBox/bucketHeightM contract). Segment angle `i * (2*PI / 8)` matches
 * kit.ts's addPrismFrustum ring convention EXACTLY (`ringAt`: x = r*sin(a), z = r*cos(a)),
 * and `rotationY = angle` orients each cuboid's local +X (its LENGTH axis) tangent to the
 * circle at that point — the same "local +X -> world (cos(rotationY), 0, -sin(rotationY))"
 * yaw convention world/propPlacements.ts's fenceSegment ring already relies on.
 */
export function stadiumColliderSegments(center: StadiumLandmark): readonly RingColliderSegment[] {
  const d = PROP_DIMS.stadium;
  const { wallRadiusM: radius } = stadiumRadii(center.w, center.h);
  const halfLen = ((2 * Math.PI * radius) / STADIUM_COLLIDER_SEGMENTS / 2) * OVERLAP_FACTOR;
  const y = d.podiumHeightM + d.wallHeightM / 2;
  const out: RingColliderSegment[] = [];
  for (let i = 0; i < STADIUM_COLLIDER_SEGMENTS; i++) {
    const a = i * ((2 * Math.PI) / STADIUM_COLLIDER_SEGMENTS);
    out.push({
      x: center.x + radius * Math.sin(a),
      y,
      z: center.z + radius * Math.cos(a),
      rotationY: a,
      halfExtents: [halfLen, d.wallHeightM / 2, STADIUM_WALL_THICKNESS_M / 2],
    });
  }
  return out;
}

/**
 * Two overlapping cuboids, 60 degrees apart, approximating the flatiron's triangular
 * footprint (CLAUDE.md's convex-primitives-only rule rules out a literal triangular-prism
 * collider; the phase-19 plan's explicit fallback is "two overlapping rotated cuboids").
 * Both centered on the wedge's own (x,z), oriented off the placement's `rot`.
 */
export function flatironColliderBoxes(center: FlatironLandmark): readonly RingColliderSegment[] {
  const d = PROP_DIMS.flatiron;
  const y = d.heightM / 2;
  const halfExtents: readonly [number, number, number] = [d.colliderHalfLengthM, d.heightM / 2, d.colliderHalfThicknessM];
  return [
    { x: center.x, y, z: center.z, rotationY: center.rot, halfExtents },
    { x: center.x, y, z: center.z, rotationY: center.rot + Math.PI / 3, halfExtents },
  ];
}
