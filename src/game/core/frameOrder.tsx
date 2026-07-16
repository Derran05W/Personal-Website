// Frame-order scaffolding (TDD §6). These are null-rendering "system" components that
// pin the canonical per-frame execution order into the R3F/Rapier scheduling hooks. Each
// is a Phase-2 placeholder no-op; the doc comment on each names the phase that fills it in.
//
// Canonical order (TDD §6):
//
//   input
//     → AI tick (10 Hz decisions, cached between ticks)
//     → fixed-step physics (60 Hz, render-interpolated)
//     → drain Rapier contact-event queue
//     → damage / heat resolvers
//     → FX / audio
//     → render
//
// How that maps onto the available hooks:
//
//   | Canonical step            | Mechanism                                    | Owner phase |
//   |---------------------------|----------------------------------------------|-------------|
//   | input                     | DOM listeners in game/input, read per step   | Phase 2     |
//   | AI tick                   | useBeforePhysicsStep (forces before integrate)| Phase 7+   |
//   | fixed-step physics        | <Physics timeStep={1/60} interpolate>        | Phase 2     |
//   | contact drain + resolvers | useAfterPhysicsStep (queue drained post-step)| Phase 6+   |
//   | FX / audio / camera       | late useFrame (FRAME_PRIORITY.cameraFx)      | Phase 3+    |
//   | render                    | R3F automatic render (see FRAME_PRIORITY)    | Phase 2/3   |
//
// AiSystem and EventDrainSystem MUST be mounted inside <Physics> (their hooks read the
// Rapier context); CameraFxSystem only needs to be inside <Canvas>.

import { useFrame } from '@react-three/fiber';
import { useBeforePhysicsStep, useAfterPhysicsStep } from '@react-three/rapier';

/**
 * useFrame priority scheme for the game's render loop.
 *
 * IMPORTANT (R3F semantics): R3F performs its automatic scene render at the end of every
 * frame *only while no useFrame subscription has a priority > 0*. The instant any
 * subscription registers a positive priority, R3F hands rendering over — the
 * highest-priority callback is expected to call `gl.render()` itself
 * (@react-three/fiber: `if (!state.internal.priority && state.gl.render) gl.render(...)`).
 *
 * So `cameraFx` is intentionally **0** in Phase 2: the camera/FX pass is a no-op that
 * neither needs to run late nor owns the render, and keeping every priority at 0 lets
 * R3F auto-render the placeholder scene in *all* builds. (In dev, r3f-perf's <Perf/>
 * separately claims priority `Infinity` and does the manual render + measurement — but
 * production has no <Perf/>, so it must rely on R3F auto-render.)
 *
 * Phase 3 takes over the render loop: it raises `cameraFx` to a positive "late" value
 * (e.g. 1) so the camera rig + FX run after interpolated transforms are written, and
 * that same pass performs the explicit `gl.render()`. Do not raise this value until a
 * matching manual render exists, or production builds will render nothing.
 */
// Intentional mixed module: the frame-order system components (which render null, so Fast
// Refresh isn't meaningful for them) are paired with the priority constant they share.
// Phase 3+ imports FRAME_PRIORITY from here.
// eslint-disable-next-line react-refresh/only-export-components
export const FRAME_PRIORITY = {
  cameraFx: 0,
} as const;

/**
 * AI decision + steering tick. Future owners: Phase 7 (civilian traffic) and the pursuit
 * AI phases (10+). Runs in `useBeforePhysicsStep` so steering / throttle forces are
 * applied to bodies *before* Rapier integrates the step. Decisions cache at 10 Hz
 * (SPAWN.aiTickHz); forces apply every step. Placeholder no-op for Phase 2.
 */
export function AiSystem(): null {
  useBeforePhysicsStep(() => {
    // Phase 7+: run cached AI steering; apply forces to pursuit / civilian bodies.
  });
  return null;
}

/**
 * Contact-event drain + damage/heat resolvers. Future owners: Phase 6 (destruction
 * physics) and Phase 8/9 (damage, heat, score). Runs in `useAfterPhysicsStep` so the
 * Rapier contact-event queue is drained immediately after the step, then routed through
 * the entity registry to the damage/heat resolvers (TDD §6). Placeholder no-op for
 * Phase 2.
 */
export function EventDrainSystem(): null {
  useAfterPhysicsStep(() => {
    // Phase 6+: drain contact events → registry lookup → damage/heat resolvers → events.
  });
  return null;
}

/**
 * Camera rig + FX + audio pass. Future owners: Phase 3 (follow camera + shake), Phase 16
 * (FX/juice), Phase 15 (audio). Runs as a late `useFrame` (see FRAME_PRIORITY.cameraFx)
 * after physics interpolation has written render transforms. Placeholder no-op for
 * Phase 2.
 */
export function CameraFxSystem(): null {
  useFrame(() => {
    // Phase 3+: damped follow camera, look-ahead, impact shake; FX + positional audio.
  }, FRAME_PRIORITY.cameraFx);
  return null;
}
