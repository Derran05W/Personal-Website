import { describe, expect, it } from 'vitest';
import { computeSkidSegment, skidFadeProgress } from './skidMath';

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
