// Phase 47 T2 (Part 11) — OSGOODE HALL, the fifth tenant of the `namedGeometryBuilders` seam
// (namedGeometry.ts's header explains the seam; royalYork.ts is the structural template).
//
// This is the seam's first SET-BACK landmark, and that is its whole identity. Every other named
// building on this map is flush to a ribbon — namedBuildings.ts's Phase-25 frontage rule pulls the
// facade to 3 wu off the kerb so it fills the frame on a drive-past. Osgoode Hall is deliberately
// NOT flush (see its AUTHORS entry): the researched read is a low Georgian pile standing well back
// from Queen behind its lawn and its famous 1867 wrought-iron fence, and a flush Osgoode Hall would
// be architecturally wrong AND indistinguishable from the streetwall it sits in.
//
// data/toronto/building-specs.json's R47 researcher notes (id `osgoode-hall`) verify: 130 Queen
// Street West, NE corner of Queen and University; a Georgian-era courthouse, ~3 storeys today; SET
// WELL BACK from Queen behind extensive landscaped grounds (6 acres); a Victorian wrought-iron
// fence installed 1867 with the distinctive cow-gate turnstiles. Confidence on the row is LOW and
// the notes say so explicitly: the height, the facade material (limestone, estimated) and the
// footprint are all estimates, and the specific architectural details are unverified. So the
// bespoke here stays MODEST by design — a low hip roof, a small central cupola, a four-column
// portico — rather than inventing a documented-looking building out of an undocumented one.
//
// WHAT THE BESPOKE ADDS, and why each piece is here:
//   • the render box keeps its FULL data height (unlike the Royal York / Old City Hall pattern):
//     at ~6 wu this is a three-storey building, and shrinking the body would leave the §4 limestone
//     facade with almost nothing to paint;
//   • roof + cupola + portico — the silhouette a flat-topped 16 wu box has none of;
//   • THE LAWN: two grass quads on `GROUND_STACK.parkGround`, filling the set-back yard between the
//     facade and Queen's sidewalk band and wrapping the west side toward University. They are also
//     `decor` CLAIMS, which is what keeps the seeded furniture/prop placers off the grounds (the
//     Phase-40 embedded-shelter class; Union's moat strip set the precedent);
//   • THE FENCE: posts + two rails along the lawn's south and west edges with a gate gap on the
//     building's own axis. VISUAL-ONLY, no collider — a ~1 wu obstacle in front of a building is
//     exactly the sub-ride-height geometry Phase 37 proved the raycast vehicle CURB-HOPS (its
//     suspension rays ramp the chassis over), so a fence collider would be a launch ramp, not a
//     fence. Every member also clears THIN_GEOMETRY.minStripeWidthWu — a to-scale wrought-iron
//     picket is ~0.05 wu and would strobe at any distance (P41's law).
//
// SINGLE SOURCE OF TRUTH: the building derives from the placement's own DATA box; the lawn and the
// fence derive from the DATA box plus Queen's and University's RIBBONS (the street table the seam
// hands every builder). There is not one literal world coordinate in this file.

import { GROUND_STACK, MIN_GROUND_SEP_WU } from '../../config/layering';
import { SIDEWALK } from '../../config/torontoMap';
import { lookForMaterial } from '../../config/torontoMaterials';
import {
  addBox,
  addFace,
  addPrismY,
  addTriFacing,
  createAccum,
  toGeometry,
  triangleCount,
  type Accum,
  type Vec3,
} from './bespokeMesh';
import type { NamedBox, NamedPlacement } from './namedBuildings';
import { CIVIC_HEART_RENDER_GROUP } from './namedGeometry';
import type { NamedBespoke, NamedBespokeGeometry, NamedExtraClaim, NamedGeometryCtx } from './namedGeometry';
import type { Street } from './streets';

// --- tri budget (Part 11 rule 2: stated per model, pinned in the phase that introduces them) -----

/** Roof + cupola + portico + lawn + fence. Pinned by osgoodeHall.test.ts with a FLOOR as well as a
 * ceiling — v1 was a 12-triangle box, and a ceiling-only budget would happily accept it back. */
export const OSGOODE_HALL_MAX_TRIS = 400 as const;

// --- proportions (the only literals; each one carries its reason) --------------------------------

/**
 * THE HEIGHT BUDGET ABOVE THE DATA BOX (wu). Everything this builder puts on the roof — hip, ridge,
 * cupola — is a fraction of this ONE number, so `meta.topY` is `dataHeight + CROWN_RISE_WU` by
 * construction and can never drift: at ~7.5 wu the whole landmark stays far below
 * CAMERA_EYE_MIN_WU (22.05), i.e. it is not and can never become an eye-line crosser
 * (`heightLaw.test.ts`'s subject), and the camera's anti-clip guard never has to think about it.
 */
const CROWN_RISE_WU = 1.5;
/** How that budget is spent, bottom → top (sums to 1 — the layout GUARDS the sum rather than
 * trusting this comment). A Georgian hip is genuinely shallow; the cupola is what gives the
 * silhouette its one vertical accent. */
const ROOF_RISE_FRAC = 0.4;
const CUPOLA_PEDESTAL_FRAC = 0.16;
const CUPOLA_DRUM_FRAC = 0.22;
const CUPOLA_DOME_FRAC = 0.22;

/** The roof plugs DOWN into the body by this much (wu) instead of starting exactly at the box top,
 * so no face of the roof ever shares a plane with the render box's own cap (the Phase 42
 * anti-coplanar rule applied at the source — unionStation.ts's attic skirt, same reasoning). */
const ROOF_SKIRT_WU = 0.25;
/** Eave overhang past the body wall (wu) and the ridge's half-extent as a fraction of the footprint
 * half — a hip with a real (short) ridge, not a pyramid. */
const ROOF_EAVE_PROUD_WU = 0.35;
const ROOF_RIDGE_FOOT_FRAC = 0.2;

/** Cupola: the pedestal is square (it sits on the ridge), the lantern above it is an OCTAGON — the
 * cheapest shape that reads as a round lantern from the fixed rig. Radii in wu. */
const CUPOLA_PEDESTAL_HALF_WU = 1.1;
const CUPOLA_DRUM_RADIUS_WU = 0.85;
const CUPOLA_DOME_RADIUS_WU = 0.16;
const CUPOLA_SIDES = 8;

/** South portico: four slim columns under an entablature and a pediment. Column thickness is
 * deliberately up-scaled past THIN_GEOMETRY.minStripeWidthWu (a to-scale column would strobe — the
 * call unionStation.ts's COLUMN_RADIUS_WU documents), and the whole porch stays inside
 * namedBuildings.ts's 3 wu massing-exclusion margin so no claim or collider changes. */
const PORTICO_COLUMN_COUNT = 4;
const PORTICO_COLUMN_HALF_WU = 0.22;
const PORTICO_DEPTH_WU = 1.8;
const PORTICO_HALF_FRAC = 0.42; // × the footprint half-extent
const PORTICO_COLUMN_TOP_FRAC = 0.62; // × the DATA height
const PORTICO_ENTABLATURE_H_WU = 0.45;
const PORTICO_PEDIMENT_H_WU = 0.7;
/** How far the entablature/pediment PLUG back into the body (wu). Without it the pediment's rear
 * face would land exactly on the render box's south facade — two coplanar surfaces, which is the
 * class Phase 42's flicker hunt exists to prevent (unionStation.ts's attic skirt, same trick). */
const PORTICO_PLUG_WU = 0.15;

/** Lawn: how far its EAST edge reaches past the building (wu). Bounded — east of the lot the civic
 * campus begins (Nathan Phillips Square's own claim, Phase 47 T1), and `osgoodeHall.test.ts` pins
 * the seam between the two layers rather than leaving it to luck. */
const LAWN_EAST_MARGIN_WU = 2.5;

/** The 1867 fence. Post/rail sections are absolute and all clear THIN_GEOMETRY.minStripeWidthWu
 * (asserted in the test, not just claimed here). The gate gap is centred on the BUILDING's axis, so
 * the walk from Queen lines up with the portico — the way the real forecourt reads. */
const FENCE = {
  postHalfWu: 0.16,
  postTopWu: 1.05,
  railHalfThickWu: 0.16,
  railHalfHeightWu: 0.18,
  /** Rail centre heights as fractions of the post height (a low rail and a high rail). The high one
   * is chosen so the rail's own TOP still clears under the post caps — a rail poking past its posts
   * reads as a mistake at any distance. */
  lowRailFrac: 0.32,
  highRailFrac: 0.8,
  /** Nominal post spacing (wu); the real count per run is derived from the run's own length. */
  postPitchWu: 4,
  gateWidthWu: 4.5,
} as const;

// --- palette (unlit-literal; §4's limestone look is the single source for the body colour) -------

const LIMESTONE = lookForMaterial('limestone').fill; // matches the render-box facade exactly
const LIMESTONE_LIGHT = '#cdb787'; // portico + cupola — proud elements read lighter
const ROOF_SLATE = '#4a4f58'; // a grey Georgian roof, NOT copper: no patina is claimed for Osgoode
const ROOF_SLATE_LIGHT = '#5d636d'; // ridge cap — the slope/cap two-tone device (royalYork.ts)
const LAWN_GRASS = '#3f5a37'; // the landscaped grounds
const FENCE_IRON = '#1e2226'; // wrought iron reads near-black at blue hour

// --- layout -----------------------------------------------------------------------------------

interface Span {
  readonly min: number;
  readonly max: number;
}

interface LawnRect {
  readonly id: string;
  readonly x: Span;
  readonly z: Span;
}

interface OsgoodeLayout {
  readonly box: NamedBox;
  readonly height: number;
  readonly zSouth: number;
  readonly roofBaseY: number;
  readonly roofRidgeY: number;
  readonly roofRidgeHalfX: number;
  readonly roofRidgeHalfZ: number;
  readonly cupolaPedestalTopY: number;
  readonly cupolaDrumTopY: number;
  readonly cupolaTopY: number;
  readonly portico: { readonly x: Span; readonly zFace: number; readonly columnTopY: number; readonly ridgeY: number };
  readonly lawnSouth: LawnRect;
  readonly lawnWest: LawnRect;
  readonly lawnY: number;
  /** The gate opening in the south fence run (centred on the building's own axis). */
  readonly gate: Span;
}

function streetById(streets: readonly Street[], id: string): Street {
  const st = streets.find((s) => s.id === id);
  if (!st) throw new Error(`osgoodeHall: street "${id}" not in the built table`);
  return st;
}

function osgoodeLayout(placement: NamedPlacement, ctx: NamedGeometryCtx): OsgoodeLayout {
  const box = placement.boxes[0];
  if (box === undefined) throw new Error('osgoodeHall: placement has no data box');
  // Guarded, not just commented: a future edit to one crown fraction without the others throws
  // instead of silently letting the cupola outgrow CROWN_RISE_WU (royalYork.ts's tier-sum guard).
  const crownSum = ROOF_RISE_FRAC + CUPOLA_PEDESTAL_FRAC + CUPOLA_DRUM_FRAC + CUPOLA_DOME_FRAC;
  if (Math.abs(crownSum - 1) > 1e-9) throw new Error('osgoodeHall: the crown fractions must sum to 1');

  const height = box.hy * 2;
  const zSouth = box.cz + box.hz;
  const roofRidgeY = height + ROOF_RISE_FRAC * CROWN_RISE_WU;
  const cupolaPedestalTopY = roofRidgeY + CUPOLA_PEDESTAL_FRAC * CROWN_RISE_WU;
  const cupolaDrumTopY = cupolaPedestalTopY + CUPOLA_DRUM_FRAC * CROWN_RISE_WU;

  // The set-back yard, derived from the RIBBONS on both sides (never a literal): the lawn fills
  // everything between the building and the far edge of each street's raised sidewalk band, which
  // is exactly the ground the flush-frontage rule would have covered with building.
  const queen = streetById(ctx.streets, 'queen');
  const university = streetById(ctx.streets, 'university');
  const lawnSouthEdge = queen.ribbon.minY - SIDEWALK.widthWu; // north edge of Queen's north walk
  const lawnWestEdge = university.ribbon.maxX + SIDEWALK.widthWu; // east edge of University's east walk
  const lawnEastEdge = box.cx + box.hx + LAWN_EAST_MARGIN_WU;
  // The south lawn starts SOUTH of the portico, so the porch stands on its own ground rather than
  // in the middle of the grass.
  const lawnNorthOfPortico = zSouth + PORTICO_DEPTH_WU;
  if (lawnSouthEdge <= lawnNorthOfPortico || lawnWestEdge >= box.cx - box.hx) {
    throw new Error('osgoodeHall: the set-back yard has no room left for the lawn');
  }

  const porticoHalf = PORTICO_HALF_FRAC * box.hx;
  const columnTopY = PORTICO_COLUMN_TOP_FRAC * height;

  return {
    box,
    height,
    zSouth,
    roofBaseY: height - ROOF_SKIRT_WU,
    roofRidgeY,
    roofRidgeHalfX: box.hx * ROOF_RIDGE_FOOT_FRAC,
    roofRidgeHalfZ: box.hz * ROOF_RIDGE_FOOT_FRAC,
    cupolaPedestalTopY,
    cupolaDrumTopY,
    cupolaTopY: height + CROWN_RISE_WU,
    portico: {
      x: { min: box.cx - porticoHalf, max: box.cx + porticoHalf },
      zFace: zSouth + PORTICO_DEPTH_WU,
      columnTopY,
      ridgeY: columnTopY + PORTICO_ENTABLATURE_H_WU + PORTICO_PEDIMENT_H_WU,
    },
    lawnSouth: {
      id: 'osgoode-lawn-s',
      x: { min: lawnWestEdge, max: lawnEastEdge },
      z: { min: lawnNorthOfPortico, max: lawnSouthEdge },
    },
    lawnWest: {
      id: 'osgoode-lawn-w',
      x: { min: lawnWestEdge, max: box.cx - box.hx },
      z: { min: box.cz - box.hz, max: lawnNorthOfPortico },
    },
    lawnY: GROUND_STACK.parkGround,
    gate: { min: box.cx - FENCE.gateWidthWu / 2, max: box.cx + FENCE.gateWidthWu / 2 },
  };
}

// --- local mesh helpers (bespokeMesh.ts is shared and owned elsewhere; these stay private) --------

/** An axis-aligned rectangular frustum (hip taper) with an optional rendered top cap. */
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

// --- the building ---------------------------------------------------------------------------------

function appendRoof(acc: Accum, L: OsgoodeLayout): void {
  addTaperedBox(
    acc,
    L.roofBaseY,
    L.roofRidgeY,
    L.box.cx,
    L.box.cz,
    L.box.hx + ROOF_EAVE_PROUD_WU,
    L.box.hz + ROOF_EAVE_PROUD_WU,
    L.roofRidgeHalfX,
    L.roofRidgeHalfZ,
    ROOF_SLATE,
    ROOF_SLATE_LIGHT,
  );
}

function appendCupola(acc: Accum, L: OsgoodeLayout): void {
  // Pedestal — a square base plugged into the ridge (its bottom sits below the ridge cap, so the
  // two solids interlock instead of meeting on a shared plane).
  addBox(
    acc,
    L.box.cx,
    (L.roofRidgeY + L.cupolaPedestalTopY) / 2,
    L.box.cz,
    CUPOLA_PEDESTAL_HALF_WU,
    (L.cupolaPedestalTopY - L.roofRidgeY) / 2,
    CUPOLA_PEDESTAL_HALF_WU,
    LIMESTONE_LIGHT,
    { py: false },
  );
  // Octagonal lantern drum + the dome above it. No top cap on the drum (the dome sits on it).
  addPrismY(
    acc,
    CUPOLA_SIDES,
    L.cupolaPedestalTopY,
    L.cupolaDrumTopY,
    L.box.cx,
    L.box.cz,
    CUPOLA_DRUM_RADIUS_WU,
    CUPOLA_DRUM_RADIUS_WU,
    LIMESTONE,
  );
  addPrismY(
    acc,
    CUPOLA_SIDES,
    L.cupolaDrumTopY,
    L.cupolaTopY,
    L.box.cx,
    L.box.cz,
    CUPOLA_DRUM_RADIUS_WU,
    CUPOLA_DOME_RADIUS_WU,
    ROOF_SLATE_LIGHT,
    { capTop: true },
  );
}

function appendPortico(acc: Accum, L: OsgoodeLayout): void {
  const p = L.portico;
  const halfX = (p.x.max - p.x.min) / 2;
  const cx = (p.x.min + p.x.max) / 2;
  const depthHalf = PORTICO_DEPTH_WU / 2;
  const columnCz = L.zSouth + depthHalf;
  // Columns: square posts standing off the facade, evenly spaced across the porch.
  const pitch = (2 * halfX - 2 * PORTICO_COLUMN_HALF_WU) / (PORTICO_COLUMN_COUNT - 1);
  for (let i = 0; i < PORTICO_COLUMN_COUNT; i++) {
    const px = p.x.min + PORTICO_COLUMN_HALF_WU + i * pitch;
    addBox(acc, px, p.columnTopY / 2, columnCz, PORTICO_COLUMN_HALF_WU, p.columnTopY / 2, PORTICO_COLUMN_HALF_WU, LIMESTONE_LIGHT, {
      py: false,
    });
  }
  // Entablature — one band across the columns, plugged into the body so no face of it lands on the
  // facade plane; its buried north face is not built.
  const entTopY = p.columnTopY + PORTICO_ENTABLATURE_H_WU;
  const zBack = L.zSouth - PORTICO_PLUG_WU;
  const entHalfZ = (p.zFace - zBack) / 2;
  addBox(acc, cx, (p.columnTopY + entTopY) / 2, zBack + entHalfZ, halfX, PORTICO_ENTABLATURE_H_WU / 2, entHalfZ, LIMESTONE_LIGHT, {
    nz: false,
    py: false,
  });
  // Pediment — a gable over the entablature, with its BACK rendered (the P46 open-shell lesson: at
  // 58° of pitch the camera looks down into anything left open).
  const ridge: readonly Vec3[] = [
    [cx, p.ridgeY, zBack],
    [cx, p.ridgeY, p.zFace],
  ];
  const base: readonly Vec3[] = [
    [cx - halfX, entTopY, zBack],
    [cx + halfX, entTopY, zBack],
    [cx + halfX, entTopY, p.zFace],
    [cx - halfX, entTopY, p.zFace],
  ];
  addTriFacing(acc, base[3], base[2], ridge[1], [0, 0, 1], LIMESTONE_LIGHT); // the pediment face (south)
  addTriFacing(acc, base[0], base[1], ridge[0], [0, 0, -1], LIMESTONE_LIGHT); // its rendered back
  addFace(acc, [base[1], base[2], ridge[1], ridge[0]], [1, 0, 0], ROOF_SLATE); // east slope
  addFace(acc, [base[3], base[0], ridge[0], ridge[1]], [-1, 0, 0], ROOF_SLATE); // west slope
}

// --- the grounds: lawn + the 1867 fence ---------------------------------------------------------------

function appendLawn(acc: Accum, L: OsgoodeLayout): void {
  for (const rect of [L.lawnSouth, L.lawnWest]) {
    addFace(
      acc,
      [
        [rect.x.min, L.lawnY, rect.z.min],
        [rect.x.min, L.lawnY, rect.z.max],
        [rect.x.max, L.lawnY, rect.z.max],
        [rect.x.max, L.lawnY, rect.z.min],
      ],
      [0, 1, 0],
      LAWN_GRASS,
    );
  }
}

/** Post positions along a run, ends included, at ~FENCE.postPitchWu spacing (derived from the run's
 * own length — never a hand-typed count, so a data change re-spaces the fence instead of stranding
 * it). */
function postsAlong(run: Span): number[] {
  const length = run.max - run.min;
  const bays = Math.max(1, Math.round(length / FENCE.postPitchWu));
  const out: number[] = [];
  for (let i = 0; i <= bays; i++) out.push(run.min + (i * length) / bays);
  return out;
}

/** One straight fence run: two rails plus its posts. `axis` is the direction the run travels. */
function appendFenceRun(acc: Accum, run: Span, axis: 'x' | 'z', crossCoord: number, postTop: number): void {
  const cx = (run.min + run.max) / 2;
  const halfAlong = (run.max - run.min) / 2;
  for (const frac of [FENCE.lowRailFrac, FENCE.highRailFrac]) {
    const railCy = frac * postTop;
    if (axis === 'x') {
      addBox(acc, cx, railCy, crossCoord, halfAlong, FENCE.railHalfHeightWu, FENCE.railHalfThickWu, FENCE_IRON);
    } else {
      addBox(acc, crossCoord, railCy, cx, FENCE.railHalfThickWu, FENCE.railHalfHeightWu, halfAlong, FENCE_IRON);
    }
  }
  for (const along of postsAlong(run)) {
    if (axis === 'x') addBox(acc, along, postTop / 2, crossCoord, FENCE.postHalfWu, postTop / 2, FENCE.postHalfWu, FENCE_IRON);
    else addBox(acc, crossCoord, postTop / 2, along, FENCE.postHalfWu, postTop / 2, FENCE.postHalfWu, FENCE_IRON);
  }
}

function appendFence(acc: Accum, L: OsgoodeLayout): void {
  // South (Queen) edge: two runs either side of the gate opening.
  const south = L.lawnSouth;
  for (const run of [
    { min: south.x.min, max: L.gate.min },
    { min: L.gate.max, max: south.x.max },
  ]) {
    appendFenceRun(acc, run, 'x', south.z.max, FENCE.postTopWu);
  }
  // West (University) edge: one run up the whole west side of the L-shaped lawn.
  appendFenceRun(acc, { min: L.lawnWest.z.min, max: south.z.max }, 'z', south.x.min, FENCE.postTopWu);
}

// --- the render plan -------------------------------------------------------------------------------

function buildOsgoodeGeometry(L: OsgoodeLayout): NamedBespokeGeometry {
  const acc = createAccum();
  appendRoof(acc, L);
  appendCupola(acc, L);
  appendPortico(acc, L);
  const building = triangleCount(acc);
  appendLawn(acc, L);
  appendFence(acc, L);
  const total = triangleCount(acc);
  return {
    geometry: toGeometry(acc, false),
    triangles: total,
    parts: [
      { id: 'osgoode-hall', triangles: building },
      { id: 'osgoode-grounds', triangles: total - building },
    ],
  };
}

function osgoodeExtraClaims(L: OsgoodeLayout): readonly NamedExtraClaim[] {
  // The lawn rects, claimed as blocking `decor` (Union's moat precedent): no seeded tree, bench,
  // bin or bus shelter may ever stand on the grounds. `decor` — not `namedBuilding` — because the
  // lawn is a colliderless SURFACE: the camera clip index must not treat it as a solid.
  return [L.lawnSouth, L.lawnWest].map((rect) => ({
    id: rect.id,
    kind: 'decor' as const,
    aabb: { minX: rect.x.min, maxX: rect.x.max, minZ: rect.z.min, maxZ: rect.z.max },
    // Tall enough to describe the grass plane itself (one ladder separation above its own rung —
    // derived, never a hand-picked epsilon); the fence standing on it is visual-only and
    // deliberately NOT claimed as a volume (nothing may be placed on the lawn anyway).
    yRange: [0, L.lawnY + MIN_GROUND_SEP_WU] as readonly [number, number],
  }));
}

/** The seam entry point (registered in namedGeometry.ts's `namedGeometryBuilders`). */
export function buildOsgoodeHallBespoke(placement: NamedPlacement, ctx: NamedGeometryCtx): NamedBespoke {
  const L = osgoodeLayout(placement, ctx);
  return {
    id: placement.id,
    // FULL data height, unlike the Royal York / Old City Hall pattern — see this file's header.
    renderBoxes: [L.box],
    renderGroup: CIVIC_HEART_RENDER_GROUP,
    // No atlas wordmark: a Georgian courthouse carries no signage, and namedGeometry.test.ts's
    // camera-visible-wordmark law binds only where signQuads exist.
    signQuads: [],
    extraClaims: osgoodeExtraClaims(L),
    // No extra collider. The DATA box's own collider is the building; the lawn is grass and the
    // fence is visual-only (P37's curb-hop law — see this file's header).
    extraColliders: [],
    meta: {
      topY: L.cupolaTopY,
      probes: {
        dataHeight: L.height,
        crownRiseWu: CROWN_RISE_WU,
        roofBaseY: L.roofBaseY,
        roofRidgeY: L.roofRidgeY,
        roofRidgeHalfX: L.roofRidgeHalfX,
        roofRidgeHalfZ: L.roofRidgeHalfZ,
        cupolaPedestalTopY: L.cupolaPedestalTopY,
        cupolaDrumTopY: L.cupolaDrumTopY,
        cupolaTopY: L.cupolaTopY,
        cupolaSides: CUPOLA_SIDES,
        porticoColumnCount: PORTICO_COLUMN_COUNT,
        porticoDepthWu: PORTICO_DEPTH_WU,
        porticoColumnThicknessWu: 2 * PORTICO_COLUMN_HALF_WU,
        porticoMinX: L.portico.x.min,
        porticoMaxX: L.portico.x.max,
        porticoFaceZ: L.portico.zFace,
        porticoColumnTopY: L.portico.columnTopY,
        porticoRidgeY: L.portico.ridgeY,
        lawnY: L.lawnY,
        lawnSMinX: L.lawnSouth.x.min,
        lawnSMaxX: L.lawnSouth.x.max,
        lawnSMinZ: L.lawnSouth.z.min,
        lawnSMaxZ: L.lawnSouth.z.max,
        lawnWMinX: L.lawnWest.x.min,
        lawnWMaxX: L.lawnWest.x.max,
        lawnWMinZ: L.lawnWest.z.min,
        lawnWMaxZ: L.lawnWest.z.max,
        fencePostCount: postsAlong({ min: L.lawnSouth.x.min, max: L.gate.min }).length
          + postsAlong({ min: L.gate.max, max: L.lawnSouth.x.max }).length
          + postsAlong({ min: L.lawnWest.z.min, max: L.lawnSouth.z.max }).length,
        fenceGateMinX: L.gate.min,
        fenceGateMaxX: L.gate.max,
        fencePostTopY: FENCE.postTopWu,
        fenceMinMemberWu: Math.min(2 * FENCE.postHalfWu, 2 * FENCE.railHalfThickWu, 2 * FENCE.railHalfHeightWu),
      },
    },
    buildGeometry: () => buildOsgoodeGeometry(L),
  };
}
