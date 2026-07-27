// Phase 41 — the SURFACE POLICY law test. Pins every value in config/surfaces.ts, re-does the
// derivation arithmetic independently (so a silent edit to the rig or the measurement frame that
// invalidates the thin-geometry bound fails loudly here), and asserts the policy map is total.
//
// The bound is ENFORCED, not documented: the shipped painted stripes are asserted against
// THIN_GEOMETRY.minStripeWidthWu straight out of config/torontoMap.ts, so narrowing a stripe below
// the shimmer floor breaks this test rather than the frame.
import { describe, expect, it } from 'vitest';
import {
  ATLAS_POLICY,
  DERIVED_MIN_STRIPE_WIDTH_WU,
  GROUND_FORESHORTEN,
  SURFACE_MEASUREMENT,
  THIN_GEOMETRY,
  pxPerWu,
  resolveAnisotropy,
  type AtlasMipPolicy,
} from './surfaces';
import { CAMERA } from './camera';
import { QUALITY_TIERS, QUALITY_TIER_ORDER } from './quality';
import { CROSSWALK, ROAD_EDGE } from './torontoMap';

describe('SURFACE_MEASUREMENT — the measured frame (Phase 41 T1)', () => {
  it('pins the frame every bound is worst-cased in', () => {
    expect(SURFACE_MEASUREMENT).toEqual({
      viewportHeightPx: 720,
      dpr: 1,
      msaaSamples: 4,
      farGroundDistanceWu: 60,
      stabilityFloorPx: 4,
    });
  });
});

describe('pxPerWu — the fixed-rig pixel-density bound', () => {
  it('is the plain perspective projection of the LAW rig FOV (≈ 1046/d at 720p)', () => {
    const expectedAt1 = 720 / (2 * Math.tan(((CAMERA.fov / 2) * Math.PI) / 180));
    expect(pxPerWu(1)).toBeCloseTo(expectedAt1, 9);
    expect(pxPerWu(1)).toBeCloseTo(1045.5, 1);
  });

  it('is inverse in distance — the near frame is always denser than the far bound', () => {
    expect(pxPerWu(30)).toBeCloseTo(pxPerWu(60) * 2, 9);
    expect(pxPerWu(SURFACE_MEASUREMENT.farGroundDistanceWu)).toBeCloseTo(17.43, 2);
  });
});

describe('THIN_GEOMETRY — the thin-geometry law', () => {
  it('foreshortens the ground plane by sin(pitch) of the LAW rig', () => {
    expect(GROUND_FORESHORTEN).toBeCloseTo(Math.sin((CAMERA.pitchDeg * Math.PI) / 180), 12);
    expect(GROUND_FORESHORTEN).toBeCloseTo(0.848, 3);
  });

  it('derives the raw bound as stabilityFloorPx ÷ far-band density ÷ foreshortening', () => {
    const raw =
      SURFACE_MEASUREMENT.stabilityFloorPx /
      pxPerWu(SURFACE_MEASUREMENT.farGroundDistanceWu) /
      GROUND_FORESHORTEN;
    expect(DERIVED_MIN_STRIPE_WIDTH_WU).toBeCloseTo(raw, 12);
    expect(DERIVED_MIN_STRIPE_WIDTH_WU).toBeCloseTo(0.271, 3);
  });

  it('ships the derived bound rounded UP (never down — rounding down would under-protect)', () => {
    expect(THIN_GEOMETRY.minStripeWidthWu).toBe(0.3);
    expect(THIN_GEOMETRY.minStripeWidthWu).toBeGreaterThanOrEqual(DERIVED_MIN_STRIPE_WIDTH_WU);
  });

  it('every shipped painted stripe clears the bound (T1 measured them stable at DPR 1)', () => {
    // Centre-line dash: 2 × halfWidthWu = 0.4 wu (0.117 % / 0.111 % jitter, high / low tier).
    expect(ROAD_EDGE.dash.halfWidthWu * 2).toBeGreaterThanOrEqual(THIN_GEOMETRY.minStripeWidthWu);
    // Crosswalk zebra stripe: 0.5 wu.
    expect(CROSSWALK.stripeWidthWu).toBeGreaterThanOrEqual(THIN_GEOMETRY.minStripeWidthWu);
    // Curb strip: 0.8 wu.
    expect(ROAD_EDGE.widthWu).toBeGreaterThanOrEqual(THIN_GEOMETRY.minStripeWidthWu);
  });

  it('rejects the P60 overhead-wire diameters as raw geometry (the note is a real constraint)', () => {
    for (const wireDiameterWu of [0.05, 0.1]) {
      expect(wireDiameterWu).toBeLessThan(THIN_GEOMETRY.minStripeWidthWu);
    }
  });
});

describe('ATLAS_POLICY — the Phase 41 minification verdicts as code', () => {
  it('covers every atlas the audit measured, with exactly the recorded verdicts', () => {
    expect(ATLAS_POLICY).toEqual({
      logoAtlas: 'magnificationOnly',
      venueBands: 'magnificationOnly',
      facadeWindows: 'magnificationOnly',
      sankofaScreen: 'magnificationOnly',
      graffiti: 'magnificationOnly',
      packPalette: 'magnificationOnly',
      routeBoards: 'mipped',
    });
  });

  it('uses only the two sanctioned policy values', () => {
    const allowed: readonly AtlasMipPolicy[] = ['magnificationOnly', 'mipped'];
    for (const value of Object.values(ATLAS_POLICY)) expect(allowed).toContain(value);
  });
});

describe('resolveAnisotropy — per-tier level, capability-capped', () => {
  it('pins the per-tier values in the tier table (high 8 / med 8 / low 4)', () => {
    expect(QUALITY_TIERS.high.anisotropy).toBe(8);
    expect(QUALITY_TIERS.med.anisotropy).toBe(8);
    expect(QUALITY_TIERS.low.anisotropy).toBe(4);
  });

  it('never increases as the tier drops (monotonic across QUALITY_TIER_ORDER)', () => {
    for (let i = 1; i < QUALITY_TIER_ORDER.length; i++) {
      const lower = QUALITY_TIERS[QUALITY_TIER_ORDER[i - 1]].anisotropy;
      const higher = QUALITY_TIERS[QUALITY_TIER_ORDER[i]].anisotropy;
      expect(higher).toBeGreaterThanOrEqual(lower);
    }
  });

  it('returns the tier value when the renderer supports it', () => {
    expect(resolveAnisotropy('high', 16)).toBe(8);
    expect(resolveAnisotropy('low', 16)).toBe(4);
  });

  it('caps at the renderer maximum, and never returns below 1 (aniso 0 is invalid)', () => {
    expect(resolveAnisotropy('high', 2)).toBe(2);
    expect(resolveAnisotropy('low', 1)).toBe(1);
    expect(resolveAnisotropy('high', 0)).toBe(1);
    expect(resolveAnisotropy('high', 2.7)).toBe(2);
  });
});
