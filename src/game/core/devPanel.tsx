// Dev-only leva tuning + debug panel. Code-split: game/index.tsx references this module
// only behind `import.meta.env.DEV ? lazy(() => import('./core/devPanel')) : null`, so the
// constant-false branch in production strips the dynamic import and leva never lands in a
// prod chunk. Rendered in the DOM tree (outside <Canvas>) — <Leva> is an HTML overlay.
//
// This panel is the shared debug surface that EVERY later gameplay phase extends (force
// tier, grant heat, spawn unit X, blackout district, teleport, invincible, chaos bench…),
// so it is structured around a top-level "Debug" folder plus auto-generated config folders.

import { useEffect, useState, type CSSProperties } from 'react';
import { Quaternion, Euler, Color } from 'three';
import { useControls, folder, button, monitor, Leva } from 'leva';
import { getGameState, useGameStore } from '../state/store';
import { canTransition, TRANSITIONS } from '../state/machine';
import { CONFIG, QUALITY_TIERS, type QualityTier } from '../config';
import { playerVehicle } from '../vehicles/playerRef';
import { spawnPoseRef } from '../world/spawn';
import type { VehiclePose } from '../vehicles/IVehicleModel';
import { getDevToggles, setDevToggle } from './devToggles';
import { loadProgress, resetProgress, unlockAllCars } from '../state/persistence';
import { trafficRef } from '../ai/trafficTypes';
import { unitsRef, type UnitSlot } from '../ai/pursuitTypes';
import {
  forceBustedGameOver,
  blackoutDistrict,
  blackoutAll,
  relightDistrict,
  relightAll,
  setForcedHeliTier,
  heliSlotsSummary,
} from './debugBridge';
import { startChaosBench } from '../ai/chaosBench';
import { ARCHETYPES } from '../world/archetypes';
import { DISTRICT_COUNT, setDistrictColor } from '../world/instancing';
import { derivePlacements } from '../world/propPlacements';
import {
  SOUND_NAMES,
  playEvent as playSound,
  registerAllEventSounds,
  stopAllLoops as stopAllAudioLoops,
  getEventMapSnapshot,
  type SoundName,
} from '../audio/eventMap';
import { worldRef } from '../world/worldRef';
import { landmarkTeleportPoints } from '../world/landmarkGen';
import { attachFxEmitter, pushFxBurst, type ParticlePreset } from '../fx/particleFeed';
import { getParticleStats } from '../fx/particles';

// Task 5 debug-tint colour: the ONE end-to-end proof that an archetype's district-grouped
// [start,count] ranges (world/instancing.ts) are correct — a single button recolours every
// instance in exactly one district, nothing else. Module-scope: one Color, reused per click.
const TINT_COLOR = new Color('#ff2222');

// Phase 15 Task 4 debug tooling: sound-test board -------------------------------------------
// Reasonable-for-a-preview param bag per SoundName (audio/synth.ts's SoundParams — a loose,
// all-optional bag, so passing fields a given builder ignores is harmless). Loop sounds
// (engine/ambienceCity/ambienceCrickets/transformerHum) fire via the exact same `playEvent`
// seam as everything else here — per the task brief ("a button per registered sound name...
// fire via playEvent") — which means repeated clicks stack additional loop voices (the 'loop'
// pool group is intentionally uncapped, config/audio.ts's VOICE_POOL_CAPS); "stop all loops
// (debug)" below is the cleanup button for exactly that.
const SOUND_PREVIEW_PARAMS: Record<SoundName, Record<string, unknown>> = {
  engine: { speed: 0.6, throttle: 0.5 },
  impact: { velocity: 0.6, variant: 1 },
  gunshot: {},
  shellLaunch: {},
  explosionNear: {},
  explosionFar: {},
  transformerHum: {},
  transformerZap: {},
  powerDownWhoomp: {},
  ambienceCity: { seed: 1 },
  ambienceCrickets: { seed: 7 },
  stingerTier1: { tier: 1 },
  stingerTier2: { tier: 2 },
  stingerTier3: { tier: 3 },
  stingerTier4: { tier: 4 },
  stingerTier5: { tier: 5 },
  stingerWrecked: {},
  stingerBusted: {},
  uiTick: { gain: 1 },
  squeak: {},
};

/** "spam test (30x mixed)": a hand-picked 10-name pattern repeated 3x so every capped pool
 * group (impact 6, gun 4, explosion 3, stinger 2 — config/audio.ts's VOICE_POOL_CAPS) gets
 * asked for MORE concurrent voices than its cap, proving refusal/eviction holds under a burst
 * rather than just a single fire-once click per sound. `ui` (cap 8) and the loop group
 * (uncapped) are included too so the button's own doc claim ("mixed events") is literal. */
const SPAM_MIX_PATTERN: readonly SoundName[] = [
  'impact',
  'impact',
  'impact',
  'gunshot',
  'gunshot',
  'explosionNear',
  'explosionFar',
  'stingerTier2',
  'stingerTier4',
  'uiTick',
];
const SPAM_MIX: readonly SoundName[] = [...SPAM_MIX_PATTERN, ...SPAM_MIX_PATTERN, ...SPAM_MIX_PATTERN];

// leva's `Schema` type isn't part of its public export surface; recover it structurally
// from `folder`'s first parameter (whose constraint IS Schema) so we never import an
// internal path. Dynamically-assembled schemas are built as Record<string, unknown> and
// handed over through a single `as unknown as LevaSchema` cast at each useControls call.
type LevaSchema = Parameters<typeof folder>[0];

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * The ONE write path for live config tuning. Config blocks are typed `as const` (deeply
 * readonly) yet are plain, mutable objects at runtime; this strips the readonly modifier
 * via a `Mutable<>` mapped-type cast so every consumer sees the tuned value immediately —
 * no `any`, lint-clean.
 */
function writeConfigLeaf(block: object, key: string, value: number | boolean): void {
  (block as Mutable<Record<string, number | boolean>>)[key] = value;
}

/**
 * Recursively turn a plain config block into a leva schema: number/boolean leaves become
 * live controls (onChange writes straight back into the block), nested plain objects
 * become collapsed sub-folders. Arrays of numbers (e.g. HEAT.tierThresholds, SPAWN.caps)
 * and string leaves (e.g. car names) are skipped — dev tooling favors readability over
 * completeness; tune those in code for now.
 */
function buildBlockSchema(block: Record<string, unknown>): Record<string, unknown> {
  const schema: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(block)) {
    if (typeof value === 'number' || typeof value === 'boolean') {
      schema[key] = {
        value,
        onChange: (next: number | boolean) => writeConfigLeaf(block, key, next),
      };
    } else if (Array.isArray(value)) {
      // Skipped by design (see doc comment above).
    } else if (value !== null && typeof value === 'object') {
      const nested = buildBlockSchema(value as Record<string, unknown>);
      if (Object.keys(nested).length > 0) {
        schema[key] = folder(nested as unknown as LevaSchema, { collapsed: true });
      }
    }
    // strings / functions: skipped.
  }
  return schema;
}

function buildConfigSchema(): Record<string, unknown> {
  const schema: Record<string, unknown> = {};
  for (const [blockName, block] of Object.entries(CONFIG)) {
    const inner = buildBlockSchema(block as Record<string, unknown>);
    if (Object.keys(inner).length > 0) {
      schema[blockName] = folder(inner as unknown as LevaSchema, { collapsed: true });
    }
  }
  return schema;
}

/**
 * Strips pitch/roll from a pose's rotation, keeping only yaw (rotation about world Y).
 * Backs the "flip recover" debug button: a car resting on its roof/side should come back
 * down right-side up, not just get nudged upward in whatever orientation it flipped to.
 */
function yawOnlyRotation(rotation: VehiclePose['rotation']): VehiclePose['rotation'] {
  const euler = new Euler().setFromQuaternion(
    new Quaternion(rotation.x, rotation.y, rotation.z, rotation.w),
    'YXZ',
  );
  const yaw = new Quaternion().setFromEuler(new Euler(0, euler.y, 0, 'YXZ'));
  return { x: yaw.x, y: yaw.y, z: yaw.z, w: yaw.w };
}

// Phase 9 Task 4 debug tooling: unit state overlay ------------------------------------------
// Small dev-only DOM list — same "plain fixed-position overlay, not an r3f scene" pattern as
// hud/Minimap.tsx (a 2D canvas would be overkill for a handful of text rows) — polling
// unitsRef.current at ~4 Hz (UNIT_OVERLAY_INTERVAL_MS) rather than every render/physics
// step, since this is a debugging aid, not part of the render loop. Lives inside this file
// (not a new hud/* component) so DevPanel's own already-DEV-gated mount
// (`import.meta.env.DEV ? lazy(() => import('./core/devPanel')) : null` in game/index.tsx)
// is the only wiring this needs — no separate mount point, no game/index.tsx edit.
const UNIT_OVERLAY_INTERVAL_MS = 250; // ~4 Hz.

const unitOverlayStyle: CSSProperties = {
  position: 'fixed',
  right: 8,
  top: 140, // clears core/PerfOverlay.tsx (top:70) and hud/Hud.tsx's star row (top:112).
  maxWidth: 260,
  maxHeight: '40vh',
  overflowY: 'auto',
  background: 'rgba(10, 14, 22, 0.65)',
  border: '1px solid rgba(255, 255, 255, 0.15)',
  borderRadius: 4,
  padding: '0.4rem 0.6rem',
  fontFamily: 'monospace',
  fontSize: '0.65rem',
  lineHeight: 1.5,
  color: 'rgba(245, 245, 245, 0.85)',
  pointerEvents: 'none',
  zIndex: 45, // above hud/Minimap.tsx (z-40); below Leva's own default z-index.
};

function distance2D(ax: number, az: number, bx: number, bz: number): number {
  return Math.hypot(ax - bx, az - bz);
}

interface UnitOverlayRow {
  readonly id: number;
  readonly kind: string;
  readonly behaviorLabel: string;
  readonly hp: number;
  readonly dist: number;
}

/** Distance-to-player is computed HERE, inside the poll tick (an effect/interval callback,
 * not render) — react-hooks' `refs` rule flags reading a ref's `.current` during render
 * (it can't tell the render apart from a stale value), so the row shape below already
 * carries the derived `dist` rather than raw player-position state read back out in JSX. */
function buildUnitOverlayRows(slots: readonly UnitSlot[], playerX: number, playerZ: number): UnitOverlayRow[] {
  return slots
    .filter((s) => s.kind !== null)
    .map((s) => ({
      id: s.id,
      kind: s.kind ?? '?',
      behaviorLabel: s.behaviorLabel,
      hp: s.hp,
      dist: distance2D(s.x, s.z, playerX, playerZ),
    }));
}

function UnitOverlay() {
  const [rows, setRows] = useState<readonly UnitOverlayRow[]>([]);

  useEffect(() => {
    const poll = () => {
      const api = unitsRef.current;
      const pose = playerVehicle.current?.readState().pose;
      const px = pose?.position.x ?? 0;
      const pz = pose?.position.z ?? 0;
      setRows(api ? buildUnitOverlayRows(api.slots, px, pz) : []);
    };
    poll();
    const id = window.setInterval(poll, UNIT_OVERLAY_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, []);

  if (rows.length === 0) return null;

  return (
    <div style={unitOverlayStyle} data-testid="unit-overlay">
      <div style={{ opacity: 0.7, marginBottom: 2 }}>pursuit units ({rows.length})</div>
      {rows.map((row) => (
        <div key={row.id}>
          #{row.id} {row.kind} · {row.behaviorLabel} · hp {Math.round(row.hp)} · {row.dist.toFixed(0)}m
        </div>
      ))}
    </div>
  );
}

/**
 * Grants exactly enough heat to reach `tier`'s threshold (config/heat.ts's
 * tierThresholds, index = tier); a no-op if the player is already at/above it — heat is
 * monotonic and never decays (locked design decision), so this can only ever move the
 * wanted level up, same as real play. Shared by the "set tier" dropdown and the Phase 10
 * "force tier N" buttons below: the dropdown is the general-purpose picker for a human
 * clicking through the panel, the buttons are the scriptable path — leva's own DOM is
 * canvas-occluded in headless Playwright, so a single-purpose button (like the existing
 * "+N heat" buttons) is what a scripted verification run can actually drive.
 */
function grantHeatToTier(tier: number): void {
  const state = getGameState();
  const target = CONFIG.HEAT.tierThresholds[tier];
  if (target === undefined) return;
  const delta = target - state.heat;
  if (delta > 0) state.addHeat(delta);
}

// Phase 16 Task 1 debug tooling: FX board -----------------------------------------------------
// Fires a particle preset (fx/particleFeed.ts → fx/particles.ts) ~6 m ahead of the player so a
// human can eyeball every effect on demand. Bursts fire once (impacts/debris/explosions/arc
// showers); emitters attach at the point and auto-release after a short demo window so the
// panel can preview persistent smokes/fire without leaving an orphan attached forever. The
// spawn point is the player's INTERPOLATED pose forward vector (its local +Z basis — identity
// yaw faces world +Z per this file's teleport helpers), lifted 0.8 m to chassis-ish height.
// No-op unless a run is live (playerVehicle set) AND fx/ParticlesMount.tsx is mounted to render
// what this spawns — the feed silently drops bursts with no consumer, by design.
const FX_DEMO_EMITTER_MS = 2500;

function fireFxAhead(preset: ParticlePreset): void {
  const pose = playerVehicle.current?.readState().pose;
  if (!pose) return;
  const q = pose.rotation;
  // Local +Z basis vector of the pose rotation, in world space (the car's forward).
  let fx = 2 * (q.x * q.z + q.w * q.y);
  let fz = 1 - 2 * (q.x * q.x + q.y * q.y);
  const len = Math.hypot(fx, fz) || 1;
  fx /= len;
  fz /= len;
  const ox = pose.position.x + fx * 6;
  const oy = pose.position.y + 0.8;
  const oz = pose.position.z + fz * 6;

  if (CONFIG.PARTICLES.presets[preset].kind === 'burst') {
    pushFxBurst(preset, ox, oy, oz, { intensity: 1 });
  } else {
    const emitter = attachFxEmitter(preset, ox, oy, oz);
    emitter.intensity = 1;
    window.setTimeout(() => emitter.release(), FX_DEMO_EMITTER_MS);
  }
}

export default function DevPanel() {
  // Subscribe to machine only: it drives which transition buttons are valid and the
  // read-only state display. Rebuilds the Debug folder via the [machine] dep below.
  const machine = useGameStore((s) => s.machine);

  // --- Debug folder: state machine control + quality override ---
  useControls(
    'Debug',
    () => {
      const schema: Record<string, unknown> = {
        'machine state': { value: machine, disabled: true },
        quality: {
          value: getGameState().settings.quality,
          options: Object.keys(QUALITY_TIERS),
          // leva fires onChange once during control REGISTRATION (context.initial) — that
          // spurious call must not write the store: at boot it can race
          // applyDetectedQuality() and stamp the pre-heuristic default ('high') with
          // setQuality's 'user' provenance, silencing the FPS probe forever (found live on
          // the Phase 18 mobile-emulation pass: iPhone profile booted high/'user'). Only a
          // real panel interaction may write.
          onChange: (q: string, _path: string, ctx: { initial: boolean }) => {
            if (ctx.initial) return;
            const state = getGameState();
            if (state.settings.quality !== q) state.setQuality(q as QualityTier);
          },
        },
      };
      // One button per *valid* transition out of the current state — every edge in the
      // TRANSITIONS table is reachable from the panel as the machine walks around.
      for (const to of TRANSITIONS[machine] ?? []) {
        schema[`→ ${to}`] = button(() => {
          const state = getGameState();
          // Guard: the machine may have moved between render and click (StrictMode / other
          // systems), so re-check before transitioning to avoid the store's dev-mode throw.
          if (canTransition(state.machine, to)) state.transition(to);
        });
      }

      // Live speed readout: a Function-form monitor() polls playerVehicle on its own
      // interval, so this stays accurate without a store subscription (per-frame vehicle
      // state deliberately never lives in zustand — see state/store.ts). Reads 0 until a
      // later task mounts the player vehicle; null-safe either way.
      schema['speed (m/s)'] = monitor(() => playerVehicle.current?.readState().speed ?? 0, {
        interval: 100,
      });

      // Flip recover: keep the vehicle's current XZ + yaw, lift it 1 m and drop the
      // pitch/roll so a car stuck on its roof (or wedged on a test-scene box) rights
      // itself. No-op if no run is live.
      schema['flip recover'] = button(() => {
        const vehicle = playerVehicle.current;
        if (!vehicle) return;
        const { position, rotation } = vehicle.readState().pose;
        vehicle.reset({
          position: { x: position.x, y: position.y + 1, z: position.z },
          rotation: yawOnlyRotation(rotation),
        });
      });

      // Teleport reset: back to spawn, identity yaw. No-op if no run is live.
      schema['teleport reset'] = button(() => {
        playerVehicle.current?.reset(spawnPoseRef.current);
      });

      // Phase 6 Task 4 debug tooling ------------------------------------------------------
      // "launch test prop" per the task brief: world/propDynamics.ts (the fixed->dynamic
      // swap + impulse pool, Task 2) is a concurrent sibling module that doesn't exist yet
      // in this wave, so a debug hook into it isn't buildable without depending on
      // unfinished internals. What IS cleanly buildable now: find the nearest parkedCar
      // placement to the player (derivePlacements() over the live world) and teleport the
      // player a driveable approach distance north of it, facing south (identity yaw) —
      // straight-line throttle drives the player into the car's front, so a human (or the
      // Playwright smoke) can ram it to verify the static collider today, and the dynamic
      // shove/tumble once Task 2 lands.
      schema['teleport near parked car'] = button(() => {
        const vehicle = playerVehicle.current;
        const world = worldRef.current;
        if (!vehicle || !world) return;
        const { position } = vehicle.readState().pose;
        const cars = derivePlacements(world).filter((p) => p.archetype === 'parkedCar');
        if (cars.length === 0) return;
        let nearest = cars[0];
        let bestDistSq = Infinity;
        for (const p of cars) {
          const distSq = (p.x - position.x) ** 2 + (p.z - position.z) ** 2;
          if (distSq < bestDistSq) {
            bestDistSq = distSq;
            nearest = p;
          }
        }
        const approachM = 3 + CONFIG.PROP_DIMS.parkedCar.bodyLengthM / 2;
        vehicle.reset({
          position: { x: nearest.x, y: position.y, z: nearest.z - approachM },
          rotation: { x: 0, y: 0, z: 0, w: 1 }, // identity yaw faces +Z (world south) — a
          // straight line south from here runs into the car regardless of its own facing.
        });
      });

      // TODO(Phase 6 Task 2 integration): world/propDynamics.ts doesn't exist yet this wave
      // (concurrent sibling task) — wake-all needs its dynamic-pool API. No-op until then;
      // the orchestrator wires this up once Task 2 lands.
      schema['wake all props'] = button(() => {});

      // TODO(Phase 6 Task 2 integration): placeholder 0 until world/propDynamics.ts exposes
      // getPoolStats() (concurrent sibling task, not built yet this wave).
      schema['prop pool occupancy'] = monitor(() => 0, { interval: 250 });

      // Phase 7 Task 2 debug tooling --------------------------------------------------
      // "traffic density": TRAFFIC_CIV.activeTarget is a plain number leaf on a CONFIG
      // registry block (config/index.ts), so the auto-built 'Config' folder below
      // (buildConfigSchema, driven off CONFIG) already exposes it live as
      // Config → TRAFFIC_CIV → activeTarget — a dedicated slider here would just be a
      // second control writing the exact same leaf, so it's deliberately skipped.
      //
      // trafficRef (ai/trafficTypes.ts) is null until ai/traffic.ts's mount runs (a
      // concurrent sibling task this wave) — both hooks below are null-safe no-ops until
      // then, same shape as the prop-pool placeholders just above.
      schema['spawn civilian here'] = button(() => {
        const vehicle = playerVehicle.current;
        if (!vehicle) return;
        const { position } = vehicle.readState().pose;
        trafficRef.current?.spawnAt(position.x, position.z);
      });
      schema['civilians'] = monitor(() => trafficRef.current?.activeCount() ?? 0, {
        interval: 250,
      });

      // Phase 8 Task 3 debug tooling — heat/score/persistence ---------------------------
      // getGameState().addHeat is a store action that has existed since Phase 2 (it's the
      // ONE write path for heat, monotonic-clamped there); Task 1 (concurrent this wave)
      // only extends what *calls* it (state/heat.ts's event→delta map) and wires it to the
      // real config, it doesn't touch the action's signature. Checked state/store.ts at
      // this task's runtime and confirmed addHeat is present and required (not optional)
      // on GameStoreState, so these call it directly rather than through an `addHeat?.()`
      // guard — there's nothing to guard against.
      schema['+10 heat'] = button(() => getGameState().addHeat(10));
      schema['+100 heat'] = button(() => getGameState().addHeat(100));

      // "set tier": grants exactly enough heat to reach the target tier's threshold
      // (config/heat.ts's tierThresholds, index = tier). Heat is monotonic and never
      // decays (locked design decision) — picking a tier at or below the current one
      // computes a <= 0 delta, and addHeat's own clamp turns that into a no-op, so this
      // can only ever move the wanted level up, same as real play.
      schema['set tier'] = {
        value: 0,
        options: CONFIG.HEAT.tierThresholds.map((_, tier) => tier),
        onChange: (tier: number) => grantHeatToTier(tier),
      };

      // Phase 10 Task 3: dedicated force-tier buttons for ★2/★3 (armored/SWAT composition
      // verification) — same grantHeatToTier as "set tier" above, just as single-purpose
      // buttons a headless script can drive without touching leva's own DOM controls.
      schema['force tier 2'] = button(() => grantHeatToTier(2));
      schema['force tier 3'] = button(() => grantHeatToTier(3));
      // Phase 12 Task 3: same seam, ★5 (tanks) verification.
      schema['force tier 5'] = button(() => grantHeatToTier(5));

      // Live run score (state/store.ts) vs. persisted meta-progression
      // (state/persistence.ts, written on `runEnded`) — the monitors below make the
      // save/load loop visible without leaving the game: play, smash things, watch
      // `score` climb; end the run and watch `best score`/`lifetime score` pick it up.
      schema['score'] = monitor(() => getGameState().score, { interval: 250 });
      schema['best score'] = monitor(() => loadProgress().bestScore, { interval: 250 });
      schema['lifetime score'] = monitor(() => loadProgress().lifetimeScore, { interval: 250 });
      schema['reset progress'] = button(() => resetProgress());
      // Phase 17 dev shortcut: whole roster unlocked in one click (persisted; "reset
      // progress" above is the undo). Emits carUnlocked per newly-added id, so the
      // garage reflects it live — no reload needed.
      schema['unlock all cars'] = button(() => unlockAllCars());

      // Phase 9 Task 4 debug tooling — police/game-over verification ------------------------
      // unitsRef (ai/pursuitTypes.ts) is null until ai/spawnDirector.ts's mount runs (a
      // concurrent sibling task this wave) — null-safe no-op until then, same shape as the
      // civilian-traffic hooks above.
      schema['force spawn police'] = button(() => {
        unitsRef.current?.forceSpawn('police');
      });
      // Phase 10 Task 3: same forceSpawn seam, generalized to the two Part 4 kinds this
      // phase adds. Armored/SWAT unit modules (ai/units/*, Task 2) register their factories
      // on their own schedule — before that, forceSpawn('armored'/'swat') is a no-op (the
      // director's factory-undefined guard returns false without throwing), so these
      // buttons are safe to click at any point in the build.
      schema['force spawn armored'] = button(() => {
        unitsRef.current?.forceSpawn('armored');
      });
      schema['force spawn swat'] = button(() => {
        unitsRef.current?.forceSpawn('swat');
      });
      // Phase 12 Task 3: same seam, ★5 tank. ai/units/tank.ts (Task 2, concurrent sibling)
      // registers its factory on its own schedule — until then this is a safe no-op, same
      // as the armored/swat buttons above were before Phase 10 Task 2 landed.
      schema['force spawn tank'] = button(() => {
        unitsRef.current?.forceSpawn('tank');
      });
      schema['pursuit units'] = monitor(() => unitsRef.current?.activeCount() ?? 0, {
        interval: 250,
      });
      // Composition readout: live counts per kind, straight off unitsRef's slots — the
      // human-facing mirror of what SPAWN_COMPOSITION/minPreferred (config/spawn.ts) are
      // actually producing at the current tier (e.g. "police:4 armored:2" at ★2, "police:3
      // armored:2 swat:3" at ★3 once armored/swat factories are registered).
      schema['composition'] = monitor(
        () => {
          const counts = new Map<string, number>();
          for (const s of unitsRef.current?.slots ?? []) {
            if (s.kind === null) continue;
            counts.set(s.kind, (counts.get(s.kind) ?? 0) + 1);
          }
          if (counts.size === 0) return 'none';
          return Array.from(counts.entries())
            .map(([kind, n]) => `${kind}:${n}`)
            .join(' ');
        },
        { interval: 250 },
      );

      // Invincible: writes ONLY the devToggles.ts flag (leva-free, safe to import from any
      // build) — it does not itself change gameplay. combat/damage.ts's applyPlayerDamage()
      // (Task 3/orchestrator-owned; not touched by this task) is the intended consumer —
      // see core/devToggles.ts's `invincible` doc comment for the full handoff.
      schema['invincible'] = {
        value: getDevToggles().invincible,
        onChange: (value: boolean) => setDevToggle('invincible', value),
      };

      // Kill player: store.setPlayerHp already exists as a public action (state/store.ts,
      // since Phase 2) — no new seam needed. Whatever run-ending logic watches playerHp
      // (combat/runLoop.ts, Task 3 this wave) reacts to this exactly like a real fatal hit.
      schema['kill player'] = button(() => getGameState().setPlayerHp(0));

      // Force BUSTED: see core/debugBridge.ts's forceBustedGameOver() doc comment for
      // exactly what this bypasses (the real speed/proximity detector) vs. what it drives
      // for real (gameEvents + store.transition, the same seams runLoop itself uses) — a
      // screen/flow verification shortcut, not a fake detector.
      schema['force BUSTED (debug)'] = button(() => forceBustedGameOver());

      // Phase 12 Task 3: tank-shell/explosion FX verification. Both call the real bridge
      // fns Task 1 owns (core/debugBridge.ts's window.__smashy.blastHere/fireShellAt —
      // combat/projectiles.ts's projectilesRef under the hood), not a re-implementation
      // here — see this task's brief ("do NOT duplicate Task 1's bridge fns"). Optional
      // chaining: safe no-op if debugBridge.ts's DEV-only dynamic import hasn't resolved
      // yet (a startup-order edge case, not a steady-state one — both modules load
      // together under import.meta.env.DEV).
      schema['blast here (debug)'] = button(() => {
        window.__smashy?.blastHere();
      });
      schema['fire shell at player (debug)'] = button(() => {
        window.__smashy?.fireShellAt();
      });

      // Phase 12 Task 4: standing perf-regression harness (ai/chaosBench.ts) — forces ★5,
      // fills the pursuit roster, auto-drives a ~60 s road-graph circuit, and prints a
      // budget report to the console (console.info, inside startChaosBench itself). This
      // button is just the trigger; the promise settles in the background (leva buttons
      // are synchronous onClick handlers) — a console.error surfaces any failure (e.g. no
      // world generated yet) since a leva button has nowhere else to show it.
      schema['chaos bench (★5, ~60s)'] = button(() => {
        console.info('[chaosBench] starting — ~60s, watch the console for the report…');
        startChaosBench().catch((err: unknown) => {
          console.error('[chaosBench] failed:', err);
        });
      });

      // Phase 14 Task 1: drive the ambient-heli lifecycle (ai/helicopter.ts) by tier directly,
      // WITHOUT granting heat — 'off' releases it back to the live heat-driven tier. Routed
      // through core/debugBridge.ts's setForcedHeliTier (heliDebugRef under the hood), a
      // null-safe no-op until ai/HeliMount.tsx is mounted. The livery/count per tier: ★0/★1
      // none, ★2 police, ★3 SWAT, ★4 military, ★5 two military. Lets a human (or the smoke
      // suite via window.__smashy.setForcedHeliTier) walk 2→3→4→5→2 and watch the swaps.
      schema['force heli tier'] = {
        value: 'off',
        options: ['off', '0', '1', '2', '3', '4', '5'],
        onChange: (v: string) => setForcedHeliTier(v === 'off' ? null : Number(v)),
      };
      // Live heli readout (effective tier + per-slot livery/presence/distance): watch a swap
      // fly out to the edge (distance climbs) and the new livery fly back in.
      schema['heli slots'] = monitor(() => heliSlotsSummary(), { interval: 250 });

      return schema as unknown as LevaSchema;
    },
    [machine],
  );

  // --- World folder: seed control + regenerate/randomize, dev-tool visibility toggles ---
  // Split into two useControls calls (both `deps: []`, so leva builds each schema exactly
  // once and never rebuilds it): leva's `useControls` re-fires every onChange with
  // `{initial: true}` whenever its schema is rebuilt (i.e. whenever `deps` changes) — so a
  // single call with `seed`'s onChange writing into a piece of React state that's ALSO in
  // that same call's `deps` is a feedback loop (typing/"randomize" → state changes → deps
  // change → schema rebuilds → onChange re-fires with whatever leva's store held at that
  // instant → can clobber the just-written value straight back to stale). Keeping `deps: []`
  // sidesteps that entirely: leva owns the field's live value itself once mounted, and
  // `getSeed`/`setSeed` (leva's own store accessors, returned because the schema arg is a
  // function — see leva's useControls.d.ts) read/write it directly, imperatively, without
  // ever needing this component to re-render or its schema to rebuild.
  //
  // `getSeed`/`setSeed` must come from an EARLIER, separate call: referencing a
  // useControls call's own return value inside a button defined by that SAME call trips
  // eslint-plugin-react-hooks' `immutability` rule (flagged as "used before declared" even
  // though the closure only runs on click, well after the const exists) — splitting into a
  // fields-only call followed by a buttons/toggles call keeps every reference strictly
  // textually-after its declaration.
  // `getWorldField` is the folder's generic (path-keyed) getter — used below for both
  // `seed` (regenerate/randomize) and `tintDistrict` (the Task 5 tint/blackout buttons),
  // per the doc comment above on why fields and buttons must live in separate calls.
  // Phase 19: teleport-to-landmark buttons. Reads the LIVE world (worldRef) each click so
  // the buttons track regenerations; lifts the car to the standard settle-safe height.
  useControls(
    'Landmarks',
    () => {
      const schema: Record<string, unknown> = {};
      const world = worldRef.current;
      const points = world ? landmarkTeleportPoints(world) : [];
      for (const p of points) {
        schema[`→ ${p.id}`] = button(() => {
          playerVehicle.current?.reset({
            position: { x: p.x, y: 0.85, z: p.z },
            rotation: { x: 0, y: 0, z: 0, w: 1 },
          });
        });
      }
      if (points.length === 0) schema['(no landmark layer)'] = { value: '', disabled: true };
      return schema as unknown as LevaSchema;
    },
    [worldRef.current],
  );

  const [, setSeed, getWorldField] = useControls(
    'World',
    () => ({
      seed: { value: getGameState().seed, step: 1 },
      // Task 5 debug proof target district (0..DISTRICT_COUNT-1, 4x4 grid): which
      // district the tint/blackout/relight buttons below act on.
      tintDistrict: { value: 0, min: 0, max: DISTRICT_COUNT - 1, step: 1 },
    }),
    [],
  );
  useControls(
    'World',
    () => ({
      // Changing the store's seed IS the regeneration trigger — the city subtree remounts
      // keyed on it (Task 3). This button (not the field's onChange) is what actually
      // fires it, so typing a seed never regenerates until asked to.
      regenerate: button(() => getGameState().setSeed(getWorldField('seed'))),
      // Math.random is fine here: a dev-only button, not part of generation itself.
      randomize: button(() => {
        const next = Math.floor(Math.random() * 0xffffffff);
        setSeed({ seed: next });
        getGameState().setSeed(next);
      }),
      minimap: {
        value: getDevToggles().minimap,
        onChange: (value: boolean) => setDevToggle('minimap', value),
      },
      graphViz: {
        value: getDevToggles().graphViz,
        onChange: (value: boolean) => setDevToggle('graphViz', value),
      },
      // Phase 10: in-scene SWAT-squad flank visualizer (ai/SquadViz.tsx) — posts at the two
      // flank slots + lines to their claimants.
      squadViz: {
        value: getDevToggles().squadViz,
        onChange: (value: boolean) => setDevToggle('squadViz', value),
      },
      // Phase 11 Task 3: in-scene LOS/aim visualizer for ★4 gun trucks (ai/GunTruckAimViz.tsx)
      // — one slot→player line per live gun truck, green (LOS clear) / red (blocked).
      aimViz: {
        value: getDevToggles().aimViz,
        onChange: (value: boolean) => setDevToggle('aimViz', value),
      },
      // Phase 13 Task 4: pooled dynamic-light position viz (minimap dots — see
      // core/devToggles.ts's lightPoolViz doc comment for why dots over an in-scene
      // marker set).
      lightPoolViz: {
        value: getDevToggles().lightPoolViz,
        onChange: (value: boolean) => setDevToggle('lightPoolViz', value),
      },
      // Task 5 district-range proof: fans over every archetype and writes exactly one
      // district's [start,count] slice. Eyeball adjacent districts in the result — only
      // `tintDistrict`'s district should change.
      'tint district (red)': button(() => {
        const d = getWorldField('tintDistrict');
        for (const name of ARCHETYPES) setDistrictColor(name, d, TINT_COLOR);
      }),
      // Phase 13 Task 4: blackout/relight one district, or every district at once — routed
      // through core/debugBridge.ts's blackoutDistrict/blackoutAll/relightDistrict/
      // relightAll so the devPanel, the minimap overlay, and window.__smashy all observe
      // the same lit/dark state, real +12 heat, and (once wired) real DARK CITY at 16/16 —
      // see that module's doc comment for exactly what each button drives.
      'blackout district': button(() => blackoutDistrict(getWorldField('tintDistrict'))),
      'relight district': button(() => relightDistrict(getWorldField('tintDistrict'))),
      'blackout ALL': button(() => blackoutAll()),
      'relight ALL': button(() => relightAll()),
    }),
    [],
  );

  // --- Toronto map (P22): drivable dev slice toggle -----------------------------------------
  // Swaps the 64×64 legacy world for world/toronto/TorontoScene.tsx (game/index.tsx reads the
  // devToggles flag, joins it to the world remount key, and renders the slice when on). Same
  // leva-free devToggles seam as the World folder's minimap/graphViz toggles.
  useControls(
    'Toronto map (P22)',
    () => ({
      torontoMap: {
        value: getDevToggles().torontoMap,
        onChange: (value: boolean) => setDevToggle('torontoMap', value),
      },
      note: { value: 'drivable dev slice; legacy world untouched when off', disabled: true },
    }),
    [],
  );

  // --- Audio folder: Phase 15 Task 4 sound-test board ---------------------------------------
  // registerAllEventSounds() is idempotent (audio/eventMap.ts) and cheap (no audio plays until
  // a button is actually clicked) — calling it here means this folder works standalone even
  // before the orchestrator's integration pass mounts the real `initEventMap()` lifecycle into
  // the live game tree. A leva button click is itself a real DOM user gesture, so the very
  // first click here can unlock the shared AudioContext on its own (manager.ts's `playEvent`
  // already falls back to a lazy `unlockAudioContext()` for exactly this "reached outside the
  // normal PLAYING-entry trigger" case) — no separate "unlock audio" step needed.
  useEffect(() => {
    registerAllEventSounds();
  }, []);

  useControls(
    'Audio',
    () => {
      const schema: Record<string, unknown> = {};
      for (const name of SOUND_NAMES) {
        schema[name] = button(() => playSound(name, SOUND_PREVIEW_PARAMS[name]));
      }
      schema['spam test (30x mixed)'] = button(() => {
        for (const name of SPAM_MIX) playSound(name, SOUND_PREVIEW_PARAMS[name]);
        console.info('[audio] spam test fired 30 events — snapshot:', getEventMapSnapshot());
      });
      schema['stop all loops (debug)'] = button(() => stopAllAudioLoops());
      schema['live voices'] = monitor(() => getEventMapSnapshot().liveVoiceTotal, { interval: 200 });
      schema['bus gains'] = monitor(
        () => {
          const g = getEventMapSnapshot().busGains;
          return `m${g.master.toFixed(2)} sfx${g.sfx.toFixed(2)} eng${g.engine.toFixed(2)} amb${g.ambient.toFixed(2)}`;
        },
        { interval: 200 },
      );
      return schema as unknown as LevaSchema;
    },
    [],
  );

  // --- FX BOARD: Phase 16 particle-system preview + pool monitor ---------------------------
  // One button per ParticlePreset (fires ~6 m ahead of the player via fireFxAhead) plus a
  // live pool-utilization / draw-call readout straight off fx/particles.ts's getParticleStats.
  // Only renders anything once the orchestrator mounts fx/ParticlesMount.tsx (see fireFxAhead).
  useControls(
    'FX BOARD',
    () => {
      const schema: Record<string, unknown> = {};
      for (const preset of Object.keys(CONFIG.PARTICLES.presets) as ParticlePreset[]) {
        schema[preset] = button(() => fireFxAhead(preset));
      }
      schema['particles (live/pool)'] = monitor(
        () => {
          const s = getParticleStats();
          return `${s.live}/${s.poolSize}`;
        },
        { interval: 200 },
      );
      schema['fx draw calls'] = monitor(() => getParticleStats().drawCalls, { interval: 200 });
      return schema as unknown as LevaSchema;
    },
    [],
  );

  // --- Config folders: auto-built from the CONFIG registry, live-tunable ---
  useControls('Config', () => buildConfigSchema() as unknown as LevaSchema);

  // Default top-right position sits directly under the fixed 64 px site header (z-index
  // 50) and is unclickable there; offsetting the title bar down clears it. `y: 70` is a
  // few px of breathing room below the header, `x: 0` keeps the default horizontal spot.
  return (
    <>
      <Leva collapsed titleBar={{ position: { x: 0, y: 70 } }} />
      <UnitOverlay />
    </>
  );
}
