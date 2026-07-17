// Flatiron landmark (Phase 19 Task 2; TDD §13). A triangular wedge building on an orthogonal
// arterial corner (phase-19-plan.md: "no angled street — stretch cut") — a true 3-sided prism
// (world/geometry/landmarks.ts's buildFlatironGeometry, convex by construction), alternating
// wall/window-tone bands. Standalone mount, same contract as CnTower.tsx/Stadium.tsx: reads
// `world.landmarks?.flatiron` ({x,z,rot}) defensively, renders nothing when absent.
//
// fog:false landmark material + castShadow={false}, same rationale as the other two.
// Collider: two overlapping cuboids 60 degrees apart approximating the triangular footprint
// (CLAUDE.md's convex-primitives-only rule rules out a literal triangular-prism collider; the
// phase-19 plan's explicit fallback), pure math in landmarksColliders.ts's
// flatironColliderBoxes.

import { useEffect, useMemo } from 'react';
import { RigidBody } from '@react-three/rapier';
import { interactionGroups } from '../../config';
import { buildFlatironGeometry } from '../geometry/landmarks';
import { getLandmarkMaterial } from './landmarkMaterial';
import { districtIdAtWorldPos, getLandmarks } from './landmarksData';
import { flatironColliderBoxes } from './landmarksColliders';
import { RegisteredCuboidCollider } from './registeredCollider';
import type { EntityEntry } from '../registry';
import type { WorldData } from '../types';

const BUILDING_GROUPS = interactionGroups('BUILDING');

export interface FlatironProps {
  readonly world: WorldData;
}

export function Flatiron({ world }: FlatironProps) {
  const point = getLandmarks(world)?.flatiron;

  const geometry = useMemo(() => buildFlatironGeometry(), []);
  useEffect(() => () => geometry.dispose(), [geometry]);
  const material = useMemo(() => getLandmarkMaterial(), []);

  if (!point) return null;

  const districtId = districtIdAtWorldPos(point.x, point.z);
  const boxes = flatironColliderBoxes(point);

  return (
    <>
      <mesh
        geometry={geometry}
        material={material}
        position={[point.x, 0, point.z]}
        rotation={[0, point.rot, 0]}
        castShadow={false}
        receiveShadow={false}
      />
      <RigidBody type="fixed" colliders={false} collisionGroups={BUILDING_GROUPS}>
        {boxes.map((box, i) => {
          const entry: EntityEntry = { kind: 'building', districtId };
          return (
            <RegisteredCuboidCollider
              key={i}
              entry={entry}
              halfExtents={box.halfExtents}
              position={[box.x, box.y, box.z]}
              rotationY={box.rotationY}
            />
          );
        })}
      </RigidBody>
    </>
  );
}
