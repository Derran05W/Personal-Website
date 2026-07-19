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
import { RigidBody } from '@react-three/rapier';
import { Color, type Material } from 'three';
import { interactionGroups } from '../../../config';
import { colliderHalfExtents } from '../../../config/cityPackScale';
import { PARKED } from '../../../config/torontoDress';
import type { DistrictId } from '../../../config/torontoDistricts';
import { toUnlit } from '../../../assets/cityPack';
import { RegisteredCuboidCollider } from '../../landmarks/registeredCollider';
import { torontoConeEntry, torontoParkedCarEntry } from '../torontoColliders';
import { useBakedCityPackModel } from './cityPackBaked';

const PROP_DYNAMIC_GROUPS = interactionGroups('PROP_DYNAMIC');

/** The minimal shape this renderer needs — ParkedVehicle (furniture.ts) and Phase 28's
 * DynamicConeSpec (infill.ts, lane-closure cones) both satisfy this structurally.
 * `districtId` is optional (Phase 29): ParkedVehicle carries one, DynamicConeSpec does not —
 * see torontoColliders.ts's torontoParkedCarEntry/torontoConeEntry for how each is registered. */
export interface DynamicPlacement {
  readonly modelId: string;
  readonly position: readonly [number, number, number];
  readonly rotationY: number;
  readonly districtId?: DistrictId;
  /** Phase 29 (D4): per-car carVariety body colour (sRGB hex). When set, this car wears a cloned
   * material with `.color` = tint (multiplied over the neutral-body map → a true body colour).
   * Absent for cones (they share the untinted group material). */
  readonly tint?: string;
}

export interface DynamicBodySpec {
  readonly massKg: number;
  readonly linearDamping: number;
  readonly angularDamping: number;
}

/** All dynamic instances of ONE model id — one shared baked geometry + one shared unlit material
 * across every body. Suspends until the GLB streams. */
function ParkedModelGroup({
  id,
  cars,
  unlit,
  body,
  registryKind,
}: {
  id: string;
  cars: readonly DynamicPlacement[];
  unlit: boolean;
  body: DynamicBodySpec;
  registryKind: 'parkedCar' | 'cone';
}) {
  const { geometry, scale, lift, material } = useBakedCityPackModel(id);
  const renderMaterial = useMemo(() => (unlit ? toUnlit(material) : material), [material, unlit]);
  useEffect(() => () => { if (renderMaterial !== material) renderMaterial.dispose(); }, [renderMaterial, material]);
  // Phase 29 (D4): per-car material when the car carries a carVariety tint — a clone of the group
  // material with `.color` set (MeshBasic/Standard both multiply .color over the map, so tint ×
  // neutral-body map = a true body colour). Cones (no tint) share the one group material. Clones
  // are disposed on unmount; the shared group material is disposed by the effect above.
  const carMaterials = useMemo(
    () =>
      cars.map((car) => {
        if (car.tint === undefined) return renderMaterial;
        const m = renderMaterial.clone();
        (m as Material & { color?: Color }).color?.set(car.tint);
        return m;
      }),
    [cars, renderMaterial],
  );
  useEffect(
    () => () => {
      for (const m of carMaterials) if (m !== renderMaterial) m.dispose();
    },
    [carMaterials, renderMaterial],
  );
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
          {/* Cuboid centred on the body origin (= geometric centre at rest → COM ≈ centre).
              Phase 29 (D1): registered via the shared RegisteredCuboidCollider wrapper — a real
              parked car or cone starts life ALREADY dynamic (never goes through
              world/propDynamics.ts's fixed->dynamic swap), so it registers directly as the
              post-swap 'propDynamic' identity (torontoColliders.ts). */}
          <RegisteredCuboidCollider
            entry={registryKind === 'cone' ? torontoConeEntry() : torontoParkedCarEntry(car.districtId)}
            halfExtents={[half.hx, half.hy, half.hz]}
            position={[0, 0, 0]}
            mass={body.massKg}
          />
          {/* Mesh floor lands on the ground at rest: body origin sits at hy, the model floor is
              `lift` above the model origin, so the mesh drops by (hy − lift). */}
          <mesh geometry={geometry} material={carMaterials[i]} position={[0, lift - half.hy, 0]} scale={scale} />
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
  /** Phase 29 (D1): which registry identity these dynamic bodies get — 'parkedCar' (hp-bearing,
   * joins scoring like a legacy parked car) or 'cone' (light knockable prop, no hp). Defaults to
   * 'parkedCar' (the original, pre-29 call site — real parked cars) so it stays additive. */
  readonly registryKind?: 'parkedCar' | 'cone';
}

/** Mounts every dynamic instance, grouped by model id so each model's geometry/material load once.
 * The grouping keys are seed-stable (furniture.ts/infill.ts are deterministic), so React's hook
 * order per ParkedModelGroup is stable. */
export function ParkedVehicles({ parked, unlit, body = PARKED.body, registryKind = 'parkedCar' }: ParkedVehiclesProps) {
  const byModel = new Map<string, DynamicPlacement[]>();
  for (const car of parked) (byModel.get(car.modelId) ?? byModel.set(car.modelId, []).get(car.modelId)!).push(car);
  const ids = [...byModel.keys()].sort();

  return (
    <Suspense fallback={null}>
      {ids.map((id) => (
        <ParkedModelGroup key={id} id={id} cars={byModel.get(id)!} unlit={unlit} body={body} registryKind={registryKind} />
      ))}
    </Suspense>
  );
}
