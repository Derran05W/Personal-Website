// Phase 39 — the ground-stack ladder LAW test. Written test-first (CLAUDE.md's map-phase
// workflow contract): `src/game/config/layering.ts` does not exist yet, so this whole file
// currently fails on a missing-module resolution error, not a syntax error — that is the
// expected, correct failure mode until the implementer lands the module. Once layering.ts
// ships with the two stacks below, this file is the durable regression: any future rung that
// silently ties, un-sorts, or drifts off its pinned value fails here first.
//
// Why this exists: `.planning/part-10-placement-integrity.md`'s audit (2026-07-26) found the
// city's near-coplanar Y offsets were hand-picked per file with no shared source of truth —
// two EXACT ties were live (SKID.yOffset 0.030 === the rainbow-crosswalk stripe Y 0.030 in
// placesLayer.ts, and SEARCHLIGHT.ground.yOffset 0.050 === WATER_Y 0.050 in TorontoScene.tsx),
// plus the city-pack `manhole-cover` model's top face landing EXACTLY on `ROAD_Y` (0.020) —
// guaranteed z-fight ("the flashing thing," per the user's Part 10 directive). GROUND_STACK
// and WALL_STACK are the fix: one ordered, minimum-separation-enforced ladder every producer
// reads from instead of inventing its own epsilon. The literal values below are LAW, not a
// suggestion — pin them exactly; a future rung is added to the ladder (never squeezed between
// existing ones without moving them), so re-running this test after that addition should still
// pass unchanged for every OTHER rung.

import { describe, expect, it } from 'vitest';
import { getCityPackModel } from '../assets/cityPackManifest';
import { GROUND_STACK, MIN_GROUND_SEP_WU, MIN_WALL_SEP_WU, SURFACE_ANCHOR, WALL_STACK } from './layering';
import { SIDEWALK } from './torontoMap';

// Float compare tolerance for the derived-value checks below (SURFACE_ANCHOR is defined AS an
// arithmetic function of GROUND_STACK + MIN_GROUND_SEP_WU, so exact equality would be fragile to
// binary floating-point rounding of numbers like 0.02 + 0.004 — this is not a "some slop is fine"
// tolerance, it is the standard float-equality guard).
const EPS = 1e-9;

describe('GROUND_STACK — every rung pinned exactly', () => {
  // PHASE 45 RE-PIN (deliberate, per the ladder's own "spliced deliberately, moving neighbours as
  // needed" rule — see layering.ts's Phase 45 note): the rail lands needed two new ground surfaces
  // between `parkGround` and the road (a gravel BALLAST bed, and the TIE/turntable marks painted
  // INSIDE that bed's own footprint — two surfaces, therefore two rungs, because one shared rung
  // would be a guaranteed coplanar pair). The 0.004 wu gap available there could not hold them, so
  // `railBallast` 0.016 / `railTrack` 0.020 were spliced in and EVERY rung above moved +0.008 wu.
  // Nothing outside this file re-types a rung value, so the whole migration is this pin.
  // PHASE 46 RE-PIN (deliberate, same rule): Union Station's sunken-carriageway paint strip needed
  // a rung, and it is the first surface in the city that rides the RAISED SIDEWALK band rather than
  // the ground/road plane — every existing rung is below `SIDEWALK.curbHeightWu` (0.12) and would
  // simply be buried under the walk. `unionMoat` is therefore APPENDED at the top of the ladder
  // (0.128 = curb top + 2 × MIN_GROUND_SEP_WU) instead of spliced into the road band. No existing
  // rung moved — the append is why this pin is a one-line addition rather than a whole-ladder shift
  // like Phase 45's.
  it('matches the law values (Phase 39, re-pinned P45 rail splice + P46 moat + P47 civic splice)', () => {
    expect(GROUND_STACK).toEqual({
      ground: 0.0,
      districtTint: 0.008,
      parkGround: 0.012,
      railBallast: 0.016,
      railTrack: 0.02,
      civicPlaza: 0.024,
      civicRink: 0.028,
      edgeBoxBase: 0.032,
      roadSurface: 0.036,
      roadPaint: 0.042,
      crosswalk: 0.048,
      placesRoadArt: 0.054,
      skid: 0.064,
      scorch: 0.07,
      water: 0.076,
      groundFx: 0.082,
      unionMoat: 0.128,
    });
  });

  it('is strictly ascending in declaration order, every rung unique, every adjacent gap clearing MIN_GROUND_SEP_WU', () => {
    const values = Object.values(GROUND_STACK);
    expect(values.length).toBeGreaterThan(1);
    for (let i = 1; i < values.length; i++) {
      const prev = values[i - 1]!;
      const cur = values[i]!;
      expect(cur, `rung ${i} (${cur}) must be strictly greater than rung ${i - 1} (${prev})`).toBeGreaterThan(prev);
      const gap = cur - prev;
      expect(
        gap,
        `gap between rung ${i - 1} and rung ${i} is ${gap}, below MIN_GROUND_SEP_WU (${MIN_GROUND_SEP_WU})`,
      ).toBeGreaterThanOrEqual(MIN_GROUND_SEP_WU - EPS);
    }
    expect(new Set(values).size, 'GROUND_STACK must have no duplicate rung values').toBe(values.length);
  });
});

describe('WALL_STACK — every rung pinned exactly', () => {
  it('matches the Phase 39 law values', () => {
    expect(WALL_STACK).toEqual({
      lightInset: 0.02,
      windowInset: 0.04,
      crownDecal: 0.05,
      fasciaBand: 0.07,
    });
  });

  it('is strictly ascending in declaration order, every rung unique, every adjacent gap clearing MIN_WALL_SEP_WU', () => {
    const values = Object.values(WALL_STACK);
    expect(values.length).toBeGreaterThan(1);
    for (let i = 1; i < values.length; i++) {
      const prev = values[i - 1]!;
      const cur = values[i]!;
      expect(cur, `rung ${i} (${cur}) must be strictly greater than rung ${i - 1} (${prev})`).toBeGreaterThan(prev);
      const gap = cur - prev;
      expect(
        gap,
        `gap between rung ${i - 1} and rung ${i} is ${gap}, below MIN_WALL_SEP_WU (${MIN_WALL_SEP_WU})`,
      ).toBeGreaterThanOrEqual(MIN_WALL_SEP_WU - EPS);
    }
    expect(new Set(values).size, 'WALL_STACK must have no duplicate rung values').toBe(values.length);
  });
});

describe('SURFACE_ANCHOR — the road/ground placement-lift rule', () => {
  it('road anchor sits exactly one ground separation above roadSurface (the manhole/road-bits fix)', () => {
    expect(SURFACE_ANCHOR.road).toBeCloseTo(GROUND_STACK.roadSurface + MIN_GROUND_SEP_WU, 9);
  });

  it('ground anchor sits strictly between districtTint and edgeBoxBase, and deliberately dodges the parkGround + railBallast rungs', () => {
    expect(SURFACE_ANCHOR.ground).toBeGreaterThan(GROUND_STACK.districtTint);
    expect(SURFACE_ANCHOR.ground).toBeLessThan(GROUND_STACK.edgeBoxBase);
    expect(Math.abs(SURFACE_ANCHOR.ground - GROUND_STACK.parkGround)).toBeGreaterThan(EPS);
    // Phase 45: the splice put `railBallast` between this anchor and `edgeBoxBase`. A flat prop
    // resting on bare dirt must still dodge it — the anchor is an ANCHOR, not a rung, so it is
    // allowed to sit inside a rung gap, but never ON a rung.
    expect(Math.abs(SURFACE_ANCHOR.ground - GROUND_STACK.railBallast)).toBeGreaterThan(EPS);
  });
});

describe('cross-stack sanity — the Phase-46 on-sidewalk rung', () => {
  it('unionMoat clears the RAISED sidewalk band top (SIDEWALK.curbHeightWu) by at least one ground separation', () => {
    // The moat strip is painted INSIDE the flush gap between Union Station's facade and Front
    // Street's ribbon — ground the raised sidewalk band already occupies. A rung below the curb top
    // would be geometrically invisible, so this relationship (not the literal) is the real law.
    expect(GROUND_STACK.unionMoat).toBeGreaterThanOrEqual(SIDEWALK.curbHeightWu + MIN_GROUND_SEP_WU - EPS);
    // …and it must still be the TOP of the ladder: nothing may paint over the walk-level strip
    // without a deliberate re-pin here.
    const values = Object.values(GROUND_STACK);
    expect(values[values.length - 1]).toBe(GROUND_STACK.unionMoat);
  });
});

describe('cross-stack sanity — the manhole-cover invariant', () => {
  it('SURFACE_ANCHOR.road + the manhole-cover native height clears both placesRoadArt and skid by at least MIN_GROUND_SEP_WU', () => {
    // Read the manhole-cover's native (pre-scale) height straight off the city-pack manifest —
    // the pack is placed at scale 1.0 (config/cityPackScale.ts has no override for it), so its
    // native height IS its world-space height. Never hardcode this: a pack regen can change it.
    const manholeHeightWu = getCityPackModel('manhole-cover').nativeDims.h;
    const manholeTopWu = SURFACE_ANCHOR.road + manholeHeightWu;

    const gapToRoadArt = Math.abs(manholeTopWu - GROUND_STACK.placesRoadArt);
    expect(
      gapToRoadArt,
      `manhole-cover top (${manholeTopWu}) sits ${gapToRoadArt} wu from placesRoadArt (${GROUND_STACK.placesRoadArt}) — below MIN_GROUND_SEP_WU`,
    ).toBeGreaterThanOrEqual(MIN_GROUND_SEP_WU - EPS);

    const gapToSkid = Math.abs(manholeTopWu - GROUND_STACK.skid);
    expect(
      gapToSkid,
      `manhole-cover top (${manholeTopWu}) sits ${gapToSkid} wu from skid (${GROUND_STACK.skid}) — below MIN_GROUND_SEP_WU`,
    ).toBeGreaterThanOrEqual(MIN_GROUND_SEP_WU - EPS);
  });
});
