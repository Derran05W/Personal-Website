// Phase 74 — THE FEEL TELEMETRY CORE. The instrument the whole feel overhaul (Parts 17-20,
// Phases 74-94) is judged against: it turns "Smashy Road still feels significantly better" from a
// sentence into a table of physical quantities that a later phase can be shown to have moved.
// Every number the Feel Spec (dev/feelSpec.ts) pins, and every number the battery
// (scripts/feel-lab.mjs) writes into results.json, is produced here.
//
// --- ZERO PROD BYTES, BY CONSTRUCTION (not by grep) ------------------------------------------
// Nothing outside src/game/dev/ is edited to make this work, so the production bundle is
// byte-identical because nothing in its import graph changed. Three existing seams make that
// possible, all of them module-scope reads that need no React context and no <Canvas> mount:
//   • vehicles/playerRef.ts    — `playerVehicle.current` is the live IVehicleModel.
//   • input/index.ts           — `getDrivingInput()` is the merged driving intent.
//   • combat/contacts.ts       — `onImpact()` is a documented, POLICY-FREE, order-independent
//                                subscription that returns an unsubscribe (contacts.ts:41-43).
//                                Adding a subscriber is prod-behaviour-neutral by contract.
// Sampling is therefore driven by this module's OWN requestAnimationFrame loop, started and
// stopped from core/debugBridge.ts (itself an `import.meta.env.DEV` dynamic import from
// game/index.tsx, so it never enters the prod chunk at all). The rejected alternative — a DEV
// `useFrame` inside world/toronto/TorontoScene.tsx, which is how P33's camera lab sampled — is
// the established pattern but would edit a prod file for no gain: rAF and r3f's loop share a
// frame cadence, and every value this sampler needs is already module-scope. Recorded here so a
// later session does not "fix" the harness by moving it into the scene.
//
// --- WHY EVERY METRIC IS A TIME INTEGRAL -----------------------------------------------------
// rAF sampling is frame-rate-coupled and headless fps in this container is unstable (~18 fps
// under SwiftShader, and it varies run to run). A frame COUNT therefore means nothing across
// runs, tiers or machines. So every metric below is either a time integral (seconds, metres,
// metres travelled per radian swept) or an instantaneous physical quantity (m/s, rad/s) — with
// exactly two deliberate exceptions, `steerClampFrac` and `airtimeFrac`, which are genuinely
// frame ratios and are ALWAYS reported next to their frame denominator (`cornering.frames`,
// `stability.frames`) so a reader can see what they were computed over.
//
// A frame whose real dt exceeds `maxDtSec` spans a main-thread stall (a shader compile, a GC
// pause, a tab that lost focus). Rapier catches up in a burst across such a gap, so the pose and
// velocity either side of it are not a measurement of anything: the sample is COUNTED
// (`timing.stalledSamples`) and then discarded from every integral, and any response timing in
// flight is abandoned with `endReason: 'stall'` rather than silently corrupted.
//
// --- SHAPE: PURE CORE + THIN LIVE SHELL ------------------------------------------------------
// Everything that computes anything is pure: `createFeelAccumulator` / `accumulateSample` /
// `accumulateImpact` / `summarizeFeel` operate on a plain mutable record with no module state,
// no three, no React, no Rapier — so feelTelemetry.test.ts drives them with synthetic sample
// streams and the metric math is verified exactly as it runs. The live shell at the bottom
// (start/stop/reset/read/markFeelPhase) only adapts `readState()` + `getDrivingInput()` into
// samples and `onImpact` records into impacts. `summarizeFeel` is READ-ONLY — it may be called
// mid-run as often as the panel likes, and it closes still-open events into the snapshot
// virtually (`endReason: 'open'`) without disturbing the accumulator.
//
// Snapshots are plain JSON (numbers, strings, arrays — no Maps, no functions), so
// `page.evaluate(() => window.__smashy.readFeelTelemetry())` round-trips them intact. Same
// contract world/toronto/cameraClipStats.ts established for the P33 battery.

import { SKID } from '../config/fx';
import { VEHICLE_TUNING } from '../config/vehicles';
import { onImpact } from '../combat/contacts';
import type { ImpactRecord } from '../combat/types';
import { computeLateralSlip, lateralSpeedAtYaw } from '../fx/skidMath';
import { getDrivingInput } from '../input';
import { getSelectedCarDef } from '../vehicles/definitions';
import { playerVehicle } from '../vehicles/playerRef';
import { steerClampRad, type SteerLimits } from '../vehicles/steering';
import type { EntityKind } from '../world/registry';

/** Snapshot schema tag — bumped if the shape changes, so an old results.json is never silently
 * compared against a new one by scripts/feel-lab-sheet.mjs. */
export const FEEL_TELEMETRY_SCHEMA = 'feel-telemetry/1';

const TAU = Math.PI * 2;

// =============================================================================================
// Tuning
// =============================================================================================

/**
 * Every threshold the detectors use, in ONE flat block so a test (or a probe that wants a
 * tighter gate) can override a single field with a plain spread. Flat rather than nested on
 * purpose: nesting would need a hand-written deep merge, and a hand-written deep merge is how an
 * override silently stops applying.
 *
 * These are dev-tool constants, not game tunables — they live here rather than in game/config/
 * for the same reason ai/chaosBench.ts and ai/cameraLabDrive.ts keep theirs local: this file only
 * ever ships inside the DEV-gated chunk, and putting measurement thresholds in the game's config
 * surface would imply they change the game. They do not.
 */
export interface FeelTelemetryTuning {
  /** A sampled frame longer than this spans a stall — see the header. 0.25 s ≈ 4.5 frames at the
   * measured headless cadence, so a normal hitch survives and a real stall does not. */
  readonly maxDtSec: number;

  // --- launch (time-to-speed) ---------------------------------------------------------------
  /** Throttle above this counts as "held". Desktop throttle is DIGITAL (exactly 0 or 1); the
   * epsilon exists for touch's analogue auto-throttle and for scripted probe ramps. */
  readonly launchThrottleMin: number;
  /** A launch only counts toward the headline t50/t90 if it started from (near) rest — a rolling
   * start would report a fictitious acceleration time. */
  readonly launchRestSpeedMps: number;
  /** A launch that has not reached 90 % of top speed in this long is abandoned (the car is
   * fighting something, or the route never offered a clear straight). */
  readonly launchTimeoutSec: number;
  /** Fractions of the car's RESOLVED top speed the two headline times are measured to. */
  readonly launchFrac50: number;
  readonly launchFrac90: number;

  // --- braking ------------------------------------------------------------------------------
  /** Brake input above this counts as a brake application. */
  readonly brakeInputMin: number;
  /** Planar speed at which a braking measurement ENDS. Derived, not picked: below
   * VEHICLE_TUNING.engine.brakeToReverseSpeed the brake pedal stops braking and becomes reverse
   * thrust (raycastVehicle.ts:271), so anything measured past it is reverse acceleration, not
   * stopping distance. Shared by all six cars (resolveControllerParams passes the base value
   * through untouched). */
  readonly brakeStopSpeedMps: number;
  /** A stop from at least this fraction of top speed is a QUALIFIED brake measurement (the Feel
   * Spec's row); slower stops are still recorded, and the snapshot always reports the start
   * speed the headline was actually measured from. */
  readonly brakeQualifyStartFrac: number;

  // --- steering response --------------------------------------------------------------------
  /** |steer| crossing this from below opens a steer-response window (a committed input, not a
   * lane-keeping nudge). */
  readonly steerEdgeInput: number;
  /** |steer| falling below this closes the window. */
  readonly steerReleaseInput: number;
  /** Hard ceiling on a response window — past this the peak is the corner, not the response. */
  readonly steerResponseWindowSec: number;

  // --- cornering ----------------------------------------------------------------------------
  /** Speed-bucket width for the yaw-rate curve and the per-bucket turn radius. */
  readonly bucketWidthMps: number;
  /** |steer| at or above this is "near full lock" — the condition for a turn-radius sample. */
  readonly steadySteerInput: number;
  /** Full lock must have been held this long (with a stable sign) before the arc counts, so the
   * turn-in TRANSIENT is excluded and only the settled circle is measured. */
  readonly steadySettleSec: number;
  /** Below this yaw rate the car is going essentially straight; including those samples would
   * inflate the arc-length numerator without adding swept angle. */
  readonly steadyMinYawRateRadS: number;
  /** A bucket needs this much settled arc time before its radius is reported at all (below it,
   * `turnRadiusM` is null — no evidence, rather than a confident wrong number). */
  readonly bucketMinSteadySec: number;

  // --- lateral slip -------------------------------------------------------------------------
  /** Slip gate + saturation, taken from the SHIPPED skid trigger (config/fx.ts SKID.slip) so the
   * measured "slip fraction" means the same thing the game's own drift trigger means. */
  readonly slipThresholdMps: number;
  readonly slipMaxMps: number;

  // --- steer clamp --------------------------------------------------------------------------
  /** Applied steer at or above this fraction of the speed-scaled clamp counts as clamped. */
  readonly steerClampAtLeastFrac: number;

  // --- contacts -----------------------------------------------------------------------------
  /** Repeat impacts against the SAME collider handle inside this window coalesce into one
   * contact EVENT. Rapier emits a contact-force record per pair per step, so a single crash into
   * one wall can produce a dozen records — the record count is kept (it is the honest raw
   * figure) but the event count is what "contacts per minute" should mean. */
  readonly contactDebounceSec: number;

  // --- stuck detector -----------------------------------------------------------------------
  /** Planar speed below which the car counts as immobile. */
  readonly stuckSpeedMps: number;
  /** Immobile-with-throttle-held for this long ⇒ a stuck event is declared. */
  readonly stuckEnterSec: number;
  /** Throttle at or above this counts as "the player is trying to move". */
  readonly stuckThrottleMin: number;
  /** Planar speed above which a declared stuck event has been escaped. Above `stuckSpeedMps` on
   * purpose: a hysteresis band, so a car jittering on a kerb does not open/close events. */
  readonly stuckRecoverSpeedMps: number;
  /** See isUnrecoverableStuck — applied to `recoverySec`, not `durationSec`. */
  readonly stuckUnrecoverableSec: number;
  /** Throttle released continuously for this long while stuck ⇒ the event is closed as
   * `abandoned` (the player stopped trying; keeping it open would charge idle time to the bug). */
  readonly stuckReleaseSec: number;
  /** How far BEFORE the immobile window began the cause classifier looks for an impact. */
  readonly stuckCauseLookbackSec: number;
  /** Chassis Y this far above the learned rest height (with wheels in contact) reads as "parked
   * on top of something". VEHICLE_TUNING.suspension.maxTravel is 0.25 m, so the whole legitimate
   * suspension band is ±0.25 and a kerb adds ~0.15 — 0.6 clears both with margin, while the
   * shallowest thing you can beach on (a pack car's bonnet) lifts the chassis appreciably more. */
  readonly stuckOnVehicleRiseM: number;
  /** The rest-height baseline only learns while the car is driving normally: all wheels down and
   * moving at least this fast. That is what keeps a car that is ALREADY perched on another car
   * from teaching the baseline its own bad height. */
  readonly restHeightMinSpeedMps: number;
  /** One-pole factor for the rest-height baseline (≈20 qualifying samples ≈ 1 s at the measured
   * headless cadence). Slow on purpose — it is a reference level, not a tracker. */
  readonly restHeightAlpha: number;

  // --- stability ----------------------------------------------------------------------------
  /** `upright === false` sustained this long is a flip (raycastVehicle.ts:341 defines upright as
   * the chassis up axis within ~60° of world up). Shorter excursions are big kerb hits. */
  readonly flipSustainSec: number;

  // --- bounds -------------------------------------------------------------------------------
  /** Per-array cap on recorded events. The EARLIEST are kept (deterministic) and the overflow is
   * counted into `timing.droppedEvents` + surfaced in `notes`, so a truncated array can never be
   * mistaken for a clean run. */
  readonly maxEvents: number;
  /** Impact ring length for cause tagging. Eviction drops the OLDEST, and the classifier is
   * newest-wins, so eviction can only ever discard entries the classifier would not have used. */
  readonly maxRecentImpacts: number;
}

export const FEEL_TELEMETRY_DEFAULTS: FeelTelemetryTuning = {
  maxDtSec: 0.25,

  launchThrottleMin: 0.05,
  launchRestSpeedMps: 0.5,
  launchTimeoutSec: 20,
  launchFrac50: 0.5,
  launchFrac90: 0.9,

  brakeInputMin: 0.5,
  brakeStopSpeedMps: VEHICLE_TUNING.engine.brakeToReverseSpeed,
  brakeQualifyStartFrac: 0.95,

  steerEdgeInput: 0.5,
  steerReleaseInput: 0.2,
  steerResponseWindowSec: 3,

  bucketWidthMps: 2.5,
  steadySteerInput: 0.9,
  steadySettleSec: 0.6,
  steadyMinYawRateRadS: 0.05,
  bucketMinSteadySec: 0.5,

  slipThresholdMps: SKID.slip.thresholdMps,
  slipMaxMps: SKID.slip.maxMps,

  steerClampAtLeastFrac: 0.99,

  contactDebounceSec: 0.25,

  stuckSpeedMps: 0.5,
  stuckEnterSec: 1.5,
  stuckThrottleMin: 0.1,
  stuckRecoverSpeedMps: 1.0,
  stuckUnrecoverableSec: 1.0,
  stuckReleaseSec: 0.5,
  stuckCauseLookbackSec: 2.0,
  stuckOnVehicleRiseM: 0.6,
  restHeightMinSpeedMps: 3,
  restHeightAlpha: 0.05,

  flipSustainSec: 0.5,

  maxEvents: 200,
  maxRecentImpacts: 64,
};

/** Merge a partial override over the defaults (flat, so a plain spread is the whole merge). */
export function resolveFeelTuning(overrides?: Partial<FeelTelemetryTuning>): FeelTelemetryTuning {
  return overrides ? { ...FEEL_TELEMETRY_DEFAULTS, ...overrides } : FEEL_TELEMETRY_DEFAULTS;
}

// =============================================================================================
// Car parameters
// =============================================================================================

/** The car-derived constants every response/cornering metric is normalised against. Resolved
 * ONCE per measured session (a car change forces a player remount, so it cannot change mid-run)
 * and echoed into the snapshot, because "t90 = 2.4 s" is meaningless without knowing which car
 * and what its top speed was. */
export interface FeelCarParams {
  readonly id: string;
  readonly name: string;
  /** The car's RESOLVED top speed (config/carTuning.ts SPEED_TOP_SPEED_MPS via the SPEED grade).
   * Never the hardcoded STARTER_TOP_SPEED — five of the six cars are not 25 m/s. */
  readonly topSpeedMps: number;
  /** The steer clamp's own limits, so `steerClampFrac` is measured against the same curve
   * vehicles/steering.ts applies. */
  readonly steering: SteerLimits;
  readonly massFactor: number;
  readonly hp: number;
}

/** Live read of the selected car (state/store.ts selectedCarId → vehicles/definitions.ts). */
export function resolveFeelCarParams(): FeelCarParams {
  const def = getSelectedCarDef();
  return {
    id: def.id,
    name: def.name,
    topSpeedMps: def.topSpeed,
    steering: {
      maxAngleDeg: def.controller.steering.maxAngleDeg,
      highSpeedAngleDeg: def.controller.steering.highSpeedAngleDeg,
    },
    massFactor: def.massFactor,
    hp: def.hp,
  };
}

// =============================================================================================
// Pure math
// =============================================================================================

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Chassis orientation, decomposed the way this project's conventions expect. */
export interface ChassisAngles {
  /** Heading about world +Y, `atan2(forward.x, forward.z)` — the +Z-forward convention every
   * steering/skid/hitscan module in this codebase uses (fx/skidMath.ts's lateralSpeedAtYaw takes
   * exactly this). */
  readonly yawRad: number;
  /** asin(forward.y) — positive = nose up. */
  readonly pitchRad: number;
  /** asin(right.y) — positive = the chassis's RIGHT side is the raised one. */
  readonly rollRad: number;
  /** The chassis up axis's world-Y component. `upright` in VehicleState is exactly `> 0.5`
   * (raycastVehicle.ts:341); carried here so the relationship is visible, not re-derived. */
  readonly upDotY: number;
}

/**
 * Quaternion → yaw/pitch/roll, by rotating the three chassis-local basis vectors directly.
 * Deliberately NOT reusing ai/chaosBench.ts's `yawFromQuaternion`: that goes through three's
 * Quaternion/Vector3 and lives in a module that also pulls r3f-perf and the world ref, which
 * would drag the whole render stack into this file's unit tests for four multiplications. The
 * yaw convention is identical (verified against chaosBench's FORWARD_LOCAL = (0,0,1)).
 */
export function chassisAnglesFromQuat(q: {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
}): ChassisAngles {
  const { x, y, z, w } = q;
  // Rotate (0,0,1), (1,0,0) and (0,1,0) by q — the standard quaternion-to-matrix columns.
  const fwdX = 2 * (x * z + w * y);
  const fwdY = 2 * (y * z - w * x);
  const fwdZ = 1 - 2 * (x * x + y * y);
  const rightY = 2 * (x * y + w * z);
  const upY = 1 - 2 * (x * x + z * z);
  return {
    yawRad: Math.atan2(fwdX, fwdZ),
    pitchRad: Math.asin(clamp(fwdY, -1, 1)),
    rollRad: Math.asin(clamp(rightY, -1, 1)),
    upDotY: upY,
  };
}

/** Signed shortest angular difference `to − from`, wrapped to (−π, π]. Without the wrap, a car
 * crossing the ±π seam registers a ~2π yaw step and fabricates a ~110 rad/s "peak yaw rate". */
export function angleDeltaRad(fromRad: number, toRad: number): number {
  let d = (toRad - fromRad) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d <= -Math.PI) d += TAU;
  return d;
}

/** Yaw rate (rad/s) from two headings and the REAL elapsed time between them. `prevYawRad` null
 * (first sample after a start/teleport/car-less frame) or a non-positive dt yields 0 rather than
 * a divide-by-zero spike. */
export function yawRateRadS(prevYawRad: number | null, yawRad: number, dtSec: number): number {
  if (prevYawRad === null || dtSec <= 0) return 0;
  return angleDeltaRad(prevYawRad, yawRad) / dtSec;
}

/** Index of the speed bucket a reading falls in (negative speeds clamp into bucket 0). */
export function speedBucketIndex(speedMps: number, bucketWidthMps: number): number {
  if (bucketWidthMps <= 0) return 0;
  return Math.max(0, Math.floor(speedMps / bucketWidthMps));
}

/**
 * Turn radius from an ARC, not from a per-sample `v / |ω|`. R = (path length) / (angle swept) is
 * the exact definition for a circular arc, and integrating both terms over the settled window
 * before dividing is the only estimator that behaves: a mean of per-sample `v/|ω|` is dominated
 * by the samples where ω is nearly zero (each one contributes a near-infinite radius), so a
 * single straight-ish frame inside a corner can move the "average radius" by hundreds of metres.
 * Returns null when nothing was swept — no evidence, rather than a division by ~0.
 */
export function turnRadiusFromArc(arcLenM: number, sweptRad: number): number | null {
  if (sweptRad <= 0) return null;
  return arcLenM / sweptRad;
}

/** Count → per-minute rate over a measured window (0 when the window is empty). */
export function perMinute(count: number, elapsedSec: number): number {
  if (elapsedSec <= 0) return 0;
  return (count * 60) / elapsedSec;
}

/**
 * Rest-height baseline: a slow one-pole average of chassis Y over samples where the car is
 * DRIVING NORMALLY — all wheels down and above `restHeightMinSpeedMps`. Returns `prev` unchanged
 * for any sample that does not qualify, which is the whole point: a car beached on another car
 * (wheels in contact, but stationary) must never teach the baseline its own bad height.
 * `null` in / no qualifying sample yet ⇒ `null` out; the first qualifying sample seeds it.
 */
export function updateRestHeightBaseline(
  prev: number | null,
  sample: {
    readonly chassisY: number;
    readonly wheelsInContact: number;
    readonly wheelCount: number;
    readonly planarSpeedMps: number;
  },
  tuning: Pick<FeelTelemetryTuning, 'restHeightMinSpeedMps' | 'restHeightAlpha'>,
): number | null {
  const grounded = sample.wheelCount > 0 && sample.wheelsInContact >= sample.wheelCount;
  if (!grounded || sample.planarSpeedMps < tuning.restHeightMinSpeedMps) return prev;
  if (prev === null) return sample.chassisY;
  return prev + (sample.chassisY - prev) * clamp(tuning.restHeightAlpha, 0, 1);
}

// =============================================================================================
// Contacts: kinds and the stuck-cause heuristic
// =============================================================================================

/** A counterpart kind, plus the honest `unknown` bucket for a collider with no registry entry
 * (contacts.ts dispatches those too — the spine never filters). */
export type FeelContactKind = EntityKind | 'unknown';

/** Fixed emit order for the per-kind contact table, so two results.json files diff cleanly.
 * Typed as a total Record over FeelContactKind: adding an EntityKind to world/registry.ts fails
 * THIS file's typecheck until the new kind is given an order and a cause mapping below. */
const CONTACT_KIND_ORDER: Record<FeelContactKind, number> = {
  player: 0,
  pursuit: 1,
  civilian: 2,
  propStatic: 3,
  propDynamic: 4,
  building: 5,
  barrier: 6,
  transformer: 7,
  projectile: 8,
  ground: 9,
  water: 10,
  unknown: 11,
};

export const FEEL_CONTACT_KINDS: readonly FeelContactKind[] = (
  Object.keys(CONTACT_KIND_ORDER) as FeelContactKind[]
).sort((a, b) => CONTACT_KIND_ORDER[a] - CONTACT_KIND_ORDER[b]);

/** Why the car could not move. */
export type FeelStuckCause = 'onVehicle' | 'vehicleWedge' | 'building' | 'scenery' | 'unknown';

export const FEEL_STUCK_CAUSES: readonly FeelStuckCause[] = [
  'onVehicle',
  'vehicleWedge',
  'building',
  'scenery',
  'unknown',
];

/**
 * Counterpart kind → cause. `null` = not informative about being stuck (the player's own
 * collider, a bullet passing through, the ground plane, the water sensor) — the classifier skips
 * those and keeps looking further back rather than tagging `unknown` on the strength of them.
 * Transformers are power boxes standing on the pavement, so they are scenery.
 */
const CAUSE_BY_CONTACT_KIND: Record<FeelContactKind, FeelStuckCause | null> = {
  player: null,
  pursuit: 'vehicleWedge',
  civilian: 'vehicleWedge',
  propStatic: 'scenery',
  propDynamic: 'scenery',
  building: 'building',
  barrier: 'scenery',
  transformer: 'scenery',
  projectile: null,
  ground: null,
  water: null,
  unknown: null,
};

/** One remembered impact, as the cause classifier sees it. */
export interface FeelImpactMark {
  readonly tSec: number;
  readonly kind: FeelContactKind;
}

export interface StuckCauseContext {
  /** Chassis centre Y at the moment the event was declared. */
  readonly chassisY: number;
  /** The learned rest height, or null if the car never drove normally this session. */
  readonly restHeightY: number | null;
  readonly wheelsInContact: number;
  /** Remembered impacts in ASCENDING time order (the accumulator's ring keeps them that way). */
  readonly impacts: readonly FeelImpactMark[];
  /** Inclusive window the classifier may consider — normally
   * [immobile-window start − stuckCauseLookbackSec, declaration time]. */
  readonly windowStartSec: number;
  readonly windowEndSec: number;
  readonly onVehicleRiseM: number;
}

/**
 * *** THIS IS A HEURISTIC, AND HERE IS EXACTLY WHY A BETTER ONE IS IMPOSSIBLE TODAY. ***
 *
 * The obvious implementation — "look at where the car was touched" — cannot be written:
 * `ImpactRecord.point` is ALWAYS absent on the live path. @react-three/rapier's
 * ContactForceEvent exposes no contact point at all, so combat/contacts.ts's
 * `dispatchContactForce` deliberately omits the field (contacts.ts:117-119); the optional
 * property exists only for a hypothetical future producer. There is therefore no geometry
 * available to distinguish "wedged against the front bumper" from "riding on the roof of the
 * thing I hit", and nothing short of adding our own raycasts (a prod-file edit, which this
 * phase forbids) would produce one.
 *
 * So the cause is inferred from two signals that ARE available:
 *
 *   1. GEOMETRY, and it wins outright: if the chassis is resting `onVehicleRiseM` above its own
 *      learned rest height WITH wheels in contact, the car is parked on top of something. This
 *      takes precedence over the impact history because climbing onto a car necessarily also
 *      produced vehicle impacts — history alone would call every beaching a `vehicleWedge`, and
 *      "I am stuck ON a car" is precisely the distinct complaint Phase 77 is chartered to fix.
 *   2. HISTORY, newest-informative-first inside the lookback window. The last thing the car hit
 *      before it stopped moving is the best available proxy for what stopped it.
 *
 * Anything else is `unknown`, and `unknown` is reported honestly rather than being folded into
 * the nearest plausible bucket. A `cause` tag is a triage hint for the P77 work, never evidence.
 */
export function classifyStuckCause(ctx: StuckCauseContext): FeelStuckCause {
  if (
    ctx.restHeightY !== null &&
    ctx.wheelsInContact > 0 &&
    ctx.chassisY > ctx.restHeightY + ctx.onVehicleRiseM
  ) {
    return 'onVehicle';
  }
  for (let i = ctx.impacts.length - 1; i >= 0; i--) {
    const mark = ctx.impacts[i];
    if (mark.tSec > ctx.windowEndSec) continue;
    if (mark.tSec < ctx.windowStartSec) break; // ascending order ⇒ everything earlier is older
    const cause = CAUSE_BY_CONTACT_KIND[mark.kind];
    if (cause !== null) return cause;
  }
  return 'unknown';
}

/**
 * Resolve which side of an impact is NOT the player, and what it was. Only the player's
 * RigidBody carries `onContactForce` (contacts.ts's header), so in practice `a` is the player
 * and `b` is the struck thing — but the record is resolved defensively, because a later phase
 * attaching a second producer must not silently make every contact read as `player`.
 */
export function counterpartOf(record: {
  readonly aHandle: number;
  readonly bHandle: number;
  readonly a?: { readonly kind: EntityKind } | undefined;
  readonly b?: { readonly kind: EntityKind } | undefined;
}): { readonly handle: number; readonly kind: FeelContactKind } {
  if (record.a?.kind === 'player') return { handle: record.bHandle, kind: record.b?.kind ?? 'unknown' };
  if (record.b?.kind === 'player') return { handle: record.aHandle, kind: record.a?.kind ?? 'unknown' };
  // Neither side resolved as the player: fall back to side B, which is `payload.other` (the
  // struck collider) on the live path.
  return { handle: record.bHandle, kind: record.b?.kind ?? record.a?.kind ?? 'unknown' };
}

// =============================================================================================
// Samples
// =============================================================================================

/** The subset of IVehicleModel's VehicleState this harness reads. Declared structurally rather
 * than importing VehicleState so a test can build one as a literal — and because `readState()`
 * hands back a REUSED, mutated-in-place object, everything here is copied into the sample below
 * before the next frame overwrites it. */
export interface FeelVehicleReading {
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
  readonly rotation: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly w: number;
  };
  readonly velocity: { readonly x: number; readonly y: number; readonly z: number };
  /** |velocity| in 3D — the value raycastVehicle.ts feeds `steerClampRad`, so the clamp fraction
   * is measured against the same curve the controller applied. */
  readonly speedMps: number;
  readonly forwardSpeedMps: number;
  readonly upright: boolean;
  readonly wheels: readonly { readonly steerAngle: number; readonly inContact: boolean }[];
}

/** Driving intent, copied out of `getDrivingInput()` (also a reused, mutated object). */
export interface FeelInputReading {
  readonly steer: number;
  readonly throttle: number;
  readonly brake: number;
  readonly handbrake: boolean;
}

/** One fully-derived sampled frame. Everything downstream reads only this. */
export interface FeelSample {
  /** Seconds since the measured session started. */
  readonly tSec: number;
  /** REAL elapsed time since the previous sample (unclamped — the accumulator decides what to do
   * with a stall; clamping here would fabricate a 4× yaw rate across one). */
  readonly dtSec: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yawRad: number;
  readonly pitchRad: number;
  readonly rollRad: number;
  readonly yawRateRadS: number;
  readonly speedMps: number;
  readonly planarSpeedMps: number;
  readonly forwardSpeedMps: number;
  /** Signed sideways speed in the chassis frame (fx/skidMath.ts's lateralSpeedAtYaw). */
  readonly lateralSpeedMps: number;
  readonly upright: boolean;
  readonly wheelsInContact: number;
  readonly wheelCount: number;
  /** |applied front-wheel steer| (rad) — the rate-limited angle the controller actually set. */
  readonly appliedSteerRad: number;
  /** The speed-scaled clamp at this speed (vehicles/steering.ts's steerClampRad). */
  readonly steerClampLimitRad: number;
  readonly steerInput: number;
  readonly throttle: number;
  readonly brake: number;
  readonly handbrake: boolean;
}

/** Build one sample from a live (or synthetic) reading. Pure. */
export function buildFeelSample(args: {
  readonly tSec: number;
  readonly dtSec: number;
  readonly prevYawRad: number | null;
  readonly vehicle: FeelVehicleReading;
  readonly input: FeelInputReading;
  readonly car: FeelCarParams;
}): FeelSample {
  const { tSec, dtSec, prevYawRad, vehicle, input, car } = args;
  const angles = chassisAnglesFromQuat(vehicle.rotation);
  const planarSpeedMps = Math.hypot(vehicle.velocity.x, vehicle.velocity.z);
  let appliedSteerRad = 0;
  let wheelsInContact = 0;
  for (const wheel of vehicle.wheels) {
    const mag = Math.abs(wheel.steerAngle);
    if (mag > appliedSteerRad) appliedSteerRad = mag;
    if (wheel.inContact) wheelsInContact++;
  }
  return {
    tSec,
    dtSec,
    x: vehicle.position.x,
    y: vehicle.position.y,
    z: vehicle.position.z,
    yawRad: angles.yawRad,
    pitchRad: angles.pitchRad,
    rollRad: angles.rollRad,
    yawRateRadS: yawRateRadS(prevYawRad, angles.yawRad, dtSec),
    speedMps: vehicle.speedMps,
    planarSpeedMps,
    forwardSpeedMps: vehicle.forwardSpeedMps,
    lateralSpeedMps: lateralSpeedAtYaw(vehicle.velocity.x, vehicle.velocity.z, angles.yawRad),
    upright: vehicle.upright,
    wheelsInContact,
    wheelCount: vehicle.wheels.length,
    appliedSteerRad,
    steerClampLimitRad: steerClampRad(vehicle.speedMps, car.topSpeedMps, car.steering),
    steerInput: input.steer,
    throttle: input.throttle,
    brake: input.brake,
    handbrake: input.handbrake,
  };
}

/** One impact, as the accumulator consumes it. */
export interface FeelImpactSample {
  readonly tSec: number;
  /** The counterpart's collider handle — the debounce key for coalescing records into events. */
  readonly handle: number;
  readonly kind: FeelContactKind;
  readonly forceMagN: number;
}

// =============================================================================================
// Recorded events
// =============================================================================================

export type FeelWindowEndReason =
  | 'reached90'
  | 'stopped'
  | 'released'
  | 'braked'
  | 'timeout'
  | 'stall'
  | 'teleport'
  | 'open';

export interface FeelLaunchEvent {
  readonly startSec: number;
  readonly startSpeedMps: number;
  readonly t50Sec: number | null;
  readonly t90Sec: number | null;
  readonly endReason: FeelWindowEndReason;
}

export interface FeelBrakeEvent {
  readonly startSec: number;
  readonly startSpeedMps: number;
  readonly distM: number;
  readonly durationSec: number;
  readonly endReason: FeelWindowEndReason;
}

export interface FeelSteerResponseEvent {
  readonly startSec: number;
  readonly speedAtEdgeMps: number;
  readonly timeToPeakSec: number;
  readonly peakYawRateRadS: number;
  readonly endReason: FeelWindowEndReason;
}

export interface FeelStuckEvent {
  /** When the car first went immobile with throttle held. */
  readonly startSec: number;
  /** `startSec + stuckEnterSec` — when the event was DECLARED. */
  readonly triggeredSec: number;
  readonly endSec: number;
  /** endSec − startSec: total time immobilised, dwell included. */
  readonly durationSec: number;
  /** endSec − triggeredSec: time spent stuck AFTER the detector declared it. This is the number
   * the gate keys off (see isUnrecoverableStuck). */
  readonly recoverySec: number;
  readonly cause: FeelStuckCause;
  readonly recovered: boolean;
  readonly endReason: 'recovered' | 'abandoned' | 'open';
  /** Where it happened — so the battery can screenshot the spot. */
  readonly x: number;
  readonly z: number;
}

export interface FeelFlipEvent {
  readonly startSec: number;
  readonly durationSec: number;
  readonly resolved: boolean;
}

export interface FeelPhaseMark {
  readonly label: string;
  readonly tSec: number;
  /** Cumulative counters AT the mark, so a consumer can diff two marks for the coarse totals.
   * Every recorded EVENT also carries its own `tSec`, so per-phase event slicing needs nothing
   * more than these timestamps. */
  readonly distanceM: number;
  readonly contactRecords: number;
  readonly stuckCount: number;
}

/**
 * The Phase 74 gate's definition of an UNRECOVERABLE stuck event.
 *
 * JUDGEMENT CALL, recorded here because the plan's Decision 1 is ambiguous and the literal
 * reading is degenerate. Decision 1 sets `STUCK.unrecoverableSec = 1.0` "over the detector's own
 * STUCK.enterSec = 1.5 dwell" and the task brief paraphrases it as `durationSec > 1.0`. But
 * `durationSec` is measured from the START of the immobile window, and the detector will not
 * declare an event until 1.5 s of that window have already elapsed — so EVERY event has
 * `durationSec ≥ 1.5 > 1.0` and the literal test would classify all of them as unrecoverable,
 * making the gate meaningless.
 *
 * The reading that matches both the words ("over the 1.5 s dwell") and the intent ("a car
 * briefly hung on a kerb is a real, readable event; an unrecoverable one is the bug") applies
 * the threshold to `recoverySec` — time still stuck AFTER the 1.5 s dwell. An event that never
 * resolved at all is unrecoverable regardless. Both `durationSec` and `recoverySec` are recorded
 * on every event, so a reader who prefers the other reading can recompute it for free.
 */
export function isUnrecoverableStuck(event: FeelStuckEvent, unrecoverableSec: number): boolean {
  return !event.recovered || event.recoverySec > unrecoverableSec;
}

// =============================================================================================
// Accumulator
// =============================================================================================

interface BucketAcc {
  timeSec: number;
  speedTimeSum: number;
  yawTimeSum: number;
  steadyTimeSec: number;
  steadyArcM: number;
  steadySweptRad: number;
}

interface KindAcc {
  records: number;
  events: number;
  forceSum: number;
  forceMax: number;
  speedLossSum: number;
  speedLossFrames: number;
}

interface OpenLaunch {
  startSec: number;
  startSpeedMps: number;
  t50Sec: number | null;
}

interface OpenBrake {
  startSec: number;
  startSpeedMps: number;
  distM: number;
}

interface OpenSteer {
  startSec: number;
  speedAtEdgeMps: number;
  peakYawRateRadS: number;
  peakAtSec: number;
}

interface OpenStuck {
  startSec: number;
  triggeredSec: number;
  cause: FeelStuckCause;
  x: number;
  z: number;
  releasedSec: number;
}

/**
 * The whole measured state. A plain mutable record with no module identity — the live shell owns
 * one, but a probe module (Phase 74 T2/T3) or a test can own as many as it likes. Exported
 * because those consumers need the type; treat the fields as internal.
 */
export interface FeelAccumulator {
  readonly tuning: FeelTelemetryTuning;
  readonly car: FeelCarParams;

  samples: number;
  stalledSamples: number;
  teleportSkips: number;
  droppedEvents: number;
  elapsedSec: number;
  dtMinSec: number;
  dtMaxSec: number;
  distanceM: number;
  lastSample: FeelSample | null;

  launchOpen: OpenLaunch | null;
  launches: FeelLaunchEvent[];
  brakeOpen: OpenBrake | null;
  brakes: FeelBrakeEvent[];
  steerOpen: OpenSteer | null;
  steerResponses: FeelSteerResponseEvent[];

  buckets: BucketAcc[];
  steerHeldSec: number;
  steerHeldSign: number;
  slipSec: number;
  slip01TimeSum: number;
  steerClampFrames: number;

  byKind: Map<FeelContactKind, KindAcc>;
  pendingImpacts: FeelImpactSample[];
  recentImpacts: FeelImpactMark[];
  lastContactAtByHandle: Map<number, number>;
  contactRecords: number;
  contactEvents: number;
  contactFrames: number;
  speedLossSum: number;
  speedLossMax: number;

  restHeightY: number | null;
  slowSinceSec: number | null;
  stuckOpen: OpenStuck | null;
  stuckEvents: FeelStuckEvent[];

  airborneSec: number;
  airborneFrames: number;
  rollPeakRad: number;
  pitchPeakRad: number;
  flipOpenSinceSec: number | null;
  flipCounted: boolean;
  flipEvents: FeelFlipEvent[];

  phases: FeelPhaseMark[];
}

export function createFeelAccumulator(
  car: FeelCarParams,
  tuning: FeelTelemetryTuning = FEEL_TELEMETRY_DEFAULTS,
): FeelAccumulator {
  return {
    tuning,
    car,
    samples: 0,
    stalledSamples: 0,
    teleportSkips: 0,
    droppedEvents: 0,
    elapsedSec: 0,
    dtMinSec: Infinity,
    dtMaxSec: 0,
    distanceM: 0,
    lastSample: null,
    launchOpen: null,
    launches: [],
    brakeOpen: null,
    brakes: [],
    steerOpen: null,
    steerResponses: [],
    buckets: [],
    steerHeldSec: 0,
    steerHeldSign: 0,
    slipSec: 0,
    slip01TimeSum: 0,
    steerClampFrames: 0,
    byKind: new Map(),
    pendingImpacts: [],
    recentImpacts: [],
    lastContactAtByHandle: new Map(),
    contactRecords: 0,
    contactEvents: 0,
    contactFrames: 0,
    speedLossSum: 0,
    speedLossMax: 0,
    restHeightY: null,
    slowSinceSec: null,
    stuckOpen: null,
    stuckEvents: [],
    airborneSec: 0,
    airborneFrames: 0,
    rollPeakRad: 0,
    pitchPeakRad: 0,
    flipOpenSinceSec: null,
    flipCounted: false,
    flipEvents: [],
    phases: [],
  };
}

/** Push with the maxEvents cap — earliest kept, overflow counted (see the tuning field). */
function pushCapped<T>(acc: FeelAccumulator, list: T[], event: T): void {
  if (list.length >= acc.tuning.maxEvents) {
    acc.droppedEvents++;
    return;
  }
  list.push(event);
}

function kindAcc(acc: FeelAccumulator, kind: FeelContactKind): KindAcc {
  let entry = acc.byKind.get(kind);
  if (!entry) {
    entry = { records: 0, events: 0, forceSum: 0, forceMax: 0, speedLossSum: 0, speedLossFrames: 0 };
    acc.byKind.set(kind, entry);
  }
  return entry;
}

/** Ceiling on the speed-bucket array. 40 buckets × the default 2.5 m/s = 100 m/s, four times the
 * fastest car — anything above lands in the top bucket rather than allocating an array indexed by
 * a physics explosion. */
const MAX_SPEED_BUCKETS = 40;

function bucketAcc(acc: FeelAccumulator, rawIndex: number): BucketAcc {
  const index = Math.min(rawIndex, MAX_SPEED_BUCKETS - 1);
  while (acc.buckets.length <= index) {
    acc.buckets.push({
      timeSec: 0,
      speedTimeSum: 0,
      yawTimeSum: 0,
      steadyTimeSec: 0,
      steadyArcM: 0,
      steadySweptRad: 0,
    });
  }
  return acc.buckets[index];
}

/**
 * Record one impact. Called synchronously from the contact spine's drain (i.e. between rAF
 * samples), so it carries its own timestamp rather than assuming the last sample's.
 */
export function accumulateImpact(acc: FeelAccumulator, impact: FeelImpactSample): void {
  const entry = kindAcc(acc, impact.kind);
  entry.records++;
  entry.forceSum += impact.forceMagN;
  if (impact.forceMagN > entry.forceMax) entry.forceMax = impact.forceMagN;
  acc.contactRecords++;

  // Coalesce repeat records against the same collider into one contact EVENT.
  const last = acc.lastContactAtByHandle.get(impact.handle);
  if (last === undefined || impact.tSec - last >= acc.tuning.contactDebounceSec) {
    entry.events++;
    acc.contactEvents++;
  }
  acc.lastContactAtByHandle.set(impact.handle, impact.tSec);
  // The debounce map would otherwise grow with every distinct collider a long route drive ever
  // touches. Prune anything that can no longer debounce anything.
  if (acc.lastContactAtByHandle.size > 512) {
    const cutoff = impact.tSec - acc.tuning.contactDebounceSec;
    for (const [handle, at] of acc.lastContactAtByHandle) {
      if (at < cutoff) acc.lastContactAtByHandle.delete(handle);
    }
  }

  acc.pendingImpacts.push(impact);
  acc.recentImpacts.push({ tSec: impact.tSec, kind: impact.kind });
  if (acc.recentImpacts.length > acc.tuning.maxRecentImpacts) acc.recentImpacts.shift();
}

/**
 * Fold one sampled frame in. THE order of operations matters only in that every sub-detector
 * reads `acc.lastSample` as "the previous frame" before it is replaced at the very end.
 */
export function accumulateSample(acc: FeelAccumulator, sample: FeelSample): void {
  const t = acc.tuning;
  const prev = acc.lastSample;

  // --- stall gate ---------------------------------------------------------------------------
  // A frame that spans a stall is not a measurement (see the file header). Count it, abandon any
  // response timing in flight, re-baseline `lastSample` so the NEXT frame's deltas are not taken
  // across the gap — and integrate nothing. Pending impacts are dropped from speed-loss
  // attribution for the same reason (their frame's speed delta is meaningless) but they remain
  // counted in the contact totals, which are honest counts, not integrals.
  if (sample.dtSec > t.maxDtSec || sample.dtSec <= 0) {
    acc.stalledSamples++;
    closeLaunch(acc, 'stall');
    closeBrake(acc, 'stall', 0);
    closeSteer(acc, 'stall');
    acc.pendingImpacts.length = 0;
    acc.lastSample = sample;
    return;
  }

  const dt = sample.dtSec;
  acc.samples++;
  acc.elapsedSec += dt;
  if (dt < acc.dtMinSec) acc.dtMinSec = dt;
  if (dt > acc.dtMaxSec) acc.dtMaxSec = dt;

  // --- travelled distance (with a teleport guard) --------------------------------------------
  // Probes and the dev reset key teleport the car; without a guard a single teleport would add
  // hundreds of metres to `distanceM` and to any open brake measurement. The guard is derived
  // per-frame rather than fixed: nothing legitimate can cover more than twice top speed in one
  // frame (+1 m of slack for the very first frame after a settle).
  let stepM = 0;
  let teleported = false;
  if (prev) {
    const raw = Math.hypot(sample.x - prev.x, sample.z - prev.z);
    const maxStepM = dt * acc.car.topSpeedMps * 2 + 1;
    if (raw <= maxStepM) {
      stepM = raw;
      acc.distanceM += raw;
    } else {
      teleported = true;
      acc.teleportSkips++;
    }
  }
  if (teleported) {
    closeLaunch(acc, 'teleport');
    closeBrake(acc, 'teleport', 0);
    closeSteer(acc, 'teleport');
  }

  // --- contacts: attribute this frame's speed delta ------------------------------------------
  // The impacts drained since the previous sample all landed inside THIS frame, so the frame's
  // planar-speed delta is the whole speed cost of them collectively. It is attributed ONCE, to
  // the frame, and tagged with the kind of the highest-force record in it — attributing the same
  // delta to each record would multiply-count a single crash (Rapier emits one record per pair
  // per step, and a crash into a corner produces several).
  if (acc.pendingImpacts.length > 0) {
    if (prev) {
      let dominant = acc.pendingImpacts[0];
      for (const impact of acc.pendingImpacts) {
        if (impact.forceMagN > dominant.forceMagN) dominant = impact;
      }
      const loss = prev.planarSpeedMps - sample.planarSpeedMps;
      acc.contactFrames++;
      acc.speedLossSum += loss;
      if (loss > acc.speedLossMax) acc.speedLossMax = loss;
      const entry = kindAcc(acc, dominant.kind);
      entry.speedLossSum += loss;
      entry.speedLossFrames++;
    }
    acc.pendingImpacts.length = 0;
  }

  // --- response: launch ----------------------------------------------------------------------
  const throttleOn = sample.throttle > t.launchThrottleMin;
  const prevThrottleOn = prev ? prev.throttle > t.launchThrottleMin : false;
  if (throttleOn && !prevThrottleOn) {
    closeLaunch(acc, 'released');
    acc.launchOpen = {
      startSec: sample.tSec,
      startSpeedMps: Math.max(0, sample.forwardSpeedMps),
      t50Sec: null,
    };
  }
  const launch = acc.launchOpen;
  if (launch) {
    if (!throttleOn) {
      closeLaunch(acc, 'released');
    } else if (sample.brake > t.brakeInputMin) {
      closeLaunch(acc, 'braked');
    } else if (sample.tSec - launch.startSec > t.launchTimeoutSec) {
      closeLaunch(acc, 'timeout');
    } else {
      // Measured on FORWARD speed: it is the axis the governor caps (steering.ts's
      // throttleGovernor), so 90 % of top speed means 90 % of what the car can actually hold.
      if (launch.t50Sec === null && sample.forwardSpeedMps >= t.launchFrac50 * acc.car.topSpeedMps) {
        launch.t50Sec = sample.tSec - launch.startSec;
      }
      if (sample.forwardSpeedMps >= t.launchFrac90 * acc.car.topSpeedMps) {
        closeLaunch(acc, 'reached90', sample.tSec - launch.startSec);
      }
    }
  }

  // --- response: braking ----------------------------------------------------------------------
  const brakeOn = sample.brake > t.brakeInputMin;
  const prevBrakeOn = prev ? prev.brake > t.brakeInputMin : false;
  if (brakeOn && !prevBrakeOn) {
    closeBrake(acc, 'released', 0);
    acc.brakeOpen = {
      startSec: sample.tSec,
      // The speed BEFORE the pedal went down — this frame has already been braking.
      startSpeedMps: prev ? prev.planarSpeedMps : sample.planarSpeedMps,
      distM: 0,
    };
  }
  const brakeWindow = acc.brakeOpen;
  if (brakeWindow) {
    // Includes the edge frame's own step: the pedal went down somewhere inside [prev, now] and
    // the sampler cannot see where, so the longer (conservative) reading is taken. That is the
    // ±1-frame quantization `timing.maxDtSec` exists to declare.
    brakeWindow.distM += stepM;
    if (sample.planarSpeedMps < t.brakeStopSpeedMps) {
      closeBrake(acc, 'stopped', sample.tSec);
    } else if (!brakeOn) {
      closeBrake(acc, 'released', sample.tSec);
    }
  }

  // --- response: steer → peak yaw rate --------------------------------------------------------
  const steerMag = Math.abs(sample.steerInput);
  const prevSteerMag = prev ? Math.abs(prev.steerInput) : 0;
  if (steerMag >= t.steerEdgeInput && prevSteerMag < t.steerEdgeInput) {
    closeSteer(acc, 'released');
    acc.steerOpen = {
      startSec: sample.tSec,
      speedAtEdgeMps: sample.planarSpeedMps,
      peakYawRateRadS: Math.abs(sample.yawRateRadS),
      peakAtSec: sample.tSec,
    };
  }
  const steerWindow = acc.steerOpen;
  if (steerWindow) {
    const windowYawMag = Math.abs(sample.yawRateRadS);
    if (windowYawMag > steerWindow.peakYawRateRadS) {
      steerWindow.peakYawRateRadS = windowYawMag;
      steerWindow.peakAtSec = sample.tSec;
    }
    if (steerMag < t.steerReleaseInput) {
      closeSteer(acc, 'released');
    } else if (sample.tSec - steerWindow.startSec > t.steerResponseWindowSec) {
      closeSteer(acc, 'timeout');
    }
  }

  // --- cornering ------------------------------------------------------------------------------
  // Full-lock hold time, sign-aware: a slalom that snaps +1 → −1 without passing through centre
  // is a NEW corner, and its turn-in transient must not be counted as settled arc.
  const steerSign = sample.steerInput > 0 ? 1 : sample.steerInput < 0 ? -1 : 0;
  if (steerMag >= t.steadySteerInput && (acc.steerHeldSign === 0 || acc.steerHeldSign === steerSign)) {
    acc.steerHeldSec += dt;
  } else {
    acc.steerHeldSec = steerMag >= t.steadySteerInput ? dt : 0;
  }
  acc.steerHeldSign = steerMag >= t.steadySteerInput ? steerSign : 0;

  const bucket = bucketAcc(acc, speedBucketIndex(sample.planarSpeedMps, t.bucketWidthMps));
  const yawMag = Math.abs(sample.yawRateRadS);
  bucket.timeSec += dt;
  bucket.speedTimeSum += sample.planarSpeedMps * dt;
  bucket.yawTimeSum += yawMag * dt;
  // `steerHeldSec - dt` is the hold time at the START of this frame's slice: a slice is only
  // counted once the ENTIRE slice sits past the settle window. Testing the post-increment value
  // instead would fold the last transient slice into the steady arc.
  const settled =
    steerMag >= t.steadySteerInput &&
    acc.steerHeldSec - dt >= t.steadySettleSec &&
    sample.wheelsInContact > 0 &&
    yawMag >= t.steadyMinYawRateRadS;
  if (settled) {
    bucket.steadyTimeSec += dt;
    // Arc length from v·dt, not from the chord between poses: at the measured headless cadence a
    // hard corner turns ~15° per frame, whose chord is visibly shorter than its arc.
    bucket.steadyArcM += sample.planarSpeedMps * dt;
    bucket.steadySweptRad += yawMag * dt;
  }

  // --- lateral slip ---------------------------------------------------------------------------
  // The shipped trigger (fx/skidMath.ts) ORs the handbrake in; here it is passed as false on
  // purpose, so the measurement is of SLIDE, not of a held button. No low-pass either: the
  // shipped smoothSlip alpha is a per-frame constant and would therefore mean something different
  // at 18 fps than at 60, whereas a time-weighted fraction of the raw reading integrates the same
  // either way.
  const slip = computeLateralSlip(sample.lateralSpeedMps, false, t.slipThresholdMps, t.slipMaxMps);
  if (slip.slipping) acc.slipSec += dt;
  acc.slip01TimeSum += slip.slip01 * dt;

  // --- steer clamp (frame ratio #1 — always reported with `frames`) ---------------------------
  if (
    sample.steerClampLimitRad > 0 &&
    sample.appliedSteerRad >= sample.steerClampLimitRad * t.steerClampAtLeastFrac
  ) {
    acc.steerClampFrames++;
  }

  // --- rest height + stuck --------------------------------------------------------------------
  acc.restHeightY = updateRestHeightBaseline(
    acc.restHeightY,
    {
      chassisY: sample.y,
      wheelsInContact: sample.wheelsInContact,
      wheelCount: sample.wheelCount,
      planarSpeedMps: sample.planarSpeedMps,
    },
    t,
  );
  updateStuck(acc, sample, dt);

  // --- airtime + stability (frame ratio #2 — always reported with `frames`) --------------------
  if (sample.wheelsInContact === 0) {
    acc.airborneSec += dt;
    acc.airborneFrames++;
  }
  const rollMag = Math.abs(sample.rollRad);
  const pitchMag = Math.abs(sample.pitchRad);
  if (rollMag > acc.rollPeakRad) acc.rollPeakRad = rollMag;
  if (pitchMag > acc.pitchPeakRad) acc.pitchPeakRad = pitchMag;
  if (!sample.upright) {
    if (acc.flipOpenSinceSec === null) acc.flipOpenSinceSec = sample.tSec - dt;
    if (!acc.flipCounted && sample.tSec - acc.flipOpenSinceSec > t.flipSustainSec) {
      acc.flipCounted = true;
    }
  } else {
    if (acc.flipCounted && acc.flipOpenSinceSec !== null) {
      pushCapped(acc, acc.flipEvents, {
        startSec: acc.flipOpenSinceSec,
        durationSec: sample.tSec - acc.flipOpenSinceSec,
        resolved: true,
      });
    }
    acc.flipOpenSinceSec = null;
    acc.flipCounted = false;
  }

  acc.lastSample = sample;
}

function closeLaunch(acc: FeelAccumulator, reason: FeelWindowEndReason, t90Sec?: number): void {
  const open = acc.launchOpen;
  if (!open) return;
  pushCapped(acc, acc.launches, {
    startSec: open.startSec,
    startSpeedMps: open.startSpeedMps,
    t50Sec: open.t50Sec,
    t90Sec: t90Sec ?? null,
    endReason: reason,
  });
  acc.launchOpen = null;
}

function closeBrake(acc: FeelAccumulator, reason: FeelWindowEndReason, endSec: number): void {
  const open = acc.brakeOpen;
  if (!open) return;
  pushCapped(acc, acc.brakes, {
    startSec: open.startSec,
    startSpeedMps: open.startSpeedMps,
    distM: open.distM,
    durationSec: endSec > 0 ? endSec - open.startSec : 0,
    endReason: reason,
  });
  acc.brakeOpen = null;
}

function closeSteer(acc: FeelAccumulator, reason: FeelWindowEndReason): void {
  const open = acc.steerOpen;
  if (!open) return;
  pushCapped(acc, acc.steerResponses, {
    startSec: open.startSec,
    speedAtEdgeMps: open.speedAtEdgeMps,
    timeToPeakSec: open.peakAtSec - open.startSec,
    peakYawRateRadS: open.peakYawRateRadS,
    endReason: reason,
  });
  acc.steerOpen = null;
}

/**
 * The stuck state machine — the phase's most important output, and Phase 77's oracle.
 *
 *   ENTER  planar speed < stuckSpeedMps, throttle held, sustained > stuckEnterSec.
 *   EXIT   planar speed > stuckRecoverSpeedMps ('recovered'), or the throttle released for
 *          stuckReleaseSec ('abandoned' — the player gave up; charging their idle time to the
 *          bug would inflate every duration).
 *
 * KNOWN LIMITATION, stated rather than papered over: only THROTTLE counts as trying. In this
 * game a brake press below brakeToReverseSpeed is reverse (raycastVehicle.ts:271), so a player
 * who rocks out of a wedge purely on reverse is not detected as stuck. That is the plan's
 * definition and Phase 77's gate is written against it; widening it later would silently move
 * the baseline every later phase is compared to.
 */
function updateStuck(acc: FeelAccumulator, sample: FeelSample, dt: number): void {
  const t = acc.tuning;
  const throttleHeld = sample.throttle >= t.stuckThrottleMin;
  const immobile = sample.planarSpeedMps < t.stuckSpeedMps;
  const open = acc.stuckOpen;

  if (!open) {
    if (immobile && throttleHeld) {
      // The window began at the START of this frame's slice, not at its end.
      if (acc.slowSinceSec === null) acc.slowSinceSec = sample.tSec - dt;
      if (sample.tSec - acc.slowSinceSec >= t.stuckEnterSec) {
        const startSec = acc.slowSinceSec;
        acc.stuckOpen = {
          startSec,
          triggeredSec: sample.tSec,
          // Classified at DECLARATION, over a window that reaches back before the immobile
          // period began: the impact that wedged the car happened before it stopped moving, and
          // anything after declaration is the car grinding against whatever it is already stuck
          // on (or its own escape attempt), which is not evidence of the cause.
          cause: classifyStuckCause({
            chassisY: sample.y,
            restHeightY: acc.restHeightY,
            wheelsInContact: sample.wheelsInContact,
            impacts: acc.recentImpacts,
            windowStartSec: startSec - t.stuckCauseLookbackSec,
            windowEndSec: sample.tSec,
            onVehicleRiseM: t.stuckOnVehicleRiseM,
          }),
          x: sample.x,
          z: sample.z,
          releasedSec: 0,
        };
        acc.slowSinceSec = null;
      }
    } else {
      acc.slowSinceSec = null;
    }
    return;
  }

  if (sample.planarSpeedMps > t.stuckRecoverSpeedMps) {
    pushStuck(acc, open, sample.tSec, 'recovered');
    return;
  }
  open.releasedSec = throttleHeld ? 0 : open.releasedSec + dt;
  if (open.releasedSec >= t.stuckReleaseSec) {
    pushStuck(acc, open, sample.tSec, 'abandoned');
  }
}

function pushStuck(
  acc: FeelAccumulator,
  open: OpenStuck,
  endSec: number,
  endReason: 'recovered' | 'abandoned',
): void {
  pushCapped(acc, acc.stuckEvents, {
    startSec: open.startSec,
    triggeredSec: open.triggeredSec,
    endSec,
    durationSec: endSec - open.startSec,
    recoverySec: endSec - open.triggeredSec,
    cause: open.cause,
    recovered: endReason === 'recovered',
    endReason,
    x: open.x,
    z: open.z,
  });
  acc.stuckOpen = null;
  acc.slowSinceSec = null;
}

/** Record a labelled point in the session. Events all carry `tSec`, so a consumer slices any
 * metric by phase from these timestamps alone; the cumulative counters are the convenience. */
export function markFeelPhaseOn(acc: FeelAccumulator, label: string): void {
  pushCapped(acc, acc.phases, {
    label,
    tSec: acc.lastSample?.tSec ?? 0,
    distanceM: acc.distanceM,
    contactRecords: acc.contactRecords,
    stuckCount: acc.stuckEvents.length + (acc.stuckOpen ? 1 : 0),
  });
}

// =============================================================================================
// Snapshot
// =============================================================================================

export interface FeelSpeedBucket {
  readonly index: number;
  readonly speedLoMps: number;
  readonly speedHiMps: number;
  readonly timeSec: number;
  readonly meanSpeedMps: number;
  /** Time-weighted mean |yaw rate| over EVERY sample in the bucket — the yaw-rate-vs-speed
   * curve. */
  readonly meanYawRateRadS: number;
  /** Time spent in a settled full-lock arc inside this bucket. */
  readonly steadyTimeSec: number;
  /** Steady-state turn radius (m) = arc length ÷ swept angle over those settled samples. Null
   * until `bucketMinSteadySec` of evidence exists. */
  readonly turnRadiusM: number | null;
}

/** One row of the per-counterpart contact table. Only kinds actually contacted get a row — an
 * absent kind means zero. */
export interface FeelKindContacts {
  readonly kind: FeelContactKind;
  readonly records: number;
  readonly events: number;
  readonly eventsPerMin: number;
  readonly meanForceMagN: number;
  readonly maxForceMagN: number;
  /** Mean planar-speed delta over the contact FRAMES this kind dominated (positive = the car
   * lost speed). */
  readonly meanSpeedLossMps: number;
}

export interface FeelTelemetrySnapshot {
  readonly schema: string;
  readonly running: boolean;
  readonly car: FeelCarParams;
  readonly timing: {
    readonly samples: number;
    readonly stalledSamples: number;
    readonly teleportSkips: number;
    readonly droppedEvents: number;
    /** Integrated sample time — NOT wall clock. A backgrounded tab stops rAF and stops physics
     * together, so integrating dt is the honest measured window. */
    readonly elapsedSec: number;
    readonly meanDtSec: number;
    readonly minDtSec: number;
    /** The quantization band on every time-to-X metric: nothing here resolves finer than one
     * frame, so a battery reporting `t90 = 1.60 s` should say `± maxDtSec`. */
    readonly maxDtSec: number;
    readonly distanceM: number;
  };
  readonly response: {
    readonly t50Sec: number | null;
    readonly t90Sec: number | null;
    readonly launchCount: number;
    readonly qualifiedLaunchCount: number;
    readonly brakeDistM: number | null;
    readonly brakeSec: number | null;
    readonly brakeStartSpeedMps: number | null;
    /** True when the reported brake figures came from a stop at ≥ `brakeQualifyStartFrac` of top
     * speed. False = the best stop available was slower, and the numbers are reported anyway
     * with the speed they were measured from. */
    readonly brakeQualified: boolean;
    readonly brakeCount: number;
    readonly steerToPeakYawSec: number | null;
    readonly peakYawRateRadS: number | null;
    readonly steerResponseCount: number;
    readonly launches: readonly FeelLaunchEvent[];
    readonly brakes: readonly FeelBrakeEvent[];
    readonly steerResponses: readonly FeelSteerResponseEvent[];
  };
  readonly cornering: {
    readonly bucketWidthMps: number;
    readonly buckets: readonly FeelSpeedBucket[];
    /** Fraction of measured TIME the car was sliding sideways past the shipped skid threshold. */
    readonly lateralSlipFrac: number;
    readonly slipSec: number;
    readonly meanSlip01: number;
    /** FRAME ratio (one of the two exceptions) — reported with `frames` below. */
    readonly steerClampFrac: number;
    readonly steerClampFrames: number;
    readonly frames: number;
  };
  readonly contact: {
    readonly records: number;
    readonly events: number;
    readonly eventsPerMin: number;
    readonly recordsPerMin: number;
    readonly byKind: readonly FeelKindContacts[];
    readonly contactFrames: number;
    readonly meanSpeedLossMps: number;
    readonly maxSpeedLossMps: number;
  };
  readonly stuck: {
    readonly count: number;
    /** The GATE number (Phase 74 Decision 1) — see isUnrecoverableStuck for the definition and
     * why it keys off `recoverySec`. */
    readonly unrecoverableCount: number;
    readonly totalStuckSec: number;
    readonly longestSec: number;
    readonly byCause: readonly { readonly cause: FeelStuckCause; readonly count: number }[];
    readonly events: readonly FeelStuckEvent[];
    /** The learned chassis rest height the `onVehicle` tag was judged against (null = the car
     * never drove normally, so that tag could not fire at all this session). */
    readonly restHeightY: number | null;
  };
  readonly stability: {
    /** FRAME ratio (the second exception) — reported with `frames`. */
    readonly airtimeFrac: number;
    readonly airtimeSec: number;
    readonly airborneFrames: number;
    readonly frames: number;
    readonly rollPeakRad: number;
    readonly pitchPeakRad: number;
    readonly flipCount: number;
    readonly flipEvents: readonly FeelFlipEvent[];
  };
  readonly phases: readonly FeelPhaseMark[];
  /** Caveats emitted WITH the data, so a reader of results.json cannot miss them. */
  readonly notes: readonly string[];
}

/**
 * Read-only summary. Open windows are closed VIRTUALLY (`endReason: 'open'`, `resolved: false`)
 * so a mid-run read is complete and honest without disturbing the run — call it as often as the
 * dev panel likes.
 */
export function summarizeFeel(acc: FeelAccumulator, running = false): FeelTelemetrySnapshot {
  const t = acc.tuning;
  const endSec = acc.lastSample?.tSec ?? 0;

  const launches: FeelLaunchEvent[] = acc.launches.slice();
  if (acc.launchOpen) {
    launches.push({
      startSec: acc.launchOpen.startSec,
      startSpeedMps: acc.launchOpen.startSpeedMps,
      t50Sec: acc.launchOpen.t50Sec,
      t90Sec: null,
      endReason: 'open',
    });
  }
  const brakes: FeelBrakeEvent[] = acc.brakes.slice();
  if (acc.brakeOpen) {
    brakes.push({
      startSec: acc.brakeOpen.startSec,
      startSpeedMps: acc.brakeOpen.startSpeedMps,
      distM: acc.brakeOpen.distM,
      durationSec: endSec - acc.brakeOpen.startSec,
      endReason: 'open',
    });
  }
  const steerResponses: FeelSteerResponseEvent[] = acc.steerResponses.slice();
  if (acc.steerOpen) {
    steerResponses.push({
      startSec: acc.steerOpen.startSec,
      speedAtEdgeMps: acc.steerOpen.speedAtEdgeMps,
      timeToPeakSec: acc.steerOpen.peakAtSec - acc.steerOpen.startSec,
      peakYawRateRadS: acc.steerOpen.peakYawRateRadS,
      endReason: 'open',
    });
  }
  const stuckEvents: FeelStuckEvent[] = acc.stuckEvents.slice();
  if (acc.stuckOpen) {
    stuckEvents.push({
      startSec: acc.stuckOpen.startSec,
      triggeredSec: acc.stuckOpen.triggeredSec,
      endSec,
      durationSec: endSec - acc.stuckOpen.startSec,
      recoverySec: endSec - acc.stuckOpen.triggeredSec,
      cause: acc.stuckOpen.cause,
      recovered: false,
      endReason: 'open',
      x: acc.stuckOpen.x,
      z: acc.stuckOpen.z,
    });
  }
  const flipEvents: FeelFlipEvent[] = acc.flipEvents.slice();
  if (acc.flipCounted && acc.flipOpenSinceSec !== null) {
    flipEvents.push({
      startSec: acc.flipOpenSinceSec,
      durationSec: endSec - acc.flipOpenSinceSec,
      resolved: false,
    });
  }

  // --- headline response picks ---------------------------------------------------------------
  // "Best observed capability", not a mean: a route drive fires dozens of launches, most of them
  // into traffic. The qualification filters (from rest / stopped / a real peak) do the honest
  // work, and the full event arrays ride along so the battery can take medians across runs.
  const qualifiedLaunches = launches.filter((l) => l.startSpeedMps < t.launchRestSpeedMps);
  const t50Sec = minOf(qualifiedLaunches.map((l) => l.t50Sec));
  const t90Sec = minOf(qualifiedLaunches.map((l) => l.t90Sec));
  const stops = brakes.filter((b) => b.endReason === 'stopped');
  let bestStop: FeelBrakeEvent | null = null;
  for (const stop of stops) {
    if (!bestStop || stop.startSpeedMps > bestStop.startSpeedMps) bestStop = stop;
  }
  let bestSteer: FeelSteerResponseEvent | null = null;
  for (const response of steerResponses) {
    if (response.peakYawRateRadS <= 0) continue;
    if (!bestSteer || response.peakYawRateRadS > bestSteer.peakYawRateRadS) bestSteer = response;
  }

  // --- cornering ------------------------------------------------------------------------------
  const buckets: FeelSpeedBucket[] = acc.buckets.map((b, index) => ({
    index,
    speedLoMps: index * t.bucketWidthMps,
    speedHiMps: (index + 1) * t.bucketWidthMps,
    timeSec: b.timeSec,
    meanSpeedMps: b.timeSec > 0 ? b.speedTimeSum / b.timeSec : 0,
    meanYawRateRadS: b.timeSec > 0 ? b.yawTimeSum / b.timeSec : 0,
    steadyTimeSec: b.steadyTimeSec,
    turnRadiusM:
      b.steadyTimeSec >= t.bucketMinSteadySec ? turnRadiusFromArc(b.steadyArcM, b.steadySweptRad) : null,
  }));

  // --- contacts -------------------------------------------------------------------------------
  // Only kinds actually contacted get a row (an absent kind means zero) — a table of nine
  // all-zero rows is noise in results.json and in every console digest built from it. The order
  // is FEEL_CONTACT_KINDS' fixed one, so two runs still diff row-for-row.
  const byKind: FeelKindContacts[] = [];
  for (const kind of FEEL_CONTACT_KINDS) {
    const entry = acc.byKind.get(kind);
    if (!entry || entry.records === 0) continue;
    byKind.push({
      kind,
      records: entry.records,
      events: entry.events,
      eventsPerMin: perMinute(entry.events, acc.elapsedSec),
      meanForceMagN: entry.forceSum / entry.records,
      maxForceMagN: entry.forceMax,
      meanSpeedLossMps: entry.speedLossFrames > 0 ? entry.speedLossSum / entry.speedLossFrames : 0,
    });
  }

  // --- stuck ----------------------------------------------------------------------------------
  let totalStuckSec = 0;
  let longestSec = 0;
  let unrecoverableCount = 0;
  const causeCounts = new Map<FeelStuckCause, number>();
  for (const event of stuckEvents) {
    totalStuckSec += event.durationSec;
    if (event.durationSec > longestSec) longestSec = event.durationSec;
    if (isUnrecoverableStuck(event, t.stuckUnrecoverableSec)) unrecoverableCount++;
    causeCounts.set(event.cause, (causeCounts.get(event.cause) ?? 0) + 1);
  }

  const notes: string[] = [];
  if (acc.samples === 0) {
    notes.push(
      'no samples were recorded — the sampler ran without a live player vehicle, or was never started',
    );
  }
  if (acc.stalledSamples > 0) {
    notes.push(
      `${acc.stalledSamples} sample(s) spanned a >${t.maxDtSec}s main-thread stall and were excluded ` +
        'from every integral; response windows in flight were abandoned (endReason "stall")',
    );
  }
  if (acc.teleportSkips > 0) {
    notes.push(
      `${acc.teleportSkips} teleport(s) detected (probe reset / respawn): the jump is excluded from ` +
        'distance and abandons any brake measurement in flight',
    );
  }
  if (acc.droppedEvents > 0) {
    notes.push(
      `${acc.droppedEvents} event(s) dropped at the ${t.maxEvents}-per-array cap — the arrays are ` +
        'truncated to the EARLIEST events; the counters above them are complete',
    );
  }
  if (acc.restHeightY === null && stuckEvents.length > 0) {
    notes.push(
      'no chassis rest height was learned (the car never drove normally), so the "onVehicle" stuck ' +
        'cause could not fire — those events fall back to impact history',
    );
  }

  return {
    schema: FEEL_TELEMETRY_SCHEMA,
    running,
    car: acc.car,
    timing: {
      samples: acc.samples,
      stalledSamples: acc.stalledSamples,
      teleportSkips: acc.teleportSkips,
      droppedEvents: acc.droppedEvents,
      elapsedSec: acc.elapsedSec,
      meanDtSec: acc.samples > 0 ? acc.elapsedSec / acc.samples : 0,
      minDtSec: Number.isFinite(acc.dtMinSec) ? acc.dtMinSec : 0,
      maxDtSec: acc.dtMaxSec,
      distanceM: acc.distanceM,
    },
    response: {
      t50Sec,
      t90Sec,
      launchCount: launches.length,
      qualifiedLaunchCount: qualifiedLaunches.length,
      brakeDistM: bestStop ? bestStop.distM : null,
      brakeSec: bestStop ? bestStop.durationSec : null,
      brakeStartSpeedMps: bestStop ? bestStop.startSpeedMps : null,
      brakeQualified:
        bestStop !== null && bestStop.startSpeedMps >= t.brakeQualifyStartFrac * acc.car.topSpeedMps,
      brakeCount: brakes.length,
      steerToPeakYawSec: bestSteer ? bestSteer.timeToPeakSec : null,
      peakYawRateRadS: bestSteer ? bestSteer.peakYawRateRadS : null,
      steerResponseCount: steerResponses.length,
      launches,
      brakes,
      steerResponses,
    },
    cornering: {
      bucketWidthMps: t.bucketWidthMps,
      buckets,
      lateralSlipFrac: acc.elapsedSec > 0 ? acc.slipSec / acc.elapsedSec : 0,
      slipSec: acc.slipSec,
      meanSlip01: acc.elapsedSec > 0 ? acc.slip01TimeSum / acc.elapsedSec : 0,
      steerClampFrac: acc.samples > 0 ? acc.steerClampFrames / acc.samples : 0,
      steerClampFrames: acc.steerClampFrames,
      frames: acc.samples,
    },
    contact: {
      records: acc.contactRecords,
      events: acc.contactEvents,
      eventsPerMin: perMinute(acc.contactEvents, acc.elapsedSec),
      recordsPerMin: perMinute(acc.contactRecords, acc.elapsedSec),
      byKind,
      contactFrames: acc.contactFrames,
      meanSpeedLossMps: acc.contactFrames > 0 ? acc.speedLossSum / acc.contactFrames : 0,
      maxSpeedLossMps: acc.speedLossMax,
    },
    stuck: {
      count: stuckEvents.length,
      unrecoverableCount,
      totalStuckSec,
      longestSec,
      // Observed causes only, in FEEL_STUCK_CAUSES order (same rule as `byKind` above).
      byCause: FEEL_STUCK_CAUSES.filter((cause) => causeCounts.has(cause)).map((cause) => ({
        cause,
        count: causeCounts.get(cause) ?? 0,
      })),
      events: stuckEvents,
      restHeightY: acc.restHeightY,
    },
    stability: {
      airtimeFrac: acc.samples > 0 ? acc.airborneFrames / acc.samples : 0,
      airtimeSec: acc.airborneSec,
      airborneFrames: acc.airborneFrames,
      frames: acc.samples,
      rollPeakRad: acc.rollPeakRad,
      pitchPeakRad: acc.pitchPeakRad,
      flipCount: flipEvents.length,
      flipEvents,
    },
    phases: acc.phases.slice(),
    notes,
  };
}

/** Smallest non-null value, or null when every entry is null/empty. */
function minOf(values: readonly (number | null)[]): number | null {
  let best: number | null = null;
  for (const value of values) {
    if (value === null) continue;
    if (best === null || value < best) best = value;
  }
  return best;
}

/** The turn radius measured in whichever bucket contains `speedMps` (null = no evidence there).
 * Convenience for the Feel Spec's `turnRadius @ 10 m/s`-style rows. */
export function turnRadiusAtSpeedM(snapshot: FeelTelemetrySnapshot, speedMps: number): number | null {
  const index = speedBucketIndex(speedMps, snapshot.cornering.bucketWidthMps);
  return snapshot.cornering.buckets[index]?.turnRadiusM ?? null;
}

// =============================================================================================
// Live shell (rAF sampler + contact subscription)
// =============================================================================================

export interface FeelTelemetryOptions {
  /** Threshold overrides (flat — see FeelTelemetryTuning). */
  readonly tuning?: Partial<FeelTelemetryTuning>;
  /** Car parameters override. Defaults to the live selected car; a probe measuring a car it just
   * switched to can pass its own rather than wait for the store to settle. */
  readonly car?: FeelCarParams;
}

let accumulator: FeelAccumulator | null = null;
let rafHandle: number | null = null;
let unsubscribeImpacts: (() => void) | null = null;
let sessionStartMs = 0;
let lastFrameMs = 0;
let prevYawRad: number | null = null;

/** True while the rAF sampler is attached. */
export function isFeelTelemetryRunning(): boolean {
  return rafHandle !== null;
}

function nowSec(): number {
  return (performance.now() - sessionStartMs) / 1000;
}

function handleImpact(record: ImpactRecord): void {
  if (!accumulator) return;
  const counterpart = counterpartOf(record);
  accumulateImpact(accumulator, {
    tSec: nowSec(),
    handle: counterpart.handle,
    kind: counterpart.kind,
    forceMagN: record.forceMag,
  });
}

function tick(frameMs: number): void {
  // Re-arm first: an exception below must not silently end the session.
  rafHandle = requestAnimationFrame(tick);
  const acc = accumulator;
  if (!acc) return;
  const dtSec = (frameMs - lastFrameMs) / 1000;
  lastFrameMs = frameMs;
  const player = playerVehicle.current;
  if (!player) {
    // No car (GARAGE, a remount, the moment after a wreck). Break the yaw chain so the first
    // frame of the next car does not register a fabricated yaw rate across the gap.
    prevYawRad = null;
    return;
  }
  const state = player.readState();
  const input = getDrivingInput();
  const sample = buildFeelSample({
    tSec: (frameMs - sessionStartMs) / 1000,
    dtSec,
    prevYawRad,
    vehicle: {
      // rawPose, not pose: `pose` is interpolated between physics steps for the camera's benefit
      // (IVehicleModel.ts:21-23), and interpolation lag would smear every response timing.
      position: state.rawPose.position,
      rotation: state.rawPose.rotation,
      velocity: state.velocity,
      speedMps: state.speed,
      forwardSpeedMps: state.forwardSpeed,
      upright: state.upright,
      wheels: state.wheels,
    },
    input,
    car: acc.car,
  });
  accumulateSample(acc, sample);
  prevYawRad = sample.yawRad;
}

/**
 * Start (or restart) a measured session. Idempotent-ish: calling it while running RESETS the
 * accumulator and re-bases the clock rather than attaching a second sampler — a battery that
 * starts each run with a fresh call gets a clean window every time.
 */
export function startFeelTelemetry(opts?: FeelTelemetryOptions): void {
  stopFeelTelemetry();
  accumulator = createFeelAccumulator(opts?.car ?? resolveFeelCarParams(), resolveFeelTuning(opts?.tuning));
  sessionStartMs = performance.now();
  lastFrameMs = sessionStartMs;
  prevYawRad = null;
  unsubscribeImpacts = onImpact(handleImpact);
  if (typeof requestAnimationFrame === 'function') {
    rafHandle = requestAnimationFrame(tick);
  }
}

/** Detach the sampler and the contact subscription. The accumulated data SURVIVES, so
 * `readFeelTelemetry()` after a stop still returns the run. Safe to call twice. */
export function stopFeelTelemetry(): void {
  if (rafHandle !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafHandle);
  rafHandle = null;
  unsubscribeImpacts?.();
  unsubscribeImpacts = null;
}

/** Zero the measured data without detaching, and re-base the clock to now. */
export function resetFeelTelemetry(): void {
  if (!accumulator) return;
  accumulator = createFeelAccumulator(accumulator.car, accumulator.tuning);
  sessionStartMs = performance.now();
  lastFrameMs = sessionStartMs;
  prevYawRad = null;
}

/** Label a point in the session (probe boundaries, route legs). No-op before a start. */
export function markFeelPhase(label: string): void {
  if (!accumulator) return;
  markFeelPhaseOn(accumulator, label);
}

/** Plain, JSON-serializable snapshot — safe to return straight out of `page.evaluate`. Before
 * any start it reports an empty session against the currently selected car rather than throwing,
 * so a battery that reads too early gets a legible zero, not a crash. */
export function readFeelTelemetry(): FeelTelemetrySnapshot {
  const acc = accumulator ?? createFeelAccumulator(resolveFeelCarParams());
  return summarizeFeel(acc, isFeelTelemetryRunning());
}

/** Test-only teardown: drop the sampler, the subscription AND the accumulated data, so each test
 * starts from a clean module (mirrors combat/contacts.ts's __resetContactsForTest). */
export function __resetFeelTelemetryForTest(): void {
  stopFeelTelemetry();
  accumulator = null;
  sessionStartMs = 0;
  lastFrameMs = 0;
  prevYawRad = null;
}
