// Phase 74 feel lab — the ROUTE DRIVES (plan Decision 3, `routes` mode). Deterministic, seeded
// scripted drives through the LIVE city (traffic on, transit on, parked cars on, furniture on,
// infill on — everything the shipped game runs) whose job is to produce the CONTACT, STUCK-EVENT
// and AIRTIME statistics the Feel Spec's route-mode rows are written against. The other half of
// the lab (dev/feelProbes.ts) runs controlled manoeuvres with the world switched off; a turn
// radius at 15 m/s is unmeasurable in traffic, and contacts/min is unmeasurable on an empty
// straight, so the two modes exist and share one telemetry core (dev/feelTelemetry.ts).
//
// --- what this module IS: the Phase 33 camera-lab drive, generalized ---------------------------
// ai/cameraLabDrive.ts is a mature, unit-tested scripted-drive implementation. This module REUSES
// its exported pure helpers verbatim — `downtownDriveRect`, `nodeInRect`, `planWaypointRoute`
// (which is itself the `pickDowntownWaypoint` walk), `aimIndexFor`, the `DriveRect` type — rather
// than growing a second copy of the rect/waypoint/pure-pursuit math. Everything those functions
// decide (rect-constrained random walk, no-U-turn filter, plan-the-whole-route-up-front
// determinism, look-ahead aim selection) is identical here, so a fix over there is a fix here.
//
// What it does NOT reuse is that file's module-PRIVATE machinery (`waitForDrivablePlayer`,
// `waitForSteadyFrames`, `startPoseAt`, the grind-escape drive loop). Those are private by design
// and cameraLabDrive.ts:414-418 records the reason: the standing perf harness / camera lab are not
// a passing task's files to reshape. Copying the local pattern is the accepted precedent in this
// repo (cameraLabDrive itself did the same to ai/chaosBench.ts), so that is what happens below —
// with the DIFFERENCES called out at each site instead of silently drifting.
//
// --- the four routes, and why each one exists --------------------------------------------------
// A single downtown circuit answers one question. The feel complaints (overview D1-D8) live in
// three different kinds of street plus the chase, so there are four:
//
//   downtownDense — the Phase 33 downtown rect, unchanged (financial / entertainment /
//                   yongeDundasQueen / stLawrence). The tower-canyon navigability case: densest
//                   streetwall, most parked cars, most traffic. This is the route the camera lab
//                   drove, so its numbers sit alongside P33/P34's on the same ground.
//   spineCruise   — the Yonge stem north (foldCorridor / northYorkCentre / willowdaleFinch). Long
//                   straights, sparse frontage, the widest ribbon on the map. The look-ahead /
//                   open-road case: what the car does when nothing is in the way is the control
//                   for everything the dense routes measure. (It crosses the Line 1 fold, so the
//                   HUD tunnel wash fires mid-run — a cosmetic overlay with no gameplay effect;
//                   hud/TunnelOverlay.tsx, audio/eventMap.ts marks it an explicit no-op.)
//   minorWeave    — chinatownKensington + queenWest. The "can you even fit" case (D2): the
//                   narrowest ribbons on the map, market stalls and patio dressing crowding the
//                   curb, and the parked-car strip encroaching the driving line. Phase 75 widens
//                   these; this route is the before.
//   chase3        — the downtown rect again, but with heat granted to ★3 BEFORE the measured
//                   window opens, so police + armored + SWAT are live and pressing in. The
//                   pursuit-contact case (D5/D6): what fraction of contacts are cops, how much
//                   speed a press-in costs, and whether the player gets pinned.
//
// Route bounds are ALWAYS derived from district ids through buildDistricts() + mapToWorld(), never
// from coordinate literals — the same rule (and the same loud throw on a renamed district) that
// cameraLabDrive.ts:163-180 sets, so a rect follows the street table if an anchor ever moves.
//
// --- speed policy: the ONE important departure from the camera lab -----------------------------
// cameraLabDrive governs to CRUISE_SPEED_MPS = 5 — a crawl — and its own header explains why: it
// was measuring the CAMERA and wanted a car that corners instead of ricocheting off the
// streetwall. That reasoning does not transfer. A feel drive governed to 5 m/s would measure
// nothing about feel: no contact happens hard enough to matter, no corner loads the tyres, no
// stuck event forms behind a car you were never going fast enough to catch. Worse, the exact
// behaviour that file lists as its reason to slow down — "at 7 the car still clipped curb-parked
// cars hard enough to be deflected across the road into the streetwall, 40-100 hp per 15 s" — is
// this lab's SIGNAL. That is the D1/D2 complaint, photographed in numbers.
//
// So the routes run at a realistic pace, expressed as a FRACTION of the resolved car's own top
// speed (vehicles/definitions.ts getSelectedCarDef().topSpeed, itself from config/carTuning.ts's
// SPEED_TOP_SPEED_MPS — never a hardcoded 25). Fraction, not an absolute, because Phase 81
// re-runs this battery across all six cars: at a fixed 15 m/s the bus would be flat out and the
// sports car loafing, and the two runs would not be comparable at all. Every report records the
// resolved absolute target AND the achieved mean/median/p95/max, so a reader can always see what
// pace the numbers describe rather than having to trust the governor.
//
// --- invincibility is ON for route drives ------------------------------------------------------
// Saved and restored exactly as ai/chaosBench.ts:374-375 does for the standing perf harness. The
// rationale is a sampling one, not a convenience one: a run that WRECKS halfway through returns a
// TRUNCATED contact sample, and a truncated sample silently biases every per-minute rate. The
// flag is HP-only — verified this phase, its sole consumer is an early return in
// combat/damage.ts:247's applyPlayerDamage, and no force/impulse/suspension path reads it — so it
// cannot bias the physics being measured; it only stops a 15 m/s downtown circuit from ending at
// t=22 s. Wreck-TRIGGERING events are still recorded as data (they arrive through the telemetry's
// impact stream like any other contact); the drive simply refuses to let one end the window.
//
// Two paths still end a run past invincibility — `enteredWater` and `leftWorld` route straight to
// GAMEOVER in combat/runLoop.ts without consulting HP at all — so the drive tick keeps
// chaosBench's belt-and-suspenders revival (transition back to PLAYING, re-grant the route's
// required tier because runReset() zeroes heat) and COUNTS the revivals into the report. A route
// that keeps drowning is a finding, not something to hide.
//
// DEV-only: like ai/chaosBench.ts and ai/cameraLabDrive.ts this module ships nowhere near
// production. Its only consumer is core/debugBridge.ts, itself an `import.meta.env.DEV` dynamic
// import from game/index.tsx — which is what makes Phase 74's "zero prod bytes" claim structural
// rather than a grep.

import { createRng } from '../world/rng';
import { playerVehicle } from '../vehicles/playerRef';
import { getGameState } from '../state/store';
import { canTransition } from '../state/machine';
import { getDevToggles, setDevToggle, type DevToggles } from '../core/devToggles';
import { setDrivingInputOverride } from '../input';
import { pursueSteer, initialStuckState, type AvoidHits, type StuckState } from '../ai/aiSteering';
import { nearestNodeId, yawFromQuaternion } from '../ai/chaosBench';
import {
  aimIndexFor,
  downtownDriveRect,
  nodeInRect,
  planWaypointRoute,
  type DriveRect,
} from '../ai/cameraLabDrive';
import { trafficRef } from '../ai/trafficTypes';
import { unitsRef, type UnitKind } from '../ai/pursuitTypes';
import { AI_STEERING, HEAT, SPAWN, SPAWN_COMPOSITION, SPEED_TOP_SPEED_MPS } from '../config';
import { WORLD_SOURCE } from '../config/worldSource';
import type { DistrictId } from '../config/torontoDistricts';
import { getSelectedCarDef } from '../vehicles/definitions';
import { buildDistricts } from '../world/toronto/districts';
import { mapToWorld, YONGE_X } from '../world/toronto/projection';
import { buildTorontoRoadGraph } from '../world/toronto/roadGraph';
import { buildStreets } from '../world/toronto/streets';
import { TORONTO_SPAWN_POSE } from '../world/toronto/torontoSceneHelpers';
import { readCameraClipStats } from '../world/toronto/cameraClipStats';
import type { TrafficGraph, TrafficNode } from '../world/types';
import type { VehiclePose } from '../vehicles/IVehicleModel';
import {
  FEEL_TELEMETRY_DEFAULTS,
  markFeelPhase,
  readFeelTelemetry,
  startFeelTelemetry,
  stopFeelTelemetry,
  type FeelTelemetrySnapshot,
} from './feelTelemetry';

// ============================================================================================
// Tunables. Module consts rather than a config block, for the reason ai/chaosBench.ts's own
// header argues: this whole file only ever ships in the DEV-gated chunk, and a lab knob is not a
// game tunable. Where a value differs from ai/cameraLabDrive.ts's, the difference is derived
// below rather than picked.
// ============================================================================================

const THINK_HZ = SPAWN.aiTickHz; // the same 10 Hz decision cadence every ai/* driver runs at
const THINK_INTERVAL_MS = Math.round(1000 / THINK_HZ);
const THINK_INTERVAL_SEC = THINK_INTERVAL_MS / 1000;

/** Arrival radius FLOOR (m) — the camera lab's proven 7 (a shade over chaosBench's 5, sized so a
 * near-miss does not send the car into a 50 m re-approach loop). At feel pace the floor alone is
 * not enough: at 21 m/s the car covers 2.1 m per decision tick, so a 7 m ball is three ticks wide
 * and a fast pass can skim it. `arriveDistFor` widens it with speed (ARRIVE_LOOKAHEAD_SEC of
 * travel), keeping the same number of decision ticks inside the window at every pace.
 *
 * The CEILING is the load-bearing one, and it is derived: the arrival radius must stay strictly
 * below LOOKAHEAD_MIN_M, or the arrival test can out-reach the aim point and the drive "arrives"
 * at a node it is still steering toward — a controller fighting itself. (Note what is NOT claimed:
 * the graph's shortest hop is ~4 wu at hub lane-chain offsets, so NO arrival radius can promise
 * never to consume two waypoints in quick succession; the camera lab's 7 m floor has exactly the
 * same property. The waypoint LOG records every node consumed or abandoned either way, so the
 * reproducibility key is unaffected.) */
const ARRIVE_DIST_MIN_M = 7;
const ARRIVE_DIST_MAX_M = 12;
const ARRIVE_LOOKAHEAD_SEC = 0.5;

/** Pure-pursuit look-ahead FLOOR (m) and its speed term. The camera lab's flat 14 m was tuned at
 * a 5 m/s crawl — 2.8 s of travel. Held flat at feel pace it becomes 0.7 s of travel at 21 m/s,
 * and a look-ahead shorter than the car's own reaction distance is what makes a pure-pursuit
 * controller saw across its lane (cameraLabDrive's LOOKAHEAD_M block documents that failure at
 * the crawl; it gets sharper, not softer, with speed). Aiming ONE SECOND ahead is the standard
 * formulation and reduces to the proven 14 m whenever the car is below 14 m/s — i.e. the camera
 * lab's tuning is the floor of this one, not a different rule. */
const LOOKAHEAD_MIN_M = 14;
const LOOKAHEAD_SEC = 1.0;

/** Speed governor: throttle = clamp(BASE + (target − speed) · GAIN, 0, MAX), then min'd with
 * pursueSteer's own command so the corner-throttle ease and the stuck-recovery command (throttle
 * 0 + brake 1 = reverse) both survive untouched. The camera lab caps the governor's output at
 * 0.55 because it is holding 5 m/s; a cap below 1 here would simply prevent the car from ever
 * REACHING an 18-21 m/s target, so the cap is 1 and the P-term does the work. BASE is the
 * steady-state hold (throttle at target speed) and GAIN zeroes it ~2.2 m/s over target — the
 * drive never brakes to hold pace, because a synthetic brake input would land in the telemetry's
 * brake channel and contaminate the very numbers the probes measure honestly. Overshoot is
 * therefore possible on a downhill straight and is reported (achieved max) rather than hidden. */
const CRUISE_THROTTLE_BASE = 0.4;
const CRUISE_SPEED_GAIN = 0.18;
const CRUISE_THROTTLE_MAX = 1;

/** A waypoint the car cannot reach within this long is abandoned and the drive moves on — without
 * it a single wedge parks the whole measured run against one wall. Unchanged from the camera lab:
 * a 16-45 wu hop takes 0.8-3 s at feel pace (vs 2-6 s at the crawl), so 6 s is still comfortably
 * "recovery already had its chance" and the two labs stay comparable on the one number that ends
 * a leg early. */
const WAYPOINT_TIMEOUT_SEC = 6;

// --- grind escape ----------------------------------------------------------------------------
// Displacement-based backstop, same shape as the camera lab's (aiSteering's own stuck detector
// needs speed < 0.5 m/s CONTINUOUSLY, and a car leaning on a curb-parked car jitters between 0.15
// and 0.97 m/s, so the reversal never fires). What CHANGED is the dwell, and it is derived, not
// picked:
//
// This lab exists to COUNT stuck events. dev/feelTelemetry.ts's detector declares one after
// `stuckEnterSec` of sub-threshold speed with throttle held, and its `isUnrecoverableStuck` — the
// Phase 74 gate — additionally needs `stuckUnrecoverableSec` of dwell PAST that declaration. An
// escape that fired sooner would truncate every event the Feel Spec's gate is about to be written
// against; the drive would be grading its own homework. So the dwell is DERIVED from the
// detector's own published thresholds (never a local copy of them) plus a margin:
//
//   GRIND_SEC = stuckEnterSec (1.5) + stuckUnrecoverableSec (1.0) + margin (1.5) = 4.0 s
//
// Two consequences worth stating, because they are what makes the escape measurement-neutral:
//   • By the time an escape fires, the open event has already accrued ≈ GRIND_SEC − stuckEnterSec
//     = 2.5 s of `recoverySec`, comfortably past the 1.0 s gate — so the escape can never MANUFACTURE
//     an unrecoverable verdict that the physics had not already earned.
//   • The escape's throttle-0 command exceeds the detector's `stuckReleaseSec` (0.5 s), so it
//     closes the event as `abandoned` (recovered: false). That is the honest label: the scripted
//     driver could not get out on its own and had to blind-reverse.
const GRIND_ESCAPE_MARGIN_SEC = 1.5;
const GRIND_SEC =
  FEEL_TELEMETRY_DEFAULTS.stuckEnterSec +
  FEEL_TELEMETRY_DEFAULTS.stuckUnrecoverableSec +
  GRIND_ESCAPE_MARGIN_SEC;
/** Displacement (m) that counts as "still making progress". Deliberately tiny: at any real pace
 * the car clears 3 m in a fraction of a second, so the grind timer only ever runs during genuine
 * near-zero progress — GRIND_SEC's dwell is not silently shortening legitimate slow driving. */
const PROGRESS_DIST_M = 3;
const ESCAPE_SEC = 1.2;

/** A per-tick position delta larger than this is a TELEPORT, not driving — a revive respawns the
 * car at the shipped spawn, and folding that jump into `pathLengthM` would report a route that
 * covered hundreds of metres it never drove. Derived from the roster's fastest car
 * (config/carTuning.ts SPEED_TOP_SPEED_MPS, grade A = 32 m/s → 3.2 m per 100 ms tick) with a 4×
 * margin, so no amount of legitimate speed can trip it. Same defence dev/feelTelemetry.ts applies
 * to its own distance integral via `teleportSkips`; counted here too rather than silently dropped. */
const TELEPORT_JUMP_M = 4 * Math.max(...Object.values(SPEED_TOP_SPEED_MPS)) * THINK_INTERVAL_SEC;

/** Route length budget: waypoints planned per second of drive, plus a fixed margin. Raised from
 * the camera lab's 2/s, and sized to the HARD BOUND rather than to a typical pace, because a
 * typical pace is not what would break it. Running out of route mid-drive parks the car for the
 * remainder of a measured window — the one outcome that must never happen — and the consumption
 * rate is not bounded by driving speed at all: the Toronto graph's hub lane-chain offsets are as
 * short as 4.1 wu (MEASURED across all edges; cameraLabDrive's quoted "16-45 wu" is the typical
 * street hop, not the floor), which is inside the 7 m arrival radius, so a chain of them is
 * consumed one per DECISION TICK regardless of pace. One tick can also advance the waypoint up to
 * three times (grind escape, then arrival, then an unstick re-route), so:
 *
 *   ROUTE_STEPS_PER_SEC = maxAdvancesPerTick (3) × THINK_HZ (10) = 30
 *
 * i.e. the plan is provably longer than any drive can consume. The cost of being wrong in this
 * direction is ~1,800 rng rolls per 60 s run — microseconds, once, before the car moves. */
const MAX_WAYPOINT_ADVANCES_PER_TICK = 3;
const ROUTE_STEPS_PER_SEC = MAX_WAYPOINT_ADVANCES_PER_TICK * THINK_HZ;
const ROUTE_STEPS_MARGIN = 16;

const DEFAULT_SECONDS = 60;
const DEFAULT_SEED = 1;
const READY_TIMEOUT_MS = 10_000;
const READY_POLL_MS = 100;

// --- warm-up (see waitForSteadyFrames) --------------------------------------------------------
// A cold Toronto mount spends its first seconds building frontage/furniture/the clip index, and a
// multi-second main-thread stall ends in a Rapier catch-up burst that LAUNCHES the car (measured
// at Phase 33: 0 -> 20.9 m/s across one stall). In the camera lab that polluted the clip counters;
// here it would post a fabricated airtime event and a fabricated 20 m/s contact into the FIRST
// route measured, and nothing downstream could tell it from a real one.
const WARMUP_POLL_MS = 150;
const WARMUP_MIN_FRAMES = 2;
const WARMUP_STEADY_POLLS = 4;
const WARMUP_TIMEOUT_MS = 8_000;
/** Settle window after the teleport, so the chassis is resting on its suspension (and any burst
 * has been absorbed) before the measured window opens. */
const SETTLE_MS = 500;

// --- tier arming (chase3) ---------------------------------------------------------------------
/** How long to wait for the granted tier AND a live roster before opening the window. The tier
 * itself is instantaneous (state/store.ts's addHeat recomputes it synchronously); the roster is
 * not — ai/spawnDirector.ts fills on its own ~2 Hz maintenance pass, so this poll force-spawns on
 * top of it exactly as ai/chaosBench.ts:332's fillRoster does. */
const TIER_ARM_TIMEOUT_MS = 8_000;
const TIER_ARM_POLL_MS = 150;
/** Pursuit units that must be alive before a chase route's window opens. Not the tier's full cap
 * (SPAWN.caps[3] = 8): waiting for a full roster can outlast the arm timeout on a slow headless
 * frame, and a route that opens with 3 cars on it is already measuring pursuit contact. The
 * actual count at window open is recorded either way, so the report never overstates the arm. */
const CHASE_MIN_PURSUIT_UNITS = 3;

const CLEAR_HITS: AvoidHits = { center: 1, left: 1, right: 1 };
const ZERO_VEL = { x: 0, z: 0 };

/**
 * The shipped pursuit tuning with ONE override: the synthetic driver breaks out of a wedge at
 * `DRIVER_UNWEDGE_SEC` instead of the shipped `AI_STEERING.stuckSec` (3 s).
 *
 * *** THIS WAS ORIGINALLY THE OPPOSITE, AND THE OPPOSITE WAS A CIRCULAR MEASUREMENT. ***
 *
 * The first version of this file used `AI_STEERING` unchanged, reasoning that "the wedge IS the
 * measurement, so shortening the shipped dwell would shorten every stuck event this lab is
 * chartered to count." That reasoning is backwards, and the Phase 74 baseline battery proved it:
 *
 *   • The telemetry detector declares a stuck event after `stuckEnterSec` (1.5 s) below
 *     0.5 m/s with throttle held, and calls it UNRECOVERABLE at `stuckUnrecoverableSec` (1.0 s)
 *     of further immobility — a 2.5 s total budget.
 *   • The shipped driver recovery does not even TRIGGER until 3.0 s below the SAME 0.5 m/s
 *     threshold (`config/vehicles.ts:358-360`).
 *   • 3.0 > 2.5, so EVERY wedge the synthetic driver enters is classified unrecoverable *by
 *     construction*, whatever the city does. The metric measured the driver's patience.
 *
 * Measured, high tier, 60 s per route, shipped-`AI_STEERING` build: 5-8 stuck events per route,
 * 25/28 of them "unrecoverable", **100 % cause-tagged `building`**, zero `onVehicle` — i.e. it was
 * not even sampling the ride-over class (user issue #14) that Phase 77 exists to fix. A control
 * sweep at cruise 5 / 9 / 15 m/s returned 5 / 5 / 6 events: flat in speed, which rules out "the
 * driver is simply going too fast" and points squarely at the timer relationship above.
 *
 * So the override is REQUIRED for the metric to mean anything, and it is bounded by an invariant
 * rather than a taste: the driver's recovery must begin strictly before the detector's
 * unrecoverable threshold, so that a wedge the driver can drive out of does NOT score as a trap.
 * `feelDrives.test.ts` pins that inequality — if either constant moves, the test fails loudly
 * instead of the baseline drifting silently.
 *
 * What this does NOT fix: the synthetic driver still hits buildings far more than a human would
 * (pure pursuit cuts corners into a streetwall that sits right at the ribbon edge). Route-mode
 * stuck counts therefore remain DRIVER-INFLUENCED and are a WATCH metric, not the Phase 77 gate —
 * the gate rests on the purpose-built trap probes the part file already mandates for P77.
 */
const DRIVER_UNWEDGE_SEC = 1.5;
const DRIVER_UNWEDGE_REVERSE_SEC = 1.2;
/** Exported solely so `feelDrives.test.ts` can pin the driver-vs-detector timer invariant. */
export const FEEL_STEERING = {
  ...AI_STEERING,
  stuckSec: DRIVER_UNWEDGE_SEC,
  reverseSec: DRIVER_UNWEDGE_REVERSE_SEC,
};

/** The ★3 mix, read off the shipped composition table rather than spelled out — a Part-19 phase
 * that re-weights ★3 changes what `chase3` arms with, automatically and correctly. Force-spawning
 * a kind the tier does not contain (a tank at ★3) would measure a different game. */
const CHASE_ROSTER_KINDS: readonly UnitKind[] = SPAWN_COMPOSITION.tiers[3].map((e) => e.kind);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================================
// Route registry
// ============================================================================================

export type FeelRouteId = 'downtownDense' | 'spineCruise' | 'minorWeave' | 'chase3';

/**
 * Where a route teleports to before driving. Every option is DERIVED (from the shipped spawn, the
 * projection's own Yonge constant, or the route's resolved rect) — never a coordinate literal —
 * so an anchor follows the street table for the same reason the rects do.
 */
export type FeelRouteAnchorKind = 'shippedSpawn' | 'yongeAtRectCentre' | 'rectCentre';

export interface FeelRouteDef {
  readonly id: FeelRouteId;
  /** Human label for the console line / contact sheet. */
  readonly label: string;
  /** The districts whose union bounding box is the route's rect. Named by id, never coordinates. */
  readonly districtIds: readonly DistrictId[];
  /**
   * The route's rect. A thunk, not a value, because `buildDistricts()` must not run at module
   * import time (the registry is imported by unit tests and by the bridge long before anything
   * needs a rect). `downtownDense`/`chase3` hand this straight to ai/cameraLabDrive.ts's OWN
   * export so the two labs provably measure the same downtown; the rest use the generalization
   * below, which a test pins as identical on downtown's own ids.
   */
  readonly rect: () => DriveRect;
  readonly anchor: FeelRouteAnchorKind;
  /**
   * Governed cruise speed as a fraction of the resolved car's top speed. See the header's speed
   * policy block for why this is a fraction and not an absolute. Values are the pace a competent
   * player would actually hold on that kind of street, not a physics limit.
   */
  readonly cruiseFracOfTopSpeed: number;
  /** Wanted tier that must be LIVE before the measured window opens (0 = grant nothing). */
  readonly requireTier: number;
  /** Which overview diagnosis item this route is the evidence for. */
  readonly answers: string;
}

/** The four routes. Uniform `seconds` (DEFAULT_SECONDS) across all of them on purpose: every
 * headline route metric is a per-minute RATE or a per-event statistic, and equal windows make the
 * four directly comparable without anyone having to renormalise. */
export const FEEL_ROUTES: Readonly<Record<FeelRouteId, FeelRouteDef>> = {
  downtownDense: {
    id: 'downtownDense',
    label: 'Downtown canyon — dense streetwall, full traffic',
    // EXACTLY the Phase 33 set (cameraLabDrive.ts's DOWNTOWN_CORE_DISTRICT_IDS), restated so the
    // registry-integrity test can resolve it; the rect thunk below still delegates to that file.
    districtIds: ['financial', 'entertainment', 'yongeDundasQueen', 'stLawrence'],
    rect: downtownDriveRect,
    anchor: 'shippedSpawn',
    // 0.60 → 15 m/s on the starter sedan. Brisk downtown pace: fast enough that a curb-parked car
    // deflects rather than nudges (which is the complaint), slow enough to be a pace a player
    // would choose rather than a demolition run.
    cruiseFracOfTopSpeed: 0.6,
    requireTier: 0,
    answers: 'D1/D2 — traffic stacking and "too dense to navigate", in the worst streetwall',
  },
  spineCruise: {
    id: 'spineCruise',
    label: 'Yonge spine north — long straights, sparse frontage',
    districtIds: ['foldCorridor', 'northYorkCentre', 'willowdaleFinch'],
    rect: () => districtUnionRect(FEEL_ROUTES.spineCruise.districtIds),
    anchor: 'yongeAtRectCentre',
    // 0.85 → 21.25 m/s on the starter sedan. The open-road control: near the car's own envelope,
    // where look-ahead, high-speed steer clamp and straight-line stability are what is on trial.
    cruiseFracOfTopSpeed: 0.85,
    requireTier: 0,
    answers: 'the open-road control — look-ahead and high-speed response with nothing in the way',
  },
  minorWeave: {
    id: 'minorWeave',
    label: 'Kensington / Queen West — narrow side streets',
    districtIds: ['chinatownKensington', 'queenWest'],
    rect: () => districtUnionRect(FEEL_ROUTES.minorWeave.districtIds),
    // Rect centre, and the awkwardness is deliberate. cameraLabDrive's own start-node note warns
    // that a rect centre "lands mid-block in whatever lane happens to be nearest" and picked a Bay
    // St lane whose curb parking encroaches the driving line. For the camera lab that was a defect
    // (it wanted a clean vantage); for THIS route it is the case under test — "can you even fit"
    // is answered from the same cramped lane a player would be in.
    anchor: 'rectCentre',
    // 0.45 → 11.25 m/s on the starter sedan. Still 2.25× the camera lab's crawl, and about as
    // fast as these ribbons allow before every corner is a wall contact.
    cruiseFracOfTopSpeed: 0.45,
    requireTier: 0,
    answers: 'D2 — "roads too narrow"; the before-picture for Phase 75\'s road widening',
  },
  chase3: {
    id: 'chase3',
    label: 'Downtown chase ★3 — police + armored + SWAT live',
    districtIds: ['financial', 'entertainment', 'yongeDundasQueen', 'stLawrence'],
    rect: downtownDriveRect,
    anchor: 'shippedSpawn',
    // 0.70 → 17.5 m/s on the starter sedan. Faster than the un-chased downtown route because
    // being chased is the reason a player drives faster than is sensible — and the pursuit-contact
    // numbers are only meaningful at the pace the pursuit actually happens at.
    cruiseFracOfTopSpeed: 0.7,
    requireTier: 3,
    answers: 'D5/D6 — pursuit tracking, press-in contact, and whether the player gets pinned',
  },
};

export const FEEL_ROUTE_IDS: readonly FeelRouteId[] = Object.keys(FEEL_ROUTES) as FeelRouteId[];

/** Route lookup that fails LOUDLY on an unknown id. The bridge (and the battery script behind it)
 * pass a plain string across `page.evaluate`, so this is the one place a typo can be caught before
 * it silently becomes "ran downtownDense four times". */
export function resolveFeelRoute(id: string): FeelRouteDef {
  const route = (FEEL_ROUTES as Readonly<Record<string, FeelRouteDef | undefined>>)[id];
  if (!route) {
    throw new Error(`feelDrives: unknown route '${id}' (known: ${FEEL_ROUTE_IDS.join(', ')})`);
  }
  return route;
}

// ============================================================================================
// Pure helpers (unit-tested — no Rapier/three/store side effects)
// ============================================================================================

/**
 * Union bounding box, in WORLD space, of every rect of every named district — the generalization
 * of ai/cameraLabDrive.ts's `downtownDriveRect` to an arbitrary district set. Routed through
 * `mapToWorld` so the map(x,y) → world(x,z) axis seam stays single-sourced (it is the identity
 * swap, but re-deriving it by hand is exactly how a rect silently transposes). Pure and
 * deterministic — the district tiling is a function of the street table and the polygon, with no
 * seed involved.
 *
 * A missing district throws rather than silently shrinking the rect: a renamed district means the
 * route no longer means what its name says. Same drift-catching stance as cameraLabDrive.ts:216
 * and world/toronto/cameraVantages.ts.
 *
 * Pinned by test against `downtownDriveRect()` on downtown's own ids, so this generalization can
 * never drift from the P33 original it is a copy of.
 */
export function districtUnionRect(ids: readonly DistrictId[]): DriveRect {
  if (ids.length === 0) throw new RangeError('feelDrives: districtUnionRect() needs ≥1 district');
  const districts = buildDistricts();
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const id of ids) {
    const resolved = districts.find((rd) => rd.def.id === id);
    if (!resolved) throw new Error(`feelDrives: district '${id}' is not in TORONTO_DISTRICTS`);
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

/** The route's world-space rect. */
export function feelRouteRect(id: FeelRouteId): DriveRect {
  return FEEL_ROUTES[id].rect();
}

/**
 * The route's deterministic start ANCHOR (a world XZ the start node is snapped to — not itself a
 * node). Every branch derives its coordinates:
 *   shippedSpawn      — config/torontoMap.ts's TORONTO_SPAWN, i.e. the spot the game itself vets
 *                       as clean and legible, and the same start the camera lab uses.
 *   yongeAtRectCentre — projection.ts's own YONGE_X (the spine is straight at x = YONGE_X BY
 *                       CONSTRUCTION), projected once so the map→world seam is honoured, at the
 *                       rect's mid-latitude. The widest, cleanest ribbon on the map.
 *   rectCentre        — the geometric centre of the route's own rect.
 */
export function feelRouteAnchor(id: FeelRouteId): { readonly x: number; readonly z: number } {
  const rect = feelRouteRect(id);
  const midZ = (rect.minZ + rect.maxZ) / 2;
  switch (FEEL_ROUTES[id].anchor) {
    case 'shippedSpawn':
      return { x: TORONTO_SPAWN_POSE.position.x, z: TORONTO_SPAWN_POSE.position.z };
    case 'yongeAtRectCentre': {
      const [yongeWorldX] = mapToWorld({ x: YONGE_X, y: 0 });
      return { x: yongeWorldX, z: midZ };
    }
    case 'rectCentre':
      return { x: (rect.minX + rect.maxX) / 2, z: midZ };
  }
}

/**
 * Nearest graph node to (x, z) CONSTRAINED to the route's own rect, falling back to the whole
 * graph if the rect somehow contains none. The constraint matters for determinism, not aesthetics:
 * a start node outside the rect makes the first planned hop take `pickDowntownWaypoint`'s
 * head-back-toward-the-centre fallback (which consumes no rng), so the same seed would produce a
 * different opening leg depending on where the graph happened to put its nearest node.
 */
export function nearestNodeIdInRect(
  nodes: readonly TrafficNode[],
  rect: DriveRect,
  x: number,
  z: number,
): number {
  const inside = nodes.filter((n) => nodeInRect(rect, n));
  return nearestNodeId(inside.length > 0 ? inside : nodes, x, z);
}

/** The planned route + the start node it was planned from — everything about a drive's path that
 * is decided BEFORE the car moves. */
export interface FeelRoutePlan {
  readonly routeId: FeelRouteId;
  readonly rect: DriveRect;
  readonly startNodeId: number;
  /** The TARGET node ids, in order. Does not include `startNodeId`. */
  readonly waypoints: readonly number[];
}

/**
 * How many waypoints to plan for a window. Generous by design: an unconsumed tail costs a few rng
 * rolls, while running OUT of route mid-window would park the car for the remainder of a measured
 * run — the one outcome that must never happen. Waypoint mode raises the FLOOR while `seconds`
 * still sets its usual value, and because planWaypointRoute consumes the rng strictly
 * sequentially, a longer plan is always a strict prefix-extension of a shorter one — so the same
 * seed yields the same opening route whichever budget wins the max().
 */
export function feelRouteSteps(seconds: number, stopAfterWaypoints: number | null): number {
  return Math.max(
    Math.ceil(seconds * ROUTE_STEPS_PER_SEC) + ROUTE_STEPS_MARGIN,
    (stopAfterWaypoints ?? 0) + ROUTE_STEPS_MARGIN,
  );
}

/**
 * The whole path a drive will follow, as a pure function of (graph, route, seed, steps). THIS is
 * what makes two runs comparable at all: the route is planned up front from the seeded stream
 * rather than rolled at each arrival — identical in outcome (a waypoint choice depends only on the
 * node it leaves, never on the car's pose) but it makes the path testable without a browser, and
 * it lets an unreachable waypoint be abandoned mid-drive without desynchronising two runs the
 * battery diffs. The drive loop calls exactly this; nothing about the path is decided elsewhere.
 */
export function planFeelRoute(
  graph: TrafficGraph,
  routeId: FeelRouteId,
  seed: number,
  steps: number,
): FeelRoutePlan {
  const rect = feelRouteRect(routeId);
  const anchor = feelRouteAnchor(routeId);
  const startNodeId = nearestNodeIdInRect(graph.nodes, rect, anchor.x, anchor.z);
  const rng = createRng(seed).fork(`feelDrive:${routeId}`);
  const waypoints = planWaypointRoute(graph, startNodeId, rect, (ids) => rng.pick(ids), steps);
  return { routeId, rect, startNodeId, waypoints };
}

/** Pure-pursuit look-ahead distance (m) at a given planar speed. See LOOKAHEAD_MIN_M/_SEC. */
export function lookaheadFor(speedMps: number): number {
  return Math.max(LOOKAHEAD_MIN_M, LOOKAHEAD_SEC * Math.max(0, speedMps));
}

/** Arrival radius (m) at a given planar speed, clamped to [ARRIVE_DIST_MIN_M, ARRIVE_DIST_MAX_M].
 * See those constants for why the ceiling exists. */
export function arriveDistFor(speedMps: number): number {
  const scaled = ARRIVE_LOOKAHEAD_SEC * Math.max(0, speedMps);
  return Math.min(ARRIVE_DIST_MAX_M, Math.max(ARRIVE_DIST_MIN_M, scaled));
}

/** The speed governor's throttle command, before it is min'd with pursueSteer's own. */
export function governedThrottle(targetMps: number, speedMps: number): number {
  const raw = CRUISE_THROTTLE_BASE + (targetMps - speedMps) * CRUISE_SPEED_GAIN;
  return Math.min(CRUISE_THROTTLE_MAX, Math.max(0, raw));
}

export interface SpeedStats {
  readonly samples: number;
  readonly meanMps: number;
  readonly medianMps: number;
  readonly p95Mps: number;
  readonly maxMps: number;
}

/** Nearest-rank percentile on a sorted-ascending copy. `frac` in [0,1]; `sorted` non-empty. */
function percentile(sorted: readonly number[], frac: number): number {
  const rank = Math.ceil(frac * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

/**
 * Achieved-pace summary over the drive's own 10 Hz speed samples. Reported so a reader can see
 * what pace the contact/stuck numbers describe rather than assuming the governor's target was
 * met — in dense traffic it routinely is not, and the gap between target and achieved is itself
 * one of the phase's findings. Sampled at the DECISION cadence, not per frame: enough to
 * characterise pace, never a substitute for dev/feelTelemetry.ts's own per-frame integrals.
 */
export function speedStats(samples: readonly number[]): SpeedStats {
  if (samples.length === 0) {
    return { samples: 0, meanMps: 0, medianMps: 0, p95Mps: 0, maxMps: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  let sum = 0;
  for (const v of samples) sum += v;
  return {
    samples: samples.length,
    meanMps: sum / samples.length,
    medianMps: percentile(sorted, 0.5),
    p95Mps: percentile(sorted, 0.95),
    maxMps: sorted[sorted.length - 1],
  };
}

// ============================================================================================
// Report
// ============================================================================================

/** The dev toggles a route report records. `applied` is what the DRIVE set (and restored);
 * `observed` is what the world was actually running with when the window opened — so a battery
 * run made with `civTraffic` accidentally off can never be mistaken for a live-city measurement. */
export interface FeelDriveToggles {
  readonly applied: Readonly<Record<string, boolean>>;
  readonly observed: Readonly<Record<string, boolean>>;
}

export interface FeelDriveDriverStats {
  /** Governed target the drive was asked to hold (m/s), and where it came from. */
  readonly cruiseTargetMps: number;
  readonly cruiseFracOfTopSpeed: number;
  readonly topSpeedMps: number;
  readonly carId: string;
  readonly waypointsPlanned: number;
  /** Decision ticks executed inside the measured window. */
  readonly ticks: number;
  /** Total path length walked (m), summed over decision ticks with teleport jumps excluded. */
  readonly pathLengthM: number;
  /** Per-tick position jumps too large to be driving (a revive respawn). Excluded from
   * `pathLengthM` and counted here rather than silently dropped. */
  readonly teleportSkips: number;
  /** Straight-line distance from the start node to where the car finished (m). A route with a
   * big path length and a small net displacement spent the window going nowhere. */
  readonly netDisplacementM: number;
  /** Waypoints abandoned by each of the three "this one is not happening" paths. */
  readonly timeoutAbandons: number;
  readonly unstickAbandons: number;
  readonly grindEscapes: number;
  /** Times the machine left PLAYING (water / out-of-bounds — neither honours invincibility) and
   * the drive revived it. Non-zero is a finding about the route, not a harness detail. */
  readonly revives: number;
  /** The escape policy the durations above were measured under (see the grind-escape block). */
  readonly grindEscapeAfterSec: number;
}

export interface FeelDriveReport {
  readonly routeId: FeelRouteId;
  readonly label: string;
  readonly districtIds: readonly string[];
  readonly rect: DriveRect;
  readonly seed: number;
  /** Requested window length (s) — the ceiling. */
  readonly seconds: number;
  /** Measured window length (s), wall-clock from open to close. The denominator for every rate. */
  readonly elapsedSec: number;
  readonly startNodeId: number;
  /**
   * The waypoint node ids the drive was steered through, in order — a strict prefix of the seeded
   * route. THE REPRODUCIBILITY KEY: two same-seed runs must log identical sequences (a waypoint
   * abandoned on a timeout is still logged, so the log mirrors the path the car was DRIVEN along,
   * not just the ones it reached). Lengths may differ by a leg or two under unstable headless
   * frame pacing — `stopAfterWaypoints` boxes by route coverage instead when that matters.
   */
  readonly waypoints: readonly number[];
  readonly waypointTarget: number | null;
  readonly speed: SpeedStats & { readonly targetMps: number };
  readonly heatAtStart: number;
  readonly heatAtEnd: number;
  readonly tierAtStart: number;
  readonly tierAtEnd: number;
  /** The tier the route REQUIRED before opening its window (0 for the three plain routes). */
  readonly requiredTier: number;
  /** Whether the required tier was actually reached before the window opened — polled and
   * verified, never assumed. `false` on a plain route is impossible (nothing was required); on
   * `chase3` it invalidates the run and the formatter says so. */
  readonly tierArmed: boolean;
  readonly pursuitUnitsAtStart: number;
  readonly maxPursuitUnits: number;
  readonly maxTrafficUnits: number;
  readonly toggles: FeelDriveToggles;
  readonly driver: FeelDriveDriverStats;
  /** dev/feelTelemetry.ts's snapshot for THIS window only (reset at window open). Plain JSON. */
  readonly telemetry: FeelTelemetrySnapshot;
}

function fmt(n: number, digits = 1): string {
  return Number.isFinite(n) ? n.toFixed(digits) : 'n/a';
}

/**
 * The route-relevant half of dev/feelTelemetry.ts's snapshot, as console lines. Route mode owns
 * CONTACT / STUCK / STABILITY (plan Decision 3); the response and cornering blocks belong to
 * dev/feelProbes.ts and are deliberately not printed here — a turn radius measured in traffic is
 * not a turn radius, and printing one invites someone to read it as a result.
 *
 * `notes` is surfaced verbatim: dev/feelTelemetry.ts emits its caveats there precisely so a reader
 * cannot miss them, and a console line that drops them would defeat that. Pure — the battery's
 * results.json carries the whole snapshot regardless; these lines are for a human watching a run.
 */
export function telemetryDigestLines(s: FeelTelemetrySnapshot): readonly string[] {
  const c = s.contact;
  const k = s.stuck;
  const st = s.stability;
  // feelTelemetry reports EVERY EntityKind, most of them zero on any given route — list only the
  // kinds that were actually hit, busiest first, so the line says something.
  const byKind = c.byKind
    .filter((e) => e.events > 0)
    .sort((a, b) => b.events - a.events)
    .slice(0, 4)
    .map((e) => `${e.kind} ${e.events}`)
    .join(', ');
  const lines = [
    `contacts   ${fmt(c.eventsPerMin)}/min — ${c.events} events / ${c.records} records` +
      `  loss mean ${fmt(c.meanSpeedLossMps, 2)} max ${fmt(c.maxSpeedLossMps, 2)} m/s` +
      (byKind ? `  [${byKind}]` : ''),
    `stuck      ${k.count} events, ${k.unrecoverableCount} UNRECOVERABLE` +
      `  longest ${fmt(k.longestSec, 2)}s  total ${fmt(k.totalStuckSec, 1)}s` +
      (k.byCause.length > 0
        ? `  [${k.byCause.map((b) => `${b.cause} ${b.count}`).join(', ')}]`
        : ''),
    `stability  airtime ${fmt(st.airtimeFrac * 100)}%  slip ${fmt(s.cornering.lateralSlipFrac * 100)}%` +
      `  flips ${st.flipCount}  roll peak ${fmt(st.rollPeakRad, 2)} rad` +
      `  pitch peak ${fmt(st.pitchPeakRad, 2)} rad`,
    `sampled    ${fmt(s.timing.elapsedSec)}s over ${s.timing.samples} frames` +
      `  dt mean ${fmt(s.timing.meanDtSec * 1000, 0)} ms  max ${fmt(s.timing.maxDtSec * 1000, 0)} ms` +
      (s.timing.stalledSamples > 0 ? `  ${s.timing.stalledSamples} STALLED` : '') +
      (s.timing.droppedEvents > 0 ? `  ${s.timing.droppedEvents} events dropped` : ''),
  ];
  for (const note of s.notes) lines.push(`note       ${note}`);
  return lines;
}

/** Pure formatter for the console line the bridge call prints (same split as
 * ai/cameraLabDrive.ts's formatDriveReport and ai/chaosBench.ts's formatBenchReport: the numbers
 * are testable without a live drive). */
export function formatFeelDriveReport(report: FeelDriveReport): string {
  const d = report.driver;
  const s = report.speed;
  const lines: string[] = [
    `[feelDrive] ${report.routeId} — ${report.label}`,
    `  window     ${fmt(report.elapsedSec)}s of ${fmt(report.seconds, 0)}s requested` +
      `  seed ${report.seed}  start node ${report.startNodeId}`,
    `  pace       target ${fmt(s.targetMps)} m/s (${fmt(d.cruiseFracOfTopSpeed, 2)} × ` +
      `${fmt(d.topSpeedMps)} top, ${d.carId})  →  mean ${fmt(s.meanMps)}` +
      `  med ${fmt(s.medianMps)}  p95 ${fmt(s.p95Mps)}  max ${fmt(s.maxMps)}` +
      `  (${s.samples} samples @ ${THINK_HZ} Hz)`,
    `  route      ${report.waypoints.length} waypoints driven / ${d.waypointsPlanned} planned` +
      `  path ${fmt(d.pathLengthM, 0)} m  net ${fmt(d.netDisplacementM, 0)} m` +
      `${report.waypointTarget !== null ? `  (boxed at ${report.waypointTarget})` : ''}`,
    `  driver     ${d.timeoutAbandons} timeouts  ${d.unstickAbandons} unstick re-routes` +
      `  ${d.grindEscapes} grind escapes (after ${fmt(d.grindEscapeAfterSec)}s)` +
      `  ${d.revives} revives` +
      `${d.teleportSkips > 0 ? `  ${d.teleportSkips} teleport jumps excluded from path` : ''}`,
    `  world      pursuit ${report.pursuitUnitsAtStart} at open / ${report.maxPursuitUnits} peak` +
      `  traffic ${report.maxTrafficUnits} peak` +
      `  invincible ${report.toggles.applied.invincible ? 'ON' : 'off'} (route policy)`,
    `  heat/tier  ${fmt(report.heatAtStart, 0)}→${fmt(report.heatAtEnd, 0)}` +
      `  ★${report.tierAtStart}→★${report.tierAtEnd}  (required ★${report.requiredTier})` +
      tierNote(report),
  ];
  for (const line of telemetryDigestLines(report.telemetry)) lines.push(`  ${line}`);
  return lines.join('\n');
}

/** What a reader must know before comparing this report with another, said out loud on the
 * console line. Heat is monotonic (a locked decision) and passive accrual alone is +1/s at ★1+,
 * so escalation inside a 60 s window is normal, not a defect — but it changes who the car was
 * sharing the street with, which is precisely what route mode measures. */
function tierNote(report: FeelDriveReport): string {
  if (report.requiredTier > 0 && !report.tierArmed) {
    return `  ← NOT ARMED: the window opened below ★${report.requiredTier}, discard this run`;
  }
  if (report.tierAtEnd > Math.max(report.requiredTier, report.tierAtStart)) {
    return report.requiredTier === 0
      ? '  ← PURSUIT WENT LIVE mid-run (contacts include cops; compare with care)'
      : `  ← escalated past ★${report.requiredTier} mid-run (heat is monotonic)`;
  }
  return '';
}

// ============================================================================================
// Drive run
// ============================================================================================

/** Polls until the machine reaches PLAYING and the player vehicle ref is populated. Both waits
 * are necessary, for the reasons ai/chaosBench.ts's ensurePlaying/waitForPlayerReady document at
 * length (a React-commit race between <Canvas> painting and PlayerVehicle publishing its ref).
 * Kept local rather than imported for the reason cameraLabDrive.ts:414-418 records: those helpers
 * are module-private there, and neither the perf harness nor the camera lab is this task's file
 * to reshape. */
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
    `feelDrives: player never became drivable within ${READY_TIMEOUT_MS}ms ` +
      `(machine ${getGameState().machine}, vehicle ${playerVehicle.current ? 'ready' : 'null'})`,
  );
}

/**
 * Blocks until the page is delivering frames STEADILY (or WARMUP_TIMEOUT_MS elapses — a slow
 * machine still gets its drive, just a colder one). The counter it watches is the camera clip
 * sampler's frame denominator (world/toronto/cameraClipStats.ts, advanced once per rendered frame
 * from TorontoScene's DEV useFrame), so this needs no extra plumbing and measures exactly the loop
 * the drive is about to run inside. Read-only — the clip stats are NEVER reset here; they belong
 * to the camera lab and a feel drive has no business zeroing them.
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

/** The Toronto road graph, resolved exactly the way ai/chaosBench.ts and ai/cameraLabDrive.ts
 * resolve it for the shipped world (a pure, seed-independent function of the street table — no
 * world-mount ref to wait on). The feel lab is Toronto-only by construction: WORLD_SOURCE has been
 * permanently 'toronto' since the Phase 32 flip, and the routes are named after Toronto districts.
 */
function resolveFeelGraph(): TrafficGraph {
  if (WORLD_SOURCE !== 'toronto') {
    throw new Error(`feelDrives: WORLD_SOURCE is '${WORLD_SOURCE}' — the feel lab is Toronto-only`);
  }
  return buildTorontoRoadGraph(buildStreets().streets);
}

/** Start pose on `node`, yawed to face `aim` so the drive opens by moving forward instead of
 * hunting through a U-turn. Chassis height comes from the shipped Toronto spawn pose (the settle
 * height world/spawn.ts picked), never a fresh literal. Quaternion is a plain yaw about +Y, which
 * matches the +Z-model-forward / atan2(dx,dz) convention every steering module uses. Local copy of
 * cameraLabDrive's `startPoseAt` — private there, same accepted-duplication precedent. */
function startPoseAt(node: TrafficNode, aim: TrafficNode | null): VehiclePose {
  const yaw = aim ? Math.atan2(aim.x - node.x, aim.z - node.z) : 0;
  return {
    position: { x: node.x, y: TORONTO_SPAWN_POSE.position.y, z: node.z },
    rotation: { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) },
  };
}

/** Grants heat straight to `tier`'s threshold. Heat is monotonic (a locked decision) and
 * state/store.ts's addHeat recomputes the tier synchronously, so one grant is enough — the poll
 * around it exists for the ROSTER, not the number. */
function grantHeatToTier(tier: number): void {
  const state = getGameState();
  const target = HEAT.tierThresholds[tier];
  if (typeof target !== 'number') throw new Error(`feelDrives: no heat threshold for tier ${tier}`);
  const delta = target - state.heat;
  if (delta > 0) state.addHeat(delta);
}

/**
 * Arms a chase route: grant heat to `tier`, then POLL until the store reports that tier AND a
 * usable pursuit roster is alive, force-spawning the tier's own composition kinds on top of the
 * director's ~2 Hz maintenance pass (ai/chaosBench.ts:332's fillRoster technique). Resolves the
 * armed state HONESTLY — `false` if the timeout won — so the report can flag the run rather than
 * quietly presenting an unpoliced drive as a chase.
 *
 * Called AFTER the teleport on purpose: the spawn director places units on a 60-90 m ring around
 * the PLAYER (SPAWN.ring*), so arming before the teleport would strand the whole roster wherever
 * the car happened to be sitting when the battery clicked go.
 */
async function armTier(tier: number): Promise<boolean> {
  grantHeatToTier(tier);
  const cap = SPAWN.caps[tier] ?? CHASE_MIN_PURSUIT_UNITS;
  const wanted = Math.min(cap, CHASE_MIN_PURSUIT_UNITS);
  const start = performance.now();
  while (performance.now() - start < TIER_ARM_TIMEOUT_MS) {
    grantHeatToTier(tier); // idempotent; re-asserts if anything reset the run mid-arm
    const tierOk = getGameState().tier >= tier;
    const rosterOk = (unitsRef.current?.activeCount() ?? 0) >= wanted;
    if (tierOk && rosterOk) return true;
    for (const kind of CHASE_ROSTER_KINDS) unitsRef.current?.forceSpawn(kind);
    await sleep(TIER_ARM_POLL_MS);
  }
  return getGameState().tier >= tier;
}

/** The dev toggles worth recording next to a route measurement: the one the drive sets, plus the
 * five whose OFF state would silently turn a "live city" run into something else. */
const OBSERVED_TOGGLE_KEYS: readonly (keyof DevToggles)[] = [
  'invincible',
  'civTraffic',
  'transit',
  'packParked',
  'packInfill',
  'venueDress',
];

function snapshotToggles(): Readonly<Record<string, boolean>> {
  const live = getDevToggles();
  const out: Record<string, boolean> = {};
  for (const key of OBSERVED_TOGGLE_KEYS) out[key] = live[key];
  return out;
}

export interface FeelDriveOptions {
  /** Which route to drive (default 'downtownDense'). */
  readonly route?: FeelRouteId;
  /** Window length in seconds (default DEFAULT_SECONDS). With `stopAfterWaypoints` set this is a
   * CEILING, not the normal end condition. */
  readonly seconds?: number;
  /** Waypoint-stream seed (default 1). Same (route, seed) ⇒ same planned route, always. */
  readonly seed?: number;
  /**
   * End the window once this many route waypoints have been logged (reached OR abandoned),
   * `seconds` remaining as the safety ceiling. Boxes the run by ROUTE COVERAGE instead of
   * wall-clock — the mode the Phase 33 battery had to adopt when unstable headless fps made two
   * same-seed time-boxed runs cover different legs. NOT the default here: every headline route
   * metric is a per-minute rate or a per-event statistic, so equal TIME is the natural window and
   * equal coverage is the special case. Omit/0 = time mode.
   */
  readonly stopAfterWaypoints?: number;
  /** Absolute governor target (m/s), overriding the route's fraction default. */
  readonly cruiseSpeedMps?: number;
  /** Governor target as a fraction of the resolved car's top speed, overriding the route's own. */
  readonly cruiseFracOfTopSpeed?: number;
}

let activeDrive: Promise<FeelDriveReport> | null = null;
let activeRouteId: FeelRouteId | null = null;

export function isFeelDriveRunning(): boolean {
  return activeDrive !== null;
}

/** The route currently being driven, or null. Lets the bridge/battery report honestly rather than
 * awaiting a promise it assumes is for the route it asked for. */
export function activeFeelDriveRoute(): FeelRouteId | null {
  return activeRouteId;
}

/**
 * Run one scripted feel-lab route drive and resolve with its report. Idempotent while in flight —
 * a second call returns the SAME promise rather than overlapping two synthetic drivers on one car
 * (the contract ai/chaosBench.ts's startChaosBench and ai/cameraLabDrive.ts's startCameraLabDrive
 * both offer, for the same reason). Because this module has FOUR routes where they have one, a
 * mismatched second call is also warned about: silently handing back another route's report is
 * exactly the sort of thing that turns a battery into four copies of run #1.
 */
export function startFeelDrive(opts?: FeelDriveOptions): Promise<FeelDriveReport> {
  const requested = opts?.route ?? 'downtownDense';
  if (activeDrive) {
    if (activeRouteId !== requested) {
      console.warn(
        `[feelDrive] '${requested}' requested while '${activeRouteId}' is still driving — ` +
          `returning the IN-FLIGHT run's promise. Await it before starting the next route.`,
      );
    }
    return activeDrive;
  }
  const route = resolveFeelRoute(requested);
  activeRouteId = route.id;
  const run = runFeelDriveOnce(route, opts ?? {}).finally(() => {
    activeDrive = null;
    activeRouteId = null;
  });
  activeDrive = run;
  return run;
}

async function runFeelDriveOnce(
  route: FeelRouteDef,
  opts: FeelDriveOptions,
): Promise<FeelDriveReport> {
  const seconds = Math.max(THINK_INTERVAL_SEC, opts.seconds ?? DEFAULT_SECONDS);
  const seed = opts.seed ?? DEFAULT_SEED;
  const stopAfterRaw = opts.stopAfterWaypoints ?? 0;
  const stopAfterWaypoints = stopAfterRaw > 0 ? Math.floor(stopAfterRaw) : null;

  const player = await waitForDrivablePlayer();
  await waitForSteadyFrames();
  const graph = resolveFeelGraph();

  // Pace resolution, in precedence order: explicit absolute → explicit fraction → the route's own
  // fraction. Always against the RESOLVED car (config/carTuning.ts's SPEED_TOP_SPEED_MPS via
  // vehicles/definitions.ts), never a literal, so Phase 81's per-car re-runs need no edit here.
  const car = getSelectedCarDef();
  const frac = opts.cruiseFracOfTopSpeed ?? route.cruiseFracOfTopSpeed;
  const cruiseTargetMps = opts.cruiseSpeedMps ?? frac * car.topSpeed;

  // The whole path, planned up front from the seeded stream (see planFeelRoute). Waypoint mode
  // still plans off the TIME budget so the same seed yields the same route whichever end condition
  // is in play.
  const plan = planFeelRoute(graph, route.id, seed, feelRouteSteps(seconds, stopAfterWaypoints));
  const { startNodeId } = plan;
  const plannedRoute = plan.waypoints;

  const startNode = graph.nodes[startNodeId];
  player.reset(
    startPoseAt(startNode, plannedRoute.length > 0 ? graph.nodes[plannedRoute[0]] : null),
  );
  await sleep(SETTLE_MS);

  // Invincible for the window (HP-only; see the header). Saved/restored exactly as
  // ai/chaosBench.ts:374-375 does, and restored in the finally below so a thrown drive can never
  // leave the player permanently immortal.
  const prevInvincible = getDevToggles().invincible;
  setDevToggle('invincible', true);

  // Arm AFTER the teleport (see armTier) and BEFORE the window opens — the plan is explicit that
  // the measured window may only start once the tier has actually been reached, polled not assumed.
  const tierArmed = route.requireTier > 0 ? await armTier(route.requireTier) : true;

  const openState = getGameState();
  const heatAtStart = openState.heat;
  const tierAtStart = openState.tier;
  const pursuitUnitsAtStart = unitsRef.current?.activeCount() ?? 0;
  const observedToggles = snapshotToggles();

  const waypoints: number[] = [];
  let routeIndex = 0;
  let waypointSec = 0;
  let stuck: StuckState = initialStuckState;
  let progressAnchor = { x: startNode.x, z: startNode.z };
  let progressSec = 0;
  let escapeSec = 0;
  let grindEscapes = 0;
  let timeoutAbandons = 0;
  let unstickAbandons = 0;
  let revives = 0;
  let ticks = 0;
  let pathLengthM = 0;
  let teleportSkips = 0;
  let lastPos = { x: startNode.x, z: startNode.z };
  let finalPos = { x: startNode.x, z: startNode.z };
  let maxPursuitUnits = pursuitUnitsAtStart;
  let maxTrafficUnits = trafficRef.current?.activeCount() ?? 0;
  const speedSamples: number[] = [];

  /** Abandon the current waypoint and move to the next. Shared by every "this one is not
   * happening" path so the waypoint LOG always mirrors the route positions the car was actually
   * steered along — which is what makes it the reproducibility key. */
  function advanceWaypoint(): void {
    waypoints.push(plannedRoute[routeIndex]);
    routeIndex++;
    waypointSec = 0;
  }

  function driveTick(): void {
    ticks++;
    const state = getGameState();
    if (state.machine !== 'PLAYING') {
      // Water entry and out-of-bounds route straight to GAMEOVER in combat/runLoop.ts without
      // consulting HP, so invincibility does not cover them. Revive and keep measuring — and
      // re-grant, because runLoop's own GAMEOVER→PLAYING subscriber calls runReset(), which
      // zeroes heat and would silently drop a chase route to ★0 mid-window.
      if (canTransition(state.machine, 'PLAYING')) {
        state.transition('PLAYING');
        revives++;
        if (route.requireTier > 0) grantHeatToTier(route.requireTier);
      }
      return;
    }
    const vehicle = playerVehicle.current;
    if (!vehicle) return;

    const readState = vehicle.readState();
    const pos = readState.rawPose.position;
    const yaw = yawFromQuaternion(readState.rawPose.rotation);
    const speed = Math.hypot(readState.velocity.x, readState.velocity.z);

    speedSamples.push(speed);
    const step = Math.hypot(pos.x - lastPos.x, pos.z - lastPos.z);
    if (step > TELEPORT_JUMP_M) teleportSkips++;
    else pathLengthM += step;
    lastPos = { x: pos.x, z: pos.z };
    finalPos = lastPos;
    const pursuitN = unitsRef.current?.activeCount() ?? 0;
    const trafficN = trafficRef.current?.activeCount() ?? 0;
    if (pursuitN > maxPursuitUnits) maxPursuitUnits = pursuitN;
    if (trafficN > maxTrafficUnits) maxTrafficUnits = trafficN;

    if (routeIndex >= plannedRoute.length) {
      // Route exhausted (only reachable if the car ate the whole generous budget): coast to a stop
      // rather than hold the last command, so the tail of the window isn't a wall grind.
      setDrivingInputOverride({ steer: 0, throttle: 0, brake: 1, handbrake: false });
      return;
    }

    // Grind escape: reverse blind for ESCAPE_SEC, alternating lock so a repeat escape never
    // repeats the same failed manoeuvre. pursueSteer is skipped (and its stuck memory cleared)
    // for the duration — this IS the recovery.
    if (escapeSec > 0) {
      escapeSec -= THINK_INTERVAL_SEC;
      stuck = initialStuckState;
      progressAnchor = { x: pos.x, z: pos.z };
      progressSec = 0;
      setDrivingInputOverride({
        steer: grindEscapes % 2 === 0 ? 1 : -1,
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
        grindEscapes++;
        advanceWaypoint();
        if (routeIndex >= plannedRoute.length) return;
      }
    }

    const target = graph.nodes[plannedRoute[routeIndex]];
    const dist = Math.hypot(target.x - pos.x, target.z - pos.z);
    waypointSec += THINK_INTERVAL_SEC;
    if (dist < arriveDistFor(speed)) {
      advanceWaypoint();
      if (routeIndex >= plannedRoute.length) return; // steered next tick by the branch above
    } else if (waypointSec >= WAYPOINT_TIMEOUT_SEC) {
      timeoutAbandons++;
      advanceWaypoint();
      if (routeIndex >= plannedRoute.length) return;
    }
    const aimIndex = aimIndexFor(
      graph.nodes,
      plannedRoute,
      routeIndex,
      pos.x,
      pos.z,
      lookaheadFor(speed),
    );
    const node = graph.nodes[plannedRoute[aimIndex]];

    const wasReversing = stuck.reverseRemainSec > 0;
    const result = pursueSteer(
      { x: pos.x, z: pos.z, yaw },
      speed,
      { x: node.x, z: node.z },
      ZERO_VEL,
      CLEAR_HITS,
      stuck,
      FEEL_STEERING,
      THINK_INTERVAL_SEC,
      'pursue',
    );
    stuck = result.stuck;
    // UNSTICK ⇒ RE-ROUTE. A reversal that has just been triggered means the line to THIS waypoint
    // is physically blocked; backing off and re-aiming at the same node just drives back into it
    // (measured at Phase 33: the car ping-ponged inside a 20 m box for a whole 25 s run). Abandon
    // at the moment the reversal starts, which is what a driver would do.
    if (!wasReversing && stuck.reverseRemainSec > 0) {
      unstickAbandons++;
      advanceWaypoint();
    }
    setDrivingInputOverride({
      steer: result.command.steer,
      throttle: Math.min(result.command.throttle, governedThrottle(cruiseTargetMps, speed)),
      brake: result.command.brake,
      handbrake: false,
    });
  }

  // --- the measured window -------------------------------------------------------------------
  // `startFeelTelemetry` IS the reset: its contract is "calling it while running RESETS the
  // accumulator and re-bases the clock rather than attaching a second sampler", and
  // `resetFeelTelemetry` is a documented no-op before any start. So one call opens a clean window
  // here, and a preceding reset would be either dead or redundant. Car params default to the live
  // selected car — the same read `getSelectedCarDef()` above made for the pace, so the snapshot's
  // `car` block and this report's `driver` block can never disagree about which car ran.
  startFeelTelemetry();
  markFeelPhase(`route:${route.id}:window-open`);
  const windowOpenedAt = performance.now();
  let telemetry: FeelTelemetrySnapshot;
  try {
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        driveTick();
        if (stopAfterWaypoints !== null && waypoints.length >= stopAfterWaypoints) {
          clearInterval(interval);
          clearTimeout(ceiling);
          resolve();
        }
      }, THINK_INTERVAL_MS);
      // The time box stays armed as the safety ceiling in BOTH modes — a wedged car must never
      // hang the battery's await.
      const ceiling = setTimeout(() => {
        clearInterval(interval);
        resolve();
      }, seconds * 1000);
    });
    markFeelPhase(`route:${route.id}:window-close`);
    telemetry = readFeelTelemetry();
  } finally {
    // Always, on every path including a throw: stop sampling, hand the car back to the keyboard,
    // and put invincibility back where it was. A lab tool that leaves the player's input silently
    // overridden is a far worse bug than anything it exists to measure.
    stopFeelTelemetry();
    setDrivingInputOverride(null);
    setDevToggle('invincible', prevInvincible);
  }
  const elapsedSec = (performance.now() - windowOpenedAt) / 1000;

  const endState = getGameState();
  const report: FeelDriveReport = {
    routeId: route.id,
    label: route.label,
    districtIds: [...route.districtIds],
    rect: plan.rect,
    seed,
    seconds,
    elapsedSec,
    startNodeId,
    waypoints,
    waypointTarget: stopAfterWaypoints,
    speed: { ...speedStats(speedSamples), targetMps: cruiseTargetMps },
    heatAtStart,
    heatAtEnd: endState.heat,
    tierAtStart,
    tierAtEnd: endState.tier,
    requiredTier: route.requireTier,
    tierArmed,
    pursuitUnitsAtStart,
    maxPursuitUnits,
    maxTrafficUnits,
    toggles: { applied: { invincible: true }, observed: observedToggles },
    driver: {
      cruiseTargetMps,
      cruiseFracOfTopSpeed:
        opts.cruiseSpeedMps !== undefined ? cruiseTargetMps / car.topSpeed : frac,
      topSpeedMps: car.topSpeed,
      carId: car.id,
      waypointsPlanned: plannedRoute.length,
      ticks,
      pathLengthM,
      teleportSkips,
      netDisplacementM: Math.hypot(finalPos.x - startNode.x, finalPos.z - startNode.z),
      timeoutAbandons,
      unstickAbandons,
      grindEscapes,
      revives,
      grindEscapeAfterSec: GRIND_SEC,
    },
    telemetry,
  };
  console.info(formatFeelDriveReport(report));
  return report;
}
