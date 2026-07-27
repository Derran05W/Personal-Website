// Phase 46 T2 (Part 11) — FAIRMONT ROYAL YORK v2, the second tenant of the `namedGeometryBuilders`
// seam (namedGeometry.ts's header explains the seam itself; unionStation.ts is this file's
// template and its comment style is followed deliberately).
//
// v1 was one extruded box: a 39×39 wu limestone slab with a flat roof. The Royal York's identity
// is its silhouette — a Châteauesque hotel is a steeply-pitched, oxidized-copper roof with rows
// of dormer windows and a rooftop sign, sitting on a plain limestone body — and a flat-topped box
// throws all of that away. This module rebuilds only the roof: the body stays on the existing §4
// facade-texture path (lit windows), and the ROOF is what turns into bespoke geometry.
//
// building-specs.json's R46 researcher notes (id `fairmont-royal-york`) verify: creamy-beige
// Indiana limestone body, a steeply pitched COPPER roof with oxidized green patina, ornate dormer
// windows on the roof slopes, and a red neon rooftop sign reading "ROYAL YORK" (verified
// night-time visibility — the same researcher round that filled namedSignage.ts's
// 'royal-york-neon' cell). EXPLICITLY UNVERIFIED (the researcher's own caveat, "stated, not
// invented" — Phase 44's beacon-cadence precedent): the exact number of roof setback tiers and
// the precise weathered-copper hex. This file picks a plausible three-tier massing and an
// approximate oxidized-copper-green palette family, both called out below where they are chosen.
//
// SINGLE SOURCE OF TRUTH: every dimension is a proportion of the placement's own DATA box (its
// footprint half-extents and its §3c/NAMED_HEIGHT_SCALE height). There is not one literal world
// coordinate in this file — only proportion literals, each carrying the reason it has the value
// it has (unionStation.ts's discipline, verbatim).
//
// NO STREET/STRIP CONTEXT NEEDED: unlike Union Station (whose moat and GO shed reach into Front
// Street and the rail-lands strip), the roof is entirely self-contained inside the DATA
// footprint — so this builder's exported function takes only `placement`. TypeScript's own
// structural typing accepts a function with fewer parameters wherever `NamedGeometryBuilder`
// (`(placement, ctx) => NamedBespoke`) is expected, so the seam's call site in namedGeometry.ts
// needs no special-casing.

import { WALL_STACK } from '../../config/layering';
import { lookForMaterial } from '../../config/torontoMaterials';
import { addBox, addFace, addTriFacing, createAccum, toGeometry, triangleCount, type Accum, type Vec3 } from './bespokeMesh';
import type { NamedBox, NamedPlacement } from './namedBuildings';
import type { NamedBespoke, NamedBespokeGeometry, NamedSignQuad } from './namedGeometry';
import { namedSignCellAspect } from './namedSignage';

// --- tri budget (Part 11 rule 2: stated per model, pinned in the phase that introduces them) -----

/** The whole bespoke roof: cornice + 3 tiers + both dormer rows. Pinned by royalYork.test.ts, with
 * a FLOOR as well as a ceiling — unionStation.test.ts's idiom: a regression that quietly reverted
 * this to the old flat-topped box would still pass a ceiling-only budget. */
export const ROYAL_YORK_MAX_TRIS = 600 as const;

// --- proportions (the only literals; each one carries its reason) --------------------------------

/** Body (render-box) height as a fraction of the DATA height — the brief's split point. Below it
 * is the existing §4 facade-texture path (lit windows); above it is this module's roof. */
const BODY_HEIGHT_FRAC = 0.72;

/** Eave cornice: a proud limestone lip at the wall-to-roof seam, absolute-literal (a cornice
 * reads at a physical thickness, not a proportion of a 28-storey building) — the same "give the
 * transition a defined edge" reasoning as Union's plinth/cornice pair. Both stay far inside
 * namedBuildings.ts's 3 wu massing-exclusion margin, so no claim or collider change is owed
 * (Union's cornice makes the identical call, same margin, smaller proud amount). */
const EAVE_CORNICE_H_WU = 0.5;
const EAVE_CORNICE_PROUD_WU = 0.4;

/**
 * The three setback tiers, as fractions of the roof volume ABOVE the eave cornice (sum to 1 —
 * `royalYork.test.ts` asserts the relationship rather than trusting this comment). Exact tier
 * count is UNVERIFIED (building-specs.json's notes flag it); three is the plausible reading of a
 * large Châteauesque roof: a lower mansard apron carrying the dormer band, a vertical limestone
 * "attic storey" drum wide enough to carry the rooftop sign, and an upper hip rising to the
 * ridge. TIER2_FRAC is the largest of the three because the sign band (see SIGN_WIDTH_FRAC
 * below) has to fit inside it with real margin.
 */
const TIER1_FRAC = 0.3; // lower mansard apron (carries the dormer band at its eave)
const TIER2_FRAC = 0.4; // vertical limestone drum (carries the rooftop sign)
const TIER3_FRAC = 0.3; // upper hip rising to an E-W RIDGE — ALWAYS terminates at the data height
// by construction (see royalYorkLayout), never by this fraction, so no fraction-sum float error
// can leave the ridge short of (or past) the pinned meta.topY.

/**
 * Footprint taper at the top of tier 1, as a fraction of the full half-extent (the plan-view is
 * square — namedBuildings.ts's 'square' shape — so X and Z taper equally). A NOTE ON "STEEP": a
 * true chateau pitch is geometrically impossible here — the data box is 39 wu across with only
 * ~5.7 wu of roof budget, so ANY taper that sheds real footprint is shallow in section (the same
 * "the numbers forbid it" class as the P19/P23/P24 camera-wall verdicts). What makes the roof READ
 * from the rig's high pitch is composition, not slope: a tight apron, a dormer band hugging the
 * eave, and a ridge-line summit whose facet shading says "roof" (the city-pack kit buildings prove
 * shallow hips read fine — their ridges do the work). First-cut 0.66 measured as a flat green deck
 * on the evidence frames; 0.84 keeps the apron tight and visibly sloped instead.
 */
const TIER1_TOP_FOOT_FRAC = 0.84;
/**
 * Tier 3 is a compact HIP PAVILION on a setback, not a full-footprint lid. Measured on the
 * evidence frames twice: at full drum footprint the summit's ~6° facets shade identically to a
 * horizontal plate (bespokeMesh's directional bake can't tell them apart at that tilt), so the
 * whole top read as one flat green table no matter where the ridge sat. Shrinking the pavilion in
 * PLAN is what the camera's high pitch actually responds to: a beige deck ring (tier 2's now-
 * rendered top) with a small centred green hip on it reads as an architected summit. The ridge is
 * a thin E-W strip (long axis = Front Street's, matching the real hotel); both ridge extents stay
 * non-zero so no quad half-collapses. */
const TIER3_PAVILION_FOOT_FRAC = 0.45; // pavilion base, as a fraction of the data half-extent
const TIER3_RIDGE_X_FRAC = 0.2;
const TIER3_RIDGE_Z_FRAC = 0.045;

/** Dormer row: base + total height, as fractions of TIER 1's OWN height — this keeps the whole
 * dormer (body + pyramid cap) inside tier 1's Y-span by construction (T0 + BODY + CAP ≤ 1, always
 * true regardless of the absolute tier-1 height), so a dormer can never float past the mansard
 * line into tier 2's footprint. T0 hugs the EAVE: the first cut's mid-slope row (0.4) read as
 * HVAC clutter scattered on a deck from the rig's high pitch — a perimeter band at the eave line
 * is what says "dormered mansard" in plan view, which is the view the camera actually has. */
const DORMER_ROW_T0 = 0.06;
const DORMER_BODY_FRAC = 0.24;
const DORMER_CAP_FRAC = 0.16;

/** Dormer half-width / proud depth (wu). Absolute, deliberately up-scaled for legibility past
 * THIN_GEOMETRY.minStripeWidthWu — the same call unionStation.ts's COLUMN_RADIUS_WU makes: a
 * to-scale hotel dormer (~1 m across) would be well under the thin-geometry floor and invisible
 * at any real distance. royalYork.test.ts asserts the clearance rather than trusting this note. */
const DORMER_HALF_W_WU = 0.55;
const DORMER_PROUD_WU = 0.5;
/** Clearance (wu) a dormer row leaves at each end of the face it rides, so the corner-most dormer
 * never sits on the hip corner where two roof slopes meet. */
const DORMER_MARGIN_WU = 1.5;

/** Row counts. UNVERIFIED exact count (building-specs.json flags it, same caveat as the tier
 * count) — six on the long south (true Front-facing) elevation, four on the shorter east return:
 * an aesthetic choice, not a researched one, echoing Union's own north/east column asymmetry one
 * lot away. */
const DORMER_COUNT_SOUTH = 6;
const DORMER_COUNT_EAST = 4;

/** Rooftop neon sign width, as a fraction of the tier-2 face it rides. Chosen (with TIER2_FRAC
 * above) so the derived sign height leaves real vertical margin inside the tier-2 band on both
 * camera-visible faces — asserted in royalYork.test.ts, not just eyeballed (at 0.4 the margin
 * assert passed by a hairline; 0.38 keeps it comfortably clear at a still-legible ~12.5 wu). */
const SIGN_WIDTH_FRAC = 0.38;

// --- palette (unlit-literal; §4's limestone look is the single source for the body colour) -------

const LIMESTONE = lookForMaterial('limestone').fill; // matches the render-box facade exactly
const LIMESTONE_LIGHT = '#cdb787'; // dormer cheeks + eave cornice — proud elements read lighter
/**
 * Oxidized copper-green patina. APPROXIMATE, not researched: building-specs.json's R46 notes flag
 * the exact weathered-copper hex as unverified. This is a plausible mid-tone from the real
 * blue-green verdigris family — the same "stated not invented, pick a plausible value and note
 * it" call the brief asks for.
 */
const COPPER_PATINA = '#4c7d63'; // tier-1 apron, dormer caps, the pavilion's ridge cap
const COPPER_PATINA_DARK = '#33564a'; // pavilion slopes + dormer-cap shade — same family, reads as shade

// --- layout -----------------------------------------------------------------------------------

interface RoyalYorkLayout {
  readonly box: NamedBox;
  readonly height: number;
  readonly bodyTopY: number;
  readonly roofBaseY: number;
  readonly tier1TopY: number;
  readonly tier2TopY: number;
  readonly tier1TopHalfX: number;
  readonly tier1TopHalfZ: number;
  readonly tier3BaseHalfX: number;
  readonly tier3BaseHalfZ: number;
  readonly tier3TopHalfX: number;
  readonly tier3TopHalfZ: number;
  readonly dormerRowY0: number;
  readonly dormerRowY1: number;
  /** Outward Z / X of the tier-1 slope surface at the dormer row's BASE (south / east). */
  readonly southRowZ: number;
  readonly eastRowX: number;
  /** Half-extent of the face AT the dormer row's height, along the axis dormers are spaced on
   * (south → X, east → Z) — used for pitch, so the row never overhangs the slope at that height. */
  readonly southRowHalfX: number;
  readonly eastRowHalfZ: number;
  readonly signY: number;
  readonly signHeightBudget: number;
}

/** Linear taper of a footprint half-extent from `full` (t=0, the tier's base) to `full ×
 * topFrac` (t=1, the tier's top) — the ONE rule every tier-1-relative height/footprint reads
 * through, so the dormer row and the tier-1 massing can never independently drift apart. */
function taperedHalf(full: number, topFrac: number, t: number): number {
  return full * (1 + t * (topFrac - 1));
}

function royalYorkLayout(placement: NamedPlacement): RoyalYorkLayout {
  const box = placement.boxes[0];
  if (box === undefined) throw new Error('royalYork: placement has no data box');
  // Guarded, not just commented: if a future edit changes one tier fraction without the others,
  // this throws instead of silently opening a gap (or an overlap) between tier 2 and the ridge.
  if (Math.abs(TIER1_FRAC + TIER2_FRAC + TIER3_FRAC - 1) > 1e-9) {
    throw new Error('royalYork: TIER1_FRAC + TIER2_FRAC + TIER3_FRAC must sum to 1');
  }
  const height = box.hy * 2;
  const bodyTopY = BODY_HEIGHT_FRAC * height;
  const roofBaseY = bodyTopY + EAVE_CORNICE_H_WU;
  const roofBudget = height - roofBaseY; // spent by the 3 tiers (TIER1_FRAC + TIER2_FRAC + TIER3_FRAC)
  const tier1H = TIER1_FRAC * roofBudget;
  const tier2H = TIER2_FRAC * roofBudget;
  const tier1TopY = roofBaseY + tier1H;
  const tier2TopY = tier1TopY + tier2H;

  const tier1TopHalfX = box.hx * TIER1_TOP_FOOT_FRAC;
  const tier1TopHalfZ = box.hz * TIER1_TOP_FOOT_FRAC;
  const tier3BaseHalfX = box.hx * TIER3_PAVILION_FOOT_FRAC;
  const tier3BaseHalfZ = box.hz * TIER3_PAVILION_FOOT_FRAC;
  const tier3TopHalfX = box.hx * TIER3_RIDGE_X_FRAC;
  const tier3TopHalfZ = box.hz * TIER3_RIDGE_Z_FRAC;

  const dormerRowY0 = roofBaseY + DORMER_ROW_T0 * tier1H;
  const dormerRowY1 = dormerRowY0 + (DORMER_BODY_FRAC + DORMER_CAP_FRAC) * tier1H;

  return {
    box,
    height,
    bodyTopY,
    roofBaseY,
    tier1TopY,
    tier2TopY,
    tier1TopHalfX,
    tier1TopHalfZ,
    tier3BaseHalfX,
    tier3BaseHalfZ,
    tier3TopHalfX,
    tier3TopHalfZ,
    dormerRowY0,
    dormerRowY1,
    southRowZ: box.cz + taperedHalf(box.hz, TIER1_TOP_FOOT_FRAC, DORMER_ROW_T0),
    eastRowX: box.cx + taperedHalf(box.hx, TIER1_TOP_FOOT_FRAC, DORMER_ROW_T0),
    southRowHalfX: taperedHalf(box.hx, TIER1_TOP_FOOT_FRAC, DORMER_ROW_T0),
    eastRowHalfZ: taperedHalf(box.hz, TIER1_TOP_FOOT_FRAC, DORMER_ROW_T0),
    signY: (tier1TopY + tier2TopY) / 2,
    signHeightBudget: tier2TopY - tier1TopY,
  };
}

// --- the roof -----------------------------------------------------------------------------------

/** An axis-aligned tapered box (a rectangular frustum) from `(hx0, hz0)` at `y0` to `(hx1, hz1)`
 * at `y1`, centred on `(cx, cz)` throughout — a hip-roof taper. `topCap` renders the flat top
 * quad (skip it when the next tier's base exactly matches, so the two solids share an
 * unrendered, fully-enclosed seam — unionStation.ts's wing/attic joint, same reasoning). */
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
  /** Colour for the top cap, or `null` for no cap (when the next tier's base exactly matches).
   * Passed EXPLICITLY darker/lighter than the sides where the facet read matters: this roof's
   * slopes sit at 6–19° from horizontal, where bespokeMesh's directional bake shades them within
   * a percent of a flat plate — the two-tone is the low-poly-kit trick that keeps a ridge legible
   * when the geometry's own tilt can't (measured flat-reading on this phase's evidence frames). */
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
  addFace(acc, [lo.nn, lo.pn, hi.pn, hi.nn], [0, 0, -1], hex); // north
  addFace(acc, [lo.pn, lo.pp, hi.pp, hi.pn], [1, 0, 0], hex); // east
  addFace(acc, [lo.pp, lo.np, hi.np, hi.pp], [0, 0, 1], hex); // south
  addFace(acc, [lo.np, lo.nn, hi.nn, hi.np], [-1, 0, 0], hex); // west
  if (capHex !== null) addFace(acc, [hi.nn, hi.pn, hi.pp, hi.np], [0, 1, 0], capHex);
}

/** A 4-sided hip/pyramid cap over a rectangular base — exactly 4 triangles (never the 8-triangle,
 * half-degenerate quad an apex-collapsed addPrismY call would pay for). */
function addHipCap(acc: Accum, cx: number, cz: number, hx: number, hz: number, y0: number, apexY: number, hex: string): void {
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
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    addTriFacing(acc, corners[i], corners[j], apex, outward[i], hex);
  }
}

/** One dormer: a small limestone box proud of the tier-1 slope, capped by a copper hip roof.
 * `cx`/`cz` is the slope surface's own position at the row's base; the box extends outward by
 * `DORMER_PROUD_WU`. The BACK face is RENDERED, unlike Union's buried column backs: the tier-1
 * slope recedes inward faster over the dormer's own height than the dormer is deep (the taper
 * sheds ~a third of a 19.5 wu half-extent across tier 1), so above the row base the back plane
 * stands clear of the slope surface — an unrendered back there is an open shell the rig's 58°
 * pitch can look straight into (the P42/P43 see-through class). +2 triangles per dormer closes it. */
function addDormer(acc: Accum, axis: 'south' | 'east', cx: number, cz: number, y0: number, y1: number): void {
  const bodyTopFrac = DORMER_BODY_FRAC / (DORMER_BODY_FRAC + DORMER_CAP_FRAC);
  const bodyTopY = y0 + (y1 - y0) * bodyTopFrac;
  const hw = DORMER_HALF_W_WU;
  const proudHalf = DORMER_PROUD_WU / 2;
  if (axis === 'south') {
    const bodyZ = cz + proudHalf;
    addBox(acc, cx, (y0 + bodyTopY) / 2, bodyZ, hw, (bodyTopY - y0) / 2, proudHalf, LIMESTONE_LIGHT, { py: false });
    addHipCap(acc, cx, bodyZ, hw, proudHalf, bodyTopY, y1, COPPER_PATINA_DARK);
  } else {
    const bodyX = cx + proudHalf;
    addBox(acc, bodyX, (y0 + bodyTopY) / 2, cz, proudHalf, (bodyTopY - y0) / 2, hw, LIMESTONE_LIGHT, { py: false });
    addHipCap(acc, bodyX, cz, proudHalf, hw, bodyTopY, y1, COPPER_PATINA_DARK);
  }
}

function appendDormerRow(acc: Accum, L: RoyalYorkLayout, axis: 'south' | 'east'): void {
  const count = axis === 'south' ? DORMER_COUNT_SOUTH : DORMER_COUNT_EAST;
  const halfWidth = axis === 'south' ? L.southRowHalfX : L.eastRowHalfZ;
  const span = 2 * halfWidth - 2 * DORMER_MARGIN_WU;
  const pitch = span / count;
  const along0 = (axis === 'south' ? L.box.cx : L.box.cz) - span / 2;
  for (let i = 0; i < count; i++) {
    const along = along0 + (i + 0.5) * pitch;
    if (axis === 'south') addDormer(acc, 'south', along, L.southRowZ, L.dormerRowY0, L.dormerRowY1);
    else addDormer(acc, 'east', L.eastRowX, along, L.dormerRowY0, L.dormerRowY1);
  }
}

/** The eave cornice: a proud limestone lip sitting exactly between the render box's top and the
 * roof's own base, so nothing is exposed in between (see EAVE_CORNICE_H_WU's note). */
function appendEaveCornice(acc: Accum, L: RoyalYorkLayout): void {
  const { box, bodyTopY, roofBaseY } = L;
  const cy = (bodyTopY + roofBaseY) / 2;
  addBox(acc, box.cx, cy, box.cz, box.hx + EAVE_CORNICE_PROUD_WU, (roofBaseY - bodyTopY) / 2, box.hz + EAVE_CORNICE_PROUD_WU, LIMESTONE_LIGHT);
}

function appendRoof(acc: Accum, L: RoyalYorkLayout): void {
  appendEaveCornice(acc, L);
  // Tier 1 — the steep mansard slope, full footprint at its base (flush with the cornice/body
  // below) tapering to TIER1_TOP_FOOT_FRAC. No top cap: tier 2 sits exactly on this footprint, so
  // the seam is fully enclosed and unrendered on both sides (unionStation.ts's wing/attic joint).
  addTaperedBox(acc, L.roofBaseY, L.tier1TopY, L.box.cx, L.box.cz, L.box.hx, L.box.hz, L.tier1TopHalfX, L.tier1TopHalfZ, COPPER_PATINA, null);
  appendDormerRow(acc, L, 'south');
  appendDormerRow(acc, L, 'east');
  // Tier 2 — the vertical limestone drum (the rooftop sign rides its south/east walls). Its top
  // IS rendered: the pavilion above it is a setback, so the exposed ring of drum top is a real,
  // visible deck (see TIER3_PAVILION_FOOT_FRAC's note — the deck ring is half of the summit fix).
  addBox(
    acc,
    L.box.cx,
    (L.tier1TopY + L.tier2TopY) / 2,
    L.box.cz,
    L.tier1TopHalfX,
    (L.tier2TopY - L.tier1TopY) / 2,
    L.tier1TopHalfZ,
    LIMESTONE,
  );
  // Tier 3 — the compact hip pavilion, from its setback base on the drum deck to the thin E-W
  // ridge strip. IT DOES get a top cap: nothing sits above it, so the ridge face is the real,
  // visible summit — and it ends at L.height EXACTLY (not a fraction sum), which is what makes
  // meta.topY exact.
  addTaperedBox(acc, L.tier2TopY, L.height, L.box.cx, L.box.cz, L.tier3BaseHalfX, L.tier3BaseHalfZ, L.tier3TopHalfX, L.tier3TopHalfZ, COPPER_PATINA_DARK, COPPER_PATINA);
}

function buildRoyalYorkGeometry(L: RoyalYorkLayout): NamedBespokeGeometry {
  const acc = createAccum();
  appendRoof(acc, L);
  const total = triangleCount(acc);
  return {
    geometry: toGeometry(acc, false),
    triangles: total,
    parts: [{ id: 'royal-york-roof', triangles: total }],
  };
}

// --- the render plan -----------------------------------------------------------------------------

function royalYorkRenderBoxes(L: RoyalYorkLayout): readonly NamedBox[] {
  return [{ ...L.box, hy: L.bodyTopY / 2 }];
}

function royalYorkSignQuads(L: RoyalYorkLayout): readonly NamedSignQuad[] {
  const aspect = namedSignCellAspect('royal-york-neon');
  const proud = WALL_STACK.fasciaBand;
  const southWidth = SIGN_WIDTH_FRAC * (2 * L.tier1TopHalfX);
  const eastWidth = SIGN_WIDTH_FRAC * (2 * L.tier1TopHalfZ);
  return [
    // The real sign is rooftop, on the vertical drum tier — proud of both camera-visible faces
    // (Phase 34's pinned south/east pair), sized + vertically centred so it stays inside tier 2
    // with real margin (asserted in royalYork.test.ts, not just eyeballed — see SIGN_WIDTH_FRAC).
    {
      id: 'royal-york-neon-south',
      cell: 'royal-york-neon',
      face: 'south',
      position: [L.box.cx, L.signY, L.box.cz + L.tier1TopHalfZ + proud],
      widthWu: southWidth,
      heightWu: southWidth * aspect,
    },
    {
      id: 'royal-york-neon-east',
      cell: 'royal-york-neon',
      face: 'east',
      position: [L.box.cx + L.tier1TopHalfX + proud, L.signY, L.box.cz],
      widthWu: eastWidth,
      heightWu: eastWidth * aspect,
    },
  ];
}

/** The seam entry point (registered in namedGeometry.ts's `namedGeometryBuilders`). Takes only
 * `placement` — see this file's header for why no street/strip context is needed, and why that is
 * legal against the two-parameter `NamedGeometryBuilder` type. */
export function buildRoyalYorkBespoke(placement: NamedPlacement): NamedBespoke {
  const L = royalYorkLayout(placement);
  return {
    id: placement.id,
    renderBoxes: royalYorkRenderBoxes(L),
    signQuads: royalYorkSignQuads(L),
    // The roof stays entirely inside the DATA box's footprint (the eave cornice's 0.4 wu overhang
    // is far inside namedBuildings.ts's 3 wu massing-exclusion margin) and never exceeds the data
    // height, so the existing claim/collider/clip machinery — all keyed off the DATA box — already
    // covers it. No extra claim, no extra collider (unionStation.ts's cornice makes the identical
    // call for the identical reason).
    extraClaims: [],
    extraColliders: [],
    meta: {
      topY: L.height,
      probes: {
        dataHeight: L.height,
        bodyTopY: L.bodyTopY,
        roofBaseY: L.roofBaseY,
        tier1TopY: L.tier1TopY,
        tier2TopY: L.tier2TopY,
        tier1TopHalfX: L.tier1TopHalfX,
        tier1TopHalfZ: L.tier1TopHalfZ,
        tier3BaseHalfX: L.tier3BaseHalfX,
        tier3BaseHalfZ: L.tier3BaseHalfZ,
        tier3TopHalfX: L.tier3TopHalfX,
        tier3TopHalfZ: L.tier3TopHalfZ,
        dormerRowY0: L.dormerRowY0,
        dormerRowY1: L.dormerRowY1,
        dormerCountSouth: DORMER_COUNT_SOUTH,
        dormerCountEast: DORMER_COUNT_EAST,
        dormerHalfWidthWu: DORMER_HALF_W_WU,
        southRowZ: L.southRowZ,
        eastRowX: L.eastRowX,
        signY: L.signY,
        signHeightBudget: L.signHeightBudget,
      },
    },
    buildGeometry: () => buildRoyalYorkGeometry(L),
  };
}
