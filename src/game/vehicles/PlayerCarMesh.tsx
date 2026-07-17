// Phase 17 Task 2: player car mesh switcher. Reads state/store.ts's selectedCarId (the
// Phase 17 seam the orchestrator authored ahead of this task) and renders the matching
// procedural mesh — the only thing that varies per car; the physics chassis/collider
// (vehicles/PlayerVehicle.tsx) is shared, and every mesh below implements the same
// wheel-sync + damage-tint contract documented in RustySedanMesh.tsx's header.
//
// Mounted as PlayerVehicle's {children} — game/index.tsx wires that (not this file's job,
// per CLAUDE.md's directory-layout rule that entry-point integration stays with the
// orchestrator).

import type { ComponentType } from 'react';
import { useGameStore } from '../state/store';
import type { PlayerCarId } from '../config';
import { RustySedanMesh } from './RustySedanMesh';
import { StreetRacerMesh } from './meshes/StreetRacerMesh';
import { PickupMesh } from './meshes/PickupMesh';
import { SchoolBusMesh } from './meshes/SchoolBusMesh';
import { MonsterTruckMesh } from './meshes/MonsterTruckMesh';
import { RedRocketMesh } from './meshes/RedRocketMesh';

const CAR_MESHES: Record<PlayerCarId, ComponentType> = {
  rustySedan: RustySedanMesh,
  streetRacer: StreetRacerMesh,
  pickup: PickupMesh,
  schoolBus: SchoolBusMesh,
  monsterTruck: MonsterTruckMesh,
  redRocket: RedRocketMesh,
};

export function PlayerCarMesh() {
  const selectedCarId = useGameStore((s) => s.selectedCarId);
  const Mesh = CAR_MESHES[selectedCarId];
  return <Mesh />;
}
