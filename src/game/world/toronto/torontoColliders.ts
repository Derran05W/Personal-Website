// Toronto map v2 — registry entry construction for every Toronto collider seam (Phase 29 T1,
// D1/D2). Mirrors world/worldCollidersLogic.ts's split (pure entry-builders in their own
// component-free module, mounted through the shared RegisteredCuboidCollider/
// RegisteredCylinderCollider wrappers in world/landmarks/registeredCollider.tsx) so this file's
// several non-component exports don't trip react-refresh/only-export-components, and so the
// registry-coverage tests can exercise every builder directly without mounting a live
// Rapier/WebGL scene (torontoColliders.test.ts).
//
// --- kind choices (documented judgment calls) ----------------------------------------------
// Every Toronto filler/backdrop/corner-fill/infill/named/hero/place BOX is registered
// `kind: 'building'` (indestructible fixed collider, CLAUDE.md locked decision) — none of them
// carry hp, so applyEntityDamage() is a permanent no-op for them; they exist purely so ramming
// one deals damage TO THE PLAYER (combat/damage.ts requires BOTH impact sides registered, see
// that file's applySideDamage header) and so the HP/heat/score chain sees a real `other` side
// instead of silently skipping every building hit.
//
// Furniture WITH a real collider — tree trunks, bus stops, and (Phase 30 T2 debt-1) hydrants,
// benches, trash cans, traffic-light masts, and stop signs (see cityPack/CityDress.tsx's
// StreetFurniture) — registers `kind: 'propStatic'` with a real `archetype` (tree/busStop/
// hydrant/bench/trashCan/trafficLight/stopSign, all in PROPS.masses/forceThresholds) and an
// `instanceId` pointing at that archetype's CityPackBatched instance.
//
// GAP CLOSED (Phase 30 T2 debt-1): Phase 29 flagged that world/propDynamics.ts's fixed->dynamic
// swap needs `getArchetypeHandles(archetype)` — the LEGACY world/instancing.ts InstancedMesh
// registry, never built under the Toronto branch (BatchedMesh, not InstancedMesh) — so a
// Toronto propStatic hit silently no-op'd. This phase does NOT wire Toronto through that
// legacy registry (BatchedMesh has no InstancedMesh-shaped API to satisfy it); instead
// world/toronto/cityPack/furnitureDynamics.ts is a SIBLING controller that reuses
// world/propDynamics.ts's exported pure tuning (resolveSwapTarget/computeLaunchImpulse/
// selectEvictionIndex/isExpired — the same PROPS-config-driven math, never re-derived) against
// a Toronto-native batched-instance registry (cityPack/batchedRegistry.ts) that CAN hide a
// BatchedMesh instance (`setVisibleAt`) and spawn a pooled dynamic replica of the real GLB
// model. Tree trunks are the one archetype with a special rule: the trunk collider stays
// registered/enabled on launch (only the canopy/whole-tree VISUAL launches) — see that
// module's header for why.
//
// Power boxes take the LEGACY TRANSFORMER role directly (`kind: 'transformer'`, hp
// POWER_BOX.hp — Toronto's OWN tuned value, Phase 30 T2 debt-3; see that config's doc comment
// for why it is never POWER_GRID.transformerHp) — combat/damage.ts's handleTransformerDeath()
// only OPTIONALLY reads getArchetypeHandles() (for the wrecked-instance tint + position),
// gracefully skipping that half when the archetype has no live mesh (see that function's doc
// comment: "the event still fires either way") — so transformerDestroyed correctly fires
// end-to-end for Toronto with NO dependency on the legacy instancing system. Phase 30 (T2
// debt-1) adds the VISUAL half back for Toronto: furnitureDynamics.ts subscribes
// transformerDestroyed directly and scans the district's registered power-box entries
// (world/registry.ts's allEntries()) for the one whose hp just hit 0, then hides + launches it
// — see that module for the "one death -> one box" scan.
//
// Parked vehicles (street + lot) and lane-closure cones are already REAL dynamic bodies at
// creation (cityPack/ParkedVehicles.tsx) — they never go through the fixed->dynamic swap at
// all, so they register directly as `kind: 'propDynamic'` (the SAME shape
// PropSwapController.handleImpact would have produced post-swap). Parked cars carry
// `archetype: 'parkedCar'` + `hp: PROPS.parkedCarHp` (joins scoring exactly like a legacy
// parked car: applyEntityDamage -> propDestroyed{archetype:'parkedCar'} -> state/heat.ts's
// civHit heat delta). Lane-closure cones have no legacy archetype equivalent and no hp (a
// cosmetic knockable prop, physics-only) and no districtId of their own
// (world/toronto/infill.ts's DynamicConeSpec carries none — registry.ts's -1 "not districted"
// convention applies).

import { PROPS } from '../../config';
import { POWER_BOX } from '../../config/torontoDress';
import type { ArchetypeName } from '../archetypes';
import type { EntityEntry } from '../registry';
import type { DistrictId } from '../../config/torontoDistricts';
import { torontoDistrictIndex } from './districts';

/** Indestructible fixed collider (buildings/boxes/corner-fill/infill fixtures/named/hero/place
 * boxes) — every filler/backdrop/named/hero/place BOX in Toronto shares this one shape. */
export function torontoBuildingEntry(districtId: DistrictId): EntityEntry {
  return { kind: 'building', districtId: torontoDistrictIndex(districtId) };
}

/** Same as torontoBuildingEntry but for a placement whose district is resolved SPATIALLY (a
 * pre-computed numeric index, e.g. via torontoDistrictIndexAt) rather than carried on the data —
 * named buildings/heroes/places boxes don't carry a districtId field of their own. */
export function torontoBuildingEntryAt(districtIndex: number): EntityEntry {
  return { kind: 'building', districtId: districtIndex };
}

/** Power-box props take the legacy TRANSFORMER role (D2): hp-bearing, dies via the same
 * combat/damage.ts handleTransformerDeath() path, emits transformerDestroyed with this
 * district's index — the district-blackout entry point. hp is POWER_BOX.hp (Phase 30 T2
 * debt-3), Toronto's OWN tuned value — deliberately NOT the legacy POWER_GRID.transformerHp
 * (see that config's doc comment for why the two must never share a number). `instanceId`
 * (Phase 30 T2 debt-1, optional so every pre-existing one-arg call site still compiles) is the
 * index into the 'power-box' CityPackBatched mesh (furniture.powerBoxes.items order) — the
 * furniture-launch pool's post-death scan (world/toronto/cityPack/furnitureDynamics.ts) uses
 * it to find and hide/launch the exact box that died. */
export function torontoTransformerEntry(districtId: DistrictId, instanceId?: number): EntityEntry {
  return { kind: 'transformer', instanceId, districtId: torontoDistrictIndex(districtId), hp: POWER_BOX.hp };
}

/** Street/lot parked car — already a real dynamic body (cityPack/ParkedVehicles.tsx); registers
 * directly as the post-swap 'propDynamic' shape (never actually swaps). `districtId` is
 * optional because the shared ParkedVehicles renderer also serves lane-closure cones, whose
 * DynamicConeSpec carries none — falls back to registry.ts's -1 "not districted". */
export function torontoParkedCarEntry(districtId: DistrictId | undefined): EntityEntry {
  return {
    kind: 'propDynamic',
    archetype: 'parkedCar',
    hp: PROPS.parkedCarHp,
    districtId: districtId !== undefined ? torontoDistrictIndex(districtId) : -1,
  };
}

/** Lane-closure cone — dynamic, knockable, no legacy archetype equivalent (see file header) and
 * no districtId (infill.ts's DynamicConeSpec doesn't carry one). Physics-only entry: contact
 * resolution still works (mass factor falls back to 1), no scoring/hp. */
export function torontoConeEntry(): EntityEntry {
  return { kind: 'propDynamic', districtId: -1 };
}

/** Tree trunk collider (StreetFurniture's shared TREE_ROW.trunk collider) — the one furniture
 * archetype with a real legacy tuning match. `instanceId` (Phase 30 T2 debt-1, optional —
 * every pre-existing one-arg call site still compiles) is the index into the 'tree'
 * CityPackBatched mesh (furniture.trees.items order); the swap-gap this file's header used to
 * document is CLOSED by world/toronto/cityPack/furnitureDynamics.ts, which reads it to hide
 * the visual instance and launch a flying replica — see that module for the tree-specific
 * rule (the TRUNK collider stays registered/enabled; only the canopy model launches). */
export function torontoTreeEntry(districtId: DistrictId, instanceId?: number): EntityEntry {
  return { kind: 'propStatic', archetype: 'tree', instanceId, districtId: torontoDistrictIndex(districtId) };
}

/** Bus-stop collider. Phase 30 (T2 debt-1): now carries the 'busStop' archetype (added to
 * world/archetypes.ts + config/world.ts's PROPS.masses/forceThresholds) so it participates in
 * the launch pool like every other furniture archetype — previously archetype-less (factor-1
 * damage default only). `instanceId` is the index into the 'bus-stop' CityPackBatched mesh. */
export function torontoBusStopEntry(districtId: DistrictId, instanceId?: number): EntityEntry {
  return { kind: 'propStatic', archetype: 'busStop', instanceId, districtId: torontoDistrictIndex(districtId) };
}

/** Generic launchable-furniture collider (Phase 30 T2 debt-1): hydrant / bench / trash-can /
 * traffic-light mast / stop-sign all register through this one builder — `archetype` picks up
 * PROPS.masses/forceThresholds via the SAME resolveSwapTarget() gate every other propStatic
 * archetype uses (world/propDynamics.ts), and `instanceId` is the index into that category's
 * CityPackBatched mesh (its placement-array order — CityPackBatched populates addInstance() in
 * that exact order on first build, so index i there IS instance id i). */
export function torontoFurnitureEntry(
  archetype: ArchetypeName,
  districtId: DistrictId,
  instanceId: number,
): EntityEntry {
  return { kind: 'propStatic', archetype, instanceId, districtId: torontoDistrictIndex(districtId) };
}
