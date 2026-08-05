// Unit tests for the Phase 74 feel-telemetry core. This module is the ORACLE every later feel
// phase (76-94) is judged against, so its arithmetic is tested the way a measuring instrument
// should be: synthetic sample streams whose right answer is known by construction, fed through
// the SAME pure functions the live rAF sampler feeds. No Rapier, no three, no browser — the
// live shell is exercised only where the wiring itself is the thing under test.

import { afterEach, describe, expect, it } from 'vitest';
import {
  FEEL_CONTACT_KINDS,
  FEEL_STUCK_CAUSES,
  FEEL_TELEMETRY_DEFAULTS,
  FEEL_TELEMETRY_SCHEMA,
  __resetFeelTelemetryForTest,
  accumulateImpact,
  accumulateSample,
  angleDeltaRad,
  buildFeelSample,
  chassisAnglesFromQuat,
  classifyStuckCause,
  counterpartOf,
  createFeelAccumulator,
  isFeelTelemetryRunning,
  isUnrecoverableStuck,
  markFeelPhase,
  markFeelPhaseOn,
  perMinute,
  readFeelTelemetry,
  resetFeelTelemetry,
  resolveFeelTuning,
  speedBucketIndex,
  startFeelTelemetry,
  stopFeelTelemetry,
  summarizeFeel,
  turnRadiusAtSpeedM,
  turnRadiusFromArc,
  updateRestHeightBaseline,
  yawRateRadS,
  type FeelAccumulator,
  type FeelCarParams,
  type FeelSample,
  type FeelStuckEvent,
  type FeelTelemetryTuning,
} from './feelTelemetry';
import { __resetContactsForTest, dispatchImpact } from '../combat/contacts';
import { steerClampRad } from '../vehicles/steering';

// =============================================================================================
// Fixtures
// =============================================================================================

/** A stand-in for the resolved rusty sedan: top speed 25 m/s, the shipped steer clamp band. */
function testCar(overrides: Partial<FeelCarParams> = {}): FeelCarParams {
  return {
    id: 'rustySedan',
    name: 'Rusty Sedan',
    topSpeedMps: 25,
    steering: { maxAngleDeg: 42, highSpeedAngleDeg: 22 },
    massFactor: 1,
    hp: 200,
    ...overrides,
  };
}

/** Chassis resting height used by every synthetic stream (the real settle height is ~0.84 m). */
const REST_Y = 0.85;

const BASE_SAMPLE: FeelSample = {
  tSec: 0,
  dtSec: 0.1,
  x: 0,
  y: REST_Y,
  z: 0,
  yawRad: 0,
  pitchRad: 0,
  rollRad: 0,
  yawRateRadS: 0,
  speedMps: 0,
  planarSpeedMps: 0,
  forwardSpeedMps: 0,
  lateralSpeedMps: 0,
  upright: true,
  wheelsInContact: 4,
  wheelCount: 4,
  appliedSteerRad: 0,
  steerClampLimitRad: 0.7,
  steerInput: 0,
  throttle: 0,
  brake: 0,
  handbrake: false,
};

/** Feeds samples on a fixed cadence, advancing its own clock — so a test describes WHAT the car
 * was doing and never has to bookkeep timestamps. `dt` defaults to 0.1 s: coarse enough to keep
 * the arithmetic in a test readable, and far under the 0.25 s stall gate. */
function makeDriver(acc: FeelAccumulator, dt = 0.1) {
  let t = 0;
  const push = (over: Partial<FeelSample> = {}): void => {
    t = Math.round((t + dt) * 1e6) / 1e6;
    accumulateSample(acc, { ...BASE_SAMPLE, tSec: t, dtSec: dt, ...over });
  };
  const run = (
    frames: number,
    over: Partial<FeelSample> | ((i: number) => Partial<FeelSample>),
  ): void => {
    for (let i = 1; i <= frames; i++) push(typeof over === 'function' ? over(i) : over);
  };
  return { push, run, now: (): number => t };
}

function tuned(overrides: Partial<FeelTelemetryTuning>): FeelTelemetryTuning {
  return resolveFeelTuning(overrides);
}

afterEach(() => {
  __resetFeelTelemetryForTest();
  __resetContactsForTest();
});

// =============================================================================================
// Pure math
// =============================================================================================

describe('chassisAnglesFromQuat', () => {
  const yawQuat = (yaw: number) => ({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) });

  it('reads identity as level and facing +Z', () => {
    const a = chassisAnglesFromQuat({ x: 0, y: 0, z: 0, w: 1 });
    expect(a.yawRad).toBeCloseTo(0, 10);
    expect(a.pitchRad).toBeCloseTo(0, 10);
    expect(a.rollRad).toBeCloseTo(0, 10);
    expect(a.upDotY).toBeCloseTo(1, 10);
  });

  it('matches the project +Z-forward atan2(dx, dz) yaw convention', () => {
    // A quarter turn about +Y must point the nose at +X (yaw = +π/2), the same convention
    // ai/chaosBench.ts's yawFromQuaternion and fx/skidMath.ts's lateralSpeedAtYaw use.
    expect(chassisAnglesFromQuat(yawQuat(Math.PI / 2)).yawRad).toBeCloseTo(Math.PI / 2, 10);
    expect(chassisAnglesFromQuat(yawQuat(-Math.PI / 2)).yawRad).toBeCloseTo(-Math.PI / 2, 10);
  });

  it('reports pitch as nose-up-positive and leaves yaw untouched by it', () => {
    // +30° about the RIGHT axis (+X) tips the nose DOWN in a right-handed frame with +Z forward.
    const pitchDown = { x: Math.sin(Math.PI / 12), y: 0, z: 0, w: Math.cos(Math.PI / 12) };
    const a = chassisAnglesFromQuat(pitchDown);
    expect(a.pitchRad).toBeLessThan(0);
    expect(Math.abs(a.pitchRad)).toBeCloseTo(Math.PI / 6, 6);
    expect(a.rollRad).toBeCloseTo(0, 10);
  });

  it('reports roll about the forward axis with the right side positive', () => {
    const roll = Math.PI / 8;
    const q = { x: 0, y: 0, z: Math.sin(roll / 2), w: Math.cos(roll / 2) };
    const a = chassisAnglesFromQuat(q);
    expect(a.rollRad).toBeCloseTo(roll, 6);
    expect(a.pitchRad).toBeCloseTo(0, 10);
  });

  it('reports an inverted chassis with upDotY below the 0.5 upright cut', () => {
    const flipped = { x: 0, y: 0, z: 1, w: 0 }; // 180° roll
    expect(chassisAnglesFromQuat(flipped).upDotY).toBeLessThan(0.5);
  });
});

describe('angleDeltaRad', () => {
  it('returns the signed shortest path', () => {
    expect(angleDeltaRad(0, 1)).toBeCloseTo(1, 10);
    expect(angleDeltaRad(1, 0)).toBeCloseTo(-1, 10);
  });

  it('wraps across the ±π seam instead of reporting a ~2π jump', () => {
    const justUnder = Math.PI - 0.05;
    const justOver = -Math.PI + 0.05;
    expect(angleDeltaRad(justUnder, justOver)).toBeCloseTo(0.1, 10);
    expect(angleDeltaRad(justOver, justUnder)).toBeCloseTo(-0.1, 10);
  });

  it('never returns a magnitude above π', () => {
    for (let from = -7; from <= 7; from += 0.37) {
      for (let to = -7; to <= 7; to += 0.53) {
        expect(Math.abs(angleDeltaRad(from, to))).toBeLessThanOrEqual(Math.PI + 1e-12);
      }
    }
  });
});

describe('yawRateRadS', () => {
  it('divides the wrapped yaw delta by the REAL elapsed time', () => {
    expect(yawRateRadS(0, 0.2, 0.1)).toBeCloseTo(2, 10);
    expect(yawRateRadS(0.2, 0, 0.05)).toBeCloseTo(-4, 10);
  });

  it('yields 0 with no previous heading (first frame, or after a car-less gap)', () => {
    expect(yawRateRadS(null, 1.2, 0.1)).toBe(0);
  });

  it('yields 0 rather than dividing by a non-positive dt', () => {
    expect(yawRateRadS(0, 1, 0)).toBe(0);
    expect(yawRateRadS(0, 1, -0.5)).toBe(0);
  });

  it('does not fabricate a huge rate when the heading crosses ±π', () => {
    const rate = yawRateRadS(Math.PI - 0.02, -Math.PI + 0.02, 1 / 60);
    expect(rate).toBeCloseTo(0.04 * 60, 6);
  });
});

describe('speedBucketIndex', () => {
  it('buckets on the lower edge (inclusive) at the configured width', () => {
    expect(speedBucketIndex(0, 2.5)).toBe(0);
    expect(speedBucketIndex(2.49, 2.5)).toBe(0);
    expect(speedBucketIndex(2.5, 2.5)).toBe(1);
    expect(speedBucketIndex(10, 2.5)).toBe(4);
  });

  it('clamps negatives into bucket 0 and survives a zero width', () => {
    expect(speedBucketIndex(-3, 2.5)).toBe(0);
    expect(speedBucketIndex(10, 0)).toBe(0);
  });
});

describe('turnRadiusFromArc', () => {
  it('is arc length ÷ swept angle', () => {
    expect(turnRadiusFromArc(2 * Math.PI * 20, 2 * Math.PI)).toBeCloseTo(20, 10);
    expect(turnRadiusFromArc(5, 0.25)).toBeCloseTo(20, 10);
  });

  it('reports no evidence rather than dividing by ~0', () => {
    expect(turnRadiusFromArc(30, 0)).toBeNull();
    expect(turnRadiusFromArc(30, -1)).toBeNull();
  });
});

describe('perMinute', () => {
  it('normalizes a count over the measured window', () => {
    expect(perMinute(4, 2)).toBeCloseTo(120, 10);
    expect(perMinute(30, 60)).toBeCloseTo(30, 10);
  });

  it('returns 0 for an empty window instead of Infinity', () => {
    expect(perMinute(5, 0)).toBe(0);
  });
});

describe('updateRestHeightBaseline', () => {
  const t = { restHeightMinSpeedMps: 3, restHeightAlpha: 0.5 };

  it('seeds from the first qualifying sample', () => {
    expect(
      updateRestHeightBaseline(null, { chassisY: 0.9, wheelsInContact: 4, wheelCount: 4, planarSpeedMps: 8 }, t),
    ).toBeCloseTo(0.9, 10);
  });

  it('low-passes toward later qualifying samples', () => {
    expect(
      updateRestHeightBaseline(0.8, { chassisY: 1.0, wheelsInContact: 4, wheelCount: 4, planarSpeedMps: 8 }, t),
    ).toBeCloseTo(0.9, 10);
  });

  it('IGNORES a car that is perched but stationary — the whole point of the speed gate', () => {
    // Wheels down (resting on another car's roof) but not driving: the baseline must not learn
    // this height, or the onVehicle cause could never fire.
    expect(
      updateRestHeightBaseline(0.85, { chassisY: 1.9, wheelsInContact: 4, wheelCount: 4, planarSpeedMps: 0.2 }, t),
    ).toBeCloseTo(0.85, 10);
  });

  it('ignores airborne and partially-grounded samples', () => {
    expect(
      updateRestHeightBaseline(0.85, { chassisY: 3, wheelsInContact: 0, wheelCount: 4, planarSpeedMps: 12 }, t),
    ).toBeCloseTo(0.85, 10);
    expect(
      updateRestHeightBaseline(0.85, { chassisY: 1.4, wheelsInContact: 2, wheelCount: 4, planarSpeedMps: 12 }, t),
    ).toBeCloseTo(0.85, 10);
  });
});

// =============================================================================================
// Contact identity + stuck cause
// =============================================================================================

describe('FEEL_CONTACT_KINDS', () => {
  it('covers every registry kind plus the unknown bucket, in a fixed order', () => {
    expect(FEEL_CONTACT_KINDS).toEqual([
      'player',
      'pursuit',
      'civilian',
      'propStatic',
      'propDynamic',
      'building',
      'barrier',
      'transformer',
      'projectile',
      'ground',
      'water',
      'unknown',
    ]);
    expect(new Set(FEEL_CONTACT_KINDS).size).toBe(FEEL_CONTACT_KINDS.length);
  });
});

describe('counterpartOf', () => {
  it('takes side B when side A is the player (the live path)', () => {
    expect(
      counterpartOf({ aHandle: 1, bHandle: 2, a: { kind: 'player' }, b: { kind: 'building' } }),
    ).toEqual({ handle: 2, kind: 'building' });
  });

  it('takes side A when the player is on side B', () => {
    expect(
      counterpartOf({ aHandle: 1, bHandle: 2, a: { kind: 'civilian' }, b: { kind: 'player' } }),
    ).toEqual({ handle: 1, kind: 'civilian' });
  });

  it('reports an unregistered counterpart as unknown, keeping its handle', () => {
    expect(counterpartOf({ aHandle: 1, bHandle: 9, a: { kind: 'player' }, b: undefined })).toEqual({
      handle: 9,
      kind: 'unknown',
    });
  });

  it('falls back to side B when neither side resolved as the player', () => {
    expect(counterpartOf({ aHandle: 1, bHandle: 2, a: undefined, b: undefined })).toEqual({
      handle: 2,
      kind: 'unknown',
    });
    expect(counterpartOf({ aHandle: 1, bHandle: 2, a: { kind: 'pursuit' }, b: undefined })).toEqual({
      handle: 2,
      kind: 'pursuit',
    });
  });
});

describe('classifyStuckCause', () => {
  const ctx = (over: Partial<Parameters<typeof classifyStuckCause>[0]> = {}) => ({
    chassisY: REST_Y,
    restHeightY: REST_Y,
    wheelsInContact: 4,
    impacts: [],
    windowStartSec: 0,
    windowEndSec: 10,
    onVehicleRiseM: 0.6,
    ...over,
  });

  it('tags onVehicle when the chassis rests well above its learned height, wheels down', () => {
    expect(classifyStuckCause(ctx({ chassisY: REST_Y + 1.0 }))).toBe('onVehicle');
  });

  it('does NOT tag onVehicle for suspension-band or kerb-height rises', () => {
    expect(classifyStuckCause(ctx({ chassisY: REST_Y + 0.3 }))).toBe('unknown');
  });

  it('does NOT tag onVehicle while airborne (a jump is not a beaching)', () => {
    expect(classifyStuckCause(ctx({ chassisY: REST_Y + 2, wheelsInContact: 0 }))).toBe('unknown');
  });

  it('cannot tag onVehicle before a rest height has been learned', () => {
    expect(classifyStuckCause(ctx({ chassisY: 99, restHeightY: null }))).toBe('unknown');
  });

  it('lets the GEOMETRY win over the impact history', () => {
    // Driving up onto a car necessarily produces civilian impacts too — history alone would call
    // every beaching a vehicleWedge, and those are the two causes P77 must tell apart.
    const cause = classifyStuckCause(
      ctx({
        chassisY: REST_Y + 1.2,
        impacts: [
          { tSec: 4, kind: 'civilian' },
          { tSec: 5, kind: 'civilian' },
        ],
      }),
    );
    expect(cause).toBe('onVehicle');
  });

  it('maps the newest informative impact inside the window', () => {
    const impacts = [
      { tSec: 1, kind: 'building' as const },
      { tSec: 2, kind: 'civilian' as const },
    ];
    expect(classifyStuckCause(ctx({ impacts }))).toBe('vehicleWedge');
    expect(classifyStuckCause(ctx({ impacts: [...impacts].reverse().map((m, i) => ({ ...m, tSec: i + 1 })) }))).toBe(
      'building',
    );
  });

  it('maps each counterpart family to its cause', () => {
    const at = (kind: Parameters<typeof classifyStuckCause>[0]['impacts'][number]['kind']) =>
      classifyStuckCause(ctx({ impacts: [{ tSec: 3, kind }] }));
    expect(at('pursuit')).toBe('vehicleWedge');
    expect(at('civilian')).toBe('vehicleWedge');
    expect(at('building')).toBe('building');
    expect(at('propStatic')).toBe('scenery');
    expect(at('propDynamic')).toBe('scenery');
    expect(at('barrier')).toBe('scenery');
    expect(at('transformer')).toBe('scenery');
  });

  it('skips uninformative counterparts and keeps looking further back', () => {
    const impacts = [
      { tSec: 1, kind: 'building' as const },
      { tSec: 2, kind: 'ground' as const },
      { tSec: 3, kind: 'projectile' as const },
    ];
    expect(classifyStuckCause(ctx({ impacts }))).toBe('building');
  });

  it('ignores impacts outside the lookback window in both directions', () => {
    const impacts = [
      { tSec: 0.5, kind: 'building' as const },
      { tSec: 11, kind: 'civilian' as const },
    ];
    expect(classifyStuckCause(ctx({ impacts, windowStartSec: 1, windowEndSec: 10 }))).toBe('unknown');
  });

  it('falls back to unknown with no impacts at all', () => {
    expect(classifyStuckCause(ctx())).toBe('unknown');
    expect(FEEL_STUCK_CAUSES).toContain('unknown');
  });
});

describe('isUnrecoverableStuck', () => {
  const event = (over: Partial<FeelStuckEvent>): FeelStuckEvent => ({
    startSec: 0,
    triggeredSec: 1.5,
    endSec: 2,
    durationSec: 2,
    recoverySec: 0.5,
    cause: 'unknown',
    recovered: true,
    endReason: 'recovered',
    x: 0,
    z: 0,
    ...over,
  });

  it('keys off recoverySec — a quick escape after the 1.5 s dwell is NOT unrecoverable', () => {
    // The literal "durationSec > 1" reading would flag this, because the detector's own dwell
    // already puts every event past 1.5 s. See the function's doc comment.
    expect(event({}).durationSec).toBeGreaterThan(1);
    expect(isUnrecoverableStuck(event({}), 1)).toBe(false);
  });

  it('flags an escape that took longer than the threshold', () => {
    expect(isUnrecoverableStuck(event({ recoverySec: 1.4 }), 1)).toBe(true);
  });

  it('flags anything that never recovered, however short', () => {
    expect(isUnrecoverableStuck(event({ recovered: false, recoverySec: 0.1 }), 1)).toBe(true);
  });
});

// =============================================================================================
// buildFeelSample
// =============================================================================================

describe('buildFeelSample', () => {
  const vehicle = (over: Partial<Parameters<typeof buildFeelSample>[0]['vehicle']> = {}) => ({
    position: { x: 5, y: REST_Y, z: -3 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    velocity: { x: 0, y: 0, z: 12 },
    speedMps: 12,
    forwardSpeedMps: 12,
    upright: true,
    wheels: [
      { steerAngle: 0.2, inContact: true },
      { steerAngle: -0.35, inContact: true },
      { steerAngle: 0, inContact: false },
      { steerAngle: 0, inContact: true },
    ],
    ...over,
  });
  const input = { steer: 0.5, throttle: 1, brake: 0, handbrake: false };

  it('derives planar speed, wheel counts and the largest applied steer magnitude', () => {
    const s = buildFeelSample({ tSec: 1, dtSec: 0.1, prevYawRad: null, vehicle: vehicle(), input, car: testCar() });
    expect(s.planarSpeedMps).toBeCloseTo(12, 10);
    expect(s.wheelsInContact).toBe(3);
    expect(s.wheelCount).toBe(4);
    expect(s.appliedSteerRad).toBeCloseTo(0.35, 10);
  });

  it('measures the steer clamp against vehicles/steering.ts, not a local copy', () => {
    const car = testCar();
    const s = buildFeelSample({ tSec: 1, dtSec: 0.1, prevYawRad: null, vehicle: vehicle(), input, car });
    expect(s.steerClampLimitRad).toBeCloseTo(steerClampRad(12, car.topSpeedMps, car.steering), 12);
  });

  it('computes lateral speed in the chassis frame via skidMath', () => {
    // Facing +X (yaw +π/2) while moving along +Z: all of that velocity is sideways.
    const yaw = Math.PI / 2;
    const s = buildFeelSample({
      tSec: 1,
      dtSec: 0.1,
      prevYawRad: null,
      vehicle: vehicle({ rotation: { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) } }),
      input,
      car: testCar(),
    });
    expect(s.yawRad).toBeCloseTo(yaw, 10);
    expect(Math.abs(s.lateralSpeedMps)).toBeCloseTo(12, 6);
  });

  it('reports zero yaw rate on the first sample and a real one afterwards', () => {
    const yaw = 0.3;
    const rotation = { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
    const first = buildFeelSample({
      tSec: 1,
      dtSec: 0.1,
      prevYawRad: null,
      vehicle: vehicle({ rotation }),
      input,
      car: testCar(),
    });
    expect(first.yawRateRadS).toBe(0);
    const second = buildFeelSample({
      tSec: 1.1,
      dtSec: 0.1,
      prevYawRad: 0.2,
      vehicle: vehicle({ rotation }),
      input,
      car: testCar(),
    });
    expect(second.yawRateRadS).toBeCloseTo(1, 6);
  });

  it('copies the input reading rather than aliasing it (getDrivingInput reuses its object)', () => {
    const live = { steer: 0.5, throttle: 1, brake: 0, handbrake: false };
    const s = buildFeelSample({ tSec: 1, dtSec: 0.1, prevYawRad: null, vehicle: vehicle(), input: live, car: testCar() });
    live.steer = -1;
    live.throttle = 0;
    expect(s.steerInput).toBe(0.5);
    expect(s.throttle).toBe(1);
  });
});

// =============================================================================================
// Accumulator — timing + the stall gate
// =============================================================================================

describe('accumulateSample timing', () => {
  it('integrates dt rather than counting frames, and tracks the dt band', () => {
    const acc = createFeelAccumulator(testCar());
    const d = makeDriver(acc, 0.05);
    d.run(10, {});
    accumulateSample(acc, { ...BASE_SAMPLE, tSec: d.now() + 0.2, dtSec: 0.2 });
    const snap = summarizeFeel(acc);
    expect(snap.timing.samples).toBe(11);
    expect(snap.timing.elapsedSec).toBeCloseTo(0.7, 10);
    expect(snap.timing.minDtSec).toBeCloseTo(0.05, 10);
    expect(snap.timing.maxDtSec).toBeCloseTo(0.2, 10);
    expect(snap.timing.meanDtSec).toBeCloseTo(0.7 / 11, 10);
  });

  it('excludes a stalled frame from every integral and counts it separately', () => {
    const acc = createFeelAccumulator(testCar());
    const d = makeDriver(acc);
    d.run(5, { planarSpeedMps: 10 });
    accumulateSample(acc, { ...BASE_SAMPLE, tSec: 2, dtSec: 1.5, planarSpeedMps: 10 });
    d.run(5, { planarSpeedMps: 10 });
    const snap = summarizeFeel(acc);
    expect(snap.timing.stalledSamples).toBe(1);
    expect(snap.timing.samples).toBe(10);
    expect(snap.timing.elapsedSec).toBeCloseTo(1.0, 10);
    expect(snap.notes.some((n) => n.includes('stall'))).toBe(true);
  });

  it('abandons a response window in flight across a stall instead of corrupting it', () => {
    const acc = createFeelAccumulator(testCar());
    const d = makeDriver(acc);
    d.push({ throttle: 1, forwardSpeedMps: 0 });
    d.push({ throttle: 1, forwardSpeedMps: 4 });
    accumulateSample(acc, { ...BASE_SAMPLE, tSec: 3, dtSec: 2.5, throttle: 1, forwardSpeedMps: 24 });
    const snap = summarizeFeel(acc);
    expect(snap.response.launches).toHaveLength(1);
    expect(snap.response.launches[0].endReason).toBe('stall');
    expect(snap.response.t90Sec).toBeNull();
  });

  it('excludes a teleport from travelled distance and abandons the brake measurement', () => {
    const acc = createFeelAccumulator(testCar());
    const d = makeDriver(acc);
    d.push({ planarSpeedMps: 20, x: 0, brake: 0 });
    d.push({ planarSpeedMps: 20, x: 2, brake: 1 });
    d.push({ planarSpeedMps: 20, x: 900, brake: 1 }); // probe reset
    const snap = summarizeFeel(acc);
    expect(snap.timing.teleportSkips).toBe(1);
    expect(snap.timing.distanceM).toBeCloseTo(2, 10);
    expect(snap.response.brakes[0].endReason).toBe('teleport');
    expect(snap.notes.some((n) => n.includes('teleport'))).toBe(true);
  });
});

// =============================================================================================
// Accumulator — response
// =============================================================================================

describe('response: launch', () => {
  /** Throttle held from a standstill, forward speed ramping 1 m/s per 0.1 s frame. */
  function rampLaunch(acc: FeelAccumulator, frames: number): void {
    makeDriver(acc).run(frames, (i) => ({
      throttle: 1,
      forwardSpeedMps: i - 1,
      planarSpeedMps: i - 1,
      x: (i - 1) * 0.1,
    }));
  }

  it('times 50 % and 90 % of the car`s RESOLVED top speed from the throttle edge', () => {
    const acc = createFeelAccumulator(testCar()); // topSpeed 25 ⇒ 12.5 and 22.5 m/s
    rampLaunch(acc, 30);
    const snap = summarizeFeel(acc);
    // Edge at t=0.1 (speed 0). First frame ≥12.5 is i=14 (speed 13, t=1.4) ⇒ 1.3 s.
    // First frame ≥22.5 is i=24 (speed 23, t=2.4) ⇒ 2.3 s.
    expect(snap.response.t50Sec).toBeCloseTo(1.3, 6);
    expect(snap.response.t90Sec).toBeCloseTo(2.3, 6);
    expect(snap.response.launches[0].endReason).toBe('reached90');
  });

  it('scales with the car, not with a hardcoded 25 m/s', () => {
    const acc = createFeelAccumulator(testCar({ topSpeedMps: 10 })); // 90 % ⇒ 9 m/s
    rampLaunch(acc, 30);
    expect(summarizeFeel(acc).response.t90Sec).toBeCloseTo(0.9, 6);
  });

  it('records a released launch as incomplete instead of guessing its t90', () => {
    const acc = createFeelAccumulator(testCar());
    const d = makeDriver(acc);
    d.run(14, (i) => ({ throttle: 1, forwardSpeedMps: i - 1, planarSpeedMps: i - 1 }));
    d.run(3, { throttle: 0, forwardSpeedMps: 13, planarSpeedMps: 13 });
    const snap = summarizeFeel(acc);
    expect(snap.response.launches).toHaveLength(1);
    expect(snap.response.launches[0].endReason).toBe('released');
    expect(snap.response.launches[0].t50Sec).toBeCloseTo(1.3, 6);
    expect(snap.response.t90Sec).toBeNull();
  });

  it('excludes a ROLLING start from the headline while still recording the event', () => {
    const acc = createFeelAccumulator(testCar());
    makeDriver(acc).run(30, (i) => ({ throttle: 1, forwardSpeedMps: 10 + i, planarSpeedMps: 10 + i }));
    const snap = summarizeFeel(acc);
    expect(snap.response.launchCount).toBe(1);
    expect(snap.response.qualifiedLaunchCount).toBe(0);
    expect(snap.response.t90Sec).toBeNull();
  });

  it('reports the BEST of several qualifying launches', () => {
    const acc = createFeelAccumulator(testCar());
    const d = makeDriver(acc);
    // Slow launch: 0.5 m/s per frame.
    d.run(60, (i) => ({ throttle: 1, forwardSpeedMps: (i - 1) * 0.5, planarSpeedMps: (i - 1) * 0.5 }));
    d.run(5, { throttle: 0 });
    // Fast launch: 2 m/s per frame.
    d.run(20, (i) => ({ throttle: 1, forwardSpeedMps: (i - 1) * 2, planarSpeedMps: (i - 1) * 2 }));
    const snap = summarizeFeel(acc);
    expect(snap.response.qualifiedLaunchCount).toBe(2);
    expect(snap.response.t90Sec).toBeCloseTo(1.2, 6); // 22.5 / 2 m/s per frame ⇒ frame 13
  });

  it('abandons a launch that never gets there', () => {
    const acc = createFeelAccumulator(testCar(), tuned({ launchTimeoutSec: 1 }));
    makeDriver(acc).run(30, { throttle: 1, forwardSpeedMps: 3, planarSpeedMps: 3 });
    const snap = summarizeFeel(acc);
    expect(snap.response.launches[0].endReason).toBe('timeout');
  });
});

describe('response: braking', () => {
  const SPEEDS = [22, 20, 18, 16, 14, 12, 10, 8, 6, 4, 2, 0.5];

  function brakeRun(acc: FeelAccumulator): void {
    const d = makeDriver(acc);
    let x = 0;
    d.push({ planarSpeedMps: 24, brake: 0, x });
    for (const v of SPEEDS) {
      x = Math.round((x + v * 0.1) * 1e6) / 1e6;
      d.push({ planarSpeedMps: v, brake: 1, x });
    }
  }

  it('measures distance and time from the pedal edge to the brake-to-reverse speed', () => {
    const acc = createFeelAccumulator(testCar());
    brakeRun(acc);
    const expectedDist = SPEEDS.reduce((sum, v) => sum + v * 0.1, 0);
    const snap = summarizeFeel(acc);
    expect(snap.response.brakeStartSpeedMps).toBeCloseTo(24, 10);
    expect(snap.response.brakeDistM).toBeCloseTo(expectedDist, 6);
    // Edge frame t=0.2, stop frame t=1.3 (the 0.5 m/s sample, below brakeStopSpeedMps 1).
    expect(snap.response.brakeSec).toBeCloseTo(1.1, 6);
    expect(snap.response.brakes[0].endReason).toBe('stopped');
  });

  it('flags whether the stop qualified (≥95 % of top speed)', () => {
    const fast = createFeelAccumulator(testCar());
    brakeRun(fast);
    expect(summarizeFeel(fast).response.brakeQualified).toBe(true);

    const slow = createFeelAccumulator(testCar({ topSpeedMps: 40 }));
    brakeRun(slow);
    const snap = summarizeFeel(slow);
    expect(snap.response.brakeQualified).toBe(false);
    // Still reported, with the speed it was actually measured from — never silently dropped.
    expect(snap.response.brakeDistM).not.toBeNull();
    expect(snap.response.brakeStartSpeedMps).toBeCloseTo(24, 10);
  });

  it('does not report a released (incomplete) brake as a stop', () => {
    const acc = createFeelAccumulator(testCar());
    const d = makeDriver(acc);
    d.push({ planarSpeedMps: 24, brake: 0, x: 0 });
    d.push({ planarSpeedMps: 20, brake: 1, x: 2 });
    d.push({ planarSpeedMps: 18, brake: 0, x: 3.8 });
    const snap = summarizeFeel(acc);
    expect(snap.response.brakes[0].endReason).toBe('released');
    expect(snap.response.brakeDistM).toBeNull();
  });
});

describe('response: steer → peak yaw rate', () => {
  it('times the peak from the steer edge', () => {
    const acc = createFeelAccumulator(testCar());
    const d = makeDriver(acc);
    const rates = [0.1, 0.4, 0.8, 1.1, 0.9, 0.85];
    d.push({ steerInput: 0, yawRateRadS: 0, planarSpeedMps: 12 });
    for (const r of rates) d.push({ steerInput: 1, yawRateRadS: r, planarSpeedMps: 12 });
    d.push({ steerInput: 0, yawRateRadS: 0.2, planarSpeedMps: 12 });
    const snap = summarizeFeel(acc);
    expect(snap.response.peakYawRateRadS).toBeCloseTo(1.1, 10);
    // Edge at t=0.2, peak at t=0.5.
    expect(snap.response.steerToPeakYawSec).toBeCloseTo(0.3, 6);
    expect(snap.response.steerResponses[0].endReason).toBe('released');
  });

  it('takes the magnitude, so a left-hand corner counts the same as a right', () => {
    const acc = createFeelAccumulator(testCar());
    const d = makeDriver(acc);
    d.push({ steerInput: 0 });
    d.push({ steerInput: -1, yawRateRadS: -0.6 });
    d.push({ steerInput: -1, yawRateRadS: -1.4 });
    d.push({ steerInput: 0 });
    const snap = summarizeFeel(acc);
    expect(snap.response.peakYawRateRadS).toBeCloseTo(1.4, 10);
  });

  it('closes a held-forever window on its own ceiling', () => {
    const acc = createFeelAccumulator(testCar(), tuned({ steerResponseWindowSec: 0.3 }));
    makeDriver(acc).run(10, { steerInput: 1, yawRateRadS: 0.5 });
    expect(summarizeFeel(acc).response.steerResponses[0].endReason).toBe('timeout');
  });

  it('reports an open window without closing it in the accumulator', () => {
    const acc = createFeelAccumulator(testCar());
    const d = makeDriver(acc);
    d.push({ steerInput: 0 });
    d.push({ steerInput: 1, yawRateRadS: 0.9 });
    const snap = summarizeFeel(acc);
    expect(snap.response.steerResponses).toHaveLength(1);
    expect(snap.response.steerResponses[0].endReason).toBe('open');
    expect(acc.steerOpen).not.toBeNull();
  });
});

// =============================================================================================
// Accumulator — cornering
// =============================================================================================

describe('cornering', () => {
  /** A perfect circle: constant speed, constant yaw rate, full lock held. R = v / ω. */
  function circle(acc: FeelAccumulator, seconds: number, speed: number, yawRate: number): void {
    makeDriver(acc).run(Math.round(seconds / 0.1), {
      steerInput: 1,
      planarSpeedMps: speed,
      speedMps: speed,
      yawRateRadS: yawRate,
      wheelsInContact: 4,
    });
  }

  it('measures the steady-state radius as arc ÷ swept angle', () => {
    const acc = createFeelAccumulator(testCar());
    circle(acc, 3, 10, 0.5); // R = 20 m, bucket 4 ([10, 12.5) m/s)
    const snap = summarizeFeel(acc);
    expect(turnRadiusAtSpeedM(snap, 10)).toBeCloseTo(20, 6);
    expect(snap.cornering.buckets[4].meanSpeedMps).toBeCloseTo(10, 6);
    expect(snap.cornering.buckets[4].meanYawRateRadS).toBeCloseTo(0.5, 6);
  });

  it('rejects the turn-in transient: only post-settle time counts as steady arc', () => {
    const acc = createFeelAccumulator(testCar()); // steadySettleSec 0.6
    circle(acc, 2, 10, 0.5);
    const snap = summarizeFeel(acc);
    // 2.0 s of full lock, the first 0.6 s excluded ⇒ ~1.4 s of arc (±1 frame).
    expect(snap.cornering.buckets[4].steadyTimeSec).toBeCloseTo(1.4, 1);
    expect(snap.cornering.buckets[4].steadyTimeSec).toBeLessThan(2);
  });

  it('reports no radius at all when there is not enough settled evidence', () => {
    const acc = createFeelAccumulator(testCar());
    circle(acc, 0.4, 10, 0.5); // shorter than the settle window
    const snap = summarizeFeel(acc);
    expect(snap.cornering.buckets[4].steadyTimeSec).toBe(0);
    expect(turnRadiusAtSpeedM(snap, 10)).toBeNull();
  });

  it('restarts the settle clock when the lock flips sign (a slalom is not one corner)', () => {
    const acc = createFeelAccumulator(testCar());
    const d = makeDriver(acc);
    d.run(10, { steerInput: 1, planarSpeedMps: 10, yawRateRadS: 0.5 }); // 1.0 s ⇒ 0.4 s steady
    d.run(4, { steerInput: -1, planarSpeedMps: 10, yawRateRadS: -0.5 }); // 0.4 s ⇒ none steady
    const snap = summarizeFeel(acc);
    expect(snap.cornering.buckets[4].steadyTimeSec).toBeCloseTo(0.4, 1);
  });

  it('ignores near-straight and airborne samples in the arc', () => {
    const acc = createFeelAccumulator(testCar());
    const d = makeDriver(acc);
    d.run(20, { steerInput: 1, planarSpeedMps: 10, yawRateRadS: 0.5 });
    const steadyBefore = summarizeFeel(acc).cornering.buckets[4].steadyTimeSec;
    d.run(10, { steerInput: 1, planarSpeedMps: 10, yawRateRadS: 0.01 }); // below the yaw floor
    d.run(10, { steerInput: 1, planarSpeedMps: 10, yawRateRadS: 0.5, wheelsInContact: 0 }); // airborne
    const snap = summarizeFeel(acc);
    expect(snap.cornering.buckets[4].steadyTimeSec).toBeCloseTo(steadyBefore, 6);
    expect(turnRadiusAtSpeedM(snap, 10)).toBeCloseTo(20, 6);
  });

  it('builds the yaw-rate-vs-speed curve in the configured buckets', () => {
    const acc = createFeelAccumulator(testCar());
    const d = makeDriver(acc);
    d.run(10, { planarSpeedMps: 4, yawRateRadS: 1.0 }); // bucket 1 [2.5, 5)
    d.run(10, { planarSpeedMps: 16, yawRateRadS: 0.4 }); // bucket 6 [15, 17.5)
    const snap = summarizeFeel(acc);
    expect(snap.cornering.bucketWidthMps).toBe(FEEL_TELEMETRY_DEFAULTS.bucketWidthMps);
    expect(snap.cornering.buckets[1].meanYawRateRadS).toBeCloseTo(1.0, 6);
    expect(snap.cornering.buckets[6].meanYawRateRadS).toBeCloseTo(0.4, 6);
    expect(snap.cornering.buckets[1].timeSec).toBeCloseTo(1, 6);
  });

  it('measures lateral slip through the SHIPPED skid trigger, handbrake excluded', () => {
    const acc = createFeelAccumulator(testCar(), tuned({ slipThresholdMps: 3.5, slipMaxMps: 9 }));
    const d = makeDriver(acc);
    d.run(10, { lateralSpeedMps: 1 }); // under the threshold
    d.run(10, { lateralSpeedMps: 6.25 }); // half-way to saturation ⇒ slip01 0.5
    d.run(10, { lateralSpeedMps: 0, handbrake: true }); // held button, no slide ⇒ not slipping
    const snap = summarizeFeel(acc);
    expect(snap.cornering.slipSec).toBeCloseTo(1, 6);
    expect(snap.cornering.lateralSlipFrac).toBeCloseTo(1 / 3, 6);
    expect(snap.cornering.meanSlip01).toBeCloseTo(0.5 / 3, 6);
  });

  it('reports the steer-clamp FRAME ratio next to its denominator', () => {
    const acc = createFeelAccumulator(testCar());
    const d = makeDriver(acc);
    d.run(6, { appliedSteerRad: 0.7, steerClampLimitRad: 0.7 }); // at the clamp
    d.run(14, { appliedSteerRad: 0.2, steerClampLimitRad: 0.7 }); // well under
    const snap = summarizeFeel(acc);
    expect(snap.cornering.steerClampFrames).toBe(6);
    expect(snap.cornering.frames).toBe(20);
    expect(snap.cornering.steerClampFrac).toBeCloseTo(0.3, 10);
  });
});

// =============================================================================================
// Accumulator — contacts
// =============================================================================================

describe('contacts', () => {
  it('coalesces repeat records against one collider into a single event', () => {
    const acc = createFeelAccumulator(testCar());
    for (const tSec of [1.0, 1.05, 1.1, 1.15]) {
      accumulateImpact(acc, { tSec, handle: 7, kind: 'building', forceMagN: 4000 });
    }
    const snap = summarizeFeel(acc);
    expect(snap.contact.records).toBe(4);
    expect(snap.contact.events).toBe(1);
  });

  it('opens a new event once the debounce window has passed', () => {
    const acc = createFeelAccumulator(testCar());
    accumulateImpact(acc, { tSec: 1.0, handle: 7, kind: 'building', forceMagN: 4000 });
    accumulateImpact(acc, { tSec: 1.4, handle: 7, kind: 'building', forceMagN: 4000 });
    expect(summarizeFeel(acc).contact.events).toBe(2);
  });

  it('debounces per collider, not globally', () => {
    const acc = createFeelAccumulator(testCar());
    accumulateImpact(acc, { tSec: 1.0, handle: 7, kind: 'building', forceMagN: 1 });
    accumulateImpact(acc, { tSec: 1.01, handle: 8, kind: 'civilian', forceMagN: 1 });
    const snap = summarizeFeel(acc);
    expect(snap.contact.events).toBe(2);
  });

  it('normalizes per kind, per minute, over the integrated window', () => {
    const acc = createFeelAccumulator(testCar());
    const d = makeDriver(acc);
    d.run(10, { planarSpeedMps: 10 }); // 1.0 s
    accumulateImpact(acc, { tSec: 0.3, handle: 1, kind: 'civilian', forceMagN: 100 });
    accumulateImpact(acc, { tSec: 0.6, handle: 2, kind: 'civilian', forceMagN: 300 });
    accumulateImpact(acc, { tSec: 0.9, handle: 3, kind: 'building', forceMagN: 900 });
    d.run(10, { planarSpeedMps: 10 }); // 2.0 s total
    const snap = summarizeFeel(acc);
    expect(snap.timing.elapsedSec).toBeCloseTo(2, 10);
    expect(snap.contact.eventsPerMin).toBeCloseTo(90, 6);
    const civ = snap.contact.byKind.find((k) => k.kind === 'civilian');
    expect(civ?.events).toBe(2);
    expect(civ?.eventsPerMin).toBeCloseTo(60, 6);
    expect(civ?.meanForceMagN).toBeCloseTo(200, 6);
    expect(civ?.maxForceMagN).toBeCloseTo(300, 6);
    // Rows only for kinds actually contacted, in FEEL_CONTACT_KINDS order (an absent kind is 0).
    expect(snap.contact.byKind.map((k) => k.kind)).toEqual(['civilian', 'building']);
    expect(snap.contact.byKind.find((k) => k.kind === 'water')).toBeUndefined();
  });

  it('attributes the frame`s speed delta ONCE, to the highest-force counterpart', () => {
    const acc = createFeelAccumulator(testCar());
    const d = makeDriver(acc);
    d.push({ planarSpeedMps: 10, x: 0 });
    accumulateImpact(acc, { tSec: 0.15, handle: 1, kind: 'civilian', forceMagN: 200 });
    accumulateImpact(acc, { tSec: 0.15, handle: 2, kind: 'building', forceMagN: 9000 });
    accumulateImpact(acc, { tSec: 0.16, handle: 3, kind: 'propStatic', forceMagN: 50 });
    d.push({ planarSpeedMps: 6, x: 0.8 });
    const snap = summarizeFeel(acc);
    expect(snap.contact.records).toBe(3);
    expect(snap.contact.contactFrames).toBe(1);
    expect(snap.contact.meanSpeedLossMps).toBeCloseTo(4, 6);
    expect(snap.contact.maxSpeedLossMps).toBeCloseTo(4, 6);
    expect(snap.contact.byKind.find((k) => k.kind === 'building')?.meanSpeedLossMps).toBeCloseTo(4, 6);
    expect(snap.contact.byKind.find((k) => k.kind === 'civilian')?.meanSpeedLossMps).toBe(0);
  });

  it('records a signed delta, so a shove that ADDS speed is not read as a loss', () => {
    const acc = createFeelAccumulator(testCar());
    const d = makeDriver(acc);
    d.push({ planarSpeedMps: 5, x: 0 });
    accumulateImpact(acc, { tSec: 0.15, handle: 1, kind: 'pursuit', forceMagN: 5000 });
    d.push({ planarSpeedMps: 9, x: 0.7 });
    expect(summarizeFeel(acc).contact.meanSpeedLossMps).toBeCloseTo(-4, 6);
  });
});

// =============================================================================================
// Accumulator — the stuck detector (P77's oracle)
// =============================================================================================

describe('stuck detector', () => {
  /** 1.0 s of normal driving (which also teaches the rest-height baseline), then `frames`
   * of the given immobile condition. */
  function drive(acc: FeelAccumulator) {
    const d = makeDriver(acc);
    d.run(10, (i) => ({ planarSpeedMps: 8, speedMps: 8, throttle: 1, x: i * 0.8 }));
    return d;
  }

  const IMMOBILE = { planarSpeedMps: 0.1, speedMps: 0.1, throttle: 1, x: 8 };

  it('declares an event after the dwell, with throttle held', () => {
    const acc = createFeelAccumulator(testCar());
    const d = drive(acc);
    d.run(20, IMMOBILE); // 2.0 s immobile
    const snap = summarizeFeel(acc);
    expect(snap.stuck.count).toBe(1);
    const event = snap.stuck.events[0];
    // The immobile window opens at t=1.0 (the start of the first slow frame's slice); the
    // detector declares at 1.0 + 1.5.
    expect(event.startSec).toBeCloseTo(1.0, 6);
    expect(event.triggeredSec).toBeCloseTo(2.5, 6);
    expect(event.endReason).toBe('open');
    expect(event.recovered).toBe(false);
  });

  it('does NOT fire when the player is not asking the car to move', () => {
    const acc = createFeelAccumulator(testCar());
    const d = drive(acc);
    d.run(40, { ...IMMOBILE, throttle: 0 });
    expect(summarizeFeel(acc).stuck.count).toBe(0);
  });

  it('needs a SUSTAINED dwell — a brief crawl through a junction is not stuck', () => {
    const acc = createFeelAccumulator(testCar());
    const d = drive(acc);
    d.run(10, IMMOBILE); // 1.0 s, under the 1.5 s dwell
    d.run(10, { planarSpeedMps: 8, throttle: 1 });
    expect(summarizeFeel(acc).stuck.count).toBe(0);
  });

  it('measures duration from the immobile start and recovery from the declaration', () => {
    const acc = createFeelAccumulator(testCar());
    const d = drive(acc);
    d.run(20, IMMOBILE); // declared at 2.5, still stuck until 3.0
    d.run(2, { planarSpeedMps: 4, throttle: 1, x: 9 }); // escape at t=3.1
    const event = summarizeFeel(acc).stuck.events[0];
    expect(event.endSec).toBeCloseTo(3.1, 6);
    expect(event.durationSec).toBeCloseTo(2.1, 6);
    expect(event.recoverySec).toBeCloseTo(0.6, 6);
    expect(event.recovered).toBe(true);
    expect(event.endReason).toBe('recovered');
  });

  it('splits recoverable from unrecoverable on recoverySec, not on the dwell', () => {
    const quick = createFeelAccumulator(testCar());
    const qd = drive(quick);
    qd.run(16, IMMOBILE); // declared at 2.5, escapes at 2.7
    qd.run(2, { planarSpeedMps: 4, throttle: 1 });
    const quickSnap = summarizeFeel(quick);
    expect(quickSnap.stuck.count).toBe(1);
    expect(quickSnap.stuck.events[0].durationSec).toBeGreaterThan(1);
    expect(quickSnap.stuck.unrecoverableCount).toBe(0);

    const bad = createFeelAccumulator(testCar());
    const bd = drive(bad);
    bd.run(40, IMMOBILE); // 2.5 s past the declaration
    bd.run(2, { planarSpeedMps: 4, throttle: 1 });
    const badSnap = summarizeFeel(bad);
    expect(badSnap.stuck.events[0].recoverySec).toBeGreaterThan(1);
    expect(badSnap.stuck.unrecoverableCount).toBe(1);
  });

  it('needs to clear the hysteresis band, not merely the immobile threshold', () => {
    const acc = createFeelAccumulator(testCar());
    const d = drive(acc);
    d.run(20, IMMOBILE);
    d.run(10, { planarSpeedMps: 0.8, throttle: 1 }); // jittering on a kerb, still not moving
    const snap = summarizeFeel(acc);
    expect(snap.stuck.count).toBe(1);
    expect(snap.stuck.events[0].endReason).toBe('open');
  });

  it('closes as abandoned when the player stops trying, and counts that as unrecoverable', () => {
    const acc = createFeelAccumulator(testCar());
    const d = drive(acc);
    d.run(20, IMMOBILE);
    d.run(10, { ...IMMOBILE, throttle: 0 });
    const snap = summarizeFeel(acc);
    expect(snap.stuck.events[0].endReason).toBe('abandoned');
    expect(snap.stuck.events[0].recovered).toBe(false);
    expect(snap.stuck.unrecoverableCount).toBe(1);
  });

  it('reports an unresolved event at read time without closing it', () => {
    const acc = createFeelAccumulator(testCar());
    const d = drive(acc);
    d.run(20, IMMOBILE);
    const first = summarizeFeel(acc);
    expect(first.stuck.events[0].endReason).toBe('open');
    expect(acc.stuckOpen).not.toBeNull();
    d.run(10, IMMOBILE);
    const second = summarizeFeel(acc);
    expect(second.stuck.count).toBe(1);
    expect(second.stuck.events[0].durationSec).toBeGreaterThan(first.stuck.events[0].durationSec);
  });

  it('counts and totals repeated events', () => {
    const acc = createFeelAccumulator(testCar());
    const d = drive(acc);
    d.run(20, IMMOBILE);
    d.run(5, { planarSpeedMps: 6, throttle: 1 });
    d.run(20, IMMOBILE);
    d.run(5, { planarSpeedMps: 6, throttle: 1 });
    const snap = summarizeFeel(acc);
    expect(snap.stuck.count).toBe(2);
    expect(snap.stuck.totalStuckSec).toBeCloseTo(snap.stuck.events.reduce((s, e) => s + e.durationSec, 0), 10);
    expect(snap.stuck.longestSec).toBeGreaterThan(0);
  });

  it('tags the cause from the impact history and reports the cause histogram', () => {
    const acc = createFeelAccumulator(testCar());
    const d = drive(acc);
    accumulateImpact(acc, { tSec: 0.95, handle: 4, kind: 'building', forceMagN: 8000 });
    d.run(20, IMMOBILE);
    const snap = summarizeFeel(acc);
    expect(snap.stuck.events[0].cause).toBe('building');
    // Observed causes only — no row of zeros for the four causes that did not happen.
    expect(snap.stuck.byCause).toEqual([{ cause: 'building', count: 1 }]);
  });

  it('tags onVehicle from the learned rest height even with vehicle impacts on record', () => {
    const acc = createFeelAccumulator(testCar());
    const d = drive(acc);
    accumulateImpact(acc, { tSec: 0.95, handle: 4, kind: 'civilian', forceMagN: 6000 });
    d.run(20, { ...IMMOBILE, y: REST_Y + 1.1 });
    const snap = summarizeFeel(acc);
    expect(snap.stuck.restHeightY).toBeCloseTo(REST_Y, 6);
    expect(snap.stuck.events[0].cause).toBe('onVehicle');
  });

  it('records WHERE it happened so the battery can go and look', () => {
    const acc = createFeelAccumulator(testCar());
    const d = drive(acc);
    d.run(20, { ...IMMOBILE, x: 1500, z: -420 });
    const event = summarizeFeel(acc).stuck.events[0];
    expect(event.x).toBeCloseTo(1500, 6);
    expect(event.z).toBeCloseTo(-420, 6);
  });

  it('notes when no rest height was ever learned, so onVehicle could not fire', () => {
    const acc = createFeelAccumulator(testCar());
    makeDriver(acc).run(30, IMMOBILE); // never drove ⇒ no baseline
    const snap = summarizeFeel(acc);
    expect(snap.stuck.restHeightY).toBeNull();
    expect(snap.stuck.count).toBe(1);
    expect(snap.notes.some((n) => n.includes('onVehicle'))).toBe(true);
  });
});

// =============================================================================================
// Accumulator — airtime and stability
// =============================================================================================

describe('airtime and stability', () => {
  it('reports airtime as both a time integral and a frame ratio with its denominator', () => {
    const acc = createFeelAccumulator(testCar());
    const d = makeDriver(acc);
    d.run(18, { wheelsInContact: 4 });
    d.run(2, { wheelsInContact: 0 });
    const snap = summarizeFeel(acc);
    expect(snap.stability.airborneFrames).toBe(2);
    expect(snap.stability.frames).toBe(20);
    expect(snap.stability.airtimeFrac).toBeCloseTo(0.1, 10);
    expect(snap.stability.airtimeSec).toBeCloseTo(0.2, 10);
  });

  it('tracks roll and pitch peaks as magnitudes', () => {
    const acc = createFeelAccumulator(testCar());
    const d = makeDriver(acc);
    d.run(3, { rollRad: 0.2, pitchRad: -0.4 });
    d.run(3, { rollRad: -0.9, pitchRad: 0.1 });
    const snap = summarizeFeel(acc);
    expect(snap.stability.rollPeakRad).toBeCloseTo(0.9, 10);
    expect(snap.stability.pitchPeakRad).toBeCloseTo(0.4, 10);
  });

  it('counts a flip only once it is SUSTAINED, and measures how long it lasted', () => {
    const acc = createFeelAccumulator(testCar());
    const d = makeDriver(acc);
    d.run(3, { upright: false }); // 0.3 s — a big kerb hit, not a flip
    d.run(3, { upright: true });
    expect(summarizeFeel(acc).stability.flipCount).toBe(0);
    d.run(10, { upright: false }); // 1.0 s — a flip
    d.run(3, { upright: true });
    const snap = summarizeFeel(acc);
    expect(snap.stability.flipCount).toBe(1);
    expect(snap.stability.flipEvents[0].resolved).toBe(true);
    // 10 non-upright slices of 0.1 s, and the car was upright again by the next sample — so the
    // true duration is somewhere in [1.0, 1.1] and the recovery frame's own timestamp (the upper
    // bound) is what gets recorded. That one-frame band is the sampler's quantization, declared
    // by `timing.maxDtSec`, not an error.
    expect(snap.stability.flipEvents[0].durationSec).toBeGreaterThanOrEqual(1.0);
    expect(snap.stability.flipEvents[0].durationSec).toBeLessThanOrEqual(1.1 + 1e-9);
  });

  it('reports a flip that never recovered as unresolved', () => {
    const acc = createFeelAccumulator(testCar());
    makeDriver(acc).run(10, { upright: false });
    const snap = summarizeFeel(acc);
    expect(snap.stability.flipCount).toBe(1);
    expect(snap.stability.flipEvents[0].resolved).toBe(false);
  });
});

// =============================================================================================
// Snapshot behaviour
// =============================================================================================

describe('summarizeFeel', () => {
  it('is read-only: two consecutive reads are identical and accumulation continues', () => {
    const acc = createFeelAccumulator(testCar());
    const d = makeDriver(acc);
    d.push({ throttle: 1, forwardSpeedMps: 1, planarSpeedMps: 1, steerInput: 1, yawRateRadS: 0.4 });
    d.push({ throttle: 1, forwardSpeedMps: 2, planarSpeedMps: 2, steerInput: 1, yawRateRadS: 0.6 });
    const a = summarizeFeel(acc);
    const b = summarizeFeel(acc);
    expect(b).toEqual(a);
    d.push({ throttle: 1, forwardSpeedMps: 3, planarSpeedMps: 3, steerInput: 1, yawRateRadS: 0.8 });
    expect(summarizeFeel(acc).timing.samples).toBe(a.timing.samples + 1);
  });

  it('is JSON-serializable end to end (page.evaluate must round-trip it)', () => {
    const acc = createFeelAccumulator(testCar());
    const d = makeDriver(acc);
    d.run(5, { planarSpeedMps: 10, steerInput: 1, yawRateRadS: 0.5 });
    accumulateImpact(acc, { tSec: 0.3, handle: 2, kind: 'civilian', forceMagN: 100 });
    d.run(5, { planarSpeedMps: 10 });
    const snap = summarizeFeel(acc);
    expect(JSON.parse(JSON.stringify(snap))).toEqual(snap);
    expect(snap.schema).toBe(FEEL_TELEMETRY_SCHEMA);
  });

  it('reports an empty session honestly rather than with NaNs', () => {
    const snap = summarizeFeel(createFeelAccumulator(testCar()));
    expect(snap.timing.samples).toBe(0);
    expect(snap.timing.minDtSec).toBe(0);
    expect(snap.cornering.steerClampFrac).toBe(0);
    expect(snap.contact.eventsPerMin).toBe(0);
    expect(snap.response.t90Sec).toBeNull();
    expect(snap.notes.some((n) => n.includes('no samples'))).toBe(true);
  });

  it('caps event arrays and says so instead of silently truncating', () => {
    const acc = createFeelAccumulator(testCar(), tuned({ maxEvents: 2 }));
    const d = makeDriver(acc);
    for (let i = 0; i < 5; i++) {
      d.run(10, { upright: false });
      d.run(2, { upright: true });
    }
    const snap = summarizeFeel(acc);
    expect(snap.stability.flipEvents).toHaveLength(2);
    expect(snap.timing.droppedEvents).toBe(3);
    expect(snap.notes.some((n) => n.includes('dropped'))).toBe(true);
  });

  it('carries the car parameters every metric was normalized against', () => {
    const snap = summarizeFeel(createFeelAccumulator(testCar({ id: 'schoolBus', topSpeedMps: 18 })));
    expect(snap.car.id).toBe('schoolBus');
    expect(snap.car.topSpeedMps).toBe(18);
  });
});

describe('markFeelPhaseOn', () => {
  it('stamps cumulative counters at a labelled point', () => {
    const acc = createFeelAccumulator(testCar());
    const d = makeDriver(acc);
    d.run(10, (i) => ({ planarSpeedMps: 10, x: i }));
    markFeelPhaseOn(acc, 'probe:brake');
    accumulateImpact(acc, { tSec: 1.05, handle: 1, kind: 'building', forceMagN: 10 });
    d.run(5, (i) => ({ planarSpeedMps: 10, x: 10 + i }));
    markFeelPhaseOn(acc, 'probe:turn');
    const snap = summarizeFeel(acc);
    expect(snap.phases.map((p) => p.label)).toEqual(['probe:brake', 'probe:turn']);
    expect(snap.phases[0].tSec).toBeCloseTo(1, 6);
    expect(snap.phases[0].contactRecords).toBe(0);
    expect(snap.phases[1].contactRecords).toBe(1);
    expect(snap.phases[1].distanceM).toBeGreaterThan(snap.phases[0].distanceM);
  });
});

describe('resolveFeelTuning', () => {
  it('returns the shared defaults untouched when nothing is overridden', () => {
    expect(resolveFeelTuning()).toBe(FEEL_TELEMETRY_DEFAULTS);
  });

  it('overrides exactly the named fields', () => {
    const t = resolveFeelTuning({ stuckEnterSec: 0.5 });
    expect(t.stuckEnterSec).toBe(0.5);
    expect(t.stuckSpeedMps).toBe(FEEL_TELEMETRY_DEFAULTS.stuckSpeedMps);
    expect(FEEL_TELEMETRY_DEFAULTS.stuckEnterSec).toBe(1.5);
  });

  it('derives the brake-stop threshold from the shipped brake-to-reverse speed', () => {
    // Not a literal: below it the pedal is reverse thrust, so a longer measurement would be
    // measuring acceleration backwards.
    expect(FEEL_TELEMETRY_DEFAULTS.brakeStopSpeedMps).toBe(1);
  });
});

// =============================================================================================
// Live shell
// =============================================================================================

describe('live shell', () => {
  it('attaches and detaches the sampler idempotently', () => {
    expect(isFeelTelemetryRunning()).toBe(false);
    startFeelTelemetry({ car: testCar() });
    expect(isFeelTelemetryRunning()).toBe(true);
    startFeelTelemetry({ car: testCar() }); // restart, not a second sampler
    expect(isFeelTelemetryRunning()).toBe(true);
    stopFeelTelemetry();
    expect(isFeelTelemetryRunning()).toBe(false);
    stopFeelTelemetry(); // safe twice
    expect(isFeelTelemetryRunning()).toBe(false);
  });

  it('reads an empty snapshot before any start instead of throwing', () => {
    const snap = readFeelTelemetry();
    expect(snap.schema).toBe(FEEL_TELEMETRY_SCHEMA);
    expect(snap.running).toBe(false);
    expect(snap.timing.samples).toBe(0);
  });

  it('routes contact-spine impacts into the accumulator, then stops routing after a stop', () => {
    startFeelTelemetry({ car: testCar() });
    // Unregistered handles ⇒ both sides resolve to undefined ⇒ counterpart tagged 'unknown'.
    dispatchImpact(11, 12, 4321);
    let snap = readFeelTelemetry();
    expect(snap.running).toBe(true);
    expect(snap.contact.records).toBe(1);
    expect(snap.contact.byKind.find((k) => k.kind === 'unknown')?.records).toBe(1);
    expect(snap.contact.byKind.find((k) => k.kind === 'unknown')?.maxForceMagN).toBe(4321);

    stopFeelTelemetry();
    dispatchImpact(11, 12, 9999);
    snap = readFeelTelemetry();
    expect(snap.running).toBe(false);
    expect(snap.contact.records).toBe(1); // the data survives the stop; the subscription does not
  });

  it('keeps recorded data across a stop and clears it on a reset', () => {
    startFeelTelemetry({ car: testCar() });
    dispatchImpact(1, 2, 100);
    markFeelPhase('leg-1');
    expect(readFeelTelemetry().contact.records).toBe(1);
    resetFeelTelemetry();
    const snap = readFeelTelemetry();
    expect(snap.contact.records).toBe(0);
    expect(snap.phases).toHaveLength(0);
    expect(snap.car.id).toBe('rustySedan'); // the car survives a reset
  });

  it('ignores a phase mark before the session starts', () => {
    markFeelPhase('too-early');
    expect(readFeelTelemetry().phases).toHaveLength(0);
  });
});
