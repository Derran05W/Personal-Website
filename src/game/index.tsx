// Real game entry (Phase 2). Owns the <Canvas>, the Rapier <Physics> world, the frame-
// order scaffolding, the BOOT→LOADING→GARAGE bootstrap seam, input attachment, and the
// dev-only tuning/perf overlays. GameCanvas.tsx (shell side) already wraps this default
// export in Suspense inside a `position:fixed; inset:0; z-index:0` container, so the
// <Canvas> here simply fills that parent.
//
// PAUSE MODEL (TDD §4.2/§7): pausing NEVER unmounts the canvas. The <Canvas> and its
// <Physics> stay mounted for the whole game lifetime; pause is expressed purely as
// `<Physics paused={machine !== 'PLAYING'}>` (Rapier stops stepping the world) plus
// game-side logic that keys off the machine state. The render loop keeps running while
// paused so the frozen scene still paints. Fixed timestep + interpolation are set
// explicitly on <Physics> (Rapier's defaults can differ): `timeStep={1/60}` gives the
// deterministic 60 Hz step the frame order assumes, `interpolate` smooths render frames
// between physics steps (TDD §7).

import { lazy, Suspense, useEffect, type CSSProperties } from 'react';
import { Canvas } from '@react-three/fiber';
import { Physics } from '@react-three/rapier';
import { useProgress } from '@react-three/drei';
import { QUALITY_TIERS } from './config';
import { getGameState, useGameStore } from './state/store';
import { useInputSystem } from './input';
import { AiSystem, CameraFxSystem, EventDrainSystem } from './core/frameOrder';
import { TestPlane } from './world/TestPlane';
import { PlayerVehicle } from './vehicles/PlayerVehicle';
import { RustySedanMesh } from './vehicles/RustySedanMesh';
import { applyDetectedQuality } from './core/quality';
import { GarageOverlay } from './GarageOverlay';

// Dev-only overlays, code-split so leva / r3f-perf never enter a production chunk. The
// `import.meta.env.DEV ? … : null` guard is a compile-time constant in prod builds
// (esbuild folds `false ? … : null` → `null`), so the dynamic import() in the dead branch
// is eliminated and its chunk is never emitted. (Verified via the prod-bundle grep audit.)
const DevPanel = import.meta.env.DEV ? lazy(() => import('./core/devPanel')) : null;
const PerfOverlay = import.meta.env.DEV ? lazy(() => import('./core/PerfOverlay')) : null;

// core/debugBridge.ts isn't a component (no default export for lazy()/Suspense to hang
// off of) — it's a side-effect module that assigns window.__smashy once loaded, purely
// for scripted (Playwright) verification. Same DEV-guard shape as the overlays above:
// `import.meta.env.DEV` folds to the literal `false` in prod builds, so this whole branch
// — dynamic import included — is dead-code-eliminated and never reaches a prod chunk.
if (import.meta.env.DEV) {
  void import('./core/debugBridge');
}

const overlayStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'flex-end',
  justifyContent: 'center',
  paddingBottom: '15vh',
  pointerEvents: 'none',
};

const barTrackStyle: CSSProperties = {
  width: 'min(280px, 60vw)',
  height: 4,
  borderRadius: 2,
  background: 'rgba(255, 255, 255, 0.15)',
  overflow: 'hidden',
};

const barFillStyle: CSSProperties = {
  height: '100%',
  borderRadius: 2,
  background: 'rgba(255, 255, 255, 0.7)',
  transition: 'width 120ms linear',
};

const visuallyHiddenStyle: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  border: 0,
};

export default function Game() {
  // Attach the keyboard input system for the game's whole lifetime (detaches on route
  // change away from Home, which unmounts this component). Contract: game/input/index.ts.
  useInputSystem();

  const machine = useGameStore((s) => s.machine);
  const quality = useGameStore((s) => s.settings.quality);

  // drei asset-load progress (TDD §4.3). No real assets stream this phase, so `active`
  // is false from the start and LOADING resolves to GARAGE in the next tick — the seam
  // is what matters here, not the (currently instant) duration.
  const progress = useProgress((s) => s.progress);
  const active = useProgress((s) => s.active);

  // One-shot auto quality detection. Idempotent (a persisted user choice short-circuits
  // it), so StrictMode's double-invoked mount effect is safe. Only the DPR cap is applied
  // this phase, reactively, via the <Canvas dpr> prop below.
  useEffect(() => {
    applyDetectedQuality();
  }, []);

  // Bootstrap seam: BOOT → LOADING → GARAGE. Every branch reads the *current* machine
  // state fresh from the store and only fires the transition it expects, so the store's
  // dev-mode invalid-transition throw can never trigger under StrictMode's double mount
  // (each run is a guarded no-op once the state has advanced).
  //
  // The `smashy:game-ready` CustomEvent is the shell's hero-reveal signal (Home.tsx
  // listens via plain DOM APIs — no game import, preserving the app/game boundary). It
  // fires exactly once per real LOADING → GARAGE arrival: on the second StrictMode
  // double-invoke pass `state.machine` already reads 'GARAGE', so this branch's guard
  // condition is false and the dispatch doesn't repeat. It DOES re-fire naturally on
  // route-away-then-back remounts, since hardReset() (input system unmount) resets the
  // store to BOOT and the whole seam replays — that's desired, not a bug.
  useEffect(() => {
    const state = getGameState();
    if (state.machine === 'BOOT') {
      state.transition('LOADING');
      return; // re-runs once the machine dep updates to LOADING
    }
    if (state.machine === 'LOADING' && !active) {
      state.transition('GARAGE');
      window.dispatchEvent(new CustomEvent('smashy:game-ready'));
    }
  }, [machine, active]);

  const dprCap = QUALITY_TIERS[quality].dprCap;

  return (
    <>
      <Canvas
        shadows
        dpr={[1, dprCap]}
        // Pre-PLAYING framing only (GARAGE/LOADING). Once a run starts, fx/cameraRig's
        // CameraFxSystem pass owns position + lookAt every frame (fixed-yaw follow rig,
        // TDD §5.3) and snaps to its ideal on the first PLAYING frame; fov/near/far
        // stay governed by this prop.
        camera={{ position: [18, 16, 18], fov: 45, near: 0.1, far: 1000 }}
        onCreated={({ camera }) => camera.lookAt(0, 0, 0)}
      >
        {/* Blue-hour-ish clear colour so lights/emissives will read later (TDD §8). */}
        <color attach="background" args={['#121a2b']} />

        {/* Asset-load suspense seam: future <useLoader> children suspend here while the
            DOM progress overlay (below) shows drei useProgress. */}
        <Suspense fallback={null}>
          <Physics timeStep={1 / 60} interpolate paused={machine !== 'PLAYING'}>
            {/* Frame-order scaffolding (TDD §6). AiSystem / EventDrainSystem must live
                inside <Physics> — their hooks read the Rapier context. */}
            <AiSystem />
            <EventDrainSystem />
            <CameraFxSystem />

            <TestPlane />
            <PlayerVehicle>
              <RustySedanMesh />
            </PlayerVehicle>

            {PerfOverlay ? (
              <Suspense fallback={null}>
                <PerfOverlay />
              </Suspense>
            ) : null}
          </Physics>
        </Suspense>
      </Canvas>

      {machine === 'LOADING' ? (
        <div style={overlayStyle} role="status" aria-live="polite" data-testid="game-asset-loading">
          <span style={visuallyHiddenStyle}>Loading game assets… {Math.round(progress)}%</span>
          <div style={barTrackStyle} aria-hidden="true">
            <div style={{ ...barFillStyle, width: `${progress}%` }} />
          </div>
        </div>
      ) : null}

      {machine === 'GARAGE' ? <GarageOverlay /> : null}

      {DevPanel ? (
        <Suspense fallback={null}>
          <DevPanel />
        </Suspense>
      ) : null}
    </>
  );
}
