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

const PROP_DYNAMIC_GROUPS = interactionGroups('PROP_DYNAMIC');

/** The minimal shape this renderer needs — ParkedVehicle (furniture.ts) and Phase 28's
 * DynamicConeSpec (infill.ts, lane-closure cones) both satisfy this structurally. */
export interface DynamicPlacement {
  readonly modelId: string;
  readonly position: readonly [number, number, number];
  readonly rotationY: number;
}

export interface DynamicBodySpec {
  readonly massKg: number;
  readonly linearDamping: number;
  readonly angularDamping: number;
}

/** All dynamic instances of ONE model id — one shared baked geometry + one shared unlit material
 * across every body. Suspends until the GLB streams. */
function ParkedModelGroup({ id, cars, unlit, body }: { id: string; cars: readonly DynamicPlacement[]; unlit: boolean; body: DynamicBodySpec }) {
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
          linearDamping={body.linearDamping}
          angularDamping={body.angularDamping}
          collisionGroups={PROP_DYNAMIC_GROUPS}
        >
          {/* Cuboid centred on the body origin (= geometric centre at rest → COM ≈ centre). */}
          <CuboidCollider args={[half.hx, half.hy, half.hz]} mass={body.massKg} />
          {/* Mesh floor lands on the ground at rest: body origin sits at hy, the model floor is
              `lift` above the model origin, so the mesh drops by (hy − lift). */}
          <mesh geometry={geometry} material={renderMaterial} position={[0, lift - half.hy, 0]} scale={scale} />
        </RigidBody>
      ))}
    </>
  );
}

export interface ParkedVehiclesProps {
  readonly parked: readonly DynamicPlacement[];
  readonly unlit: boolean;
  /** Rigid-body spec (mass/damping) — defaults to PARKED.body (street-parked cars). Phase 28
   * reuses this SAME component for lane-closure cones with LANE_CLOSURE.coneBody instead of
   * inventing a parallel dynamic-body renderer. */
  readonly body?: DynamicBodySpec;
}

/** Mounts every dynamic instance, grouped by model id so each model's geometry/material load once.
 * The grouping keys are seed-stable (furniture.ts/infill.ts are deterministic), so React's hook
 * order per ParkedModelGroup is stable. */
export function ParkedVehicles({ parked, unlit, body = PARKED.body }: ParkedVehiclesProps) {
  const byModel = new Map<string, DynamicPlacement[]>();
  for (const car of parked) (byModel.get(car.modelId) ?? byModel.set(car.modelId, []).get(car.modelId)!).push(car);
  const ids = [...byModel.keys()].sort();

  return (
    <Suspense fallback={null}>
      {ids.map((id) => (
        <ParkedModelGroup key={id} id={id} cars={byModel.get(id)!} unlit={unlit} body={body} />
      ))}
    </Suspense>
  );
}
