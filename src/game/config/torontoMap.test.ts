// Phase 75 (T0) — the ROAD_MEDIAN + LANE_OFFSET_WU LAW tests.
//
// WHY THIS FILE EXISTS: Phase 75 doubled every road width (D1) and gave the two widest classes a
// grass median (D3). Both changes are pure data in config/torontoMap.ts, and both have a property
// that MUST hold and that no downstream test was checking:
//
//   1. LANE_OFFSET_WU used to be `min(0.25 x width, 2.2)`. The 2.2 CAP was the old safety
//      mechanism — a blunt clamp that guaranteed a lane centre could not leave its own ribbon on
//      the narrowest class. At the doubled widths that cap binds on EVERY class, which would have
//      pinned both travel directions to the centreline — straddling the new median on spine and
//      artery — while 8+ wu of new asphalt sat unused. D6 removed the cap and replaced it with
//      the carriageway centre. THIS FILE IS THE REPLACEMENT SAFETY MECHANISM: a clamp silently
//      produces a wrong-but-legal number, a law test fails loudly and names the class.
//
//   2. Which classes carry a median, and the per-street override mechanism, are policy — the kind
//      of rule that rots into a hand-copied literal three files away if nothing pins it.
//
// The ROAD_CLASSES width derivation, the class ORDERING invariant and the per-street width pins
// live in world/toronto/streets.test.ts's "config sanity — car-derived widths" block (they were
// there before this phase and stay there). This file owns the median + lane-offset laws.

import { describe, expect, it } from 'vitest';
import { CAR_REF } from './cityPackScale';
import { GROUND_STACK } from './layering';
import {
  carriagewayCentreWu,
  defaultMedianWidthWu,
  LANE_OFFSET_WU,
  ROAD_CLASSES,
  ROAD_MEDIAN,
  SIDEWALK,
  type RoadClass,
} from './torontoMap';

const CLASSES: readonly RoadClass[] = ['spine', 'artery', 'major', 'minor'];

/** Half a player car — the width the lane law has to fit on each side of a lane centre. */
const CAR_HALF_WU = CAR_REF.widthWu / 2;

/**
 * THE LANE LAW, as a predicate: a car of CAR_REF width centred on `offset` must lie strictly
 * inside its own ribbon (its outer flank clears the curb) AND strictly outside the median (its
 * inner flank clears the planted strip). Exposed as a function so the tests below can prove it
 * has teeth by feeding it offsets that are known-wrong.
 */
function laneFits(cls: RoadClass, offset: number): boolean {
  const halfWidth = ROAD_CLASSES[cls] / 2;
  const medianHalfWidth = defaultMedianWidthWu(cls) / 2;
  const inner = offset - CAR_HALF_WU;
  const outer = offset + CAR_HALF_WU;
  return inner > medianHalfWidth && outer < halfWidth;
}

describe('LANE_OFFSET_WU — the carriageway-centre law (Phase 75 D6; replaces the deleted 2.2 cap)', () => {
  it('every class lane centre puts a whole car strictly inside the ribbon and strictly outside the median', () => {
    for (const cls of CLASSES) {
      const halfWidth = ROAD_CLASSES[cls] / 2;
      const medianHalfWidth = defaultMedianWidthWu(cls) / 2;
      const offset = LANE_OFFSET_WU[cls];
      const inner = offset - CAR_HALF_WU;
      const outer = offset + CAR_HALF_WU;
      expect(inner, `${cls}: lane inner flank ${inner} must clear the median half-width ${medianHalfWidth}`).toBeGreaterThan(
        medianHalfWidth,
      );
      expect(outer, `${cls}: lane outer flank ${outer} must stay inside the ribbon half-width ${halfWidth}`).toBeLessThan(
        halfWidth,
      );
    }
  });

  it('THE LAW HAS TEETH — reinstating the 2.2 cap puts the car ON the median of every median class', () => {
    // The old `min(0.25 x width, 2.2)` value, which at the Phase 75 widths would bind on ALL FOUR
    // classes. On spine and artery it is a hard violation: the lane's inner flank lands exactly on
    // the median edge (2.2 − 1.1 = 1.1 = the median half-width), i.e. the car drives through the
    // planted strip. THIS is the defect the deleted cap would now cause and the law above catches.
    for (const cls of CLASSES) {
      if (defaultMedianWidthWu(cls) === 0) continue;
      expect(laneFits(cls, CAR_REF.widthWu), `${cls} @ the old capped offset`).toBe(false);
    }
  });

  it('…and on the median-less classes the capped offset is merely WASTEFUL, which the value pins catch', () => {
    // Honest scope: on major/minor a 2.2 offset is still geometrically legal (inner 1.1 > 0, outer
    // 3.3 < 8.8/6.6) — it just hugs the centreline and leaves the outer half of a 17.6 wu road
    // unused, which is the navigability loss, not a collision. That regression is caught by the
    // "reduces to 0.25 x width" + "is UNCAPPED" + value pins below, not by the containment law —
    // recorded here so nobody later "strengthens" the law into asserting something untrue.
    for (const cls of CLASSES) {
      if (defaultMedianWidthWu(cls) > 0) continue;
      expect(laneFits(cls, CAR_REF.widthWu), `${cls} @ the old capped offset`).toBe(true);
      expect(LANE_OFFSET_WU[cls], `${cls} shipped offset`).toBeGreaterThan(CAR_REF.widthWu);
    }
  });

  it('THE LAW HAS TEETH — a curb-hugging offset (the ribbon edge) fails on every class', () => {
    for (const cls of CLASSES) {
      expect(laneFits(cls, ROAD_CLASSES[cls] / 2), `${cls} @ the curb`).toBe(false);
    }
  });

  it('THE LAW HAS TEETH — a centreline offset (no lane separation at all) fails on every class', () => {
    for (const cls of CLASSES) {
      expect(laneFits(cls, 0), `${cls} @ the centreline`).toBe(false);
    }
  });

  it('the shipped offsets all pass the same predicate the counter-examples fail', () => {
    for (const cls of CLASSES) {
      expect(laneFits(cls, LANE_OFFSET_WU[cls]), cls).toBe(true);
    }
  });

  it('is exactly the carriageway centre of its own class (derivation, not a hand-typed number)', () => {
    for (const cls of CLASSES) {
      expect(LANE_OFFSET_WU[cls], cls).toBeCloseTo(carriagewayCentreWu(ROAD_CLASSES[cls], defaultMedianWidthWu(cls)), 9);
    }
  });

  it('reduces to the historic 0.25 x width on classes with no median (major/minor unchanged in form)', () => {
    for (const cls of CLASSES) {
      if (defaultMedianWidthWu(cls) > 0) continue;
      expect(LANE_OFFSET_WU[cls], cls).toBeCloseTo(0.25 * ROAD_CLASSES[cls], 9);
    }
  });

  it('is UNCAPPED — spine/artery exceed the one-car-width clamp the Phase 31 rule used to impose', () => {
    // The regression this phase exists to prevent: with the cap alive, both directions hug the
    // centreline and the widening buys nothing.
    expect(LANE_OFFSET_WU.spine).toBeGreaterThan(CAR_REF.widthWu);
    expect(LANE_OFFSET_WU.artery).toBeGreaterThan(CAR_REF.widthWu);
    expect(LANE_OFFSET_WU.major).toBeGreaterThan(CAR_REF.widthWu);
    expect(LANE_OFFSET_WU.minor).toBeGreaterThan(CAR_REF.widthWu);
  });

  it('mirrors the class ordering (a wider road pushes its lanes further out)', () => {
    expect(LANE_OFFSET_WU.spine).toBeGreaterThan(LANE_OFFSET_WU.artery);
    expect(LANE_OFFSET_WU.artery).toBeGreaterThan(LANE_OFFSET_WU.major);
    expect(LANE_OFFSET_WU.major).toBeGreaterThan(LANE_OFFSET_WU.minor);
  });

  it('matches the Phase 75 values (spine 6.05 / artery 5.5 / major 4.4 / minor 3.3)', () => {
    expect(LANE_OFFSET_WU.spine).toBeCloseTo(6.05, 9);
    expect(LANE_OFFSET_WU.artery).toBeCloseTo(5.5, 9);
    expect(LANE_OFFSET_WU.major).toBeCloseTo(4.4, 9);
    expect(LANE_OFFSET_WU.minor).toBeCloseTo(3.3, 9);
  });

  it('leaves the same clearance to the median edge as to the curb (that IS the carriageway centre)', () => {
    for (const cls of CLASSES) {
      const toMedian = LANE_OFFSET_WU[cls] - defaultMedianWidthWu(cls) / 2;
      const toCurb = ROAD_CLASSES[cls] / 2 - LANE_OFFSET_WU[cls];
      expect(toMedian, cls).toBeCloseTo(toCurb, 9);
    }
  });
});

describe('carriagewayCentreWu — the one lane-offset formula', () => {
  it('is the midpoint between the median edge and the curb', () => {
    expect(carriagewayCentreWu(22, 2.2)).toBeCloseTo((1.1 + 11) / 2, 9);
  });

  it('collapses to a quarter width when there is no median', () => {
    expect(carriagewayCentreWu(13.2, 0)).toBeCloseTo(0.25 * 13.2, 9);
  });

  it('a wider median pushes the lane centre outward (monotonic in the median width)', () => {
    expect(carriagewayCentreWu(22, 4)).toBeGreaterThan(carriagewayCentreWu(22, 2.2));
  });
});

describe('ROAD_MEDIAN — the median exists as DATA (Phase 75 D3)', () => {
  it('every median width is CAR_REF-derived — exactly one player-car width, never a literal', () => {
    for (const cls of CLASSES) {
      if (ROAD_MEDIAN.policy[cls] === 'never') {
        expect(ROAD_MEDIAN.widthWu[cls], cls).toBe(0);
        continue;
      }
      expect(ROAD_MEDIAN.widthWu[cls], cls).toBeCloseTo(CAR_REF.widthWu, 9);
    }
  });

  it('only spine and artery carry one by default; major is opt-in; minor never', () => {
    expect(ROAD_MEDIAN.policy).toEqual({
      spine: 'always',
      artery: 'always',
      major: 'optIn',
      minor: 'never',
    });
    expect(defaultMedianWidthWu('spine')).toBeCloseTo(CAR_REF.widthWu, 9);
    expect(defaultMedianWidthWu('artery')).toBeCloseTo(CAR_REF.widthWu, 9);
    expect(defaultMedianWidthWu('major')).toBe(0);
    expect(defaultMedianWidthWu('minor')).toBe(0);
  });

  it('leaves every carriageway at least two car widths wide (D3: a median must not re-create the single-lane problem)', () => {
    for (const cls of CLASSES) {
      const carriageway = (ROAD_CLASSES[cls] - defaultMedianWidthWu(cls)) / 2;
      expect(carriageway, `${cls} carriageway`).toBeGreaterThanOrEqual(2 * CAR_REF.widthWu);
    }
  });

  it('a median never eats more than a fifth of its own ribbon', () => {
    for (const cls of CLASSES) {
      expect(ROAD_MEDIAN.widthWu[cls] / ROAD_CLASSES[cls], cls).toBeLessThanOrEqual(0.2);
    }
  });

  it('the kerb step and kerb face are the city\'s ONE kerb (shared with the raised sidewalk band)', () => {
    expect(ROAD_MEDIAN.curbHeightWu).toBe(SIDEWALK.curbHeightWu);
    expect(ROAD_MEDIAN.curbFaceColor).toBe(SIDEWALK.curbFaceColor);
    expect(ROAD_MEDIAN.curbHeightWu).toBeGreaterThan(0);
  });

  it('colliders are OFF pending the T5 curb-hop measurement (drive feel outranks the visual)', () => {
    // If T5's probe trio ever flips this to true, that is a deliberate re-pin here plus the
    // measured verdict written into ROAD_MEDIAN's own comment — never a silent flip.
    expect(ROAD_MEDIAN.colliders).toBe(false);
  });

  it('adds NO GROUND_STACK rung — the raised band is a geometry height, not a coplanarity epsilon', () => {
    // The median sits INSIDE the ribbon footprint and the asphalt quad covers the whole ribbon, so
    // a flat quad below `roadSurface` would be buried under its own road. It rides the same path
    // the raised sidewalk band already proves (config/layering.ts's "NOT A RUNG" note). This pins
    // that decision: no rung named for the median, and its kerb height is not a rung value.
    expect(Object.keys(GROUND_STACK).some((k) => k.toLowerCase().includes('median'))).toBe(false);
    for (const [name, rung] of Object.entries(GROUND_STACK)) {
      expect(rung, `${name} must not tie the median kerb height`).not.toBe(ROAD_MEDIAN.curbHeightWu);
    }
  });
});
