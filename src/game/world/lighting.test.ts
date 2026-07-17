// Pure math tests for the blue-hour shadow-follow quantization (world/lighting.ts). The
// shimmer this guards against is nearly impossible to SEE in a headless screenshot, so the
// texel-snap invariants are pinned here instead: the snap grid is stable, the light
// direction is preserved, and depth is untouched.
import { describe, it, expect } from 'vitest';
import {
  sunToWorld,
  computeSunBasis,
  worldTexelSize,
  snapToShadowTexel,
  computeSunFollow,
  skyGradientStops,
  resolveSkyGlow,
  type SkyConfig,
  type Vec3,
} from './lighting';

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}
function len(a: Vec3): number {
  return Math.hypot(a.x, a.y, a.z);
}

const BASIS = computeSunBasis(290, 18); // the shipped WNW dusk angle
const TEXEL = worldTexelSize(60, 2048);

describe('worldTexelSize', () => {
  it('is the ortho box side divided by the shadow map resolution', () => {
    expect(worldTexelSize(60, 2048)).toBeCloseTo(60 / 2048, 12);
    expect(worldTexelSize(60, 1024)).toBeCloseTo(60 / 1024, 12);
    // A smaller map ⇒ coarser (larger) world texel.
    expect(worldTexelSize(60, 1024)).toBeGreaterThan(worldTexelSize(60, 2048));
  });
});

describe('sunToWorld compass mapping', () => {
  it('places the sun on the right compass bearing (0=N=−Z, 90=E=+X, 270=W=−X)', () => {
    const n = sunToWorld(0, 0);
    expect(n.x).toBeCloseTo(0, 6);
    expect(n.z).toBeCloseTo(-1, 6);
    const e = sunToWorld(90, 0);
    expect(e.x).toBeCloseTo(1, 6);
    expect(e.z).toBeCloseTo(0, 6);
    const w = sunToWorld(270, 0);
    expect(w.x).toBeCloseTo(-1, 6);
    expect(w.z).toBeCloseTo(0, 6);
  });
  it('elevation lifts the sun along +Y and is a unit vector', () => {
    const s = sunToWorld(290, 18);
    expect(s.y).toBeCloseTo(Math.sin(18 * (Math.PI / 180)), 6);
    expect(len(s)).toBeCloseTo(1, 6);
    // WNW: toward −X (west) and −Z (north).
    expect(s.x).toBeLessThan(0);
    expect(s.z).toBeLessThan(0);
  });
});

describe('computeSunBasis', () => {
  it('is orthonormal', () => {
    const { right, up, forward } = BASIS;
    expect(len(right)).toBeCloseTo(1, 6);
    expect(len(up)).toBeCloseTo(1, 6);
    expect(len(forward)).toBeCloseTo(1, 6);
    expect(dot(right, up)).toBeCloseTo(0, 6);
    expect(dot(right, forward)).toBeCloseTo(0, 6);
    expect(dot(up, forward)).toBeCloseTo(0, 6);
  });
  it('forward is the light travel direction (−toSun)', () => {
    const toSun = sunToWorld(290, 18);
    expect(BASIS.forward.x).toBeCloseTo(-toSun.x, 6);
    expect(BASIS.forward.y).toBeCloseTo(-toSun.y, 6);
    expect(BASIS.forward.z).toBeCloseTo(-toSun.z, 6);
  });
});

describe('snapToShadowTexel', () => {
  const out: Vec3 = { x: 0, y: 0, z: 0 };

  it('lands the in-plane projection on whole-texel multiples', () => {
    const center: Vec3 = { x: 12.3456, y: 1.4, z: -87.91 };
    snapToShadowTexel(center, BASIS, TEXEL, out);
    const pr = dot(out, BASIS.right) / TEXEL;
    const pu = dot(out, BASIS.up) / TEXEL;
    expect(Math.abs(pr - Math.round(pr))).toBeLessThan(1e-6);
    expect(Math.abs(pu - Math.round(pu))).toBeLessThan(1e-6);
  });

  it('preserves the depth component along the light direction', () => {
    const center: Vec3 = { x: -5.2, y: 2.1, z: 33.7 };
    snapToShadowTexel(center, BASIS, TEXEL, out);
    expect(dot(out, BASIS.forward)).toBeCloseTo(dot(center, BASIS.forward), 6);
  });

  it('is idempotent (snapping an already-snapped point is a no-op)', () => {
    const center: Vec3 = { x: 40.01, y: 0.5, z: -12.9 };
    const once: Vec3 = { x: 0, y: 0, z: 0 };
    const twice: Vec3 = { x: 0, y: 0, z: 0 };
    snapToShadowTexel(center, BASIS, TEXEL, once);
    snapToShadowTexel(once, BASIS, TEXEL, twice);
    expect(twice.x).toBeCloseTo(once.x, 6);
    expect(twice.y).toBeCloseTo(once.y, 6);
    expect(twice.z).toBeCloseTo(once.z, 6);
  });

  it('does not move (no shimmer) for sub-texel drift within one cell', () => {
    const center: Vec3 = { x: 10, y: 1, z: 10 };
    const a: Vec3 = { x: 0, y: 0, z: 0 };
    const b: Vec3 = { x: 0, y: 0, z: 0 };
    snapToShadowTexel(center, BASIS, TEXEL, a);
    // Nudge by 0.3 of a texel along `right` — should land in the same cell → identical snap.
    const drifted: Vec3 = {
      x: center.x + BASIS.right.x * TEXEL * 0.3,
      y: center.y + BASIS.right.y * TEXEL * 0.3,
      z: center.z + BASIS.right.z * TEXEL * 0.3,
    };
    snapToShadowTexel(drifted, BASIS, TEXEL, b);
    expect(b.x).toBeCloseTo(a.x, 9);
    expect(b.y).toBeCloseTo(a.y, 9);
    expect(b.z).toBeCloseTo(a.z, 9);
  });

  it('steps by exactly one texel when the center moves one texel along an axis', () => {
    const center: Vec3 = { x: 3.33, y: 0.7, z: -9.87 };
    const a: Vec3 = { x: 0, y: 0, z: 0 };
    const b: Vec3 = { x: 0, y: 0, z: 0 };
    snapToShadowTexel(center, BASIS, TEXEL, a);
    const moved: Vec3 = {
      x: center.x + BASIS.right.x * TEXEL,
      y: center.y + BASIS.right.y * TEXEL,
      z: center.z + BASIS.right.z * TEXEL,
    };
    snapToShadowTexel(moved, BASIS, TEXEL, b);
    // The snapped point shifts by exactly one texel along `right` and nowhere else.
    const shift: Vec3 = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
    expect(dot(shift, BASIS.right)).toBeCloseTo(TEXEL, 6);
    expect(dot(shift, BASIS.up)).toBeCloseTo(0, 6);
    expect(dot(shift, BASIS.forward)).toBeCloseTo(0, 6);
  });
});

describe('computeSunFollow', () => {
  const sunOffset: Vec3 = { x: -BASIS.forward.x * 100, y: -BASIS.forward.y * 100, z: -BASIS.forward.z * 100 };
  const target: Vec3 = { x: 0, y: 0, z: 0 };
  const light: Vec3 = { x: 0, y: 0, z: 0 };

  it('keeps the light→target direction constant (== sunOffset) for any center', () => {
    for (const center of [
      { x: 0, y: 0, z: 0 },
      { x: 123.4, y: 1.2, z: -256.7 },
      { x: -300, y: 0.6, z: 44.9 },
      { x: 7.77, y: 2.0, z: 7.77 },
    ] satisfies Vec3[]) {
      computeSunFollow(center, BASIS, sunOffset, TEXEL, target, light);
      expect(light.x - target.x).toBeCloseTo(sunOffset.x, 6);
      expect(light.y - target.y).toBeCloseTo(sunOffset.y, 6);
      expect(light.z - target.z).toBeCloseTo(sunOffset.z, 6);
    }
  });

  it('snaps the target to the texel grid', () => {
    computeSunFollow({ x: 55.55, y: 1.4, z: -12.34 }, BASIS, sunOffset, TEXEL, target, light);
    const pr = dot(target, BASIS.right) / TEXEL;
    const pu = dot(target, BASIS.up) / TEXEL;
    expect(Math.abs(pr - Math.round(pr))).toBeLessThan(1e-6);
    expect(Math.abs(pu - Math.round(pu))).toBeLessThan(1e-6);
  });
});

// --- Blue-hour sky gradient math (Phase 19) -----------------------------------------------

const SKY: SkyConfig = {
  top: '#0d1a33',
  horizon: '#dd8b55',
  bottom: '#141d33',
  horizonStop: 0.46,
  glow: { color: '#f0a878', strength: 0.55, centerX: 0.36, centerY: 0.52, radius: 0.55 },
};

describe('skyGradientStops', () => {
  it('returns exactly three ascending stops anchored at the top (0) and bottom (1)', () => {
    const stops = skyGradientStops(SKY);
    expect(stops).toHaveLength(3);
    expect(stops[0]).toEqual({ pos: 0, color: SKY.top });
    expect(stops[1]).toEqual({ pos: 0.46, color: SKY.horizon });
    expect(stops[2]).toEqual({ pos: 1, color: SKY.bottom });
    for (let i = 1; i < stops.length; i++) {
      expect(stops[i].pos).toBeGreaterThan(stops[i - 1].pos);
    }
  });

  it('clamps a degenerate horizonStop into (0,1) so the warm band always has room', () => {
    expect(skyGradientStops({ ...SKY, horizonStop: 0 })[1].pos).toBeCloseTo(0.05, 6);
    expect(skyGradientStops({ ...SKY, horizonStop: 1 })[1].pos).toBeCloseTo(0.95, 6);
    expect(skyGradientStops({ ...SKY, horizonStop: -5 })[1].pos).toBeCloseTo(0.05, 6);
    // Endpoints are never moved by the clamp.
    const s = skyGradientStops({ ...SKY, horizonStop: 2 });
    expect(s[0].pos).toBe(0);
    expect(s[2].pos).toBe(1);
  });
});

describe('resolveSkyGlow', () => {
  it('places the lobe centre from the screen-space fractions, biased toward the lake (left)', () => {
    const lobe = resolveSkyGlow(SKY, 96, 256);
    expect(lobe.cx).toBeCloseTo(0.36 * 96, 6);
    expect(lobe.cy).toBeCloseTo(0.52 * 256, 6);
    // The lake/south side sits left-of-centre for the fixed WNW-looking rig.
    expect(lobe.cx).toBeLessThan(96 / 2);
    expect(lobe.color).toBe(SKY.glow.color);
  });

  it('sizes the radius from the canvas diagonal and never below 1px', () => {
    const w = 96;
    const h = 256;
    const lobe = resolveSkyGlow(SKY, w, h);
    expect(lobe.radius).toBeCloseTo(0.55 * Math.hypot(w, h), 6);
    expect(resolveSkyGlow({ ...SKY, glow: { ...SKY.glow, radius: 0 } }, w, h).radius).toBeGreaterThanOrEqual(1);
  });

  it('clamps strength to [0,1] and the centre fractions to the canvas', () => {
    expect(resolveSkyGlow({ ...SKY, glow: { ...SKY.glow, strength: 2 } }, 96, 256).strength).toBe(1);
    expect(resolveSkyGlow({ ...SKY, glow: { ...SKY.glow, strength: -1 } }, 96, 256).strength).toBe(0);
    const off = resolveSkyGlow({ ...SKY, glow: { ...SKY.glow, centerX: 1.5, centerY: -0.5 } }, 96, 256);
    expect(off.cx).toBe(96); // clamped to the right edge
    expect(off.cy).toBe(0); // clamped to the top edge
  });
});
