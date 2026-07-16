import { describe, expect, it } from 'vitest';
import {
  approach,
  nextSteerAngle,
  steerClampRad,
  throttleGovernor,
  type SteerTuning,
} from './steering';
import { STARTER_TOP_SPEED, VEHICLE_TUNING } from '../config';

const DEG2RAD = Math.PI / 180;
const TUNING: SteerTuning = VEHICLE_TUNING.steering;

describe('approach', () => {
  it('reaches the target exactly when within maxDelta (no overshoot)', () => {
    expect(approach(0, 0.05, 0.1)).toBe(0.05);
    expect(approach(1, 0.95, 0.1)).toBe(0.95);
  });

  it('steps by at most maxDelta toward the target', () => {
    expect(approach(0, 1, 0.1)).toBeCloseTo(0.1, 10);
    expect(approach(0, -1, 0.1)).toBeCloseTo(-0.1, 10);
  });

  it('is a no-op when already at the target', () => {
    expect(approach(0.3, 0.3, 0.1)).toBe(0.3);
  });
});

describe('steerClampRad', () => {
  it('gives the full standstill angle at zero speed', () => {
    expect(steerClampRad(0, STARTER_TOP_SPEED, TUNING)).toBeCloseTo(
      TUNING.maxAngleDeg * DEG2RAD,
      10,
    );
  });

  it('eases to the high-speed angle at (and beyond) top speed', () => {
    const highRad = TUNING.highSpeedAngleDeg * DEG2RAD;
    expect(steerClampRad(STARTER_TOP_SPEED, STARTER_TOP_SPEED, TUNING)).toBeCloseTo(highRad, 10);
    // Clamps: nothing tighter than the high-speed angle even past top speed.
    expect(steerClampRad(STARTER_TOP_SPEED * 3, STARTER_TOP_SPEED, TUNING)).toBeCloseTo(
      highRad,
      10,
    );
  });

  it('decreases monotonically from standstill to top speed', () => {
    let prev = Infinity;
    for (let s = 0; s <= STARTER_TOP_SPEED; s += STARTER_TOP_SPEED / 8) {
      const angle = steerClampRad(s, STARTER_TOP_SPEED, TUNING);
      expect(angle).toBeLessThanOrEqual(prev);
      prev = angle;
    }
  });

  it('treats reverse speed the same as forward (uses |speed|)', () => {
    const s = STARTER_TOP_SPEED / 2;
    expect(steerClampRad(-s, STARTER_TOP_SPEED, TUNING)).toBeCloseTo(
      steerClampRad(s, STARTER_TOP_SPEED, TUNING),
      10,
    );
  });
});

describe('nextSteerAngle', () => {
  const dt = 1 / 60;

  it('rate-limits the chase toward the target (no snap)', () => {
    const next = nextSteerAngle(0, 1, 0, STARTER_TOP_SPEED, TUNING, dt);
    expect(next).toBeCloseTo(TUNING.rateDegPerSec * DEG2RAD * dt, 10);
    // One step is nowhere near the full standstill clamp.
    expect(next).toBeLessThan(steerClampRad(0, STARTER_TOP_SPEED, TUNING));
  });

  it('steers right for positive input, left for negative', () => {
    expect(nextSteerAngle(0, 1, 0, STARTER_TOP_SPEED, TUNING, dt)).toBeGreaterThan(0);
    expect(nextSteerAngle(0, -1, 0, STARTER_TOP_SPEED, TUNING, dt)).toBeLessThan(0);
  });

  it('recenters faster than it steers out (returnRate > rate applies)', () => {
    const start = 0.3;
    const outward = start - nextSteerAngle(start, 1, 0, STARTER_TOP_SPEED, TUNING, dt);
    const returning = start - nextSteerAngle(start, 0, 0, STARTER_TOP_SPEED, TUNING, dt);
    // Returning toward center moves by returnRate*dt; steering further out moves by rate*dt.
    expect(returning).toBeCloseTo(TUNING.returnRateDegPerSec * DEG2RAD * dt, 10);
    expect(Math.abs(returning)).toBeGreaterThan(Math.abs(outward));
  });

  it('never overshoots center when relaxing from a small angle', () => {
    const tiny = TUNING.returnRateDegPerSec * DEG2RAD * dt * 0.5;
    expect(nextSteerAngle(tiny, 0, 0, STARTER_TOP_SPEED, TUNING, dt)).toBe(0);
  });
});

describe('throttleGovernor', () => {
  it('is full force at a standstill', () => {
    expect(throttleGovernor(0, STARTER_TOP_SPEED)).toBe(1);
  });

  it('fades to zero at top speed', () => {
    expect(throttleGovernor(STARTER_TOP_SPEED, STARTER_TOP_SPEED)).toBe(0);
  });

  it('is half at half top speed (linear taper)', () => {
    expect(throttleGovernor(STARTER_TOP_SPEED / 2, STARTER_TOP_SPEED)).toBeCloseTo(0.5, 10);
  });

  it('clamps to zero past top speed and to one while reversing', () => {
    expect(throttleGovernor(STARTER_TOP_SPEED * 2, STARTER_TOP_SPEED)).toBe(0);
    expect(throttleGovernor(-5, STARTER_TOP_SPEED)).toBe(1);
  });
});
