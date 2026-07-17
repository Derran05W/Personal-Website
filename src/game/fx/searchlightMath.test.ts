import { describe, expect, it } from 'vitest';
import {
  beamGroundIntersectionY0,
  coneBaseRadius,
  createSpringVec3,
  snapSpringVec3,
  springConstants,
  stepSpringVec3,
} from './searchlightMath';

describe('springConstants', () => {
  it('maps frequency/damping to k = ω² and c = 2ζω', () => {
    const { k, c } = springConstants(1, 0.5);
    const omega = 2 * Math.PI;
    expect(k).toBeCloseTo(omega * omega, 10);
    expect(c).toBeCloseTo(2 * 0.5 * omega, 10);
  });
});

describe('stepSpringVec3 — lag + overshoot (the searchlight feel)', () => {
  // Explicit k/c so the test is deterministic regardless of how the SEARCHLIGHT config is
  // later tuned. c/(2√k) = 8/(2·10) = 0.4 → clearly under-damped (overshoots).
  const K = 100;
  const C_UNDER = 8; // ζ = 0.4
  const C_CRIT = 20; // ζ = 1.0 (critically damped — no overshoot)
  const SUB = 1 / 240;

  it('lags: a single small step does NOT snap to the target', () => {
    const s = createSpringVec3();
    stepSpringVec3(s, 10, 0, 0, 1 / 60, K, C_UNDER, SUB);
    // Still far from 10 after one 16 ms frame — the beam trails the player.
    expect(s.x).toBeGreaterThan(0);
    expect(s.x).toBeLessThan(2);
  });

  it('under-damped: overshoots the target, then settles onto it', () => {
    const s = createSpringVec3();
    let peak = 0;
    for (let i = 0; i < 240; i += 1) {
      stepSpringVec3(s, 10, 0, 0, 1 / 60, K, C_UNDER, SUB);
      if (s.x > peak) peak = s.x;
    }
    expect(peak).toBeGreaterThan(10); // it went past the target (overshoot)
    expect(s.x).toBeCloseTo(10, 1); // and settled back onto it after ~4 s of stepping
    expect(s.vx).toBeCloseTo(0, 1);
  });

  it('critically damped: reaches the target WITHOUT overshooting', () => {
    const s = createSpringVec3();
    let peak = 0;
    for (let i = 0; i < 240; i += 1) {
      stepSpringVec3(s, 10, 0, 0, 1 / 60, K, C_CRIT, SUB);
      if (s.x > peak) peak = s.x;
    }
    expect(peak).toBeLessThanOrEqual(10 + 1e-6);
    expect(s.x).toBeCloseTo(10, 3);
  });

  it('sub-steps a large dt without blowing up', () => {
    const s = createSpringVec3();
    // One giant 0.5 s frame (tab-refocus spike) — must stay finite and bounded, not NaN/∞.
    stepSpringVec3(s, 10, 0, 0, 0.5, K, C_UNDER, SUB);
    expect(Number.isFinite(s.x)).toBe(true);
    expect(s.x).toBeGreaterThan(0);
    expect(s.x).toBeLessThan(20);
  });

  it('dt <= 0 is a no-op', () => {
    const s = createSpringVec3();
    snapSpringVec3(s, 3, 0, 0);
    stepSpringVec3(s, 10, 0, 0, 0, K, C_UNDER, SUB);
    expect(s.x).toBe(3);
  });

  it('snapSpringVec3 locks position with zero velocity', () => {
    const s = createSpringVec3();
    s.vx = 5;
    snapSpringVec3(s, 7, 1, -2);
    expect(s).toEqual({ x: 7, y: 1, z: -2, vx: 0, vy: 0, vz: 0 });
  });
});

describe('beamGroundIntersectionY0', () => {
  it('straight down: ground hit is directly under the heli, dist = altitude', () => {
    const g = beamGroundIntersectionY0(0, 35, 0, 0, 0, 0);
    expect(g).not.toBeNull();
    expect(g!.x).toBeCloseTo(0, 10);
    expect(g!.z).toBeCloseTo(0, 10);
    expect(g!.dist).toBeCloseTo(35, 10);
  });

  it('offset aim: hits the ground at the aim XZ, dist = hypotenuse', () => {
    // heli 35 up at origin, aiming at ground point (10,0,0).
    const g = beamGroundIntersectionY0(0, 35, 0, 10, 0, 0);
    expect(g!.x).toBeCloseTo(10, 10);
    expect(g!.z).toBeCloseTo(0, 10);
    expect(g!.dist).toBeCloseTo(Math.sqrt(10 * 10 + 35 * 35), 10);
  });

  it('extends the beam PAST an aim point that sits slightly above ground', () => {
    // Aim at the player chassis (y=0.5); the ground intersection is a hair beyond it.
    const g = beamGroundIntersectionY0(0, 35, 0, 4, 0.5, 4);
    // t = 35/34.5 ≈ 1.0145 → ground XZ slightly beyond (4,4).
    expect(g!.x).toBeCloseTo(4 * (35 / 34.5), 6);
    expect(g!.z).toBeCloseTo(4 * (35 / 34.5), 6);
  });

  it('returns null when the heli is not above the ground', () => {
    expect(beamGroundIntersectionY0(0, 0, 0, 5, 0, 5)).toBeNull();
    expect(beamGroundIntersectionY0(0, -3, 0, 5, 0, 5)).toBeNull();
  });

  it('returns null when the beam does not point downward (aim at/above heli)', () => {
    expect(beamGroundIntersectionY0(0, 35, 0, 5, 35, 5)).toBeNull();
    expect(beamGroundIntersectionY0(0, 35, 0, 5, 40, 5)).toBeNull();
  });
});

describe('coneBaseRadius', () => {
  it('is tan(halfAngle) · dist', () => {
    expect(coneBaseRadius(35, Math.PI / 4)).toBeCloseTo(35, 10); // tan45° = 1
    expect(coneBaseRadius(40, 0)).toBe(0);
  });
});
