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
// Furniture WITH a real collider (currently only tree trunks + bus stops — see
// cityPack/CityDress.tsx's StreetFurniture) registers `kind: 'propStatic'`: tree trunks carry
// the LEGACY 'tree' archetype (matches DAMAGE.archetypeMassKg / PROPS masses/forceThresholds
// exactly, so a tree hit deals/receives the same mass-scaled damage a legacy tree would), bus
// stops carry no archetype (no legacy equivalent exists — massFactorOf() falls back to its
// documented factor-1 default, same as an unlisted archetype).
//
// HONEST GAP (flagged, not hidden): world/propDynamics.ts's fixed->dynamic swap
// (PropSwapController.handleImpact) requires `getArchetypeHandles(archetype)` — the LEGACY
// world/instancing.ts InstancedMesh registry, built only by world/CityArchetypes.tsx (never
// mounted under the Toronto branch). So even though tree trunks carry a swap-eligible
// archetype+threshold, `handles.length === 0` for Toronto and the swap silently no-ops (see
// that file's own comment on the guard) — no visual launch, no propDestroyed event, for ANY
// Toronto 'propStatic' entry, this phase. This is a real architecture gap between the plan's
// assumption ("same archetypes -> same tuning" implies the swap "just works") and Toronto's
// actual pack-based rendering (BatchedMesh, not InstancedMesh) — registering the archetype
// name anyway is still correct and forward-compatible (right mass/threshold now; a future
// Toronto-aware swap visual can reuse these entries unchanged), it just doesn't visually launch
// yet. "Impacts launch props + score accrues" is instead satisfied by PARKED CARS (below) and
// LANE-CLOSURE CONES, which start life as REAL dynamic bodies (never need the swap at all) and
// so shove/tumble via plain Rapier physics from the moment they're registered.
//
// Power boxes take the LEGACY TRANSFORMER role directly (`kind: 'transformer'`, hp
// POWER_GRID.transformerHp) — combat/damage.ts's handleTransformerDeath() only OPTIONALLY reads
// getArchetypeHandles() (for the wrecked-instance tint + position), gracefully skipping that
// half when the archetype has no live mesh (see that function's doc comment: "the event still
// fires either way") — so transformerDestroyed correctly fires end-to-end for Toronto with NO
// dependency on the legacy instancing system, unlike the general prop-swap path above.
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

import { PROPS, POWER_GRID } from '../../config';
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
 * district's index — the district-blackout entry point. */
export function torontoTransformerEntry(districtId: DistrictId): EntityEntry {
  return { kind: 'transformer', districtId: torontoDistrictIndex(districtId), hp: POWER_GRID.transformerHp };
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
 * archetype with a real legacy tuning match. See file header for the swap-gap caveat. */
export function torontoTreeEntry(districtId: DistrictId): EntityEntry {
  return { kind: 'propStatic', archetype: 'tree', districtId: torontoDistrictIndex(districtId) };
}

/** Bus-stop collider — no legacy archetype equivalent exists (busStop isn't in
 * world/archetypes.ts's ARCHETYPES list), so this carries no archetype (massFactorOf's
 * documented factor-1 default applies, same as any unlisted archetype). */
export function torontoBusStopEntry(districtId: DistrictId): EntityEntry {
  return { kind: 'propStatic', districtId: torontoDistrictIndex(districtId) };
}
