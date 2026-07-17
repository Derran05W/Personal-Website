// Stadium landmark (Phase 19 Task 2; TDD §13). A low elliptical bowl beside the CN Tower — a
// squat, hollow cylinder shell + flared rim (world/geometry/landmarks.ts's
// buildStadiumGeometry, <=800 tris). Standalone mount, same contract as CnTower.tsx: reads
// `world.landmarks?.stadium` defensively, renders nothing when absent, mounted by the
// phase-19 orchestrator as a sibling inside the same <Physics> tree.
//
// fog:false landmark material (see landmarkMaterial.ts) + castShadow={false} everywhere, same
// rationale as CnTower.tsx. Collider: a ring of 8 tangential cuboids approximating the outer
// wall (CLAUDE.md's convex-primitives-only rule — no round collider shape is in the sanctioned
// set), pure math in landmarksColliders.ts's stadiumColliderSegments.

import { useEffect, useMemo } from 'react';
import { RigidBody } from '@react-three/rapier';
import { interactionGroups } from '../../config';
import { buildStadiumGeometry } from '../geometry/landmarks';
import { getLandmarkMaterial } from './landmarkMaterial';
import { districtIdAtWorldPos, getLandmarks } from './landmarksData';
import { stadiumColliderSegments } from './landmarksColliders';
import { RegisteredCuboidCollider } from './registeredCollider';
import type { EntityEntry } from '../registry';
import type { WorldData } from '../types';

const BUILDING_GROUPS = interactionGroups('BUILDING');

export interface StadiumProps {
  readonly world: WorldData;
}

export function Stadium({ world }: StadiumProps) {
  const point = getLandmarks(world)?.stadium;

  // Parametric by the reserved lot's own footprint (see buildStadiumGeometry's header) — the
  // 4x4 fallback below is never rendered (the `!point` guard skips the return below) and only
  // keeps this hook call unconditional, per React's rules-of-hooks.
  const geometry = useMemo(() => buildStadiumGeometry(point?.w ?? 4, point?.h ?? 4), [point?.w, point?.h]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  const material = useMemo(() => getLandmarkMaterial(), []);

  if (!point) return null;

  const districtId = districtIdAtWorldPos(point.x, point.z);
  const segments = stadiumColliderSegments(point);

  return (
    <>
      <mesh geometry={geometry} material={material} position={[point.x, 0, point.z]} castShadow={false} receiveShadow={false} />
      <RigidBody type="fixed" colliders={false} collisionGroups={BUILDING_GROUPS}>
        {segments.map((seg, i) => {
          const entry: EntityEntry = { kind: 'building', districtId };
          return (
            <RegisteredCuboidCollider
              key={i}
              entry={entry}
              halfExtents={seg.halfExtents}
              position={[seg.x, seg.y, seg.z]}
              rotationY={seg.rotationY}
            />
          );
        })}
      </RigidBody>
    </>
  );
}
