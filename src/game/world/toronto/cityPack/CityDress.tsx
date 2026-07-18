// Phase 25.6 — the re-dressed city mount. Consumes the pure frontage (frontage.ts) + furniture
// (furniture.ts) layouts and renders the whole city-pack dress: frontage buildings (one BatchedMesh
// per model type, per-instance culled) + fixed BUILDING colliders, the D7 backdrop-tower boxes
// (legacy box InstancedMesh path), the street-furniture rows (one BatchedMesh per prop type) with
// tree-trunk + bus-stop colliders, parked cars as sleeping dynamic bodies, and the traffic-light
// lamp overlay. Every layer gates on its own devToggle (perf triage / A/B) and reads `cityPackUnlit`
// for the material A/B arm. This is the layer TorontoScene mounts in place of the retired massing.

import { Suspense } from 'react';
import { CuboidCollider, RigidBody } from '@react-three/rapier';
import { useEffect, useMemo, useRef } from 'react';
import { Color, Object3D, type InstancedMesh } from 'three';
import { interactionGroups } from '../../../config';
import { useDevToggle } from '../../../core/devToggles';
import { CityPackBatched } from './CityPackBatched';
import { ParkedVehicles } from './ParkedVehicles';
import { TrafficLampOverlay } from './TrafficLampOverlay';
import { slotsForModel, type FrontageLayout } from '../frontage';
import type { FurnitureLayout, FurniturePlacement } from '../furniture';
import type { CityPackPlacement } from './CityPackInstances';

const BUILDING_GROUPS = interactionGroups('BUILDING');

/** FurniturePlacement → CityPackPlacement (drop the districtId; furniture carries no tint). */
function toPlacements(items: readonly FurniturePlacement[]): readonly CityPackPlacement[] {
  return items.map((p) => ({ position: p.position, rotationY: p.rotationY }));
}

/** Frontage pack buildings: one BatchedMesh per model id + one fixed RigidBody of BUILDING cuboids
 * (the slot half-extents are already post-yaw, so the colliders mount axis-aligned). */
function FrontageBuildings({ layout, unlit }: { layout: FrontageLayout; unlit: boolean }) {
  const byModel = useMemo(
    () =>
      layout.modelIds.map((id) => ({
        id,
        placements: slotsForModel(layout, id).map(
          (s): CityPackPlacement => ({ position: s.position, rotationY: s.rotationY, tint: s.tint }),
        ),
      })),
    [layout],
  );

  return (
    <Suspense fallback={null}>
      {byModel.map(({ id, placements }) => (
        <CityPackBatched key={id} id={id} placements={placements} unlit={unlit} />
      ))}
      <RigidBody type="fixed" colliders={false} collisionGroups={BUILDING_GROUPS}>
        {layout.slots.map((s) => (
          <CuboidCollider key={s.slotId} args={[s.hx, s.hy, s.hz]} position={[s.position[0], s.hy, s.position[2]]} />
        ))}
      </RigidBody>
    </Suspense>
  );
}

/** D7 backdrop towers: legacy extruded coloured boxes (one InstancedMesh + fixed colliders), the
 * exact P23 material (unlit + instanceColor). Only the three tower districts populate this. */
function BackdropTowers({ layout }: { layout: FrontageLayout }) {
  const boxes = layout.towerBoxes;
  const ref = useRef<InstancedMesh>(null);
  useEffect(() => {
    const mesh = ref.current;
    if (!mesh || boxes.length === 0) return;
    const dummy = new Object3D();
    const color = new Color();
    boxes.forEach((b, i) => {
      dummy.position.set(b.x, b.hy, b.z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(b.hx * 2, b.hy * 2, b.hz * 2);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      color.set(b.color);
      mesh.setColorAt(i, color);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [boxes]);

  if (boxes.length === 0) return null;
  return (
    <>
      <instancedMesh ref={ref} args={[undefined, undefined, boxes.length]} frustumCulled={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
      <RigidBody type="fixed" colliders={false} collisionGroups={BUILDING_GROUPS}>
        {boxes.map((b, i) => (
          <CuboidCollider key={i} args={[b.hx, b.hy, b.hz]} position={[b.x, b.hy, b.z]} />
        ))}
      </RigidBody>
    </>
  );
}

/** Street furniture: one BatchedMesh per prop type + tree-trunk / bus-stop colliders (D12). Small
 * furniture (masts/hydrants/benches/trash/power/stop/manhole) is colliderless this phase. */
function StreetFurniture({ furniture, unlit }: { furniture: FurnitureLayout; unlit: boolean }) {
  const cats = useMemo(
    () => [
      { id: 'traffic-light', placements: toPlacements(furniture.trafficLights) },
      { id: 'tree', placements: toPlacements(furniture.trees.items) },
      { id: 'fire-hydrant', placements: toPlacements(furniture.hydrants.items) },
      { id: 'bench', placements: toPlacements(furniture.benches.items) },
      { id: 'trash-can', placements: toPlacements(furniture.trashCans.items) },
      { id: 'bus-stop', placements: toPlacements(furniture.busStops.items) },
      { id: 'power-box', placements: toPlacements(furniture.powerBoxes.items) },
      { id: 'stop-sign', placements: toPlacements(furniture.stopSigns.items) },
      { id: 'manhole-cover', placements: toPlacements(furniture.manholes.items) },
    ],
    [furniture],
  );
  const trunk = furniture.colliderSpecs.treeTrunk;
  const busStop = furniture.colliderSpecs.busStop;

  return (
    <Suspense fallback={null}>
      {cats.map(({ id, placements }) => (
        <CityPackBatched key={id} id={id} placements={placements} unlit={unlit} />
      ))}
      <RigidBody type="fixed" colliders={false} collisionGroups={BUILDING_GROUPS}>
        {furniture.trees.items.map((t, i) => (
          <CuboidCollider key={`tree-${i}`} args={[trunk.hx, trunk.hy, trunk.hz]} position={[t.position[0], trunk.hy, t.position[2]]} />
        ))}
        {furniture.busStops.items.map((b, i) => (
          <CuboidCollider
            key={`bus-${i}`}
            args={[busStop.hx, busStop.hy, busStop.hz]}
            position={[b.position[0], busStop.hy, b.position[2]]}
            rotation={[0, b.rotationY, 0]}
          />
        ))}
      </RigidBody>
    </Suspense>
  );
}

export interface CityDressProps {
  readonly frontage: FrontageLayout;
  readonly furniture: FurnitureLayout;
}

/** The whole re-dressed city — each layer independently toggle-gated (perf triage / A/B). */
export function CityDress({ frontage, furniture }: CityDressProps) {
  const unlit = useDevToggle('cityPackUnlit');
  const showBuildings = useDevToggle('packBuildings');
  const showFurniture = useDevToggle('packFurniture');
  const showParked = useDevToggle('packParked');
  const showLamps = useDevToggle('packLightCycling');

  return (
    <>
      {showBuildings ? <FrontageBuildings layout={frontage} unlit={unlit} /> : null}
      {showBuildings ? <BackdropTowers layout={frontage} /> : null}
      {showFurniture ? <StreetFurniture furniture={furniture} unlit={unlit} /> : null}
      {showParked ? <ParkedVehicles parked={furniture.parked.items} unlit={unlit} /> : null}
      {showLamps ? <TrafficLampOverlay masts={furniture.trafficLights} /> : null}
    </>
  );
}
