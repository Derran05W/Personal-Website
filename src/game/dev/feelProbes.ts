// Phase 74 Task 2 — THE CONTROLLED-MANOEUVRE PROBES. Scripted, deterministic driving inputs
// that measure the player car's RESPONSE and CORNERING in isolation, on a cleared straight,
// with nothing else in the frame that could move the numbers.
//
// --- why probes exist at all (the two-mode split, phase-74-plan.md Decision 3) ---------------
// The feel harness has two measurement modes because no single run can produce both halves of
// the Feel Spec:
//   • Turn radius at 15 m/s, time-to-90 %-speed and brake distance are UNMEASURABLE in live
//     traffic — a civilian car clipped at second 3 changes the speed trace, and "the settled
//     radius of a full-lock circle" has no meaning if a bus is in the circle. They need
//     controlled inputs on clear road. THAT IS THIS FILE.
//   • Contacts/min, stuck events and airtime are unmeasurable on an empty straight — they only
//     exist because the city is full. Those belong to route mode (dev/feelDrives.ts, T3),
//     driven over the live city with everything switched ON.
// One harness, two run modes, one results schema. Read a probe number as "what the car can do",
// a route number as "what the city does to the car"; never average them together.
//
// --- how a probe is built --------------------------------------------------------------------
// Every probe is self-contained and identical in skeleton:
//     teleport to a DERIVED start pose  →  settle on the suspension  →  run one or more
//     scripted input SEGMENTS  →  analyse the recorded trace  →  report.
// The teleport is the determinism guarantee. A probe that measured "from wherever the car
// happened to be" would fold the previous probe's end state (speed, heading, which lane, how
// much road is left) into its own numbers, and no two batteries would be comparable. Every
// probe starts from the same pose on the same street facing the same way — the technique
// ai/cameraLabDrive.ts's startPoseAt/runDriveOnce opening establishes, for the same reason.
//
// Commands go out through `setDrivingInputOverride` (input/keyboard.ts) — the ONE scripted-
// driver seam every synthetic driver in this codebase uses (chaos bench, camera lab, and now
// this). It is ALWAYS cleared in a `finally`: a lab tool that leaves the player's input
// overridden is a far worse bug than anything it exists to measure (cameraLabDrive.ts:687-691).
//
// --- readiness / warm-up / drive-loop patterns are COPIED, not imported ----------------------
// `waitForDrivablePlayer` and `waitForSteadyFrames` below mirror ai/cameraLabDrive.ts's helpers
// of the same names. Those are module-private there BY DESIGN — that file documents at :414-418
// why it duplicates chaosBench's readiness waits rather than reshaping a standing harness to
// export them. Copying the pattern locally is therefore the accepted precedent in this codebase,
// and it is what this file does. (This module's warm-up counts its OWN requestAnimationFrame
// frames instead of borrowing the camera-clip sampler's counter, so a probe run does not depend
// on the clip sampler being active.)
//
// --- sampling cadence, and why every metric is a physical quantity ---------------------------
// Samples are taken once per rendered frame (rAF). That is deliberate and it is the ONLY honest
// cadence available: <Physics> steps inside the r3f frame loop, so `readState()` only changes
// when a frame renders — polling faster (a 16 ms setInterval, say) would return the same pose
// several times and manufacture precision that is not there. Under SwiftShader in this container
// that means ~55 ms between samples, so every timing metric carries a real quantization floor.
// Each result therefore reports `sampleIntervalSec` (the measured median) alongside its numbers,
// and the two timing metrics that live closest to the floor (steerToPeakYawSec) additionally
// report `quantizationSec`. No metric is ever a frame COUNT; they are all seconds, metres,
// metres/second or radians/second.
//
// --- honesty rules this file enforces (phase-74-plan.md Risks) -------------------------------
//   1. A manoeuvre that does not fit the available clear road reports `insufficientRunway: true`
//      together with the distance it actually had. It NEVER reports a truncated number as if it
//      were a real one.
//   2. A run that is interrupted (a collision, a flip, the machine leaving PLAYING, the frame
//      loop stalling, the car leaving the corridor) reports the interruption and marks its
//      status. Partial data is labelled partial.
//   3. A target the car physically cannot reach (see the brake probe's entry-speed plateau) is
//      reported as "not reached, here is what it did reach" — never quietly re-defined.
//
// DEV-only: like ai/chaosBench.ts and ai/cameraLabDrive.ts this module ships nowhere near
// production. Its only consumers are core/debugBridge.ts (itself an `import.meta.env.DEV`
// dynamic import from game/index.tsx) and the Playwright battery that drives that bridge.

import { getGameState } from '../state/store';
import { canTransition } from '../state/machine';
import { playerVehicle } from '../vehicles/playerRef';
import { setDrivingInputOverride } from '../input';
import { getDevToggles, setDevToggle } from '../core/devToggles';
import { getSelectedCarDef } from '../vehicles/definitions';
import { steerClampRad } from '../vehicles/steering';
import { onImpact } from '../combat/contacts';
import { buildStreets } from '../world/toronto/streets';
import { mapToWorld, YONGE_X, ZONE_BOUNDARIES } from '../world/toronto/projection';
import { TORONTO_SPAWN_POSE } from '../world/toronto/torontoSceneHelpers';
import { SIDEWALK } from '../config/torontoMap';
import { WORLD_SOURCE } from '../config/worldSource';
import { markFeelPhase } from './feelTelemetry';
import type { PlayerCarId } from '../config/vehicles';
import type { EntityKind } from '../world/registry';
import type { ImpactRecord } from '../combat/types';
import type { VehicleInputs, VehiclePose, VehicleState } from '../vehicles/IVehicleModel';

// ============================================================================================
// Tunables
//
// Module consts rather than a config/ block, for exactly the reason ai/chaosBench.ts's own
// header argues: config/ is the single source of truth for GAME tunables, and none of these are
// game tunables — this whole file only ever ships in the DEV-gated chunk. Every one carries its
// derivation or the measurement it came from.
// ============================================================================================

// --- readiness ------------------------------------------------------------------------------
const READY_TIMEOUT_MS = 10_000;
const READY_POLL_MS = 100;
/** Frames the warm-up must see per poll before the page counts as "actually rendering"
 * (≥ ~13 fps — well under SwiftShader's real cadence here, far above a stalling mount). */
const WARMUP_MIN_FRAMES = 2;
const WARMUP_POLL_MS = 150;
const WARMUP_STEADY_POLLS = 4;
const WARMUP_TIMEOUT_MS = 8_000;

// --- settle (after every teleport) ------------------------------------------------------------
/** Minimum dwell after a teleport before the measured window may open. A cold chassis dropped at
 * the spawn height needs a few frames for the suspension rays to take the load; opening the
 * window on the drop would charge the launch probe with a bounce it did not cause. */
const SETTLE_MIN_MS = 400;
const SETTLE_TIMEOUT_MS = 3_000;
const SETTLE_POLL_MS = 60;
/** Planar speed (m/s) under which the chassis counts as at rest. Matches the 0.5 m/s "stopped"
 * threshold the plan's brake metric uses, so "at rest" means one thing in this file. */
const SETTLE_SPEED_MPS = 0.5;
/** Wheels that must report ground contact before the car counts as settled. 3 of 4 rather than
 * 4 of 4: a chassis resting on a very slightly uneven ribbon legitimately floats one wheel, and
 * demanding all four turns a fine start pose into a spurious `inconclusive`. */
const SETTLE_WHEELS_IN_CONTACT = 3;

// --- frame loop -------------------------------------------------------------------------------
/** If requestAnimationFrame goes this long without firing, the page has stalled (a backgrounded
 * tab, a multi-second main-thread hitch) and the segment aborts as `frameStall` rather than
 * silently integrating a gap into a time measurement. 1.5 s is ~27 missed frames at the ~18 fps
 * this container renders at — far beyond ordinary jitter. */
const FRAME_STALL_MS = 1_500;
const FRAME_STALL_POLL_MS = 200;

// --- corridor (the cleared straight the probes drive on) ---------------------------------------
/** Clearance kept south of Bloor's ribbon when placing the start pose, so a probe never opens
 * inside the Yonge×Bloor intersection (cross-ribbon paint, mast arms, the widest junction on the
 * corridor). One car length plus change. */
const CORRIDOR_START_CLEARANCE_M = 8;
/** Clearance kept off the SOUTH end of the Yonge ribbon. The south end runs at the harbour, and
 * world/toronto's water sensor carries a 30 m ballistic envelope (Phase 37) — a brake probe that
 * overran into it would end the run in a drowning instead of a measurement. 60 m is double that
 * envelope. */
const CORRIDOR_SOUTH_MARGIN_M = 60;
/** Longitudinal slack subtracted from the corridor before it is offered to a probe, so the
 * "available" number is a distance the car may actually consume rather than the exact point at
 * which it would leave the corridor. */
const CORRIDOR_END_SLACK_M = 20;
/** How far NORTH of the start pose the car may drift before it counts as having left the
 * corridor. It should never go north at all (every probe drives +z), but a brake-to-reverse
 * overshoot at the very end of a stop legitimately backs up a little. */
const CORRIDOR_BACKSTOP_M = 20;
/** Lateral margin kept between the car's centreline path and the edge of the clear box, so the
 * runway estimator is answering "can the CAR stay inside" rather than "can a point". Half the
 * widest player chassis (the streetcar's 1.2 m half-width) plus a little. */
const CAR_LATERAL_MARGIN_M = 1.5;

// --- interruption detection -------------------------------------------------------------------
/** Registry kinds that END a measurement on contact. These are immovable (or effectively so):
 * once the car has hit one, whatever the trace does next is a wall's opinion, not the car's.
 * propStatic/propDynamic (cones, bins, planters) are deliberately NOT here — they are knockable
 * street dressing, recorded as contacts and left to the speed-drop backstop below. */
const HARD_CONTACT_KINDS: ReadonlySet<EntityKind> = new Set<EntityKind>([
  'building',
  'barrier',
  'transformer',
  'civilian',
  'pursuit',
]);
/** Kinematic backstop for anything the registry misses (an unregistered collider, a contact whose
 * force event never fired): a planar-speed drop larger than this BETWEEN CONSECUTIVE SAMPLES,
 * while the probe is not braking, is not something a car does under its own power. Explicitly a
 * HEURISTIC — it is reported as reason 'collision' with the drop in `detail` so a reader can
 * second-guess it. 4 m/s in one ~55 ms frame is ≈ 73 m/s², an order of magnitude past any
 * braking or drag deceleration this vehicle can produce. */
const INTERRUPT_SPEED_DROP_MPS = 4;
/** `upright === false` (raycastVehicle's own chassis-up test) sustained this long counts as a
 * flip. Matches the plan's flipEvents definition. */
const FLIP_DWELL_SEC = 0.5;

// --- probe scripts ------------------------------------------------------------------------------
/** Launch probe: fractions of resolved top speed the report times. */
const LAUNCH_FRACTIONS = { half: 0.5, ninety: 0.9 } as const;
/** Launch probe ceiling. The car's own speed asymptote (throttle governor × linear damping) sits
 * near 93 % of top speed for the sedan, so 90 % is reached in ≈4.6 s of model time; 14 s leaves
 * room for a heavy car (the bus/streetcar grades) without letting a stuck run eat the battery. */
const LAUNCH_MAX_SEC = 14;

/** Brake probe: the entry speed the metric NOMINALLY asks for (plan: "from ≥95 % top speed"). */
const BRAKE_ENTRY_FRAC = 0.95;
/** …and the entry speed below which the measurement stops being comparable at all. Between the
 * two, the probe reports `entryTargetMet: false` with the speed it actually reached — see the
 * ENTRY-SPEED PLATEAU note on runBrakeProbe for why 95 % is not always physically reachable. */
const BRAKE_ENTRY_MIN_FRAC = 0.8;
const BRAKE_ACCEL_MAX_SEC = 18;
const BRAKE_STOP_MAX_SEC = 12;
/** Planar speed under which the car counts as stopped (plan's brake metric definition). */
const BRAKE_STOP_SPEED_MPS = 0.5;
/** The accel phase ends early once speed has climbed less than this much over PLATEAU_WINDOW_SEC
 * — i.e. the governor/damping equilibrium has been found and waiting longer adds nothing.
 * 0.15 m/s over 1.5 s is ~0.1 m/s², below the sampling noise floor of a settled cruise. */
const BRAKE_PLATEAU_GAIN_MPS = 0.15;
const BRAKE_PLATEAU_WINDOW_SEC = 1.5;

/** Step-steer probe: the speed the car is held at before the step, as a fraction of top speed.
 * 0.6 puts the sedan at ~15 m/s — the same speed the Feel Spec's turn-radius gate keys on, so the
 * two cornering metrics describe the same operating point. */
const STEP_STEER_SPEED_FRAC = 0.6;
const STEP_STEER_APPROACH_MAX_SEC = 14;
/** How long full lock is held after the step. The yaw-rate peak of a raycast chassis arrives
 * within a few tenths of a second (the 400 °/s steer rate reaches the ~30° speed-scaled clamp in
 * under 0.1 s; the tyre/chassis response adds a few more), so 1.0 s is comfortably past the peak.
 * It is also a LATERAL budget: excursion grows with the square of the hold, and at 0.6 × top
 * speed a 1.2 s hold already eats ~6.8 m of the ~7 m the clear box offers. 1.0 s keeps it near
 * 4.8 m — measurable with room to spare instead of a coin flip against the streetwall. */
const STEP_STEER_HOLD_SEC = 1.0;

/** Turn-radius probe: the speeds the steady full-lock circle is measured at (plan §Cornering). */
const TURN_SPEEDS_MPS: readonly number[] = [5, 10, 15, 20];
const TURN_APPROACH_MAX_SEC = 16;
/** Entry transient rejected before the settled window may start. The yaw rate has to climb from
 * 0 to its steady value through the steer-rate ramp AND the tyre/chassis response; measured on
 * this chassis that lands in the low hundreds of milliseconds, so 0.45 s is the transient plus a
 * margin. */
const TURN_TRANSIENT_SEC = 0.45;
/** Minimum settled window. Short on purpose: the lateral room a full-lock circle eats grows with
 * the SQUARE of the window, and the widest street on the map is 11 wu. 0.4 s is ~7 samples at
 * this container's frame rate — reported as `samplesInWindow` so a reader can judge the average
 * for themselves rather than take it on trust. */
const TURN_SETTLE_MIN_SEC = 0.4;
/** Total lock-hold ceiling per speed point (transient + window + slack). */
const TURN_HOLD_SEC = 1.4;
/** Tolerated spread (max−min, relative to the mean) inside a settled window, for |yaw rate| and
 * for speed. 12 % is loose enough to survive rAF-quantized differentiation of the yaw angle and
 * tight enough that a still-climbing transient can never pass. */
const TURN_SETTLE_TOLERANCE = 0.12;

/** Slalom probe: cruise speed fraction and the half-period of the alternating steer. */
const SLALOM_SPEED_FRAC = 0.6;
const SLALOM_APPROACH_MAX_SEC = 14;
/** Time at full lock in one direction before flipping to the other. Chosen from the same lateral
 * budget as the turn probe (excursion ≈ ½·a_lat·t², and the corridor gives ~4.6 m of ribbon each
 * side of the centreline): 0.8 s keeps a ~9 m/s² lateral excursion near 2.9 m. It is also the
 * regime the D8 monster-truck complaint lives in — a tall, high-CoM chassis reversed at this
 * cadence is what rolls, if anything does. */
const SLALOM_HALF_PERIOD_SEC = 0.8;
const SLALOM_SEC = 12;

/** Speed-hold controller used by every "get to X m/s and stay there" approach phase. Same shape
 * as ai/cameraLabDrive.ts's cruise governor (base throttle plus a P term on the speed error),
 * with a brake term so an overshoot is corrected instead of waited out. */
const HOLD_THROTTLE_BASE = 0.35;
const HOLD_SPEED_GAIN = 0.25;
const HOLD_BRAKE_GAIN = 0.3;
/** Speed band (m/s) inside which the approach phase counts as "at speed". Must be wide enough
 * that the P controller can actually sit in it at this sampling rate. */
const HOLD_TOLERANCE_MPS = 0.6;
/** Consecutive seconds inside the band before the approach phase hands over. */
const HOLD_DWELL_SEC = 0.4;

/** Conservative lateral-acceleration cap used ONLY by the runway ESTIMATOR (never by a
 * measurement). A raycast chassis on frictionSlip 3.2 / sideFrictionStiffness 1.4 will not pull
 * much past ~1 g laterally; 10 m/s² is that, rounded up, so the estimator over-reserves rather
 * than under-reserves lateral room. */
const RUNWAY_LAT_ACCEL_CAP_MPS2 = 10;

const NEUTRAL_INPUT: VehicleInputs = { steer: 0, throttle: 0, brake: 0, handbrake: false };
const FULL_THROTTLE_INPUT: VehicleInputs = { steer: 0, throttle: 1, brake: 0, handbrake: false };
const BRAKE_INPUT: VehicleInputs = { steer: 0, throttle: 0, brake: 1, handbrake: false };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// ============================================================================================
// Result schema (plain data — every field JSON-serializable, so a battery can write it straight
// into results.json without a custom serializer)
// ============================================================================================

export type ProbeKind = 'launch' | 'brake' | 'stepSteer' | 'turnRadius' | 'slalom';

/**
 * How much to trust a probe's numbers.
 *   ok                 — the manoeuvre ran to completion inside its runway; the numbers stand.
 *   insufficientRunway — the clear road available was smaller than the manoeuvre needs. The
 *                        runway block says how much there was and how much was needed. Any
 *                        measurement present alongside this status is partial BY DEFINITION.
 *   interrupted        — something ended the run early (see `interruption`).
 *   inconclusive       — the run completed but the trace does not support the metric (the target
 *                        speed was never reached, no settled window existed, …).
 */
export type ProbeStatus = 'ok' | 'insufficientRunway' | 'interrupted' | 'inconclusive';

export type ProbeInterruptionReason =
  | 'collision'
  | 'flip'
  | 'leftPlaying'
  | 'leftCorridor'
  | 'frameStall';

export interface ProbeInterruption {
  readonly reason: ProbeInterruptionReason;
  /** Seconds into the probe (not into the segment) at which it was detected. */
  readonly atSec: number;
  /** Human-readable specifics — the struck entity kind, the speed drop, the corridor overshoot. */
  readonly detail: string;
}

/** One rAF frame of the probe. The phase tag is what makes the analysis functions pure: they
 * find the throttle edge / brake edge / steer edge in the trace itself rather than being told. */
export interface ProbeSample {
  readonly tSec: number;
  readonly phase: string;
  readonly x: number;
  readonly z: number;
  /** Planar |v| (m/s) — the y component is dropped; a probe measures ground speed. */
  readonly speedMps: number;
  /** Signed speed along the chassis forward axis (m/s). */
  readonly forwardSpeedMps: number;
  /** +Z-forward yaw (rad), same convention as ai/chaosBench.ts's yawFromQuaternion. */
  readonly yawRad: number;
  /** Wrap-corrected d(yaw)/dt (rad/s). Zero on the first sample of a probe (no previous frame). */
  readonly yawRateRadS: number;
  /** See axesFromQuaternion for the sign convention. */
  readonly rollRad: number;
  readonly pitchRad: number;
  readonly upright: boolean;
  readonly wheelsInContact: number;
  readonly steer: number;
  readonly throttle: number;
  readonly brake: number;
}

export interface SpeedTracePoint {
  readonly tSec: number;
  readonly speedMps: number;
}

/** A contact seen during the probe, from the combat/contacts.ts spine. Recorded on every probe
 * (a "clean" probe should have none) so a suspicious number can always be checked against
 * whether the car actually touched anything. */
export interface ProbeContact {
  readonly atSec: number;
  /** The registry kind of the thing that was NOT the player, or 'unknown' when neither collider
   * resolved to a registry entry (the ground, an unregistered collider). */
  readonly counterpartKind: EntityKind | 'unknown';
  readonly forceMag: number;
  readonly blocking: boolean;
}

/** Longitudinal + lateral clear road, needed vs available. Both axes matter: a launch eats road
 * ahead, a full-lock circle eats road SIDEWAYS, and the widest street in Toronto is 11 wu. */
export interface ProbeRunway {
  readonly availableLongitudinalM: number;
  readonly neededLongitudinalM: number;
  readonly availableLateralM: number;
  readonly neededLateralM: number;
  readonly sufficient: boolean;
}

/** The cleared straight probes drive on, derived (never hand-typed) from the street table. */
export interface ProbeCorridor {
  /** World x of the Yonge spine centreline. */
  readonly centreX: number;
  /** World z the probes start at (north end) and the far limit they must not pass (south end).
   * The drive direction is +z, which is the identity quaternion — the same facing the shipped
   * TORONTO_SPAWN_POSE uses. */
  readonly startZ: number;
  readonly endZ: number;
  readonly lengthM: number;
  /** Half-width of the asphalt ribbon itself (m). */
  readonly ribbonHalfWidthM: number;
  /** Half-width of the CLEAR box: ribbon + the sidewalk band, which carries no colliders
   * (config/torontoMap.ts SIDEWALK.colliders === false, the Phase 25.8 drive-feel verdict). A
   * probe that overruns onto the sidewalk is still measuring free-rolling physics; it may clip a
   * tree or a lamp post, which the contact detector catches. */
  readonly clearHalfWidthM: number;
}

/** Exactly which isolation switches the probe applied. Recorded on every result so no reader can
 * mistake a probe number for live play (phase-74-plan.md Decision 4). */
export interface ProbeIsolation {
  readonly civTraffic: boolean;
  readonly transit: boolean;
  readonly packParked: boolean;
  readonly invincible: boolean;
}

export interface ProbeResultBase {
  readonly kind: ProbeKind;
  readonly status: ProbeStatus;
  /** Mirrors `status === 'insufficientRunway'` as a flat boolean — the plan asks for this field
   * by name, and a battery predicate should not have to know the status vocabulary. */
  readonly insufficientRunway: boolean;
  readonly interrupted: boolean;
  readonly interruption: ProbeInterruption | null;
  readonly carId: PlayerCarId;
  /** The car's RESOLVED top speed (config/carTuning.ts SPEED_TOP_SPEED_MPS via
   * getSelectedCarDef) — every fraction in this file is taken against this, never against a
   * hardcoded 25. */
  readonly topSpeedMps: number;
  readonly corridor: ProbeCorridor;
  readonly runway: ProbeRunway;
  readonly isolation: ProbeIsolation;
  readonly durationSec: number;
  readonly sampleCount: number;
  /** Median inter-sample gap (s) — the quantization floor on every timing metric below. */
  readonly sampleIntervalSec: number;
  readonly contacts: readonly ProbeContact[];
  /** Full per-frame trace, only when the caller asked for it (`includeSamples`). Omitted by
   * default: five probes of raw frames is a lot of JSON for a results file nobody reads by hand. */
  readonly samples?: readonly ProbeSample[];
}

export interface LaunchProbeResult extends ProbeResultBase {
  readonly kind: 'launch';
  /** Seconds from the throttle edge to 50 % / 90 % of `topSpeedMps`. `null` = never reached
   * (which the peak speed below explains). */
  readonly t50Sec: number | null;
  readonly t90Sec: number | null;
  readonly target50Mps: number;
  readonly target90Mps: number;
  readonly peakSpeedMps: number;
  readonly distanceM: number;
  /** The speed-vs-time trace the plan asks for, always included (it is the evidence behind
   * t50/t90 and it is small). */
  readonly speedTrace: readonly SpeedTracePoint[];
}

export interface BrakeProbeResult extends ProbeResultBase {
  readonly kind: 'brake';
  readonly entryTargetMps: number;
  readonly entrySpeedMps: number;
  /** False ⇒ the car could not reach the nominal ≥95 % entry speed; `entrySpeedMps` is what it
   * did reach and every number below is measured FROM THAT. See the ENTRY-SPEED PLATEAU note. */
  readonly entryTargetMet: boolean;
  readonly brakeDistM: number | null;
  readonly brakeSec: number | null;
  readonly stopped: boolean;
  readonly speedTrace: readonly SpeedTracePoint[];
}

export interface StepSteerProbeResult extends ProbeResultBase {
  readonly kind: 'stepSteer';
  readonly targetSpeedMps: number;
  readonly entrySpeedMps: number;
  /** Seconds from the steer edge to peak |yaw rate|. Sits within a sample or two of the
   * quantization floor at this frame rate — read it together with `quantizationSec`. */
  readonly steerToPeakYawSec: number | null;
  readonly peakYawRateRadS: number | null;
  readonly quantizationSec: number;
}

export interface TurnRadiusPoint {
  readonly targetSpeedMps: number;
  readonly status: ProbeStatus;
  readonly insufficientRunway: boolean;
  readonly runway: ProbeRunway;
  readonly interruption: ProbeInterruption | null;
  /** Mean speed over the settled window (m/s) — NOT the target; the car holds what it holds. */
  readonly measuredSpeedMps: number | null;
  readonly yawRateRadS: number | null;
  /** measuredSpeed ÷ |yawRate| over the settled window. */
  readonly radiusM: number | null;
  readonly settledWindowSec: number | null;
  readonly samplesInWindow: number;
  /** Short human-readable reason when this point is not `ok` (a target above the car's top speed,
   * a lateral shortfall, no settled window). null on a clean point. */
  readonly note: string | null;
}

export interface TurnRadiusProbeResult extends ProbeResultBase {
  readonly kind: 'turnRadius';
  readonly points: readonly TurnRadiusPoint[];
}

export interface SlalomProbeResult extends ProbeResultBase {
  readonly kind: 'slalom';
  readonly targetSpeedMps: number;
  readonly entrySpeedMps: number;
  readonly halfPeriodSec: number;
  readonly rollPeakRad: number;
  readonly pitchPeakRad: number;
  /** Runs of `upright === false` lasting longer than FLIP_DWELL_SEC. The number the D8
   * monster-truck complaint is sized against. */
  readonly flipEvents: number;
  /** Fraction of slalom frames with ZERO wheels in contact. Reported with its denominator
   * (`sampleCount`) because it is one of the two deliberately frame-based ratios. */
  readonly airtimeFrac: number;
  readonly minSpeedMps: number;
}

export type ProbeResult =
  | LaunchProbeResult
  | BrakeProbeResult
  | StepSteerProbeResult
  | TurnRadiusProbeResult
  | SlalomProbeResult;

export interface FeelProbeSuiteResult {
  readonly startedAtIso: string;
  readonly carId: PlayerCarId;
  readonly topSpeedMps: number;
  readonly corridor: ProbeCorridor;
  readonly isolation: ProbeIsolation;
  readonly results: readonly ProbeResult[];
}

// ============================================================================================
// Pure analysis (no Rapier / three / store — unit-tested in feelProbes.test.ts)
// ============================================================================================

/** Wrap an angle difference into (−π, π]. Yaw is read modulo 2π, so a car crossing the ±π seam
 * would otherwise show a ~2π/dt yaw-rate spike that would win every peak-yaw contest. */
export function wrapAngle(rad: number): number {
  const twoPi = Math.PI * 2;
  let a = (rad + Math.PI) % twoPi;
  if (a <= 0) a += twoPi;
  return a - Math.PI;
}

/**
 * Chassis attitude from a physics quaternion, without three.js (this file stays free of the
 * renderer, like ai/aiSteering.ts and vehicles/steering.ts).
 *
 * Convention, stated exactly because "roll" is otherwise ambiguous:
 *   • yaw   — atan2(forward.x, forward.z) with forward = local +Z. Identical to
 *             ai/chaosBench.ts's yawFromQuaternion (the house convention).
 *   • pitch — asin(forward.y). Positive = the nose is above the horizon.
 *   • roll  — asin(localX.y). Positive = the chassis's local +X axis is RAISED. Which physical
 *             side that is follows from the +Z-forward, Y-up right-handed frame; no metric in
 *             this file depends on the sign, since roll/pitch are reported as ABSOLUTE peaks.
 *
 * Both angles come from a single rotated basis vector rather than an Euler decomposition, so
 * they stay well-defined at any attitude (including the upside-down poses the slalom probe is
 * hunting for).
 */
export function axesFromQuaternion(q: {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
}): { readonly yawRad: number; readonly pitchRad: number; readonly rollRad: number } {
  const { x, y, z, w } = q;
  // Rotated basis vectors from the standard quaternion→matrix identities. Only the local +Z
  // column (forward) and the y component of the local +X column (roll) are needed; no
  // normalization — physics quaternions are unit by construction, and asin is clamped anyway.
  const forwardX = 2 * (x * z + w * y);
  const forwardY = 2 * (y * z - w * x);
  const forwardZ = 1 - 2 * (x * x + y * y);
  const localXy = 2 * (x * y + w * z);
  return {
    yawRad: Math.atan2(forwardX, forwardZ),
    pitchRad: Math.asin(clamp(forwardY, -1, 1)),
    rollRad: Math.asin(clamp(localXy, -1, 1)),
  };
}

/** Samples belonging to one phase, in order. */
export function samplesInPhase(
  samples: readonly ProbeSample[],
  phase: string,
): readonly ProbeSample[] {
  return samples.filter((s) => s.phase === phase);
}

/** Median gap between consecutive samples (s) — the honest quantization floor for every timing
 * metric. Median, not mean: one long frame (a GC pause, a lazy chunk landing) must not inflate
 * the number the whole battery is read against. Returns 0 for fewer than 2 samples. */
export function medianSampleIntervalSec(samples: readonly ProbeSample[]): number {
  if (samples.length < 2) return 0;
  const gaps: number[] = [];
  for (let i = 1; i < samples.length; i++) gaps.push(samples[i].tSec - samples[i - 1].tSec);
  gaps.sort((a, b) => a - b);
  const mid = gaps.length >> 1;
  return gaps.length % 2 === 1 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
}

/**
 * Time (s, measured from the FIRST sample of `phase`) at which planar speed first reaches
 * `speedMps`, linearly interpolated between the bracketing samples so the answer is not
 * quantized to the frame grid.
 *
 * Returns null when the speed is never reached — the case that matters most, because a launch
 * probe on a car whose asymptote sits below 90 % of its nominal top speed MUST say "never
 * reached" rather than hand back the last sample's time.
 */
export function timeToSpeed(
  samples: readonly ProbeSample[],
  phase: string,
  speedMps: number,
): number | null {
  const seg = samplesInPhase(samples, phase);
  if (seg.length === 0) return null;
  const t0 = seg[0].tSec;
  if (seg[0].speedMps >= speedMps) return 0;
  for (let i = 1; i < seg.length; i++) {
    const prev = seg[i - 1];
    const cur = seg[i];
    if (cur.speedMps < speedMps) continue;
    const span = cur.speedMps - prev.speedMps;
    const frac = span > 0 ? (speedMps - prev.speedMps) / span : 0;
    return prev.tSec - t0 + frac * (cur.tSec - prev.tSec);
  }
  return null;
}

/** Trapezoidal ∫|v| dt over a sample run (m). Speed integration rather than summed chord length:
 * a chord underestimates a curved path, and both manoeuvres this is used for (launch, brake) are
 * straight by construction, so the trapezoid is both simpler and the more accurate of the two. */
export function integrateDistanceM(samples: readonly ProbeSample[]): number {
  let d = 0;
  for (let i = 1; i < samples.length; i++) {
    d += ((samples[i].speedMps + samples[i - 1].speedMps) / 2) * (samples[i].tSec - samples[i - 1].tSec);
  }
  return d;
}

export interface LaunchMetrics {
  readonly t50Sec: number | null;
  readonly t90Sec: number | null;
  readonly peakSpeedMps: number;
  readonly distanceM: number;
}

/** Launch metrics from a trace. `topSpeedMps` is the car's RESOLVED top speed — the caller reads
 * it from getSelectedCarDef(), never from a literal. */
export function launchMetricsFrom(
  samples: readonly ProbeSample[],
  phase: string,
  topSpeedMps: number,
): LaunchMetrics {
  const seg = samplesInPhase(samples, phase);
  return {
    t50Sec: timeToSpeed(samples, phase, topSpeedMps * LAUNCH_FRACTIONS.half),
    t90Sec: timeToSpeed(samples, phase, topSpeedMps * LAUNCH_FRACTIONS.ninety),
    peakSpeedMps: seg.reduce((m, s) => Math.max(m, s.speedMps), 0),
    distanceM: integrateDistanceM(seg),
  };
}

export interface BrakeMetrics {
  readonly entrySpeedMps: number;
  readonly brakeDistM: number | null;
  readonly brakeSec: number | null;
  readonly stopped: boolean;
}

/**
 * Brake metrics from a trace: entry speed is the FIRST sample of the brake phase (the frame the
 * brake edge went out), and distance/time run to the first sample under `stopSpeedMps`.
 *
 * The final partial interval is interpolated to the exact crossing rather than snapped to the
 * frame grid — at ~55 ms per sample and ~5 m/s of speed left in the last frame, snapping would
 * add up to ~0.3 m of phantom stopping distance.
 *
 * Never stopping is reported as `stopped: false` with NULL distance/time. A brake distance that
 * silently means "as far as it got in 12 s" is exactly the kind of truncated number this phase
 * exists to not produce.
 */
export function brakeMetricsFrom(
  samples: readonly ProbeSample[],
  phase: string,
  stopSpeedMps: number,
): BrakeMetrics {
  const seg = samplesInPhase(samples, phase);
  if (seg.length === 0) {
    return { entrySpeedMps: 0, brakeDistM: null, brakeSec: null, stopped: false };
  }
  const entrySpeedMps = seg[0].speedMps;
  const t0 = seg[0].tSec;
  let dist = 0;
  for (let i = 1; i < seg.length; i++) {
    const prev = seg[i - 1];
    const cur = seg[i];
    const dt = cur.tSec - prev.tSec;
    if (cur.speedMps < stopSpeedMps) {
      // Interpolate the crossing inside this interval.
      const span = prev.speedMps - cur.speedMps;
      const frac = span > 0 ? clamp((prev.speedMps - stopSpeedMps) / span, 0, 1) : 1;
      const dtc = dt * frac;
      const vEnd = prev.speedMps + (cur.speedMps - prev.speedMps) * frac;
      dist += ((prev.speedMps + vEnd) / 2) * dtc;
      return {
        entrySpeedMps,
        brakeDistM: dist,
        brakeSec: prev.tSec - t0 + dtc,
        stopped: true,
      };
    }
    dist += ((prev.speedMps + cur.speedMps) / 2) * dt;
  }
  return { entrySpeedMps, brakeDistM: null, brakeSec: null, stopped: false };
}

export interface PeakYawMetrics {
  readonly peakYawRateRadS: number | null;
  readonly timeToPeakSec: number | null;
  readonly quantizationSec: number;
}

/**
 * Peak |yaw rate| in a phase and the time from the phase's first sample to it.
 *
 * The FIRST sample of the phase is skipped: its yawRate was differentiated across the phase
 * boundary (the frame before the steer edge), so it belongs to the previous phase's motion.
 * Ties go to the EARLIEST peak — a plateau's leading edge is the response time being measured.
 */
export function peakYawFrom(samples: readonly ProbeSample[], phase: string): PeakYawMetrics {
  const seg = samplesInPhase(samples, phase);
  const quantizationSec = medianSampleIntervalSec(seg);
  if (seg.length < 2) return { peakYawRateRadS: null, timeToPeakSec: null, quantizationSec };
  const t0 = seg[0].tSec;
  let best = -1;
  let bestT = 0;
  for (let i = 1; i < seg.length; i++) {
    const mag = Math.abs(seg[i].yawRateRadS);
    if (mag > best) {
      best = mag;
      bestT = seg[i].tSec - t0;
    }
  }
  return { peakYawRateRadS: best, timeToPeakSec: bestT, quantizationSec };
}

export interface SettledWindow {
  readonly startSec: number;
  readonly endSec: number;
  readonly durationSec: number;
  readonly meanSpeedMps: number;
  readonly meanYawRateRadS: number;
  readonly radiusM: number;
  readonly sampleCount: number;
}

export interface SettledWindowOptions {
  /** Seconds of the phase discarded up front — the entry transient. */
  readonly rejectSec: number;
  readonly minWindowSec: number;
  /** Max (max−min)/|mean| spread allowed inside the window, for |yaw rate| AND for speed. */
  readonly tolerance: number;
}

/**
 * The settled portion of a steady-state turn: the LONGEST trailing window of the phase in which
 * both |yaw rate| and speed hold within `tolerance` of their means.
 *
 * The search shrinks the window FROM THE FRONT — start with everything after `rejectSec`, and
 * drop leading samples until the spread test passes. That is literally "reject the entry
 * transient", and it means the returned window is the largest settled one available rather than
 * the first fixed-length slice that happens to pass.
 *
 * Returns null when nothing settles (the car was still winding up, or it was disturbed), when the
 * remaining window is shorter than `minWindowSec`, or when the mean yaw rate is ~0 (a straight
 * line has no radius, and dividing by it would report a spectacular fake).
 */
export function settledTurnWindow(
  samples: readonly ProbeSample[],
  phase: string,
  opts: SettledWindowOptions,
): SettledWindow | null {
  const seg = samplesInPhase(samples, phase);
  if (seg.length === 0) return null;
  const phaseT0 = seg[0].tSec;
  const cand = seg.filter((s) => s.tSec - phaseT0 >= opts.rejectSec);
  for (let i = 0; i < cand.length - 1; i++) {
    const win = cand.slice(i);
    const durationSec = win[win.length - 1].tSec - win[0].tSec;
    if (durationSec < opts.minWindowSec) return null; // every shorter window is too short too
    const yaws = win.map((s) => Math.abs(s.yawRateRadS));
    const speeds = win.map((s) => s.speedMps);
    if (!withinTolerance(yaws, opts.tolerance)) continue;
    if (!withinTolerance(speeds, opts.tolerance)) continue;
    const meanYaw = mean(yaws);
    const meanSpeed = mean(speeds);
    if (meanYaw < 1e-4) return null;
    return {
      startSec: win[0].tSec,
      endSec: win[win.length - 1].tSec,
      durationSec,
      meanSpeedMps: meanSpeed,
      meanYawRateRadS: meanYaw,
      radiusM: meanSpeed / meanYaw,
      sampleCount: win.length,
    };
  }
  return null;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** (max−min) ≤ tolerance × |mean|. A near-zero mean fails closed (nothing "settles" around 0 in
 * a metric whose whole point is a ratio against it). */
function withinTolerance(values: readonly number[], tolerance: number): boolean {
  const m = Math.abs(mean(values));
  if (m < 1e-6) return false;
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return hi - lo <= tolerance * m;
}

export interface StabilityMetrics {
  readonly rollPeakRad: number;
  readonly pitchPeakRad: number;
  readonly flipEvents: number;
  readonly airtimeFrac: number;
  readonly frames: number;
  readonly minSpeedMps: number;
}

/**
 * Roll/pitch peaks, flip events and airtime over a phase.
 *
 * A flip event is a run of consecutive `upright === false` samples spanning MORE than
 * `flipDwellSec` — the plan's own definition. Counting bare `upright === false` frames instead
 * would score a hard lean over a kerb as a flip; the dwell is what separates "leaned" from
 * "went over". Airtime is a frame RATIO and is reported with its denominator (`frames`), one of
 * the two ratios the plan explicitly allows to be frame-based.
 */
export function stabilityMetricsFrom(
  samples: readonly ProbeSample[],
  phase: string,
  flipDwellSec: number,
): StabilityMetrics {
  const seg = samplesInPhase(samples, phase);
  let rollPeakRad = 0;
  let pitchPeakRad = 0;
  let airborne = 0;
  let minSpeedMps = Infinity;
  let flipEvents = 0;
  let runStart: number | null = null;
  let runCounted = false;
  for (const s of seg) {
    rollPeakRad = Math.max(rollPeakRad, Math.abs(s.rollRad));
    pitchPeakRad = Math.max(pitchPeakRad, Math.abs(s.pitchRad));
    if (s.wheelsInContact === 0) airborne++;
    minSpeedMps = Math.min(minSpeedMps, s.speedMps);
    if (!s.upright) {
      if (runStart === null) {
        runStart = s.tSec;
        runCounted = false;
      } else if (!runCounted && s.tSec - runStart > flipDwellSec) {
        // ONE event per sustained run: a 4 s roll is one flip, not eight. `runCounted` (rather
        // than resetting runStart) is what makes that true — resetting would re-arm the dwell and
        // score a long roll once per dwell period.
        flipEvents++;
        runCounted = true;
      }
    } else {
      runStart = null;
      runCounted = false;
    }
  }
  return {
    rollPeakRad,
    pitchPeakRad,
    flipEvents,
    airtimeFrac: seg.length > 0 ? airborne / seg.length : 0,
    frames: seg.length,
    minSpeedMps: seg.length > 0 ? minSpeedMps : 0,
  };
}

export interface TurnRunwayEstimate {
  readonly radiusEstM: number;
  readonly lateralM: number;
  readonly longitudinalM: number;
}

/**
 * How much road a steady full-lock turn at `speedMps` will eat, over a measurement window of
 * `windowSec`. Used ONLY to decide whether a probe may run — never as a substitute for a
 * measurement.
 *
 * Two radii bound the answer and the LARGER lateral consumer wins:
 *   • kinematic (bicycle) radius   R_k = wheelbase / tan(δ), with δ the speed-scaled steer clamp
 *     read from the shipped vehicles/steering.ts `steerClampRad` — the geometry the wheels ask
 *     for;
 *   • grip-limited radius          R_g = v² / a_lat_cap — the tyres' opinion.
 * The car turns on whichever is WIDER, so R = max(R_k, R_g). Lateral/longitudinal consumption is
 * then the exact circular-arc offset over the window, R(1−cos θ) and R·sin θ with θ = v·t/R —
 * not a small-angle approximation, because θ is not small at 5 m/s.
 */
export function estimateTurnRunway(params: {
  readonly speedMps: number;
  readonly topSpeedMps: number;
  readonly wheelbaseM: number;
  readonly maxAngleDeg: number;
  readonly highSpeedAngleDeg: number;
  readonly latAccelCapMps2: number;
  readonly windowSec: number;
}): TurnRunwayEstimate {
  const delta = steerClampRad(params.speedMps, params.topSpeedMps, {
    maxAngleDeg: params.maxAngleDeg,
    highSpeedAngleDeg: params.highSpeedAngleDeg,
  });
  const kinematicR = params.wheelbaseM / Math.max(Math.tan(delta), 1e-6);
  const gripR = params.speedMps > 0 ? (params.speedMps * params.speedMps) / params.latAccelCapMps2 : 0;
  const radiusEstM = Math.max(kinematicR, gripR);
  const theta = radiusEstM > 0 ? (params.speedMps * params.windowSec) / radiusEstM : 0;
  return {
    radiusEstM,
    lateralM: radiusEstM * (1 - Math.cos(theta)),
    longitudinalM: radiusEstM * Math.sin(theta),
  };
}

/**
 * Rigorous UPPER BOUND on the road a straight-line manoeuvre can consume: the car cannot exceed
 * its governed top speed (vehicles/steering.ts `throttleGovernor` fades engine force to zero
 * there, the map is flat, and nothing else propels the player), so `topSpeed × maxSec` bounds the
 * distance whatever the acceleration curve turns out to be. Deliberately a BOUND and not a
 * prediction — a runway pre-check that guessed low would be worse than useless. */
export function estimateStraightRunwayM(topSpeedMps: number, maxSec: number): number {
  return topSpeedMps * maxSec;
}

/** Assemble a runway verdict. Kept pure + separate so the "sufficient" rule has one home. */
export function makeRunway(
  availableLongitudinalM: number,
  neededLongitudinalM: number,
  availableLateralM: number,
  neededLateralM: number,
): ProbeRunway {
  return {
    availableLongitudinalM,
    neededLongitudinalM,
    availableLateralM,
    neededLateralM,
    sufficient: neededLongitudinalM <= availableLongitudinalM && neededLateralM <= availableLateralM,
  };
}

/** Worst case across a set of runways (max need, min availability) — the aggregate a multi-point
 * probe (turn radius) reports at its top level while each point keeps its own. */
export function worstRunway(runways: readonly ProbeRunway[]): ProbeRunway {
  if (runways.length === 0) return makeRunway(0, 0, 0, 0);
  return makeRunway(
    Math.min(...runways.map((r) => r.availableLongitudinalM)),
    Math.max(...runways.map((r) => r.neededLongitudinalM)),
    Math.min(...runways.map((r) => r.availableLateralM)),
    Math.max(...runways.map((r) => r.neededLateralM)),
  );
}

/**
 * The status a probe should report, from the three things that can go wrong, in priority order:
 * an interruption beats a runway shortfall (it is what actually ended the run), a runway
 * shortfall beats an unusable trace (it explains it), and only then does the metric's own
 * verdict apply. One function so no probe invents its own precedence.
 */
export function resolveProbeStatus(args: {
  readonly interruption: ProbeInterruption | null;
  readonly runwaySufficient: boolean;
  readonly metricUsable: boolean;
}): ProbeStatus {
  if (args.interruption) return 'interrupted';
  if (!args.runwaySufficient) return 'insufficientRunway';
  return args.metricUsable ? 'ok' : 'inconclusive';
}

// ============================================================================================
// Corridor derivation — the cleared straight, from the street table (no coordinate literals)
// ============================================================================================

/**
 * The Yonge spine's DOWNTOWN segment, which is the longest and widest straight ribbon on the map
 * and therefore the only place these manoeuvres fit. Derived, never typed:
 *
 *   • centre x  — the spine street's own centreline (which is YONGE_X by construction; asserted,
 *                 so a projection change is a loud failure and not a silently wrong probe).
 *   • north end — Bloor's ribbon edge plus a clearance, so a probe never opens inside the widest
 *                 junction on the corridor. Staying SOUTH of Bloor also keeps every probe out of
 *                 the fold band, whose crossing fires the Line 1 tunnel overlay
 *                 (world/toronto/tunnel.ts) — an overlay firing mid-brake-probe would be one more
 *                 uncontrolled variable.
 *   • south end — the spine ribbon's own south end, held back by CORRIDOR_SOUTH_MARGIN_M so a
 *                 brake overrun cannot reach the harbour's water sensor.
 *
 * Direction is +z (south), which is the IDENTITY quaternion and therefore the same facing the
 * shipped TORONTO_SPAWN_POSE uses — the probe start pose is the same kind of pose the game itself
 * vets, just relocated to the top of the corridor so the whole segment is runway.
 *
 * Toronto-only by construction (the street table is the map), matching ai/cameraLabDrive.ts.
 */
export function resolveProbeCorridor(): ProbeCorridor {
  if (WORLD_SOURCE !== 'toronto') {
    throw new Error(`feelProbes: WORLD_SOURCE is '${WORLD_SOURCE}' — the feel probes are Toronto-only`);
  }
  const { streets } = buildStreets();
  const spine = streets.find((s) => s.cls === 'spine');
  const bloor = streets.find((s) => s.id === 'bloor');
  if (!spine) throw new Error('feelProbes: no spine street in the street table');
  if (!bloor) throw new Error("feelProbes: street 'bloor' is not in the street table");
  if (Math.abs(spine.centerline - YONGE_X) > 1e-6) {
    // Loud, not silent — the same drift-catching stance cameraLabDrive.downtownDriveRect takes.
    throw new Error(
      `feelProbes: spine centreline ${spine.centerline} is not YONGE_X (${YONGE_X}); the corridor derivation is stale`,
    );
  }
  const [centreX] = mapToWorld({ x: spine.centerline, y: spine.span[0] });
  const [, spineSouthZ] = mapToWorld({ x: spine.centerline, y: spine.span[1] });
  const [, bloorZ] = mapToWorld({ x: spine.centerline, y: bloor.centerline });

  const startZ = bloorZ + bloor.halfWidth + CORRIDOR_START_CLEARANCE_M;
  // Never past the shore, whichever comes first — ZONE_BOUNDARIES[3] is the water line.
  const [, shoreZ] = mapToWorld({ x: spine.centerline, y: ZONE_BOUNDARIES[3] });
  const endZ = Math.min(spineSouthZ, shoreZ) - CORRIDOR_SOUTH_MARGIN_M;
  return {
    centreX,
    startZ,
    endZ,
    lengthM: Math.max(0, endZ - startZ - CORRIDOR_END_SLACK_M),
    ribbonHalfWidthM: spine.halfWidth,
    clearHalfWidthM: spine.halfWidth + SIDEWALK.widthWu,
  };
}

/** The deterministic probe start pose: on the corridor centreline at its north end, facing +z
 * (identity rotation), at the shipped spawn's settle height. Every probe teleports here first. */
export function probeStartPose(corridor: ProbeCorridor): VehiclePose {
  return {
    position: { x: corridor.centreX, y: TORONTO_SPAWN_POSE.position.y, z: corridor.startZ },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
  };
}

// ============================================================================================
// Report formatting (pure — testable without a live run)
// ============================================================================================

function fmt(n: number | null, digits = 2): string {
  return n === null || !Number.isFinite(n) ? 'n/a' : n.toFixed(digits);
}

function statusSuffix(r: ProbeResultBase): string {
  const bits: string[] = [r.status];
  if (r.status === 'insufficientRunway') {
    bits.push(
      `need ${fmt(r.runway.neededLongitudinalM, 0)}m/${fmt(r.runway.neededLateralM, 1)}m lat, ` +
        `had ${fmt(r.runway.availableLongitudinalM, 0)}m/${fmt(r.runway.availableLateralM, 1)}m`,
    );
  }
  if (r.interruption) bits.push(`${r.interruption.reason}@${fmt(r.interruption.atSec, 1)}s: ${r.interruption.detail}`);
  return ` [${bits.join(' · ')}]`;
}

/** One line per probe, plus the header the battery's console capture reads. Pure formatter, split
 * out for the same reason chaosBench.ts splits formatBenchReport: the numbers stay testable
 * without a live drive. */
export function formatProbeSuiteReport(suite: FeelProbeSuiteResult): string {
  const lines: string[] = [
    `[feelProbes] car ${suite.carId} · topSpeed ${fmt(suite.topSpeedMps, 1)} m/s · ` +
      `corridor ${fmt(suite.corridor.lengthM, 0)} m on Yonge x=${fmt(suite.corridor.centreX, 0)} ` +
      `(ribbon ±${fmt(suite.corridor.ribbonHalfWidthM, 1)} m, clear ±${fmt(suite.corridor.clearHalfWidthM, 1)} m)`,
    `  isolation: civTraffic ${suite.isolation.civTraffic} · transit ${suite.isolation.transit}` +
      ` · packParked ${suite.isolation.packParked} · invincible ${suite.isolation.invincible}` +
      '  ← NOT live play',
  ];
  for (const r of suite.results) {
    switch (r.kind) {
      case 'launch':
        lines.push(
          `  launch     t50 ${fmt(r.t50Sec)}s  t90 ${fmt(r.t90Sec)}s  peak ${fmt(r.peakSpeedMps, 1)} m/s` +
            `  (targets ${fmt(r.target50Mps, 1)}/${fmt(r.target90Mps, 1)})  dist ${fmt(r.distanceM, 0)} m` +
            `  Δt ${fmt(r.sampleIntervalSec, 3)}s${statusSuffix(r)}`,
        );
        break;
      case 'brake':
        lines.push(
          `  brake      dist ${fmt(r.brakeDistM, 1)} m  time ${fmt(r.brakeSec)}s  from ${fmt(r.entrySpeedMps, 1)} m/s` +
            `${r.entryTargetMet ? '' : ` (target ${fmt(r.entryTargetMps, 1)} NOT reached)`}${statusSuffix(r)}`,
        );
        break;
      case 'stepSteer':
        lines.push(
          `  stepSteer  peakYaw ${fmt(r.peakYawRateRadS, 3)} rad/s  in ${fmt(r.steerToPeakYawSec)}s` +
            ` ±${fmt(r.quantizationSec, 3)}s (quantization)  at ${fmt(r.entrySpeedMps, 1)} m/s${statusSuffix(r)}`,
        );
        break;
      case 'turnRadius':
        lines.push(`  turnRadius${statusSuffix(r)}`);
        for (const p of r.points) {
          lines.push(
            `    @${fmt(p.targetSpeedMps, 0)} m/s  R ${fmt(p.radiusM, 1)} m  ` +
              `(v ${fmt(p.measuredSpeedMps, 1)}, yaw ${fmt(p.yawRateRadS, 3)} rad/s, ` +
              `window ${fmt(p.settledWindowSec, 2)}s / ${p.samplesInWindow} samples)  [${p.status}]` +
              (p.note ? ` — ${p.note}` : ''),
          );
        }
        break;
      case 'slalom':
        lines.push(
          `  slalom     roll ${fmt(r.rollPeakRad, 3)} rad  pitch ${fmt(r.pitchPeakRad, 3)} rad  ` +
            `flips ${r.flipEvents}  airtime ${(r.airtimeFrac * 100).toFixed(1)}% of ${r.sampleCount} frames  ` +
            `v ${fmt(r.entrySpeedMps, 1)}→min ${fmt(r.minSpeedMps, 1)} m/s${statusSuffix(r)}`,
        );
        break;
    }
    if (r.contacts.length > 0) {
      const kinds = r.contacts.map((c) => c.counterpartKind).join(',');
      lines.push(`             contacts: ${r.contacts.length} (${kinds})`);
    }
  }
  return lines.join('\n');
}

// ============================================================================================
// Live run — readiness, isolation, the scripted segment loop
// ============================================================================================

/** Polls until the machine reaches PLAYING and the player vehicle ref is populated. Both waits
 * are necessary, for the React-commit race ai/chaosBench.ts's ensurePlaying/waitForPlayerReady
 * document at length. Local copy, per this file's header. */
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
    `feelProbes: player never became drivable within ${READY_TIMEOUT_MS}ms ` +
      `(machine ${getGameState().machine}, vehicle ${playerVehicle.current ? 'ready' : 'null'})`,
  );
}

/**
 * Blocks until the page is delivering frames STEADILY (or WARMUP_TIMEOUT_MS elapses — a slow
 * machine still gets its probes, just a colder run). A cold Toronto mount spends its first
 * seconds building frontage/furniture/the clip index, and a multi-second main-thread stall ends
 * in a Rapier catch-up burst that LAUNCHES the car (measured live during Phase 33: 0 → 20.9 m/s
 * across one stall). A launch probe opening inside that burst would report a fantasy t50.
 */
async function waitForSteadyFrames(): Promise<void> {
  let frames = 0;
  let running = true;
  const tick = (): void => {
    frames++;
    if (running) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  try {
    const start = performance.now();
    let last = frames;
    let steady = 0;
    while (performance.now() - start < WARMUP_TIMEOUT_MS) {
      await sleep(WARMUP_POLL_MS);
      const now = frames;
      steady = now - last >= WARMUP_MIN_FRAMES ? steady + 1 : 0;
      last = now;
      if (steady >= WARMUP_STEADY_POLLS) return;
    }
  } finally {
    running = false;
  }
}

/** The isolation switches a probe run applies, and the previous values to put back. All four are
 * existing, already-proven dev toggles (core/devToggles.ts) — the same ones core/debugBridge.ts
 * exposes as setCivTraffic/setPackParked/setInvincible; this module writes them directly rather
 * than through the bridge so the probes work with or without the bridge being wired.
 *
 * `invincible` is VERIFIED HP-ONLY (phase-74-plan.md Decision 4): its sole consumer is an early
 * return in combat/damage.ts's applyPlayerDamage; no force/impulse path reads it, so it cannot
 * bias a kinematic measurement — it only stops a 25 m/s brake probe from ending the run.
 * Precedent: ai/chaosBench.ts:374-375 does exactly this for the standing perf harness.
 *
 * `transit` is included alongside civTraffic even though the plan's toggle list names only
 * civTraffic/packParked/invincible: TTC route 97 runs the FULL Yonge spine (config/
 * torontoTransit.ts), i.e. straight down the probe corridor, so leaving buses on would put a
 * 12 m vehicle in the middle of every brake probe. Phase 42's flicker sweep sets exactly this
 * pair off together, for the same "moving agents make the run non-comparable" reason.
 */
const PROBE_ISOLATION: ProbeIsolation = {
  civTraffic: false,
  transit: false,
  packParked: false,
  invincible: true,
};

function applyIsolation(): () => void {
  const prev = getDevToggles();
  const restore = {
    civTraffic: prev.civTraffic,
    transit: prev.transit,
    packParked: prev.packParked,
    invincible: prev.invincible,
  };
  setDevToggle('civTraffic', PROBE_ISOLATION.civTraffic);
  setDevToggle('transit', PROBE_ISOLATION.transit);
  setDevToggle('packParked', PROBE_ISOLATION.packParked);
  setDevToggle('invincible', PROBE_ISOLATION.invincible);
  return () => {
    setDevToggle('civTraffic', restore.civTraffic);
    setDevToggle('transit', restore.transit);
    setDevToggle('packParked', restore.packParked);
    setDevToggle('invincible', restore.invincible);
  };
}

/** Mutable per-probe run state shared by the segment loop and the probe bodies. */
interface ProbeRun {
  readonly corridor: ProbeCorridor;
  readonly samples: ProbeSample[];
  readonly contacts: ProbeContact[];
  /** performance.now() at probe start — every sample's tSec is relative to this. */
  readonly t0: number;
  prevYawRad: number | null;
  prevSampleSec: number | null;
  /** Set by the contact subscription; consumed (and cleared) by the segment loop's checks. */
  pendingHardContact: ProbeContact | null;
  flipRunStartSec: number | null;
}

function newRun(corridor: ProbeCorridor): ProbeRun {
  return {
    corridor,
    samples: [],
    contacts: [],
    t0: performance.now(),
    prevYawRad: null,
    prevSampleSec: null,
    pendingHardContact: null,
    flipRunStartSec: null,
  };
}

/** Which side of an impact was NOT the player. */
function counterpartKindOf(impact: ImpactRecord): EntityKind | 'unknown' {
  if (impact.a && impact.a.kind !== 'player') return impact.a.kind;
  if (impact.b && impact.b.kind !== 'player') return impact.b.kind;
  return 'unknown';
}

function buildSample(
  run: ProbeRun,
  phase: string,
  state: Readonly<VehicleState>,
  input: VehicleInputs,
): ProbeSample {
  const tSec = (performance.now() - run.t0) / 1000;
  const pos = state.rawPose.position;
  const { yawRad, pitchRad, rollRad } = axesFromQuaternion(state.rawPose.rotation);
  const dt = run.prevSampleSec === null ? 0 : tSec - run.prevSampleSec;
  const yawRateRadS =
    run.prevYawRad === null || dt <= 0 ? 0 : wrapAngle(yawRad - run.prevYawRad) / dt;
  run.prevYawRad = yawRad;
  run.prevSampleSec = tSec;
  let wheelsInContact = 0;
  for (const w of state.wheels) if (w.inContact) wheelsInContact++;
  return {
    tSec,
    phase,
    x: pos.x,
    z: pos.z,
    speedMps: Math.hypot(state.velocity.x, state.velocity.z),
    forwardSpeedMps: state.forwardSpeed,
    yawRad,
    yawRateRadS,
    rollRad,
    pitchRad,
    upright: state.upright,
    wheelsInContact,
    steer: input.steer,
    throttle: input.throttle,
    brake: input.brake,
  };
}

/**
 * Everything that can end a segment early, checked once per sample. Returns the interruption or
 * null. Ordered so the most specific/most trustworthy cause wins: a registry-typed hard contact
 * beats the kinematic speed-drop heuristic that would also fire on the same frame.
 */
function detectInterruption(run: ProbeRun, sample: ProbeSample): ProbeInterruption | null {
  if (getGameState().machine !== 'PLAYING') {
    return { reason: 'leftPlaying', atSec: sample.tSec, detail: `machine ${getGameState().machine}` };
  }
  const hard = run.pendingHardContact;
  run.pendingHardContact = null;
  if (hard) {
    return {
      reason: 'collision',
      atSec: sample.tSec,
      detail: `hit ${hard.counterpartKind} (force ${hard.forceMag.toFixed(0)})`,
    };
  }
  // Flip dwell — `upright` is raycastVehicle's own chassis-up test.
  if (!sample.upright) {
    if (run.flipRunStartSec === null) run.flipRunStartSec = sample.tSec;
    else if (sample.tSec - run.flipRunStartSec > FLIP_DWELL_SEC) {
      return { reason: 'flip', atSec: sample.tSec, detail: `not upright for >${FLIP_DWELL_SEC}s` };
    }
  } else {
    run.flipRunStartSec = null;
  }
  // Corridor box. Lateral uses the CLEAR half-width (ribbon + colliderless sidewalk band);
  // longitudinal uses the corridor ends.
  const lateral = Math.abs(sample.x - run.corridor.centreX);
  if (lateral > run.corridor.clearHalfWidthM) {
    return {
      reason: 'leftCorridor',
      atSec: sample.tSec,
      detail: `lateral ${lateral.toFixed(1)} m > clear ${run.corridor.clearHalfWidthM.toFixed(1)} m`,
    };
  }
  if (sample.z > run.corridor.endZ || sample.z < run.corridor.startZ - CORRIDOR_BACKSTOP_M) {
    return {
      reason: 'leftCorridor',
      atSec: sample.tSec,
      detail: `z ${sample.z.toFixed(0)} outside [${run.corridor.startZ.toFixed(0)}, ${run.corridor.endZ.toFixed(0)}]`,
    };
  }
  // Kinematic backstop (heuristic — see INTERRUPT_SPEED_DROP_MPS).
  const prev = run.samples[run.samples.length - 2];
  if (prev && sample.brake < 0.5 && prev.speedMps - sample.speedMps > INTERRUPT_SPEED_DROP_MPS) {
    return {
      reason: 'collision',
      atSec: sample.tSec,
      detail: `unexplained speed drop ${(prev.speedMps - sample.speedMps).toFixed(1)} m/s in one frame (heuristic)`,
    };
  }
  return null;
}

interface SegmentSpec {
  /** Stamped on every sample this segment records — the key the pure analysis functions slice on. */
  readonly phase: string;
  readonly maxSec: number;
  /**
   * The command applied SYNCHRONOUSLY, before the segment's first sample.
   *
   * This exists to kill a systematic one-frame bias. Our rAF callback is registered after r3f's,
   * so it runs at the END of a frame: a sample taken there reflects the physics step just
   * completed, and a command issued after it does not take effect until the NEXT step. Without
   * `openWith`, "time from the throttle edge" would therefore be measured from a frame in which
   * the throttle was still zero — a whole sample interval (~55 ms here) of phantom lag on t50,
   * and proportionally worse on `steerToPeakYawSec`, the metric that already sits closest to the
   * quantization floor.
   *
   * With it, the phase contract is uniform and stateable: the phase's opening command is live
   * BEFORE its first sample, so `tSec = 0` is the first frame measured under that command.
   */
  readonly openWith?: VehicleInputs;
  /** Called once per frame with the sample just taken; returns the input to apply from now on and
   * whether the segment is finished. */
  readonly step: (sample: ProbeSample, segmentSec: number) => { input: VehicleInputs; done: boolean };
}

interface SegmentOutcome {
  readonly endedBy: 'done' | 'timeout' | 'interrupted';
  readonly interruption: ProbeInterruption | null;
}

/**
 * Run one scripted input segment: sample every rendered frame, feed the script's command through
 * `setDrivingInputOverride`, and stop on the script's own `done`, on `maxSec`, or on an
 * interruption. Never throws — a failure is data (an outcome), because a probe that threw would
 * lose the trace that explains why.
 */
function runSegment(run: ProbeRun, spec: SegmentSpec): Promise<SegmentOutcome> {
  return new Promise<SegmentOutcome>((resolve) => {
    const segStart = performance.now();
    let lastFrameAt = segStart;
    let finished = false;
    let rafId = 0;
    let input: VehicleInputs = spec.openWith ?? NEUTRAL_INPUT;
    if (spec.openWith) setDrivingInputOverride(spec.openWith);

    const stallWatch = setInterval(() => {
      // rAF does not fire in a backgrounded tab; without this the whole battery would hang on a
      // promise that can never settle.
      if (!finished && performance.now() - lastFrameAt > FRAME_STALL_MS) {
        finish({
          endedBy: 'interrupted',
          interruption: {
            reason: 'frameStall',
            atSec: (performance.now() - run.t0) / 1000,
            detail: `no frame for >${FRAME_STALL_MS}ms`,
          },
        });
      }
    }, FRAME_STALL_POLL_MS);

    function finish(outcome: SegmentOutcome): void {
      if (finished) return;
      finished = true;
      clearInterval(stallWatch);
      if (rafId) cancelAnimationFrame(rafId);
      resolve(outcome);
    }

    function frame(): void {
      if (finished) return;
      lastFrameAt = performance.now();
      const vehicle = playerVehicle.current;
      if (!vehicle) {
        // The player remounted underneath us (a run reset, a car swap). That is not a physics
        // result — report it as leaving PLAYING rather than pretending the trace continues.
        finish({
          endedBy: 'interrupted',
          interruption: {
            reason: 'leftPlaying',
            atSec: (performance.now() - run.t0) / 1000,
            detail: 'player vehicle ref went null mid-segment',
          },
        });
        return;
      }
      const sample = buildSample(run, spec.phase, vehicle.readState(), input);
      run.samples.push(sample);
      const interruption = detectInterruption(run, sample);
      if (interruption) {
        setDrivingInputOverride(NEUTRAL_INPUT);
        finish({ endedBy: 'interrupted', interruption });
        return;
      }
      const segmentSec = (lastFrameAt - segStart) / 1000;
      const next = spec.step(sample, segmentSec);
      input = next.input;
      setDrivingInputOverride(input);
      if (next.done) {
        finish({ endedBy: 'done', interruption: null });
        return;
      }
      if (segmentSec >= spec.maxSec) {
        finish({ endedBy: 'timeout', interruption: null });
        return;
      }
      rafId = requestAnimationFrame(frame);
    }

    rafId = requestAnimationFrame(frame);
  });
}

/**
 * Teleport to the deterministic start pose and wait for the chassis to come to rest on its
 * suspension. Returns false if it never settles (reported as `inconclusive`, never papered over).
 *
 * Reads `playerVehicle.current` FRESH rather than taking the handle captured at suite start: a run
 * reset or a car swap between probes replaces the model, and driving a stale one would teleport a
 * destroyed body and then measure a car that never moved. Also re-asserts PLAYING, because physics
 * is paused outside it (game/index.tsx's `<Physics paused>`) and a probe teleporting into a paused
 * world would sit at zero speed forever — the same belt-and-suspenders revival ai/chaosBench.ts's
 * drive tick does.
 */
async function teleportAndSettle(corridor: ProbeCorridor): Promise<boolean> {
  const state = getGameState();
  if (state.machine !== 'PLAYING' && canTransition(state.machine, 'PLAYING')) {
    state.transition('PLAYING');
  }
  const player = playerVehicle.current;
  if (!player) return false;
  setDrivingInputOverride(NEUTRAL_INPUT);
  player.reset(probeStartPose(corridor));
  await sleep(SETTLE_MIN_MS);
  const start = performance.now();
  while (performance.now() - start < SETTLE_TIMEOUT_MS) {
    const live = playerVehicle.current;
    if (!live) return false;
    const s = live.readState();
    const speed = Math.hypot(s.velocity.x, s.velocity.z);
    let inContact = 0;
    for (const w of s.wheels) if (w.inContact) inContact++;
    if (speed < SETTLE_SPEED_MPS && inContact >= SETTLE_WHEELS_IN_CONTACT) return true;
    await sleep(SETTLE_POLL_MS);
  }
  return false;
}

/** The speed-hold command used by every approach phase: base throttle plus a P term, with a brake
 * term on overshoot so the controller converges instead of coasting down. */
function holdSpeedInput(currentMps: number, targetMps: number, steer = 0): VehicleInputs {
  const error = targetMps - currentMps;
  if (error < -HOLD_TOLERANCE_MPS) {
    return { steer, throttle: 0, brake: clamp(-error * HOLD_BRAKE_GAIN, 0, 1), handbrake: false };
  }
  return {
    steer,
    throttle: clamp(HOLD_THROTTLE_BASE + error * HOLD_SPEED_GAIN, 0, 1),
    brake: 0,
    handbrake: false,
  };
}

/** Approach-phase script factory: hold `targetMps` and finish once the speed has stayed inside
 * HOLD_TOLERANCE_MPS for HOLD_DWELL_SEC. The dwell is what stops the next phase opening on a
 * single lucky frame that happened to touch the band. */
function makeApproachStep(targetMps: number): SegmentSpec['step'] {
  let inBandSince: number | null = null;
  return (sample, segmentSec) => {
    const atSpeed = Math.abs(sample.speedMps - targetMps) <= HOLD_TOLERANCE_MPS;
    if (atSpeed) inBandSince = inBandSince ?? segmentSec;
    else inBandSince = null;
    return {
      input: holdSpeedInput(sample.speedMps, targetMps),
      done: inBandSince !== null && segmentSec - inBandSince >= HOLD_DWELL_SEC,
    };
  };
}

// ============================================================================================
// The five probes
// ============================================================================================

interface ProbeContext {
  readonly corridor: ProbeCorridor;
  readonly carId: PlayerCarId;
  readonly topSpeedMps: number;
  readonly wheelbaseM: number;
  readonly maxAngleDeg: number;
  readonly highSpeedAngleDeg: number;
  readonly includeSamples: boolean;
}

function baseFields(
  ctx: ProbeContext,
  kind: ProbeKind,
  run: ProbeRun,
  runway: ProbeRunway,
  interruption: ProbeInterruption | null,
  status: ProbeStatus,
): ProbeResultBase {
  const last = run.samples[run.samples.length - 1];
  return {
    kind,
    status,
    insufficientRunway: status === 'insufficientRunway',
    interrupted: interruption !== null,
    interruption,
    carId: ctx.carId,
    topSpeedMps: ctx.topSpeedMps,
    corridor: ctx.corridor,
    runway,
    isolation: PROBE_ISOLATION,
    durationSec: last ? last.tSec : 0,
    sampleCount: run.samples.length,
    sampleIntervalSec: medianSampleIntervalSec(run.samples),
    contacts: run.contacts,
    ...(ctx.includeSamples ? { samples: run.samples } : {}),
  };
}

function speedTraceOf(samples: readonly ProbeSample[], phase: string): SpeedTracePoint[] {
  const seg = samplesInPhase(samples, phase);
  const t0 = seg.length > 0 ? seg[0].tSec : 0;
  return seg.map((s) => ({ tSec: s.tSec - t0, speedMps: s.speedMps }));
}

/** 1 — LAUNCH. From rest, throttle 1.0 held. Times 50 % and 90 % of the car's RESOLVED top
 * speed. Non-reaching is `null`, explained by `peakSpeedMps`. */
async function runLaunchProbe(ctx: ProbeContext, run: ProbeRun): Promise<LaunchProbeResult> {
  markFeelPhase('probe:launch');
  const runway = makeRunway(
    ctx.corridor.lengthM,
    estimateStraightRunwayM(ctx.topSpeedMps, LAUNCH_MAX_SEC),
    ctx.corridor.ribbonHalfWidthM,
    0, // a straight-line launch consumes no lateral room by design
  );
  const settled = await teleportAndSettle(ctx.corridor);
  const target90 = ctx.topSpeedMps * LAUNCH_FRACTIONS.ninety;
  let outcome: SegmentOutcome = { endedBy: 'done', interruption: null };
  if (runway.sufficient && settled) {
    outcome = await runSegment(run, {
      phase: 'launch',
      maxSec: LAUNCH_MAX_SEC,
      openWith: FULL_THROTTLE_INPUT,
      step: (sample) => ({
        input: FULL_THROTTLE_INPUT,
        // Stop the moment the metric is satisfied; holding longer only burns runway.
        done: sample.speedMps >= target90,
      }),
    });
  }
  const metrics = launchMetricsFrom(run.samples, 'launch', ctx.topSpeedMps);
  const status = resolveProbeStatus({
    interruption: outcome.interruption,
    runwaySufficient: runway.sufficient,
    // t90 is THE gated response metric, so a run that never got there is `inconclusive` even
    // though t50 is a perfectly good number — the Feel Spec must not be able to quote a t90 gate
    // off a probe that never reached 90 %. (All six cars' governor/damping equilibria sit near
    // 93 % of their own top speed — the arithmetic cancels massFactor — so this should never fire
    // on the shipped roster. If it does, that IS the finding.)
    metricUsable: settled && metrics.t50Sec !== null && metrics.t90Sec !== null,
  });
  return {
    ...baseFields(ctx, 'launch', run, runway, outcome.interruption, status),
    kind: 'launch',
    t50Sec: metrics.t50Sec,
    t90Sec: metrics.t90Sec,
    target50Mps: ctx.topSpeedMps * LAUNCH_FRACTIONS.half,
    target90Mps: target90,
    peakSpeedMps: metrics.peakSpeedMps,
    distanceM: metrics.distanceM,
    speedTrace: speedTraceOf(run.samples, 'launch'),
  };
}

/**
 * 2 — BRAKE. Accelerate to the entry speed, then brake 1.0 to a stop.
 *
 * ENTRY-SPEED PLATEAU (why `entryTargetMet` exists): the player's top speed is enforced by a
 * governor that fades engine force linearly to zero at `topSpeed` (vehicles/steering.ts
 * `throttleGovernor`), while linear damping grows with speed. The two balance BELOW the nominal
 * top speed — for the sedan's numbers the equilibrium sits near 93 %, so the plan's nominal
 * "≥95 % of top speed" entry is not always physically reachable. Rather than quietly redefining
 * the metric or waiting out a 12 s timeout on a speed that will never arrive, the accel phase
 * detects the plateau (BRAKE_PLATEAU_GAIN_MPS over BRAKE_PLATEAU_WINDOW_SEC), brakes from
 * whatever it reached, and reports `entrySpeedMps` next to `entryTargetMps` with
 * `entryTargetMet: false`. Below BRAKE_ENTRY_MIN_FRAC the result is `inconclusive` instead.
 */
async function runBrakeProbe(ctx: ProbeContext, run: ProbeRun): Promise<BrakeProbeResult> {
  markFeelPhase('probe:brake');
  const entryTargetMps = ctx.topSpeedMps * BRAKE_ENTRY_FRAC;
  const runway = makeRunway(
    ctx.corridor.lengthM,
    estimateStraightRunwayM(ctx.topSpeedMps, BRAKE_ACCEL_MAX_SEC + BRAKE_STOP_MAX_SEC),
    ctx.corridor.ribbonHalfWidthM,
    0,
  );
  const settled = await teleportAndSettle(ctx.corridor);
  let outcome: SegmentOutcome = { endedBy: 'done', interruption: null };
  if (runway.sufficient && settled) {
    // Accel phase — full throttle until the target OR the plateau.
    const plateau: { bestSpeed: number; bestAtSec: number } = { bestSpeed: 0, bestAtSec: 0 };
    outcome = await runSegment(run, {
      phase: 'brakeAccel',
      maxSec: BRAKE_ACCEL_MAX_SEC,
      openWith: FULL_THROTTLE_INPUT,
      step: (sample, segmentSec) => {
        if (sample.speedMps > plateau.bestSpeed + BRAKE_PLATEAU_GAIN_MPS) {
          plateau.bestSpeed = sample.speedMps;
          plateau.bestAtSec = segmentSec;
        }
        const plateaued = segmentSec - plateau.bestAtSec >= BRAKE_PLATEAU_WINDOW_SEC;
        return { input: FULL_THROTTLE_INPUT, done: sample.speedMps >= entryTargetMps || plateaued };
      },
    });
    if (!outcome.interruption) {
      outcome = await runSegment(run, {
        phase: 'brake',
        maxSec: BRAKE_STOP_MAX_SEC,
        openWith: BRAKE_INPUT,
        step: (sample) => ({ input: BRAKE_INPUT, done: sample.speedMps < BRAKE_STOP_SPEED_MPS }),
      });
    }
  }
  const metrics = brakeMetricsFrom(run.samples, 'brake', BRAKE_STOP_SPEED_MPS);
  const entryTargetMet = metrics.entrySpeedMps >= entryTargetMps;
  const usable =
    settled && metrics.stopped && metrics.entrySpeedMps >= ctx.topSpeedMps * BRAKE_ENTRY_MIN_FRAC;
  return {
    ...baseFields(
      ctx,
      'brake',
      run,
      runway,
      outcome.interruption,
      resolveProbeStatus({
        interruption: outcome.interruption,
        runwaySufficient: runway.sufficient,
        metricUsable: usable,
      }),
    ),
    kind: 'brake',
    entryTargetMps,
    entrySpeedMps: metrics.entrySpeedMps,
    entryTargetMet,
    brakeDistM: metrics.brakeDistM,
    brakeSec: metrics.brakeSec,
    stopped: metrics.stopped,
    speedTrace: speedTraceOf(run.samples, 'brake'),
  };
}

/** 3 — STEP-STEER. Hold a target speed, then apply full steer in ONE step and time the yaw-rate
 * peak. Steering RIGHT (+1) is arbitrary but fixed, so repeat runs are comparable. */
async function runStepSteerProbe(ctx: ProbeContext, run: ProbeRun): Promise<StepSteerProbeResult> {
  markFeelPhase('probe:stepSteer');
  const targetSpeedMps = ctx.topSpeedMps * STEP_STEER_SPEED_FRAC;
  const turn = estimateTurnRunway({
    speedMps: targetSpeedMps,
    topSpeedMps: ctx.topSpeedMps,
    wheelbaseM: ctx.wheelbaseM,
    maxAngleDeg: ctx.maxAngleDeg,
    highSpeedAngleDeg: ctx.highSpeedAngleDeg,
    latAccelCapMps2: RUNWAY_LAT_ACCEL_CAP_MPS2,
    windowSec: STEP_STEER_HOLD_SEC,
  });
  const runway = makeRunway(
    ctx.corridor.lengthM,
    estimateStraightRunwayM(ctx.topSpeedMps, STEP_STEER_APPROACH_MAX_SEC) + turn.longitudinalM,
    Math.max(0, ctx.corridor.clearHalfWidthM - CAR_LATERAL_MARGIN_M),
    turn.lateralM,
  );
  const settled = await teleportAndSettle(ctx.corridor);
  let outcome: SegmentOutcome = { endedBy: 'done', interruption: null };
  let entrySpeedMps = 0;
  if (runway.sufficient && settled) {
    outcome = await runSegment(run, {
      phase: 'stepApproach',
      maxSec: STEP_STEER_APPROACH_MAX_SEC,
      step: makeApproachStep(targetSpeedMps),
    });
    if (!outcome.interruption) {
      const approach = samplesInPhase(run.samples, 'stepApproach');
      entrySpeedMps = approach.length > 0 ? approach[approach.length - 1].speedMps : 0;
      outcome = await runSegment(run, {
        phase: 'step',
        maxSec: STEP_STEER_HOLD_SEC,
        openWith: holdSpeedInput(entrySpeedMps, targetSpeedMps, 1),
        // Throttle is held at the approach controller's value for the target speed so the step
        // measures STEERING response, not a simultaneous throttle-lift transient.
        step: (sample) => ({
          input: holdSpeedInput(sample.speedMps, targetSpeedMps, 1),
          done: false,
        }),
      });
    }
  }
  const peak = peakYawFrom(run.samples, 'step');
  return {
    ...baseFields(
      ctx,
      'stepSteer',
      run,
      runway,
      outcome.interruption,
      resolveProbeStatus({
        interruption: outcome.interruption,
        runwaySufficient: runway.sufficient,
        metricUsable: settled && peak.peakYawRateRadS !== null,
      }),
    ),
    kind: 'stepSteer',
    targetSpeedMps,
    entrySpeedMps,
    steerToPeakYawSec: peak.timeToPeakSec,
    peakYawRateRadS: peak.peakYawRateRadS,
    quantizationSec: peak.quantizationSec,
  };
}

/**
 * 4 — TURN RADIUS. Steady full lock at each of TURN_SPEEDS_MPS; the settled circle radius is
 * speed ÷ |yaw rate| averaged over a window that rejects the entry transient.
 *
 * Each speed point gets its OWN teleport back to the corridor start. Running them back-to-back
 * down one pass would make every point after the first depend on where the previous one left the
 * car (heading, lane, remaining road) — the exact non-determinism the teleport exists to kill.
 */
async function runTurnRadiusProbe(ctx: ProbeContext, run: ProbeRun): Promise<TurnRadiusProbeResult> {
  markFeelPhase('probe:turnRadius');
  const points: TurnRadiusPoint[] = [];
  const runways: ProbeRunway[] = [];
  let firstInterruption: ProbeInterruption | null = null;

  for (const targetSpeedMps of TURN_SPEEDS_MPS) {
    if (targetSpeedMps >= ctx.topSpeedMps) {
      // Physically unreachable for this car (the D-grade bus/streetcar top out at 19 m/s), so the
      // approach phase would burn its whole timeout to arrive at a speed the point is not about.
      // Reported as a skipped point rather than silently measured at whatever it managed.
      points.push({
        targetSpeedMps,
        status: 'inconclusive',
        insufficientRunway: false,
        runway: makeRunway(ctx.corridor.lengthM, 0, ctx.corridor.clearHalfWidthM, 0),
        interruption: null,
        measuredSpeedMps: null,
        yawRateRadS: null,
        radiusM: null,
        settledWindowSec: null,
        samplesInWindow: 0,
        note: `target ${targetSpeedMps} m/s is at or above this car's top speed ${ctx.topSpeedMps.toFixed(1)} m/s`,
      });
      continue;
    }
    const turn = estimateTurnRunway({
      speedMps: targetSpeedMps,
      topSpeedMps: ctx.topSpeedMps,
      wheelbaseM: ctx.wheelbaseM,
      maxAngleDeg: ctx.maxAngleDeg,
      highSpeedAngleDeg: ctx.highSpeedAngleDeg,
      latAccelCapMps2: RUNWAY_LAT_ACCEL_CAP_MPS2,
      windowSec: TURN_TRANSIENT_SEC + TURN_SETTLE_MIN_SEC,
    });
    // Lateral budget is measured from the CENTRELINE the probe starts on, so the car's own
    // half-width comes off the clear box before the manoeuvre may claim it.
    const availableLateralM = Math.max(0, ctx.corridor.clearHalfWidthM - CAR_LATERAL_MARGIN_M);
    const runway = makeRunway(
      ctx.corridor.lengthM,
      estimateStraightRunwayM(ctx.topSpeedMps, TURN_APPROACH_MAX_SEC) + turn.longitudinalM,
      availableLateralM,
      turn.lateralM,
    );
    runways.push(runway);
    const approachPhase = `turnApproach@${targetSpeedMps}`;
    const lockPhase = `turnLock@${targetSpeedMps}`;
    if (!runway.sufficient) {
      points.push({
        targetSpeedMps,
        status: 'insufficientRunway',
        insufficientRunway: true,
        runway,
        interruption: null,
        measuredSpeedMps: null,
        yawRateRadS: null,
        radiusM: null,
        settledWindowSec: null,
        samplesInWindow: 0,
        note:
          `full lock at ${targetSpeedMps} m/s needs ${turn.lateralM.toFixed(1)} m of lateral room ` +
          `over ${(TURN_TRANSIENT_SEC + TURN_SETTLE_MIN_SEC).toFixed(2)} s; the corridor offers ` +
          `${availableLateralM.toFixed(1)} m`,
      });
      continue;
    }
    const settled = await teleportAndSettle(ctx.corridor);
    let outcome: SegmentOutcome = { endedBy: 'done', interruption: null };
    if (settled) {
      outcome = await runSegment(run, {
        phase: approachPhase,
        maxSec: TURN_APPROACH_MAX_SEC,
        step: makeApproachStep(targetSpeedMps),
      });
      if (!outcome.interruption) {
        outcome = await runSegment(run, {
          phase: lockPhase,
          maxSec: TURN_HOLD_SEC,
          openWith: holdSpeedInput(targetSpeedMps, targetSpeedMps, 1),
          step: (sample) => ({
            input: holdSpeedInput(sample.speedMps, targetSpeedMps, 1),
            done: false,
          }),
        });
      }
    }
    const window = settledTurnWindow(run.samples, lockPhase, {
      rejectSec: TURN_TRANSIENT_SEC,
      minWindowSec: TURN_SETTLE_MIN_SEC,
      tolerance: TURN_SETTLE_TOLERANCE,
    });
    if (outcome.interruption && !firstInterruption) firstInterruption = outcome.interruption;
    points.push({
      targetSpeedMps,
      status: resolveProbeStatus({
        interruption: outcome.interruption,
        runwaySufficient: true,
        metricUsable: settled && window !== null,
      }),
      insufficientRunway: false,
      runway,
      interruption: outcome.interruption,
      measuredSpeedMps: window ? window.meanSpeedMps : null,
      yawRateRadS: window ? window.meanYawRateRadS : null,
      radiusM: window ? window.radiusM : null,
      settledWindowSec: window ? window.durationSec : null,
      samplesInWindow: window ? window.sampleCount : 0,
      note: noteForTurnPoint(settled, window, outcome),
    });
  }

  const aggregate = worstRunway(runways);
  const anyUsable = points.some((p) => p.radiusM !== null);
  return {
    ...baseFields(
      ctx,
      'turnRadius',
      run,
      aggregate,
      firstInterruption,
      resolveProbeStatus({
        interruption: firstInterruption,
        runwaySufficient: points.some((p) => !p.insufficientRunway),
        metricUsable: anyUsable,
      }),
    ),
    kind: 'turnRadius',
    points,
  };
}

/** Why a measured turn point is not `ok`, in the words a reader needs. Null when it is fine. */
function noteForTurnPoint(
  settled: boolean,
  window: SettledWindow | null,
  outcome: SegmentOutcome,
): string | null {
  if (outcome.interruption) return outcome.interruption.detail;
  if (!settled) return 'the chassis never came to rest at the start pose';
  if (!window) {
    return (
      'no settled window: the yaw rate or speed never held steady for ' +
      `${TURN_SETTLE_MIN_SEC}s after the ${TURN_TRANSIENT_SEC}s transient`
    );
  }
  return null;
}

/**
 * 5 — SLALOM / STABILITY. Alternating full lock at a held speed; reports roll/pitch peaks, flip
 * events and airtime. THIS is the probe that sizes the D8 monster-truck complaint: a tall,
 * high-CoM chassis reversed at SLALOM_HALF_PERIOD_SEC is what rolls, if anything does.
 *
 * A flip DOES interrupt the segment (the interruption detector's flip dwell fires), which is
 * correct: the trace after a roll is not a slalom any more. The event is still counted in the
 * metrics, and the interruption says why the run is short.
 */
async function runSlalomProbe(ctx: ProbeContext, run: ProbeRun): Promise<SlalomProbeResult> {
  markFeelPhase('probe:slalom');
  const targetSpeedMps = ctx.topSpeedMps * SLALOM_SPEED_FRAC;
  const swing = estimateTurnRunway({
    speedMps: targetSpeedMps,
    topSpeedMps: ctx.topSpeedMps,
    wheelbaseM: ctx.wheelbaseM,
    maxAngleDeg: ctx.maxAngleDeg,
    highSpeedAngleDeg: ctx.highSpeedAngleDeg,
    latAccelCapMps2: RUNWAY_LAT_ACCEL_CAP_MPS2,
    windowSec: SLALOM_HALF_PERIOD_SEC,
  });
  const runway = makeRunway(
    ctx.corridor.lengthM,
    estimateStraightRunwayM(ctx.topSpeedMps, SLALOM_APPROACH_MAX_SEC + SLALOM_SEC),
    Math.max(0, ctx.corridor.clearHalfWidthM - CAR_LATERAL_MARGIN_M),
    swing.lateralM,
  );
  const settled = await teleportAndSettle(ctx.corridor);
  let outcome: SegmentOutcome = { endedBy: 'done', interruption: null };
  let entrySpeedMps = 0;
  if (runway.sufficient && settled) {
    outcome = await runSegment(run, {
      phase: 'slalomApproach',
      maxSec: SLALOM_APPROACH_MAX_SEC,
      step: makeApproachStep(targetSpeedMps),
    });
    if (!outcome.interruption) {
      const approach = samplesInPhase(run.samples, 'slalomApproach');
      entrySpeedMps = approach.length > 0 ? approach[approach.length - 1].speedMps : 0;
      outcome = await runSegment(run, {
        phase: 'slalom',
        maxSec: SLALOM_SEC,
        openWith: holdSpeedInput(entrySpeedMps, targetSpeedMps, 1),
        step: (sample, segmentSec) => {
          // Square wave: full lock, sign flipping every half period. A square wave (not a sine)
          // because the complaint is about ABRUPT direction reversal, which is what a player
          // does with a keyboard — there is no analogue steering input in this game.
          const steer = Math.floor(segmentSec / SLALOM_HALF_PERIOD_SEC) % 2 === 0 ? 1 : -1;
          return {
            input: holdSpeedInput(sample.speedMps, targetSpeedMps, steer),
            done: false,
          };
        },
      });
    }
  }
  const stability = stabilityMetricsFrom(run.samples, 'slalom', FLIP_DWELL_SEC);
  return {
    ...baseFields(
      ctx,
      'slalom',
      run,
      runway,
      outcome.interruption,
      resolveProbeStatus({
        interruption: outcome.interruption,
        runwaySufficient: runway.sufficient,
        metricUsable: settled && stability.frames > 0,
      }),
    ),
    kind: 'slalom',
    targetSpeedMps,
    entrySpeedMps,
    halfPeriodSec: SLALOM_HALF_PERIOD_SEC,
    rollPeakRad: stability.rollPeakRad,
    pitchPeakRad: stability.pitchPeakRad,
    flipEvents: stability.flipEvents,
    airtimeFrac: stability.airtimeFrac,
    minSpeedMps: stability.minSpeedMps,
  };
}

// ============================================================================================
// Entry point
// ============================================================================================

export interface FeelProbeOptions {
  /** Which probes to run, in order. Default: all five. */
  readonly probes?: readonly ProbeKind[];
  /** Include the full per-frame trace on each result (large). Default false. */
  readonly includeSamples?: boolean;
}

const ALL_PROBES: readonly ProbeKind[] = ['launch', 'brake', 'stepSteer', 'turnRadius', 'slalom'];

let activeSuite: Promise<FeelProbeSuiteResult> | null = null;

/**
 * Run the controlled-manoeuvre probe suite once and resolve with its results.
 *
 * Idempotent while in flight — a second call returns the SAME promise rather than putting two
 * scripted drivers on one car (the contract ai/chaosBench.ts's startChaosBench and
 * ai/cameraLabDrive.ts's startCameraLabDrive both offer, for the same reason).
 */
export function startFeelProbes(opts?: FeelProbeOptions): Promise<FeelProbeSuiteResult> {
  if (activeSuite) return activeSuite;
  const run = runProbeSuiteOnce(opts ?? {}).finally(() => {
    activeSuite = null;
  });
  activeSuite = run;
  return run;
}

async function runProbeSuiteOnce(opts: FeelProbeOptions): Promise<FeelProbeSuiteResult> {
  // Readiness only — the handle is deliberately NOT retained; every probe re-reads the live ref
  // (see teleportAndSettle) so a mid-suite remount cannot leave the probes driving a dead model.
  await waitForDrivablePlayer();
  await waitForSteadyFrames();
  const corridor = resolveProbeCorridor();
  const car = getSelectedCarDef();
  const ctx: ProbeContext = {
    corridor,
    carId: car.id,
    topSpeedMps: car.topSpeed,
    // Wheelbase from the car's OWN resolved geometry (front axle to rear axle), never a literal.
    wheelbaseM: car.controller.wheels.frontZ - car.controller.wheels.rearZ,
    maxAngleDeg: car.controller.steering.maxAngleDeg,
    highSpeedAngleDeg: car.controller.steering.highSpeedAngleDeg,
    includeSamples: opts.includeSamples ?? false,
  };

  const restoreIsolation = applyIsolation();
  const results: ProbeResult[] = [];
  try {
    for (const kind of opts.probes ?? ALL_PROBES) {
      // One ProbeRun per probe: separate traces, separate contact lists, separate clocks. The
      // contact subscription is per-probe too, so a probe's `contacts` can only contain contacts
      // that happened during it.
      const run = newRun(corridor);
      const unsubscribe = onImpact((impact: ImpactRecord) => {
        const counterpartKind = counterpartKindOf(impact);
        const blocking = counterpartKind !== 'unknown' && HARD_CONTACT_KINDS.has(counterpartKind);
        const contact: ProbeContact = {
          atSec: (performance.now() - run.t0) / 1000,
          counterpartKind,
          forceMag: impact.forceMag,
          blocking,
        };
        run.contacts.push(contact);
        if (blocking) run.pendingHardContact = contact;
      });
      try {
        switch (kind) {
          case 'launch':
            results.push(await runLaunchProbe(ctx, run));
            break;
          case 'brake':
            results.push(await runBrakeProbe(ctx, run));
            break;
          case 'stepSteer':
            results.push(await runStepSteerProbe(ctx, run));
            break;
          case 'turnRadius':
            results.push(await runTurnRadiusProbe(ctx, run));
            break;
          case 'slalom':
            results.push(await runSlalomProbe(ctx, run));
            break;
        }
      } finally {
        unsubscribe();
      }
    }
  } finally {
    // Always hand the car back to the keyboard and put the world's switches back exactly as they
    // were — a lab tool that leaves the player's input overridden (or the city permanently
    // traffic-free) is a far worse bug than anything it exists to measure.
    setDrivingInputOverride(null);
    restoreIsolation();
    markFeelPhase('probe:done');
  }

  const suite: FeelProbeSuiteResult = {
    startedAtIso: new Date().toISOString(),
    carId: ctx.carId,
    topSpeedMps: ctx.topSpeedMps,
    corridor,
    isolation: PROBE_ISOLATION,
    results,
  };
  console.info(formatProbeSuiteReport(suite));
  return suite;
}
