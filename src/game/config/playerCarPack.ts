// Phase 31 T2 (D6) — player/garage-swap city-pack car config. CLAUDE.md's CITY-PACK REAPPROACH
// block + the Assets locked-decision row: "default rusty car = pack car-a, garage cars swap
// where a fit exists, monster truck stays in-house" — this module is the single source of truth
// for WHICH pack model each swapped car renders, its tint colour, and the BODY scale factor
// (vehicles/meshes/PackCarMesh.tsx consumes all three; the WHEEL scale is resolved at RENDER
// TIME instead — see below — not here).
//
// monsterTruck is deliberately absent from every map/record here (no pack tower/truck-class model
// exists for it — the user-stated in-house exception CLAUDE.md records; it keeps rendering via
// vehicles/meshes/MonsterTruckMesh.tsx, untouched by this phase).
//
// TWO INDEPENDENT SCALE FACTORS (not one shared uniform scale) — a deliberate Phase 31 T2 design
// choice, not an oversight:
//   - BODY scale (resolvePlayerCarBodyScale, below): matches the model's own native LENGTH (its
//     longest horizontal/native-Z axis — confirmed the forward axis for all 5 targets) to the
//     car's own collider length (D6's literal instruction). Grades differ wildly (streetRacer
//     3.9 m vs redRocket 11.0 m), so this factor differs per car even though 2 of the 5 share a
//     model FAMILY resemblance (car-a/sports-car-a are both ~1:1 already; sports-car-b stretches
//     ~1.9x to fill the Red Rocket's boat-turn length — a known, accepted cosmetic trade-off, see
//     phase-31 notes).
//   - WHEEL scale: deliberately NOT resolved here. Matching wheel VISUAL RADIUS to the physics
//     wheel radius (VEHICLE_TUNING/CAR_OVERRIDES `wheels.radius`) matters far more than matching
//     the body's uniform factor — measured off the raw pack geometry, a body-uniform wheel scale
//     put the Red Rocket's front tire at ~0.87 wu radius against a 0.36 wu physics wheel (the
//     sports-car-b donor model's wheels are proportionally huge on its own short chassis, and the
//     body stretch factor makes it worse). vehicles/meshes/PackCarMesh.tsx computes
//     targetWheelRadiusWu(carId) / <the loaded wheel geometry's own bounding radius> once per
//     mount instead — this file only exposes the TARGET (the physics side), never the model's
//     native geometry (that lives in the loaded asset, not in config).

import { getCityPackModel } from '../assets/cityPackManifest';
// Deliberately the ZERO-DEPENDENCY names module, never cityPackPlayerCar.mjs itself (which pulls
// in @gltf-transform/functions + a lazy `sharp` import, Node-only — see that file's own header).
import { playerVariantId } from '../../../scripts/lib/cityPackPlayerCarNames.mjs';
import { CAR_OVERRIDES } from './carTuning';
import { VEHICLE_TUNING, type PlayerCarId } from './vehicles';

/** The 5 PlayerCarIds Phase 31 T2 swaps to a city-pack model (every PlayerCarId except
 * 'monsterTruck', which stays in-house — see file header). */
export type PlayerPackCarId = Exclude<PlayerCarId, 'monsterTruck'>;

/** Which city-pack manifest id (base, pre `-player` suffix) each swapped car renders. */
export const PLAYER_CAR_PACK_MODEL: Record<PlayerPackCarId, string> = {
  rustySedan: 'car-a',
  streetRacer: 'sports-car-a',
  pickup: 'pickup-truck',
  schoolBus: 'bus',
  redRocket: 'sports-car-b',
};

/**
 * Per-car body tint (sRGB hex), applied every frame via `material.color.set(tint)` on the
 * `-player` variant's neutral-body base (vehicles/meshes/PackCarMesh.tsx, mirroring
 * RustySedanMesh.tsx's damage-tint reset-then-apply discipline). Every value reuses its retired
 * procedural mesh's exact PALETTE.body hex (RustySedanMesh/StreetRacerMesh/PickupMesh/
 * SchoolBusMesh/RedRocketMesh) so no car's identity colour changes across the swap — schoolBus is
 * the one genuine RE-colour in the set (bus.glb ships a TTC-red-ish atlas; the `-player` pipeline
 * variant neutralizes it first — scripts/lib/cityPackPlayerCar.mjs — so this yellow reads as a
 * school bus body, not a leftover TTC red).
 */
export const PLAYER_CAR_TINT: Record<PlayerPackCarId, string> = {
  rustySedan: '#a9502f', // rust — THE default car (CLAUDE.md locked override)
  streetRacer: '#1fb6c4', // teal/cyan
  pickup: '#2f5233', // forest green
  schoolBus: '#f4c430', // school-bus yellow
  redRocket: '#c1272d', // red
};

/** Chassis length (m) for a swapped car — reads CAR_OVERRIDES directly (chassis half-extents are
 * NOT mass-scaled by the grade resolver, vehicles/definitions.ts's header — CAR_OVERRIDES'
 * ov.chassis passes straight through), except the sedan, which (like everywhere else in the
 * config layer) references VEHICLE_TUNING so it stays leva-live and never drifts from the
 * signed-off M1 collider. Deliberately reads config/ directly rather than importing
 * vehicles/definitions.ts's getCarDef — config/ must stay a dependency LEAF (CLAUDE.md directory
 * layout), never depending on the vehicles/ layer above it. */
function chassisLengthWu(carId: PlayerPackCarId): number {
  return carId === 'rustySedan'
    ? VEHICLE_TUNING.chassis.halfLength * 2
    : CAR_OVERRIDES[carId].chassis.halfLength * 2;
}

/** Physics wheel radius (m) for a swapped car — same sedan/VEHICLE_TUNING exception as above. */
export function targetWheelRadiusWu(carId: PlayerPackCarId): number {
  return carId === 'rustySedan' ? VEHICLE_TUNING.wheels.radius : CAR_OVERRIDES[carId].wheels.radius;
}

/** The manifest id of the actual `-player` GLB a swapped car renders (e.g. 'car-a-player') —
 * centralizes the `-player` suffix knowledge here so vehicles/meshes/PackCarMesh.tsx never needs
 * to import scripts/lib/cityPackPlayerCar.mjs directly. */
export function resolvePlayerCarModelVariantId(carId: PlayerPackCarId): string {
  return playerVariantId(PLAYER_CAR_PACK_MODEL[carId]);
}

/**
 * Uniform BODY scale (D6): target chassis length / the model's native length. The `-player`
 * variant shares its base id's nativeDims exactly (cityPackManifest.test.ts asserts this — the
 * pipeline pre-transform only restructures nodes/recolours materials, never geometry bounds), so
 * reading the `-player` entry vs. the base entry is equivalent; this reads the `-player` entry
 * directly since that is the id actually rendered. `.d` (native Z) is the confirmed forward/
 * length axis for every one of the 5 targets (car bodies measurably longer along Z than X for
 * all 5 — see phase-31 notes' pipeline investigation).
 */
export function resolvePlayerCarBodyScale(carId: PlayerPackCarId): number {
  const nativeLength = getCityPackModel(resolvePlayerCarModelVariantId(carId)).nativeDims.d;
  return chassisLengthWu(carId) / nativeLength;
}
