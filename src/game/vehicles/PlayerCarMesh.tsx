// Phase 17 Task 2: player car mesh switcher. Reads state/store.ts's selectedCarId (the
// Phase 17 seam the orchestrator authored ahead of this task) and renders the matching
// mesh — the only thing that varies per car; the physics chassis/collider
// (vehicles/PlayerVehicle.tsx) is shared, and every mesh below implements the same
// wheel-sync + damage-tint contract documented in RustySedanMesh.tsx's header.
//
// Mounted as PlayerVehicle's {children} — game/index.tsx wires that (not this file's job,
// per CLAUDE.md's directory-layout rule that entry-point integration stays with the
// orchestrator).
//
// Phase 31 T2 (D6, CITY-PACK REAPPROACH): 5 of the 6 cars now render their city-pack `-player`
// GLB variant (vehicles/meshes/PackCarMesh.tsx + PackPlayerCars.tsx) instead of a procedural box
// body — rustySedan -> car-a (THE default, rust-tinted), streetRacer -> sports-car-a, pickup ->
// pickup-truck, schoolBus -> bus (yellow-retinted), redRocket -> sports-car-b. monsterTruck stays
// in-house (user-stated exception, CLAUDE.md — no pack truck/tower-class model exists for it),
// still MonsterTruckMesh. The original procedural meshes (RustySedanMesh.tsx +
// meshes/{StreetRacer,Pickup,SchoolBus,RedRocket}Mesh.tsx) are left in place, unimported here —
// a deliberate keep, not an oversight (harmless dead code; a ready-made fallback/reference if the
// pack swap is ever reverted for one car).

import type { ComponentType } from 'react';
import { useGameStore } from '../state/store';
import type { PlayerCarId } from '../config';
import { MonsterTruckMesh } from './meshes/MonsterTruckMesh';
import {
  BusPlayerMesh,
  CarAPlayerMesh,
  PickupTruckPlayerMesh,
  SportsCarAPlayerMesh,
  SportsCarBPlayerMesh,
} from './meshes/PackPlayerCars';

const CAR_MESHES: Record<PlayerCarId, ComponentType> = {
  rustySedan: CarAPlayerMesh,
  streetRacer: SportsCarAPlayerMesh,
  pickup: PickupTruckPlayerMesh,
  schoolBus: BusPlayerMesh,
  monsterTruck: MonsterTruckMesh,
  redRocket: SportsCarBPlayerMesh,
};

export function PlayerCarMesh() {
  const selectedCarId = useGameStore((s) => s.selectedCarId);
  const Mesh = CAR_MESHES[selectedCarId];
  return <Mesh />;
}
