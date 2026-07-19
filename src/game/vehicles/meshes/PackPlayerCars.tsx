// Phase 31 T2 (D6) — the 5 no-prop garage-swap wrapper components vehicles/PlayerCarMesh.tsx's
// CAR_MESHES switcher renders, each just PackCarMesh (the shared parametric implementation, see
// its own file header) pinned to one carId. monsterTruck has no entry here — it keeps rendering
// via vehicles/meshes/MonsterTruckMesh.tsx, untouched.
//
// PlayerVehicle (vehicles/PlayerVehicle.tsx) is always mounted, keyed on selectedCarId — picking
// a different car in the garage remounts it, which would otherwise cold-suspend on that car's
// `-player` GLB (game/index.tsx's Suspense boundary around <Physics> has no loading fallback, so
// a cold suspend blanks the whole scene briefly). Preloading all 5 at module scope (this file is
// imported once, at game bootstrap, via PlayerCarMesh.tsx) means every garage swap almost always
// hits an already-streamed/cached GLB instead.

import { preloadCityPack } from '../../assets/cityPack';
import { PLAYER_CAR_PACK_MODEL, resolvePlayerCarModelVariantId, type PlayerPackCarId } from '../../config/playerCarPack';
import { PackCarMesh } from './PackCarMesh';

preloadCityPack(
  (Object.keys(PLAYER_CAR_PACK_MODEL) as PlayerPackCarId[]).map((carId) => resolvePlayerCarModelVariantId(carId)),
);

export function CarAPlayerMesh() {
  return <PackCarMesh carId="rustySedan" />;
}

export function SportsCarAPlayerMesh() {
  return <PackCarMesh carId="streetRacer" />;
}

export function PickupTruckPlayerMesh() {
  return <PackCarMesh carId="pickup" />;
}

export function BusPlayerMesh() {
  return <PackCarMesh carId="schoolBus" />;
}

export function SportsCarBPlayerMesh() {
  return <PackCarMesh carId="redRocket" />;
}
