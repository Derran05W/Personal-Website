// R3F mount for the ambient helicopter flight model (Phase 14 Task 1). Named `HeliMount.tsx`
// (not `Helicopter.tsx`) to stay case-distinct from `helicopter.ts` — TypeScript rejects two
// modules differing only in case (TS1149), the same reason ai/TrafficMount.tsx sits next to
// ai/traffic.ts. Owns one HeliController (ai/helicopter.ts) for its lifetime, publishes it
// through BOTH refs:
//   • ai/heliTypes.ts's sealed `heliRef` — the read-only HeliSlot seam HeliMesh (Task 2) and
//     the searchlight (Task 3) consume.
//   • ai/helicopter.ts's `heliDebugRef` — the dev force-tier + readout handle.
//
// It drives the controller from a PRIORITY-0 useFrame — ambient, not physics: the heli has no
// colliders and never touches the Rapier world (TDD §5.7 v1), so it deliberately does NOT use
// the physics step hooks. Each frame it reads the player's INTERPOLATED pose (vehicles/
// playerRef.ts) as the orbit center — the same interpolated pose the follow camera reads, so
// the two never disagree — and passes the render delta straight through.
//
// Tier wiring: seeds the controller from the store's current tier on mount, then keeps it in
// sync via the tierChanged event (state/events.ts) — the same event the spawn director keys
// off. A debug force-tier (heliDebugRef.setForcedTier) overrides this without any heat.
//
// Unlike the pursuit/traffic mounts this needs neither <Physics> nor a world/seed key — it's
// pure atmosphere keyed off tier + the live player ref. Integration (game/index.tsx) mounts it
// once inside <Canvas>; a run reset naturally drops the heli because tier resets to 0.

import { useEffect, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { HeliController, heliDebugRef, type Vec3 } from './helicopter';
import { heliRef } from './heliTypes';
import { gameEvents } from '../state/events';
import { getGameState } from '../state/store';
import { playerVehicle } from '../vehicles/playerRef';

const ORIGIN: Vec3 = { x: 0, y: 0, z: 0 };

export function HeliMount() {
  const controllerRef = useRef<HeliController | null>(null);

  useEffect(() => {
    const controller = new HeliController();
    controllerRef.current = controller;
    heliRef.current = controller.api;
    heliDebugRef.current = controller.debug;

    // Seed from the current tier, then track it live.
    controller.setTier(getGameState().tier);
    const offTier = gameEvents.on('tierChanged', ({ tier }) => controller.setTier(tier));

    return () => {
      offTier();
      if (heliRef.current === controller.api) heliRef.current = null;
      if (heliDebugRef.current === controller.debug) heliDebugRef.current = null;
      controllerRef.current = null;
    };
  }, []);

  useFrame((_, delta) => {
    const controller = controllerRef.current;
    if (controller === null) return;
    // Interpolated player pose (not rawPose) — the orbit tracks what the camera sees. Falls
    // back to the origin before a run exists (tier is 0 there anyway, so no heli flies).
    const pose = playerVehicle.current?.readState().pose;
    controller.update(delta, pose ? pose.position : ORIGIN);
  }, 0);

  return null;
}
