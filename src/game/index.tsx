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
import { WORLD_SOURCE } from './config/worldSource';
import { getGameState, useGameStore } from './state/store';
import { useInputSystem } from './input';
import { AiSystem, CameraFxSystem, EventDrainSystem } from './core/frameOrder';
import { PropDynamics } from './world/PropDynamicsMount';
import { DamageSystem } from './combat/damage';
import { onImpact } from './combat/contacts';
import { TorontoPursuitDirector } from './ai/SpawnDirectorMount';
import { HeliMount } from './ai/HeliMount';
import { HeliMesh } from './ai/HeliMesh';
import { Searchlight } from './fx/Searchlight';
import { SquadMount } from './ai/SquadMount';
import { PoliceMesh } from './ai/units/PoliceMesh';
import { ArmoredMesh } from './ai/units/ArmoredMesh';
import { SwatMesh } from './ai/units/SwatMesh';
import { GunTruckMesh } from './ai/units/GunTruckMesh';
import { ProjectilesMount } from './combat/ProjectilesMount';
import { Tracers } from './fx/Tracers';
import { Explosions } from './fx/Explosions';
import { TankTelegraph } from './fx/TankTelegraph';
import { TankMesh } from './ai/units/TankMesh';
import { ParticlesMount } from './fx/ParticlesMount';
import { DamageStatesMount } from './fx/damageStates';
import { initEventFx } from './fx/eventFx';
import { initGameAnalytics } from './analytics';
import GameOver from './hud/GameOver';
import { SirensSystem } from './audio/SirensSystem';
import { PositionalAudioSystem } from './audio/PositionalAudioSystem';
import { HeatScoreSystem } from './state/heatScoreSystem';
import { initProgressPersistence } from './state/persistence';
import { initPowerGrid } from './powergrid/grid';
import { initEventMap } from './audio/eventMap';
import { PowerGridSystem } from './powergrid/PowerGridMount';
import Hud from './hud/Hud';
import ContextLossOverlay from './hud/ContextLossOverlay';
import { ContextLossSystem } from './core/ContextLossMount';
import { startQualityProbe } from './core/quality';
import { SkidMarks } from './fx/SkidMarks';
import { PlayerVehicle } from './vehicles/PlayerVehicle';
import { PlayerCarMesh } from './vehicles/PlayerCarMesh';
import { applyDetectedQuality } from './core/quality';
import { GarageOverlay } from './GarageOverlay';
// Phase 32 (the flip, config/worldSource.ts): the Toronto "thermometer" map IS the shipped
// world — mounted unconditionally below, no toggle involved.
import { TorontoScene } from './world/toronto/TorontoScene';
import { TorontoTraffic } from './world/toronto/TorontoTraffic';
import { TorontoTransit } from './world/toronto/TorontoTransit';
import { TORONTO_SPAWN_POSE } from './world/toronto/torontoSceneHelpers';
import { TORONTO_DISTRICT_COUNT } from './world/toronto/districts';
// Pure/seed-independent (world/toronto/roadGraph.ts's own doc comment) — cheap enough to build
// again here for the dev-only GraphViz overlay below; TorontoTraffic.tsx builds its own copy for
// the real civilian controller, so this is a second, independent memoization, not a shared ref.
import { buildTorontoRoadGraph } from './world/toronto/roadGraph';
import { buildStreets } from './world/toronto/streets';
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
const GunTruckAimViz = import.meta.env.DEV ? lazy(() => import('./ai/GunTruckAimViz')) : null;
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

// Phase 32 (the flip): the render tree below has no legacy branch to fall back to — every
// legacy-world import (CityScape, the legacy Traffic/StreetcarTraffic controllers, the
// generator) was removed from this file so tree-shaking drops that code from the built game
// chunk (bundle-verified in phase-32-notes.md). Fail loudly at import time rather than
// silently booting a broken game if WORLD_SOURCE is ever set to anything else.
if (WORLD_SOURCE !== 'toronto') {
  throw new Error(
    `WORLD_SOURCE=${WORLD_SOURCE}: only 'toronto' is wired into game/index.tsx's render tree ` +
      '(Phase 32 flip) — see config/worldSource.ts.',
  );
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
  const aimVizOn = useDevToggle('aimViz');
  const squadVizOn = useDevToggle('squadViz');
  // Phase 32: the dev-only graph visualizer now draws the ACTUAL shipped road graph (Toronto's),
  // not a `world` prop from a generator that no longer runs. Pure/seed-independent, so an empty
  // deps array is correct (same memoization TorontoTraffic.tsx uses for its own copy).
  const torontoGraph = useMemo(() => buildTorontoRoadGraph(buildStreets().streets), []);

  // Retry/regenerate nonce (TDD §5.4): the store's seed + runId together key every physical-world
  // mount below (city colliders, traffic pools, pursuit units, the player vehicle). Changing the
  // store seed (future garage UI) or runReset bumping runId (same-seed retry) remounts the whole
  // physical world — @react-three/rapier tears down and rebuilds colliders, nothing incrementally
  // mutates, no leak surface.
  const seed = useGameStore((s) => s.seed);
  const runId = useGameStore((s) => s.runId);
  // Phase 17: keys the player mount (below) so picking a different car in the garage
  // remounts the vehicle with that car's collider/controller params. Safe to subscribe
  // here — it only ever changes outside PLAYING (garage/dev bridge), never per frame.
  const selectedCarId = useGameStore((s) => s.selectedCarId);
  const worldKey = `${seed}-${runId}`;
  // Player spawn: Yonge between Dundas and Queen, southbound lane (config/torontoMap.ts's
  // TORONTO_SPAWN — see its doc comment for the Phase 32 D3 relocation). Read once at
  // PlayerVehicle mount (keyed on worldKey). TorontoScene itself publishes this pose to
  // spawnPoseRef so devPanel teleports stay coherent.
  const spawn = TORONTO_SPAWN_POSE;

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

  // Power grid (Phase 13): transformerDestroyed -> blackout + DARK CITY. Re-inits per
  // world/run so district state always matches the freshly-lit remounted city. Phase 29: the
  // Toronto map has 15 districts (world/toronto/districts.ts), not the legacy 4x4 grid's 16.
  useEffect(() => initPowerGrid(TORONTO_DISTRICT_COUNT), [worldKey]);

  // Audio event mapping (Phase 15): every gameplay event -> synthesized sound via the
  // manager seam; game-lifetime subscription.
  useEffect(() => initEventMap(), []);

  // Particle event wiring (Phase 16): transformerDestroyed/propDestroyed -> spark/debris
  // bursts through the particle feed; game-lifetime subscription like the audio map.
  useEffect(() => initEventFx(), []);

  // Analytics events (Phase 20): runStarted/runEnded/darkCity -> Vercel Analytics via the
  // typed event catalog; no-ops in dev and under webdriver (see game/analytics.ts).
  useEffect(() => initGameAnalytics(), []);

  // Quality FPS probe (Phase 18): after the machine first reaches GARAGE, sample ~2 s of
  // frame deltas on the live scene and demote the tier if the device can't hold it. An
  // explicit user pick in the pause menu (qualitySource 'user') is never overridden.
  useEffect(() => startQualityProbe(), []);

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
        onCreated={({ camera, gl }) => {
          camera.lookAt(0, 0, 0);
          // The REAL <canvas> carries the img role/label (Phase 20 QA FILED-2) — the
          // shell wrapper is a region so the garage/pause/game-over controls stay
          // exposed to assistive tech.
          gl.domElement.setAttribute('role', 'img');
          gl.domElement.setAttribute('aria-label', '3D driving game canvas');
        }}
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
            {/* WebGL context-loss listeners (Phase 18): pause + restore-overlay flag.
                Needs only R3F's gl — mounted with the frame-order systems. */}
            <ContextLossSystem />

            {/* Phase 32 (the flip): the Toronto map is the shipped world, mounted
                unconditionally — no toggle, no legacy alternative branch. TorontoScene owns
                the ground/water/roads/signposts/tunnel/camera-clamp and carries its own
                RunLoopSystem for the water-death path. Everything below is the world-agnostic
                gameplay spine (destruction, heat/score, damage-state FX, particles, skidmarks,
                power-grid flicker) plus the full pursuit + combat-escalation stack: the pursuit
                unit meshes register their factories + drive their per-step tick lists;
                TorontoPursuitDirector owns spawn/despawn/caps AND publishes the Toronto
                NavProvider (road-follow + squad flank-clamp read it); TankMesh/Explosions/
                TankTelegraph are mounted explicitly (Phase 16's integration-gap lesson: PROVE
                they mount, don't assume) and the ambient heli trio (grid-independent
                searchlight — the money shot reads over dark-district ground tints). */}
            <TorontoScene key={`toronto-${worldKey}`} />
            <TorontoTraffic key={`toronto-traffic-${worldKey}`} />
            {/* Phase 31 (Part-8 D1-D5): TTC-homage transit — buses + streetcars on real
                route numbers/streets, wreckable, tier-scaled roster. Same key convention as
                every other seed-scoped Toronto mount. */}
            <TorontoTransit key={`toronto-transit-${worldKey}`} />
            <DamageSystem key={`damage-${worldKey}`} />
            <PropDynamics key={`props-${worldKey}`} source={onImpact} />
            <HeatScoreSystem />
            <DamageStatesMount key={`dmgstates-${worldKey}`} />
            <ParticlesMount key={`particles-${worldKey}`} />
            <SkidMarks />
            <PowerGridSystem key={`grid-${worldKey}`} />
            <PoliceMesh key={`toronto-police-${worldKey}`} />
            <ArmoredMesh key={`toronto-armored-${worldKey}`} />
            <SwatMesh key={`toronto-swat-${worldKey}`} />
            <GunTruckMesh key={`toronto-guntruck-${worldKey}`} />
            <TankMesh key={`toronto-tank-${worldKey}`} />
            <ProjectilesMount key={`toronto-projectiles-${worldKey}`} />
            <Tracers key={`toronto-tracers-${worldKey}`} />
            <Explosions key={`toronto-explosions-${worldKey}`} />
            <TankTelegraph />
            <TorontoPursuitDirector key={`toronto-director-${worldKey}`} seed={seed} />
            <SquadMount key={`toronto-squad-${worldKey}`} />
            <HeliMount />
            <HeliMesh />
            <Searchlight />
            {/* key: spawn position is read once at body create (PlayerVehicle contract),
                and (Phase 17) the car's collider/controller params are resolved once at
                mount from getSelectedCarDef() — so the key carries BOTH the world/run
                nonce AND the selected car id: regenerate, retry, or picking a different
                car in the garage each force a full remount with fresh physics. The mesh
                switcher (PlayerCarMesh) reads the same store field, so paint and
                collider can never disagree. */}
            <PlayerVehicle
              key={`player-${worldKey}-${selectedCarId}`}
              position={[spawn.position.x, spawn.position.y, spawn.position.z]}
            >
              <PlayerCarMesh />
            </PlayerVehicle>

            {PerfOverlay ? (
              <Suspense fallback={null}>
                <PerfOverlay />
              </Suspense>
            ) : null}

            {GunTruckAimViz && aimVizOn ? (
              <Suspense fallback={null}>
                <GunTruckAimViz />
              </Suspense>
            ) : null}
            {GraphViz && graphVizOn ? (
              <Suspense fallback={null}>
                <GraphViz graph={torontoGraph} />
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
      <ContextLossOverlay />
      <GameOver />
      <SirensSystem />
      <PositionalAudioSystem />

      {DevPanel ? (
        <Suspense fallback={null}>
          <DevPanel />
        </Suspense>
      ) : null}
    </>
  );
}
