// Heat/score frame-order system (Phase 8 Task 1). Mirrors core/frameOrder.tsx's null-
// rendering "system component" style (AiSystem/EventDrainSystem/CameraFxSystem) and
// combat/damage.ts's DamageSystem (event-subscription mount via useEffect) — this one
// combines both patterns because it owns two concerns:
//
//   1. Mount-lifetime event wiring: state/heat.ts's initHeatSystem() and
//      state/score.ts's initScoreSystem() subscribe gameEvents → store actions for as
//      long as this component is mounted.
//   2. Fixed-step accrual: PLAYING-only, driven from useAfterPhysicsStep (TDD §6 frame
//      order: "drain contact events → damage/heat resolvers" — accrual is a heat/score
//      resolver that runs every physics step, not tied to any single contact event).
//      Runs at the physics step size (1/60 s — matches <Physics timeStep={1/60}> in
//      game/index.tsx, same convention as world/propDynamics.ts's PHYSICS_STEP_SEC)
//      rather than useFrame's variable `delta`, so accrual advances in lockstep with
//      simulation time and — for free — stops entirely while PAUSED, since Rapier's step
//      loop simply doesn't run then (no explicit pause branch needed here beyond the
//      PLAYING gate, which also covers GARAGE/GAMEOVER/BOOT/LOADING/PAUSED alike).
//
// MUST live inside <Physics> (useAfterPhysicsStep reads the Rapier context) — the
// orchestrator mounts it alongside AiSystem/EventDrainSystem/CameraFxSystem/DamageSystem
// in game/index.tsx.
import { useEffect } from 'react';
import { useAfterPhysicsStep } from '@react-three/rapier';
import { accruePassive, initHeatSystem } from './heat';
import { accrueRisk, initScoreSystem } from './score';
import { getGameState } from './store';

/** Matches <Physics timeStep={1/60}> (game/index.tsx) — see file header. */
const FIXED_STEP_SEC = 1 / 60;

export function HeatScoreSystem(): null {
  useEffect(() => {
    const offHeat = initHeatSystem();
    const offScore = initScoreSystem();
    return () => {
      offHeat();
      offScore();
    };
  }, []);

  useAfterPhysicsStep(() => {
    if (getGameState().machine !== 'PLAYING') return;
    accruePassive(FIXED_STEP_SEC);
    accrueRisk(FIXED_STEP_SEC);
  });

  return null;
}
