import { describe, expect, it } from 'vitest';
import {
  computeLateralSlip,
  computeSkidSegment,
  lateralSpeedAtYaw,
  skidFadeProgress,
  smoothSlip,
} from './skidMath';

describe('skidFadeProgress', () => {
  it('is 0 at birth and 1 at the fade horizon', () => {
    expect(skidFadeProgress(0, 6)).toBe(0);
    expect(skidFadeProgress(6, 6)).toBe(1);
  });

  it('is linear across the window', () => {
    expect(skidFadeProgress(3, 6)).toBeCloseTo(0.5, 12);
    expect(skidFadeProgress(1.5, 6)).toBeCloseTo(0.25, 12);
  });

  it('clamps past the horizon instead of overshooting', () => {
    expect(skidFadeProgress(100, 6)).toBe(1);
  });

  it('guards a zero/negative fade window (no divide-by-zero)', () => {
    expect(skidFadeProgress(0, 0)).toBe(1);
    expect(skidFadeProgress(5, -1)).toBe(1);
  });
});

describe('computeSkidSegment', () => {
  it('centres the quad on the midpoint of the two ground points', () => {
    const seg = computeSkidSegment(0, 0, 2, 4, 10);
    expect(seg.midX).toBe(1);
    expect(seg.midZ).toBe(2);
  });

  it('length is the travelled distance when under the clamp', () => {
    // 3-4-5 triangle: distance 5, well under the 10 m clamp.
    const seg = computeSkidSegment(0, 0, 3, 4, 10);
    expect(seg.length).toBe(5);
  });

  it('clamps length to maxLength on an over-long step', () => {
    const seg = computeSkidSegment(0, 0, 0, 100, 0.9);
    expect(seg.length).toBe(0.9);
  });

  it('yaw = atan2(dx, dz): 0 straight along +Z, +90deg straight along +X', () => {
    // Pure +Z travel → yaw 0 (quad length axis already points +Z).
    expect(computeSkidSegment(0, 0, 0, 5, 10).yaw).toBeCloseTo(0, 12);
    // Pure +X travel → yaw +π/2.
    expect(computeSkidSegment(0, 0, 5, 0, 10).yaw).toBeCloseTo(Math.PI / 2, 12);
    // Pure -X travel → yaw -π/2.
    expect(computeSkidSegment(0, 0, -5, 0, 10).yaw).toBeCloseTo(-Math.PI / 2, 12);
  });

  it('a degenerate (zero-length) step yields length 0 (caller filters it)', () => {
    const seg = computeSkidSegment(7, 7, 7, 7, 0.9);
    expect(seg.length).toBe(0);
  });
});

// --- lateral-slip trigger (Phase 16 Task 2) ---------------------------------------------------

describe('lateralSpeedAtYaw', () => {
  it('is ~0 when velocity points exactly along the heading (pure forward/reverse motion)', () => {
    for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2, 1.234]) {
      const vx = Math.sin(yaw) * 12;
      const vz = Math.cos(yaw) * 12;
      expect(lateralSpeedAtYaw(vx, vz, yaw)).toBeCloseTo(0, 9);
      expect(lateralSpeedAtYaw(-vx, -vz, yaw)).toBeCloseTo(0, 9); // reverse too
    }
  });

  it('equals the full speed (signed by drift direction) when velocity points along the right axis', () => {
    for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2, 0.7]) {
      const rightX = Math.cos(yaw);
      const rightZ = -Math.sin(yaw);
      expect(lateralSpeedAtYaw(rightX * 7, rightZ * 7, yaw)).toBeCloseTo(7, 9);
      expect(lateralSpeedAtYaw(-rightX * 7, -rightZ * 7, yaw)).toBeCloseTo(-7, 9);
    }
  });

  it('at heading 0 (+Z forward, this project\'s convention), +X velocity is fully lateral', () => {
    expect(lateralSpeedAtYaw(5, 0, 0)).toBeCloseTo(5, 9);
    expect(lateralSpeedAtYaw(-5, 0, 0)).toBeCloseTo(-5, 9);
    expect(lateralSpeedAtYaw(0, 5, 0)).toBeCloseTo(0, 9);
  });
});

describe('smoothSlip', () => {
  it('alpha=1 snaps immediately to the raw value (no smoothing)', () => {
    expect(smoothSlip(0, 10, 1)).toBe(10);
  });

  it('alpha=0 never moves away from prev (fully smoothed / frozen)', () => {
    expect(smoothSlip(3, 10, 0)).toBe(3);
  });

  it('blends linearly toward raw for a mid alpha', () => {
    expect(smoothSlip(0, 10, 0.3)).toBeCloseTo(3, 9);
    expect(smoothSlip(10, 0, 0.25)).toBeCloseTo(7.5, 9);
  });

  it('clamps an out-of-range alpha into [0,1] rather than over/undershooting', () => {
    expect(smoothSlip(0, 10, 1.5)).toBe(10);
    expect(smoothSlip(3, 10, -1)).toBe(3);
  });
});

describe('computeLateralSlip', () => {
  const thresholdMps = 3.5;
  const maxMps = 9;

  it('straight-line driving (zero lateral speed, no handbrake) does not slip', () => {
    const r = computeLateralSlip(0, false, thresholdMps, maxMps);
    expect(r.slipping).toBe(false);
    expect(r.slip01).toBe(0);
  });

  it('gentle cornering (small lateral speed under the threshold, no handbrake) does not slip', () => {
    const r = computeLateralSlip(1.2, false, thresholdMps, maxMps);
    expect(r.slipping).toBe(false);
    expect(r.slip01).toBe(0);
  });

  it('a deliberate drift over the threshold slips even with NO handbrake', () => {
    const r = computeLateralSlip(6, false, thresholdMps, maxMps);
    expect(r.slipping).toBe(true);
    expect(r.slip01).toBeGreaterThan(0);
    expect(r.slip01).toBeLessThan(1);
  });

  it('threshold is a strict ">": exactly at it does not yet slip without the handbrake', () => {
    expect(computeLateralSlip(thresholdMps, false, thresholdMps, maxMps).slipping).toBe(false);
    expect(computeLateralSlip(thresholdMps + 1e-6, false, thresholdMps, maxMps).slipping).toBe(true);
  });

  it('slip01 is exactly 0 at the threshold, 1 at maxMps, and clamps beyond maxMps', () => {
    expect(computeLateralSlip(thresholdMps, false, thresholdMps, maxMps).slip01).toBe(0);
    expect(computeLateralSlip(maxMps, false, thresholdMps, maxMps).slip01).toBe(1);
    expect(computeLateralSlip(maxMps * 2, false, thresholdMps, maxMps).slip01).toBe(1);
  });

  it('the handbrake ORs the trigger even at zero lateral speed (the pre-existing path, kept)', () => {
    const r = computeLateralSlip(0, true, thresholdMps, maxMps);
    expect(r.slipping).toBe(true);
    // Strength still tracks the REAL slide, not forced to 1 just because the handbrake is
    // held — an early pivot with little sideways speed ramps in rather than popping to full.
    expect(r.slip01).toBe(0);
  });

  it('sign does not matter — equal-magnitude left/right drifts slip identically', () => {
    expect(computeLateralSlip(-6, false, thresholdMps, maxMps)).toEqual(
      computeLateralSlip(6, false, thresholdMps, maxMps),
    );
  });

  it('falls back to a hard 0/1 step (no divide-by-zero) when maxMps <= thresholdMps', () => {
    expect(computeLateralSlip(2, false, 5, 5).slip01).toBe(0);
    expect(computeLateralSlip(6, false, 5, 5).slip01).toBe(1);
    expect(computeLateralSlip(6, false, 5, 3).slip01).toBe(1);
  });
});
