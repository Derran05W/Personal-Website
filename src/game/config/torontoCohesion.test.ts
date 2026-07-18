// Phase 25.8 (D4) — vertex-gradient bake math: endpoints, strength-0 identity, monotonic ramp.
import { describe, expect, it } from 'vitest';
import { VERTEX_GRADIENT_BAKE, computeGradientLuminance, gradientLuminanceAt, vertexGradientActive } from './torontoCohesion';

describe('computeGradientLuminance', () => {
  it('at full strength, floor = start, roof = end', () => {
    expect(computeGradientLuminance(0, 1.0, 0.86, 1)).toBeCloseTo(1.0, 6);
    expect(computeGradientLuminance(1, 1.0, 0.86, 1)).toBeCloseTo(0.86, 6);
  });

  it('strength 0 is the identity (1.0 everywhere → byte-identical shading)', () => {
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      expect(computeGradientLuminance(t, 1.0, 0.86, 0)).toBe(1);
    }
  });

  it('clamps t to [0,1]', () => {
    expect(computeGradientLuminance(-1, 1.0, 0.5, 1)).toBeCloseTo(1.0, 6);
    expect(computeGradientLuminance(2, 1.0, 0.5, 1)).toBeCloseTo(0.5, 6);
  });

  it('is a monotone top-darken when end < start (roof never brighter than floor)', () => {
    let prev = Infinity;
    for (let i = 0; i <= 10; i++) {
      const l = computeGradientLuminance(i / 10, 1.0, 0.86, 1);
      expect(l).toBeLessThanOrEqual(prev + 1e-9);
      prev = l;
    }
  });

  it('strength blends the ramp toward 1.0 (half strength = half the roof shade)', () => {
    const full = computeGradientLuminance(1, 1.0, 0.86, 1);
    const half = computeGradientLuminance(1, 1.0, 0.86, 0.5);
    expect(half).toBeCloseTo(1 + (full - 1) * 0.5, 6);
  });
});

describe('config wiring', () => {
  it('shipped default is a subtle top-darken (roof < floor, active)', () => {
    expect(VERTEX_GRADIENT_BAKE.endLuminance).toBeLessThan(VERTEX_GRADIENT_BAKE.startLuminance);
    expect(vertexGradientActive()).toBe(true);
    expect(gradientLuminanceAt(0)).toBeGreaterThanOrEqual(gradientLuminanceAt(1));
  });
});
