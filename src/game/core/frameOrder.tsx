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
import type { PerspectiveCamera } from 'three';
import { updateCameraRig } from '../fx/cameraRig';
import { hasExternalRenderOwner } from './renderOwner';

/**
 * useFrame priority scheme for the game's render loop.
 *
 * IMPORTANT (R3F semantics, verified in node_modules): R3F performs its automatic scene
 * render at the end of every frame *only while no useFrame subscription has a priority > 0*
 * (@react-three/fiber 9.6.1: `if (!state.internal.priority && state.gl.render)
 * gl.render(state.scene, state.camera)`). `internal.priority` counts positive-priority
 * useFrame subscriptions on THIS canvas root; the moment one registers, R3F hands rendering
 * over and the highest-priority callback (they run sorted, so it fires last) must call
 * `gl.render()` itself.
 *
 * Phase 3 raises `cameraFx` **0 → 1**: the camera rig runs late (after interpolated
 * transforms are written) and CameraFxSystem performs the explicit `gl.render()`. It does
 * so in *every* build — there is no r3f-perf handoff, contrary to an earlier assumption:
 * r3f-perf 7.2.3's <Perf/> mounted here (PerfHeadless) only uses addEffect/addAfterEffect,
 * which never touch this canvas's `internal.priority`, and its priority-Infinity
 * `gl.render()` lives in a *separate nested graph <Canvas>* (HtmlMinimal → createRoot),
 * so it renders the tiny FPS-graph scene, NOT this one. Net: this scene is rendered only by
 * whoever owns priority here — i.e. CameraFxSystem — so it must always render (guarded only
 * against a *future* higher-priority main-scene owner via renderOwner.ts). Do not lower
 * this back to 0 without removing the manual render, or nothing would paint.
 */
// Intentional mixed module: the frame-order system components (which render null, so Fast
// Refresh isn't meaningful for them) are paired with the priority constant they share.
// Phase 3+ imports FRAME_PRIORITY from here.
// eslint-disable-next-line react-refresh/only-export-components
export const FRAME_PRIORITY = {
  cameraFx: 1,
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
 * Camera rig + FX + audio pass. Owners: Phase 3 (follow camera + shake), Phase 16
 * (FX/juice), Phase 15 (audio). Runs as a late priority-1 `useFrame` (see
 * FRAME_PRIORITY.cameraFx) after physics interpolation has written render transforms, then
 * OWNS the main-scene render (R3F no longer auto-renders once priority > 0). The render is
 * unconditional except while a higher-priority system owns it (hasExternalRenderOwner) — so
 * GARAGE/LOADING still paint even though updateCameraRig leaves the camera untouched then.
 */
export function CameraFxSystem(): null {
  useFrame((state, delta) => {
    updateCameraRig(state.camera as PerspectiveCamera, delta);
    // Phase 16+: FX + positional audio hook in here (before the render).
    if (!hasExternalRenderOwner()) {
      state.gl.render(state.scene, state.camera);
    }
  }, FRAME_PRIORITY.cameraFx);
  return null;
}
