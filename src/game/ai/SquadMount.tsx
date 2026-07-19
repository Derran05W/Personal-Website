// R3F mount that drives the SWAT-squad coordinator (Phase 10 Task 1). Named `SquadMount.tsx`
// (not `Squad.tsx`) to stay case-distinct from a potential `squad.ts` on case-insensitive file
// systems, mirroring ai/SpawnDirectorMount.tsx next to ai/spawnDirector.ts.
//
// This is GAMEPLAY infrastructure, NOT a dev tool: the published claims are what SWAT units read
// to flank, so it ships in production (the dev-gated part is only the ai/SquadViz.tsx visualizer).
// It owns no state of its own — ai/squadCoordinator.ts holds the module-scope published state; the
// mount just calls updateSquad() on a 10 Hz cadence off the physics step (so it pauses with the
// world and never runs faster than the units think) and resetSquad() on teardown.
//
// Phase 30 D1: the coordinator's flank-slot clamp now goes through the active NavProvider
// (ai/navProvider.ts), which the pursuit director mount publishes — so this mount is map-agnostic
// and needs no world prop. It works identically on the legacy 64×64 world and the Toronto map.
//
// MUST live inside <Physics> (the step hook only fires while the world is stepping — i.e. PLAYING)
// and be keyed on the world seed/run nonce alongside the city/director so the coordinator's
// published state tears down and rebuilds cleanly on regenerate/retry.

import { useEffect, useRef } from 'react';
import { useBeforePhysicsStep } from '@react-three/rapier';
import { resetSquad, updateSquad, SQUAD_STEPS_PER_UPDATE } from './squadCoordinator';

export function SquadMount() {
  const stepRef = useRef(0);

  // Clear any stale published claims on mount and on teardown (regenerate / retry / route away).
  useEffect(() => {
    resetSquad();
    return () => resetSquad();
  }, []);

  useBeforePhysicsStep(() => {
    // Throttle to the 10 Hz think cadence — the flank slots only need to track the player as often
    // as a unit re-decides, and the drivable clamp shouldn't run at 60 Hz.
    stepRef.current += 1;
    if (stepRef.current < SQUAD_STEPS_PER_UPDATE) return;
    stepRef.current = 0;
    updateSquad();
  });

  return null;
}
