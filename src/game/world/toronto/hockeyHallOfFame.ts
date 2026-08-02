// Phase 48 (Part 11) — THE HOCKEY HALL OF FAME, in the 1885 Bank of Montreal at Yonge & Front.
// The sixth tenant of the `namedGeometryBuilders` seam (namedGeometry.ts's header explains the
// seam; oldCityHall.ts is this file's structural template: a SHRUNK body render box that keeps the
// §4 facade machinery, plus bespoke geometry for the ornament above and in front of it).
//
// data/toronto/building-specs.json's R48 researcher notes (id `hockey-hall-of-fame`) VERIFY:
// built 1885–1887 by Darling & Curry as the Bank of Montreal's Toronto head office; an exterior of
// OHIO FREESTONE (tan/cream stone) with extensive carved ornamental detail; a grand ARCHED BANKING-
// HALL ENTRANCE AT THE CORNER of Yonge & Front; and, inside, the Esso Great Hall — a 70 × 70 ft
// room under a 45 ft STAINED-GLASS DOME on a drum. The corner itself is verified: NW corner of
// Yonge × Front, i.e. the ornate elevations face SOUTH and EAST.
//
// EXPLICITLY UNVERIFIED on that same row, and therefore STATED not invented (Phase 44's beacon-
// cadence precedent, Phase 46's omitted Union clock, Phase 47's patina caveat):
//   • the exterior height, the storey count and the footprint — all estimates on a `confidence:
//     "low"` row. Everything here is a PROPORTION of the resulting data box, so a corrected spec
//     row re-proportions the whole model with no code change;
//   • whether the dome carries a CUPOLA or LANTERN. It does not get one here: the crown ends in a
//     minimal finial spire rather than an invented glazed lantern (see FINIAL_*);
//   • the dome's exterior finish. It ships in the same copper-patina family Old City Hall and the
//     Royal York already use, so the three landmarks read as one city (see DOME_COPPER);
//   • the drum glazing band. The stained glass is verified but INTERIOR; a lit band on the drum is
//     an inference from it, not a researched exterior feature (see DRUM_GLASS_FRAC).
//
// THE LUCKIEST CORNER ON THE MAP. This is the NW corner of the intersection, so the two elevations
// a corner banking hall spends its ornament on are exactly the SOUTH + EAST pair the fixed rig can
// see (Phase 34's pinned face set). And at ~7.4 wu of data height under a camera whose ground band
// runs to ~27–29 wu (Phase 38's visible-band law), this is one of the very few landmarks the player
// sees WHOLE — pavement to finial — on an ordinary drive past. So the detail budget goes where it
// is seen: an arcade of round-headed bays on those two elevations, a canted corner entrance with
// steps under them, a cornice + parapet, and the dome.
//
// NO LEAGUE OR TEAM ICONOGRAPHY OF ANY KIND. The building is depicted as ARCHITECTURE only — no
// hockey marks, no team crests, no trophy, and no wordmark (a wordmark would need the shared
// namedSignage.ts atlas, and there is nothing here it could honestly quote). CLAUDE.md's brand
// rule admits pixel-art homages of consumer brands; sports-league and team marks are outside it,
// and the credits entry says so.
//
// SINGLE SOURCE OF TRUTH: every dimension is a proportion of the placement's own DATA box (its
// footprint half-extents and its §3c/NAMED_HEIGHT_SCALE height, both computed by namedBuildings.ts
// from the spec row). There is not one literal world coordinate in this file — only proportion
// literals, each carrying the reason it has the value it has (unionStation.ts's discipline).
//
// NO STREET CONTEXT NEEDED: like oldCityHall.ts, everything sits on or over the DATA footprint, so
// this builder takes only `placement` — structurally legal against the two-parameter
// `NamedGeometryBuilder` type.

import { WALL_STACK } from '../../config/layering';
import { lookForMaterial } from '../../config/torontoMaterials';
import {
  addArcBand,
  addBox,
  addFace,
  addPrismY,
  addTriFacing,
  createAccum,
  toGeometry,
  triangleCount,
  type Accum,
  type BoxFaces,
  type Quad,
  type Vec3,
} from './bespokeMesh';
import type { NamedBox, NamedPlacement } from './namedBuildings';
import type { NamedBespoke, NamedBespokeGeometry } from './namedGeometry';

// --- tri budget (Part 11 rule 2: stated per model, pinned in the phase that introduces them) -----

/**
 * Courses + the two arcades + the corner entrance + the dome. Pinned by hockeyHallOfFame.test.ts
 * with a FLOOR as well as a ceiling — v1 was a 12-triangle extruded box, and a ceiling-only budget
 * is passed just as happily by that box as by the real landmark (unionStation.test.ts's idiom).
 *
 * The ceiling is deliberately the SMALLEST of the Part-11 landmark budgets (CN 2500, Rogers 1500,
 * City Hall 1600, Union 900, Old City Hall 900, Osgoode 400): this is a 9 × 9 wu, 7.4 wu building,
 * and Phase 47's ablation measured the LOW tier at 98.3 % of its triangle budget on untouched
 * geometry. A small building gets a small budget.
 */
export const HOCKEY_HALL_MAX_TRIS = 500 as const;

// --- proportions (the only literals; each one carries its reason) --------------------------------

/**
 * Body (render-box) height as a fraction of the DATA height. The data height is the height to the
 * TOP of the crown (the finial), so the cornice line has to sit well under it: 0.62 leaves ~38 % of
 * the elevation for the cornice, the parapet, the drum and the dome, which is what a two-storey
 * banking hall under a domed crown reads as. (The spec row's `floors: 3` is itself an estimate.)
 */
const BODY_HEIGHT_FRAC = 0.62;

/** Plinth and cornice courses. ABSOLUTE literals, not fractions: a stone course reads at a physical
 * thickness rather than as a fraction of the building (oldCityHall.ts's course note). Both stay far
 * inside namedBuildings.ts's 3 wu massing-exclusion margin, so no claim or collider is owed. */
const PLINTH_H_WU = 0.32;
/** The plinth is the PROUDEST course on the elevation (0.42 > the cornice's 0.35 > the piers'
 * 0.32): a base course that does not out-project what stands on it reads as a mistake. */
const PLINTH_PROUD_WU = 0.42;
const CORNICE_H_WU = 0.3;
/** The cornice's overhang. Its TOP FACE doubles as the roof deck the crown stands on — a separate
 * deck quad at the same height would be the exact coplanar pair Phase 39 exists to prevent. */
const CORNICE_PROUD_WU = 0.35;
/** The parapet ring standing on that deck, on the body footprint, so the cornice lip still shows
 * outside it. Four overlapping bars (their buried ends are never emitted), not a solid lid: the
 * 58° camera looks DOWN on a 7.4 wu building, so a recessed deck behind a parapet edge is geometry
 * the player actually sees. */
const PARAPET_H_WU = 0.26;
const PARAPET_T_WU = 0.3;

/**
 * THE ARCADE — the single most important read (a Victorian stone bank is a rhythm of round-headed
 * bays). It occupies the tall ground storey: `ARCADE_TOP_FRAC` × the body height, which at these
 * proportions is a ~2.5 wu (≈ 6.8 m) banking-hall storey with the §4 window-grid facade above it.
 */
const ARCADE_TOP_FRAC = 0.6;
/** Bays per camera-visible elevation. Four is what a 9 wu facade takes at a legible opening width
 * once the corner bay has claimed its end — an aesthetic call, not a researched bay count. */
const ARCADE_BAYS = 4;
/** The piers between the bays: half-width and how far they stand proud of the facade. The PROUD
 * depth is what makes this an arcade rather than a decal — the openings sit back on the facade
 * plane and the piers cast the reveal. Both clear THIN_GEOMETRY.minStripeWidthWu (0.3 wu), which a
 * to-scale pilaster would not (P41's law; the test asserts it). */
const PIER_HALF_WU = 0.22;
const PIER_PROUD_WU = 0.32;
/** The impost/cornice band capping the arcade — one horizontal line tying the bays together, which
 * is what separates "an arcade" from "some arches". Stands slightly prouder than the piers. */
const ARCADE_CORNICE_H_WU = 0.22;
const ARCADE_CORNICE_PROUD_WU = 0.44;
/** Clearance (wu) the arcade leaves at the far (non-corner) end of each elevation, so the end pier
 * never overhangs the building's own corner. */
const ARCADE_END_MARGIN_WU = 0.3;
/** Opening half-width as a fraction of its bay, and the springing line as a fraction of the arcade
 * storey. `ARCH_HEAD_FACETS` = 4 is where a semicircle stops reading as a triangle (oldCityHall). */
const ARCH_HALF_FRAC = 0.34;
const ARCH_SPRING_FRAC = 0.62;
const ARCH_HEAD_FACETS = 4;

/**
 * THE CORNER ENTRANCE (researched: "grand arched banking hall entrance at corner Yonge & Front").
 * A CANTED corner bay is the classic treatment for a corner bank, and it is built here as an added
 * mass rather than as a chamfer cut, because the §4 render box is and stays a box.
 *
 * `CORNER_BAY_RUN_WU` is how far along EACH elevation the bay's shoulders sit. How far the face is
 * then pushed out along the diagonal is DERIVED, never typed: it must clear not just the box's own
 * corner (run/√2) but the corner of the PROUDEST course that wraps it — a plinth corner sticking
 * through the entrance face is exactly the kind of defect a hand-tuned literal ships. See
 * `hockeyHallLayout`. `CORNER_BAY_MARGIN_WU` is the visible gap left beyond that.
 */
const CORNER_BAY_RUN_WU = 1.5;
const CORNER_BAY_MARGIN_WU = 0.12;
/** The portal on that canted face: half-width as a fraction of the face's own half-width, and its
 * springing line as a fraction of the arcade storey (so the entrance arch springs from the same
 * line as the arcade beside it — that shared line is what makes the corner read as part of the
 * same building). The blind arched panel above it repeats the motif on the upper storey. */
const PORTAL_HALF_FRAC = 0.4;
const PORTAL_SPRING_FRAC = 0.56;
const PORTAL_SURROUND_WU = 0.16; // the stone archivolt ring standing proud around the dark opening
const UPPER_PANEL_HALF_FRAC = 0.26;
const UPPER_PANEL_BASE_FRAC = 1.18; // × the arcade top: the blind arch sits above the arcade cornice
const UPPER_PANEL_TOP_FRAC = 1.62;

/**
 * The entrance STEPS. Geometry, never painted ground: a painted step would need its own
 * `GROUND_STACK` rung and that ladder is law (Phase 39) — a builder does not extend it.
 * VISUAL-ONLY, no collider: Phase 37 proved the raycast vehicle's suspension rays CURB-HOP anything
 * around this height, so a step collider is a launch ramp, not a step (Osgoode's fence and Union's
 * balustrade made the same call). The TREAD is the dimension the 58° camera actually sees (the
 * riser is nearly edge-on from above), so it is the tread that must clear
 * THIN_GEOMETRY.minStripeWidthWu.
 */
const STEP_COUNT = 2;
const STEP_TREAD_WU = 0.4;
/** Step half-width as a fraction of the portal's own half-width — a flight a touch wider than the
 * door it serves. */
const STEP_HALF_FRAC = 1.3;

/**
 * THE DOME, set back on the roof. Its whole vertical stack is expressed as fractions of the CROWN
 * RISE (data height − roof deck), which is what makes the finial land on the data height EXACTLY by
 * construction rather than by a lucky sum (osgoodeHall.ts's device; the layout GUARDS the sum
 * rather than trusting this comment).
 */
const CROWN_STACK = {
  /** Splayed plinth: a short frustum widening the drum's foot where it meets the deck. */
  plinth: 0.08,
  /** The stone lower drum. */
  drumStone: 0.14,
  /** The glazed upper drum — an INFERENCE from the verified interior stained-glass dome, not a
   * researched exterior feature. Emitted unshaded so it reads as lit from within at blue hour. */
  drumGlass: 0.16,
  /** The dome shell itself. */
  dome: 0.5,
  /** The finial. Deliberately a minimal spire and NOT a lantern/cupola — the spec row records the
   * cupola as unverified, so inventing a glazed lantern would be inventing a landmark feature. */
  finial: 0.12,
} as const;

/** Drum radius as a fraction of the footprint half-extent. The Great Hall below is 70 × 70 ft in a
 * building whose characteristic width the spec row itself estimates, so the exterior dome's
 * diameter is NOT derivable from the data: 0.36 (≈ 3.2 wu across a 9 wu roof) is the fraction at
 * which the dome reads as a dome on a roof rather than as a lid over it. Stated, not researched. */
const DRUM_R_FRAC = 0.36;
/** The dome springs from an EAVE slightly wider than the drum — the lip that stops the dome/drum
 * junction reading as one continuous cone. Its underside is never rendered: the fixed camera looks
 * DOWN on this building and can never see an upward-facing solid's underside. */
const DOME_EAVE_FRAC = 1.1;
/** How much wider the plinth is at the deck than at its top (where it meets the drum exactly, so
 * no upward-facing annulus is left open). */
const PLINTH_SPLAY_FRAC = 1.22;
/**
 * The dome PROFILE: normalized heights up the notional sphere. Radii are DERIVED from them by the
 * circle rule r = R·√(1 − t²) — three tapering bands read as a dome for a fraction of a sphere's
 * triangles, and deriving the radii means the profile can never drift into a cone. The last band
 * stops at 0.96 rather than 1.0 so the shell ends in a small flat crown the finial stands on.
 */
const DOME_PROFILE_T = [0, 0.42, 0.74, 0.96] as const;
/** Facets around the drum/dome. 10 is where an N-gon reads as round at this size; 24 would cost
 * 2.4× the triangles for a difference nobody can see at play distance. */
const DOME_SIDES = 10;
/** Facets on the finial — a 0.2 wu post does not need ten. */
const FINIAL_SIDES = 6;
const FINIAL_NECK_R_FRAC = 0.125; // × the drum radius
const FINIAL_TIP_R_FRAC = 0.012;
const FINIAL_NECK_FRAC = 0.4; // share of the finial's own rise spent on the neck, the rest on the spire

/** The camera boresight in plan: the fixed rig sits at +x/+z of its target (yaw 45°), so a facet
 * centre pointed at π/4 is a facet pointed straight at the player. Every N-gon in this file is
 * ROLLED onto it (the CN-tower 15°-roll idiom) instead of landing a CORNER there. */
const BORESIGHT_AZIMUTH = Math.PI / 4;

// --- palette (unlit-literal; §4's limestone look is the single source for the body colour) --------

/** The §4 look of the spec row's material — the render box's own facade fill, so every trim below
 * harmonizes with the machine-painted body rather than fighting it. Ohio freestone is a tan/cream
 * stone (researched), which is exactly what this look already is. */
const STONE = lookForMaterial('limestone').fill;
const STONE_LIGHT = '#cdb681'; // plinth / piers / cornice / corner bay — proud carved stone reads lighter
const ARCH_VOID = '#2a2018'; // the dark reveal inside an opening — depth by VALUE, not by a modelled void
/**
 * Oxidized copper-green. APPROXIMATE, not researched — the spec row does not record the dome's
 * exterior finish. It quotes Old City Hall's and the Royal York's patina family on purpose: three
 * landmarks within a kilometre of each other must read as the same city, and the slope/cap two-tone
 * is the measured low-poly device that keeps a curved roof legible when facet tilt alone cannot
 * (Phase 46's evidence-frame finding).
 */
const DOME_COPPER = '#4c7d63'; // the lit copper: the eave lip band and the finial
const DOME_COPPER_DARK = '#33564a'; // the shell bands — same family, reads as shade
const DRUM_GLASS = '#ffd8a2'; // warm, UNSHADED: a glazed drum lit from within at blue hour

// --- local helpers (bespokeMesh.ts is shared and owned elsewhere; these stay private) -------------

/**
 * A vertical face to hang elements on: a point on the plane, the horizontal unit vector along it
 * (+u always runs TOWARD the corner bay) and its outward normal. One abstraction for the south
 * elevation, the east elevation and the canted corner face, so all three get the identical arch —
 * which is what makes the corner entrance read as the same building as the arcade.
 */
interface FacePlane {
  readonly ox: number;
  readonly oz: number;
  readonly u: Vec3;
  readonly outward: Vec3;
}

/** The point `u` along the face, `y` up, `offset` proud of the plane. */
function facePoint(f: FacePlane, u: number, y: number, offset: number): Vec3 {
  return [
    f.ox + f.u[0] * u + f.outward[0] * offset,
    y,
    f.oz + f.u[2] * u + f.outward[2] * offset,
  ];
}

/**
 * A round-headed opening on a face: a rectangle up to the springing line, then a fan of
 * `ARCH_HEAD_FACETS` triangles over it. 6 triangles for the whole arch.
 */
function addArchedOpening(
  acc: Accum,
  f: FacePlane,
  uCenter: number,
  halfWidth: number,
  baseY: number,
  springY: number,
  offset: number,
  hex: string,
): void {
  const p = (u: number, y: number): Vec3 => facePoint(f, u, y, offset);
  addFace(
    acc,
    [p(uCenter - halfWidth, baseY), p(uCenter + halfWidth, baseY), p(uCenter + halfWidth, springY), p(uCenter - halfWidth, springY)],
    f.outward,
    hex,
  );
  const apex = p(uCenter, springY);
  for (let i = 0; i < ARCH_HEAD_FACETS; i++) {
    const a0 = (i / ARCH_HEAD_FACETS) * Math.PI;
    const a1 = ((i + 1) / ARCH_HEAD_FACETS) * Math.PI;
    addTriFacing(
      acc,
      apex,
      p(uCenter - halfWidth * Math.cos(a0), springY + halfWidth * Math.sin(a0)),
      p(uCenter - halfWidth * Math.cos(a1), springY + halfWidth * Math.sin(a1)),
      f.outward,
      hex,
    );
  }
}

/** Which faces of a face-local box to emit, in the face's OWN terms — so the south and east
 * elevations share one call site instead of each hand-mapping a `BoxFaces` mask. */
interface FaceBoxFaces {
  readonly front?: boolean;
  readonly back?: boolean;
  readonly ends?: boolean;
  readonly top?: boolean;
}

/** An axis-aligned box expressed in face-local coordinates (along the face, up, proud of it). */
function addFaceBox(
  acc: Accum,
  f: FacePlane,
  uCenter: number,
  uHalf: number,
  y0: number,
  y1: number,
  offNear: number,
  offFar: number,
  hex: string,
  show: FaceBoxFaces,
): void {
  const offMid = (offNear + offFar) / 2;
  const offHalf = (offFar - offNear) / 2;
  const alongX = f.u[0] !== 0;
  const cx = f.ox + (alongX ? f.u[0] * uCenter : f.outward[0] * offMid);
  const cz = f.oz + (alongX ? f.outward[2] * offMid : f.u[2] * uCenter);
  const faces: BoxFaces = alongX
    ? { pz: show.front === true, nz: show.back === true, px: show.ends === true, nx: show.ends === true, py: show.top === true }
    : { px: show.front === true, nx: show.back === true, pz: show.ends === true, nz: show.ends === true, py: show.top === true };
  addBox(
    acc,
    cx,
    (y0 + y1) / 2,
    cz,
    alongX ? uHalf : offHalf,
    (y1 - y0) / 2,
    alongX ? offHalf : uHalf,
    hex,
    faces,
  );
}

/** The `angleOffset` that lands a FACET CENTRE (not a corner) on the camera boresight, for an
 * N-gon in either of bespokeMesh's two angle conventions — both place a facet centre half a step
 * past vertex 0 (see bespokeMesh's `addPrismY` / `arcAngle`). */
function boresightRoll(sides: number): number {
  return BORESIGHT_AZIMUTH - Math.PI / sides;
}

// --- layout ---------------------------------------------------------------------------------------

interface HockeyHallLayout {
  readonly box: NamedBox;
  readonly height: number;
  readonly xEast: number;
  readonly zSouth: number;
  readonly plinthTopY: number;
  readonly bodyTopY: number;
  readonly deckY: number;
  readonly parapetTopY: number;
  readonly arcadeTopY: number;
  readonly arcadeCorniceTopY: number;
  readonly archSpringY: number;
  readonly archHalfWidth: number;
  readonly bayPitch: number;
  /** Face-local `u` of the first pier; piers run `ARCADE_BAYS + 1` of them at `bayPitch`. */
  readonly pierU0: number;
  readonly corner: {
    readonly plane: FacePlane;
    readonly halfWidth: number;
    readonly proud: number;
    readonly shoulderU: number;
    /** The canted face's distance from the box centre along the SE unit diagonal — the ONE number
     * that says whether a course corner pokes through it, and what the test measures against. */
    readonly faceDiagonal: number;
    readonly widestCourseProudWu: number;
  };
  readonly drumR: number;
  readonly crownRise: number;
  readonly plinthTopCrownY: number;
  readonly drumBaseY: number;
  readonly drumGlassBaseY: number;
  readonly domeBaseY: number;
  readonly domeShellTopY: number;
  readonly finialNeckTopY: number;
  readonly topY: number;
}

/** The face plane of one camera-visible elevation, with +u running toward the corner bay. */
function elevationPlane(L: Pick<HockeyHallLayout, 'box' | 'xEast' | 'zSouth'>, axis: 'south' | 'east'): FacePlane {
  return axis === 'south'
    ? { ox: L.box.cx, oz: L.zSouth, u: [1, 0, 0], outward: [0, 0, 1] }
    : { ox: L.xEast, oz: L.box.cz, u: [0, 0, 1], outward: [1, 0, 0] };
}

function hockeyHallLayout(placement: NamedPlacement): HockeyHallLayout {
  const box = placement.boxes[0];
  if (box === undefined) throw new Error('hockeyHallOfFame: placement has no data box');
  const height = box.hy * 2;
  const bodyTopY = BODY_HEIGHT_FRAC * height;
  const deckY = bodyTopY + CORNICE_H_WU;
  const crownRise = height - deckY;
  if (crownRise <= 0) throw new Error('hockeyHallOfFame: the cornice leaves no room for the crown');
  const stackSum = Object.values(CROWN_STACK).reduce((n, v) => n + v, 0);
  if (Math.abs(stackSum - 1) > 1e-9) throw new Error(`hockeyHallOfFame: CROWN_STACK must sum to 1 (got ${stackSum})`);

  const arcadeTopY = ARCADE_TOP_FRAC * bodyTopY;
  const arcadeStoreyH = arcadeTopY - PLINTH_H_WU;
  if (arcadeStoreyH <= 0) throw new Error('hockeyHallOfFame: no room for an arcade storey above the plinth');

  // The arcade span runs from the far end of the elevation to the corner bay's shoulder. The bay
  // pitch is derived ONCE and shared by both elevations, which is only correct on a square
  // footprint — the spec row's `shape: 'square'` guarantees it, and this guard turns a future
  // shape change into a loud failure instead of an east arcade that silently misses its piers.
  if (Math.abs(box.hx - box.hz) > 1e-9) throw new Error('hockeyHallOfFame: expects a square footprint (shape: "square")');
  const half = box.hx;
  const spanStart = -half + ARCADE_END_MARGIN_WU;
  // The end pier stops exactly AT the bay's shoulder rather than straddling it (half a pier buried
  // inside the bay would be triangles nobody can see).
  const spanEnd = half - CORNER_BAY_RUN_WU - PIER_HALF_WU;
  if (spanEnd <= spanStart) throw new Error('hockeyHallOfFame: the corner bay leaves no room for an arcade');
  const bayPitch = (spanEnd - spanStart) / ARCADE_BAYS;

  // The canted corner face: shoulders `CORNER_BAY_RUN_WU` along each elevation, pushed out along
  // the diagonal far enough to clear the box's own corner (run/√2) AND the corner of the proudest
  // course wrapping it (a course projecting `p` on both axes reaches p·√2 further along the
  // diagonal), plus the visible margin. All three terms are derived from constants declared above.
  const diagonal = Math.SQRT1_2;
  const widestCourseProudWu = Math.max(PLINTH_PROUD_WU, CORNICE_PROUD_WU, ARCADE_CORNICE_PROUD_WU);
  const proud = CORNER_BAY_RUN_WU * diagonal + widestCourseProudWu * Math.SQRT2 + CORNER_BAY_MARGIN_WU;
  const xEast = box.cx + box.hx;
  const zSouth = box.cz + box.hz;
  const cornerPlane: FacePlane = {
    // Midpoint of the two shoulders, pushed out along the diagonal.
    ox: xEast - CORNER_BAY_RUN_WU / 2 + proud * diagonal,
    oz: zSouth - CORNER_BAY_RUN_WU / 2 + proud * diagonal,
    u: [diagonal, 0, -diagonal],
    outward: [diagonal, 0, diagonal],
  };

  const drumR = DRUM_R_FRAC * box.hx;
  const plinthTopCrownY = deckY + CROWN_STACK.plinth * crownRise;
  const drumGlassBaseY = plinthTopCrownY + CROWN_STACK.drumStone * crownRise;
  const domeBaseY = drumGlassBaseY + CROWN_STACK.drumGlass * crownRise;
  const domeShellTopY = domeBaseY + CROWN_STACK.dome * crownRise;

  return {
    box,
    height,
    xEast,
    zSouth,
    plinthTopY: PLINTH_H_WU,
    bodyTopY,
    deckY,
    parapetTopY: deckY + PARAPET_H_WU,
    arcadeTopY,
    arcadeCorniceTopY: arcadeTopY + ARCADE_CORNICE_H_WU,
    archSpringY: PLINTH_H_WU + ARCH_SPRING_FRAC * arcadeStoreyH,
    archHalfWidth: ARCH_HALF_FRAC * bayPitch,
    bayPitch,
    pierU0: spanStart,
    corner: {
      plane: cornerPlane,
      halfWidth: (CORNER_BAY_RUN_WU * Math.SQRT2) / 2,
      proud,
      shoulderU: half - CORNER_BAY_RUN_WU,
      faceDiagonal: (cornerPlane.ox - box.cx + (cornerPlane.oz - box.cz)) * diagonal,
      widestCourseProudWu,
    },
    drumR,
    crownRise,
    plinthTopCrownY,
    drumBaseY: plinthTopCrownY,
    drumGlassBaseY,
    domeBaseY,
    domeShellTopY,
    finialNeckTopY: domeShellTopY + FINIAL_NECK_FRAC * CROWN_STACK.finial * crownRise,
    // The finial's tip IS the data height, by construction — that is what makes the shrunk render
    // box legal (heightLaw, the claims and the camera clip volumes all read the DATA box).
    topY: height,
  };
}

// --- the body: courses, parapet ---------------------------------------------------------------------

function appendCourses(acc: Accum, L: HockeyHallLayout): void {
  const { box } = L;
  // Plinth: the base course the whole elevation stands on.
  addBox(acc, box.cx, PLINTH_H_WU / 2, box.cz, box.hx + PLINTH_PROUD_WU, PLINTH_H_WU / 2, box.hz + PLINTH_PROUD_WU, STONE_LIGHT);
  // Cornice: the crowning course. Its TOP FACE is the roof deck (see CORNICE_PROUD_WU).
  addBox(
    acc,
    box.cx,
    (L.bodyTopY + L.deckY) / 2,
    box.cz,
    box.hx + CORNICE_PROUD_WU,
    (L.deckY - L.bodyTopY) / 2,
    box.hz + CORNICE_PROUD_WU,
    STONE_LIGHT,
  );
  // Parapet ring: four bars on the body footprint. Their ends overlap inside the corners and are
  // never emitted, so the ring costs 6 triangles a side instead of 10.
  const bar = (cx: number, cz: number, hx: number, hz: number, faces: BoxFaces): void =>
    addBox(acc, cx, (L.deckY + L.parapetTopY) / 2, cz, hx, (L.parapetTopY - L.deckY) / 2, hz, STONE_LIGHT, faces);
  const t = PARAPET_T_WU / 2;
  bar(box.cx, L.zSouth - t, box.hx, t, { pz: true, nz: true, py: true, px: false, nx: false });
  bar(box.cx, box.cz - box.hz + t, box.hx, t, { nz: true, pz: true, py: true, px: false, nx: false });
  bar(L.xEast - t, box.cz, t, box.hz, { px: true, nx: true, py: true, pz: false, nz: false });
  bar(box.cx - box.hx + t, box.cz, t, box.hz, { nx: true, px: true, py: true, pz: false, nz: false });
}

// --- the arcade -------------------------------------------------------------------------------------

function appendArcade(acc: Accum, L: HockeyHallLayout, axis: 'south' | 'east'): void {
  const f = elevationPlane(L, axis);
  // Both elevations run the SAME span and pitch (the layout's square-footprint guard is what makes
  // that legal), so the two arcades cannot drift apart.
  const spanStart = L.pierU0;
  // Piers: one at every bay boundary, standing proud of the facade so the openings behind them
  // read as recessed. Their tops are covered by the arcade cornice and are not emitted.
  for (let i = 0; i <= ARCADE_BAYS; i++) {
    addFaceBox(acc, f, spanStart + i * L.bayPitch, PIER_HALF_WU, L.plinthTopY, L.arcadeTopY, 0, PIER_PROUD_WU, STONE_LIGHT, {
      front: true,
      ends: true,
    });
  }
  // The impost/cornice band over them — the horizontal line that ties the bays into an arcade.
  const bandU0 = spanStart - PIER_HALF_WU;
  const bandU1 = spanStart + ARCADE_BAYS * L.bayPitch + PIER_HALF_WU;
  addFaceBox(
    acc,
    f,
    (bandU0 + bandU1) / 2,
    (bandU1 - bandU0) / 2,
    L.arcadeTopY,
    L.arcadeCorniceTopY,
    0,
    ARCADE_CORNICE_PROUD_WU,
    STONE_LIGHT,
    { front: true, ends: true, top: true },
  );
  // The openings themselves: one round-headed bay per bay, on the facade plane one WALL_STACK rung
  // proud of it (never coplanar with the §4-textured render box — the Phase 42 rule at the source).
  for (let i = 0; i < ARCADE_BAYS; i++) {
    addArchedOpening(
      acc,
      f,
      spanStart + (i + 0.5) * L.bayPitch,
      L.archHalfWidth,
      L.plinthTopY,
      L.archSpringY,
      WALL_STACK.crownDecal,
      ARCH_VOID,
    );
  }
}

// --- the canted corner entrance ----------------------------------------------------------------------

function appendCornerEntrance(acc: Accum, L: HockeyHallLayout): void {
  const { plane: f, halfWidth } = L.corner;
  const topY = L.parapetTopY; // the bay runs the full height and caps flush with the parapet ring
  // The mass. In plan it is the quadrilateral (south shoulder, canted face, east shoulder, chord);
  // the chord is buried inside the box and is never emitted, and so is the underside.
  const face = (u: number, y: number): Vec3 => facePoint(f, u, y, 0);
  const shoulderS: Vec3 = [L.xEast - CORNER_BAY_RUN_WU, 0, L.zSouth];
  const shoulderE: Vec3 = [L.xEast, 0, L.zSouth - CORNER_BAY_RUN_WU];
  const cantedFace: Quad = [face(-halfWidth, 0), face(halfWidth, 0), face(halfWidth, topY), face(-halfWidth, topY)];
  addFace(acc, cantedFace, f.outward, STONE_LIGHT);
  // The two returns back to the elevations. Both are edge-on to the fixed rig (their normals are
  // perpendicular to the boresight) but they are what closes the shell — Phase 46's open-shell
  // lesson: an unrendered return is a hole the camera eventually looks into.
  const returnWall = (shoulder: Vec3, u: number, outward: Vec3): void =>
    addFace(
      acc,
      [[shoulder[0], 0, shoulder[2]], face(u, 0), face(u, topY), [shoulder[0], topY, shoulder[2]]],
      outward,
      STONE_LIGHT,
    );
  returnWall(shoulderS, -halfWidth, [-Math.SQRT1_2, 0, Math.SQRT1_2]);
  returnWall(shoulderE, halfWidth, [Math.SQRT1_2, 0, -Math.SQRT1_2]);
  // The cap — visible, since the 58° camera looks down on this building.
  addFace(
    acc,
    [
      [shoulderS[0], topY, shoulderS[2]],
      face(-halfWidth, topY),
      face(halfWidth, topY),
      [shoulderE[0], topY, shoulderE[2]],
    ],
    [0, 1, 0],
    STONE_LIGHT,
  );

  // The portal: a stone archivolt ring with the dark opening set inside it, both on the canted face.
  const portalHalf = PORTAL_HALF_FRAC * halfWidth;
  const arcadeStoreyH = L.arcadeTopY - L.plinthTopY;
  const portalSpringY = L.plinthTopY + PORTAL_SPRING_FRAC * arcadeStoreyH;
  addArchedOpening(acc, f, 0, portalHalf + PORTAL_SURROUND_WU, 0, portalSpringY + PORTAL_SURROUND_WU, WALL_STACK.crownDecal, STONE);
  addArchedOpening(acc, f, 0, portalHalf, 0, portalSpringY, WALL_STACK.fasciaBand, ARCH_VOID);
  // A blind arched panel on the storey above, repeating the arcade's motif on the corner bay.
  addArchedOpening(
    acc,
    f,
    0,
    UPPER_PANEL_HALF_FRAC * halfWidth,
    UPPER_PANEL_BASE_FRAC * L.arcadeTopY,
    UPPER_PANEL_TOP_FRAC * L.arcadeTopY,
    WALL_STACK.crownDecal,
    ARCH_VOID,
  );

  // The steps down to the pavement, parallel to the canted face. Each is a front riser + a tread;
  // the flight's own ends are 0.2 wu slivers seen edge-on and are not emitted.
  const stepHalf = STEP_HALF_FRAC * portalHalf;
  for (let k = 1; k <= STEP_COUNT; k++) {
    const treadY = (L.plinthTopY * (STEP_COUNT + 1 - k)) / (STEP_COUNT + 1);
    const outer = k * STEP_TREAD_WU;
    const inner = (k - 1) * STEP_TREAD_WU;
    addFace(
      acc,
      [
        facePoint(f, -stepHalf, 0, outer),
        facePoint(f, stepHalf, 0, outer),
        facePoint(f, stepHalf, treadY, outer),
        facePoint(f, -stepHalf, treadY, outer),
      ],
      f.outward,
      STONE_LIGHT,
    );
    addFace(
      acc,
      [
        facePoint(f, -stepHalf, treadY, inner),
        facePoint(f, stepHalf, treadY, inner),
        facePoint(f, stepHalf, treadY, outer),
        facePoint(f, -stepHalf, treadY, outer),
      ],
      [0, 1, 0],
      STONE_LIGHT,
    );
  }
}

// --- the dome ----------------------------------------------------------------------------------------

function appendDome(acc: Accum, L: HockeyHallLayout): void {
  const { box } = L;
  const roll = boresightRoll(DOME_SIDES);
  const prism = (y0: number, y1: number, r0: number, r1: number, hex: string, capTop = false): void =>
    addPrismY(acc, DOME_SIDES, y0, y1, box.cx, box.cz, r0, r1, hex, { angleOffset: roll, capTop });

  // Splayed plinth → stone drum. The plinth's top radius IS the drum radius, so no upward-facing
  // annulus is left open for the camera (which looks DOWN on this roof) to see through.
  prism(L.deckY, L.plinthTopCrownY, PLINTH_SPLAY_FRAC * L.drumR, L.drumR, STONE_LIGHT);
  prism(L.plinthTopCrownY, L.drumGlassBaseY, L.drumR, L.drumR, STONE);
  // The glazed upper drum — UNSHADED, so it reads as lit from within rather than as a stone facet
  // (the one inference in this model; see CROWN_STACK.drumGlass). `addArcBand` is the toolkit's
  // primitive that takes FaceOpts; its angle convention rolls onto the same boresight facet.
  addArcBand(
    acc,
    { cx: box.cx, cz: box.cz, a0: boresightRoll(DOME_SIDES), a1: boresightRoll(DOME_SIDES) + Math.PI * 2, segments: DOME_SIDES },
    L.drumR,
    L.drumGlassBaseY,
    L.domeBaseY,
    DRUM_GLASS,
    'out',
    { unshaded: true },
  );

  // The shell: three bands whose radii are DERIVED from the circle (see DOME_PROFILE_T).
  const eaveR = DOME_EAVE_FRAC * L.drumR;
  const shellRise = L.domeShellTopY - L.domeBaseY;
  const tMax = DOME_PROFILE_T[DOME_PROFILE_T.length - 1];
  const at = (t: number): { y: number; r: number } => ({
    y: L.domeBaseY + (t / tMax) * shellRise,
    r: eaveR * Math.sqrt(1 - t * t),
  });
  for (let i = 0; i + 1 < DOME_PROFILE_T.length; i++) {
    const lo = at(DOME_PROFILE_T[i]);
    const hi = at(DOME_PROFILE_T[i + 1]);
    // The lowest band takes the LIT copper (it is the eave lip, and the one band the player sees
    // most of); the bands above take the dark tone — Phase 46's two-tone legibility device.
    prism(lo.y, hi.y, lo.r, hi.r, i === 0 ? DOME_COPPER : DOME_COPPER_DARK, i + 2 === DOME_PROFILE_T.length);
  }

  // The finial: a neck and a spire, and deliberately NOT a lantern (see CROWN_STACK.finial).
  const neckR = FINIAL_NECK_R_FRAC * L.drumR;
  const finialRoll = boresightRoll(FINIAL_SIDES);
  addPrismY(acc, FINIAL_SIDES, L.domeShellTopY, L.finialNeckTopY, box.cx, box.cz, neckR, neckR, DOME_COPPER, {
    angleOffset: finialRoll,
  });
  addPrismY(acc, FINIAL_SIDES, L.finialNeckTopY, L.topY, box.cx, box.cz, neckR, FINIAL_TIP_R_FRAC * L.drumR, DOME_COPPER, {
    angleOffset: finialRoll,
  });
}

// --- the render plan -----------------------------------------------------------------------------------

function buildHockeyHallGeometry(L: HockeyHallLayout): NamedBespokeGeometry {
  const acc = createAccum();
  appendCourses(acc, L);
  appendArcade(acc, L, 'south');
  appendArcade(acc, L, 'east');
  appendCornerEntrance(acc, L);
  const body = triangleCount(acc);
  appendDome(acc, L);
  const total = triangleCount(acc);
  return {
    geometry: toGeometry(acc, false),
    triangles: total,
    parts: [
      { id: 'hockey-hall-of-fame-body', triangles: body },
      { id: 'hockey-hall-of-fame-dome', triangles: total - body },
    ],
  };
}

/**
 * The seam entry point (registered in namedGeometry.ts's `namedGeometryBuilders`). Takes only
 * `placement` — see this file's header for why no street context is needed, and why that is legal
 * against the two-parameter `NamedGeometryBuilder` type.
 */
export function buildHockeyHallOfFameBespoke(placement: NamedPlacement): NamedBespoke {
  const L = hockeyHallLayout(placement);
  return {
    id: placement.id,
    // THE OLD CITY HALL PATTERN: the body render box keeps the DATA footprint and the §4 limestone
    // facade machinery (its baked window texture is what lights the upper storey at dusk) — only
    // its HEIGHT shrinks, so this module owns the cornice, the parapet and the whole crown.
    renderBoxes: [{ ...L.box, hy: L.bodyTopY / 2 }],
    // No `renderBoxDataIndices`: one data box, one render box, identity mapping.
    // No `renderGroup`: the nearest poolable neighbour is the bank block ~120 wu west, well past
    // the seam's 200 wu same-block cap — and a group fades as ONE unit, so pooling across blocks
    // would ghost unrelated skyline. This landmark pays its own draw call.
    signQuads: [],
    // Everything sits on or over the DATA footprint (the widest element, the entrance steps, reach
    // ~1.6 wu past the corner — inside namedBuildings.ts's 3 wu massing-exclusion margin), and
    // nothing exceeds the data height, so the existing claim/collider/clip machinery — all keyed
    // off the DATA box — already covers this landmark exactly (oldCityHall.ts makes the same call).
    extraClaims: [],
    extraColliders: [],
    meta: {
      topY: L.topY,
      probes: {
        dataHeight: L.height,
        bodyTopY: L.bodyTopY,
        plinthTopY: L.plinthTopY,
        deckY: L.deckY,
        parapetTopY: L.parapetTopY,
        arcadeTopY: L.arcadeTopY,
        arcadeCorniceTopY: L.arcadeCorniceTopY,
        archBays: ARCADE_BAYS,
        archSpringY: L.archSpringY,
        archHalfWidth: L.archHalfWidth,
        archApexY: L.archSpringY + L.archHalfWidth,
        bayPitch: L.bayPitch,
        pierCount: ARCADE_BAYS + 1,
        pierU0: L.pierU0,
        pierWidthWu: 2 * PIER_HALF_WU,
        pierProudWu: PIER_PROUD_WU,
        arcadeCorniceProudWu: ARCADE_CORNICE_PROUD_WU,
        cornerBayRunWu: CORNER_BAY_RUN_WU,
        cornerBayProudWu: L.corner.proud,
        cornerBayHalfWidth: L.corner.halfWidth,
        cornerBayShoulderU: L.corner.shoulderU,
        cornerBayTopY: L.parapetTopY,
        cornerFaceDiagonalWu: L.corner.faceDiagonal,
        cornerFaceMarginWu: CORNER_BAY_MARGIN_WU,
        widestCourseProudWu: L.corner.widestCourseProudWu,
        portalHalfWidth: PORTAL_HALF_FRAC * L.corner.halfWidth,
        portalSpringY: L.plinthTopY + PORTAL_SPRING_FRAC * (L.arcadeTopY - L.plinthTopY),
        stepCount: STEP_COUNT,
        stepTreadWu: STEP_TREAD_WU,
        stepRunWu: STEP_COUNT * STEP_TREAD_WU,
        crownRise: L.crownRise,
        crownPlinthTopY: L.plinthTopCrownY,
        drumBaseY: L.drumBaseY,
        drumGlassBaseY: L.drumGlassBaseY,
        drumTopY: L.domeBaseY,
        drumRadius: L.drumR,
        domeBaseY: L.domeBaseY,
        domeEaveRadius: DOME_EAVE_FRAC * L.drumR,
        domeShellTopY: L.domeShellTopY,
        domeSides: DOME_SIDES,
        domeBands: DOME_PROFILE_T.length - 1,
        finialNeckTopY: L.finialNeckTopY,
        finialSides: FINIAL_SIDES,
        topY: L.topY,
        boresightRoll: boresightRoll(DOME_SIDES),
      },
    },
    buildGeometry: () => buildHockeyHallGeometry(L),
  };
}
