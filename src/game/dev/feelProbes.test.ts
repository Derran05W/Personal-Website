// Phase 74 Task 2 — unit tests for the PURE half of dev/feelProbes.ts.
//
// Everything here runs headless: no browser, no Rapier, no store. The probe RUNNERS are not
// tested (they need a live physics world and are exercised by the Playwright battery); what is
// tested is every function that turns a trace into a number, plus the two derivations that decide
// whether a probe may run at all (the corridor and the runway estimator).
//
// The traces are SYNTHETIC and analytic on purpose: a first-order launch curve, a constant-decel
// brake, a ramp-then-settle turn. That means the expected answers are closed-form, so a test
// failure points at the analysis code rather than at a recorded fixture nobody can re-derive.
//
// The cases that matter most — and the ones the plan asks for by name — are the NEGATIVE ones:
// a speed that is never reached, a brake that never stops, a turn that never settles, a runway
// that is too small. Those are exactly the paths where a careless implementation returns a
// truncated number that reads like a real measurement.

import { describe, it, expect } from 'vitest';
import {
  axesFromQuaternion,
  brakeMetricsFrom,
  estimateStraightRunwayM,
  estimateTurnRunway,
  formatProbeSuiteReport,
  integrateDistanceM,
  launchMetricsFrom,
  makeRunway,
  medianSampleIntervalSec,
  peakYawFrom,
  probeStartPose,
  resolveProbeCorridor,
  resolveProbeStatus,
  samplesInPhase,
  settledTurnWindow,
  stabilityMetricsFrom,
  timeToSpeed,
  worstRunway,
  wrapAngle,
  type FeelProbeSuiteResult,
  type ProbeCorridor,
  type ProbeResultBase,
  type ProbeSample,
} from './feelProbes';
import { SPEED_TOP_SPEED_MPS } from '../config/carTuning';
import { VEHICLE_TUNING } from '../config/vehicles';
import { YONGE_X, ZONE_BOUNDARIES } from '../world/toronto/projection';
import { buildStreets } from '../world/toronto/streets';

// --- trace fixtures ---------------------------------------------------------------------------

/** A sample with sane defaults; every test overrides only what it cares about. */
function sample(over: Partial<ProbeSample> & Pick<ProbeSample, 'tSec' | 'phase'>): ProbeSample {
  return {
    x: 0,
    z: 0,
    speedMps: 0,
    forwardSpeedMps: 0,
    yawRad: 0,
    yawRateRadS: 0,
    rollRad: 0,
    pitchRad: 0,
    upright: true,
    wheelsInContact: 4,
    steer: 0,
    throttle: 0,
    brake: 0,
    ...over,
  };
}

/** Samples at a fixed cadence over [0, durationSec], speed from an analytic function. */
function speedTrace(
  phase: string,
  durationSec: number,
  dtSec: number,
  speedAt: (t: number) => number,
  over: (t: number) => Partial<ProbeSample> = () => ({}),
): ProbeSample[] {
  const out: ProbeSample[] = [];
  const steps = Math.round(durationSec / dtSec);
  for (let i = 0; i <= steps; i++) {
    const tSec = i * dtSec;
    out.push(sample({ tSec, phase, speedMps: speedAt(tSec), ...over(tSec) }));
  }
  return out;
}

// A first-order launch, which is what a linearly-fading throttle governor plus linear damping
// actually produces: v(t) = vAsymptote · (1 − e^(−t/τ)).
const LAUNCH_TAU_SEC = 1.5;
function firstOrderLaunch(vAsymptote: number): (t: number) => number {
  return (t) => vAsymptote * (1 - Math.exp(-t / LAUNCH_TAU_SEC));
}

// --- wrapAngle ----------------------------------------------------------------------------------

describe('wrapAngle', () => {
  it('leaves in-range angles alone and maps the seam to (−π, π]', () => {
    expect(wrapAngle(0)).toBeCloseTo(0, 12);
    expect(wrapAngle(1)).toBeCloseTo(1, 12);
    expect(wrapAngle(-1)).toBeCloseTo(-1, 12);
    expect(wrapAngle(Math.PI)).toBeCloseTo(Math.PI, 12);
  });

  it('kills the ±π wrap spike that would otherwise win every peak-yaw contest', () => {
    // A car turning right through the seam: yaw goes 3.10 → −3.10, a raw delta of −6.2 rad.
    const rawDelta = -3.1 - 3.1;
    expect(Math.abs(rawDelta)).toBeGreaterThan(6);
    expect(wrapAngle(rawDelta)).toBeCloseTo(2 * Math.PI - 6.2, 10);
    expect(Math.abs(wrapAngle(rawDelta))).toBeLessThan(0.1);
  });
});

// --- axesFromQuaternion --------------------------------------------------------------------------

describe('axesFromQuaternion', () => {
  /** Quaternion for a rotation of `rad` about a unit axis. */
  function quat(axis: readonly [number, number, number], rad: number) {
    const s = Math.sin(rad / 2);
    return { x: axis[0] * s, y: axis[1] * s, z: axis[2] * s, w: Math.cos(rad / 2) };
  }

  it('is all-zero for the identity rotation (the probe start pose)', () => {
    const a = axesFromQuaternion({ x: 0, y: 0, z: 0, w: 1 });
    expect(a.yawRad).toBeCloseTo(0, 12);
    expect(a.pitchRad).toBeCloseTo(0, 12);
    expect(a.rollRad).toBeCloseTo(0, 12);
  });

  it('reads yaw about +Y with the house atan2(fwd.x, fwd.z) convention, and leaves roll/pitch flat', () => {
    for (const yaw of [0.3, 1.2, -2.0, Math.PI / 2]) {
      const a = axesFromQuaternion(quat([0, 1, 0], yaw));
      expect(a.yawRad).toBeCloseTo(yaw, 10);
      expect(a.pitchRad).toBeCloseTo(0, 10);
      expect(a.rollRad).toBeCloseTo(0, 10);
    }
  });

  it('reads pitch as the nose angle above the horizon, independent of roll', () => {
    // Rotation about the local X axis tips the +Z forward vector out of the ground plane.
    const a = axesFromQuaternion(quat([1, 0, 0], 0.4));
    expect(Math.abs(a.pitchRad)).toBeCloseTo(0.4, 10);
    expect(a.rollRad).toBeCloseTo(0, 10);
  });

  it('reads roll as the tilt of the local +X axis, independent of pitch', () => {
    // Rotation about the local Z (forward) axis lifts one side.
    const a = axesFromQuaternion(quat([0, 0, 1], 0.5));
    expect(a.rollRad).toBeCloseTo(0.5, 10);
    expect(a.pitchRad).toBeCloseTo(0, 10);
  });

  it('stays finite fully inverted — the attitude the slalom probe is hunting for', () => {
    const a = axesFromQuaternion(quat([0, 0, 1], Math.PI));
    expect(Number.isFinite(a.rollRad)).toBe(true);
    expect(Number.isFinite(a.pitchRad)).toBe(true);
    expect(Number.isFinite(a.yawRad)).toBe(true);
  });
});

// --- sampling bookkeeping -----------------------------------------------------------------------

describe('samplesInPhase / medianSampleIntervalSec', () => {
  it('slices by phase tag, preserving order', () => {
    const trace = [
      sample({ tSec: 0, phase: 'approach' }),
      sample({ tSec: 0.1, phase: 'approach' }),
      sample({ tSec: 0.2, phase: 'step' }),
    ];
    expect(samplesInPhase(trace, 'approach')).toHaveLength(2);
    expect(samplesInPhase(trace, 'step').map((s) => s.tSec)).toEqual([0.2]);
    expect(samplesInPhase(trace, 'nope')).toHaveLength(0);
  });

  it('reports the MEDIAN gap so one stalled frame cannot inflate the quantization floor', () => {
    const trace = [
      sample({ tSec: 0, phase: 'p' }),
      sample({ tSec: 0.05, phase: 'p' }),
      sample({ tSec: 0.1, phase: 'p' }),
      sample({ tSec: 1.6, phase: 'p' }), // a 1.5 s hitch
      sample({ tSec: 1.65, phase: 'p' }),
    ];
    expect(medianSampleIntervalSec(trace)).toBeCloseTo(0.05, 10);
    // The mean would have been ~0.41 — an order of magnitude of fake quantization.
  });

  it('returns 0 for a trace too short to have a gap', () => {
    expect(medianSampleIntervalSec([])).toBe(0);
    expect(medianSampleIntervalSec([sample({ tSec: 0, phase: 'p' })])).toBe(0);
  });
});

// --- timeToSpeed ----------------------------------------------------------------------------------

describe('timeToSpeed', () => {
  const trace = speedTrace('launch', 1, 0.25, (t) => t * 10); // 0, 2.5, 5, 7.5, 10

  it('interpolates between bracketing samples rather than snapping to the frame grid', () => {
    // 6 m/s sits 40 % of the way from the t=0.5 sample (5) to the t=0.75 sample (7.5).
    expect(timeToSpeed(trace, 'launch', 6)).toBeCloseTo(0.6, 10);
  });

  it('measures from the phase start, not from the trace start', () => {
    const offset = trace.map((s) => ({ ...s, tSec: s.tSec + 12 }));
    expect(timeToSpeed(offset, 'launch', 6)).toBeCloseTo(0.6, 10);
  });

  it('returns 0 when the phase opens already at or above the target', () => {
    expect(timeToSpeed(trace, 'launch', 0)).toBe(0);
  });

  it('returns NULL when the speed is never reached — never the last sample time', () => {
    expect(timeToSpeed(trace, 'launch', 25)).toBeNull();
  });

  it('returns null for an absent phase', () => {
    expect(timeToSpeed(trace, 'brake', 1)).toBeNull();
  });
});

// --- integrateDistanceM -----------------------------------------------------------------------

describe('integrateDistanceM', () => {
  it('is exact for a linear speed ramp (the trapezoid rule integrates a line exactly)', () => {
    // v = 4t over 3 s ⇒ ∫ = 2·3² = 18 m.
    expect(integrateDistanceM(speedTrace('p', 3, 0.1, (t) => 4 * t))).toBeCloseTo(18, 8);
  });

  it('is 0 for a trace with fewer than two samples', () => {
    expect(integrateDistanceM([])).toBe(0);
    expect(integrateDistanceM([sample({ tSec: 0, phase: 'p', speedMps: 9 })])).toBe(0);
  });
});

// --- launch metrics ------------------------------------------------------------------------------

describe('launchMetricsFrom', () => {
  it('extracts t50/t90 from a first-order launch, against the RESOLVED top speed', () => {
    const topSpeed = SPEED_TOP_SPEED_MPS.C; // the shipped starter's grade — never a literal 25
    const trace = speedTrace('launch', 10, 0.02, firstOrderLaunch(topSpeed));
    const m = launchMetricsFrom(trace, 'launch', topSpeed);
    // v(t) = vmax(1−e^(−t/τ)) ⇒ t50 = τ·ln2, t90 = τ·ln10.
    expect(m.t50Sec).toBeCloseTo(LAUNCH_TAU_SEC * Math.LN2, 3);
    expect(m.t90Sec).toBeCloseTo(LAUNCH_TAU_SEC * Math.log(10), 3);
    expect(m.peakSpeedMps).toBeLessThanOrEqual(topSpeed);
    expect(m.distanceM).toBeGreaterThan(0);
  });

  it('reports t90 as NULL when the car asymptotes below 90 % of its nominal top speed', () => {
    // The governor/damping equilibrium sitting under the nominal top speed is a REAL property of
    // this vehicle model, so "never reached" has to be representable — see the brake probe's
    // ENTRY-SPEED PLATEAU note for the same physics.
    const topSpeed = SPEED_TOP_SPEED_MPS.C;
    const trace = speedTrace('launch', 20, 0.05, firstOrderLaunch(topSpeed * 0.85));
    const m = launchMetricsFrom(trace, 'launch', topSpeed);
    expect(m.t50Sec).not.toBeNull();
    expect(m.t90Sec).toBeNull();
    expect(m.peakSpeedMps).toBeLessThan(topSpeed * 0.9);
  });

  it('is all-null/zero for an empty launch phase', () => {
    const m = launchMetricsFrom([], 'launch', 25);
    expect(m.t50Sec).toBeNull();
    expect(m.t90Sec).toBeNull();
    expect(m.peakSpeedMps).toBe(0);
    expect(m.distanceM).toBe(0);
  });
});

// --- brake metrics --------------------------------------------------------------------------------

describe('brakeMetricsFrom', () => {
  const DECEL = 5; // m/s²
  const ENTRY = 20; // m/s

  it('integrates a constant-decel stop to the closed-form distance and time', () => {
    const trace = speedTrace('brake', 4.5, 0.05, (t) => Math.max(0, ENTRY - DECEL * t));
    const m = brakeMetricsFrom(trace, 'brake', 0.5);
    expect(m.stopped).toBe(true);
    expect(m.entrySpeedMps).toBeCloseTo(ENTRY, 10);
    // Stop threshold is 0.5 m/s, so the car covers (v0² − 0.5²)/(2a) and takes (v0 − 0.5)/a.
    expect(m.brakeDistM).toBeCloseTo((ENTRY * ENTRY - 0.25) / (2 * DECEL), 3);
    expect(m.brakeSec).toBeCloseTo((ENTRY - 0.5) / DECEL, 3);
  });

  it('interpolates the crossing instead of snapping to the frame grid', () => {
    // A deliberately coarse 0.5 s cadence: the last sample before the threshold still has 2.5 m/s
    // on it, so a grid-snapped answer would add ~0.6 m of phantom stopping distance.
    const coarse = speedTrace('brake', 4.5, 0.5, (t) => Math.max(0, ENTRY - DECEL * t));
    const m = brakeMetricsFrom(coarse, 'brake', 0.5);
    expect(m.brakeDistM).toBeCloseTo((ENTRY * ENTRY - 0.25) / (2 * DECEL), 1);
    expect(m.brakeSec).toBeCloseTo((ENTRY - 0.5) / DECEL, 2);
  });

  it('measures from the FIRST brake-phase sample, ignoring the accel phase before it', () => {
    const trace = [
      ...speedTrace('brakeAccel', 2, 0.1, (t) => 10 * t),
      ...speedTrace('brake', 4.5, 0.05, (t) => Math.max(0, ENTRY - DECEL * t)).map((s) => ({
        ...s,
        tSec: s.tSec + 2,
      })),
    ];
    const m = brakeMetricsFrom(trace, 'brake', 0.5);
    expect(m.entrySpeedMps).toBeCloseTo(ENTRY, 10);
    expect(m.brakeSec).toBeCloseTo((ENTRY - 0.5) / DECEL, 3);
  });

  it('reports NULL distance/time when the car never stops — not "as far as it got"', () => {
    // 3 s of a 4 s stop: a truncated 42 m would read exactly like a real brake distance.
    const truncated = speedTrace('brake', 3, 0.05, (t) => ENTRY - DECEL * t);
    const m = brakeMetricsFrom(truncated, 'brake', 0.5);
    expect(m.stopped).toBe(false);
    expect(m.brakeDistM).toBeNull();
    expect(m.brakeSec).toBeNull();
    expect(m.entrySpeedMps).toBeCloseTo(ENTRY, 10); // the entry speed IS still known, and reported
  });

  it('degrades safely on an empty brake phase', () => {
    const m = brakeMetricsFrom([], 'brake', 0.5);
    expect(m).toEqual({ entrySpeedMps: 0, brakeDistM: null, brakeSec: null, stopped: false });
  });
});

// --- peak yaw ---------------------------------------------------------------------------------------

describe('peakYawFrom', () => {
  it('finds the peak |yaw rate| and the time to it, from the phase start', () => {
    const rates = [0, 0.1, 0.4, 0.75, 0.6, 0.55];
    const trace = rates.map((r, i) => sample({ tSec: i * 0.05, phase: 'step', yawRateRadS: r }));
    const m = peakYawFrom(trace, 'step');
    expect(m.peakYawRateRadS).toBeCloseTo(0.75, 10);
    expect(m.timeToPeakSec).toBeCloseTo(0.15, 10);
    expect(m.quantizationSec).toBeCloseTo(0.05, 10);
  });

  it('handles a LEFT step (negative yaw rate) by magnitude', () => {
    const trace = [0, -0.2, -0.9, -0.5].map((r, i) =>
      sample({ tSec: i * 0.05, phase: 'step', yawRateRadS: r }),
    );
    expect(peakYawFrom(trace, 'step').peakYawRateRadS).toBeCloseTo(0.9, 10);
  });

  it("skips the phase's first sample, whose rate was differentiated across the phase boundary", () => {
    // The frame carrying the steer edge inherits the PREVIOUS phase's motion; if it were counted,
    // this straight-line-then-turn trace would report a 9 rad/s "response" at t=0.
    const trace = [
      sample({ tSec: 0, phase: 'step', yawRateRadS: 9 }),
      sample({ tSec: 0.05, phase: 'step', yawRateRadS: 0.2 }),
      sample({ tSec: 0.1, phase: 'step', yawRateRadS: 0.6 }),
    ];
    const m = peakYawFrom(trace, 'step');
    expect(m.peakYawRateRadS).toBeCloseTo(0.6, 10);
    expect(m.timeToPeakSec).toBeCloseTo(0.1, 10);
  });

  it('breaks a plateau tie toward the EARLIEST peak (the response time being measured)', () => {
    const trace = [0, 0.5, 0.5, 0.5].map((r, i) =>
      sample({ tSec: i * 0.05, phase: 'step', yawRateRadS: r }),
    );
    expect(peakYawFrom(trace, 'step').timeToPeakSec).toBeCloseTo(0.05, 10);
  });

  it('returns nulls when the phase is too short to have a rate at all', () => {
    expect(peakYawFrom([], 'step').peakYawRateRadS).toBeNull();
    expect(peakYawFrom([sample({ tSec: 0, phase: 'step' })], 'step').timeToPeakSec).toBeNull();
  });
});

// --- settled turn window -----------------------------------------------------------------------------

describe('settledTurnWindow', () => {
  const OPTS = { rejectSec: 0.45, minWindowSec: 0.4, tolerance: 0.12 };

  /** A lock phase: yaw rate ramps linearly over `rampSec`, then holds `steadyYaw`. */
  function lockTrace(rampSec: number, steadyYaw: number, speed: number, durationSec = 1.4) {
    return speedTrace(
      'lock',
      durationSec,
      0.05,
      () => speed,
      (t) => ({ yawRateRadS: t < rampSec ? (steadyYaw * t) / rampSec : steadyYaw }),
    );
  }

  it('returns speed ÷ |yawRate| over the settled portion', () => {
    const w = settledTurnWindow(lockTrace(0.45, 0.6, 15), 'lock', OPTS);
    expect(w).not.toBeNull();
    expect(w?.meanYawRateRadS).toBeCloseTo(0.6, 6);
    expect(w?.meanSpeedMps).toBeCloseTo(15, 6);
    expect(w?.radiusM).toBeCloseTo(25, 4);
    expect(w?.durationSec).toBeCloseTo(0.95, 6);
    expect(w?.sampleCount).toBeGreaterThan(5);
  });

  it('SHRINKS FROM THE FRONT so a transient longer than rejectSec is still rejected', () => {
    // The ramp runs to 0.7 s, well past the 0.45 s reject. A fixed-slice implementation would
    // average the tail of the ramp in and report a too-small radius.
    const w = settledTurnWindow(lockTrace(0.7, 0.6, 15), 'lock', OPTS);
    expect(w).not.toBeNull();
    // Well past the 0.45 s reject, i.e. the search kept dropping leading samples until the ramp
    // was (all but) out of the window. It may keep the last sample or two of the ramp — that is
    // the tolerance doing its job, and it costs ~0.5 % on the radius, not 30 %.
    expect(w?.startSec).toBeGreaterThan(0.6);
    expect(w?.meanYawRateRadS).toBeCloseTo(0.6, 2);
    expect(w?.radiusM).toBeGreaterThan(24.5);
    expect(w?.radiusM).toBeLessThan(25.5);
  });

  it('handles a LEFT-hand circle (negative yaw rate) via magnitude', () => {
    const w = settledTurnWindow(lockTrace(0.45, -0.6, 15), 'lock', OPTS);
    expect(w?.meanYawRateRadS).toBeCloseTo(0.6, 6);
    expect(w?.radiusM).toBeCloseTo(25, 4);
  });

  it('returns null when the yaw rate never settles inside tolerance', () => {
    // A yaw rate still climbing at the end of the hold: every candidate window fails the spread
    // test until it is shorter than minWindowSec.
    const climbing = speedTrace(
      'lock',
      1.4,
      0.05,
      () => 15,
      (t) => ({ yawRateRadS: 0.2 + 0.5 * t }),
    );
    expect(settledTurnWindow(climbing, 'lock', OPTS)).toBeNull();
  });

  it('returns null when the settled part is shorter than minWindowSec', () => {
    // Ramp to 1.2 s of a 1.4 s hold ⇒ only 0.2 s of steady state.
    expect(settledTurnWindow(lockTrace(1.2, 0.6, 15), 'lock', OPTS)).toBeNull();
  });

  it('returns null when the speed is not steady even though the yaw rate is', () => {
    const decaying = speedTrace(
      'lock',
      1.4,
      0.05,
      (t) => 15 - 6 * t, // scrubbing off a third of its speed through the turn
      () => ({ yawRateRadS: 0.6 }),
    );
    expect(settledTurnWindow(decaying, 'lock', OPTS)).toBeNull();
  });

  it('refuses to divide by a near-zero yaw rate (a straight line has no radius)', () => {
    const straight = speedTrace(
      'lock',
      1.4,
      0.05,
      () => 15,
      () => ({ yawRateRadS: 5e-5 }), // steady, but not a turn — radius would be 300 km
    );
    expect(settledTurnWindow(straight, 'lock', OPTS)).toBeNull();
  });

  it('returns null for an absent phase', () => {
    expect(settledTurnWindow([], 'lock', OPTS)).toBeNull();
  });
});

// --- stability -------------------------------------------------------------------------------------

describe('stabilityMetricsFrom', () => {
  it('reports absolute roll/pitch peaks, airtime with its denominator, and the min speed', () => {
    const trace = [
      sample({ tSec: 0, phase: 'slalom', rollRad: 0.1, pitchRad: -0.05, speedMps: 15 }),
      sample({ tSec: 0.05, phase: 'slalom', rollRad: -0.42, pitchRad: 0.2, speedMps: 14 }),
      sample({ tSec: 0.1, phase: 'slalom', rollRad: 0.3, wheelsInContact: 0, speedMps: 13.5 }),
      sample({ tSec: 0.15, phase: 'slalom', rollRad: 0.05, wheelsInContact: 0, speedMps: 14 }),
    ];
    const m = stabilityMetricsFrom(trace, 'slalom', 0.5);
    expect(m.rollPeakRad).toBeCloseTo(0.42, 10); // magnitude, so the left-hand peak wins
    expect(m.pitchPeakRad).toBeCloseTo(0.2, 10);
    expect(m.frames).toBe(4);
    expect(m.airtimeFrac).toBeCloseTo(0.5, 10);
    expect(m.minSpeedMps).toBeCloseTo(13.5, 10);
    expect(m.flipEvents).toBe(0);
  });

  it('counts a sustained non-upright run as ONE flip, not one per dwell period', () => {
    // 3 s continuously on its roof at a 0.5 s dwell: a re-arming implementation scores 5-6.
    const trace = speedTrace(
      'slalom',
      3,
      0.05,
      () => 8,
      () => ({ upright: false }),
    );
    expect(stabilityMetricsFrom(trace, 'slalom', 0.5).flipEvents).toBe(1);
  });

  it('does not count a lean shorter than the dwell', () => {
    const trace = speedTrace(
      'slalom',
      1,
      0.05,
      () => 8,
      (t) => ({ upright: !(t >= 0.4 && t <= 0.7) }), // 0.3 s over, under the 0.5 s dwell
    );
    expect(stabilityMetricsFrom(trace, 'slalom', 0.5).flipEvents).toBe(0);
  });

  it('counts two separated flips as two', () => {
    const trace = speedTrace(
      'slalom',
      5,
      0.05,
      () => 8,
      (t) => ({ upright: !((t >= 0.2 && t <= 1.2) || (t >= 3 && t <= 4.2)) }),
    );
    expect(stabilityMetricsFrom(trace, 'slalom', 0.5).flipEvents).toBe(2);
  });

  it('is all-zero (never NaN) on an empty phase', () => {
    const m = stabilityMetricsFrom([], 'slalom', 0.5);
    expect(m).toEqual({
      rollPeakRad: 0,
      pitchPeakRad: 0,
      flipEvents: 0,
      airtimeFrac: 0,
      frames: 0,
      minSpeedMps: 0,
    });
  });
});

// --- runway estimation --------------------------------------------------------------------------------

describe('estimateTurnRunway', () => {
  const BASE = {
    topSpeedMps: SPEED_TOP_SPEED_MPS.C,
    wheelbaseM: VEHICLE_TUNING.wheels.frontZ - VEHICLE_TUNING.wheels.rearZ,
    maxAngleDeg: VEHICLE_TUNING.steering.maxAngleDeg,
    highSpeedAngleDeg: VEHICLE_TUNING.steering.highSpeedAngleDeg,
    latAccelCapMps2: 10,
    windowSec: 0.85,
  };

  it('is grip-limited at speed: R = v²/a_lat once that exceeds the bicycle radius', () => {
    const e = estimateTurnRunway({ ...BASE, speedMps: 20 });
    expect(e.radiusEstM).toBeCloseTo((20 * 20) / 10, 6);
  });

  it('is kinematics-limited at a crawl, where the wheels cannot ask for a tighter circle', () => {
    const e = estimateTurnRunway({ ...BASE, speedMps: 2 });
    const gripR = (2 * 2) / 10;
    expect(e.radiusEstM).toBeGreaterThan(gripR);
    expect(e.radiusEstM).toBeGreaterThan(BASE.wheelbaseM); // ≈ wheelbase / tan(δ) with δ < 45°
  });

  it('consumes room along the EXACT circular arc, not a small-angle approximation', () => {
    const speedMps = 15;
    const e = estimateTurnRunway({ ...BASE, speedMps });
    const theta = (speedMps * BASE.windowSec) / e.radiusEstM;
    expect(e.lateralM).toBeCloseTo(e.radiusEstM * (1 - Math.cos(theta)), 10);
    expect(e.longitudinalM).toBeCloseTo(e.radiusEstM * Math.sin(theta), 10);
    // Sanity: a real arc never travels further forward than the path length.
    expect(e.longitudinalM).toBeLessThanOrEqual(speedMps * BASE.windowSec + 1e-9);
  });

  it('eats more lateral room the longer the window is held — the reason holds are short', () => {
    const short = estimateTurnRunway({ ...BASE, speedMps: 15, windowSec: 0.85 });
    const long = estimateTurnRunway({ ...BASE, speedMps: 15, windowSec: 1.2 });
    expect(long.lateralM).toBeGreaterThan(short.lateralM);
  });

  it('degrades to zero consumption at a standstill', () => {
    const e = estimateTurnRunway({ ...BASE, speedMps: 0 });
    expect(e.lateralM).toBeCloseTo(0, 10);
    expect(e.longitudinalM).toBeCloseTo(0, 10);
  });
});

describe('estimateStraightRunwayM', () => {
  it('is the governed-top-speed UPPER BOUND, not a prediction', () => {
    expect(estimateStraightRunwayM(25, 12)).toBe(300);
  });
});

describe('makeRunway / worstRunway', () => {
  it('is sufficient only when BOTH axes fit', () => {
    expect(makeRunway(1000, 300, 7, 3).sufficient).toBe(true);
    expect(makeRunway(1000, 1200, 7, 3).sufficient).toBe(false); // longitudinal short
    expect(makeRunway(1000, 300, 2, 3).sufficient).toBe(false); // lateral short
  });

  it('treats an exactly-fitting manoeuvre as sufficient', () => {
    expect(makeRunway(300, 300, 3, 3).sufficient).toBe(true);
  });

  it('aggregates a multi-point probe to the worst case: max need, min availability', () => {
    const w = worstRunway([makeRunway(1000, 300, 7, 2), makeRunway(900, 420, 6, 5)]);
    expect(w.availableLongitudinalM).toBe(900);
    expect(w.neededLongitudinalM).toBe(420);
    expect(w.availableLateralM).toBe(6);
    expect(w.neededLateralM).toBe(5);
    expect(w.sufficient).toBe(true);
  });

  it('is an all-zero, sufficient runway for an empty point list', () => {
    expect(worstRunway([]).sufficient).toBe(true);
  });
});

// --- status precedence -------------------------------------------------------------------------------

describe('resolveProbeStatus', () => {
  const interruption = { reason: 'collision' as const, atSec: 1, detail: 'hit building' };

  it('reports an interruption ahead of everything else — it is what ended the run', () => {
    expect(
      resolveProbeStatus({ interruption, runwaySufficient: false, metricUsable: false }),
    ).toBe('interrupted');
  });

  it('reports a runway shortfall ahead of an unusable metric — it EXPLAINS the unusable metric', () => {
    expect(
      resolveProbeStatus({ interruption: null, runwaySufficient: false, metricUsable: false }),
    ).toBe('insufficientRunway');
    // …and still does so even when a partial number happens to exist, so no reader can mistake
    // a truncated measurement for a real one.
    expect(
      resolveProbeStatus({ interruption: null, runwaySufficient: false, metricUsable: true }),
    ).toBe('insufficientRunway');
  });

  it('falls through to the metric verdict on a clean run', () => {
    expect(
      resolveProbeStatus({ interruption: null, runwaySufficient: true, metricUsable: true }),
    ).toBe('ok');
    expect(
      resolveProbeStatus({ interruption: null, runwaySufficient: true, metricUsable: false }),
    ).toBe('inconclusive');
  });
});

// --- corridor derivation ------------------------------------------------------------------------------

describe('resolveProbeCorridor', () => {
  const corridor = resolveProbeCorridor();
  const { streets } = buildStreets();
  const spine = streets.find((s) => s.cls === 'spine');
  const bloor = streets.find((s) => s.id === 'bloor');

  it('sits on the Yonge spine centreline (derived from the street table, never typed)', () => {
    expect(corridor.centreX).toBe(YONGE_X);
    expect(corridor.ribbonHalfWidthM).toBe(spine?.halfWidth);
  });

  it('offers a clear box wider than the ribbon, because the sidewalk band carries no colliders', () => {
    expect(corridor.clearHalfWidthM).toBeGreaterThan(corridor.ribbonHalfWidthM);
  });

  it('starts SOUTH of Bloor, clear of the junction — which also keeps it out of the fold band', () => {
    const bloorZ = bloor?.centerline ?? 0;
    const bloorHalf = bloor?.halfWidth ?? 0;
    expect(corridor.startZ).toBeGreaterThan(bloorZ + bloorHalf);
    // The fold boundary is ZONE_BOUNDARIES[2]; crossing it fires the Line 1 tunnel overlay.
    expect(corridor.startZ).toBeGreaterThan(ZONE_BOUNDARIES[2]);
  });

  it('ends well short of the shore, so a brake overrun cannot reach the water sensor', () => {
    expect(corridor.endZ).toBeLessThan(ZONE_BOUNDARIES[3] - 30);
    expect(corridor.endZ).toBeLessThanOrEqual(spine?.span[1] ?? Infinity);
  });

  it('runs strictly south (+z) and reports a positive usable length', () => {
    expect(corridor.endZ).toBeGreaterThan(corridor.startZ);
    expect(corridor.lengthM).toBeGreaterThan(0);
    expect(corridor.lengthM).toBeLessThan(corridor.endZ - corridor.startZ); // slack is deducted
  });

  it('IS LONG ENOUGH for the suite\'s longest manoeuvre on the FASTEST car in the roster', () => {
    // The brake probe's bound is topSpeed × (accel window + stop window) = 30 s of travel. This is
    // the invariant that keeps every probe out of the `insufficientRunway` branch on the shipped
    // map — if a future road/street-table change shortens Yonge, this fires instead of the
    // battery quietly reporting five runway shortfalls.
    const fastest = Math.max(...Object.values(SPEED_TOP_SPEED_MPS));
    expect(corridor.lengthM).toBeGreaterThanOrEqual(estimateStraightRunwayM(fastest, 30));
  });
});

describe('probeStartPose', () => {
  it('faces +z with the IDENTITY rotation — the same facing the shipped spawn uses', () => {
    const corridor = resolveProbeCorridor();
    const pose = probeStartPose(corridor);
    expect(pose.rotation).toEqual({ x: 0, y: 0, z: 0, w: 1 });
    expect(pose.position.x).toBe(corridor.centreX);
    expect(pose.position.z).toBe(corridor.startZ);
    expect(pose.position.y).toBeGreaterThan(0); // the shipped settle height, not the ground plane
  });
});

// --- report formatting --------------------------------------------------------------------------------

describe('formatProbeSuiteReport', () => {
  const corridor: ProbeCorridor = {
    centreX: 1500,
    startZ: 1380,
    endZ: 2410,
    lengthM: 1010,
    ribbonHalfWidthM: 5.5,
    clearHalfWidthM: 8.5,
  };
  const base: ProbeResultBase = {
    kind: 'launch',
    status: 'ok',
    insufficientRunway: false,
    interrupted: false,
    interruption: null,
    carId: 'rustySedan',
    topSpeedMps: 25,
    corridor,
    runway: makeRunway(1010, 350, 5.5, 0),
    isolation: { civTraffic: false, transit: false, packParked: false, invincible: true },
    durationSec: 5,
    sampleCount: 90,
    sampleIntervalSec: 0.055,
    contacts: [],
  };

  function suiteOf(...results: FeelProbeSuiteResult['results']): FeelProbeSuiteResult {
    return {
      startedAtIso: '2026-08-04T00:00:00.000Z',
      carId: 'rustySedan',
      topSpeedMps: 25,
      corridor,
      isolation: base.isolation,
      results,
    };
  }

  it('always states the isolation, so a probe number can never be read as live play', () => {
    const text = formatProbeSuiteReport(suiteOf());
    expect(text).toContain('NOT live play');
    expect(text).toContain('civTraffic false');
    expect(text).toContain('invincible true');
  });

  it('prints t50/t90 and marks a never-reached target as n/a rather than a number', () => {
    const text = formatProbeSuiteReport(
      suiteOf({
        ...base,
        kind: 'launch',
        t50Sec: 1.04,
        t90Sec: null,
        target50Mps: 12.5,
        target90Mps: 22.5,
        peakSpeedMps: 21.2,
        distanceM: 88,
        speedTrace: [],
      }),
    );
    expect(text).toContain('t50 1.04s');
    expect(text).toContain('t90 n/a');
  });

  it('spells out BOTH runway numbers when a probe could not fit', () => {
    const text = formatProbeSuiteReport(
      suiteOf({
        ...base,
        kind: 'launch',
        status: 'insufficientRunway',
        insufficientRunway: true,
        runway: makeRunway(120, 350, 5.5, 0),
        t50Sec: null,
        t90Sec: null,
        target50Mps: 12.5,
        target90Mps: 22.5,
        peakSpeedMps: 0,
        distanceM: 0,
        speedTrace: [],
      }),
    );
    expect(text).toContain('insufficientRunway');
    expect(text).toContain('need 350m');
    expect(text).toContain('had 120m');
  });

  it('names the interruption reason and when it happened', () => {
    const text = formatProbeSuiteReport(
      suiteOf({
        ...base,
        kind: 'brake',
        status: 'interrupted',
        interrupted: true,
        interruption: { reason: 'collision', atSec: 4.2, detail: 'hit building (force 91000)' },
        contacts: [{ atSec: 4.2, counterpartKind: 'building', forceMag: 91000, blocking: true }],
        entryTargetMps: 23.75,
        entrySpeedMps: 23.1,
        entryTargetMet: false,
        brakeDistM: null,
        brakeSec: null,
        stopped: false,
        speedTrace: [],
      }),
    );
    expect(text).toContain('collision@4.2s');
    expect(text).toContain('target 23.8 NOT reached'); // m/s printed to 1 dp
    expect(text).toContain('contacts: 1 (building)');
  });

  it('lists every turn-radius speed point with its own verdict', () => {
    const text = formatProbeSuiteReport(
      suiteOf({
        ...base,
        kind: 'turnRadius',
        status: 'ok',
        runway: makeRunway(1010, 420, 7, 3.6),
        points: [
          {
            targetSpeedMps: 10,
            status: 'ok',
            insufficientRunway: false,
            runway: makeRunway(1010, 420, 7, 3.4),
            interruption: null,
            measuredSpeedMps: 10.1,
            yawRateRadS: 0.98,
            radiusM: 10.3,
            settledWindowSec: 0.55,
            samplesInWindow: 11,
            note: null,
          },
          {
            targetSpeedMps: 20,
            status: 'insufficientRunway',
            insufficientRunway: true,
            runway: makeRunway(1010, 420, 2, 3.6),
            interruption: null,
            measuredSpeedMps: null,
            yawRateRadS: null,
            radiusM: null,
            settledWindowSec: null,
            samplesInWindow: 0,
            note: 'full lock at 20 m/s needs 3.6 m of lateral room; the corridor offers 2.0 m',
          },
        ],
      }),
    );
    expect(text).toContain('@10 m/s  R 10.3 m');
    expect(text).toContain('11 samples');
    expect(text).toContain('@20 m/s  R n/a');
    expect(text).toContain('needs 3.6 m of lateral room; the corridor offers 2.0 m');
  });

  it('reports airtime WITH its frame denominator (a ratio without one is not a measurement)', () => {
    const text = formatProbeSuiteReport(
      suiteOf({
        ...base,
        kind: 'slalom',
        sampleCount: 220,
        targetSpeedMps: 15,
        entrySpeedMps: 15.1,
        halfPeriodSec: 0.8,
        rollPeakRad: 0.41,
        pitchPeakRad: 0.12,
        flipEvents: 1,
        airtimeFrac: 0.05,
        minSpeedMps: 9.4,
      }),
    );
    expect(text).toContain('flips 1');
    expect(text).toContain('airtime 5.0% of 220 frames');
  });
});
