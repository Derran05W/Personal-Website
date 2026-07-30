// Phase 47 T1 (Part 11) — TORONTO CITY HALL + NATHAN PHILLIPS SQUARE, the third tenant of the
// `namedGeometryBuilders` seam (namedGeometry.ts's header explains the seam; unionStation.ts is
// this file's template and its comment style is followed deliberately).
//
// Viljo Revell's 1965 competition winner is the one building on this map whose identity is PURE
// silhouette: two CURVED office slabs of different heights, their concave faces embracing a
// saucer-shaped council chamber that sits on a wide, low podium — an eye, in plan. Rendered as the
// three extruded boxes the data row describes, it reads as a parking garage with two fins. So the
// whole complex is bespoke.
//
// WHAT THE RESEARCHER ROUND VERIFIED (data/toronto/building-specs.json, id `new-city-hall`, R47):
//   • East tower 99.7 m / 27 floors; West tower 79.6 m / 20 floors — both flow from the data row
//     (the west box is namedBuildings.ts's `twin`, by floor ratio), never from a literal here;
//   • council chamber 155 ft (47.2 m) across, ~40 ft (12.2 m) to the dome peak;
//   • Nathan Phillips Square (4.85 ha) with THREE Freedom Arches on the Old City Hall axis over
//     the reflecting pool (converted to a skating rink in winter);
//   • the 3D TORONTO sign — 3 m letters, 22 m long, LED-lit, City-owned, installed July 2015.
// EXPLICITLY UNVERIFIED (the researcher's own caveats — "stated, not invented", Phase 44's
// beacon-cadence precedent): podium storeys (namedBuildings.ts authors an 8 m design value), the
// Freedom Arches' span/height, and the TOWER-GAP COMPASS ORIENTATION. The gap opening N–S is a
// DERIVATION from the verified site plan (the square lies SOUTH of the towers; the arches run on
// the Old City Hall axis, i.e. E–W), recorded as a derivation, not presented as a researched fact.
//
// CAMERA LAW (Phase 34's pinned south+east pair) decides which truth gets which treatment:
//   • the concave faces carry the warm lit-window floor bands — TRUE (Revell's offices all face
//     inward) and the west tower's concave face is squarely camera-visible across the gap;
//   • the convex backs are nearly-blind ribbed precast — also TRUE, and the east tower's back is
//     the face a car on Bay Street actually drives past;
//   • the saucer sits in the gap, framed by both crescents when seen from the square to the south.
// Building the east tower's inward-facing bands (never on-rig visible) is the Rogers-Centre
// north-hotel-strip call from Phase 45: a camera-invisible face is still worth building when it is
// the building's identity, and here the two towers share one code path anyway.
//
// SINGLE SOURCE OF TRUTH: every dimension derives from the placement's own DATA boxes (which
// namedBuildings.ts computes from building-specs.json) or from the street table. There is not one
// literal world coordinate in this file; the literals are proportions, researched real-world
// metres transcribed from the spec row's own notes (marked as such, with the row's own documented
// footprint/height rules applied to them), and design values that carry their reason.

import { CAMERA_EYE_MIN_WU } from '../../config/camera';
import { GROUND_STACK } from '../../config/layering';
import { NAMED_HEIGHT_SCALE } from '../../config/torontoMap';
import { lookForMaterial } from '../../config/torontoMaterials';
import {
  addArcBand,
  addArcRing,
  addBox,
  addFace,
  addPrismY,
  addTriFacing,
  arcOutward,
  arcPoint,
  arcTangent,
  createAccum,
  toGeometry,
  triangleCount,
  type Accum,
  type ArcSpec,
  type Vec3,
} from './bespokeMesh';
import type { Aabb } from './claimIndex';
import { hGame } from './heightCurve';
import type { NamedBox, NamedPlacement } from './namedBuildings';
import type {
  NamedBespoke,
  NamedBespokeGeometry,
  NamedExtraClaim,
  NamedExtraCollider,
  NamedGeometryCtx,
} from './namedGeometry';
import { CIVIC_HEART_RENDER_GROUP } from './namedGeometry';
import type { Street } from './streets';

// --- tri budgets (Part 11 rule 2: stated per model, pinned in the phase that introduces them) ------

/** The CAMPUS: both crescent towers + the saucer + the podium articulation. Pinned by
 * newCityHall.test.ts with a FLOOR as well as a ceiling — unionStation.test.ts's idiom: a
 * regression that quietly reverted the crescents to slabs would pass a ceiling-only budget. */
export const CITY_HALL_CAMPUS_MAX_TRIS = 1800 as const;
/** NATHAN PHILLIPS SQUARE: plaza + rink + the three arches + the TORONTO sign + the flagpole row. */
export const NATHAN_PHILLIPS_SQUARE_MAX_TRIS = 600 as const;

// --- researched real-world numbers (transcribed from the spec row's own R47 notes) ----------------
//
// These four live in the `notes` PROSE of data/toronto/building-specs.json's `new-city-hall` row —
// there is no structured field for a sub-element's diameter or for a plaza sign — so they are
// transcribed ONCE, here, each with its citation, and converted with the row's OWN documented
// rules: heights through `hGame() × NAMED_HEIGHT_SCALE` (namedBuildings.ts's `namedHeight`), and
// footprints through the rule the row's `footprint_note` states verbatim: `real_m / 1.55 × 0.5`.

/** Council chamber: "155 ft (47.2 m) diameter" (R47). */
const SAUCER_REAL_DIAMETER_M = 47.2;
/** Council chamber: "~40 ft (12.2 m) to dome peak" (R47), measured from the podium roof. */
const SAUCER_REAL_HEIGHT_M = 12.2;
/** The spec row's own footprint rule: `footprint_wu derived from … real_m / 1.55 * 0.5`. */
const FOOTPRINT_M_PER_WU = 1.55;
const FOOTPRINT_HALF_SCALE = 0.5;
/** TORONTO sign: "3 m letter height, 22 m total length" (R47). Used as an ASPECT RATIO only — see
 * SIGN_LETTER_HEIGHT_WU for why the sign ships at prop scale rather than map scale. */
const SIGN_REAL_LETTER_HEIGHT_M = 3;
const SIGN_REAL_LENGTH_M = 22;

// --- proportions + design values (the only other literals; each carries its reason) ---------------

/**
 * Crescent wall thickness, as a fraction of the data slab's own depth (2·hx). The slab is the
 * tower's BOUNDING box, so the curve has to be inscribed in it: the convex arc uses the slab's
 * full depth as its sagitta (the strongest curve the data allows — see `crescentFor`), which
 * leaves this fraction as the wall's own thickness. 0.6 keeps a believable slab thickness while
 * leaving the concave sweep clearly hollow.
 */
const TOWER_WALL_FRAC = 0.6;
/** Facets per crescent. 12 puts a ~4 wu chord on a 48 wu tower — past ~8 the silhouette stops
 * improving and the tri cost is linear in this number (it multiplies the window bands too). */
const TOWER_SEGMENTS = 12;
/**
 * Warm lit-window bands on the concave face, as horizontal STRIPS OF THE SAME curved surface
 * (adjacent, edge-sharing — the GO shed's rib/glass pattern, which cannot z-fight). Five bands is
 * a legibility choice, not a floor count: the east tower's 27 storeys over 19.5 wu would be 0.72
 * wu per floor, which survives THIN_GEOMETRY's stripe floor but costs 27 × 12 quads of window band
 * per tower for a read no camera can resolve. Bands quote the stack; they don't count it.
 */
const LIT_BAND_COUNT = 5;
/** Vertical rib fins on the convex back, per tower, and their dimensions (wu). Absolute, and
 * deliberately up-scaled for legibility past THIN_GEOMETRY.minStripeWidthWu — the same call
 * unionStation.ts's COLUMN_RADIUS_WU makes (a to-scale precast rib would be ~0.15 wu). */
const FIN_COUNT = 6;
const FIN_HALF_WIDTH_WU = 0.34;
const FIN_PROUD_WU = 0.4;
/** How far a fin's root is buried inside the wall it rides (wu) — no flush base seam ever. */
const FIN_BURY_WU = 0.15;

/** Saucer vertical proportions, as fractions of its own height above the podium roof: the stem
 * ends, the flared underside meets the drum, the drum meets the dome. The dome ALWAYS terminates
 * at the derived peak (never at a fraction sum), so meta.saucerTopY is exact. */
const SAUCER_STEM_TOP_FRAC = 0.22;
const SAUCER_DRUM_BASE_FRAC = 0.42;
const SAUCER_GLAZING_TOP_FRAC = 0.58;
const SAUCER_DOME_BASE_FRAC = 0.7;
/** Stem radius + dome shoulder radius, as fractions of the saucer radius. */
const SAUCER_STEM_RADIUS_FRAC = 0.28;
const SAUCER_DOME_SHOULDER_FRAC = 0.45;
/** Facets around the saucer / its stem. The saucer is the composition's focal point and sits in
 * the open gap, so it carries the higher count. */
const SAUCER_SIDES = 14;
const SAUCER_STEM_SIDES = 10;
/** Clearance (wu) the saucer keeps from each crescent's concave face at mid-span. The derived
 * diameter is CLAMPED by this rather than trusted — if a future data change narrows the towers'
 * gap, the saucer shrinks instead of growing through a wall. */
const SAUCER_GAP_CLEARANCE_WU = 1.5;

/** Podium parapet: a proud lip ring around the roof edge (wu). Both numbers stay far inside
 * namedBuildings.ts's 3 wu massing-exclusion margin, so no claim or collider changes (Union's
 * cornice and the Royal York's eave make the identical call). */
const PARAPET_PROUD_WU = 0.35;
const PARAPET_HALF_THICK_WU = 0.35;
const PARAPET_BELOW_ROOF_WU = 0.45;
const PARAPET_ABOVE_ROOF_WU = 0.55;
/** South-face entrance portal (wu): the camera-visible elevation gets the one articulated door.
 * Piers + canopy stand PROUD of the render box's facade rather than cutting a recess into it — a
 * render box cannot be carved, and Union's pilaster rhythm set the precedent for reading depth
 * from proud members instead. */
const PORTAL_WIDTH_WU = 12;
const PORTAL_PIER_HALF_WU = 0.7;
const PORTAL_PIER_PROUD_WU = 0.6;
const PORTAL_HEIGHT_WU = 3.4;
const PORTAL_CANOPY_H_WU = 0.5;
const PORTAL_CANOPY_PROUD_WU = 1.2;
const PORTAL_GLASS_PROUD_WU = 0.25;
/** The threshold in front of the doors: two steps on the west half, a ramp on the east (the
 * camera-visible side). Depth is capped by the campus rect — the tower slabs reach 1 wu further
 * south than the podium, and nothing here may reach past THEM. */
const THRESHOLD_DEPTH_WU = 0.95;
const THRESHOLD_RISE_WU = 0.55;

/** Nathan Phillips Square, street-referenced. Each offset is measured from a resolved edge and
 * says what it clears. */
const SQUARE = {
  /** West edge, west of the campus centreline. Osgoode Hall's massing exclusion ends ~2.8 wu
   * further west at this offset, so the square never touches its lawn (asserted in the test). */
  westOfCampusWu: 24,
  /** East edge, clear of Bay's ribbon: 3 wu of sidewalk band + 4 wu of margin. */
  bayClearanceWu: 7,
  /** North edge, south of the podium's own data box. */
  podiumGapWu: 2,
  /** South edge, clear of Queen's ribbon: the same 3 wu band + 3 wu (the square's south lip is
   * where the TORONTO sign stands, so it keeps the wider margin). */
  queenClearanceWu: 6,
} as const;

/** The rink INSIDE the plaza, as fractions of the plaza's own extents. It occupies the northern
 * ~⅔ (under the arches, framed by the towers behind it), leaving the southern strip for the sign
 * and the flagpole row — the real square's own zoning. */
const RINK = {
  insetXFrac: 0.11,
  northFrac: 0.08,
  southFrac: 0.62,
} as const;

/** The three Freedom Arches. Span/height are UNVERIFIED (the researcher flagged them), so: the
 * span is DERIVED (rink depth + a foot outside the ice at each end) and the rise is a design
 * fraction of that span, stated here rather than invented as a metre value. */
const ARCH = {
  count: 3,
  footMarginWu: 1.5,
  riseFrac: 0.22,
  /** Facets along each arch's half-sine curve — 8 is where the curve stops reading as a tent. */
  facets: 8,
  /** Rectangular beam section (wu). Both dimensions clear THIN_GEOMETRY.minStripeWidthWu. */
  halfWidthWu: 0.3,
  halfThickWu: 0.28,
} as const;

/**
 * TORONTO sign letter height (wu) — a PROP-SCALE homage, deliberately not map-scale. The map
 * compresses buildings (the podium's researched 8 m becomes 4.28 wu) but vehicles are 1 unit = 1 m,
 * so the player's car is ~4.4 wu long: a to-scale 3 m letter would be ~1.6 wu and read as knee-high
 * litter beside it. 2.6 wu is ~0.6 car lengths — the height at which the sign reads as the landmark
 * it is from a drive-past. The RUN length keeps the researched 22:3 aspect exactly.
 */
const SIGN_LETTER_HEIGHT_WU = 2.6;
/** Letter block depth (wu) and the fraction of each letter cell the glyph fills. */
const SIGN_LETTER_DEPTH_WU = 0.9;
const SIGN_LETTER_WIDTH_FRAC = 0.8;
/** Stroke thickness as a fraction of the letter cell — the block-letter weight. */
const SIGN_STROKE_FRAC = 0.22;
/** Where the sign stands, as a fraction of the plaza depth measured NORTH from its south edge. */
const SIGN_SOUTH_FRAC = 0.13;
/** The word itself — its length is the letter count the run divides into. */
const SIGN_TEXT = 'TORONTO';
/** Margin (wu) the sign's claim/collider adds around the letter run. */
const SIGN_CLAIM_MARGIN_WU = 0.5;
/**
 * Sign collider height (wu). THE LETTERS MUST STOP THE CAR: Phase 37 proved by creep/ram/drop
 * probe that a collider under ride height is CURB-HOPPED by the raycast vehicle (the suspension
 * rays ramp the chassis over it), and fixed its dead-end jersey rows by giving 0.9 wu visuals a
 * ring-height 3 collider. Same law, same number, same reason — the visual letters stay 2.6 wu.
 */
const SIGN_COLLIDER_HEIGHT_WU = 3;

/** The flagpole row on the plaza's west strip. Poles are visual-only (nothing in the square blocks
 * except the sign — see NEW_CITY_HALL_SQUARE_COLLIDER_NOTE below). */
const FLAGPOLE = {
  count: 3,
  /** Half-section (wu): 0.34 wu across clears THIN_GEOMETRY.minStripeWidthWu (0.3), which a
   * to-scale flagpole would not — the P41 thin-geometry law, applied at the source. */
  halfWu: 0.17,
  heightWu: 6.5,
  /** Row position, as fractions of the plaza's extents. */
  westFrac: 0.06,
  southFracs: [0.72, 0.8, 0.88] as const,
  flagWidthWu: 1.5,
  flagHeightWu: 0.9,
  /** Flag plate depth (wu) — also over the thin-geometry floor, for the same reason. */
  flagDepthWu: 0.32,
} as const;

// WHY THE SQUARE'S FURNITURE CARRIES NO COLLIDERS. The arches' feet are 0.6 wu posts and a
// flagpole is 0.34 wu across; a collider on either is precisely the sub-ride-height / hair-thin
// obstacle Phase 37 measured the raycast vehicle CURB-HOPPING (and, where it doesn't hop, a
// car-trap in the middle of an otherwise drivable plaza). The square is drivable BY DESIGN — that
// is the whole joy of a 4.85 ha civic plaza in this game — and the TORONTO sign is the one thing in
// it that stops you, at ring height. Union's visual-only balustrade set the precedent one phase ago.

// --- palette (unlit-literal; §4's precast_grey look is the single source for the concrete) --------

/** The §4 fill itself — authored on the crescents' END RETURNS, which is where a face SHOULD read
 * a step darker than the compensated main walls (see PRECAST_LIGHT). */
const PRECAST = lookForMaterial('precast_grey').fill;
/**
 * The crescents' own concrete, one step LIGHTER than the §4 fill. The render-box podium below them
 * is drawn flat-unlit at exactly `PRECAST`, while every face in this mesh carries bespokeMesh's
 * baked directional shade (0.5–1.0) — so a vertical wall authored at the same hex would land ~30%
 * darker than the podium and the complex would read as two buildings. Lifting the authored hex is
 * what makes the shaded result sit in the same precast family.
 */
const PRECAST_LIGHT = '#8d8996';
const PRECAST_SHADE = '#4f4c57'; // window spandrels + the saucer stem — recessive by design
const LIT_WINDOW = lookForMaterial('precast_grey').windowTint; // the §4 warm office glow
const SAUCER_WHITE = '#d3d4d9'; // the focal point: pale, and the only near-white mass on the block
const SAUCER_SHADE = '#b0b2bb';
const SAUCER_GLASS = '#3d4a5c';
const PLAZA_STONE = '#726e78'; // civic paving — a shade off the road, so the square edge reads
const RINK_ICE = '#cfe4f2'; // pale blue-white, unshaded: the blue-hour night-rink glow
const ARCH_CONCRETE = '#9c98a4';
const POLE_METAL = '#9aa0a8';
/** The LED sign's per-letter colours — a seven-hue homage to the real 228-million-combination
 * sign (which cycles; this map's permanent blue hour gets ONE frozen frame of it). Unshaded. */
const SIGN_LETTER_COLORS: readonly string[] = ['#e0453c', '#f08b2a', '#f4d03f', '#4caf50', '#3a8fd8', '#7b5bd6', '#e0559b'];
const FLAG_COLORS: readonly string[] = ['#d03a3a', '#3a6fd0', '#e8e6e0'];

// --- layout -----------------------------------------------------------------------------------

/** One crescent tower: its data slab, the arc its walls follow, and the two radii of that wall. */
interface Crescent {
  readonly box: NamedBox;
  readonly topY: number;
  readonly arc: ArcSpec;
  readonly rOuter: number;
  readonly rInner: number;
}

interface Saucer {
  readonly cx: number;
  readonly cz: number;
  readonly radius: number;
  readonly baseY: number;
  readonly peakY: number;
}

interface SignLayout {
  readonly run: Aabb;
  readonly baseY: number;
  readonly letterHeight: number;
  readonly letterWidth: number;
  readonly pitch: number;
  readonly zBack: number;
  readonly zFront: number;
}

interface CityHallLayout {
  readonly east: Crescent;
  readonly west: Crescent;
  readonly podium: NamedBox;
  readonly podiumTopY: number;
  readonly campusX: number;
  readonly campusRect: Aabb;
  readonly saucer: Saucer;
  readonly square: Aabb;
  readonly rink: Aabb;
  readonly sign: SignLayout;
  readonly archXs: readonly number[];
  readonly archNorthZ: number;
  readonly archSouthZ: number;
  readonly archTopY: number;
  readonly flagpoles: readonly { readonly x: number; readonly z: number }[];
}

function streetById(streets: readonly Street[], id: string): Street {
  const st = streets.find((s) => s.id === id);
  if (!st) throw new Error(`newCityHall: street "${id}" not in the built table`);
  return st;
}

/**
 * The crescent inscribed in a tower's data slab. The slab is a BOUNDING box (namedBuildings.ts
 * gives both towers `shape: longZ`, long axis N–S), so the convex arc takes the slab's full depth
 * as its sagitta — the strongest curve the data permits — which fixes the radius exactly:
 *
 *     R = (L² + s²) / 2s      with half-chord L = hz and sagitta s = 2·hx
 *
 * At mid-span the convex face touches the slab's outer face; at both ends it touches the slab's
 * INNER face, so the outer surface is inscribed by construction. The concave face follows at
 * constant radial thickness, which sweeps it past the slab's inner face toward the gap as the arc
 * turns away — that sweep IS the embrace, and it stays inside the CAMPUS rect (the union of the
 * three data boxes), which namedBuildings.ts's podium exclusion already reserves with 3 wu to
 * spare. `concave` names the direction the hollow side faces, i.e. where the arc's centre lies.
 */
function crescentFor(box: NamedBox, concave: 'west' | 'east'): Crescent {
  const halfChord = box.hz;
  const sagitta = 2 * box.hx;
  const rOuter = (halfChord * halfChord + sagitta * sagitta) / (2 * sagitta);
  const theta = Math.asin(Math.min(1, halfChord / rOuter));
  // Concave-west → the material is the slab's EAST half and the arc centre lies west of it, so the
  // arc is sampled about a = 0 (which points +X, i.e. toward the convex face). Concave-east is the
  // mirror, sampled about a = π.
  const base = concave === 'west' ? 0 : Math.PI;
  const cx = concave === 'west' ? box.cx + box.hx - rOuter : box.cx - box.hx + rOuter;
  return {
    box,
    topY: box.hy * 2,
    arc: { cx, cz: box.cz, a0: base - theta, a1: base + theta, segments: TOWER_SEGMENTS },
    rOuter,
    rInner: rOuter - sagitta * TOWER_WALL_FRAC,
  };
}

/** Named-building height rule, mirrored from namedBuildings.ts's private `namedHeight` (the §3c
 * curve then the Part-8 named scale) so a metre value transcribed from the spec row's notes
 * converts EXACTLY the way the row's own `real_h_m` does. */
function namedHeightWu(realM: number): number {
  return hGame(realM) * NAMED_HEIGHT_SCALE;
}

/** The podium's index in `placement.boxes` — the one data box this builder still renders. Single
 * source for the role guard below and for the `renderBoxDataIndices` mapping. */
const CITY_HALL_PODIUM_BOX_INDEX = 2;

function cityHallLayout(placement: NamedPlacement, ctx: NamedGeometryCtx): CityHallLayout {
  const [eastBox, westBox, podium] = placement.boxes;
  if (placement.boxes.length !== 3 || eastBox === undefined || westBox === undefined || podium === undefined) {
    throw new Error('newCityHall: expected three data boxes (east tower, west tower, podium)');
  }
  // Guarded, not assumed: the builder reads its boxes BY ROLE. If a future authoring edit reorders
  // them, this throws instead of quietly building the saucer inside a tower.
  if (!(eastBox.cx > westBox.cx)) throw new Error('newCityHall: box 0 must be the EAST tower');
  if (!(podium.hx > eastBox.hx && podium.hy < eastBox.hy)) throw new Error('newCityHall: box 2 must be the low, wide podium');

  const podiumTopY = podium.hy * 2;
  const east = crescentFor(eastBox, 'west');
  const west = crescentFor(westBox, 'east');
  const campusRect: Aabb = {
    minX: Math.min(...placement.boxes.map((b) => b.cx - b.hx)),
    maxX: Math.max(...placement.boxes.map((b) => b.cx + b.hx)),
    minZ: Math.min(...placement.boxes.map((b) => b.cz - b.hz)),
    maxZ: Math.max(...placement.boxes.map((b) => b.cz + b.hz)),
  };

  // --- the saucer, in the gap the two crescents leave ------------------------------------------
  const saucerCx = (eastBox.cx + westBox.cx) / 2;
  const saucerCz = (eastBox.cz + westBox.cz) / 2;
  // The concave faces at mid-span are the walls the saucer must clear (each crescent's inner
  // radius, measured from its own arc centre) — derived, so a data change can only shrink it.
  const gapEastX = east.arc.cx + east.rInner;
  const gapWestX = west.arc.cx - west.rInner;
  const gapHalf = Math.min(saucerCx - gapWestX, gapEastX - saucerCx) - SAUCER_GAP_CLEARANCE_WU;
  const saucerRadius = Math.min(
    (SAUCER_REAL_DIAMETER_M / FOOTPRINT_M_PER_WU) * FOOTPRINT_HALF_SCALE * 0.5,
    gapHalf,
  );
  if (saucerRadius <= 0) throw new Error('newCityHall: the crescents leave no room for the council chamber');
  const saucer: Saucer = {
    cx: saucerCx,
    cz: saucerCz,
    radius: saucerRadius,
    baseY: podiumTopY,
    peakY: podiumTopY + namedHeightWu(SAUCER_REAL_HEIGHT_M),
  };

  // --- Nathan Phillips Square, street-referenced -----------------------------------------------
  const bay = streetById(ctx.streets, 'bay');
  const queen = streetById(ctx.streets, 'queen');
  const university = streetById(ctx.streets, 'university');
  const campusX = (university.centerline + bay.centerline) / 2;
  const square: Aabb = {
    minX: campusX - SQUARE.westOfCampusWu,
    maxX: bay.ribbon.minX - SQUARE.bayClearanceWu,
    minZ: podium.cz + podium.hz + SQUARE.podiumGapWu,
    maxZ: queen.ribbon.minY - SQUARE.queenClearanceWu,
  };
  if (square.maxX <= square.minX || square.maxZ <= square.minZ) {
    throw new Error('newCityHall: no room between the podium, Bay and Queen for Nathan Phillips Square');
  }
  const squareW = square.maxX - square.minX;
  const squareD = square.maxZ - square.minZ;
  const rink: Aabb = {
    minX: square.minX + RINK.insetXFrac * squareW,
    maxX: square.maxX - RINK.insetXFrac * squareW,
    minZ: square.minZ + RINK.northFrac * squareD,
    maxZ: square.minZ + RINK.southFrac * squareD,
  };

  // --- the Freedom Arches: an E-W row (the Old City Hall axis) spanning the rink N-S ------------
  const archNorthZ = rink.minZ - ARCH.footMarginWu;
  const archSouthZ = rink.maxZ + ARCH.footMarginWu;
  const archXs: number[] = [];
  for (let i = 0; i < ARCH.count; i++) {
    archXs.push(rink.minX + ((i + 1) / (ARCH.count + 1)) * (rink.maxX - rink.minX));
  }
  const archTopY = GROUND_STACK.civicPlaza + ARCH.riseFrac * (archSouthZ - archNorthZ);

  // --- the TORONTO sign: prop-scale letters at the researched 22:3 aspect -----------------------
  const runLength = SIGN_LETTER_HEIGHT_WU * (SIGN_REAL_LENGTH_M / SIGN_REAL_LETTER_HEIGHT_M);
  const signCx = (square.minX + square.maxX) / 2;
  const signCz = square.maxZ - SIGN_SOUTH_FRAC * squareD;
  const pitch = runLength / SIGN_TEXT.length;
  const sign: SignLayout = {
    run: {
      minX: signCx - runLength / 2,
      maxX: signCx + runLength / 2,
      minZ: signCz - SIGN_LETTER_DEPTH_WU / 2,
      maxZ: signCz + SIGN_LETTER_DEPTH_WU / 2,
    },
    baseY: GROUND_STACK.civicPlaza,
    letterHeight: SIGN_LETTER_HEIGHT_WU,
    letterWidth: pitch * SIGN_LETTER_WIDTH_FRAC,
    pitch,
    zBack: signCz - SIGN_LETTER_DEPTH_WU / 2,
    zFront: signCz + SIGN_LETTER_DEPTH_WU / 2,
  };

  const flagpoles = FLAGPOLE.southFracs.map((f) => ({
    x: square.minX + FLAGPOLE.westFrac * squareW,
    z: square.minZ + f * squareD,
  }));

  return {
    east,
    west,
    podium,
    podiumTopY,
    campusX,
    campusRect,
    saucer,
    square,
    rink,
    sign,
    archXs,
    archNorthZ,
    archSouthZ,
    archTopY,
    flagpoles,
  };
}

// --- the crescent towers ---------------------------------------------------------------------------

function appendCrescent(acc: Accum, c: Crescent, podiumTopY: number): void {
  const { arc, rOuter, rInner, topY } = c;

  // Convex back — one blind precast band, ground to parapet. Revell's offices face inward; the
  // back of a City Hall tower really is a nearly windowless ribbed wall.
  addArcBand(acc, arc, rOuter, 0, topY, PRECAST_LIGHT, 'out');

  // Concave front — a plain base inside the podium's own height, then the alternating
  // spandrel/lit-window floor bands. Bands are strips of ONE surface, so the warm glass sits IN
  // the concrete with no offset and no possible z-fight.
  addArcBand(acc, arc, rInner, 0, podiumTopY, PRECAST_SHADE, 'in');
  const rows = 2 * LIT_BAND_COUNT + 1; // spandrel, lit, spandrel, … spandrel
  for (let r = 0; r < rows; r++) {
    const y0 = podiumTopY + ((topY - podiumTopY) * r) / rows;
    const y1 = podiumTopY + ((topY - podiumTopY) * (r + 1)) / rows;
    const lit = r % 2 === 1;
    addArcBand(acc, arc, rInner, y0, y1, lit ? LIT_WINDOW : PRECAST_SHADE, 'in', { unshaded: lit });
  }

  // The two radial end walls, and the roof ring that caps the wall between its radii.
  for (const [i, dir] of [
    [0, -1],
    [arc.segments, 1],
  ] as const) {
    const t = arcTangent(arc, i);
    addFace(
      acc,
      [arcPoint(arc, i, rInner, 0), arcPoint(arc, i, rOuter, 0), arcPoint(arc, i, rOuter, topY), arcPoint(arc, i, rInner, topY)],
      [t[0] * dir, 0, t[2] * dir],
      PRECAST,
    );
  }
  addArcRing(acc, arc, rInner, rOuter, topY, PRECAST_LIGHT, 'up');

  // Vertical rib fins on the convex back, spaced along the arc and anchored ON its facet CREASES —
  // the one place a faceted band actually touches its true circle, so a fin rooted `FIN_BURY_WU`
  // inside the radius is buried on BOTH adjacent facets and can never float. Closed at the top: an
  // open fin is the see-through shell class the Royal York's dormers were caught by.
  const step = arc.segments / FIN_COUNT;
  for (let k = 0; k < FIN_COUNT; k++) {
    appendFin(acc, arc, (k + 0.5) * step, rOuter, podiumTopY, topY);
  }
}

function appendFin(acc: Accum, arc: ArcSpec, i: number, rOuter: number, y0: number, y1: number): void {
  const n = arcOutward(arc, i);
  const t = arcTangent(arc, i);
  const rBase = rOuter - FIN_BURY_WU;
  const rTop = rOuter + FIN_PROUD_WU;
  const at = (side: 1 | -1, r: number, y: number): Vec3 => [
    arc.cx + r * n[0] + side * FIN_HALF_WIDTH_WU * t[0],
    y,
    arc.cz + r * n[2] + side * FIN_HALF_WIDTH_WU * t[2],
  ];
  for (const side of [1, -1] as const) {
    addFace(acc, [at(side, rBase, y0), at(side, rBase, y1), at(side, rTop, y1), at(side, rTop, y0)], [t[0] * side, 0, t[2] * side], PRECAST_LIGHT);
  }
  addFace(acc, [at(1, rTop, y0), at(1, rTop, y1), at(-1, rTop, y1), at(-1, rTop, y0)], n, PRECAST_LIGHT);
  addFace(acc, [at(1, rBase, y1), at(1, rTop, y1), at(-1, rTop, y1), at(-1, rBase, y1)], [0, 1, 0], PRECAST_LIGHT);
}

// --- the council chamber (saucer) --------------------------------------------------------------------

function appendSaucer(acc: Accum, L: CityHallLayout): void {
  const s = L.saucer;
  const height = s.peakY - s.baseY;
  const at = (frac: number): number => s.baseY + frac * height;
  const stemR = s.radius * SAUCER_STEM_RADIUS_FRAC;
  // Stem — no caps: its top is buried in the flared underside above it, its base in the podium roof.
  addPrismY(acc, SAUCER_STEM_SIDES, s.baseY, at(SAUCER_STEM_TOP_FRAC), s.cx, s.cz, stemR, stemR, PRECAST_SHADE);
  // The flared underside, the glazed band the council chamber looks out of, the pale drum, and the
  // shallow dome that terminates EXACTLY at the derived peak (never at a fraction sum).
  addPrismY(acc, SAUCER_SIDES, at(SAUCER_STEM_TOP_FRAC), at(SAUCER_DRUM_BASE_FRAC), s.cx, s.cz, stemR * 1.1, s.radius, SAUCER_SHADE);
  addPrismY(acc, SAUCER_SIDES, at(SAUCER_DRUM_BASE_FRAC), at(SAUCER_GLAZING_TOP_FRAC), s.cx, s.cz, s.radius, s.radius, SAUCER_GLASS);
  addPrismY(acc, SAUCER_SIDES, at(SAUCER_GLAZING_TOP_FRAC), at(SAUCER_DOME_BASE_FRAC), s.cx, s.cz, s.radius, s.radius, SAUCER_WHITE);
  addPrismY(acc, SAUCER_SIDES, at(SAUCER_DOME_BASE_FRAC), s.peakY, s.cx, s.cz, s.radius, s.radius * SAUCER_DOME_SHOULDER_FRAC, SAUCER_WHITE, {
    capTop: true,
  });
}

// --- the podium's articulation -------------------------------------------------------------------------

function appendPodiumDetail(acc: Accum, L: CityHallLayout): void {
  const p = L.podium;
  const roof = L.podiumTopY;
  const cy = roof + (PARAPET_ABOVE_ROOF_WU - PARAPET_BELOW_ROOF_WU) / 2;
  const hy = (PARAPET_ABOVE_ROOF_WU + PARAPET_BELOW_ROOF_WU) / 2;
  const outerHx = p.hx + PARAPET_PROUD_WU;
  // Parapet ring — four bars that ABUT at the corners (the E/W bars stop where the N/S bars start)
  // rather than overlapping: two overlapping bars would share a top-face plane, which is the exact
  // coplanar pair Phase 39's ladder exists to prevent.
  for (const dz of [-1, 1] as const) {
    addBox(acc, p.cx, cy, p.cz + dz * p.hz, outerHx, hy, PARAPET_HALF_THICK_WU, PRECAST_LIGHT);
  }
  for (const dx of [-1, 1] as const) {
    addBox(acc, p.cx + dx * p.hx, cy, p.cz, PARAPET_HALF_THICK_WU, hy, p.hz - PARAPET_HALF_THICK_WU, PRECAST_LIGHT);
  }

  // The south-face entrance: two proud piers, a canopy over them, and the dark glazed wall between
  // — the recess read, built proud (see PORTAL_* above for why a render box can't be carved).
  const zFace = p.cz + p.hz;
  const halfPortal = PORTAL_WIDTH_WU / 2;
  for (const dx of [-1, 1] as const) {
    addBox(
      acc,
      p.cx + dx * (halfPortal - PORTAL_PIER_HALF_WU),
      PORTAL_HEIGHT_WU / 2,
      zFace + PORTAL_PIER_PROUD_WU / 2,
      PORTAL_PIER_HALF_WU,
      PORTAL_HEIGHT_WU / 2,
      PORTAL_PIER_PROUD_WU / 2,
      PRECAST_LIGHT,
    );
  }
  addBox(
    acc,
    p.cx,
    PORTAL_HEIGHT_WU + PORTAL_CANOPY_H_WU / 2,
    zFace + PORTAL_CANOPY_PROUD_WU / 2,
    halfPortal + PORTAL_PIER_HALF_WU,
    PORTAL_CANOPY_H_WU / 2,
    PORTAL_CANOPY_PROUD_WU / 2,
    PRECAST_LIGHT,
  );
  addBox(
    acc,
    p.cx,
    PORTAL_HEIGHT_WU / 2,
    zFace + PORTAL_GLASS_PROUD_WU / 2,
    halfPortal - 2 * PORTAL_PIER_HALF_WU,
    PORTAL_HEIGHT_WU / 2,
    PORTAL_GLASS_PROUD_WU / 2,
    SAUCER_GLASS,
  );

  // The threshold: steps on the west half, an accessible ramp on the east (camera-visible) half.
  const stepDepth = THRESHOLD_DEPTH_WU / 2;
  for (const [k, rise] of [
    [0, THRESHOLD_RISE_WU],
    [1, THRESHOLD_RISE_WU / 2],
  ] as const) {
    addBox(
      acc,
      p.cx - halfPortal / 2,
      rise / 2,
      zFace + stepDepth * (k + 0.5),
      halfPortal / 2,
      rise / 2,
      stepDepth / 2,
      PRECAST_LIGHT,
    );
  }
  appendRamp(acc, p.cx + PORTAL_PIER_HALF_WU, p.cx + halfPortal, zFace, zFace + THRESHOLD_DEPTH_WU, THRESHOLD_RISE_WU);
}

/** A wedge ramp: a sloped top face from `yHigh` at `zHigh` down to the plaza at `zLow`, closed by
 * two side triangles. Four triangles for the whole thing. */
function appendRamp(acc: Accum, x0: number, x1: number, zHigh: number, zLow: number, yHigh: number): void {
  const base = GROUND_STACK.civicPlaza;
  addFace(
    acc,
    [
      [x0, yHigh, zHigh],
      [x1, yHigh, zHigh],
      [x1, base, zLow],
      [x0, base, zLow],
    ],
    [0, 1, 0],
    PRECAST_LIGHT,
  );
  addTriFacing(acc, [x1, yHigh, zHigh], [x1, base, zLow], [x1, base, zHigh], [1, 0, 0], PRECAST_LIGHT);
  addTriFacing(acc, [x0, yHigh, zHigh], [x0, base, zLow], [x0, base, zHigh], [-1, 0, 0], PRECAST_LIGHT);
}

// --- Nathan Phillips Square ----------------------------------------------------------------------------

function addGroundQuad(acc: Accum, rect: Aabb, y: number, hex: string, unshaded: boolean): void {
  addFace(
    acc,
    [
      [rect.minX, y, rect.minZ],
      [rect.minX, y, rect.maxZ],
      [rect.maxX, y, rect.maxZ],
      [rect.maxX, y, rect.minZ],
    ],
    [0, 1, 0],
    hex,
    { unshaded },
  );
}

/** One Freedom Arch: a rectangular beam swept along a half-sine from foot to foot, its section
 * kept perpendicular to the curve (so the feet meet the plaza square-on rather than sheared). */
function appendArch(acc: Accum, x: number, zNorth: number, zSouth: number, rise: number): void {
  const span = zSouth - zNorth;
  const base = GROUND_STACK.civicPlaza;
  const centre = (t: number): { y: number; z: number } => ({ y: base + rise * Math.sin(Math.PI * t), z: zNorth + t * span });
  /** Section corners at parameter `t`: ± the section normal in the YZ plane, ± half-width in X. */
  const section = (t: number): { outer: [number, number]; inner: [number, number] } => {
    const c = centre(t);
    const dy = rise * Math.PI * Math.cos(Math.PI * t);
    const len = Math.hypot(dy, span) || 1;
    const ny = span / len;
    const nz = -dy / len;
    return {
      outer: [c.y + ny * ARCH.halfThickWu, c.z + nz * ARCH.halfThickWu],
      inner: [c.y - ny * ARCH.halfThickWu, c.z - nz * ARCH.halfThickWu],
    };
  };
  for (let f = 0; f < ARCH.facets; f++) {
    const s0 = section(f / ARCH.facets);
    const s1 = section((f + 1) / ARCH.facets);
    const corner = (s: { outer: [number, number]; inner: [number, number] }, edge: 'outer' | 'inner', dx: 1 | -1): Vec3 => [
      x + dx * ARCH.halfWidthWu,
      s[edge][0],
      s[edge][1],
    ];
    // Outer (upper) face, inner (soffit) face, and the two flanks — a closed section, so no
    // grazing vantage can look into the beam.
    addFace(acc, [corner(s0, 'outer', -1), corner(s0, 'outer', 1), corner(s1, 'outer', 1), corner(s1, 'outer', -1)], [0, 1, 0], ARCH_CONCRETE);
    addFace(acc, [corner(s0, 'inner', -1), corner(s0, 'inner', 1), corner(s1, 'inner', 1), corner(s1, 'inner', -1)], [0, -1, 0], ARCH_CONCRETE);
    for (const dx of [1, -1] as const) {
      addFace(acc, [corner(s0, 'inner', dx), corner(s0, 'outer', dx), corner(s1, 'outer', dx), corner(s1, 'inner', dx)], [dx, 0, 0], ARCH_CONCRETE);
    }
  }
}

// --- the TORONTO sign ----------------------------------------------------------------------------------

/** The block-letter alphabet SIGN_TEXT needs. Glyphs are authored in a unit cell (x and y both
 * 0…1, origin at the letter's bottom-left) as UPRIGHT bars plus, where a letter genuinely needs
 * one, a SLANT bar — an "N" without its diagonal reads as a Π, which is the kind of detail a
 * 2.6 wu homage cannot afford to lose. */
interface UprightStroke {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}
interface SlantStroke {
  readonly ax: number;
  readonly ay: number;
  readonly bx: number;
  readonly by: number;
}
interface Glyph {
  readonly uprights: readonly UprightStroke[];
  readonly slants: readonly SlantStroke[];
}

const S = SIGN_STROKE_FRAC;
const GLYPHS: Readonly<Record<string, Glyph>> = {
  T: {
    uprights: [
      { x0: 0, y0: 1 - S, x1: 1, y1: 1 },
      { x0: 0.5 - S / 2, y0: 0, x1: 0.5 + S / 2, y1: 1 - S },
    ],
    slants: [],
  },
  O: {
    uprights: [
      { x0: 0, y0: 0, x1: S, y1: 1 },
      { x0: 1 - S, y0: 0, x1: 1, y1: 1 },
      { x0: S, y0: 1 - S, x1: 1 - S, y1: 1 },
      { x0: S, y0: 0, x1: 1 - S, y1: S },
    ],
    slants: [],
  },
  R: {
    uprights: [
      { x0: 0, y0: 0, x1: S, y1: 1 },
      { x0: S, y0: 1 - S, x1: 0.8, y1: 1 },
      { x0: 1 - S, y0: 0.52, x1: 1, y1: 0.8 },
      { x0: S, y0: 0.44, x1: 0.8, y1: 0.44 + S },
    ],
    slants: [{ ax: 0.5, ay: 0.55, bx: 0.92, by: 0.06 }],
  },
  N: {
    uprights: [
      { x0: 0, y0: 0, x1: S, y1: 1 },
      { x0: 1 - S, y0: 0, x1: 1, y1: 1 },
    ],
    slants: [{ ax: 0.12, ay: 0.94, bx: 0.88, by: 0.06 }],
  },
};

/** A slanted bar in the letter's XY plane, extruded through the letter's depth: front, back and
 * both long flanks (the ends are buried inside the upright strokes it joins). */
function addSlantBar(acc: Accum, a: readonly [number, number], b: readonly [number, number], halfW: number, zBack: number, zFront: number, hex: string): void {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  const nx = (-dy / len) * halfW;
  const ny = (dx / len) * halfW;
  const corners: readonly (readonly [number, number])[] = [
    [a[0] + nx, a[1] + ny],
    [b[0] + nx, b[1] + ny],
    [b[0] - nx, b[1] - ny],
    [a[0] - nx, a[1] - ny],
  ];
  const at = (i: number, z: number): Vec3 => [corners[i][0], corners[i][1], z];
  addFace(acc, [at(0, zFront), at(1, zFront), at(2, zFront), at(3, zFront)], [0, 0, 1], hex, { unshaded: true });
  addFace(acc, [at(0, zBack), at(1, zBack), at(2, zBack), at(3, zBack)], [0, 0, -1], hex, { unshaded: true });
  addFace(acc, [at(0, zBack), at(1, zBack), at(1, zFront), at(0, zFront)], [nx, ny, 0], hex, { unshaded: true });
  addFace(acc, [at(3, zBack), at(2, zBack), at(2, zFront), at(3, zFront)], [-nx, -ny, 0], hex, { unshaded: true });
}

function appendSign(acc: Accum, L: CityHallLayout): void {
  const sign = L.sign;
  for (let i = 0; i < SIGN_TEXT.length; i++) {
    const glyph = GLYPHS[SIGN_TEXT[i]];
    if (glyph === undefined) throw new Error(`newCityHall: no block glyph for "${SIGN_TEXT[i]}"`);
    const hex = SIGN_LETTER_COLORS[i % SIGN_LETTER_COLORS.length];
    const x0 = sign.run.minX + i * sign.pitch + (sign.pitch - sign.letterWidth) / 2;
    const px = (u: number): number => x0 + u * sign.letterWidth;
    const py = (v: number): number => sign.baseY + v * sign.letterHeight;
    for (const st of glyph.uprights) {
      addBox(
        acc,
        (px(st.x0) + px(st.x1)) / 2,
        (py(st.y0) + py(st.y1)) / 2,
        (sign.zBack + sign.zFront) / 2,
        (px(st.x1) - px(st.x0)) / 2,
        (py(st.y1) - py(st.y0)) / 2,
        SIGN_LETTER_DEPTH_WU / 2,
        hex,
        {},
        { unshaded: true },
      );
    }
    for (const sl of glyph.slants) {
      addSlantBar(
        acc,
        [px(sl.ax), py(sl.ay)],
        [px(sl.bx), py(sl.by)],
        (S * sign.letterWidth) / 2,
        sign.zBack,
        sign.zFront,
        hex,
      );
    }
  }
}

function appendFlagpoles(acc: Accum, L: CityHallLayout): void {
  const baseY = GROUND_STACK.civicPlaza;
  L.flagpoles.forEach((pole, i) => {
    const top = baseY + FLAGPOLE.heightWu;
    addBox(acc, pole.x, (baseY + top) / 2, pole.z, FLAGPOLE.halfWu, (top - baseY) / 2, FLAGPOLE.halfWu, POLE_METAL);
    const flagTop = top - FLAGPOLE.flagHeightWu / 2;
    addBox(
      acc,
      pole.x + FLAGPOLE.halfWu + FLAGPOLE.flagWidthWu / 2,
      flagTop - FLAGPOLE.flagHeightWu / 2,
      pole.z,
      FLAGPOLE.flagWidthWu / 2,
      FLAGPOLE.flagHeightWu / 2,
      FLAGPOLE.flagDepthWu / 2,
      FLAG_COLORS[i % FLAG_COLORS.length],
      {},
      { unshaded: true },
    );
  });
}

function appendSquare(acc: Accum, L: CityHallLayout): void {
  // The paved plaza, then the rink INSIDE it on its own rung (the railTrack-inside-ballast pattern:
  // a surface's own inset decoration never shares its host's rung). The ice is UNSHADED — a pale
  // plane lit by nothing reads as wet asphalt at blue hour; the glow is the whole postcard.
  addGroundQuad(acc, L.square, GROUND_STACK.civicPlaza, PLAZA_STONE, false);
  addGroundQuad(acc, L.rink, GROUND_STACK.civicRink, RINK_ICE, true);
  const rise = L.archTopY - GROUND_STACK.civicPlaza;
  for (const x of L.archXs) appendArch(acc, x, L.archNorthZ, L.archSouthZ, rise);
  appendSign(acc, L);
  appendFlagpoles(acc, L);
}

// --- the render plan -----------------------------------------------------------------------------------

/**
 * THE SPLIT between the box path and this mesh:
 *   • the PODIUM keeps its full-height render box, so it gets the §4 precast facade with baked,
 *     seeded lit windows — exactly what the Phase-24 box path is good at, and what Union's wings
 *     and the Royal York's body also keep;
 *   • both TOWERS are replaced by geometry and their render boxes are DROPPED. They first shipped
 *     as buried 0.1 wu pads to satisfy the seam's original one-box-per-data-box law — and each
 *     invisible pad still cost a whole draw call on the per-box facade-texture path, which is what
 *     pushed the low-tier bench to 93/90. The law was amended the same session (renderBoxes may be
 *     a footprint-matched SUBSET, namedGeometry.test.ts): the placement is not "swallowed" — its
 *     data boxes still carry the claims, colliders and exclusions — it just isn't paid for twice.
 */
function cityHallRenderBoxes(L: CityHallLayout): readonly NamedBox[] {
  // Exactly one entry, and `renderBoxDataIndices` says which data box it is. Keep the two in step.
  return [{ ...L.podium }];
}

function cityHallExtraClaims(L: CityHallLayout): readonly NamedExtraClaim[] {
  return [
    {
      // NATHAN PHILLIPS SQUARE. Blocking `decor` (Union's moat precedent) — this single claim is
      // what keeps every later placer (frontage, infill, furniture, parks, venues) off the square,
      // so the plaza stays the empty civic room it is in life. The yRange describes the PAVED
      // SURFACE, not the arches standing on it: the arbiter's sweep is XZ, and a decor claim never
      // reaches the camera clip index, so the rect is the whole protection.
      id: 'nps-square',
      kind: 'decor',
      aabb: L.square,
      yRange: [0, GROUND_STACK.civicRink],
    },
    {
      // The TORONTO sign row: a real volume that blocks, so `namedBuilding` — and its rect must
      // equal its collider's footprint exactly (namedGeometry.test.ts asserts the pair).
      id: 'toronto-sign',
      kind: 'namedBuilding',
      aabb: signClaimRect(L),
      yRange: [0, SIGN_COLLIDER_HEIGHT_WU],
    },
  ];
}

function signClaimRect(L: CityHallLayout): Aabb {
  const m = SIGN_CLAIM_MARGIN_WU;
  return {
    minX: L.sign.run.minX - m,
    maxX: L.sign.run.maxX + m,
    minZ: L.sign.run.minZ - m,
    maxZ: L.sign.run.maxZ + m,
  };
}

function cityHallExtraColliders(L: CityHallLayout): readonly NamedExtraCollider[] {
  const rect = signClaimRect(L);
  const hy = SIGN_COLLIDER_HEIGHT_WU / 2;
  return [
    {
      id: 'toronto-sign',
      cx: (rect.minX + rect.maxX) / 2,
      cy: hy,
      cz: (rect.minZ + rect.maxZ) / 2,
      hx: (rect.maxX - rect.minX) / 2,
      hy,
      hz: (rect.maxZ - rect.minZ) / 2,
    },
  ];
}

function buildCityHallGeometry(L: CityHallLayout): NamedBespokeGeometry {
  const acc = createAccum();
  appendCrescent(acc, L.east, L.podiumTopY);
  appendCrescent(acc, L.west, L.podiumTopY);
  appendSaucer(acc, L);
  appendPodiumDetail(acc, L);
  const campus = triangleCount(acc);
  appendSquare(acc, L);
  const total = triangleCount(acc);
  return {
    geometry: toGeometry(acc, false),
    triangles: total,
    parts: [
      { id: 'campus', triangles: campus },
      { id: 'square', triangles: total - campus },
    ],
  };
}

/** The seam entry point (registered in namedGeometry.ts's `namedGeometryBuilders`). */
export function buildNewCityHallBespoke(placement: NamedPlacement, ctx: NamedGeometryCtx): NamedBespoke {
  const L = cityHallLayout(placement, ctx);
  return {
    id: placement.id,
    renderBoxes: cityHallRenderBoxes(L),
    // The one surviving render box IS data box 2 (the podium) — declared, so its facade/occlusion
    // key stays `new-city-hall#2` instead of being renumbered to `#0` by its array position.
    renderBoxDataIndices: [CITY_HALL_PODIUM_BOX_INDEX],
    renderGroup: CIVIC_HEART_RENDER_GROUP,
    // No atlas wordmark: the TORONTO sign is 3D block lettering INSIDE this mesh (per-letter LED
    // colours are the whole point of it), so the shared namedSignage atlas has nothing to add here.
    signQuads: [],
    extraClaims: cityHallExtraClaims(L),
    extraColliders: cityHallExtraColliders(L),
    meta: {
      topY: L.east.topY,
      probes: {
        towerTopEast: L.east.topY,
        towerTopWest: L.west.topY,
        podiumTopY: L.podiumTopY,
        campusX: L.campusX,
        campusMinX: L.campusRect.minX,
        campusMaxX: L.campusRect.maxX,
        campusMinZ: L.campusRect.minZ,
        campusMaxZ: L.campusRect.maxZ,
        towerSegments: TOWER_SEGMENTS,
        towerWallThicknessWu: L.east.rOuter - L.east.rInner,
        towerArcRadiusEast: L.east.rOuter,
        towerArcCentreXEast: L.east.arc.cx,
        towerArcCentreXWest: L.west.arc.cx,
        litBandCount: LIT_BAND_COUNT,
        finCount: FIN_COUNT,
        finWidthWu: 2 * FIN_HALF_WIDTH_WU,
        saucerCx: L.saucer.cx,
        saucerCz: L.saucer.cz,
        saucerRadius: L.saucer.radius,
        saucerBaseY: L.saucer.baseY,
        saucerTopY: L.saucer.peakY,
        gapEastX: L.east.arc.cx + L.east.rInner,
        gapWestX: L.west.arc.cx - L.west.rInner,
        squareMinX: L.square.minX,
        squareMaxX: L.square.maxX,
        squareMinZ: L.square.minZ,
        squareMaxZ: L.square.maxZ,
        rinkMinX: L.rink.minX,
        rinkMaxX: L.rink.maxX,
        rinkMinZ: L.rink.minZ,
        rinkMaxZ: L.rink.maxZ,
        plazaY: GROUND_STACK.civicPlaza,
        rinkY: GROUND_STACK.civicRink,
        archCount: ARCH.count,
        archTopY: L.archTopY,
        archMinZ: L.archNorthZ,
        archMaxZ: L.archSouthZ,
        archSectionWu: 2 * Math.min(ARCH.halfWidthWu, ARCH.halfThickWu),
        signMinX: L.sign.run.minX,
        signMaxX: L.sign.run.maxX,
        signMinZ: L.sign.run.minZ,
        signMaxZ: L.sign.run.maxZ,
        signBaseY: L.sign.baseY,
        signLetterHeightWu: L.sign.letterHeight,
        signLetterCount: SIGN_TEXT.length,
        signColliderHeightWu: SIGN_COLLIDER_HEIGHT_WU,
        flagpoleCount: FLAGPOLE.count,
        flagpoleThicknessWu: 2 * FLAGPOLE.halfWu,
        flagpoleTopY: GROUND_STACK.civicPlaza + FLAGPOLE.heightWu,
        eyeLineMinWu: CAMERA_EYE_MIN_WU,
      },
    },
    buildGeometry: () => buildCityHallGeometry(L),
  };
}
