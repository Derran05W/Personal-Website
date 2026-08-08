// THE CORRIDOR-AIRSPACE LAW — the world half (Phase 76 T0).
//
// config/camera.law.test.ts owns the CAMERA half: it asserts the shipped rig stays inside the
// bound. This file owns the bound itself — where it comes from, what it is worth, and the two
// places the shipped rig knowingly sits outside it. The split follows the constraint's own
// nature: the ceiling is a property of the WORLD (road widths, lane offsets, the sidewalk band),
// which is exactly what camera.law.test.ts's header always said and exactly why the number
// belonged over here rather than as a literal over there.
//
// READ world/toronto/corridorLaw.ts's header first — the derivation chain and the three findings
// this file pins are written down there.
import { describe, expect, it } from 'vitest';
import {
  bindingCorridorClass,
  CORRIDOR_ASSERTED_GEOMETRIC_CLASS,
  CORRIDOR_CEILINGS_BY_CLASS,
  CORRIDOR_EMPIRICAL_MAX_HR_WU,
  CORRIDOR_EMPIRICAL_SOURCE_PRESET_ID,
  CORRIDOR_PER_AXIS_FRACTION,
  CORRIDOR_PHASE33_SPINE_HR_CEILING_WU,
  CORRIDOR_REFERENCES,
  CORRIDOR_SHIPPED_LITERAL_HR_WU_PRE_P76,
  corridorEyeCeilingWu,
  corridorMarginWu,
  facadeOffsetWu,
  laneOffsetWu,
  presetHorizontalRadiusWu,
  roadClassCorridorCeilings,
  streetCorridorCeilings,
} from './corridorLaw';
import { buildStreets } from './streets';
import { CAMERA, CAMERA_EYE_MIN_WU } from '../../config/camera';
import { CAR_REF, resolveCityPackScale, STREETWALL_MAX_HEIGHT_WU } from '../../config/cityPackScale';
import { LANE_OFFSET_WU, ROAD_CLASSES, SIDEWALK, type RoadClass } from '../../config/torontoMap';
import { CITY_PACK_MANIFEST } from '../../assets/cityPackManifest';
import { STARTER_TOP_SPEED } from '../../config/vehicles';
import { cameraDistance, cameraPitchOffsetDeg, sphericalOffset } from '../../fx/cameraRig';

const CLASSES: readonly RoadClass[] = ['spine', 'artery', 'major', 'minor'];

/** Pack manifest entries that are ORDINARY streetwall facades — the same filter heightLaw.test.ts
 * uses, so the two files can never disagree about what "ordinary" means. */
const PACK_BUILDINGS = CITY_PACK_MANIFEST.filter((e) => e.category === 'building' || e.category === 'building-blank');
const TIERS = [0, 1, 2, 3, 4, 5] as const;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** The shipped rig's horizontal radius for a player state, solved through the PRODUCTION path —
 * the same `envelope()` helper camera.law.test.ts uses, restated here rather than exported across
 * a test boundary so neither file can quietly change the other's meaning. */
function shippedHr(speed: number, tier: number): number {
  const offset = sphericalOffset(
    { x: 0, y: 0, z: 0 },
    cameraDistance(speed, tier, 0),
    0,
    cameraPitchOffsetDeg(speed, tier),
  );
  return Math.hypot(offset.x, offset.z);
}

/** Worst (largest) horizontal radius anywhere in the normal-play envelope, found by a DENSE sweep
 * of the speed ramp rather than by sampling its ends — hr is not monotonic in either input (see
 * the excursion block below), so a three-point sample can miss the maximum. */
const SPEED_SAMPLES = Array.from({ length: 201 }, (_, i) => (STARTER_TOP_SPEED * i) / 200);
const ENVELOPE = TIERS.flatMap((tier) =>
  SPEED_SAMPLES.map((speed) => ({ tier, speed, hr: shippedHr(speed, tier) })),
);
const SHIPPED_WORST = ENVELOPE.reduce((a, b) => (b.hr > a.hr ? b : a));
const SHIPPED_WORST_HR_WU = SHIPPED_WORST.hr;

describe('corridor law — the derivation chain', () => {
  // The one place the trigonometry is checked against the rig instead of against itself. If a
  // future phase moves yaw off 45, this fails and names the reason: the two street axes stop
  // tying and the binding fraction becomes the larger of sin/cos.
  it('the per-axis fraction is the rig\'s own yaw projection, and ties at 1/√2 under yaw 45', () => {
    const yaw = (CAMERA.yawDeg * Math.PI) / 180;
    expect(CORRIDOR_PER_AXIS_FRACTION).toBeCloseTo(Math.max(Math.abs(Math.sin(yaw)), Math.abs(Math.cos(yaw))), 12);
    expect(CAMERA.yawDeg).toBe(45); // the pin that makes the next line meaningful
    expect(CORRIDOR_PER_AXIS_FRACTION).toBeCloseTo(Math.SQRT1_2, 12);
    // ...so the familiar closed form holds, without anything hardcoding √2.
    expect(corridorEyeCeilingWu(10)).toBeCloseTo(10 * Math.SQRT2, 12);
  });

  it('is monotonic: more clearance is never a lower ceiling, and zero clearance is zero', () => {
    expect(corridorEyeCeilingWu(0)).toBe(0);
    expect(corridorEyeCeilingWu(9)).toBeLessThan(corridorEyeCeilingWu(9.5));
  });

  // THE ANTI-DRIFT ASSERTION. facadeOffsetWu duplicates an expression that already exists in
  // frontage.ts (slotCenter / districtRefPoint / the corner-fill walk) and dev/feelProbes.ts
  // (clearHalfWidthM). Re-stating it here is only safe while it keeps matching, so it is checked
  // against every street the map actually builds, from Street.halfWidth — never from ROAD_CLASSES.
  it('the facade plane is halfWidth + sidewalk on every built street', () => {
    const { streets } = buildStreets();
    expect(streets.length).toBeGreaterThan(0);
    for (const s of streets) {
      expect(facadeOffsetWu(s), s.id).toBeCloseTo(s.halfWidth + SIDEWALK.widthWu, 12);
      expect(facadeOffsetWu(s), s.id).toBeCloseTo(ROAD_CLASSES[s.cls] / 2 + SIDEWALK.widthWu, 12);
    }
  });

  // THE MEDIAN OPT-IN TRIPWIRE. The class table below assumes each class's DEFAULT median, which
  // is the same assumption LANE_OFFSET_WU is built on. The first street that ever opts a major in
  // breaks that assumption — and this test is what makes it loud instead of silent. (streets.test
  // .ts pins the same coupling for the traffic graph; this is the corridor's copy of it.)
  it('per-street ceilings agree with the class table — until a street opts a median in', () => {
    const { streets } = buildStreets();
    for (const s of streets) {
      expect(laneOffsetWu(s), s.id).toBeCloseTo(LANE_OFFSET_WU[s.cls], 12);
      const perStreet = streetCorridorCeilings(s);
      const perClass = roadClassCorridorCeilings(s.cls);
      for (const ref of CORRIDOR_REFERENCES) {
        expect(perStreet.hrCeilingWu[ref], `${s.id}/${ref}`).toBeCloseTo(perClass.hrCeilingWu[ref], 12);
      }
    }
  });
});

describe('corridor law — THE PINNED TABLE (a measurement, not an assertion)', () => {
  // Phase 75's tripwire tradition: pin the geometry as a measurement so it REPORTS FIRST if a
  // future phase touches road widths, lane offsets or the sidewalk band. A failure here is not a
  // bug — it is the corridor law telling you its inputs moved and the camera decision may need
  // re-opening. Restate the numbers; do not widen anything to make it pass.
  it('pins the per-class corridor geometry (wu)', () => {
    const table = Object.fromEntries(
      CLASSES.map((cls) => {
        const c = CORRIDOR_CEILINGS_BY_CLASS[cls];
        return [
          cls,
          {
            facade: round2(c.facadeOffsetWu),
            lane: round2(c.laneOffsetWu),
            centreline: round2(c.hrCeilingWu.centreline),
            worstLane: round2(c.hrCeilingWu.worstLane),
            bestLane: round2(c.hrCeilingWu.bestLane),
          },
        ];
      }),
    );
    expect(table).toEqual({
      spine: { facade: 14.0, lane: 6.05, centreline: 19.8, worstLane: 11.24, bestLane: 28.35 },
      artery: { facade: 12.9, lane: 5.5, centreline: 18.24, worstLane: 10.47, bestLane: 26.02 },
      major: { facade: 11.8, lane: 4.4, centreline: 16.69, worstLane: 10.47, bestLane: 22.91 },
      minor: { facade: 9.6, lane: 3.3, centreline: 13.58, worstLane: 8.91, bestLane: 18.24 },
    });
  });

  it('pins which class binds under each reference', () => {
    expect(bindingCorridorClass('centreline')).toEqual({ cls: 'minor', hrCeilingWu: expect.closeTo(13.58, 2) });
    expect(bindingCorridorClass('worstLane')).toEqual({ cls: 'minor', hrCeilingWu: expect.closeTo(8.91, 2) });
    expect(bindingCorridorClass('bestLane')).toEqual({ cls: 'minor', hrCeilingWu: expect.closeTo(18.24, 2) });
  });

  // FINDING 2, as a number. Phase 75 doubled every ribbon, which raised the CENTRELINE ceiling
  // 31 % on the spine — and re-derived LANE_OFFSET_WU to the carriageway centre in the same edit,
  // which spent nearly all of it back on the camera side. Anyone reading only the centreline row
  // would conclude the corridor opened up; on the reference that describes normal play it closed
  // slightly. Both halves are pinned so the claim survives its own author.
  it('the widening moved the two references in OPPOSITE directions on the spine', () => {
    const preP75Facade = (CAR_REF.widthWu * 5) / 2 + SIDEWALK.widthWu; // Phase 27 diet: 5 car widths
    const preP75Lane = 2.2; // the Phase 31 cap, which bound on every class pre-P75
    const spine = CORRIDOR_CEILINGS_BY_CLASS.spine;

    // Centreline: 12.02 -> 19.80, +64 % (the spine doubled outright).
    expect(spine.hrCeilingWu.centreline / corridorEyeCeilingWu(preP75Facade)).toBeGreaterThan(1.6);
    // Worst lane: 8.5 - 2.2 = 6.3 wu of clearance became 7.95 — better, but only by a quarter,
    // and in ABSOLUTE terms the binding ceiling is still 11.24 vs the rig's 14.42.
    expect(spine.clearanceWu.worstLane).toBeCloseTo(7.95, 6);
    expect(spine.hrCeilingWu.worstLane).toBeLessThan(SHIPPED_WORST_HR_WU);
    expect(corridorEyeCeilingWu(preP75Facade - preP75Lane)).toBeLessThan(spine.hrCeilingWu.worstLane);
  });

  // Backs the "the class the map is mostly made of" claim in CORRIDOR_ASSERTED_GEOMETRIC_CLASS's
  // rationale with a census instead of an adjective.
  it('pins the class census — major is the class the grid is made of', () => {
    const { streets } = buildStreets();
    const census = Object.fromEntries(CLASSES.map((cls) => [cls, streets.filter((s) => s.cls === cls).length]));
    expect(census).toEqual({ spine: 1, artery: 3, major: 13, minor: 7 });
    expect(census.major).toBeGreaterThan(census.spine + census.artery + census.minor - census.major);
  });
});

describe('corridor law — resolving the 14.8 discrepancy', () => {
  // FINDING 1. The shipped constant was documented as geometry in three places (phase-33-notes.md,
  // config/camera.ts's header, preset E's comment) and is not geometry. These assertions are the
  // audit trail; each one is a claim the header makes, made falsifiable.

  it('14.8 is not the geometric ceiling of ANY class under ANY reference, then or now', () => {
    for (const cls of CLASSES) {
      for (const ref of CORRIDOR_REFERENCES) {
        expect(
          Math.abs(CORRIDOR_CEILINGS_BY_CLASS[cls].hrCeilingWu[ref] - CORRIDOR_SHIPPED_LITERAL_HR_WU_PRE_P76),
          `${cls}/${ref}`,
        ).toBeGreaterThan(0.5);
      }
    }
  });

  // THE CORE CORRECTION, and it inverts Phase 76's own plan. The plan (and the phase-33 note it
  // trusted) computed the historical bound off a 15.4 wu spine — the Phase 25.6 width, superseded
  // by Phase 27's road diet SIX PHASES before the Phase 33 lab ran. Against the table that was
  // actually live, 14.8 was permissive by 2.78 wu (+23 %), not conservative by 0.33.
  it('was MORE permissive than the geometry live when it was measured, not more conservative', () => {
    expect(CORRIDOR_PHASE33_SPINE_HR_CEILING_WU).toBeCloseTo(12.02, 2);
    expect(CORRIDOR_SHIPPED_LITERAL_HR_WU_PRE_P76).toBeGreaterThan(CORRIDOR_PHASE33_SPINE_HR_CEILING_WU);
    expect(CORRIDOR_SHIPPED_LITERAL_HR_WU_PRE_P76 - CORRIDOR_PHASE33_SPINE_HR_CEILING_WU).toBeCloseTo(2.78, 2);
  });

  it('the note\'s own arithmetic never closed either: the 15.4 wu spine gives 15.13, not 14.8', () => {
    const phase25_6SpineFacade = (CAR_REF.widthWu * 7) / 2 + SIDEWALK.widthWu; // 15.4 wu spine → 10.7
    expect(phase25_6SpineFacade).toBeCloseTo(10.7, 6);
    expect(corridorEyeCeilingWu(phase25_6SpineFacade)).toBeCloseTo(15.13, 2);
    // And the "> 10.7 per axis" half of the same sentence describes a DIFFERENT hr again:
    expect(CORRIDOR_SHIPPED_LITERAL_HR_WU_PRE_P76 * CORRIDOR_PER_AXIS_FRACTION).toBeCloseTo(10.47, 2);
  });

  // What it really was: preset B's own horizontal radius, rounded down to three digits — the
  // largest bound that still rejects the one rig the lab measured failing.
  it('IS preset B\'s horizontal radius, rounded down (the empirical discriminator)', () => {
    expect(presetHorizontalRadiusWu(CORRIDOR_EMPIRICAL_SOURCE_PRESET_ID)).toBeCloseTo(14.84, 2);
    expect(CORRIDOR_EMPIRICAL_MAX_HR_WU).toBeCloseTo(14.84, 2);
    expect(CORRIDOR_EMPIRICAL_MAX_HR_WU - CORRIDOR_SHIPPED_LITERAL_HR_WU_PRE_P76).toBeCloseTo(0.038, 3);
  });

  it('is sourced to a preset that still exists — and says so loudly if it stops existing', () => {
    expect(() => presetHorizontalRadiusWu('not-a-preset')).toThrow(/corridor law|corridorLaw/i);
  });
});

describe('corridor law — the asserted bound', () => {
  // THE TRIPWIRE that replaces the 14.8 literal. Empirical by construction (see the constant's
  // own rationale): stay strictly below the smallest horizontal radius ever MEASURED to fail.
  it('the shipped envelope stays strictly inside the measured-unsafe radius', () => {
    for (const tier of TIERS) {
      for (const speed of [0, STARTER_TOP_SPEED * 0.5, STARTER_TOP_SPEED]) {
        expect(shippedHr(speed, tier), `★${tier} @ ${speed}`).toBeLessThan(CORRIDOR_EMPIRICAL_MAX_HR_WU);
      }
    }
  });

  it('the bound actually rejects the rig it was measured on (it is not vacuous)', () => {
    expect(presetHorizontalRadiusWu('B')).toBeGreaterThanOrEqual(CORRIDOR_EMPIRICAL_MAX_HR_WU);
    // ...and preset A, the rig whose fold-corridor frame was a 100 %-of-frames wall, is further out
    // still — the bound's ordering matches the measured outcomes.
    expect(presetHorizontalRadiusWu('A')).toBeGreaterThan(presetHorizontalRadiusWu('E'));
  });

  // The GEOMETRIC half, asserted against the one named class the shipped rig clears. Calibrated
  // and labelled as such at the constant; the classes it does NOT clear are pinned below.
  it('the shipped envelope stays inside the asserted geometric class at the centreline', () => {
    expect(CORRIDOR_ASSERTED_GEOMETRIC_CLASS).toBe('major');
    for (const tier of TIERS) {
      for (const speed of [0, STARTER_TOP_SPEED]) {
        expect(
          corridorMarginWu(shippedHr(speed, tier), CORRIDOR_ASSERTED_GEOMETRIC_CLASS, 'centreline'),
          `★${tier} @ ${speed}`,
        ).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('corridor law — the shipped rig\'s EXCURSIONS (pinned, so they stay evidence)', () => {
  // Pinning a known excursion is what stops it becoming folklore. Both of these are cases where
  // the shipped rig sits OUTSIDE a geometric ceiling and has nonetheless measured 0.0 % eye-inside
  // — at all 7 Phase 34 vantages, at all 7 Phase 75 vantages, and across every drive in between.
  // If either line ever needs relaxing, the correct response is new measurement, not a bigger
  // number. FINDING 3 (below) is why they are survivable.

  // A CORRECTION TO THE RECORD, found by sweeping instead of sampling. phase-34-notes.md and
  // config/camera.ts's header both name "14.42 rest/★5 (worst)" as the envelope's worst pose. It is
  // not: hr peaks at rest ★4 (14.4281) and comes back DOWN at ★5 (14.4221), because tierPitchDeg's
  // shortening finally out-runs tierZoom's lengthening on the last step of the ladder. The
  // magnitude is trivial (0.006 wu) but the shape is not — "worst = the top of the ladder" is
  // false for this rig, and any future candidate must be swept, not sampled at its ends.
  it('pins the worst horizontal radius in the whole envelope: 14.43 wu at REST, ★4', () => {
    expect(SHIPPED_WORST_HR_WU).toBeCloseTo(14.43, 2);
    expect({ tier: SHIPPED_WORST.tier, speed: SHIPPED_WORST.speed }).toEqual({ tier: 4, speed: 0 });
    expect(shippedHr(0, 5)).toBeCloseTo(14.42, 2); // ★5 is LOWER than ★4
    expect(shippedHr(0, 5)).toBeLessThan(SHIPPED_WORST_HR_WU);
    expect(shippedHr(0, 0)).toBeCloseTo(13.78, 2); // ...and rest ★0 is the familiar 13.78
    // Speed only ever SHORTENS hr (the Phase 34 split's whole point), so the worst pose is at rest
    // on every tier — asserted, because it is what makes "sweep the tiers" sufficient.
    for (const tier of TIERS) {
      expect(shippedHr(STARTER_TOP_SPEED, tier), `★${tier}`).toBeLessThan(shippedHr(0, tier));
    }
  });

  it('EXCURSION 1 — it exceeds the MINOR-street centreline ceiling by 0.85 wu', () => {
    const minor = CORRIDOR_CEILINGS_BY_CLASS.minor.hrCeilingWu.centreline;
    expect(minor).toBeCloseTo(13.58, 2);
    expect(SHIPPED_WORST_HR_WU).toBeGreaterThan(minor);
    expect(SHIPPED_WORST_HR_WU - minor).toBeCloseTo(0.85, 2);
    // Even the calmest pose in the game — parked, no heat — is over it.
    expect(shippedHr(0, 0)).toBeGreaterThan(minor);
    // Clears the other three, which is why 'major' is the asserted class.
    for (const cls of ['spine', 'artery', 'major'] as const) {
      expect(corridorMarginWu(SHIPPED_WORST_HR_WU, cls, 'centreline'), cls).toBeGreaterThan(0);
    }
  });

  it('EXCURSION 2 — it exceeds the worst-lane ceiling of ALL FOUR classes', () => {
    for (const cls of CLASSES) {
      expect(corridorMarginWu(SHIPPED_WORST_HR_WU, cls, 'worstLane'), cls).toBeLessThan(0);
    }
    // Worst case: on a minor street's camera-side lane the eye is 5.52 wu past the ceiling.
    expect(SHIPPED_WORST_HR_WU - CORRIDOR_CEILINGS_BY_CLASS.minor.hrCeilingWu.worstLane).toBeCloseTo(5.52, 2);
    // This is NOT new to Phase 75: pre-P75 the spine's worst-lane ceiling was 8.91 wu and the same
    // rig ran at the same 14.43. The widening changed the size of a long-standing excursion, not
    // its existence.
    expect(corridorEyeCeilingWu((CAR_REF.widthWu * 5) / 2 + SIDEWALK.widthWu - 2.2)).toBeLessThan(SHIPPED_WORST_HR_WU);
  });
});

describe('corridor law — FINDING 3: superseded by the Phase 35 eye line', () => {
  // The claim: the corridor bound only binds where the facade is TALLER than the eye, and since
  // Phase 35 ordinary streetwall structurally is not. VERIFIED against the code rather than
  // asserted from the plan — if resolveCityPackScale ever stops capping, these fail and the
  // corridor is promoted back to primary constraint.

  it('the streetwall cap is real, structural, and below the resting eye', () => {
    expect(STREETWALL_MAX_HEIGHT_WU).toBeLessThan(CAMERA_EYE_MIN_WU);
    expect(CAMERA_EYE_MIN_WU).toBeCloseTo(22.05, 2);
    expect(STREETWALL_MAX_HEIGHT_WU).toBeCloseTo(21.05, 2);
  });

  it('every pack building model resolves BELOW the resting eye through resolveCityPackScale', () => {
    const buildings = PACK_BUILDINGS;
    expect(buildings.length).toBeGreaterThan(0);
    for (const m of buildings) {
      expect(m.nativeDims.h * resolveCityPackScale(m.id), m.id).toBeLessThan(CAMERA_EYE_MIN_WU);
    }
  });

  // The consequence, stated as the thing a future camera phase must not forget: on ordinary
  // streetwall the eye clears the roofline, so a corridor excursion costs nothing. Only the
  // counted crosser set (heightLaw.test.ts block (d)) can trap the eye, and that set is Phase
  // 36's dither-fade/anti-clip work order — a different mechanism with its own tests.
  it('so the eye clears ordinary streetwall outright, with margin at every legal pose', () => {
    const lowestEye = CAMERA_EYE_MIN_WU;
    const tallestOrdinaryFacade = Math.max(...PACK_BUILDINGS.map((m) => m.nativeDims.h * resolveCityPackScale(m.id)));
    expect(tallestOrdinaryFacade).toBeLessThanOrEqual(STREETWALL_MAX_HEIGHT_WU + 1e-9);
    expect(lowestEye - tallestOrdinaryFacade).toBeGreaterThanOrEqual(1.0 - 1e-9);
  });
});
