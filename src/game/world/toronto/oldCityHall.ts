// Phase 47 T2 (Part 11) — OLD CITY HALL, the fourth tenant of the `namedGeometryBuilders` seam
// (namedGeometry.ts's header explains the seam; royalYork.ts is this file's structural template:
// a SHRUNK body render box carrying the §4 facade machinery, plus a bespoke mesh for everything
// above and in front of it).
//
// v1 was one extruded box: 23 × 23 wu of brick-red sandstone with a window grid on it. Old City
// Hall is E.J. Lennox's 1899 Romanesque Revival courthouse, and the two things everybody in
// Toronto actually pictures — the OFF-CENTRE CLOCK TOWER that terminates the Bay Street view, and
// the steep copper-patina roof over a heavy sandstone block — are exactly the two things a flat-
// topped box throws away.
//
// data/toronto/building-specs.json's R47 researcher notes (id `old-city-hall`) verify: 103.6 m to
// the top of the OFF-CENTRE clock tower; FOUR clock faces, each 3.5 m in diameter; reddish-brown
// Credit Valley sandstone with a contrasting darker New Brunswick course ("creating layered
// appearance"); a steep hipped roof with copper trimmings that have developed a patina; TRIPLE-
// ARCHED entrances; NE corner of Queen and Bay. Everything below is one of those features or a
// proportion derived from the DATA box.
//
// EXPLICITLY NOT RESEARCHED, stated not invented (Phase 44's beacon-cadence precedent, Phase 46's
// omitted Union clock): the time the clock hands show (a design literal, see CLOCK_TIME), the exact
// patina hex (royalYork.ts's palette caveat, same family), the dormer counts and the pinnacle
// treatment. Each is called out at its constant.
//
// SINGLE SOURCE OF TRUTH: every dimension is a proportion of the placement's own DATA box (its
// footprint half-extents and its §3c/NAMED_HEIGHT_SCALE height, both computed by namedBuildings.ts
// from the spec row). There is not one literal world coordinate in this file — only proportion
// literals, each carrying the reason it has the value it has (unionStation.ts's discipline).
//
// NO STREET CONTEXT NEEDED: unlike Osgoode Hall next door (whose lawn and fence are derived from
// Queen's and University's ribbons), everything here sits on or over the DATA footprint, so this
// builder takes only `placement` — structurally legal against the two-parameter
// `NamedGeometryBuilder` type, exactly as royalYork.ts documents.

import { WALL_STACK } from '../../config/layering';
import { lookForMaterial } from '../../config/torontoMaterials';
import {
  addBox,
  addFace,
  addTri,
  addTriFacing,
  faceNormal,
  createAccum,
  toGeometry,
  triangleCount,
  type Accum,
  type FaceOpts,
  type Quad,
  type Vec3,
} from './bespokeMesh';
import type { NamedBox, NamedPlacement } from './namedBuildings';
import { CIVIC_HEART_RENDER_GROUP } from './namedGeometry';
import type { NamedBespoke, NamedBespokeGeometry } from './namedGeometry';

// --- tri budget (Part 11 rule 2: stated per model, pinned in the phase that introduces them) -----

/** Body courses + roof + dormers + the whole clock tower + the triple-arched entry. Pinned by
 * oldCityHall.test.ts with a FLOOR as well as a ceiling — v1 was a 12-triangle box, and a
 * regression that quietly reverted to it would pass a ceiling-only budget (unionStation.test.ts's
 * idiom). */
export const OLD_CITY_HALL_MAX_TRIS = 900 as const;

// --- proportions (the only literals; each one carries its reason) --------------------------------

/**
 * Body (render-box) height as a fraction of the DATA height. The DATA height is the height to the
 * top of the CLOCK TOWER (the spec row says so in as many words), not to the cornice — so the body
 * has to be well short of it, and the gap is where the roof and the tower live. 0.52 puts the
 * cornice just above half, which is what a 4-storey block under a steep roof and a tower twice its
 * height reads as in elevation.
 */
const BODY_HEIGHT_FRAC = 0.52;

/** Plinth course + the darker mid-facade band ("layered appearance", researched) + the eave
 * cornice: three proud horizontal courses, absolute-literal because a course reads at a physical
 * thickness rather than as a fraction of the building (royalYork.ts's EAVE_CORNICE note). All
 * three stay far inside namedBuildings.ts's 3 wu massing-exclusion margin, so no claim or collider
 * change is owed. */
const PLINTH_H_WU = 0.7;
const PLINTH_PROUD_WU = 0.3;
const BAND_COURSE_H_WU = 0.45;
const BAND_COURSE_PROUD_WU = 0.22;
/** Where the darker course sits, as a fraction of the BODY height (a string course runs at a floor
 * line, i.e. proportionally — unlike its thickness). */
const BAND_COURSE_FRAC = 0.46;
const EAVE_CORNICE_H_WU = 0.55;
const EAVE_CORNICE_PROUD_WU = 0.45;

/** Roof ridge height as a fraction of the DATA height, and the ridge's own half-extent as a
 * fraction of the footprint half. Together they set the pitch: with the cornice at ~0.55 h the
 * slope runs ~4.9 wu up over ~8.5 wu of run ≈ 30°, which is a genuinely STEEP hipped roof at this
 * scale — steeper than the Royal York's 6–19° apron, which measured as a flat plate and needed the
 * two-tone/pavilion rescue. The two-tone stays anyway (see COPPER_PATINA): it is a measured palette
 * device, not a slope workaround. */
const ROOF_TOP_FRAC = 0.78;
const ROOF_RIDGE_FOOT_FRAC = 0.26;
/** Roof eave overhang past the body wall (wu) — deliberately LESS than EAVE_CORNICE_PROUD_WU so the
 * stone cornice still reads as a lip under the copper. */
const ROOF_EAVE_PROUD_WU = 0.3;
/** Copper ridge cresting: a thin proud strip along the ridge (the real roof's crested ironwork,
 * quoted as a solid because a to-scale cresting would be far under THIN_GEOMETRY.minStripeWidthWu). */
const RIDGE_CREST_H_WU = 0.28;
const RIDGE_CREST_PROUD_WU = 0.18;

/** Gable dormer rows on the two CAMERA-VISIBLE roof slopes (Phase 34's pinned south + east pair).
 * Counts are an aesthetic choice, NOT researched (the same caveat royalYork.ts's dormer counts
 * carry). Geometry is a fraction of the roof's own height so a dormer can never poke through the
 * ridge regardless of the absolute roof budget.
 *
 * NOTE these are the row's NOMINAL bay counts: the row is laid on one uniform pitch across the
 * whole slope and the bays the CLOCK TOWER occupies are then dropped (`dormerPositions`), because a
 * dormer there would be built entirely inside the tower shaft — invisible geometry that still costs
 * triangles. `meta.probes.dormerCountSouth` reports what is actually emitted. */
const DORMER_COUNT_SOUTH = 7;
const DORMER_COUNT_EAST = 4;
const DORMER_ROW_T0 = 0.08; // where the row's base sits on the slope (0 = eave, 1 = ridge)
const DORMER_BODY_FRAC = 0.26; // dormer wall height, as a fraction of the roof height
const DORMER_GABLE_FRAC = 0.16; // its gable head, same units
/** Dormer half-width / proud depth (wu). Absolute and deliberately up-scaled for legibility past
 * THIN_GEOMETRY.minStripeWidthWu — the call royalYork.ts's DORMER_HALF_W_WU documents. */
const DORMER_HALF_W_WU = 0.6;
const DORMER_PROUD_WU = 0.55;
/** Clearance (wu) each row leaves at both ends of the slope it rides, so the corner-most dormer
 * never lands on the hip corner where two slopes meet. */
const DORMER_MARGIN_WU = 2;

/** Corner turrets: half-engaged tourelles on the block's corners, each capped by its own little
 * pyramid rising just past the main ridge. A DESIGN HINT in the Romanesque Revival idiom rather
 * than a researched profile (the R47 notes verify the steep hipped roof and the copper trimmings,
 * not the corner treatment) — and the one detail the 58° camera, which reads this building mostly
 * in plan, gets the most silhouette out of. Only the three corners the fixed rig can see are built
 * (south + east faces are the pinned camera-visible pair): the NW corner is never in frame. */
const TURRET_HALF_WU = 0.7;
const TURRET_BASE_BELOW_EAVE_WU = 1.2; // it plugs into the cornice instead of floating on it
const TURRET_SHAFT_TOP_FRAC = 0.72; // × the DATA height
const TURRET_APEX_FRAC = 0.8;

/**
 * THE CLOCK TOWER. `TOWER_X_OFFSET_FRAC` is the whole point of this landmark: the real tower is
 * OFF-CENTRE, set toward the WEST end of the Queen Street facade so that it closes the view north
 * up Bay Street (the researcher's "visual anchor for Bay Street"). Bay runs immediately west of
 * this lot — namedBuildings.ts places the box at `bay + 19` — so a tower west of the box centre is
 * the one that terminates that view, and `oldCityHall.test.ts` pins the sign of the offset rather
 * than trusting this comment.
 */
const TOWER_X_OFFSET_FRAC = 0.6; // × the footprint half-extent, WEST (−X) of the box centre
const TOWER_HALF_FRAC = 0.19; // × the footprint half-extent → a slender square shaft
/** How far the tower breaks the south facade line (wu). It is an ENGAGED tower: its north half is
 * buried in the block, its south face stands proud of the wall. Inside the 3 wu exclusion margin. */
const TOWER_PROUD_WU = 0.55;
/** Shaft top / clock-stage top, as fractions of the DATA height. The apex of the pyramidal cap
 * lands on the DATA height EXACTLY (by construction in `oldCityHallLayout`, never by a fraction
 * sum) — the spec row's 103.6 m IS the height to the top of the tower, so the CAP, not the shaft,
 * is what the data height describes. */
const TOWER_SHAFT_TOP_FRAC = 0.72;
const TOWER_STAGE_TOP_FRAC = 0.885;
/** The belfry/clock stage steps out past the shaft (wu), and the copper collar caps that stage. */
const TOWER_STAGE_PROUD_WU = 0.35;
const TOWER_COLLAR_H_WU = 0.3;
const TOWER_COLLAR_PROUD_WU = 0.12;
/** Corner pinnacle hints: four small posts at the stage corners, rising past the collar with a
 * pyramid cap of their own. Treatment is a HINT, not a researched profile. */
const PINNACLE_HALF_WU = 0.24;
const PINNACLE_BODY_FRAC = 0.36; // × the cap's height, above the collar
const PINNACLE_CAP_FRAC = 0.2;

/** Clock face: diameter as a fraction of the SMALLER of the stage's two dimensions (see
 * `clockRadius` in the layout — a dial sized off the width alone pokes out of a stage that is
 * taller than it is wide, or vice versa). The real dials are 3.5 m on a ~9 m tower face ≈ 0.39;
 * this reads a touch larger so the dial is legible at play distance. An octagon is the cheapest
 * shape that reads as a DISC at this size, and the hands are one quad each. */
const CLOCK_DIAMETER_FRAC = 0.62;
const CLOCK_HOUR_HAND_FRAC = 0.52; // × the dial radius
const CLOCK_MINUTE_HAND_FRAC = 0.86;
const CLOCK_HAND_HALF_W_WU = 0.09;
/**
 * THE TIME ON THE DIALS — a DESIGN LITERAL, not a researched fact: the world is a permanent
 * early-evening blue hour (CLAUDE.md's locked time-of-day), so the clocks are frozen at 8:20 pm,
 * which is both plausible for the light and the classic "hands apart" clock-photograph pose (a
 * 12:00 or 6:00 pose collapses the two hands into one stripe). Angles are derived from it below,
 * clockwise from 12.
 */
const CLOCK_TIME = { hour: 8, minute: 20 } as const;

/** The triple-arched Romanesque entry (researched). It rides a shallow SANDSTONE PORCH standing
 * proud of the body — building the arches on their own proud face means no quad is ever coplanar
 * with the render box's textured facade (the Phase 42 anti-coplanar rule applied at the source),
 * and the porch itself is the "sandstone surround" the arches are cut into. Centred on the TOWER,
 * because on the real building the main entrance sits at the tower's base. */
const PORCH_PROUD_WU = 0.9; // > TOWER_PROUD_WU, so the entry steps out IN FRONT of the tower base
const PORCH_HEIGHT_FRAC = 0.19; // × the DATA height
const PORCH_HALF_FRAC = 1.55; // × the tower half-width
const ARCH_COUNT = 3;
/** Arch opening: half-width as a fraction of its bay, springing line as a fraction of the porch
 * height, and the head's facet count (4 facets is where a semicircle stops reading as a triangle). */
const ARCH_HALF_FRAC = 0.34;
const ARCH_SPRING_FRAC = 0.5;
const ARCH_BASE_FRAC = 0.06;
const ARCH_HEAD_FACETS = 4;

// --- palette (unlit-literal; §4's brick_red look is the single source for the body colour) -------

/** The §4 look of the spec row's material — the render box's own facade fill, so every trim below
 * harmonizes with the machine-painted body rather than fighting it. */
const SANDSTONE = lookForMaterial('brick_red').fill;
const SANDSTONE_LIGHT = '#96654a'; // proud courses / porch / tower stage — proud elements read lighter
const SANDSTONE_DARK = '#5a3728'; // the contrasting darker (New Brunswick) course, researched
/**
 * Oxidized copper-green patina. APPROXIMATE, not researched (the same caveat royalYork.ts records
 * for the Royal York's roof); the two greens are deliberately NOT unified — a slope/cap two-tone is
 * the measured low-poly device that keeps a ridge legible when the facet tilt alone cannot
 * (royalYork.ts's evidence-frame finding), and this roof quotes the same family one lot away so the
 * two landmarks read as the same city.
 */
const COPPER_PATINA = '#4c7d63'; // ridge cap / cresting / collar — the lit copper
const COPPER_PATINA_DARK = '#33564a'; // slopes + dormer gables — same family, reads as shade
const CLOCK_FACE_FILL = '#ffe9c0'; // pale warm, unshaded: a lit dial at blue hour
const CLOCK_HAND_FILL = '#241c14'; // near-black hands, unshaded so they stay readable on the dial
const ARCH_VOID = '#241d18'; // the dark reveal inside each arch — depth by value, not by geometry

// --- local mesh helpers (bespokeMesh.ts is shared and owned elsewhere; these stay private) --------

/** `addTriFacing` with FaceOpts forwarded — the toolkit's own variant takes no options, and the
 * clock dials must be UNSHADED (a lit dial, not a stone facet). */
function addTriOpts(acc: Accum, a: Vec3, b: Vec3, c: Vec3, outward: Vec3, hex: string, opts: FaceOpts = {}): void {
  const [nx, ny, nz] = faceNormal(a, b, c);
  if (nx * outward[0] + ny * outward[1] + nz * outward[2] >= 0) addTri(acc, a, b, c, hex, opts);
  else addTri(acc, a, c, b, hex, opts);
}

/** An axis-aligned rectangular frustum from `(hx0, hz0)` at `y0` to `(hx1, hz1)` at `y1`, centred
 * on `(cx, cz)` — a hip-roof taper. `capHex` renders the flat top (pass `null` when the next solid
 * sits exactly on this footprint, so the seam stays enclosed and unrendered on both sides). */
function addTaperedBox(
  acc: Accum,
  y0: number,
  y1: number,
  cx: number,
  cz: number,
  hx0: number,
  hz0: number,
  hx1: number,
  hz1: number,
  hex: string,
  capHex: string | null,
): void {
  const corner = (hx: number, hz: number, y: number) => ({
    nn: [cx - hx, y, cz - hz] as Vec3,
    pn: [cx + hx, y, cz - hz] as Vec3,
    pp: [cx + hx, y, cz + hz] as Vec3,
    np: [cx - hx, y, cz + hz] as Vec3,
  });
  const lo = corner(hx0, hz0, y0);
  const hi = corner(hx1, hz1, y1);
  addFace(acc, [lo.nn, lo.pn, hi.pn, hi.nn], [0, 0, -1], hex);
  addFace(acc, [lo.pn, lo.pp, hi.pp, hi.pn], [1, 0, 0], hex);
  addFace(acc, [lo.pp, lo.np, hi.np, hi.pp], [0, 0, 1], hex);
  addFace(acc, [lo.np, lo.nn, hi.nn, hi.np], [-1, 0, 0], hex);
  if (capHex !== null) addFace(acc, [hi.nn, hi.pn, hi.pp, hi.np], [0, 1, 0], capHex);
}

/** A 4-sided pyramid over a rectangular base — exactly 4 triangles. */
function addPyramid(acc: Accum, cx: number, cz: number, hx: number, hz: number, y0: number, apexY: number, hex: string): void {
  const corners: readonly Vec3[] = [
    [cx - hx, y0, cz - hz],
    [cx + hx, y0, cz - hz],
    [cx + hx, y0, cz + hz],
    [cx - hx, y0, cz + hz],
  ];
  const apex: Vec3 = [cx, apexY, cz];
  const outward: readonly Vec3[] = [
    [0, 0, -1],
    [1, 0, 0],
    [0, 0, 1],
    [-1, 0, 0],
  ];
  for (let i = 0; i < 4; i++) addTriFacing(acc, corners[i], corners[(i + 1) % 4], apex, outward[i], hex);
}

// --- layout -----------------------------------------------------------------------------------

interface Span {
  readonly min: number;
  readonly max: number;
}

interface OldCityHallLayout {
  readonly box: NamedBox;
  readonly height: number;
  readonly zSouth: number;
  readonly bodyTopY: number;
  readonly bandCourseY: number;
  readonly roofBaseY: number;
  readonly roofBaseHalfX: number;
  readonly roofBaseHalfZ: number;
  readonly roofRidgeY: number;
  readonly roofRidgeHalfX: number;
  readonly roofRidgeHalfZ: number;
  readonly dormerRowY0: number;
  readonly dormerRowY1: number;
  /** The slope surface's own outward Z / X at the dormer row's base, and the half-extent there. */
  readonly southRowZ: number;
  readonly eastRowX: number;
  readonly southRowHalfX: number;
  readonly eastRowHalfZ: number;
  readonly towerCenterX: number;
  readonly towerCenterZ: number;
  readonly towerHalf: number;
  readonly towerShaftTopY: number;
  readonly towerStageTopY: number;
  readonly towerStageHalf: number;
  readonly towerCollarTopY: number;
  readonly towerTopY: number;
  readonly clockFaceY: number;
  readonly clockRadius: number;
  readonly porch: { readonly x: Span; readonly zFace: number; readonly topY: number };
}

/** Linear taper of a footprint half-extent from `full` at the roof's base (t = 0) to `full ×
 * ridgeFrac` at the ridge (t = 1) — the ONE rule the dormer row and the roof massing both read
 * through, so they can never drift apart. */
function taperedHalf(full: number, ridgeFrac: number, t: number): number {
  return full * (1 + t * (ridgeFrac - 1));
}

function oldCityHallLayout(placement: NamedPlacement): OldCityHallLayout {
  const box = placement.boxes[0];
  if (box === undefined) throw new Error('oldCityHall: placement has no data box');
  const height = box.hy * 2;
  const bodyTopY = BODY_HEIGHT_FRAC * height;
  const roofBaseY = bodyTopY + EAVE_CORNICE_H_WU;
  const roofRidgeY = ROOF_TOP_FRAC * height;
  if (roofRidgeY <= roofBaseY) throw new Error('oldCityHall: no vertical room between the cornice and the ridge');
  const roofH = roofRidgeY - roofBaseY;

  const roofBaseHalfX = box.hx + ROOF_EAVE_PROUD_WU;
  const roofBaseHalfZ = box.hz + ROOF_EAVE_PROUD_WU;
  const dormerRowY0 = roofBaseY + DORMER_ROW_T0 * roofH;

  const towerHalf = TOWER_HALF_FRAC * box.hx;
  const towerStageHalf = towerHalf + TOWER_STAGE_PROUD_WU;
  const towerStageTopY = TOWER_STAGE_TOP_FRAC * height;
  const towerCollarTopY = towerStageTopY + TOWER_COLLAR_H_WU;
  // The apex lands on the DATA height EXACTLY — that is what makes the shrunk render box legal
  // (heightLaw, the claims and the camera clip volumes all read the DATA box).
  const towerTopY = height;
  if (towerCollarTopY >= towerTopY) throw new Error('oldCityHall: the clock stage leaves no room for the tower cap');

  const porchTopY = PORCH_HEIGHT_FRAC * height;
  const porchHalf = PORCH_HALF_FRAC * towerHalf;
  const towerCenterX = box.cx - TOWER_X_OFFSET_FRAC * box.hx;
  const zSouth = box.cz + box.hz;

  return {
    box,
    height,
    zSouth,
    bodyTopY,
    bandCourseY: BAND_COURSE_FRAC * bodyTopY,
    roofBaseY,
    roofBaseHalfX,
    roofBaseHalfZ,
    roofRidgeY,
    roofRidgeHalfX: box.hx * ROOF_RIDGE_FOOT_FRAC,
    roofRidgeHalfZ: box.hz * ROOF_RIDGE_FOOT_FRAC,
    dormerRowY0,
    dormerRowY1: dormerRowY0 + (DORMER_BODY_FRAC + DORMER_GABLE_FRAC) * roofH,
    southRowZ: box.cz + taperedHalf(roofBaseHalfZ, ROOF_RIDGE_FOOT_FRAC, DORMER_ROW_T0),
    eastRowX: box.cx + taperedHalf(roofBaseHalfX, ROOF_RIDGE_FOOT_FRAC, DORMER_ROW_T0),
    southRowHalfX: taperedHalf(roofBaseHalfX, ROOF_RIDGE_FOOT_FRAC, DORMER_ROW_T0),
    eastRowHalfZ: taperedHalf(roofBaseHalfZ, ROOF_RIDGE_FOOT_FRAC, DORMER_ROW_T0),
    towerCenterX,
    // Engaged tower: its south face stands TOWER_PROUD_WU past the facade, its north half is
    // buried in the block.
    towerCenterZ: zSouth + TOWER_PROUD_WU - towerHalf,
    towerHalf,
    towerShaftTopY: TOWER_SHAFT_TOP_FRAC * height,
    towerStageTopY,
    towerStageHalf,
    towerCollarTopY,
    towerTopY,
    clockFaceY: ((TOWER_SHAFT_TOP_FRAC + TOWER_STAGE_TOP_FRAC) * height) / 2,
    // The dial is bounded by the SHORTER of the stage's two dimensions — on a belfry the stage is
    // taller than it is wide only sometimes, and a radius derived from the width alone would poke
    // the dial straight out of the top and bottom of the stage it rides.
    clockRadius: CLOCK_DIAMETER_FRAC * Math.min(towerStageHalf, (towerStageTopY - TOWER_SHAFT_TOP_FRAC * height) / 2),
    porch: { x: { min: towerCenterX - porchHalf, max: towerCenterX + porchHalf }, zFace: zSouth + PORCH_PROUD_WU, topY: porchTopY },
  };
}

// --- the body courses + the roof ------------------------------------------------------------------

function appendCourses(acc: Accum, L: OldCityHallLayout): void {
  const { box } = L;
  // Plinth, mid-facade band (the researched darker course) and eave cornice: three proud bands that
  // give a 23 wu block a bottom, a middle and a top. Without them the elevation is a slab.
  addBox(acc, box.cx, PLINTH_H_WU / 2, box.cz, box.hx + PLINTH_PROUD_WU, PLINTH_H_WU / 2, box.hz + PLINTH_PROUD_WU, SANDSTONE_LIGHT);
  addBox(
    acc,
    box.cx,
    L.bandCourseY,
    box.cz,
    box.hx + BAND_COURSE_PROUD_WU,
    BAND_COURSE_H_WU / 2,
    box.hz + BAND_COURSE_PROUD_WU,
    SANDSTONE_DARK,
  );
  addBox(
    acc,
    box.cx,
    (L.bodyTopY + L.roofBaseY) / 2,
    box.cz,
    box.hx + EAVE_CORNICE_PROUD_WU,
    (L.roofBaseY - L.bodyTopY) / 2,
    box.hz + EAVE_CORNICE_PROUD_WU,
    SANDSTONE_LIGHT,
  );
}

/** One gable dormer: a small sandstone box proud of the roof slope, headed by a copper gable whose
 * ridge runs perpendicular to the wall. The BACK faces are RENDERED (the P46 open-shell lesson: the
 * slope recedes inward faster over the dormer's height than the dormer is deep, so above the row
 * base the back plane stands clear of the slope and an unrendered back is a hole the 58° camera
 * looks straight into). */
function addGableDormer(acc: Accum, axis: 'south' | 'east', cx: number, cz: number, y0: number, y1: number): void {
  const bodyTopFrac = DORMER_BODY_FRAC / (DORMER_BODY_FRAC + DORMER_GABLE_FRAC);
  const bodyTopY = y0 + (y1 - y0) * bodyTopFrac;
  const hw = DORMER_HALF_W_WU;
  const proudHalf = DORMER_PROUD_WU / 2;
  const gable = (ax: number, az: number, halfAlong: number, halfOut: number, alongAxis: 'x' | 'z'): void => {
    // Ridge runs along the OUT axis (perpendicular to the wall); the two gable ends face along the
    // wall's own direction, the two slopes shed to either side.
    const p = (dAlong: number, dOut: number, y: number): Vec3 =>
      alongAxis === 'x' ? [ax + dAlong, y, az + dOut] : [ax + dOut, y, az + dAlong];
    const apexOut: readonly Vec3[] = [p(0, -halfOut, y1), p(0, halfOut, y1)];
    const base: readonly Vec3[] = [
      p(-halfAlong, -halfOut, bodyTopY),
      p(halfAlong, -halfOut, bodyTopY),
      p(halfAlong, halfOut, bodyTopY),
      p(-halfAlong, halfOut, bodyTopY),
    ];
    const outA: Vec3 = alongAxis === 'x' ? [0, 0, -1] : [-1, 0, 0];
    const outB: Vec3 = alongAxis === 'x' ? [0, 0, 1] : [1, 0, 0];
    addTriFacing(acc, base[0], base[1], apexOut[0], outA, COPPER_PATINA_DARK); // near gable end
    addTriFacing(acc, base[2], base[3], apexOut[1], outB, COPPER_PATINA_DARK); // far gable end (rendered back)
    addFace(acc, [base[1], base[2], apexOut[1], apexOut[0]], alongAxis === 'x' ? [1, 0, 0] : [0, 0, 1], COPPER_PATINA);
    addFace(acc, [base[3], base[0], apexOut[0], apexOut[1]], alongAxis === 'x' ? [-1, 0, 0] : [0, 0, -1], COPPER_PATINA);
  };
  if (axis === 'south') {
    const bodyZ = cz + proudHalf;
    addBox(acc, cx, (y0 + bodyTopY) / 2, bodyZ, hw, (bodyTopY - y0) / 2, proudHalf, SANDSTONE_LIGHT, { py: false });
    gable(cx, bodyZ, hw, proudHalf, 'x');
  } else {
    const bodyX = cx + proudHalf;
    addBox(acc, bodyX, (y0 + bodyTopY) / 2, cz, proudHalf, (bodyTopY - y0) / 2, hw, SANDSTONE_LIGHT, { py: false });
    gable(bodyX, cz, hw, proudHalf, 'z');
  }
}

/** Where a row's dormers actually land — ONE pure function shared by the geometry and by the
 * `dormerCount*` probes, so the pinned count can never disagree with the mesh. */
function dormerPositions(L: OldCityHallLayout, axis: 'south' | 'east'): number[] {
  const count = axis === 'south' ? DORMER_COUNT_SOUTH : DORMER_COUNT_EAST;
  const halfWidth = axis === 'south' ? L.southRowHalfX : L.eastRowHalfZ;
  const span = 2 * halfWidth - 2 * DORMER_MARGIN_WU;
  const pitch = span / count;
  const along0 = (axis === 'south' ? L.box.cx : L.box.cz) - span / 2;
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const along = along0 + (i + 0.5) * pitch;
    // Drop the bays the clock tower stands in (see DORMER_COUNT_SOUTH's note). The east row can
    // never hit the tower — it is 15 wu away across the block — but the test asserts that rather
    // than trusting the geometry to stay put.
    if (axis === 'south' && Math.abs(along - L.towerCenterX) < L.towerStageHalf + DORMER_HALF_W_WU) continue;
    out.push(along);
  }
  return out;
}

function appendDormerRow(acc: Accum, L: OldCityHallLayout, axis: 'south' | 'east'): void {
  for (const along of dormerPositions(L, axis)) {
    if (axis === 'south') addGableDormer(acc, 'south', along, L.southRowZ, L.dormerRowY0, L.dormerRowY1);
    else addGableDormer(acc, 'east', L.eastRowX, along, L.dormerRowY0, L.dormerRowY1);
  }
}

function appendRoof(acc: Accum, L: OldCityHallLayout): void {
  // The hipped mass: full (over-hanging) footprint at the cornice, tapering to a short ridge.
  // Slopes take the DARK green and the ridge cap the lit one — royalYork.ts's two-tone device.
  addTaperedBox(
    acc,
    L.roofBaseY,
    L.roofRidgeY,
    L.box.cx,
    L.box.cz,
    L.roofBaseHalfX,
    L.roofBaseHalfZ,
    L.roofRidgeHalfX,
    L.roofRidgeHalfZ,
    COPPER_PATINA_DARK,
    COPPER_PATINA,
  );
  // Ridge cresting: a thin proud strip standing on the ridge, so the summit has an edge instead of
  // ending in a bare quad (the flat-plate read royalYork.ts measured).
  addBox(
    acc,
    L.box.cx,
    L.roofRidgeY + RIDGE_CREST_H_WU / 2,
    L.box.cz,
    L.roofRidgeHalfX - RIDGE_CREST_PROUD_WU,
    RIDGE_CREST_H_WU / 2,
    L.roofRidgeHalfZ - RIDGE_CREST_PROUD_WU,
    COPPER_PATINA,
  );
  appendDormerRow(acc, L, 'south');
  appendDormerRow(acc, L, 'east');
  appendCornerTurrets(acc, L);
}

/** The three camera-visible corner turrets (see TURRET_HALF_WU). Each straddles its corner — half
 * inside the block, half proud of it, which is what makes it read as engaged rather than as a box
 * parked on the roof — and stays far inside the 3 wu massing-exclusion margin. */
function appendCornerTurrets(acc: Accum, L: OldCityHallLayout): void {
  const shaftTopY = TURRET_SHAFT_TOP_FRAC * L.height;
  const apexY = TURRET_APEX_FRAC * L.height;
  const baseY = L.roofBaseY - TURRET_BASE_BELOW_EAVE_WU;
  for (const [sx, sz] of [
    [1, 1], // SE — the corner the fixed rig frames head-on
    [-1, 1], // SW
    [1, -1], // NE
  ] as const) {
    const cx = L.box.cx + sx * L.box.hx;
    const cz = L.box.cz + sz * L.box.hz;
    addBox(acc, cx, (baseY + shaftTopY) / 2, cz, TURRET_HALF_WU, (shaftTopY - baseY) / 2, TURRET_HALF_WU, SANDSTONE_LIGHT, {
      py: false,
    });
    addPyramid(acc, cx, cz, TURRET_HALF_WU, TURRET_HALF_WU, shaftTopY, apexY, COPPER_PATINA_DARK);
  }
}

// --- the clock tower ------------------------------------------------------------------------------

/** Hand angles (radians, clockwise from 12) for the frozen CLOCK_TIME — derived, never typed. */
const CLOCK_ANGLES = {
  hour: ((CLOCK_TIME.hour % 12) + CLOCK_TIME.minute / 60) * (Math.PI / 6),
  minute: CLOCK_TIME.minute * (Math.PI / 30),
} as const;

/** The four faces a dial rides, with the direction text/hands READ toward for a viewer standing off
 * that face (right = normal × up — namedGeometry.ts's SIGN_FACE_BASIS derivation, extended to the
 * two camera-invisible faces because a clock tower with two dials is not a clock tower). */
const DIAL_FACES: readonly { readonly outward: Vec3; readonly right: Vec3 }[] = [
  { outward: [0, 0, 1], right: [1, 0, 0] }, // south — camera-visible
  { outward: [1, 0, 0], right: [0, 0, -1] }, // east — camera-visible
  { outward: [0, 0, -1], right: [-1, 0, 0] }, // north
  { outward: [-1, 0, 0], right: [0, 0, 1] }, // west
];

function appendClockDial(acc: Accum, L: OldCityHallLayout, face: { readonly outward: Vec3; readonly right: Vec3 }): void {
  const dialOffset = WALL_STACK.crownDecal; // the dial, proud of the stage wall
  const handOffset = WALL_STACK.fasciaBand; // the hands, one rung proud of the dial
  const { outward, right } = face;
  const at = (u: number, v: number, offset: number): Vec3 => [
    L.towerCenterX + right[0] * u + outward[0] * (L.towerStageHalf + offset),
    L.clockFaceY + v,
    L.towerCenterZ + right[2] * u + outward[2] * (L.towerStageHalf + offset),
  ];
  // The dial: an octagon fan. Unshaded — a lit dial at blue hour, not a stone facet.
  const ring: Vec3[] = [];
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    ring.push(at(L.clockRadius * Math.sin(a), L.clockRadius * Math.cos(a), dialOffset));
  }
  for (let i = 1; i + 1 < 8; i++) addTriOpts(acc, ring[0], ring[i], ring[i + 1], outward, CLOCK_FACE_FILL, { unshaded: true });
  // Two hands, at the frozen CLOCK_TIME. Each is one quad from the dial centre outward.
  for (const [angle, lengthFrac] of [
    [CLOCK_ANGLES.hour, CLOCK_HOUR_HAND_FRAC],
    [CLOCK_ANGLES.minute, CLOCK_MINUTE_HAND_FRAC],
  ] as const) {
    const du = Math.sin(angle);
    const dv = Math.cos(angle);
    const len = lengthFrac * L.clockRadius;
    const w = CLOCK_HAND_HALF_W_WU;
    const quad: Quad = [
      at(-dv * w, du * w, handOffset),
      at(dv * w, -du * w, handOffset),
      at(du * len + dv * w, dv * len - du * w, handOffset),
      at(du * len - dv * w, dv * len + du * w, handOffset),
    ];
    addFace(acc, quad, outward, CLOCK_HAND_FILL, { unshaded: true });
  }
}

function appendTower(acc: Accum, L: OldCityHallLayout): void {
  // Shaft — from the ground (it is a tower, not a rooftop turret), all four walls rendered: below
  // the body roofline its north face is buried in an opaque solid, above it every face is exposed.
  addBox(acc, L.towerCenterX, L.towerShaftTopY / 2, L.towerCenterZ, L.towerHalf, L.towerShaftTopY / 2, L.towerHalf, SANDSTONE, {
    py: false,
  });
  // The clock stage: a wider belfry drum carrying the four dials.
  addBox(
    acc,
    L.towerCenterX,
    (L.towerShaftTopY + L.towerStageTopY) / 2,
    L.towerCenterZ,
    L.towerStageHalf,
    (L.towerStageTopY - L.towerShaftTopY) / 2,
    L.towerStageHalf,
    SANDSTONE_LIGHT,
    { py: false },
  );
  for (const face of DIAL_FACES) appendClockDial(acc, L, face);
  // Copper collar between the stone stage and the cap — the two-tone's transition, and what makes
  // the pyramid read as metal sitting ON stone rather than as a stone spike.
  addBox(
    acc,
    L.towerCenterX,
    (L.towerStageTopY + L.towerCollarTopY) / 2,
    L.towerCenterZ,
    L.towerStageHalf + TOWER_COLLAR_PROUD_WU,
    (L.towerCollarTopY - L.towerStageTopY) / 2,
    L.towerStageHalf + TOWER_COLLAR_PROUD_WU,
    COPPER_PATINA,
  );
  // Corner pinnacle hints: four posts on the collar's corners, each with its own little cap.
  const capH = L.towerTopY - L.towerCollarTopY;
  const pinnacleTopY = L.towerCollarTopY + PINNACLE_BODY_FRAC * capH;
  const pinnacleApexY = pinnacleTopY + PINNACLE_CAP_FRAC * capH;
  const inset = L.towerStageHalf - PINNACLE_HALF_WU;
  for (const [sx, sz] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ] as const) {
    const px = L.towerCenterX + sx * inset;
    const pz = L.towerCenterZ + sz * inset;
    addBox(acc, px, (L.towerCollarTopY + pinnacleTopY) / 2, pz, PINNACLE_HALF_WU, (pinnacleTopY - L.towerCollarTopY) / 2, PINNACLE_HALF_WU, SANDSTONE_LIGHT, {
      py: false,
    });
    addPyramid(acc, px, pz, PINNACLE_HALF_WU, PINNACLE_HALF_WU, pinnacleTopY, pinnacleApexY, COPPER_PATINA_DARK);
  }
  // The steep pyramidal cap — its apex IS the data height (see towerTopY).
  addPyramid(
    acc,
    L.towerCenterX,
    L.towerCenterZ,
    L.towerStageHalf + TOWER_COLLAR_PROUD_WU,
    L.towerStageHalf + TOWER_COLLAR_PROUD_WU,
    L.towerCollarTopY,
    L.towerTopY,
    COPPER_PATINA_DARK,
  );
}

// --- the triple-arched entry ------------------------------------------------------------------------

function appendEntry(acc: Accum, L: OldCityHallLayout): void {
  const p = L.porch;
  const halfX = (p.x.max - p.x.min) / 2;
  const cx = (p.x.min + p.x.max) / 2;
  const depthHalf = PORCH_PROUD_WU / 2;
  // The porch block: a shallow sandstone mass proud of the facade. Its north face is buried in the
  // body and is not built.
  addBox(acc, cx, p.topY / 2, L.zSouth + depthHalf, halfX, p.topY / 2, depthHalf, SANDSTONE_LIGHT, { nz: false });

  // Three Romanesque openings on the porch's own south face — dark reveals, so the depth reads by
  // VALUE rather than by a modelled void (Phase 39's sunk-flush prototype: an apertureless hole
  // reads as nothing, and a real void needs a floor, two walls and a camera trap).
  const bayWidth = (2 * halfX) / ARCH_COUNT;
  const archHalf = ARCH_HALF_FRAC * bayWidth;
  const springY = ARCH_SPRING_FRAC * p.topY;
  const baseY = ARCH_BASE_FRAC * p.topY;
  const faceZ = p.zFace + WALL_STACK.crownDecal;
  for (let i = 0; i < ARCH_COUNT; i++) {
    const ax = p.x.min + (i + 0.5) * bayWidth;
    addFace(
      acc,
      [
        [ax - archHalf, baseY, faceZ],
        [ax + archHalf, baseY, faceZ],
        [ax + archHalf, springY, faceZ],
        [ax - archHalf, springY, faceZ],
      ],
      [0, 0, 1],
      ARCH_VOID,
    );
    // The semicircular head: a fan of facets over the springing line.
    const apex: Vec3 = [ax, springY, faceZ];
    for (let f = 0; f < ARCH_HEAD_FACETS; f++) {
      const a0 = (f / ARCH_HEAD_FACETS) * Math.PI;
      const a1 = ((f + 1) / ARCH_HEAD_FACETS) * Math.PI;
      addTriFacing(
        acc,
        apex,
        [ax - archHalf * Math.cos(a0), springY + archHalf * Math.sin(a0), faceZ],
        [ax - archHalf * Math.cos(a1), springY + archHalf * Math.sin(a1), faceZ],
        [0, 0, 1],
        ARCH_VOID,
      );
    }
  }
}

// --- the render plan -------------------------------------------------------------------------------

function buildOldCityHallGeometry(L: OldCityHallLayout): NamedBespokeGeometry {
  const acc = createAccum();
  appendCourses(acc, L);
  appendRoof(acc, L);
  appendEntry(acc, L);
  const block = triangleCount(acc);
  appendTower(acc, L);
  const total = triangleCount(acc);
  return {
    geometry: toGeometry(acc, false),
    triangles: total,
    parts: [
      { id: 'old-city-hall-block', triangles: block },
      { id: 'old-city-hall-tower', triangles: total - block },
    ],
  };
}

/** The seam entry point (registered in namedGeometry.ts's `namedGeometryBuilders`). Takes only
 * `placement` — see this file's header for why no street context is needed, and why that is legal
 * against the two-parameter `NamedGeometryBuilder` type. */
export function buildOldCityHallBespoke(placement: NamedPlacement): NamedBespoke {
  const L = oldCityHallLayout(placement);
  return {
    id: placement.id,
    // ROYAL YORK PATTERN: the body render box keeps the DATA footprint and the §4 brick_red facade
    // machinery (its baked window texture is what lights the block at dusk) — only its HEIGHT
    // shrinks, so this module's roof and tower own everything above it.
    renderBoxes: [{ ...L.box, hy: L.bodyTopY / 2 }],
    renderGroup: CIVIC_HEART_RENDER_GROUP,
    // No atlas wordmark: Old City Hall carries carved stone lettering the 32-px homage font cannot
    // quote honestly at this size, and namedGeometry.test.ts's camera-visible-wordmark law binds
    // only where signQuads exist (amended for exactly this case).
    signQuads: [],
    // Everything sits on or over the DATA footprint (the widest element, the eave cornice at
    // 0.45 wu proud, is far inside namedBuildings.ts's 3 wu massing-exclusion margin) and nothing
    // exceeds the data height, so the existing claim/collider/clip machinery — all keyed off the
    // DATA box — already covers this landmark exactly (royalYork.ts makes the identical call).
    extraClaims: [],
    extraColliders: [],
    meta: {
      topY: L.towerTopY,
      probes: {
        dataHeight: L.height,
        bodyTopY: L.bodyTopY,
        bandCourseY: L.bandCourseY,
        roofBaseY: L.roofBaseY,
        roofRidgeY: L.roofRidgeY,
        roofRidgeHalfX: L.roofRidgeHalfX,
        roofRidgeHalfZ: L.roofRidgeHalfZ,
        ridgeCrestTopY: L.roofRidgeY + RIDGE_CREST_H_WU,
        turretCount: 3,
        turretApexY: TURRET_APEX_FRAC * L.height,
        turretHalfWu: TURRET_HALF_WU,
        dormerRowY0: L.dormerRowY0,
        dormerRowY1: L.dormerRowY1,
        dormerBaysSouth: DORMER_COUNT_SOUTH,
        dormerBaysEast: DORMER_COUNT_EAST,
        dormerCountSouth: dormerPositions(L, 'south').length,
        dormerCountEast: dormerPositions(L, 'east').length,
        dormerHalfWidthWu: DORMER_HALF_W_WU,
        dormerProudWu: DORMER_PROUD_WU,
        southRowZ: L.southRowZ,
        eastRowX: L.eastRowX,
        towerCenterX: L.towerCenterX,
        towerCenterZ: L.towerCenterZ,
        towerHalf: L.towerHalf,
        towerShaftTopY: L.towerShaftTopY,
        towerStageTopY: L.towerStageTopY,
        towerStageHalf: L.towerStageHalf,
        towerCollarTopY: L.towerCollarTopY,
        towerTopY: L.towerTopY,
        clockFaceY: L.clockFaceY,
        clockRadius: L.clockRadius,
        clockFaceCount: DIAL_FACES.length,
        clockHourAngle: CLOCK_ANGLES.hour,
        clockMinuteAngle: CLOCK_ANGLES.minute,
        porchMinX: L.porch.x.min,
        porchMaxX: L.porch.x.max,
        porchFaceZ: L.porch.zFace,
        porchTopY: L.porch.topY,
        archCount: ARCH_COUNT,
      },
    },
    buildGeometry: () => buildOldCityHallGeometry(L),
  };
}
