// Phase 25.6 (D12/D18) — parked pack vehicles as SLEEPING DYNAMIC bodies. Each parked car is a
// real Rapier dynamic body (canSleep, damped, PROP_DYNAMIC group) that SHOVES and scatters when
// the player rams it — plain physics, ZERO event/registry/scoring wiring this phase (the slice has
// no contact spine; that's the Part-8 parity flip's job). Sleeping bodies don't count against the
// active-body budget and wake only locally on contact.
//
// RENDERING: rather than a BatchedMesh synced from body poses every frame (D13's static path can't
// help a moving body), each car wears an individual <mesh> that shares its model's baked geometry +
// unlit material. Those per-car meshes are `frustumCulled` (three's default), so the ~188 off-
// screen parked cars cull to zero triangles and only the ~dozen actually in view draw — the same
// visible-only tri envelope the BatchedMesh path gives the static filler, without the sync cost.
// Draw calls scale with VISIBLE cars (~a dozen at the §5.3 camera), well within budget.

import { Suspense, useEffect, useMemo } from 'react';
import { CuboidCollider, RigidBody } from '@react-three/rapier';
import { interactionGroups } from '../../../config';
import { colliderHalfExtents } from '../../../config/cityPackScale';
import { PARKED } from '../../../config/torontoDress';
import { toUnlit } from '../../../assets/cityPack';
import { useBakedCityPackModel } from './cityPackBaked';
import type { ParkedVehicle } from '../furniture';

const PROP_DYNAMIC_GROUPS = interactionGroups('PROP_DYNAMIC');

/** All parked cars of ONE model id — one shared baked geometry + one shared unlit material across
 * every body. Suspends until the GLB streams. */
function ParkedModelGroup({ id, cars, unlit }: { id: string; cars: readonly ParkedVehicle[]; unlit: boolean }) {
  const { geometry, scale, lift, material } = useBakedCityPackModel(id);
  const renderMaterial = useMemo(() => (unlit ? toUnlit(material) : material), [material, unlit]);
  useEffect(() => () => { if (renderMaterial !== material) renderMaterial.dispose(); }, [renderMaterial, material]);
  const half = colliderHalfExtents(id);

  return (
    <>
      {cars.map((car, i) => (
        <RigidBody
          key={i}
          type="dynamic"
          colliders={false}
          canSleep
          position={[car.position[0], half.hy, car.position[2]]}
          rotation={[0, car.rotationY, 0]}
          linearDamping={PARKED.body.linearDamping}
          angularDamping={PARKED.body.angularDamping}
          collisionGroups={PROP_DYNAMIC_GROUPS}
        >
          {/* Cuboid centred on the body origin (= geometric centre at rest → COM ≈ centre). */}
          <CuboidCollider args={[half.hx, half.hy, half.hz]} mass={PARKED.body.massKg} />
          {/* Mesh floor lands on the ground at rest: body origin sits at hy, the model floor is
              `lift` above the model origin, so the mesh drops by (hy − lift). */}
          <mesh geometry={geometry} material={renderMaterial} position={[0, lift - half.hy, 0]} scale={scale} />
        </RigidBody>
      ))}
    </>
  );
}

export interface ParkedVehiclesProps {
  readonly parked: readonly ParkedVehicle[];
  readonly unlit: boolean;
}

/** Mounts every parked car, grouped by model id so each model's geometry/material load once. The
 * grouping keys are seed-stable (furniture.ts is deterministic), so React's hook order per
 * ParkedModelGroup is stable. */
export function ParkedVehicles({ parked, unlit }: ParkedVehiclesProps) {
  const byModel = new Map<string, ParkedVehicle[]>();
  for (const car of parked) (byModel.get(car.modelId) ?? byModel.set(car.modelId, []).get(car.modelId)!).push(car);
  const ids = [...byModel.keys()].sort();

  return (
    <Suspense fallback={null}>
      {ids.map((id) => (
        <ParkedModelGroup key={id} id={id} cars={byModel.get(id)!} unlit={unlit} />
      ))}
    </Suspense>
  );
}
