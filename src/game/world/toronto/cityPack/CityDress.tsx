// Phase 25.6 — the re-dressed city mount. Consumes the pure frontage (frontage.ts) + furniture
// (furniture.ts) layouts and renders the whole city-pack dress: frontage buildings (one BatchedMesh
// per model type, per-instance culled) + fixed BUILDING colliders, the D7 backdrop-tower boxes
// (legacy box InstancedMesh path), the street-furniture rows (one BatchedMesh per prop type) with
// tree-trunk + bus-stop colliders, parked cars as sleeping dynamic bodies, and the traffic-light
// lamp overlay. Every layer gates on its own devToggle (perf triage / A/B) and reads `cityPackUnlit`
// for the material A/B arm. This is the layer TorontoScene mounts in place of the retired massing.

import { Suspense } from 'react';
import { RigidBody } from '@react-three/rapier';
import { useEffect, useMemo, useRef } from 'react';
import { Color, Object3D, type InstancedMesh } from 'three';
import { interactionGroups } from '../../../config';
import { colliderHalfExtents } from '../../../config/cityPackScale';
import { useDevToggle } from '../../../core/devToggles';
import { RegisteredCuboidCollider } from '../../landmarks/registeredCollider';
import { torontoBuildingEntry, torontoTransformerEntry, torontoTreeEntry, torontoBusStopEntry } from '../torontoColliders';
import { CityPackBatched } from './CityPackBatched';
import { ParkedVehicles } from './ParkedVehicles';
import { TrafficLampOverlay } from './TrafficLampOverlay';
import { VenueDressLayer } from './VenueDressLayer';
import { LANE_CLOSURE } from '../../../config/torontoDress';
import { type BackdropBox, type FrontageLayout, type PlacedBox } from '../frontage';
import type { FurnitureLayout } from '../furniture';
import type { DecorPlacement, InfillLayout } from '../infill';
import type { VenueDress } from '../venueDress';
import type { DistrictId } from '../../../config/torontoDistricts';
import type { CityPackPlacement } from './CityPackInstances';

const BUILDING_GROUPS = interactionGroups('BUILDING');
// Power boxes take the legacy transformer role (Phase 29 D2) — the legacy world registers
// transformerBox as a street-prop archetype (world/CityColliders.tsx's propColliderGroups),
// which uses PROP_STATIC, not BUILDING; matched exactly here for collision-group parity.
const PROP_STATIC_GROUPS = interactionGroups('PROP_STATIC');

/** FurniturePlacement/DecorPlacement → CityPackPlacement (drop the districtId; neither carries a
 * tint). Shared by StreetFurniture (25.6) and Phase 28's DecorInstances. */
function toPlacements(items: readonly { readonly modelId: string; readonly position: readonly [number, number, number]; readonly rotationY: number }[]): readonly CityPackPlacement[] {
  return items.map((p) => ({ position: p.position, rotationY: p.rotationY }));
}

/** PlacedBox structurally widened with the districtId every real caller (FrontageSlot,
 * FixedInfillItem) actually carries — FixedPackInstances needs it for registry entries (Phase
 * 29 D1), but the bare PlacedBox shape (still used by BackdropBox's sibling paths) doesn't. */
type RegistrablePlacedBox = PlacedBox & { readonly districtId: DistrictId };

/**
 * Generic batched pack-model renderer + fixed BUILDING colliders, keyed by modelId (Phase 28: the
 * "extend the data the batchers consume" seam) — one BatchedMesh per unique model id across ANY
 * combination of layers passed in, so a model id shared by e.g. frontage + corner-fill + back-lot
 * collapses to ONE draw call regardless of which layer placed it. Was `FrontageBuildings` (25.6),
 * generalized from `FrontageLayout` to a flat `PlacedBox[]` so every fixed-collider layer (frontage
 * slots, corner fill, back-lot pack row, parking-lot cars, construction fence/dumpster/billboard)
 * shares this ONE component instead of each inventing its own. Phase 29 (D1): every collider here
 * registers `kind: 'building'` (indestructible fixed collider) so ramming one deals damage to the
 * player instead of silently no-op'ing (combat/damage.ts requires both impact sides registered). */
function FixedPackInstances({ items, unlit }: { items: readonly RegistrablePlacedBox[]; unlit: boolean }) {
  const byModel = useMemo(() => {
    const ids = [...new Set(items.map((s) => s.modelId))].sort();
    return ids.map((id) => ({
      id,
      placements: items
        .filter((s) => s.modelId === id)
        .map((s): CityPackPlacement => ({ position: s.position, rotationY: s.rotationY, tint: s.tint })),
    }));
  }, [items]);

  return (
    <Suspense fallback={null}>
      {byModel.map(({ id, placements }) => (
        <CityPackBatched key={id} id={id} placements={placements} unlit={unlit} />
      ))}
      <RigidBody type="fixed" colliders={false} collisionGroups={BUILDING_GROUPS}>
        {items.map((s, i) => (
          <RegisteredCuboidCollider
            key={i}
            entry={torontoBuildingEntry(s.districtId)}
            halfExtents={[s.hx, s.hy, s.hz]}
            position={[s.position[0], s.hy, s.position[2]]}
          />
        ))}
      </RigidBody>
    </Suspense>
  );
}

/** Colliderless decorative props (laneway clutter, construction decor, lane-closure road-bits) —
 * one BatchedMesh per unique model id, no colliders (Phase 28 D4/D6/D7). */
function DecorInstances({ items, unlit }: { items: readonly DecorPlacement[]; unlit: boolean }) {
  const byModel = useMemo(() => {
    const ids = [...new Set(items.map((d) => d.modelId))].sort();
    return ids.map((id) => ({ id, placements: toPlacements(items.filter((d) => d.modelId === id)) }));
  }, [items]);

  return (
    <Suspense fallback={null}>
      {byModel.map(({ id, placements }) => (
        <CityPackBatched key={id} id={id} placements={placements} unlit={unlit} />
      ))}
    </Suspense>
  );
}

/** D7/D3 backdrop-style boxes: legacy extruded coloured boxes (one InstancedMesh + fixed colliders),
 * the exact P23 material (unlit + instanceColor). Generalized from `FrontageLayout` to a flat
 * `BackdropBox[]` (Phase 28) so the D7 tower-district backdrop AND the D3 back-lot boxes share this
 * ONE component — callers merge both arrays before passing in. */
function BackdropTowers({ boxes }: { boxes: readonly BackdropBox[] }) {
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
          <RegisteredCuboidCollider
            key={i}
            entry={torontoBuildingEntry(b.districtId)}
            halfExtents={[b.hx, b.hy, b.hz]}
            position={[b.x, b.hy, b.z]}
          />
        ))}
      </RigidBody>
    </>
  );
}

/** Street furniture: one BatchedMesh per prop type + tree-trunk / bus-stop colliders (D12). Small
 * furniture (masts/hydrants/benches/trash/stop/manhole) is colliderless this phase — power boxes
 * get their OWN collider (PowerBoxes below): they take the legacy transformer role (Phase 29 D2),
 * so they need a real hp-bearing collider a car can actually hit. */
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
      {/* Phase 29 (D1): tree trunks + bus stops register as 'propStatic' (tree trunks carry the
          matching legacy 'tree' archetype for mass/threshold parity; bus stops have no legacy
          equivalent, so no archetype). See torontoColliders.ts's file header for the documented
          swap-visual gap (Toronto never builds the legacy InstancedMesh propDynamics.ts's
          fixed->dynamic swap depends on, so these never visually launch this phase — the
          registration is still correct/forward-compatible for damage mass factors). */}
      <RigidBody type="fixed" colliders={false} collisionGroups={BUILDING_GROUPS}>
        {furniture.trees.items.map((t, i) => (
          <RegisteredCuboidCollider
            key={`tree-${i}`}
            entry={torontoTreeEntry(t.districtId)}
            halfExtents={[trunk.hx, trunk.hy, trunk.hz]}
            position={[t.position[0], trunk.hy, t.position[2]]}
          />
        ))}
        {furniture.busStops.items.map((b, i) => (
          <RegisteredCuboidCollider
            key={`bus-${i}`}
            entry={torontoBusStopEntry(b.districtId)}
            halfExtents={[busStop.hx, busStop.hy, busStop.hz]}
            position={[b.position[0], busStop.hy, b.position[2]]}
            rotationY={b.rotationY}
          />
        ))}
      </RigidBody>
    </Suspense>
  );
}

/** Power boxes take the legacy TRANSFORMER role (Phase 29 D2): hp-bearing, dies via
 * combat/damage.ts's handleTransformerDeath() path, emits transformerDestroyed with this box's
 * district index — the district-blackout entry point (grid.ts/powergrid/emitters.ts). Unlike
 * the rest of StreetFurniture, power boxes NEED a real collider (they had none before this
 * phase — colliderless furniture can never be hit), sized from the pack model's own footprint
 * via the same colliderHalfExtents() every dynamic-vehicle path already uses. */
function PowerBoxes({ furniture }: { furniture: FurnitureLayout }) {
  const half = colliderHalfExtents('power-box');
  const items = furniture.powerBoxes.items;
  if (items.length === 0) return null;
  return (
    <RigidBody type="fixed" colliders={false} collisionGroups={PROP_STATIC_GROUPS}>
      {items.map((p, i) => (
        <RegisteredCuboidCollider
          key={i}
          entry={torontoTransformerEntry(p.districtId)}
          halfExtents={[half.hx, half.hy, half.hz]}
          position={[p.position[0], half.hy, p.position[2]]}
          rotationY={p.rotationY}
        />
      ))}
    </RigidBody>
  );
}

export interface CityDressProps {
  readonly frontage: FrontageLayout;
  readonly furniture: FurnitureLayout;
  /** Phase 28 infill: corner fill lives on `frontage.cornerFills`; back-lot/laneway/parking-lots/
   * construction/lane-closures live here. Optional so any pre-28 test harness that constructs
   * CityDressProps by hand without it still compiles — CityDress treats a missing/empty layout as
   * "nothing to add" (every array empty). */
  readonly infill?: InfillLayout;
  /** Phase 25.7 venue dressing (built off frontage.venueClaims by TorontoScene, passed in). */
  readonly dress: VenueDress;
  /** Phase 25.8 (D8): QUALITY_TIERS[tier].lampOverlay, mount-captured by TorontoScene. The
   * per-frame traffic-lamp phase overlay mounts only when BOTH this AND the devToggle are true —
   * low tier drops it (a small per-frame cost the screen is too small to read anyway at that
   * distance/tier). */
  readonly lampOverlay: boolean;
}

const EMPTY_INFILL: InfillLayout = { fixed: [], boxes: [], decor: [], cones: [], counts: {} };

/** The whole re-dressed city — each layer independently toggle-gated (perf triage / A/B). */
export function CityDress({ frontage, furniture, infill, dress, lampOverlay }: CityDressProps) {
  const unlit = useDevToggle('cityPackUnlit');
  const showBuildings = useDevToggle('packBuildings');
  const showFurniture = useDevToggle('packFurniture');
  const showParked = useDevToggle('packParked');
  const showLamps = useDevToggle('packLightCycling');
  const showVenueDress = useDevToggle('venueDress');
  const showInfill = useDevToggle('packInfill');
  const layer = infill ?? EMPTY_INFILL;

  // Phase 28: merge every fixed-collider layer (frontage + corner fill + back-lot pack row +
  // parking-lot cars + construction fence/dumpster/billboard) into ONE FixedPackInstances call —
  // a model id shared across layers (e.g. 'building-red-corner' from both the regular street-walk
  // and corner fill) collapses to a single BatchedMesh/draw call instead of one per layer. Same for
  // the box layer (D7 backdrop towers + D3 back-lot boxes).
  const fixedItems = useMemo<readonly RegistrablePlacedBox[]>(
    () => (showInfill ? [...frontage.slots, ...frontage.cornerFills, ...layer.fixed] : frontage.slots),
    [frontage, layer, showInfill],
  );
  const boxes = useMemo<readonly BackdropBox[]>(
    () => (showInfill ? [...frontage.towerBoxes, ...layer.boxes] : frontage.towerBoxes),
    [frontage, layer, showInfill],
  );

  return (
    <>
      {showBuildings ? <FixedPackInstances items={fixedItems} unlit={unlit} /> : null}
      {showBuildings ? <BackdropTowers boxes={boxes} /> : null}
      {showFurniture ? <StreetFurniture furniture={furniture} unlit={unlit} /> : null}
      {/* Phase 29 (D2): power boxes take the legacy transformer role — a dedicated collider (they
          had none before), gated on the SAME showFurniture toggle since they're conceptually a
          furniture item. */}
      {showFurniture ? <PowerBoxes furniture={furniture} /> : null}
      {showParked ? <ParkedVehicles parked={furniture.parked.items} unlit={unlit} registryKind="parkedCar" /> : null}
      {showLamps && lampOverlay ? <TrafficLampOverlay masts={furniture.trafficLights} /> : null}
      {showVenueDress ? <VenueDressLayer dress={dress} unlit={unlit} /> : null}
      {/* Phase 28 (D4/D6/D7): laneway clutter + construction decor + lane-closure road-bits
          (colliderless) and lane-closure cones (dynamic, knockable — reuses ParkedVehicles' body
          renderer with LANE_CLOSURE.coneBody instead of the parked-car spec). Phase 29 (D1):
          registryKind="cone" — light knockable prop, no hp, no legacy archetype match. */}
      {showInfill && layer.decor.length > 0 ? <DecorInstances items={layer.decor} unlit={unlit} /> : null}
      {showInfill && layer.cones.length > 0 ? (
        <ParkedVehicles parked={layer.cones} unlit={unlit} body={LANE_CLOSURE.coneBody} registryKind="cone" />
      ) : null}
    </>
  );
}
