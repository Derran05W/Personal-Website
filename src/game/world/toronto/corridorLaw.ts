// THE CORRIDOR-AIRSPACE LAW, re-derived (Phase 76 T0).
//
// WHY THIS LIVES IN world/toronto/ AND NOT IN config/camera.ts. The bound is a property of the
// WORLD, not of the camera — config/camera.law.test.ts said exactly that in its own header, and
// then wrote the bound down as the literal `14.8` anyway, which is how it survived two road
// re-grades without moving. Phase 75 doubled every ribbon; this module is the re-derivation, and
// it is a module (not a constant) so the number can never again be right at one road width and
// silently wrong at the next.
//
// ─── THE DERIVATION CHAIN ────────────────────────────────────────────────────────────────────
//
//  1. THE FACADE PLANE. A frontage building's front face lands flush on the outer edge of the
//     sidewalk band, so the streetwall face plane sits `street.halfWidth + SIDEWALK.widthWu` off
//     the centreline. That expression is stated in three independent places already —
//     frontage.ts's `slotCenter` / `districtRefPoint` (which add the model's own depth-half on top
//     to get the box CENTRE), frontage.ts's corner-fill placement, and dev/feelProbes.ts's
//     `clearHalfWidthM` — and `facadeOffsetWu()` below is the fourth. It is derived from
//     `Street.halfWidth`, never from ROAD_CLASSES, because a per-street median opt-in exists and
//     the per-street resolution is the one downstream consumers read.
//
//  2. THE EYE'S PER-AXIS OFFSET. fx/cameraRig.ts's `sphericalOffset` puts the eye at
//     x = hr·sin(yaw), z = hr·cos(yaw) with hr = dist·cos(pitch). A street's clearance is measured
//     on ONE perpendicular axis (x for an 'ns' street, z for an 'ew' one), so the binding fraction
//     is max(|sin yaw|, |cos yaw|) — `CORRIDOR_PER_AXIS_FRACTION`, read out of the rig's own
//     function rather than restated, so a yaw change moves it. At the pinned yaw 45 both axes tie
//     at 1/√2, which is why the ceiling is `clearance·√2`.
//
//  3. THE CEILING. `corridorEyeCeilingWu(clearance) = clearance / CORRIDOR_PER_AXIS_FRACTION`.
//
//  4. WHICH CLEARANCE. Three references, and the choice is the whole finding (see below):
//        centreline  = facadeOffset                  (car on the centreline — the historic claim)
//        worstLane   = facadeOffset − laneOffset     (car on the lane TOWARD the camera side)
//        bestLane    = facadeOffset + laneOffset     (car on the far lane)
//     The eye's x and z offsets are both POSITIVE at yaw 45, so "toward the camera side" means the
//     +x lane on an 'ns' street and the +z lane on an 'ew' one. Traffic uses both, and the player
//     uses whichever it likes, so `worstLane` is the one that describes normal play.
//
// ─── FINDING 1: WHERE `14.8` ACTUALLY CAME FROM (it is not a derivation) ─────────────────────
//
// The shipped constant was `CORRIDOR_MAX_HR_WU = 14.8`, sourced to "Phase 33 Discovery 3". Three
// documents state its geometry identically — phase-33-notes.md ("on the dieted spine (15.4 road +
// 3 sidewalk) the streetwall face plane sits ~10.7 wu off the centreline"), config/camera.ts's
// header, and preset E's own comment ("hr > ~14.8, i.e. > 10.7 per axis under the 45° yaw"). All
// three are wrong twice over, and the second error is the load-bearing one:
//
//   • ARITHMETIC. 10.7·√2 = 15.132, not 14.8. The stated per-axis figure and the stated hr figure
//     do not describe the same rig; 14.8/√2 = 10.465. There is no term that reconciles them.
//
//   • STALE INPUT (the real problem). 15.4 wu is the Phase 25.6 spine. Phase 27's road diet cut it
//     to `CAR_REF.widthWu · 5 = 11.0` — verified against the tree at commit 4ffe2d7, six phases
//     before the Phase 33 lab ran. The width table live when the number was measured gave
//     halfWidth 5.5 + sidewalk 3 = 8.5 wu of facade offset, i.e. a geometric ceiling of
//     **12.02 wu**. So 14.8 was never 0.3 wu of conservatism on a 15.13 bound (the reading Phase
//     76's own plan carried in): it was **2.78 wu / +23 % MORE PERMISSIVE than the geometry it
//     claimed to state.** The number that got rounded down was computed against a road that had
//     not existed for six phases.
//
//   • WHAT IT REALLY WAS. An EMPIRICAL discriminator, fitted to the Phase 33 battery and given a
//     geometric story afterwards. Preset B's horizontal radius is 28·cos58° = 14.838, and B is the
//     only rig the lab measured going eye-inside near the boundary (1 of 4 drives, on a wedge).
//     "~14.8" is B's own hr rounded down to three digits — the largest bound that still rejects
//     the rig that failed. That is a legitimate thing to have; it was simply mislabelled as
//     geometry. `CORRIDOR_EMPIRICAL_MAX_HR_WU` below carries it forward DERIVED from preset B
//     instead of typed, so its provenance is in the code rather than in a comment.
//
// ─── FINDING 2: THE CENTRELINE REFERENCE IS WRONG, AND PHASE 75 MADE IT WORSE ────────────────
//
// The recorded law assumes the car sits on the centreline. It does not — it sits on a lane, and
// Phase 75 roughly tripled `LANE_OFFSET_WU` (spine 2.2 → 6.05, artery 2.2 → 5.5, major 2.2 → 4.4,
// minor 1.65 → 3.3) when it re-derived lane centres to the carriageway centre. On the camera side
// of the street the lane push very nearly cancels the width gain: worst-lane spine clearance went
// 8.5 → 7.95 wu, i.e. slightly WORSE, while the centreline ceiling rose 31 %. Reporting only the
// centreline number would tell a reader the corridor opened up when on the binding side it did
// not. Both references are therefore first-class here and both are pinned in corridorLaw.test.ts.
//
// ─── FINDING 3: THE CORRIDOR STOPPED BEING THE BINDING CONSTRAINT AT PHASE 35 ────────────────
//
// The airspace bound only binds where the facade is TALLER than the eye. Phase 35 shipped
// `STREETWALL_MAX_HEIGHT_WU = CAMERA_EYE_MIN_WU − STREETWALL_EYE_MARGIN_WU = 21.05 wu`, enforced
// structurally inside `resolveCityPackScale()` — so every ordinary pack facade is below the 22.05
// resting eye and the eye clears its roofline instead of entering it. Only the counted crosser set
// (heightLaw.test.ts block (d): backdrop-tower boxes, tall back-lot boxes, the named towers, the
// heroes) can trap the eye at all, and those are Phase 36's dither-fade / anti-clip work order.
//
// This is verified, not asserted: `corridorLaw.test.ts` re-checks the cap against
// `resolveCityPackScale` and asserts every pack building resolves below `CAMERA_EYE_MIN_WU`.
//
// It is also the only explanation that fits the measurements. Rig E's hr of 13.78 exceeded the
// then-live geometric ceiling of 12.02 by 1.76 wu **at Phase 33, before the cap existed**, and
// still measured 0.0 % eye-inside; it exceeds today's minor-class ceiling of 13.58 and measured
// 0.0 % eye-inside at all 7 Phase 75 vantages. A bound that a clean rig violates continuously is
// not the operative constraint. The honest headline of this re-derivation is therefore not "the
// corridor opened up 31 %" but **"the corridor is a secondary constraint; the eye line is the
// primary one."** The ceilings below are still worth computing — they are what a rig must respect
// where a crosser DOES front a street — but a future camera decision that treats
// `min(all class ceilings)` as a hard gate will reject rigs the world can actually carry.
//
// Pure + deterministic: no three/react, no fs, no seed. Safe for tests, dev tooling and prod.

import { CAMERA_PRESETS } from '../../config/camera';
import { CAR_REF } from '../../config/cityPackScale';
import { carriagewayCentreWu, defaultMedianWidthWu, ROAD_CLASSES, SIDEWALK, type RoadClass } from '../../config/torontoMap';
import { sphericalOffset } from '../../fx/cameraRig';
import type { Street } from './streets';

const DEG2RAD = Math.PI / 180;

/**
 * The fraction of the camera's horizontal radius that lands on a street's PERPENDICULAR axis —
 * the quantity a corridor clearance actually bounds.
 *
 * Read out of the production rig (`sphericalOffset` at unit distance) rather than restated as
 * `cos(45°)`: the offset's x and z components are `sin(yaw)` and `cos(yaw)` scaled by the shared
 * `cos(pitch)`, so normalising by hr cancels pitch exactly and leaves a pure function of yaw. An
 * 'ns' street is bounded by the x component and an 'ew' street by the z component, so the binding
 * case is the LARGER of the two. At the pinned yaw 45 they tie at 1/√2 = 0.7071, which is where
 * the familiar `clearance·√2` comes from — but nothing here hardcodes 45 or √2, so the day yaw
 * moves this moves with it.
 */
export const CORRIDOR_PER_AXIS_FRACTION = (() => {
  const unit = sphericalOffset({ x: 0, y: 0, z: 0 }, 1, 0, 0);
  const hr = Math.hypot(unit.x, unit.z);
  return Math.max(Math.abs(unit.x), Math.abs(unit.z)) / hr;
})();

/**
 * The largest camera horizontal radius (wu) that keeps the eye inside a corridor offering
 * `clearanceWu` of lateral room on the camera side. The inverse of the per-axis projection above.
 */
export function corridorEyeCeilingWu(clearanceWu: number): number {
  return clearanceWu / CORRIDOR_PER_AXIS_FRACTION;
}

/**
 * Distance (wu) from a street's centreline to its streetwall FACE plane: the ribbon half-width
 * plus the sidewalk band. Derived from `Street.halfWidth` so a per-street width ever diverging
 * from its class table is honoured automatically.
 *
 * NOT the frontage box's centre — frontage.ts adds the model's own depth-half beyond this line to
 * place the centre, precisely so the FACE lands here.
 */
export function facadeOffsetWu(street: Street): number {
  return street.halfWidth + SIDEWALK.widthWu;
}

/**
 * Distance (wu) from a street's centreline to a carriageway (lane) centre — where a car actually
 * drives. Uses the street's OWN resolved median width, so an 'optIn' major that ever plants a
 * median gets the right, smaller carriageway rather than silently inheriting the class number.
 */
export function laneOffsetWu(street: Street): number {
  return carriagewayCentreWu(street.width, street.medianWidth);
}

/** Which lateral clearance a corridor ceiling is measured against. */
export type CorridorReference = 'centreline' | 'worstLane' | 'bestLane';

export const CORRIDOR_REFERENCES: readonly CorridorReference[] = ['centreline', 'worstLane', 'bestLane'];

/** A corridor's clearances and the camera horizontal-radius ceiling each one implies. */
export interface CorridorCeilings {
  /** Centreline → streetwall face plane (wu). */
  readonly facadeOffsetWu: number;
  /** Centreline → carriageway centre (wu). */
  readonly laneOffsetWu: number;
  /** Lateral clearance (wu) per reference: car on the centreline / on the camera-side lane / on
   * the far lane. `worstLane` is the one that describes normal play. */
  readonly clearanceWu: Readonly<Record<CorridorReference, number>>;
  /** Max camera horizontal radius (wu) per reference. */
  readonly hrCeilingWu: Readonly<Record<CorridorReference, number>>;
}

function ceilingsFrom(facade: number, lane: number): CorridorCeilings {
  const clearanceWu = {
    centreline: facade,
    worstLane: facade - lane,
    bestLane: facade + lane,
  } as const;
  return {
    facadeOffsetWu: facade,
    laneOffsetWu: lane,
    clearanceWu,
    hrCeilingWu: {
      centreline: corridorEyeCeilingWu(clearanceWu.centreline),
      worstLane: corridorEyeCeilingWu(clearanceWu.worstLane),
      bestLane: corridorEyeCeilingWu(clearanceWu.bestLane),
    },
  };
}

/** The corridor ceilings of one BUILT street — the authoritative per-street answer. */
export function streetCorridorCeilings(street: Street): CorridorCeilings {
  return ceilingsFrom(facadeOffsetWu(street), laneOffsetWu(street));
}

/**
 * The corridor ceilings of a road CLASS, assuming that class's DEFAULT median (an 'optIn' class
 * contributes 0 — the same assumption `LANE_OFFSET_WU` itself is built on). A convenience for
 * reasoning about the map as four numbers; `streetCorridorCeilings` is the truth for a given
 * street, and corridorLaw.test.ts pins that the two agree for every street the map builds.
 */
export function roadClassCorridorCeilings(cls: RoadClass): CorridorCeilings {
  const width = ROAD_CLASSES[cls];
  return ceilingsFrom(width / 2 + SIDEWALK.widthWu, carriagewayCentreWu(width, defaultMedianWidthWu(cls)));
}

/** The per-class corridor table — the map's corridor geometry as four rows. Pinned as a
 * MEASUREMENT in corridorLaw.test.ts (the Phase 75 tripwire tradition): it reports first if a
 * future phase touches road widths, lane offsets or the sidewalk band. */
export const CORRIDOR_CEILINGS_BY_CLASS: Readonly<Record<RoadClass, CorridorCeilings>> = {
  spine: roadClassCorridorCeilings('spine'),
  artery: roadClassCorridorCeilings('artery'),
  major: roadClassCorridorCeilings('major'),
  minor: roadClassCorridorCeilings('minor'),
};

const ROAD_CLASS_IDS = Object.keys(CORRIDOR_CEILINGS_BY_CLASS) as readonly RoadClass[];

/** Which road class binds (the tightest ceiling) under a given reference, and by how much. */
export function bindingCorridorClass(reference: CorridorReference): { cls: RoadClass; hrCeilingWu: number } {
  let best: { cls: RoadClass; hrCeilingWu: number } | null = null;
  for (const cls of ROAD_CLASS_IDS) {
    const hrCeilingWu = CORRIDOR_CEILINGS_BY_CLASS[cls].hrCeilingWu[reference];
    if (best === null || hrCeilingWu < best.hrCeilingWu) best = { cls, hrCeilingWu };
  }
  // ROAD_CLASSES is a non-empty `as const` object, so this is unreachable; stated for the type.
  if (best === null) throw new Error('corridorLaw: no road classes to bind on');
  return best;
}

/**
 * Margin (wu) a camera horizontal radius has against a class's ceiling — positive = inside the
 * corridor, negative = the eye leaves the street's airspace on that class under that reference.
 */
export function corridorMarginWu(hrWu: number, cls: RoadClass, reference: CorridorReference): number {
  return CORRIDOR_CEILINGS_BY_CLASS[cls].hrCeilingWu[reference] - hrWu;
}

/** Does a camera horizontal radius stay inside the corridor of `cls` under `reference`? */
export function corridorClearsClass(hrWu: number, cls: RoadClass, reference: CorridorReference): boolean {
  return corridorMarginWu(hrWu, cls, reference) >= 0;
}

/** Horizontal radius (wu) of a lab preset at REST — `baseDist·cos(pitch)`, the quantity the whole
 * corridor law is stated in. Loud if the preset id is gone: the empirical bound below is sourced
 * to a specific measured rig, and a silent fallback would turn evidence into folklore. */
export function presetHorizontalRadiusWu(id: string): number {
  const preset = CAMERA_PRESETS.find((p) => p.id === id);
  if (!preset) {
    throw new Error(`corridorLaw: camera preset '${id}' is gone — the empirical corridor bound is sourced to it`);
  }
  return preset.baseDist * Math.cos(preset.pitchDeg * DEG2RAD);
}

/**
 * The road class the GEOMETRIC half of the law is asserted against (centreline-referenced).
 *
 * CALIBRATED, AND SAID SO. It is the tightest class the shipped envelope actually clears — which
 * is a fitted choice, not a derived one, and naming it here is the whole point: the classes below
 * it (`minor` at the centreline; every class under `worstLane`) are PINNED AS EXCURSIONS instead of
 * asserted, because asserting them would encode a false statement about a rig that measures 0.0 %
 * eye-inside. It is also the class the map is mostly made of and the one carrying the Phase 33
 * evidence vantages (financial-canyon = Bay × King, both major), so it is not an arbitrary pick —
 * corridorLaw.test.ts pins the class census so "mostly made of" stays a measured claim.
 *
 * A rig whose horizontal radius exceeds this ceiling has left the airspace of half the downtown
 * grid and needs the same evidence Phase 33 demanded, not a widened constant.
 */
export const CORRIDOR_ASSERTED_GEOMETRIC_CLASS: RoadClass = 'major';

/** The lab preset the empirical bound is sourced to — the ONE rig measured going eye-inside near
 * the boundary (Phase 33: 1 of 4 drives, on a wedge that angled it into the frontage). */
export const CORRIDOR_EMPIRICAL_SOURCE_PRESET_ID = 'B';

/**
 * THE ASSERTED BOUND (wu) — the largest camera horizontal radius the Phase 33 battery ever
 * measured to be UNSAFE, derived from the preset it was measured on rather than typed.
 *
 * WHY EMPIRICAL AND NOT GEOMETRIC. There is no single geometric ceiling that is both asserted and
 * TRUE of the shipped rig: the centreline table rejects it on `minor` and the worst-lane table
 * rejects it on all four classes, while it measures 0.0 % eye-inside everywhere it has ever been
 * pointed. Asserting a geometric `min()` would encode a false statement about a rig with a clean
 * measured record, and "fixing" that by widening the bound is how a law becomes decoration. So the
 * geometry is PINNED as a measurement (with its shortfalls named) and the TRIPWIRE is this: stay
 * strictly below the smallest horizontal radius ever measured to fail.
 *
 * PROVENANCE, honestly labelled. This is what `14.8` always was — see FINDING 1 in the header.
 * Carrying it as `presetHorizontalRadiusWu('B')` = 14.838 rather than the literal 14.8 relaxes the
 * old constant by 0.038 wu (0.26 %), which is the rounding the original applied to get a tidier
 * number; every rig it rejected it still rejects, and the strict `<` keeps B itself out.
 *
 * WHAT IT IS NOT. Not a geometric guarantee, and not transferable to a differently-shaped world —
 * it is calibrated to the crosser population that existed when it was measured. If Parts 12-16 add
 * street-fronting towers, the geometric ceilings below become the live constraint again and this
 * bound stops being sufficient.
 */
export const CORRIDOR_EMPIRICAL_MAX_HR_WU = presetHorizontalRadiusWu(CORRIDOR_EMPIRICAL_SOURCE_PRESET_ID);

/** The spine's car-width grade under the Phase 27 road diet — a HISTORICAL fact (commit 4ffe2d7's
 * `spine: CAR_REF.widthWu * 5`), not a tunable. Phase 75 doubled it to 10. */
const PHASE33_SPINE_CAR_WIDTHS = 5;

/**
 * The geometric ceiling (wu) that was live when `14.8` was measured — the Phase 27 dieted spine
 * (5 car widths = 11.0, halfWidth 5.5 + sidewalk 3 = 8.5 of facade offset) — expressed through the
 * SAME `CAR_REF.widthWu` and `SIDEWALK.widthWu` the live table uses, so the comparison in FINDING 1
 * stays honest if either ever moves. 12.02 wu.
 *
 * Kept as an exported constant, not a comment, because it is the evidence for the claim that the
 * shipped bound was permissive rather than conservative, and comments do not fail tests.
 */
export const CORRIDOR_PHASE33_SPINE_HR_CEILING_WU = corridorEyeCeilingWu(
  (CAR_REF.widthWu * PHASE33_SPINE_CAR_WIDTHS) / 2 + SIDEWALK.widthWu,
);

/** The value `camera.law.test.ts` carried from Phase 34 until Phase 76, kept only so the
 * re-derivation can assert what changed. Never use it as a bound. */
export const CORRIDOR_SHIPPED_LITERAL_HR_WU_PRE_P76 = 14.8;
