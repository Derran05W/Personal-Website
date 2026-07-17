// Chaos bench — the standing perf-regression harness (Phase 12 Task 4; TDD §10 budget
// table). A one-call dev/bench harness that forces ★5 (max heat/wanted tier), fills the
// pursuit roster, auto-drives the PLAYER around a waypoint circuit on the civilian traffic
// graph for ~60 s (so pursuit units chase, gun trucks orbit, tanks telegraph/fire — real
// escalation load, not a synthetic stand-in), samples perf every 500 ms, and returns/prints
// a budget report compared against config/quality.ts's QUALITY_TIERS (the same numbers
// CLAUDE.md's perf-budget table documents).
//
// --- auto-drive design (locked, phase-12-plan.md Task 4) -----------------------------------
// The bench does NOT create a new AI unit chasing the player — it drives the PLAYER'S OWN
// vehicle. Real gameplay input (input/keyboard.ts) and this bench must feed the exact same
// seam (VehicleInputs, via getDrivingInput()) so nothing downstream (PlayerVehicle, replay,
// future telemetry) needs to know the difference — see input/keyboard.ts's
// setDrivingInputOverride for that hook.
//
// Steering reuses ai/aiSteering.ts's EXISTING pursueSteer math UNCHANGED, aimed at the next
// waypoint instead of the player:
//   • the waypoint is passed as pursueSteer's `player` argument with a ZERO velocity (no
//     lead needed — waypoints don't move),
//   • AvoidHits are passed fully-clear ({center:1,left:1,right:1}) — no raycasts are cast.
//     The traffic graph's nodes already sit on drivable lane centerlines (world/
//     trafficGraph.ts), so a road-following loop needs no obstacle avoidance; passing clear
//     hits simply switches that layer of pursueSteer off (avoid term becomes 0), leaving pure
//     heading-error steering + corner-throttle easing + the free stuck/reversal recovery if
//     the bench chassis ever does wedge on something (tank wreckage, a flung prop, …).
// This reuse is also why chaosBench.ts stays Rapier-free itself — pursueSteer is pure numbers
// in, numbers out; the only physics reads are playerVehicle.current.readState() (already
// exposed for exactly this kind of consumer) and the bridge/ref accessors below.
//
// --- next-waypoint selection --------------------------------------------------------------
// A tiny state machine: hold a `targetNodeId`; once the player is within ARRIVE_DIST_M of it,
// roll a new outgoing edge from that node (mirrors ai/traffic.ts's own pickEdge contract:
// `pickEdge(edgeIndices) -> one of those indices`) and re-target the edge's `to` node. The
// graph's own invariant (world/trafficGraph.ts: "no lane ever dead-ends off the edge of the
// map") means outEdges is never empty in practice; pickNextWaypoint still degrades safely
// (holds position) if it ever were.
//
// --- resilience against incidental death -----------------------------------------------
// ★5 chaos (tanks, gun trucks, explosions with NO faction filter — phase-12-plan.md) can
// plausibly wreck the player mid-soak; a dead 60 s run would under-measure the very load this
// bench exists to characterize. Two layers of insurance: (1) the DEV invincible toggle
// (core/devToggles.ts) is forced on for the bench's duration and restored after — the
// intended, already-wired no-op-player-damage path (combat/damage.ts, and hitscan.ts's gun-
// truck fire already honors it; explosion damage is expected to route through the same single
// player-damage entry point once Task 1 lands). (2) belt-and-suspenders: if the machine ever
// leaves PLAYING anyway (GAMEOVER, or a debug transition), the drive tick transitions straight
// back to PLAYING and re-grants heat to ★5 — combat/runLoop.ts's own store subscription calls
// runReset() on every GAMEOVER->PLAYING edge (zeroing heat), so heat must be re-granted on
// every such revival, not just once at bench start.
//
// --- what "bodies" means here ----------------------------------------------------------------
// CLAUDE.md's perf table has an "active dynamic bodies" row backed by the real Rapier
// world.bodies count. That accessor only exists behind useRapier() (an R3F hook), and every
// component that calls it (PlayerVehicle.tsx, ai/units/*Mesh.tsx, ai/TrafficMount.tsx, …) is
// outside this task's file scope — wiring a new one would mean adding a mount point in
// game/index.tsx, also outside scope. So the report's body-load proxy is the two counts this
// module CAN reach without new wiring: live pursuit units (ai/pursuitTypes.ts's unitsRef) and
// live traffic cars (ai/trafficTypes.ts's trafficRef) — reported honestly as unit counts, not
// as the literal Rapier body total (which would also include static colliders, dynamic props,
// shells, and wrecked debris). Draw calls / triangles (r3f-perf, already real) are what the CI
// gate below actually enforces.

import { createRng } from '../world/rng';
import { worldRef } from '../world/worldRef';
import { playerVehicle } from '../vehicles/playerRef';
import { getGameState } from '../state/store';
import { canTransition } from '../state/machine';
import { getDevToggles, setDevToggle } from '../core/devToggles';
import { setDrivingInputOverride } from '../input';
import { pursueSteer, initialStuckState, type AvoidHits, type StuckState } from './aiSteering';
import { trafficRef } from './trafficTypes';
import { unitsRef, type UnitKind } from './pursuitTypes';
import type { TrafficGraph, TrafficNode } from '../world/types';
import { AI_STEERING, HEAT, QUALITY_TIERS, SPAWN } from '../config';
import { getPerf } from 'r3f-perf';
import { Quaternion, Vector3 } from 'three';

// --- tunables (dev/bench-only tool; not a CONFIG block — see CLAUDE.md's config module
// convention doc, but this whole file only ever ships in the DEV-gated chunk: its only
// consumers, core/debugBridge.ts and core/devPanel.tsx, are both already
// `import.meta.env.DEV`-only dynamic imports) ------------------------------------------------
const THINK_HZ = SPAWN.aiTickHz; // matches the rest of ai/*'s 10 Hz decision cadence
const THINK_INTERVAL_MS = Math.round(1000 / THINK_HZ);
const THINK_INTERVAL_SEC = THINK_INTERVAL_MS / 1000;
const SAMPLE_INTERVAL_MS = 500; // divisible by THINK_INTERVAL_MS (100) — see the tick loop
const BLAST_INTERVAL_MS = 8000; // divisible by THINK_INTERVAL_MS too
const BENCH_DURATION_MS = 60_000;
const ARRIVE_DIST_M = 5; // under TRAFFIC.waypointSpacingTiles * WORLD.tileSize (20 m)
const ENSURE_PLAYING_TIMEOUT_MS = 10_000;
const ENSURE_PLAYING_POLL_MS = 100;
const FILL_TIMEOUT_MS = 5_000;
const FILL_POLL_MS = 150;
const TIER5_INDEX = 5;

const CLEAR_HITS: AvoidHits = { center: 1, left: 1, right: 1 };
const ZERO_VEL = { x: 0, z: 0 };
const ROSTER_KINDS: readonly UnitKind[] = ['police', 'armored', 'swat', 'gunTruck', 'tank'];
const FORWARD_LOCAL = new Vector3(0, 0, 1);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================================
// Pure helpers (unit-tested — no Rapier/three/store side effects)
// ============================================================================================

/** Nearest graph node to a world-space (x,z), by squared distance. Used once, at bench start,
 * to seed the circuit from wherever the player currently is. `nodes` must be non-empty. */
export function nearestNodeId(nodes: readonly TrafficNode[], x: number, z: number): number {
  if (nodes.length === 0) throw new RangeError('nearestNodeId(): empty node list');
  let best = nodes[0].id;
  let bestDistSq = Infinity;
  for (const node of nodes) {
    const dx = node.x - x;
    const dz = node.z - z;
    const distSq = dx * dx + dz * dz;
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      best = node.id;
    }
  }
  return best;
}

/**
 * One circuit-advance step: roll a new outgoing edge from `currentNodeId` and return the node
 * at its far end. `pickEdge` mirrors ai/traffic.ts's advanceCursor contract exactly — it
 * receives the arrived node's outEdges (edge INDICES into `graph.edges`) and returns one of
 * those same indices — so the same rng.pick-based picker traffic uses drops straight in.
 * Degrades safely (holds `currentNodeId`) if the node has no outgoing edges, which the graph's
 * own generation invariant (world/trafficGraph.ts) guarantees never happens in practice.
 */
export function pickNextWaypoint(
  graph: TrafficGraph,
  currentNodeId: number,
  pickEdge: (edgeIndices: readonly number[]) => number,
): number {
  const outs = graph.outEdges[currentNodeId];
  if (!outs || outs.length === 0) return currentNodeId;
  const edge = graph.edges[pickEdge(outs)];
  return edge.to;
}

/** +Z-model-forward yaw from a physics quaternion (matches aiSteering's atan2(dx,dz)
 * convention exactly, and raycastVehicle.ts's own forward-vector derivation — robust to any
 * chassis pitch/roll, unlike an Euler decomposition). */
export function yawFromQuaternion(q: {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
}): number {
  const fwd = FORWARD_LOCAL.clone().applyQuaternion(new Quaternion(q.x, q.y, q.z, q.w));
  return Math.atan2(fwd.x, fwd.z);
}

function fmtNum(n: number | null, digits = 1): string {
  return n === null || !Number.isFinite(n) ? 'n/a' : n.toFixed(digits);
}

function mark(ok: boolean): string {
  return ok ? 'OK' : 'FAIL';
}

// ============================================================================================
// Report
// ============================================================================================

export interface BenchReport {
  readonly durationSec: number;
  readonly samples: number;
  readonly minFps: number | null;
  readonly avgFps: number | null;
  readonly maxDrawCalls: number;
  readonly maxTriangles: number;
  /** Peak concurrent pursuit units observed (ai/pursuitTypes.ts's unitsRef) — proxy for
   * body-count load; see the file header's "what bodies means here" note. */
  readonly maxPursuitUnits: number;
  /** Peak concurrent civilian traffic cars observed (ai/trafficTypes.ts's trafficRef). */
  readonly maxTrafficUnits: number;
  readonly heapStartMb: number | null;
  readonly heapEndMb: number | null;
  readonly heapDeltaMb: number | null;
  readonly blastsTriggered: number;
  /** Whether window.__smashy.blastHere existed to schedule (Task 3's debug hook — may not be
   * wired yet; the bench runs fine without it, just with less scheduled explosion load). */
  readonly blastBridgeAvailable: boolean;
  readonly gate: {
    /** CLAUDE.md's perf table has 3 tiers; the CI-verifiable gate below checks against
     * 'high' (the default settings quality a fresh page load boots with) — draw calls and
     * triangles are real GPU-submission counts, container-verifiable regardless of the
     * SwiftShader software renderer's fps ceiling. */
    readonly tier: 'high';
    readonly maxDrawCalls: number;
    readonly maxTriangles: number;
    readonly drawCallsOk: boolean;
    readonly trianglesOk: boolean;
    readonly ok: boolean;
  };
}

/** Pure formatter — the console table shape both the live bridge call and the CI script
 * print. Kept separate from startChaosBench so it's independently testable. */
export function formatBenchReport(report: BenchReport): string {
  const high = QUALITY_TIERS.high;
  const med = QUALITY_TIERS.med;
  const low = QUALITY_TIERS.low;
  const lines: string[] = [
    `[chaosBench] ★5 chaos report — ${report.durationSec.toFixed(1)}s, ${report.samples} samples`,
    `  fps        min ${fmtNum(report.minFps)}  avg ${fmtNum(report.avgFps)}` +
      '  (informational only — SwiftShader/headless fps is env-bound, not CI-gated)',
    `  drawCalls  max ${report.maxDrawCalls}` +
      `   high<${high.maxDrawCalls} ${mark(report.maxDrawCalls < high.maxDrawCalls)}` +
      `  med<${med.maxDrawCalls} ${mark(report.maxDrawCalls < med.maxDrawCalls)}` +
      `  low<${low.maxDrawCalls} ${mark(report.maxDrawCalls < low.maxDrawCalls)}`,
    `  triangles  max ${report.maxTriangles}` +
      `   high<${high.maxTriangles} ${mark(report.maxTriangles < high.maxTriangles)}` +
      `  med<${med.maxTriangles} ${mark(report.maxTriangles < med.maxTriangles)}` +
      `  low<${low.maxTriangles} ${mark(report.maxTriangles < low.maxTriangles)}`,
    `  units      pursuit max ${report.maxPursuitUnits}  traffic max ${report.maxTrafficUnits}` +
      '  (proxy for "active dynamic bodies" — see file header)',
    `  heap       start ${fmtNum(report.heapStartMb)}MB  end ${fmtNum(report.heapEndMb)}MB` +
      `  delta ${fmtNum(report.heapDeltaMb)}MB`,
    `  blasts     ${report.blastsTriggered} triggered` +
      `  (blastHere bridge: ${report.blastBridgeAvailable ? 'present' : 'not wired yet'})`,
    `  CI gate (${report.gate.tier})  drawCalls ${mark(report.gate.drawCallsOk)}` +
      `  triangles ${mark(report.gate.trianglesOk)}  →  ${report.gate.ok ? 'PASS' : 'FAIL'}`,
  ];
  return lines.join('\n');
}

// ============================================================================================
// Optional blastHere bridge (Task 3, FX + debug — may not exist yet). Feature-detected, never
// a hard dependency: the bench treats a missing blastHere as "no scheduled bonus load", not an
// error. Declared locally (not merged into debugBridge.ts's own Window.__smashy interface,
// which Task 3 owns) so this module never assumes a signature Task 3 hasn't shipped yet.
// ============================================================================================
interface BenchBlastBridge {
  readonly blastHere?: () => void;
}

function getBlastHere(): (() => void) | null {
  if (typeof window === 'undefined' || !window.__smashy) return null;
  const bridge = window.__smashy as unknown as BenchBlastBridge;
  return typeof bridge.blastHere === 'function' ? bridge.blastHere : null;
}

// ============================================================================================
// Bench run
// ============================================================================================

function grantHeatToTier5(): void {
  const state = getGameState();
  const target = HEAT.tierThresholds[TIER5_INDEX];
  const delta = target - state.heat;
  if (delta > 0) state.addHeat(delta);
}

/** Polls until `machine` reaches PLAYING (driving any single valid transition edge it can),
 * up to ENSURE_PLAYING_TIMEOUT_MS. Throws if it never gets there (e.g. stuck in LOADING with
 * assets that never resolve) — a bench that silently no-ops is worse than one that fails loud. */
async function ensurePlaying(): Promise<void> {
  const start = performance.now();
  while (performance.now() - start < ENSURE_PLAYING_TIMEOUT_MS) {
    const state = getGameState();
    if (state.machine === 'PLAYING') return;
    if (canTransition(state.machine, 'PLAYING')) state.transition('PLAYING');
    await sleep(ENSURE_PLAYING_POLL_MS);
  }
  throw new Error(
    `chaosBench: could not reach PLAYING within ${ENSURE_PLAYING_TIMEOUT_MS}ms (stuck at ${getGameState().machine})`,
  );
}

/**
 * Polls until both worldRef and playerVehicle are populated, up to ENSURE_PLAYING_TIMEOUT_MS.
 * NEEDED even after ensurePlaying() resolves: reaching machine==='PLAYING' only proves the
 * zustand store transitioned — CityScape/PlayerVehicle (world/CityScape.tsx,
 * vehicles/PlayerVehicle.tsx) are mounted unconditionally (not gated on `machine` at all, so
 * ordinary play always has many frames of GARAGE to mount in), but they still populate their
 * refs asynchronously relative to the OUTER React commit: react-three-fiber's <Canvas> creates
 * the DOM <canvas> element (and the game-canvas-container becomes "visible") before its
 * internal fiber root has actually mounted the JSX children into the WebGL scene, and a
 * caller (a scripted driver, this file's own consumers) that force-transitions through
 * BOOT->LOADING->GARAGE->PLAYING within milliseconds of page load — exactly what
 * ensurePlaying() above does — can win that race and reach PLAYING before either ref is set.
 * Also guards the (should-never-happen, per world/trafficGraph.ts's own invariant) empty-graph
 * case the same way.
 */
async function waitForWorldReady(): Promise<{
  world: NonNullable<typeof worldRef.current>;
  player: NonNullable<typeof playerVehicle.current>;
}> {
  const start = performance.now();
  while (performance.now() - start < ENSURE_PLAYING_TIMEOUT_MS) {
    const world = worldRef.current;
    const player = playerVehicle.current;
    if (world && world.graph.nodes.length > 0 && player) return { world, player };
    await sleep(ENSURE_PLAYING_POLL_MS);
  }
  throw new Error(
    `chaosBench: world/player never became ready within ${ENSURE_PLAYING_TIMEOUT_MS}ms ` +
      `(world: ${worldRef.current ? 'ready' : 'null'}, player: ${playerVehicle.current ? 'ready' : 'null'})`,
  );
}

/** Force-spawns every registered unit kind on a short poll until the ★5 cap is reached (or
 * FILL_TIMEOUT_MS elapses) — faster and more reliable than waiting on the director's own
 * organic ~2 Hz maintenance pass, and harmless against kinds whose factory isn't registered
 * yet (ai/pursuitTypes.ts's forceSpawn contract: false, never throws). */
async function fillRoster(): Promise<void> {
  const cap = SPAWN.caps[TIER5_INDEX] ?? 10;
  const start = performance.now();
  while (performance.now() - start < FILL_TIMEOUT_MS) {
    if ((unitsRef.current?.activeCount() ?? 0) >= cap) return;
    for (const kind of ROSTER_KINDS) unitsRef.current?.forceSpawn(kind);
    await sleep(FILL_POLL_MS);
  }
}

interface PerformanceMemoryLike {
  readonly usedJSHeapSize: number;
}

/** Chrome/Chromium-only (`performance.memory`) — not in the standard lib.dom types, and
 * genuinely absent on other engines, hence the optional chain rather than a hard read. */
function readHeapMb(): number | null {
  const perf = performance as Performance & { readonly memory?: PerformanceMemoryLike };
  const bytes = perf.memory?.usedJSHeapSize;
  return typeof bytes === 'number' ? bytes / (1024 * 1024) : null;
}

let activeBench: Promise<BenchReport> | null = null;

/**
 * Runs the ★5 chaos bench once (idempotent — a call while one is already in flight returns
 * the SAME promise rather than starting a second overlapping run) and resolves with the
 * printed report. See the file header for the full design rationale.
 */
export function startChaosBench(): Promise<BenchReport> {
  if (activeBench) return activeBench;
  const run = runChaosBenchOnce().finally(() => {
    activeBench = null;
  });
  activeBench = run;
  return run;
}

async function runChaosBenchOnce(): Promise<BenchReport> {
  await ensurePlaying();
  const { world, player } = await waitForWorldReady();

  const prevInvincible = getDevToggles().invincible;
  setDevToggle('invincible', true);
  grantHeatToTier5();
  await fillRoster();

  const rng = createRng(world.seed).fork('chaosBench');
  const pickEdge = (ids: readonly number[]): number => rng.pick(ids);

  const startPos = player.readState().rawPose.position;
  let currentNodeId = nearestNodeId(world.graph.nodes, startPos.x, startPos.z);
  let targetNodeId = pickNextWaypoint(world.graph, currentNodeId, pickEdge);
  let stuck: StuckState = initialStuckState;

  let fpsSum = 0;
  let fpsCount = 0;
  let minFps = Infinity;
  let maxDrawCalls = 0;
  let maxTriangles = 0;
  let maxPursuitUnits = 0;
  let maxTrafficUnits = 0;
  let heapStartMb: number | null = null;
  let heapEndMb: number | null = null;
  let samples = 0;
  let blastsTriggered = 0;
  const blastHere = getBlastHere();

  function driveTick(): void {
    // Belt-and-suspenders revival — see the file header's "resilience against incidental
    // death" note. invincible (above) is the primary guard; this covers anything it misses
    // (BUSTED, water entry, a stray debug transition).
    const state = getGameState();
    if (state.machine !== 'PLAYING') {
      if (canTransition(state.machine, 'PLAYING')) {
        state.transition('PLAYING');
        grantHeatToTier5(); // runLoop.ts's own GAMEOVER->PLAYING subscriber calls runReset(),
        // which zeroes heat — re-grant every time this branch fires, not just once.
      }
      return;
    }

    const vehicle = playerVehicle.current;
    if (!vehicle) return;
    const readState = vehicle.readState();
    const pos = readState.rawPose.position;
    const yaw = yawFromQuaternion(readState.rawPose.rotation);
    const speed = Math.hypot(readState.velocity.x, readState.velocity.z);

    const target = world.graph.nodes[targetNodeId];
    const dist = Math.hypot(target.x - pos.x, target.z - pos.z);
    if (dist < ARRIVE_DIST_M) {
      currentNodeId = targetNodeId;
      targetNodeId = pickNextWaypoint(world.graph, currentNodeId, pickEdge);
    }
    const node = world.graph.nodes[targetNodeId];

    const result = pursueSteer(
      { x: pos.x, z: pos.z, yaw },
      speed,
      { x: node.x, z: node.z },
      ZERO_VEL,
      CLEAR_HITS,
      stuck,
      AI_STEERING,
      THINK_INTERVAL_SEC,
      'pursue',
    );
    stuck = result.stuck;
    setDrivingInputOverride({
      steer: result.command.steer,
      throttle: result.command.throttle,
      brake: result.command.brake,
      handbrake: false,
    });
  }

  function sampleTick(): void {
    samples++;
    const perf = getPerf();
    const fps = perf.log?.fps ?? null;
    const calls = perf.gl?.info.render.calls ?? 0;
    const triangles = perf.gl?.info.render.triangles ?? 0;
    if (fps !== null) {
      fpsSum += fps;
      fpsCount++;
      if (fps < minFps) minFps = fps;
    }
    if (calls > maxDrawCalls) maxDrawCalls = calls;
    if (triangles > maxTriangles) maxTriangles = triangles;

    const pursuitN = unitsRef.current?.activeCount() ?? 0;
    const trafficN = trafficRef.current?.activeCount() ?? 0;
    if (pursuitN > maxPursuitUnits) maxPursuitUnits = pursuitN;
    if (trafficN > maxTrafficUnits) maxTrafficUnits = trafficN;

    const heap = readHeapMb();
    if (heap !== null) {
      if (heapStartMb === null) heapStartMb = heap;
      heapEndMb = heap;
    }
  }

  let elapsedMs = 0;
  await new Promise<void>((resolve) => {
    const interval = setInterval(() => {
      elapsedMs += THINK_INTERVAL_MS;
      driveTick();
      if (elapsedMs % SAMPLE_INTERVAL_MS === 0) sampleTick();
      if (blastHere && elapsedMs % BLAST_INTERVAL_MS === 0) {
        blastHere();
        blastsTriggered++;
      }
    }, THINK_INTERVAL_MS);

    setTimeout(() => {
      clearInterval(interval);
      resolve();
    }, BENCH_DURATION_MS);
  });

  // Restore, always — a bench that leaves the player permanently invincible or the keyboard
  // silently overridden would be a much worse bug than any of the ones it's meant to catch.
  setDrivingInputOverride(null);
  setDevToggle('invincible', prevInvincible);

  const high = QUALITY_TIERS.high;
  const drawCallsOk = maxDrawCalls < high.maxDrawCalls;
  const trianglesOk = maxTriangles < high.maxTriangles;

  const report: BenchReport = {
    durationSec: BENCH_DURATION_MS / 1000,
    samples,
    minFps: fpsCount > 0 ? minFps : null,
    avgFps: fpsCount > 0 ? fpsSum / fpsCount : null,
    maxDrawCalls,
    maxTriangles,
    maxPursuitUnits,
    maxTrafficUnits,
    heapStartMb,
    heapEndMb,
    heapDeltaMb: heapStartMb !== null && heapEndMb !== null ? heapEndMb - heapStartMb : null,
    blastsTriggered,
    blastBridgeAvailable: blastHere !== null,
    gate: {
      tier: 'high',
      maxDrawCalls: high.maxDrawCalls,
      maxTriangles: high.maxTriangles,
      drawCallsOk,
      trianglesOk,
      ok: drawCallsOk && trianglesOk,
    },
  };

  console.info(formatBenchReport(report));
  return report;
}
