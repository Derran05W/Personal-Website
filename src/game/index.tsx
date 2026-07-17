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

import { lazy, Suspense, useEffect, useMemo, type CSSProperties } from 'react';
import { Canvas } from '@react-three/fiber';
import { Physics } from '@react-three/rapier';
import { useProgress } from '@react-three/drei';
import { QUALITY_TIERS } from './config';
import { getGameState, useGameStore } from './state/store';
import { useInputSystem } from './input';
import { AiSystem, CameraFxSystem, EventDrainSystem } from './core/frameOrder';
import { generate } from './world/generate';
import { getSpawnPose } from './world/spawn';
import { CityScape } from './world/CityScape';
import { PropDynamics } from './world/PropDynamicsMount';
import { DamageSystem } from './combat/damage';
import { onImpact } from './combat/contacts';
import { Traffic } from './ai/TrafficMount';
import { TrafficMesh } from './ai/TrafficMesh';
import { RunLoopSystem } from './combat/runLoop';
import { SpawnDirector } from './ai/SpawnDirectorMount';
import { SquadMount } from './ai/SquadMount';
import { PoliceMesh } from './ai/units/PoliceMesh';
import { ArmoredMesh } from './ai/units/ArmoredMesh';
import { SwatMesh } from './ai/units/SwatMesh';
import GameOver from './hud/GameOver';
import { SirensSystem } from './audio/SirensSystem';
import { HeatScoreSystem } from './state/heatScoreSystem';
import { initProgressPersistence } from './state/persistence';
import Hud from './hud/Hud';
import { SkidMarks } from './fx/SkidMarks';
import { PlayerVehicle } from './vehicles/PlayerVehicle';
import { RustySedanMesh } from './vehicles/RustySedanMesh';
import { applyDetectedQuality } from './core/quality';
import { GarageOverlay } from './GarageOverlay';
// Dependency-free (no leva/three-heavy deps), same as core/renderOwner.ts — safe to import
// unconditionally here even though this file ships in every build; only the DEV-gated
// components below (Minimap, GraphViz) that CONSUME these are what actually get stripped
// from prod.
import { useDevToggle } from './core/devToggles';

// Dev-only overlays, code-split so leva / r3f-perf never enter a production chunk. The
// `import.meta.env.DEV ? … : null` guard is a compile-time constant in prod builds
// (esbuild folds `false ? … : null` → `null`), so the dynamic import() in the dead branch
// is eliminated and its chunk is never emitted. (Verified via the prod-bundle grep audit.)
const DevPanel = import.meta.env.DEV ? lazy(() => import('./core/devPanel')) : null;
const PerfOverlay = import.meta.env.DEV ? lazy(() => import('./core/PerfOverlay')) : null;
// Dev minimap (DOM overlay, mounted alongside DevPanel below) and in-scene traffic-graph
// visualizer (mounted alongside PerfOverlay, inside <Physics>) — both leva-toggle-gated
// (core/devToggles.ts) on top of this DEV guard.
const Minimap = import.meta.env.DEV ? lazy(() => import('./hud/Minimap')) : null;
const GraphViz = import.meta.env.DEV ? lazy(() => import('./world/GraphViz')) : null;
// In-scene SWAT-squad flank visualizer (Phase 10), same DEV-guard + leva-toggle pattern as
// GraphViz — the coordinator itself (SquadMount) always ships; only this overlay is dev-only.
const SquadViz = import.meta.env.DEV ? lazy(() => import('./ai/SquadViz')) : null;

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

  // Reactive read of the leva "graphViz" toggle (core/devToggles.ts) — always false/no-op
  // in prod (nothing ever calls setDevToggle there), cheap enough to call unconditionally.
  const graphVizOn = useDevToggle('graphViz');
  const squadVizOn = useDevToggle('squadViz');

  // The generated city (TDD §5.4): pure data, ~1–2 ms, memoized per seed. Changing the
  // store seed (leva "World" folder / future garage UI) regenerates here, and the
  // key={seed} on CityScape + PlayerVehicle below remounts the whole physical world —
  // colliders torn down and rebuilt by @react-three/rapier, player dropped at the new
  // map's spawn tile. No incremental mutation, no leak surface.
  const seed = useGameStore((s) => s.seed);
  // Retry nonce: runReset bumps runId so a same-seed retry still fully remounts the
  // physical world (fresh props/pools/units — the part-file "full clean reset").
  const runId = useGameStore((s) => s.runId);
  const worldKey = `${seed}-${runId}`;
  const world = useMemo(() => generate(seed), [seed]);
  const spawn = useMemo(() => getSpawnPose(world), [world]);

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

  // Best/lifetime score persistence (Phase 8): subscribes runEnded for the game's whole
  // mounted lifetime; unsubscribes on route-away unmount.
  useEffect(() => initProgressPersistence(), []);

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

            <CityScape key={`city-${worldKey}`} world={world} />
            {/* Destruction spine (Phase 6): impacts flow contacts→damage/propDynamics.
                Keyed on seed like the city — a regenerate must reset the pool + hp state
                with the world it belongs to. */}
            <DamageSystem key={`damage-${worldKey}`} />
            <PropDynamics key={`props-${worldKey}`} source={onImpact} />
            {/* Civilian traffic (Phase 7): kinematic graph-followers + hit conversion.
                Same seed-keyed remount contract as the city/pool systems. */}
            <Traffic key={`traffic-${worldKey}`} graph={world.graph} seed={seed} source={onImpact} />
            <TrafficMesh key={`traffic-mesh-${worldKey}`} />
            {/* Pursuit (Phase 9): PoliceMesh registers the unit factory + drives the
                per-step tick list; the director owns spawn/despawn/caps. Run-loop owns
                WRECKED/BUSTED/water → GAMEOVER. All keyed on the retry nonce. */}
            <PoliceMesh key={`police-${worldKey}`} />
            <ArmoredMesh key={`armored-${worldKey}`} />
            <SwatMesh key={`swat-${worldKey}`} />
            <SpawnDirector key={`director-${worldKey}`} world={world} seed={seed} />
            {/* SWAT-squad flank coordinator (Phase 10): publishes flank-slot claims SWAT units
                read to box in the player. Gameplay infra (ships), keyed like the director. */}
            <SquadMount key={`squad-${worldKey}`} world={world} />
            <RunLoopSystem key={`runloop-${worldKey}`} />
            {/* Heat/score accrual runs in fixed-step land (Phase 8) — pausing Physics
                pauses accrual for free. */}
            <HeatScoreSystem />
            <SkidMarks />
            {/* key: spawn position is read once at body create (PlayerVehicle contract) —
                remount on regenerate rather than mutate. */}
            <PlayerVehicle
              key={`player-${worldKey}`}
              position={[spawn.position.x, spawn.position.y, spawn.position.z]}
            >
              <RustySedanMesh />
            </PlayerVehicle>

            {PerfOverlay ? (
              <Suspense fallback={null}>
                <PerfOverlay />
              </Suspense>
            ) : null}

            {GraphViz && graphVizOn ? (
              <Suspense fallback={null}>
                <GraphViz world={world} />
              </Suspense>
            ) : null}

            {SquadViz && squadVizOn ? (
              <Suspense fallback={null}>
                <SquadViz />
              </Suspense>
            ) : null}
          </Physics>
        </Suspense>
      </Canvas>

      {Minimap ? (
        <Suspense fallback={null}>
          <Minimap />
        </Suspense>
      ) : null}

      {machine === 'LOADING' ? (
        <div style={overlayStyle} role="status" aria-live="polite" data-testid="game-asset-loading">
          <span style={visuallyHiddenStyle}>Loading game assets… {Math.round(progress)}%</span>
          <div style={barTrackStyle} aria-hidden="true">
            <div style={{ ...barFillStyle, width: `${progress}%` }} />
          </div>
        </div>
      ) : null}

      {machine === 'GARAGE' ? <GarageOverlay /> : null}

      {/* Gameplay HUD (Phase 8): DOM overlay, pointer-events none, self-gates to
          PLAYING/PAUSED, ≤10 Hz store sampling. */}
      <Hud />
      <GameOver />
      <SirensSystem />

      {DevPanel ? (
        <Suspense fallback={null}>
          <DevPanel />
        </Suspense>
      ) : null}
    </>
  );
}
