// Phase 25.8 (D6) — ground-noise field: seamless wrap (tileable), value range, determinism, and
// the ladder-order-preservation guard (the ±grain can never invert the palette ladder).
import { describe, expect, it } from 'vitest';
import { GROUND_NOISE, buildNoiseField, sampleNoiseField } from './groundNoise';

describe('buildNoiseField', () => {
  it('is deterministic (same seed → identical lattice)', () => {
    const a = buildNoiseField(7, 16, 0.9, 1.0);
    const b = buildNoiseField(7, 16, 0.9, 1.0);
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
  });

  it('every lattice value is in [lo, hi]', () => {
    const f = buildNoiseField(42, 32, 0.9, 1.0);
    for (const v of f.data) {
      expect(v).toBeGreaterThanOrEqual(0.9);
      expect(v).toBeLessThanOrEqual(1.0);
    }
  });
});

describe('sampleNoiseField — seamless tiling', () => {
  const f = buildNoiseField(99, 24, 0.9, 1.0);

  it('wraps: sample(u=0) === sample(u=1), sample(v=0) === sample(v=1)', () => {
    for (const w of [0, 0.13, 0.37, 0.5, 0.81]) {
      expect(sampleNoiseField(f, 0, w)).toBeCloseTo(sampleNoiseField(f, 1, w), 10);
      expect(sampleNoiseField(f, w, 0)).toBeCloseTo(sampleNoiseField(f, w, 1), 10);
    }
  });

  it('stays within [lo, hi] for arbitrary (u,v) incl. negatives', () => {
    for (let i = 0; i < 200; i++) {
      const u = (i * 0.017) - 1.5;
      const v = (i * 0.031) - 0.7;
      const s = sampleNoiseField(f, u, v);
      expect(s).toBeGreaterThanOrEqual(0.9 - 1e-9);
      expect(s).toBeLessThanOrEqual(1.0 + 1e-9);
    }
  });
});

describe('ladder-order preservation under the grain', () => {
  it('GROUND_NOISE.lo is above the tightest adjacent ladder ratio (can never invert order)', () => {
    // Post-L3 luminances (approx, sRGB-ish): road spine ≈ 0.24, ground base ≈ 0.31. The grain
    // darkens by at most (1 - lo). A darker surface × 1.0 must stay below a lighter surface × lo.
    const spine = 0.24;
    const ground = 0.31;
    // ground × lo > spine × 1.0  ⟺  lo > spine/ground
    expect(GROUND_NOISE.lo).toBeGreaterThan(spine / ground);
  });

  it('the field only DARKENS (hi ≤ 1) so a multiply never lifts a surface past a brighter one', () => {
    expect(GROUND_NOISE.hi).toBeLessThanOrEqual(1.0);
    expect(GROUND_NOISE.lo).toBeLessThan(GROUND_NOISE.hi);
  });
});
