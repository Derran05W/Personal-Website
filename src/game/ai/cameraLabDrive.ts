// Phase 33 camera lab — the SCRIPTED LAB DRIVE. A deterministic, seeded ~60 s auto-cruise of the
// PLAYER'S OWN car around downtown Toronto, used by the Playwright battery (scripts/camera-lab.mjs)
// to collect per-preset camera-clip statistics (world/toronto/cameraClipStats.ts) on an IDENTICAL
// path for every candidate rig. Same path + same duration for A/B/C/D/E ⇒ the clip counters are
// comparable; anything less and a "worse" preset might just have driven a different street.
//
// It is the CRUISE variant of ai/chaosBench.ts's auto-drive and deliberately reuses that module's
// exported helpers (nearestNodeId / pickNextWaypoint / yawFromQuaternion) and its drive-loop
// technique verbatim: pursueSteer aimed at a graph waypoint passed as the `player` argument with a
// ZERO velocity, fully-clear AvoidHits (the traffic graph's nodes already sit on drivable lane
// centrelines, so a road-following loop needs no raycasts), commands fed through the ONE scripted-
// driver seam every synthetic driver uses (input/keyboard.ts's setDrivingInputOverride). Read that
// file's header for the full rationale — none of it is restated here.
//
// What is DIFFERENT from the chaos bench, and why:
//   • NO heat is granted, NO pursuit roster is filled, invincibility is NOT touched. The lab is
//     measuring the CAMERA, and a pursuit swarm would change what the camera sees (and, via the
//     tier zoom, the follow distance itself — see `tierAtEnd` below).
//   • Speed is GOVERNED (CRUISE_SPEED_MPS, capped by CRUISE_THROTTLE_MAX) and a wedge is broken out
//     of sooner (LAB_STEERING): the bench wants maximum chaos, the lab wants a car that corners
//     instead of ricocheting off the streetwall — a run spent grinding a wall samples one
//     accidental vantage, not a drive.
//   • The circuit is CONSTRAINED to a downtown rect (see downtownDriveRect) so the drive stays in
//     the tower canyon where the camera-phasing complaint actually lives, instead of wandering up
//     the fold corridor into the sparse North York capsule.
//   • The whole route is PLANNED UP FRONT from the seeded stream (planWaypointRoute) rather than
//     rolled at each arrival. Identical in outcome (a waypoint choice depends only on the node it
//     leaves, never on the car's pose), but it makes the path a pure function of (seed, start node)
//     that unit tests can pin — and it lets an unreachable waypoint be abandoned on a timeout
//     without desynchronising the two runs the reproducibility gate diffs.
//   • The drive TELEPORTS to its own deterministic start (the graph node at the shipped player
//     spawn) before driving, so `seed` alone fixes the entire path. Two drives, any time, any
//     preset, same route.
//
// MEASURED CAVEAT (2026-07-26, this container, SwiftShader): the ROUTE is deterministic, but how
// far along it the car gets in a fixed wall-clock window is not — the live city is full of traffic,
// curb-parked cars that overlap the graph's own lanes, and street furniture, and headless frame
// pacing varies run to run. Two same-seed drives therefore produce waypoint logs that agree
// entry-for-entry but may differ in LENGTH by one (measured: 14 vs 15 over 60 s) — and the leg the
// longer run adds can swing the clip RATES well past the ±10% reproducibility bar (measured: 33%
// vs 43% boresightRate when a 10th leg entered a canyon block). `stopAfterWaypoints` exists for
// exactly this: it boxes the drive by ROUTE COVERAGE instead of wall-clock, so two same-seed runs
// cover identical legs and the rates carry the whole reproducibility burden. The battery's
// evidence passes run in waypoint mode; pure time mode remains for open-ended cruising.
//
// DEV-only: like chaosBench.ts this module ships nowhere near production — its only consumer is
// core/debugBridge.ts, itself an `import.meta.env.DEV` dynamic import from game/index.tsx.

import { createRng } from '../world/rng';
import { playerVehicle } from '../vehicles/playerRef';
import { getGameState } from '../state/store';
import { canTransition } from '../state/machine';
import { setDrivingInputOverride } from '../input';
import { pursueSteer, initialStuckState, type AvoidHits, type StuckState } from './aiSteering';
import { nearestNodeId, pickNextWaypoint, yawFromQuaternion } from './chaosBench';
import { AI_STEERING, SPAWN } from '../config';
import { WORLD_SOURCE } from '../config/worldSource';
import type { DistrictId } from '../config/torontoDistricts';
import { buildDistricts } from '../world/toronto/districts';
import { mapToWorld } from '../world/toronto/projection';
import { buildTorontoRoadGraph } from '../world/toronto/roadGraph';
import { buildStreets } from '../world/toronto/streets';
import { TORONTO_SPAWN_POSE } from '../world/toronto/torontoSceneHelpers';
import {
  readCameraClipStats,
  resetCameraClipStats,
  type CameraClipStats,
} from '../world/toronto/cameraClipStats';
import type { TrafficGraph, TrafficNode } from '../world/types';
import type { VehiclePose } from '../vehicles/IVehicleModel';

// --- tunables (dev/lab-only tool; module consts rather than a config block, exactly as
// chaosBench.ts's own header argues — this file only ever ships in the DEV-gated chunk) ---------
const THINK_HZ = SPAWN.aiTickHz; // the same 10 Hz decision cadence every ai/* driver runs at
const THINK_INTERVAL_MS = Math.round(1000 / THINK_HZ);
const THINK_INTERVAL_SEC = THINK_INTERVAL_MS / 1000;
/** Arrival radius. A shade wider than chaosBench's 5 m, and deliberately so: the Toronto graph's
 * inter-node hops run 16-45 wu, and a near-miss that does NOT count as arrival sends the car into
 * a wide re-approach loop (measured live: 50 m of extra driving to come back for a waypoint it had
 * already passed 2 m from). Still far under the shortest hop, so no waypoint is skipped for free. */
const ARRIVE_DIST_M = 7;
/** Cruise SPEED governor (m/s) + its P-controller, modelled on aiSteering's own orbit-throttle
 * controller. A flat throttle cap is not enough on the compacted map: pursueSteer's pursue branch
 * happily holds throttle down a long straight, and the raycast chassis at 16 m/s has a turn radius
 * far wider than a downtown block — measured live, the car blew a waypoint and drove 50 m past it
 * on full lock. Governing SPEED (not throttle) keeps the turn radius inside a city block, so the
 * drive threads real streets instead of pinballing, and keeps incidental collision heat down.
 *
 * TUNED LIVE at 5 m/s. At 7 the car still clipped curb-parked cars hard enough to be deflected
 * across the road into the streetwall — 40-100 hp per 15 s drive, so the third drive of a battery
 * would WRECK (and the lab may not switch invincibility on: that would change nothing about the
 * camera but a lot about the physics being measured). At 5 the same 60 s route costs ZERO hp
 * twice over, covers MORE ground (271-320 m of path, 84-100 m from the start vs 80-93 at 7), and
 * ends at tier 0. */
const CRUISE_SPEED_MPS = 5;
const CRUISE_THROTTLE_BASE = 0.35;
const CRUISE_SPEED_GAIN = 0.12;
/** Hard ceiling on the governed throttle — the governor's output is min'd with this AND with
 * pursueSteer's own command, so the stuck-recovery command (throttle 0 + brake 1 = reverse) and
 * the corner-throttle ease both survive untouched. */
const CRUISE_THROTTLE_MAX = 0.55;
/** A waypoint the car cannot reach within this long is abandoned and the drive moves to the next
 * one. Without it a single wedge (a fallen prop, a construction fence) parks the whole measured
 * run against one wall — and the two runs of the reproducibility gate would diverge in length for
 * a purely physical reason. At the governed cruise a 16-45 wu hop takes ~2-6 s, and pursueSteer's
 * own stuck reversal fires at 3 s, so 6 s is "recovery already had its chance". */
const WAYPOINT_TIMEOUT_SEC = 6;
/** Pure-pursuit look-ahead (m): the drive STEERS at the first route node at least this far away,
 * while ARRIVAL is still judged against the current one. Aiming straight at a node you are almost
 * on top of turns a metre of lateral error into a huge heading error — with AI_STEERING's
 * steerGain 2.2 (full lock at 26°) that pins the wheel hard left/right on alternate ticks, and the
 * measured result was a car sawing across its lane into the curb-parked cars. One node of
 * look-ahead is the standard fix and keeps the car tracking the lane instead of the point. */
const LOOKAHEAD_M = 14;
// --- grind escape ---------------------------------------------------------------------------
// aiSteering's own stuck detector needs speed < stuckSpeedMps (0.5) CONTINUOUSLY for stuckSec; a
// car leaning on a curb-parked car jitters between 0.15 and 0.97 m/s, so slowSec resets every few
// ticks and the reversal never fires. Measured live: 8 s pinned in one spot bleeding 50 hp. This
// is a displacement-based backstop — if the car has not covered PROGRESS_DIST_M in GRIND_SEC it
// is grinding, whatever the speedometer says, so back out and re-route.
const PROGRESS_DIST_M = 3;
const GRIND_SEC = 2.5;
const ESCAPE_SEC = 1.2;
/** Route length budget: waypoints planned per second of drive, plus a fixed margin. Generous —
 * an unconsumed tail costs nothing but a few rng rolls, while running OUT of route mid-drive
 * would park the car (see the drive tick's end-of-route brake). */
const ROUTE_STEPS_PER_SEC = 2;
const ROUTE_STEPS_MARGIN = 8;
const DEFAULT_SECONDS = 60;
const DEFAULT_SEED = 1;
const READY_TIMEOUT_MS = 10_000;
const READY_POLL_MS = 100;
// --- warm-up (see waitForSteadyFrames) ------------------------------------------------------
// A cold Toronto mount spends its first seconds building frontage/furniture/the clip index, and a
// multi-second main-thread stall ends in a Rapier catch-up burst that LAUNCHES the car (measured
// live: 0 -> 20.9 m/s across one stall, straight into the first intersection). Both the physics
// and the clip counters would be charged to whichever preset happened to be measured first.
const WARMUP_POLL_MS = 150;
/** Frames the sampler must advance per poll to count the page as "actually rendering" (≥ ~13 fps
 * — well under SwiftShader's real cadence here, but far above a stalling mount). */
const WARMUP_MIN_FRAMES = 2;
const WARMUP_STEADY_POLLS = 4;
const WARMUP_TIMEOUT_MS = 8_000;
/** Settle window after the teleport, so the chassis is resting on its suspension (and any burst
 * has been absorbed) before the measured window opens. */
const SETTLE_MS = 500;

const CLEAR_HITS: AvoidHits = { center: 1, left: 1, right: 1 };
const ZERO_VEL = { x: 0, z: 0 };

/**
 * The shipped pursuit tuning with ONE lab-local override: a wedge is broken out of at 1.5 s
 * instead of 3 s (with a slightly longer reversal). A pursuit unit that reverses too eagerly stops
 * being a threat, so config/vehicles.ts's AI_STEERING is correctly patient — but a wedged lab
 * drive is spending MEASURED seconds staring at one wall, which skews every clip rate for that
 * preset. Proven necessary live: the cruise grinds against the odd curb-parked car (they are
 * dynamic props, and the graph's lane sits close enough to the parking strip to clip one), and at
 * the shipped 3 s the car ate most of a short drive against a single one. Everything else — gains,
 * corner ease, avoidance weights, press/ram bands — is the shipped math, untouched.
 */
const LAB_STEERING = { ...AI_STEERING, stuckSec: 1.5, reverseSec: 1.2 };

/**
 * The districts whose union bounding box IS the lab's downtown rect. Named by id (never by
 * coordinate — world/toronto/cameraVantages.ts's KENSINGTON_DISTRICT_ID sets the precedent), so
 * the rect follows the street table if anchors ever move:
 *   financial        — the bank-tower canyon; the camera-phasing complaint's home ground
 *   entertainment    — King West towers/podiums, the second-densest streetwall
 *   yongeDundasQueen — the Yonge spine's busiest blocks (Eaton Centre, Sankofa screens)
 *   stLawrence       — the low-rise east edge, so the drive also samples a NON-canyon block
 * The bounding box necessarily also covers slivers of the neighbours it spans (kingWest,
 * genericDowntown, queenWest) — that is intended: they are downtown streets too, and a rect is
 * what the waypoint filter can test in one comparison per node.
 */
const DOWNTOWN_CORE_DISTRICT_IDS: readonly DistrictId[] = [
  'financial',
  'entertainment',
  'yongeDundasQueen',
  'stLawrence',
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================================
// Pure helpers (unit-tested — no Rapier/three/store side effects)
// ============================================================================================

/** An axis-aligned WORLD-space XZ rectangle the drive's waypoints must stay inside. */
export interface DriveRect {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

/**
 * The downtown rect the lab drive is confined to: the union bounding box of
 * DOWNTOWN_CORE_DISTRICT_IDS' resolved rects, routed through mapToWorld so the map(x,y) →
 * world(x,z) axis seam stays single-sourced (it is the identity swap, but re-deriving it here by
 * hand is exactly how a rect silently transposes). Pure + deterministic — the district tiling is a
 * function of the street table and the polygon, with no seed involved.
 */
export function downtownDriveRect(): DriveRect {
  const districts = buildDistricts();
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const id of DOWNTOWN_CORE_DISTRICT_IDS) {
    const resolved = districts.find((rd) => rd.def.id === id);
    if (!resolved) {
      // Loud, not silent: a missing district means the config was renamed and the "downtown rect"
      // no longer means downtown — the same drift-catching stance cameraVantages.ts takes.
      throw new Error(`cameraLabDrive: district '${id}' is not in TORONTO_DISTRICTS`);
    }
    for (const rect of resolved.rects) {
      const [ax, az] = mapToWorld({ x: rect.minX, y: rect.minY });
      const [bx, bz] = mapToWorld({ x: rect.maxX, y: rect.maxY });
      minX = Math.min(minX, ax, bx);
      maxX = Math.max(maxX, ax, bx);
      minZ = Math.min(minZ, az, bz);
      maxZ = Math.max(maxZ, az, bz);
    }
  }
  return { minX, maxX, minZ, maxZ };
}

/** Is this graph node inside the drive rect? Boundary-inclusive (a node exactly on a district
 * edge is a downtown node). */
export function nodeInRect(rect: DriveRect, node: { readonly x: number; readonly z: number }): boolean {
  return node.x >= rect.minX && node.x <= rect.maxX && node.z >= rect.minZ && node.z <= rect.maxZ;
}

/**
 * One rect-constrained circuit-advance step. Wraps chaosBench's own `pickNextWaypoint` (so the
 * outEdges/edge-index contract has exactly one implementation) with two filters, applied in order:
 *
 *   1. RECT — `pickEdge` is only ever offered edges whose FAR node is inside `rect`.
 *   2. NO U-TURN — given where the car came from (`prevNodeId`, −1 at the very first step), edges
 *      that double back on the arrival heading are dropped whenever anything else remains. The
 *      Toronto graph gives every hub an outgoing edge onto the OPPOSITE direction's lane chain (a
 *      free U-turn, roadGraph.ts's own no-sink guarantee), so an unfiltered random walk turns
 *      around constantly: a measured 60 s drive covered 328 m of path but never got more than 80 m
 *      from where it started. Dropping the reversal turns the same walk into an actual cruise.
 *
 * When no outgoing edge stays inside the rect (the car has been pushed out, or sits on its very
 * edge), the fallback picks — DETERMINISTICALLY, consuming no rng — the edge whose far node is
 * nearest the rect centre, i.e. it heads back downtown. Ties break toward the earlier edge index,
 * which is stable because the graph's node/edge order is a pure function of the street table.
 */
export function pickDowntownWaypoint(
  graph: TrafficGraph,
  currentNodeId: number,
  rect: DriveRect,
  pickEdge: (edgeIndices: readonly number[]) => number,
  prevNodeId = -1,
): number {
  const cx = (rect.minX + rect.maxX) / 2;
  const cz = (rect.minZ + rect.maxZ) / 2;
  return pickNextWaypoint(graph, currentNodeId, (outs) => {
    const inside = outs.filter((e) => nodeInRect(rect, graph.nodes[graph.edges[e].to]));
    if (inside.length > 0) return pickEdge(withoutUTurns(graph, currentNodeId, prevNodeId, inside));
    let best = outs[0];
    let bestDistSq = Infinity;
    for (const e of outs) {
      const to = graph.nodes[graph.edges[e].to];
      const distSq = (to.x - cx) ** 2 + (to.z - cz) ** 2;
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        best = e;
      }
    }
    return best;
  });
}

/** Cosine of the arrival→departure angle below which a turn counts as doubling back. −0.3 ≈ 107°,
 * so every real turn (≈90°) survives and only genuine reversals are dropped. */
const U_TURN_DOT = -0.3;

/** `edges` minus the ones that double back on the heading the car arrived on — unless that would
 * leave nothing, in which case the original list is returned (a true dead end must still be
 * drivable). A no-op when there is no arrival heading yet (`prevNodeId < 0`). */
function withoutUTurns(
  graph: TrafficGraph,
  currentNodeId: number,
  prevNodeId: number,
  edges: readonly number[],
): readonly number[] {
  if (prevNodeId < 0 || edges.length < 2) return edges;
  const prev = graph.nodes[prevNodeId];
  const cur = graph.nodes[currentNodeId];
  const inLen = Math.hypot(cur.x - prev.x, cur.z - prev.z);
  if (inLen < 1e-6) return edges;
  const ix = (cur.x - prev.x) / inLen;
  const iz = (cur.z - prev.z) / inLen;
  const forward = edges.filter((e) => {
    const to = graph.nodes[graph.edges[e].to];
    const outLen = Math.hypot(to.x - cur.x, to.z - cur.z);
    if (outLen < 1e-6) return true;
    return (ix * (to.x - cur.x) + iz * (to.z - cur.z)) / outLen > U_TURN_DOT;
  });
  return forward.length > 0 ? forward : edges;
}

/**
 * The whole drive path, planned up front: `steps` successive rect-constrained waypoint choices
 * from `startNodeId`. A pure function of (graph, startNodeId, rect, the pickEdge stream) — which
 * is what makes two same-seed drives comparable at all. Stops early at a node with no outgoing
 * edge (the graph's own no-sink invariant says that never happens; degrading beats throwing).
 *
 * The returned array does NOT include `startNodeId` — it is the list of TARGETS, in order.
 */
export function planWaypointRoute(
  graph: TrafficGraph,
  startNodeId: number,
  rect: DriveRect,
  pickEdge: (edgeIndices: readonly number[]) => number,
  steps: number,
): number[] {
  const route: number[] = [];
  let previous = -1;
  let current = startNodeId;
  for (let i = 0; i < steps; i++) {
    const next = pickDowntownWaypoint(graph, current, rect, pickEdge, previous);
    if (next === current) break; // sink node: nowhere to go
    route.push(next);
    previous = current;
    current = next;
  }
  return route;
}

/**
 * Pure-pursuit aim selection: the index into `route` of the first node at or beyond `lookaheadM`
 * from (x, z), scanning forward from `fromIndex`. Never scans past the end (the last node is the
 * fallback), and never returns an index before `fromIndex`, so the aim point only ever moves
 * forward along the planned route. See LOOKAHEAD_M for why the drive steers at this instead of at
 * the arrival waypoint.
 */
export function aimIndexFor(
  nodes: readonly TrafficNode[],
  route: readonly number[],
  fromIndex: number,
  x: number,
  z: number,
  lookaheadM: number,
): number {
  let i = fromIndex;
  while (i < route.length - 1) {
    const n = nodes[route[i]];
    if (Math.hypot(n.x - x, n.z - z) >= lookaheadM) break;
    i++;
  }
  return i;
}

// ============================================================================================
// Report
// ============================================================================================

export interface CameraLabDriveReport {
  /** world/toronto/cameraClipStats.ts's counters, accumulated over THIS drive only (they are
   * reset at drive start). Compare RATES (counter ÷ frames) between presets, never raw counts. */
  readonly stats: CameraClipStats;
  /** The waypoint node ids the drive was steered through, in order — a prefix of the seeded route.
   * A waypoint abandoned on WAYPOINT_TIMEOUT_SEC is still logged: the log mirrors the path the car
   * was DRIVEN along, so two same-seed drives agree entry-for-entry even if one made less progress
   * (the battery's reproducibility gate diffs exactly this array). */
  readonly waypoints: readonly number[];
  readonly seconds: number;
  readonly seed: number;
  /** The stopAfterWaypoints target this run drove under (null = pure time mode). When set and
   * `waypoints.length` equals it, the run ended by covering the full target route — two such
   * same-seed runs covered IDENTICAL legs and their rates are directly comparable. */
  readonly waypointTarget: number | null;
  /** Heat at drive end. The drive grants none itself, but ramming civilians/props during the
   * cruise does — reported honestly rather than suppressed. */
  readonly heatAtEnd: number;
  /** Wanted tier at drive end. NON-ZERO CONTAMINATES A PRESET COMPARISON: the camera rig adds
   * follow distance per tier (config/camera.ts), so a run that picked up stars was shot from a
   * different rig than the one under test. The battery treats tierAtEnd > 0 as a re-run signal. */
  readonly tierAtEnd: number;
  /** Convenience mirror of `stats.frames` — the denominator for every rate above. Zero means the
   * clip sampler never ran (world not mounted / not a DEV build), NOT a perfectly clean camera. */
  readonly framesObserved: number;
}

/** Pure formatter for the console line the bridge call prints (mirrors chaosBench's
 * formatBenchReport split: the numbers are testable without a live drive). */
export function formatDriveReport(report: CameraLabDriveReport): string {
  const f = report.framesObserved;
  const rate = (n: number): string => (f > 0 ? `${((n / f) * 100).toFixed(1)}%` : 'n/a');
  const s = report.stats;
  return [
    `[cameraLabDrive] ${report.seconds.toFixed(0)}s seed ${report.seed} — ` +
      `${report.waypoints.length} waypoints, ${f} frames`,
    `  eyeInside ${rate(s.eyeInsideFrames)}  nearPlane ${rate(s.nearPlaneFrames)}` +
      `  occluded ${rate(s.occludedFrames)}  clamped ${rate(s.clampedFrames)}`,
    `  boresight blocked ${rate(s.boresightBlockedFrames)}` +
      `  (mean depth ${s.boresightBlockedFrames > 0 ? (s.boresightHitSum / s.boresightBlockedFrames).toFixed(2) : 'n/a'})`,
    `  occluders  mean ${f > 0 ? (s.occlusionHitSum / f).toFixed(2) : 'n/a'}  max ${s.occlusionHitMax}`,
    `  heat ${report.heatAtEnd.toFixed(0)} tier ${report.tierAtEnd}` +
      `${report.tierAtEnd > 0 ? '  ← CONTAMINATED (tier zoom changed the rig)' : ''}`,
  ].join('\n');
}

// ============================================================================================
// Drive run
// ============================================================================================

/** Polls until the machine reaches PLAYING and the player vehicle ref is populated. Both waits
 * are necessary and for the reasons ai/chaosBench.ts's ensurePlaying/waitForPlayerReady document
 * at length (React-commit race between <Canvas> painting and PlayerVehicle publishing its ref) —
 * kept local rather than imported because those helpers are module-private there, and the standing
 * perf harness is not this task's file to reshape. */
async function waitForDrivablePlayer(): Promise<NonNullable<typeof playerVehicle.current>> {
  const start = performance.now();
  while (performance.now() - start < READY_TIMEOUT_MS) {
    const state = getGameState();
    if (state.machine !== 'PLAYING' && canTransition(state.machine, 'PLAYING')) {
      state.transition('PLAYING');
    }
    const player = playerVehicle.current;
    if (getGameState().machine === 'PLAYING' && player) return player;
    await sleep(READY_POLL_MS);
  }
  throw new Error(
    `cameraLabDrive: player never became drivable within ${READY_TIMEOUT_MS}ms ` +
      `(machine ${getGameState().machine}, vehicle ${playerVehicle.current ? 'ready' : 'null'})`,
  );
}

/**
 * Blocks until the page is delivering frames STEADILY (or WARMUP_TIMEOUT_MS elapses — a slow
 * machine still gets its drive, just a colder one). The frame counter it watches is the clip
 * sampler's own denominator, so this needs no extra plumbing and measures exactly the loop the
 * drive is about to be judged on. See the WARMUP_* constants for why a cold mount must never be
 * inside the measured window.
 */
async function waitForSteadyFrames(): Promise<void> {
  const start = performance.now();
  let last = readCameraClipStats().frames;
  let steady = 0;
  while (performance.now() - start < WARMUP_TIMEOUT_MS) {
    await sleep(WARMUP_POLL_MS);
    const now = readCameraClipStats().frames;
    steady = now - last >= WARMUP_MIN_FRAMES ? steady + 1 : 0;
    last = now;
    if (steady >= WARMUP_STEADY_POLLS) return;
  }
}

/** The Toronto road graph, resolved exactly the way ai/chaosBench.ts resolves it for the shipped
 * world (a pure, seed-independent function of the street table — no world-mount ref to wait on).
 * The camera lab is Toronto-only by construction: the clip index it measures is built from the
 * Toronto scene's own layouts, so a legacy build has nothing to report. */
function resolveDowntownGraph(): TrafficGraph {
  if (WORLD_SOURCE !== 'toronto') {
    throw new Error(`cameraLabDrive: WORLD_SOURCE is '${WORLD_SOURCE}' — the camera lab is Toronto-only`);
  }
  return buildTorontoRoadGraph(buildStreets().streets);
}

/** Start pose on `node`, yawed to face `aim` so the drive opens by moving forward instead of
 * hunting through a U-turn. Chassis height comes from the shipped Toronto spawn pose (the settle
 * height world/spawn.ts picked), never a fresh literal. Quaternion is a plain yaw about +Y, which
 * matches the +Z-model-forward / atan2(dx,dz) convention every steering module uses. */
function startPoseAt(node: TrafficNode, aim: TrafficNode | null): VehiclePose {
  const yaw = aim ? Math.atan2(aim.x - node.x, aim.z - node.z) : 0;
  return {
    position: { x: node.x, y: TORONTO_SPAWN_POSE.position.y, z: node.z },
    rotation: { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) },
  };
}

export interface CameraLabDriveOptions {
  /** Drive length in seconds (default 60). With `stopAfterWaypoints` set this is a CEILING, not
   * the normal end condition. */
  readonly seconds?: number;
  /** Waypoint-stream seed (default 1). Same seed ⇒ same route, always. */
  readonly seed?: number;
  /** End the drive once this many route waypoints have been logged (reached OR abandoned),
   * `seconds` remaining as the safety ceiling. This is the REPRODUCIBILITY mode: a time-boxed
   * drive covers a different amount of route per run under unstable headless fps (measured live:
   * 10 vs 9 waypoints and 33% vs 43% boresightRate for the same seed), while a waypoint-boxed
   * drive covers the identical route legs every run — and since the waypoint log is by
   * construction a strict prefix of the seeded route, equal counts ⇒ identical sequences.
   * Omit/0 = pure time mode (the original behavior). */
  readonly stopAfterWaypoints?: number;
}

let activeDrive: Promise<CameraLabDriveReport> | null = null;

/**
 * Run the scripted camera-lab drive once and resolve with its clip statistics. Idempotent while in
 * flight — a second call returns the SAME promise rather than overlapping two drivers on one car
 * (the exact contract ai/chaosBench.ts's startChaosBench offers, for the same reason).
 *
 * The drive teleports the car to its own deterministic downtown start before driving, so the whole
 * path is fixed by `seed` alone: whatever the battery did for its vantage screenshots does not
 * leak into the measured run.
 */
export function startCameraLabDrive(opts?: CameraLabDriveOptions): Promise<CameraLabDriveReport> {
  if (activeDrive) return activeDrive;
  const run = runDriveOnce(
    opts?.seconds ?? DEFAULT_SECONDS,
    opts?.seed ?? DEFAULT_SEED,
    opts?.stopAfterWaypoints ?? 0,
  ).finally(() => {
    activeDrive = null;
  });
  activeDrive = run;
  return run;
}

async function runDriveOnce(secondsRaw: number, seed: number, stopAfterRaw: number): Promise<CameraLabDriveReport> {
  const seconds = Math.max(THINK_INTERVAL_SEC, secondsRaw);
  // ≤0 (the default) = pure time mode. See CameraLabDriveOptions.stopAfterWaypoints.
  const stopAfterWaypoints = stopAfterRaw > 0 ? Math.floor(stopAfterRaw) : null;
  const player = await waitForDrivablePlayer();
  await waitForSteadyFrames();
  const graph = resolveDowntownGraph();
  const rect = downtownDriveRect();

  const rng = createRng(seed).fork('cameraLabDrive');
  const pickEdge = (ids: readonly number[]): number => rng.pick(ids);

  // Deterministic start: the graph node nearest the SHIPPED player spawn (config/torontoMap.ts's
  // TORONTO_SPAWN — downtown Yonge between Dundas and Queen, inside the rect, and the one downtown
  // spot the game itself vets as clean and legible). Not the rect centre: that lands mid-block in
  // whatever lane happens to be nearest, and the first pick landed on a Bay St lane whose curb
  // parking encroaches the driving line — the car spent whole measured runs fighting one parked
  // car (see PROGRESS_DIST_M). Yonge is the widest ribbon on the map, so the drive opens on the
  // cleanest line available, and it also means the lab sees exactly what a player sees at t=0.
  const startNodeId = nearestNodeId(graph.nodes, TORONTO_SPAWN_POSE.position.x, TORONTO_SPAWN_POSE.position.z);
  // Waypoint mode still plans off the TIME budget (its ceiling) so the same seed yields the same
  // route regardless of which end condition is in play — planWaypointRoute consumes the rng
  // sequentially, so a longer plan is always a strict prefix-extension of a shorter one (pinned
  // by test). The floor just guarantees the plan can't be shorter than the waypoint target.
  const steps = Math.max(
    Math.ceil(seconds * ROUTE_STEPS_PER_SEC) + ROUTE_STEPS_MARGIN,
    (stopAfterWaypoints ?? 0) + ROUTE_STEPS_MARGIN,
  );
  const route = planWaypointRoute(graph, startNodeId, rect, pickEdge, steps);
  player.reset(startPoseAt(graph.nodes[startNodeId], route.length > 0 ? graph.nodes[route[0]] : null));
  await sleep(SETTLE_MS);

  const waypoints: number[] = [];
  let routeIndex = 0;
  let waypointSec = 0;
  let stuck: StuckState = initialStuckState;
  // Grind-escape bookkeeping (see the PROGRESS_DIST_M block).
  const startPos = graph.nodes[startNodeId];
  let progressAnchor = { x: startPos.x, z: startPos.z };
  let progressSec = 0;
  let escapeSec = 0;
  let escapeCount = 0;

  /** Abandon the current waypoint and move to the next. Shared by every "this one is not
   * happening" path (arrival timeout, stuck reversal, grind escape) so the waypoint LOG always
   * mirrors the route positions the car was actually steered along. */
  function advanceWaypoint(): void {
    waypoints.push(route[routeIndex]);
    routeIndex++;
    waypointSec = 0;
  }

  function driveTick(): void {
    const state = getGameState();
    if (state.machine !== 'PLAYING') {
      // Revive and keep measuring. Unlike chaosBench there is nothing to re-grant after
      // combat/runLoop.ts's runReset() — the lab drive never granted heat in the first place.
      if (canTransition(state.machine, 'PLAYING')) state.transition('PLAYING');
      return;
    }
    const vehicle = playerVehicle.current;
    if (!vehicle) return;

    if (routeIndex >= route.length) {
      // Route exhausted (only reachable if the car ate the whole generous budget): coast to a
      // stop rather than hold the last command, so the tail of the run isn't a wall grind.
      setDrivingInputOverride({ steer: 0, throttle: 0, brake: 1, handbrake: false });
      return;
    }

    const readState = vehicle.readState();
    const pos = readState.rawPose.position;
    const yaw = yawFromQuaternion(readState.rawPose.rotation);
    const speed = Math.hypot(readState.velocity.x, readState.velocity.z);

    // Grind escape: reverse blind for ESCAPE_SEC, alternating lock so a repeat escape never
    // repeats the same failed manoeuvre. pursueSteer is skipped (and its stuck memory cleared)
    // for the duration — this IS the recovery.
    if (escapeSec > 0) {
      escapeSec -= THINK_INTERVAL_SEC;
      stuck = initialStuckState;
      progressAnchor = { x: pos.x, z: pos.z };
      progressSec = 0;
      setDrivingInputOverride({
        steer: escapeCount % 2 === 0 ? 1 : -1,
        throttle: 0,
        brake: 1,
        handbrake: false,
      });
      return;
    }
    if (Math.hypot(pos.x - progressAnchor.x, pos.z - progressAnchor.z) >= PROGRESS_DIST_M) {
      progressAnchor = { x: pos.x, z: pos.z };
      progressSec = 0;
    } else {
      progressSec += THINK_INTERVAL_SEC;
      if (progressSec >= GRIND_SEC) {
        escapeSec = ESCAPE_SEC;
        escapeCount++;
        advanceWaypoint();
        if (routeIndex >= route.length) return;
      }
    }

    const target = graph.nodes[route[routeIndex]];
    const dist = Math.hypot(target.x - pos.x, target.z - pos.z);
    waypointSec += THINK_INTERVAL_SEC;
    if (dist < ARRIVE_DIST_M || waypointSec >= WAYPOINT_TIMEOUT_SEC) {
      advanceWaypoint();
      if (routeIndex >= route.length) return; // steered next tick by the branch above
    }
    const node = graph.nodes[route[aimIndexFor(graph.nodes, route, routeIndex, pos.x, pos.z, LOOKAHEAD_M)]];

    // Aimed at a STATIONARY point, pursueSteer resolves to its ram/press-in branches inside
    // commitDistM/pressDistM — which also SUPPRESSES stuck detection within pressDistM of the
    // target (aiSteering.ts step 5: leaning on a stopped "player" is the intended terminal state).
    // The look-ahead keeps the aim point ≥ LOOKAHEAD_M out for most of the drive, so those bands
    // (and that suppression) only engage on the route's final node — where WAYPOINT_TIMEOUT_SEC
    // is the backstop.
    const wasReversing = stuck.reverseRemainSec > 0;
    const result = pursueSteer(
      { x: pos.x, z: pos.z, yaw },
      speed,
      { x: node.x, z: node.z },
      ZERO_VEL,
      CLEAR_HITS,
      stuck,
      LAB_STEERING,
      THINK_INTERVAL_SEC,
      'pursue',
    );
    stuck = result.stuck;
    // UNSTICK ⇒ RE-ROUTE. A reversal that has just been triggered means the line to THIS waypoint
    // is physically blocked (measured live: a curb-parked car half-inside the lane). Backing off
    // and then re-aiming at the same node just drives back into it — the car ping-ponged inside a
    // 20 m box for a whole 25 s test that way. Abandoning the waypoint at the moment the reversal
    // starts sends the car somewhere else once it is free, which is what a driver would do.
    if (!wasReversing && stuck.reverseRemainSec > 0) advanceWaypoint();
    const governed = Math.min(
      CRUISE_THROTTLE_MAX,
      Math.max(0, CRUISE_THROTTLE_BASE + (CRUISE_SPEED_MPS - speed) * CRUISE_SPEED_GAIN),
    );
    setDrivingInputOverride({
      steer: result.command.steer,
      throttle: Math.min(result.command.throttle, governed),
      brake: result.command.brake,
      handbrake: false,
    });
  }

  resetCameraClipStats();
  try {
    await new Promise<void>((resolve) => {
      // Waypoint mode ends the run the tick the target count is logged; the time box stays armed
      // as the safety ceiling either way (a wedged car must never hang the battery's await).
      const interval = setInterval(() => {
        driveTick();
        if (stopAfterWaypoints !== null && waypoints.length >= stopAfterWaypoints) {
          clearInterval(interval);
          clearTimeout(ceiling);
          resolve();
        }
      }, THINK_INTERVAL_MS);
      const ceiling = setTimeout(() => {
        clearInterval(interval);
        resolve();
      }, seconds * 1000);
    });
  } finally {
    // Always hand the car back to the keyboard — a lab tool that leaves the player's input
    // silently overridden is a far worse bug than anything it exists to measure.
    setDrivingInputOverride(null);
  }

  const stats = readCameraClipStats();
  const state = getGameState();
  const report: CameraLabDriveReport = {
    stats,
    waypoints,
    seconds,
    seed,
    waypointTarget: stopAfterWaypoints,
    heatAtEnd: state.heat,
    tierAtEnd: state.tier,
    framesObserved: stats.frames,
  };
  console.info(formatDriveReport(report));
  return report;
}
