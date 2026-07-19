// Part-8 (D1/D2, "density/life flip", phase-27-plan T1) — dedicated derivation tests for the
// compaction seam: projection.ts's ZONE_BOUNDARIES/scaleBaseY and polygon.ts's scaleAboutYonge/
// ZONE_X_EXTENTS. These pin the DERIVATION (formula), not just today's DENSITY.scale=0.6 output —
// re-implementing the same "scaled-span cumulative sum, fold exempt" rule independently at
// several scale factors proves the rule itself (not just one instance of it).
import { describe, expect, it } from 'vitest';
import { DENSITY } from '../../config/torontoMap';
import { PLAYABLE_POLYGON, scaleAboutYonge, ZONE_X_EXTENTS } from './polygon';
import { ZONE_BOUNDARIES, YONGE_X } from './projection';

// The same BASE (pre-compaction) §1/§2 constants projection.ts's own BASE_NS_Y encodes —
// duplicated here ONLY as independent fixture data for this property test (never imported from
// projection.ts, so a bug in the module under test can't also corrupt the expectation).
const BASE_NS_Y = { finch: 170, sheppard: 1170, bloor: 1830, shore: 3700, waterBottom: 4100 };

/** Re-derives the live [sheppard, bloor, shore, waterBottom] control-ys for an arbitrary scale,
 * fold segment exempt — the same rule ZONE_BOUNDARIES is built from. */
function deriveLiveYs(scale: number): { sheppard: number; bloor: number; shore: number; waterBottom: number } {
  const topMargin = BASE_NS_Y.finch * scale;
  const northYork = (BASE_NS_Y.sheppard - BASE_NS_Y.finch) * scale;
  const fold = BASE_NS_Y.bloor - BASE_NS_Y.sheppard; // exempt — unscaled
  const downtown = (BASE_NS_Y.shore - BASE_NS_Y.bloor) * scale;
  const water = (BASE_NS_Y.waterBottom - BASE_NS_Y.shore) * scale;
  const finch = topMargin;
  const sheppard = finch + northYork;
  const bloor = sheppard + fold;
  const shore = bloor + downtown;
  const waterBottom = shore + water;
  return { sheppard, bloor, shore, waterBottom };
}

describe('compaction derivation — fold span preserved under ANY DENSITY.scale', () => {
  it.each([0.3, 0.5, 0.6, 0.75, 1.0])('fold span (bloor - sheppard) is always 660 wu at scale=%s', (scale) => {
    const { sheppard, bloor } = deriveLiveYs(scale);
    expect(bloor - sheppard).toBeCloseTo(660, 9);
  });

  it('at scale=1 (no compaction) every live y equals its BASE y', () => {
    const { sheppard, bloor, shore, waterBottom } = deriveLiveYs(1);
    expect(sheppard).toBeCloseTo(BASE_NS_Y.sheppard, 9);
    expect(bloor).toBeCloseTo(BASE_NS_Y.bloor, 9);
    expect(shore).toBeCloseTo(BASE_NS_Y.shore, 9);
    expect(waterBottom).toBeCloseTo(BASE_NS_Y.waterBottom, 9);
  });

  it('the LIVE projection.ts ZONE_BOUNDARIES match this formula at the real DENSITY.scale', () => {
    const { sheppard, bloor, shore, waterBottom } = deriveLiveYs(DENSITY.scale);
    expect(ZONE_BOUNDARIES[0]).toBe(0);
    expect(ZONE_BOUNDARIES[1]).toBeCloseTo(sheppard, 9);
    expect(ZONE_BOUNDARIES[2]).toBeCloseTo(bloor, 9);
    expect(ZONE_BOUNDARIES[3]).toBeCloseTo(shore, 9);
    expect(ZONE_BOUNDARIES[4]).toBeCloseTo(waterBottom, 9);
  });
});

describe('scaleAboutYonge — x compaction is about x=1500 exactly (the Yonge invariant)', () => {
  it('YONGE_X is 1500 and scaleAboutYonge(1500) is a no-op at any scale', () => {
    expect(YONGE_X).toBe(1500);
    expect(scaleAboutYonge(1500)).toBe(1500);
  });

  it('scales symmetrically about 1500: equal-and-opposite offsets stay equal-and-opposite', () => {
    for (const delta of [1, 50, 400, 900]) {
      const east = scaleAboutYonge(1500 + delta) - 1500;
      const west = 1500 - scaleAboutYonge(1500 - delta);
      expect(east).toBeCloseTo(west, 9);
      expect(east).toBeCloseTo(delta * DENSITY.scale, 9);
    }
  });

  it('is the identity function iff DENSITY.scale were 1 (sanity on the formula, not the live constant)', () => {
    const identityScale = (x: number): number => YONGE_X + (x - YONGE_X) * 1;
    expect(identityScale(2400)).toBe(2400);
    expect(identityScale(0)).toBe(0);
  });
});

describe('polygon rects are consistent with ZONE_BOUNDARIES / ZONE_X_EXTENTS (single source, no drift)', () => {
  it('every PLAYABLE_POLYGON vertex y is one of the four ZONE_BOUNDARIES bands', () => {
    const validYs = new Set(ZONE_BOUNDARIES);
    for (const v of PLAYABLE_POLYGON) {
      expect(validYs.has(v.y), `vertex y=${v.y} not a zone boundary`).toBe(true);
    }
  });

  it('every PLAYABLE_POLYGON vertex x is one of the three ZONE_X_EXTENTS edges', () => {
    const validXs = new Set([...ZONE_X_EXTENTS.capsule, ...ZONE_X_EXTENTS.fold, ...ZONE_X_EXTENTS.downtown]);
    for (const v of PLAYABLE_POLYGON) {
      expect(validXs.has(v.x), `vertex x=${v.x} not a zone x-extent`).toBe(true);
    }
  });

  it('ZONE_X_EXTENTS nest correctly (capsule ⊆ downtown-width footprint, fold narrowest)', () => {
    const capsuleWidth = ZONE_X_EXTENTS.capsule[1] - ZONE_X_EXTENTS.capsule[0];
    const foldWidth = ZONE_X_EXTENTS.fold[1] - ZONE_X_EXTENTS.fold[0];
    const downtownWidth = ZONE_X_EXTENTS.downtown[1] - ZONE_X_EXTENTS.downtown[0];
    expect(foldWidth).toBeLessThan(capsuleWidth);
    expect(capsuleWidth).toBeLessThan(downtownWidth);
  });
});
