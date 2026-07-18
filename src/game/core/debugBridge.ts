// Dev-only window bridge: scripted (Playwright) verification of driving feel needs an
// objective speed/pose readout and a way to force state transitions without simulating
// real gameplay input. Loaded exclusively via the `import.meta.env.DEV` dynamic-import
// branch in game/index.tsx — never a static import — so, like devPanel.tsx and
// PerfOverlay.tsx, this module is dead-code-eliminated out of production chunks.
import { Color } from 'three';
import { getPerf as getR3fPerfState } from 'r3f-perf';
import { getGameState } from '../state/store';
import { PLAYER_CARS, type PlayerCarId } from '../config/vehicles';
import { canTransition, type GameState } from '../state/machine';
import { playerVehicle } from '../vehicles/playerRef';
import { spawnPoseRef } from '../world/spawn';
import type { VehiclePose, VehicleState } from '../vehicles/IVehicleModel';
import { ARCHETYPES, EMISSIVE_ARCHETYPES } from '../world/archetypes';
import { setDistrictColor, setDistrictEmissive as setDistrictEmissiveRange } from '../world/instancing';
import { DISTRICT_COUNT, gridRef } from '../powergrid/grid';
import {
  isDistrictDark as emittersIsDistrictDark,
  relightDistrict as emittersRelightDistrict,
  setDistrictDark,
} from '../powergrid/emitters';
import { getImpactCount, onImpact } from '../combat/contacts';
import { trafficRef } from '../ai/trafficTypes';
import { gameEvents } from '../state/events';
import { unitsRef, type UnitKind } from '../ai/pursuitTypes';
import { tankDebugSnapshot } from '../ai/units/tank';
import { projectilesRef } from '../combat/projectiles';
import { setDevToggle } from './devToggles';
import { getSirenDebugSnapshot, type SirenDebugVoice } from '../audio/sirens';
import { busGains, getAudioContextState, liveVoiceCount } from '../audio/manager';
import {
  getHumCandidatesDebug,
  getHumDebugSnapshot,
  getRotorDebugSnapshot,
  type HumVoiceSnapshot,
  type RotorVoiceSnapshot,
} from '../audio/positional';
import { startChaosBench, type BenchReport } from '../ai/chaosBench';
import { heliDebugRef } from '../ai/helicopter';
import { heliRef, type HeliLivery } from '../ai/heliTypes';
import { getParticleStats, type ParticleStats } from '../fx/particles';
import { getDrivingInput, isCoarsePointer, isTouchModeActive } from '../input';
import { landmarkTeleportPoints } from '../world/landmarkGen';
import { streetcarRef } from '../ai/streetcarTypes';
import { occlusionFader } from '../world/toronto/occlusionFade';
import { worldRef } from '../world/worldRef';
import { getReducedShake } from '../state/store';

// Phase 7 traffic verification: exactly-once event proof. The civHit/civWrecked emitter
// payloads are empty, so scripted checks can't scrape them from the DOM — count them here
// (DEV-only, like recentImpacts) and read the totals through window.__smashy.
let civHitTotal = 0;
let civWreckTotal = 0;
gameEvents.on('civHit', () => {
  civHitTotal++;
});
gameEvents.on('civWrecked', () => {
  civWreckTotal++;
});

// Phase 6 contact-spine verification: a small ring buffer of the most recent dispatched
// ImpactRecords, resolved to the registry identities the spine attached. The contact-force
// drain writes nothing to the DOM/canvas a screenshot could scrape, so — like readState/
// readPerf — a scripted check reads impacts through this bridge instead of watching pixels.
// DEV-only (this whole module is dynamically imported only under import.meta.env.DEV).
interface ImpactSample {
  readonly aKind: string | undefined;
  readonly aArchetype: string | undefined;
  readonly bKind: string | undefined;
  readonly bArchetype: string | undefined;
  readonly forceMag: number;
}
const RECENT_IMPACTS_CAP = 16;
const recentImpacts: ImpactSample[] = [];
onImpact((impact) => {
  recentImpacts.push({
    aKind: impact.a?.kind,
    aArchetype: impact.a?.archetype,
    bKind: impact.b?.kind,
    bArchetype: impact.b?.archetype,
    forceMag: impact.forceMag,
  });
  if (recentImpacts.length > RECENT_IMPACTS_CAP) recentImpacts.shift();
});

// Task 5 debug-tint colour — same value the devPanel "tint district (red)" button uses, so
// a screenshot script driving this bridge headlessly reproduces exactly what the leva
// button does.
const TINT_COLOR = new Color('#ff2222');

// Phase 13 Task 4 debug tooling: district blackout/relight -------------------------------
// Routes through the REAL Task 1/2 modules (powergrid/grid.ts, powergrid/emitters.ts —
// both landed mid-session; this replaced an earlier direct-buffer-write fallback written
// before they existed):
//  - `blackoutDistrict` fires the real `transformerDestroyed` event, the exact trigger a
//    live transformer kill uses — grid.ts's subscription (once the orchestrator's
//    integration mount calls `initPowerGrid()`) updates the canonical `gridRef` state,
//    grants the standard +12 heat (state/heat.ts's own independent listener — same event,
//    same amount a real kill grants), and fires `darkCity` + the persisted badge at 16/16.
//    It's ALSO followed by a direct `setDistrictDark` call so the district goes visibly
//    dark immediately regardless of whether the flicker sequencer's physics-step tick
//    (powergrid/PowerGridMount.tsx's useAfterPhysicsStep) is mounted yet — the flicker
//    path alone never advances without that tick, which would otherwise leave a debug
//    blackout stuck mid-sequence pre-integration.
//  - `isDistrictDark` ORs grid.ts's canonical `gridRef.current.lit` (heat/darkCity source
//    of truth) with emitters.ts's own settled-flicker state, so hud/Minimap.tsx reads
//    correctly whether or not the orchestrator's `setBlackoutHandler`/mount wiring has
//    happened yet: `setDistrictDark` above always updates the emitters side; `gridRef`
//    updates once grid.ts's subscription is live.
//  - Guarded against re-firing on an already-dark district (mirrors grid.ts's own
//    idempotency) so double-clicking "blackout district"/"blackout ALL" can't double-grant
//    heat — state/heat.ts's `transformerDestroyed` listener has no such guard itself (see
//    that file), so this guard is the only thing preventing it on the debug path.
//  - `relightDistrict`/`relightAll` are visual-only (emitters.ts's own debug relight) —
//    grid.ts has no un-blackout path (blackouts are permanent for a run, by design), so a
//    relit district's `gridRef` state (and any heat/darkCity already granted) does NOT
//    reset. These exist purely so this task's own before/after screenshot workflow (and
//    future manual testing) can reset the visual between shots.

/** Phase 13 Task 4: is district `districtId` currently dark? Reads BOTH sources — see the
 * block comment above for why. */
export function isDistrictDark(districtId: number): boolean {
  return gridRef.current.lit[districtId] === false || emittersIsDistrictDark(districtId);
}

/** Phase 13 Task 4: blackout one district through the real grid-consistent path — see the
 * block comment above. Used by both the devPanel "blackout district" button and
 * window.__smashy. No-op if the district is already dark (idempotency guard). */
export function blackoutDistrict(districtId: number): void {
  if (isDistrictDark(districtId)) return;
  gameEvents.emit('transformerDestroyed', { districtId });
  setDistrictDark(districtId);
}

/** Phase 13 Task 4: relight one district — visual-only debug reset (see block comment
 * above for why this can't undo grid.ts's state/heat/darkCity). */
export function relightDistrict(districtId: number): void {
  emittersRelightDistrict(districtId);
}

/** Phase 13 Task 4: blackout every district (the devPanel "blackout ALL" button). Loops
 * `blackoutDistrict`, so it's exactly as grid-consistent (and idempotent) as blackout-one;
 * once grid.ts's subscription is live this naturally fires the real `darkCity` + persisted
 * badge at 16/16 — no separate manual emit needed here. */
export function blackoutAll(): void {
  for (let d = 0; d < DISTRICT_COUNT; d++) blackoutDistrict(d);
}

/** Phase 13 Task 4: relight every district (visual-only debug reset). */
export function relightAll(): void {
  for (let d = 0; d < DISTRICT_COUNT; d++) relightDistrict(d);
}

/** Phase 13 Task 4 stub for the minimap's `lightPoolViz` overlay (see core/devToggles.ts's
 * lightPoolViz doc comment for why minimap dots were chosen over an in-scene marker set).
 * TODO(Phase 13 Task 3 integration): powergrid/lightPool.ts (landed mid-session as this
 * task's own pure selection/fade core) doesn't export a ref to the LIVE per-slot state —
 * only its mount component (an R3F tree, still under active revision as of this task's
 * finish) owns the real `<pointLight>` positions, the same "heavy system owns a ref the
 * mount populates" shape as trafficRef/unitsRef/projectilesRef. Deliberately not wired
 * against that mount here (it was still being renamed/reworked while this task ran) —
 * once it settles and exposes a ref, point this at it for real instead of returning []. */
export function getLightPoolPositions(): { x: number; z: number }[] {
  return [];
}

// Phase 10 Task 3: forceSpawnUnit's runtime kind guard. UnitKind (ai/pursuitTypes.ts) is a
// string-literal union with no runtime representation, so a plain string argument off
// window (Playwright's page.evaluate can't pass a typed literal) needs a real value to
// validate against rather than an unsafe cast. Kept in lockstep with UnitKind by hand — the
// same discipline Part 4's own unit modules already follow when they extend that union.
const KNOWN_UNIT_KINDS: readonly UnitKind[] = ['police', 'armored', 'swat', 'gunTruck', 'tank'];

function isUnitKind(kind: string): kind is UnitKind {
  return (KNOWN_UNIT_KINDS as readonly string[]).includes(kind);
}

// Phase 17 Task 3: runtime guard for the selectCar bridge. selectedCarId is a PlayerCarId
// (config/vehicles.ts), a string-literal union with no runtime form, so a raw string off
// page.evaluate is validated against the real PLAYER_CARS keys before reaching the store setter
// (mirrors isUnitKind above). There's no bridge SETTER for the selected car otherwise, and a
// battery selecting a car can't reach the store module directly from the page.
function isPlayerCarId(id: string): id is PlayerCarId {
  return Object.prototype.hasOwnProperty.call(PLAYER_CARS, id);
}

// Phase 9 Task 4: force a GAMEOVER with reason 'busted' without needing the real detector
// live (combat/runLoop.ts, a concurrent sibling task — speed<1 for 3s AND >=3 pursuers
// within 8m — which in turn needs Task 1/2's pursuit units actually chasing the player to
// construct naturally). This is a screen/flow verification shortcut, not a stand-in for
// runLoop's real BUSTED detector: it drives the exact same public seams (gameEvents,
// store.transition) runLoop itself will drive once it lands, so once it exists this
// function and the real path can never disagree about what a BUSTED game-over looks like —
// there's nothing here for runLoop to conflict with. Exported (not just attached to
// window) so core/devPanel.tsx's "force BUSTED (debug)" button can call the identical
// logic instead of duplicating it.
export function forceBustedGameOver(): void {
  const state = getGameState();
  gameEvents.emit('runEnded', { score: state.score, reason: 'busted' });
  if (canTransition(state.machine, 'GAMEOVER')) state.transition('GAMEOVER');
}

/** Task 5 perf snapshot for the screenshot suite. The PerfOverlay draws these numbers to a
 * canvas (not DOM text), so a screenshot script can't scrape them from the page — this
 * reads the SAME r3f-perf zustand store PerfOverlay renders from instead. `gl.info.render`
 * is last-frame draw calls/triangles (reset every frame, autoReset disabled by r3f-perf's
 * PerfHeadless — see its source); `log.fps` is r3f-perf's own smoothed reading. All fields
 * are null until PerfOverlay has mounted and rendered at least one frame. */
export interface PerfSnapshot {
  readonly calls: number | null;
  readonly triangles: number | null;
  readonly fps: number | null;
}

// Phase 14 Task 1 debug tooling: ambient-helicopter lifecycle -------------------------------
// The heli system (ai/helicopter.ts via ai/HeliMount.tsx) has NO physics bodies and NO heat
// coupling — it's driven purely by tier. `setForcedHeliTier` overrides the lifecycle's tier
// so a scripted (Playwright) or manual check can walk the liveries 2→3→4→5→2 without granting
// heat; `heliSlots` reads the sealed HeliSlot seam (heliRef) so the same check can watch a
// swap fly out to the edge and the new livery fly in. Both are null-safe no-ops until
// HeliMount publishes heliDebugRef/heliRef (same pattern as the pursuit/traffic bridge fns).

/** Phase 14 Task 1: force the heli lifecycle to `tier` (0..5), or null to release it back to
 * the live (heat-driven) tier. No-op if the heli mount hasn't published its debug handle. */
export function setForcedHeliTier(tier: number | null): void {
  heliDebugRef.current?.setForcedTier(tier);
}

/** Phase 14 Task 1: plain per-slot heli snapshot (no functions — safe to serialize across
 * page.evaluate). `dist` is the slot's XZ distance from the player (large ⇒ out toward the
 * edge mid-swap; ≈ HELI.orbitRadius ⇒ settled on orbit). Empty when no heli mount is live. */
export interface HeliSlotSample {
  readonly index: number;
  readonly livery: HeliLivery | null;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly bank: number;
  readonly presence: number;
  readonly dist: number;
}

export function heliSlots(): HeliSlotSample[] {
  const slots = heliRef.current?.slots;
  if (!slots) return [];
  const pose = playerVehicle.current?.readState().pose;
  const px = pose?.position.x ?? 0;
  const pz = pose?.position.z ?? 0;
  return slots.map((s, index) => ({
    index,
    livery: s.livery,
    x: s.x,
    y: s.y,
    z: s.z,
    yaw: s.yaw,
    bank: s.bank,
    presence: s.presence,
    dist: Math.hypot(s.x - px, s.z - pz),
  }));
}

/** Phase 14 Task 1: one-line human-readable heli readout for the devPanel monitor — e.g.
 * "★4→military | s0 military p1.00 d40". Shared so the panel doesn't re-derive the format. */
export function heliSlotsSummary(): string {
  const eff = heliDebugRef.current?.getEffectiveTier();
  const active = heliSlots().filter((s) => s.livery !== null);
  const head = eff === undefined ? '—' : `★${eff}`;
  if (active.length === 0) return `${head} | none`;
  const body = active
    .map((s) => `s${s.index} ${s.livery} p${s.presence.toFixed(2)} d${s.dist.toFixed(0)}`)
    .join(' | ');
  return `${head} | ${body}`;
}

// Phase 15 Task 1 debug tooling: shared WebAudio manager introspection -----------------------
// audio/manager.ts's context/bus/pool are otherwise invisible to a scripted check (no DOM/
// canvas surface, and jsdom has no Web Audio implementation at all — see that module's file
// header). This snapshot is the one read path a Playwright script or manual dev-console poke
// needs to confirm: the context unlocks on the start gesture (`contextState === 'running'`),
// `M` flips master gain, pause zeroes the sfx/engine buses (ambient may stay partially
// audible per that module's documented GARAGE-only exception), and a repeated-play soak
// returns every pool to 0 (no orphaned/leaked voices).
export interface AudioSnapshot {
  readonly contextState: AudioContextState | null;
  readonly busGains: {
    readonly master: number;
    readonly sfx: number;
    readonly engine: number;
    readonly ambient: number;
  };
  readonly liveVoices: {
    readonly impact: number;
    readonly gun: number;
    readonly explosion: number;
    readonly loop: number;
    readonly ui: number;
    readonly stinger: number;
  };
  readonly liveVoiceTotal: number;
}

export function audioSnapshot(): AudioSnapshot {
  return {
    contextState: getAudioContextState(),
    busGains: busGains(),
    liveVoices: {
      impact: liveVoiceCount('impact'),
      gun: liveVoiceCount('gun'),
      explosion: liveVoiceCount('explosion'),
      loop: liveVoiceCount('loop'),
      ui: liveVoiceCount('ui'),
      stinger: liveVoiceCount('stinger'),
    },
    liveVoiceTotal: liveVoiceCount(),
  };
}

declare global {
  interface Window {
    __smashy?: {
      /** Current game state machine value. */
      getMachine: () => GameState;
      /** Guarded transition — a no-op if `to` isn't a valid edge from the current state. */
      transition: (to: GameState) => void;
      /** Player vehicle's current readState(), or null if no run is live. */
      readState: () => Readonly<VehicleState> | null;
      /** Teleports the player vehicle to `pose` (default: spawn, identity yaw). No-op
       * if no run is live. */
      reset: (pose?: VehiclePose) => void;
      /** Task 5 district-range proof, headless mirror of the devPanel "tint district
       * (red)" button: recolours district `n`'s [start,count] slice red across every
       * archetype in ARCHETYPES. No-op for archetypes not built this run. */
      tintDistrict: (n: number) => void;
      /** Task 5 district-range proof, headless mirror of the devPanel "blackout
       * district"/"relight district" buttons: flips district `n`'s aEmissiveOn slice
       * across every EMISSIVE_ARCHETYPES archetype (0 = dark, 1 = lit). */
      setDistrictEmissive: (n: number, on: 0 | 1) => void;
      /** Task 5 perf snapshot (draw calls / triangles / fps) for the screenshot suite —
       * see PerfSnapshot's doc comment for why this reads the r3f-perf store directly. */
      readPerf: () => PerfSnapshot;
      /** Phase 8 audit: HUD-visible store numbers in one read. */
      readHud: () => { heat: number; tier: number; score: number; playerHp: number };
      /** Phase 8 audit: monotonic heat grant — the scripted mirror of the devPanel
       * "+N heat" buttons (leva DOM automation is canvas-occluded in headless). */
      addHeat: (delta: number) => void;
      /** Phase 9 audit: direct store.setPlayerHp mirror — the scripted kill path for
       * WRECKED verification (combat/runLoop.ts). Deliberately bypasses the damage
       * resolver (combat/damage.ts) entirely, same as the devPanel's own hp slider would
       * — runLoop's WRECKED detection polls store.playerHp every fixed step specifically
       * so this path (and any other non-event hp mutation) can never be missed. */
      setPlayerHp: (hp: number) => void;
      /** Phase 17 Task 3: select the player car for the next run (store.setSelectedCar) — the
       * scripted mirror of the garage car cards, for a battery that needs to drive a specific
       * car (crush/plow/heavy-mass checks). Validates `id` against PLAYER_CARS; returns whether
       * it applied. Selection is only meaningful outside PLAYING (the car is fixed per run). */
      selectCar: (id: string) => boolean;
      /** Phase 6 contact-spine proof: total ImpactRecords dispatched since load. */
      impactCount: () => number;
      /** Phase 6 contact-spine proof: the last few dispatched impacts, resolved to registry
       * identities (kind/archetype of each side + force magnitude). */
      recentImpacts: () => readonly ImpactSample[];
      /** Phase 7 traffic proof: live civilian count (non-free slots); 0 when unmounted. */
      trafficCount: () => number;
      /** Phase 7 traffic proof: state histogram { driving, converted, wrecked, free }. */
      trafficStates: () => Record<string, number>;
      /** Phase 7 traffic proof: plain per-slot pose snapshot (no functions/bodies — safe to
       * serialize across page.evaluate for position-advance / conversion / flip checks). */
      trafficSlots: () => {
        id: number;
        state: string | null;
        x: number;
        y: number;
        z: number;
        yaw: number;
        dynamic: boolean;
        qw: number;
        hp: number;
      }[];
      /** Phase 7 traffic proof: force-spawn a civilian near a world position (nearest node). */
      trafficSpawnAt: (x: number, z: number) => boolean;
      /** Phase 7 traffic proof: total civHit / civWrecked events emitted since load. */
      civHitCount: () => number;
      civWreckCount: () => number;
      /** Phase 9 Task 4 proof: live pursuit-unit count (non-free slots); 0 when the spawn
       * director (ai/spawnDirector.ts) hasn't mounted yet. */
      pursuitCount: () => number;
      /** Phase 9 Task 4 proof: plain per-slot snapshot (no functions — safe to serialize
       * across page.evaluate), mirroring trafficSlots' shape for the pursuit roster. */
      pursuitSlots: () => {
        id: number;
        kind: string | null;
        state: string;
        x: number;
        y: number;
        z: number;
        hp: number;
        behaviorLabel: string;
      }[];
      /** Phase 9 Task 4 debug: force-spawn one police unit near the player, ignoring spawn
       * caps (ai/pursuitTypes.ts's PursuitApi.forceSpawn). False if the director hasn't
       * mounted yet or declined to spawn. Kept as a thin sugar alias over forceSpawnUnit
       * ('police') below — existing scripts calling this by name keep working unchanged. */
      forceSpawnPolice: () => boolean;
      /** Phase 10 Task 3 debug: force-spawn one unit of `kind` near the player, ignoring
       * spawn caps — generalizes forceSpawnPolice to every registered UnitKind ('police' |
       * 'armored' | 'swat' | 'gunTruck'). False if `kind` isn't a known UnitKind, the director hasn't
       * mounted yet, `kind` has no registered factory yet (Part 4 units register on their
       * own schedule — see ai/spawnDirector.ts's unknown-factory fallback), or the director
       * otherwise declined to spawn. Never throws. */
      forceSpawnUnit: (kind: string) => boolean;
      /** Phase 9 Task 4 debug: flips core/devToggles.ts's `invincible` flag. See that
       * module's doc comment for the handoff — this flag alone changes no behavior until
       * combat/damage.ts's applyPlayerDamage() is wired to read it. */
      setInvincible: (value: boolean) => void;
      /** Phase 22: scripted mirror of the devPanel "Toronto map (P22)" toggle (leva DOM
       * is canvas-occluded in headless). Flip in GARAGE — it changes the world remount
       * key, so a live run would be torn down. */
      setTorontoMap: (value: boolean) => void;
      /** Phase 9 Task 4 debug: forces a GAMEOVER with reason 'busted' — see
       * forceBustedGameOver's doc comment above for exactly what this does and doesn't
       * stand in for. */
      forceBustedGameOver: () => void;
      /** Phase 9 Task 4 proof: per-voice siren binding + gain, and the shared
       * AudioContext's state (audio/sirens.ts). Real audible output can't be verified in
       * this headless container — see that module's file header. */
      sirenSnapshot: () => {
        readonly contextState: AudioContextState | null;
        readonly voices: readonly SirenDebugVoice[];
      };
      /** Phase 15 Task 1 proof: shared AudioContext state, bus gains, and per-group live
       * voice-pool counts (audio/manager.ts) — see AudioSnapshot's doc comment above. */
      audioSnapshot: () => AudioSnapshot;
      /** Phase 15 Task 3 proof: per-district-hum voice snapshot (audio/positional.ts) —
       * `liveCount` is how many transformers are currently sounding (drops when a district is
       * blacked out or leaves audible range), each voice carries its district binding + gain +
       * pan. Audible output is a human-on-hardware check — see positional.ts's file header. */
      humSnapshot: () => {
        readonly contextState: AudioContextState | null;
        readonly liveCount: number;
        readonly voices: readonly HumVoiceSnapshot[];
      };
      /** Phase 15 Task 3 proof: per-heli-rotor voice snapshot (audio/positional.ts) —
       * `liveCount` is how many rotors are sounding (goes live when a heli tier is forced,
       * fades with presence), each voice carries its livery + active flag + gain + pan. */
      rotorSnapshot: () => {
        readonly contextState: AudioContextState | null;
        readonly liveCount: number;
        readonly voices: readonly RotorVoiceSnapshot[];
      };
      /** Phase 15 Task 3 helper: transformer (hum-candidate) positions for the current world —
       * lets a scripted check teleport the player onto one to exercise the hum + blackout path. */
      humCandidates: () => readonly { readonly districtId: number; readonly x: number; readonly z: number }[];
      /** Phase 12 Task 4: runs the ★5 chaos bench (ai/chaosBench.ts) — forces max heat,
       * fills the pursuit roster, auto-drives the player around a road-graph circuit for
       * ~60 s while sampling perf, and resolves with the printed budget report. Idempotent
       * while already running (returns the in-flight run's promise rather than overlapping
       * a second one) — see that module's doc comment for the full design. */
      runChaosBench: () => Promise<BenchReport>;
      /** Phase 12 Task 1 debug: detonate a tank-shell explosion (combat/explosion.ts) directly
       * at the player's position — the fastest way to observe a blast (car launched + recovers,
       * nearby props/cars fly, a force-spawned cop in range wrecks by friendly fire). No-op if
       * no run is live. Returns false if the projectiles system hasn't mounted. */
      blastHere: () => boolean;
      /** Phase 12 Task 1 debug: fire a real tank shell FROM an elevated point ~22 m off the
       * player TOWARD the player (no firer, so nothing is excluded) — exercises the full
       * pure-point shell → sweep → detonate path, not just the explosion. Returns false if the
       * projectiles system hasn't mounted or no run is live. */
      fireShellAt: () => boolean;
      /** Phase 12 Task 1 proof: shells currently in flight (0 when the pool is idle). Lets a
       * scripted soak confirm the pool always drains back to 0 (no leaked/stuck shells). */
      shellCount: () => number;
      /** Phase 12 Task 2 proof: per-live-tank fire-cycle snapshot (id / phase / telegraph
       * progress01 / shotsFired) — lets a scripted check confirm the idle → telegraph → fire
       * cycle runs on its ~5 s cadence without watching pixels. Empty when no tanks are live. */
      tankTelegraphs: () => {
        id: number;
        phase: 'idle' | 'telegraph';
        progress01: number;
        shotsFired: number;
        turretYaw: number;
      }[];
      /** Phase 13 Task 4 debug: blackout/relight one district through the grid-consistent
       * entry point — see blackoutDistrict's doc comment for exactly what this stands in
       * for pre-integration (Tasks 1-2's real powergrid/grid.ts + emitters.ts). */
      blackoutDistrict: (districtId: number) => void;
      relightDistrict: (districtId: number) => void;
      /** Phase 13 Task 4 debug: blackout/relight every district. blackoutAll also fires
       * the real `darkCity` event (no heat, no flicker, no persisted badge — see doc
       * comment above). */
      blackoutAll: () => void;
      relightAll: () => void;
      /** Phase 13 Task 4 proof: current lit/dark state for all 16 districts, index =
       * districtId — the scripted mirror of what hud/Minimap.tsx's overlay is reading. */
      districtDarkStates: () => boolean[];
      /** Phase 13 Task 4 stub: pooled dynamic-light world positions for the minimap's
       * lightPoolViz overlay. Empty until powergrid/lightPool.ts (Task 3) lands — see
       * getLightPoolPositions' doc comment. */
      lightPoolPositions: () => { x: number; z: number }[];
      /** Phase 14 Task 1 debug: force the ambient-heli lifecycle to `tier` (0..5), or null to
       * release it back to the heat-driven tier — drives livery/count without granting heat.
       * No-op until ai/HeliMount.tsx publishes the debug handle. */
      setForcedHeliTier: (tier: number | null) => void;
      /** Phase 14 Task 1 proof: per-slot heli snapshot (livery/pose/presence + XZ distance to
       * the player) off the sealed HeliSlot seam — lets a scripted check watch a livery swap
       * fly OUT to the edge (large dist) and the new one fly IN. Empty when no mount is live. */
      heliSlots: () => HeliSlotSample[];
      /** Phase 16 proof: live particle-pool occupancy + how many of the system's two
       * materials currently draw — the scripted mirror of the dev panel's FX BOARD meters
       * (soak scripts watch `live` return to ~0 and `drawCalls` stay ≤ 2). */
      particleStats: () => ParticleStats;
      /** Phase 16 a11y flag (persisted setting; Phase 18 surfaces the real UI): when true
       * the camera rig zeroes shake offsets + FOV kick at apply time. Scripted A/B proof
       * drives this, then diffs camera jitter across identical blasts. */
      setReducedShake: (value: boolean) => void;
      getReducedShake: () => boolean;
      /** Phase 18: live touch-input state — scripted mobile-emulation checks read these
       * instead of poking at module internals. */
      touchState: () => { coarse: boolean; touchModeActive: boolean; input: { steer: number; throttle: number; brake: number; handbrake: boolean } };
      /** Phase 19: landmark teleport points ({id,x,z}[]) off the LIVE world — scripted
       * postcard batteries + the devPanel teleport buttons read the same helper. */
      landmarks: () => readonly { id: string; x: number; z: number }[];
      /** Phase 19: live streetcar roster snapshot (state/pose per slot) — scripted proof the
       * avenue loop runs without watching pixels. Empty when no mount/roster is live. */
      streetcarSlots: () => { state: string | null; x: number; z: number }[];
      /** Phase 25: lowest occludable opacity right now (1 = nothing fading). A scripted check
       * teleports the car behind a named tower / hero and reads this < 1 to prove the camera→car
       * occlusion raycast + fade (A.5) is live — the tight §5.3 camera setback makes a dramatic
       * see-through screenshot geometrically impossible, so this is the headless proof. */
      occlusionMinOpacity: () => number;
    };
  }
}

window.__smashy = {
  getMachine: () => getGameState().machine,
  transition: (to) => {
    const state = getGameState();
    if (canTransition(state.machine, to)) state.transition(to);
  },
  readState: () => playerVehicle.current?.readState() ?? null,
  reset: (pose) => playerVehicle.current?.reset(pose ?? spawnPoseRef.current),
  tintDistrict: (n) => {
    for (const name of ARCHETYPES) setDistrictColor(name, n, TINT_COLOR);
  },
  setDistrictEmissive: (n, on) => {
    for (const name of EMISSIVE_ARCHETYPES) setDistrictEmissiveRange(name, n, on);
  },
  readHud: () => {
    const s = getGameState();
    return { heat: s.heat, tier: s.tier, score: s.score, playerHp: s.playerHp };
  },
  addHeat: (delta) => getGameState().addHeat(delta),
  setPlayerHp: (hp) => getGameState().setPlayerHp(hp),
  selectCar: (id) => {
    if (!isPlayerCarId(id)) return false;
    getGameState().setSelectedCar(id);
    return true;
  },
  readPerf: () => {
    const state = getR3fPerfState();
    return {
      calls: state.gl?.info.render.calls ?? null,
      triangles: state.gl?.info.render.triangles ?? null,
      fps: state.log?.fps ?? null,
    };
  },
  impactCount: () => getImpactCount(),
  recentImpacts: () => recentImpacts.slice(),
  trafficCount: () => trafficRef.current?.activeCount() ?? 0,
  trafficStates: () => {
    const h: Record<string, number> = { driving: 0, converted: 0, wrecked: 0, free: 0 };
    for (const s of trafficRef.current?.slots ?? []) h[s.state ?? 'free']++;
    return h;
  },
  trafficSlots: () =>
    (trafficRef.current?.slots ?? []).map((s) => ({
      id: s.id,
      state: s.state,
      x: s.x,
      y: s.y,
      z: s.z,
      yaw: s.yaw,
      dynamic: s.dynamic,
      qw: s.qw,
      hp: s.hp,
    })),
  trafficSpawnAt: (x, z) => trafficRef.current?.spawnAt(x, z) ?? false,
  civHitCount: () => civHitTotal,
  civWreckCount: () => civWreckTotal,
  pursuitCount: () => unitsRef.current?.activeCount() ?? 0,
  pursuitSlots: () =>
    (unitsRef.current?.slots ?? [])
      .filter((s) => s.kind !== null)
      .map((s) => ({
        id: s.id,
        kind: s.kind,
        state: s.state,
        x: s.x,
        y: s.y,
        z: s.z,
        hp: s.hp,
        behaviorLabel: s.behaviorLabel,
      })),
  forceSpawnPolice: () => unitsRef.current?.forceSpawn('police' satisfies UnitKind) ?? false,
  forceSpawnUnit: (kind) => (isUnitKind(kind) ? (unitsRef.current?.forceSpawn(kind) ?? false) : false),
  setInvincible: (value) => setDevToggle('invincible', value),
  setTorontoMap: (value) => setDevToggle('torontoMap', value),
  forceBustedGameOver,
  sirenSnapshot: () => getSirenDebugSnapshot(),
  audioSnapshot,
  humSnapshot: () => getHumDebugSnapshot(),
  rotorSnapshot: () => getRotorDebugSnapshot(),
  humCandidates: () => getHumCandidatesDebug(),
  runChaosBench: () => startChaosBench(),
  blastHere: () => {
    const api = projectilesRef.current;
    const state = playerVehicle.current?.readState();
    if (api === null || !state) return false;
    const p = state.rawPose.position;
    api.blastAt(p.x, p.y, p.z);
    return true;
  },
  fireShellAt: () => {
    const api = projectilesRef.current;
    const state = playerVehicle.current?.readState();
    if (api === null || !state) return false;
    const p = state.rawPose.position;
    // Spawn NE of and ABOVE the player, aimed DOWN at the chassis — a mild descent so the
    // flat-trajectory shell reliably meets the low car (and, on a near-miss, the ground right
    // beside it) instead of sailing over the roof. Debug-only framing; the tank's own muzzle
    // fires far flatter.
    const origin = { x: p.x + 16, y: 3.2, z: p.z + 16 };
    const dir = { x: p.x - origin.x, y: p.y + 0.4 - origin.y, z: p.z - origin.z };
    api.spawn(-1, origin, dir);
    return true;
  },
  shellCount: () => projectilesRef.current?.activeCount() ?? 0,
  tankTelegraphs: () => tankDebugSnapshot(),
  blackoutDistrict,
  relightDistrict,
  blackoutAll,
  relightAll,
  districtDarkStates: () => Array.from({ length: DISTRICT_COUNT }, (_, d) => isDistrictDark(d)),
  lightPoolPositions: getLightPoolPositions,
  setForcedHeliTier,
  heliSlots,
  particleStats: getParticleStats,
  touchState: () => ({ coarse: isCoarsePointer(), touchModeActive: isTouchModeActive(), input: { ...getDrivingInput() } }),
  landmarks: () => (worldRef.current ? landmarkTeleportPoints(worldRef.current) : []),
  streetcarSlots: () =>
    (streetcarRef.current?.slots ?? []).map((s) => ({ state: s.state, x: s.x, z: s.z })),
  setReducedShake: (value) => getGameState().setReducedShake(value),
  getReducedShake,
  occlusionMinOpacity: () => occlusionFader.minOpacity(),
};
