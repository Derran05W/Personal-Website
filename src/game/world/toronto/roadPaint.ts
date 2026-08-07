// Phase 25.6 (D2/D20 seam #1) — the merged road-paint geometry: ribbons + curbs + centre-line
// dashes (SKIPPED inside intersection boxes) + the sidewalk band along every ribbon edge +
// crosswalk zebra bands at signalized intersections. ONE vertex-coloured BufferGeometry (one draw
// call, +0 over the old ribbon mesh) — the same UNLIT-literal path the P22 roads used. This is
// D20's road-paint seam: dashes/crosswalks are emitted from ROAD_CLASSES + roadGraph's
// `listIntersections` records, keyed the way MegaKit's road-paint decal meshes would one day
// replace the quad emission.
//
// PHASE 25.8 (D5) — the sidewalk band is now a RAISED curb-height band (the "road depth" ask): a
// flat top face at SIDEWALK.curbHeightWu + a road-facing CHAMFER curb face (a darker fake-AO seam,
// THE depth cue), emitted PER BLOCK SEGMENT so the raised band stops at intersection boxes (natural
// curb cuts where the crosswalks land — a full-length raised strip would protrude across crossings).
// Optional matching GROUND colliders per segment (SIDEWALK.colliders kill-switch, drive-feel gated)
// mount from the same segment set in TorontoScene. Everything is still ONE unlit vertex-coloured
// mesh — normals are irrelevant to unlit shading, so the only correctness constraint on the raised
// faces is winding: every quad is emitted in the same A(x0,z0) B(x0,z1) C(x1,z1) D(x1,z0) order with
// x0<x1, z0<z1 (matching the proven `quad()` +Y-up winding) so its front face reads from the camera.
//
// PHASE 75 (feel overhaul) — six additions, all of them consequences of the doubled ribbon widths
// (config/torontoMap.ts's ROAD_CLASSES re-grade):
//   1. THE GRASS MEDIAN. A raised band down the middle of every median-carrying ribbon, built by
//      the SAME `emitBand` helper the raised sidewalk uses (kerb chamfer + flat top), with its own
//      style (grass top, shared kerb-face tone) and its own top HEIGHT — `ROAD_MEDIAN.curbHeightWu`,
//      a geometry height exactly like `SIDEWALK.curbHeightWu`, NOT a GROUND_STACK rung (see
//      config/layering.ts's "NOT A RUNG" note and ROAD_MEDIAN's own doc comment). The median cuts
//      out at every crossing, with a deeper setback than the sidewalk's so the zebra bands always
//      land on bare asphalt.
//   2. CENTRE-LINE DASHES ARE SUPPRESSED ON MEDIAN STREETS. The dashes are painted on the exact
//      geometric centreline — i.e. UNDER the median — and on a median street the median IS the
//      centre marker. See `emitCentreDashes` for the "does a median carriageway need a lane
//      divider at all" reasoning (it does not: one lane per direction).
//   3. THE RIBBON UNION. Two overlapping asphalt quads on the same `GROUND_STACK.roadSurface`
//      rung are exactly the coplanar z-fight Part 10 exists to prevent, and at the doubled widths
//      Bay and York (7.52 wu apart on the compacted map) overlap by 7.88 wu. Asphalt is now emitted
//      as a UNION: ribbons are ranked (wider class wins, ties by id — roadGraph.ts's own rule, so
//      the render and the traffic graph can never disagree about which street yields) and each
//      street emits only the part of its rectangle no higher-ranked ribbon already covers. Curb
//      strips, dashes and sidewalk bands are suppressed over the same covered ground. See
//      `ribbonPrecedence`.
//   4. TERMINUS INSETS. The median stops short of a street's own ends so it never lies across the
//      centreline-hub → offset-lane swing a car makes leaving a dead end (`medianTerminusInsetWu`).
//   5. (T4) THE STRIP ALGEBRA MOVED OUT, to the three-free `./roadStrips`. This file still draws
//      the median; it no longer decides where the median IS. `roadStrips.medianBandRuns` does, and
//      furniture.ts's median PLANTING reads the identical call — one derivation, so a tree can
//      never stand where the paint left bare asphalt. Everything moved is re-exported below, so
//      roadPaint's public surface (and every call site + test import) is unchanged.
//   6. THE CURB STRIPS JOINED THE UNION (2026-08-06, the Phase 75 flicker finding). They used to be
//      painted on the `roadPaint` rung, 0.006 wu above the asphalt — a full-length coplanar decal
//      whose depth margin runs out at the far end of the camera's visible ground band, so the
//      asphalt won it back at some camera positions (measured: a 40.5% swing in on-screen curb
//      pixels under a frozen-world camera ladder). They are now emitted at ROAD_Y as members of the
//      ribbon union, and the asphalt gives up the ground under them. See `curbStripPieces` for the
//      measurement, the disjointness argument and the deliberate side effect at junctions.
//
// Y-LAYERING (Phase 39): every offset below is a RUNG of config/layering.ts's GROUND_STACK, the
// one ordered ladder the whole city reads from — no hand-picked epsilons here any more (the old
// `ROAD_Y + 0.005 / + 0.007` arithmetic left the zebra only 0.002 above the curb strips). Order,
// low to high: road ribbon AND its curb strips (`roadSurface`, disjoint pieces of ONE surface —
// see 6 above) < centre dashes (`roadPaint`) < crosswalk zebra (`crosswalk`) < raised sidewalk top
// (SIDEWALK.curbHeightWu — a geometry HEIGHT, not a ladder rung, and well above all the paint) =
// raised median top (ROAD_MEDIAN.curbHeightWu, the same kerb step by construction). mapToWorld is
// the identity swap, so street map coords ARE world x/z.

import { BufferGeometry, Color, Float32BufferAttribute } from 'three';
import { CROSSWALK, ROAD_COLORS, ROAD_EDGE, ROAD_MEDIAN, SIDEWALK } from '../../config/torontoMap';
import { GROUND_STACK } from '../../config/layering';
import { crosswalkBands } from './crosswalks';
import type { Intersection } from './roadGraph';
import type { MapRect, Street } from './streets';
// PHASE 75 (T4): the interval / ribbon-union / crossing algebra and the median-band derivation now
// live in the three-free `roadStrips.ts` so the (pure-TS) median planting placer can read exactly
// the segments this file paints. Public names are re-exported below — no call site changed.
import {
  CURB_CUT_SETBACK_WU,
  MIN_SEGMENT_WU,
  coveredAlong,
  crossingBoxes,
  crossingsOn,
  freeIntervals,
  higherRibbons,
  insideAnyIntersection,
  insideAnyInterval,
  medianBandRuns,
  parallelRibbons,
  rectsOverlap,
  ribbonPrecedence,
  type Interval,
} from './roadStrips';

export {
  MAX_GRAPH_STEP_WU,
  MEDIAN_CUT_SETBACK_WU,
  medianBandRuns,
  medianTerminusInsetWu,
  ribbonPrecedence,
  type Interval,
  type MedianBandRun,
} from './roadStrips';

const ROAD_Y = GROUND_STACK.roadSurface;
const PAINT_Y = GROUND_STACK.roadPaint; // curbs + dashes
const CROSSWALK_Y = GROUND_STACK.crosswalk; // above the curbs so the zebra reads on the asphalt

// D5 raised-sidewalk geometry.
const CURB_TOP_Y = SIDEWALK.curbHeightWu; // flat top face height (0.12)
const CURB_CHAMFER_WU = 0.7; // horizontal run of the sloped road-facing curb face (reads top-down)

/**
 * PHASE 75 — how much of a median strip must read as GRASS rather than kerb chamfer. The sidewalk
 * band can spend a flat 0.7 wu on its chamfer because the band behind it is 3 wu wide; a 2.2 wu
 * median has 1.1 wu per side and two chamfers facing opposite carriageways, so the sidewalk's run
 * would leave only 0.8 of 2.2 wu as grass and the strip would read as a kerb, not a planting. The
 * chamfer is therefore the sidewalk's run CAPPED so at least this fraction of the strip stays flat
 * green (at today's one-car-wide median: min(0.7, 0.55) = 0.55 per side, 1.1 wu of grass = exactly
 * half). Derived, so a future wider median gets the full sidewalk chamfer automatically.
 */
const MEDIAN_GRASS_MIN_FRACTION = 0.5;

interface Sink {
  readonly positions: number[];
  readonly normals: number[];
  readonly colors: number[];
}

/** Flat +Y quad at height `y`, proven front-face-up winding (A x0z0, B x0z1, C x1z1, D x1z0). */
function quad(sink: Sink, hex: string, x0: number, z0: number, x1: number, z1: number, y: number, c: Color): void {
  const { positions, normals, colors } = sink;
  positions.push(x0, y, z0, x0, y, z1, x1, y, z1, x0, y, z0, x1, y, z1, x1, y, z0);
  for (let i = 0; i < 6; i++) normals.push(0, 1, 0);
  c.set(hex);
  for (let i = 0; i < 6; i++) colors.push(c.r, c.g, c.b);
}

/** Same winding as `quad()` but with a per-corner Y (the raised curb chamfer). Corners in the exact
 * A(x0,z0) B(x0,z1) C(x1,z1) D(x1,z0) order — pass x0<x1, z0<z1 so the front face reads up-and-out.
 * Normals are (0,1,0) placeholders (unlit mesh — only winding matters for culling). */
function quadYs(
  sink: Sink,
  hex: string,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  yA: number,
  yB: number,
  yC: number,
  yD: number,
  c: Color,
): void {
  const { positions, normals, colors } = sink;
  positions.push(x0, yA, z0, x0, yB, z1, x1, yC, z1, x0, yA, z0, x1, yC, z1, x1, yD, z0);
  for (let i = 0; i < 6; i++) normals.push(0, 1, 0);
  c.set(hex);
  for (let i = 0; i < 6; i++) colors.push(c.r, c.g, c.b);
}

// --- the ribbon union (Phase 75) --------------------------------------------------------------
// `ribbonPrecedence` (who yields) and the parallel-cover helpers live in ./roadStrips; what stays
// here is the rectangle SUBTRACTION the asphalt emitter uses to draw only the ground it won.

/** `base` minus `cut`, as up to four disjoint rectangles that exactly tile the remainder (shared
 * edge coordinates, so the pieces abut with no hairline gap). */
function subtractRect(base: MapRect, cut: MapRect): MapRect[] {
  if (!rectsOverlap(base, cut)) return [base];
  const out: MapRect[] = [];
  if (cut.minY > base.minY) out.push({ minX: base.minX, minY: base.minY, maxX: base.maxX, maxY: cut.minY });
  if (cut.maxY < base.maxY) out.push({ minX: base.minX, minY: cut.maxY, maxX: base.maxX, maxY: base.maxY });
  const midLo = Math.max(base.minY, cut.minY);
  const midHi = Math.min(base.maxY, cut.maxY);
  if (cut.minX > base.minX) out.push({ minX: base.minX, minY: midLo, maxX: cut.minX, maxY: midHi });
  if (cut.maxX < base.maxX) out.push({ minX: cut.maxX, minY: midLo, maxX: base.maxX, maxY: midHi });
  return out;
}

/** `base` minus every rect in `cuts` — the asphalt a street actually emits. */
export function subtractRects(base: MapRect, cuts: readonly MapRect[]): MapRect[] {
  let pieces: MapRect[] = [base];
  for (const cut of cuts) {
    pieces = pieces.flatMap((p) => subtractRect(p, cut));
    if (pieces.length === 0) break;
  }
  return pieces;
}

/** The free along-segments of a street's ribbon span minus the intersection boxes (each crossing ±
 * crossHalf + `setbackWu`, default CURB_CUT_SETBACK), merged. The raised sidewalk (D5) only sits
 * inside these, so the band cuts out at every crossing = a natural curb cut where the crosswalk
 * lands. Shared by the visual band and the collider boxes so the two can never drift. */
export function sidewalkSegments(
  lo: number,
  hi: number,
  crossings: readonly { along: number; crossHalf: number }[],
  setbackWu: number = CURB_CUT_SETBACK_WU,
): readonly Interval[] {
  return freeIntervals(lo, hi, crossingBoxes(crossings, setbackWu), MIN_SEGMENT_WU);
}

// --- raised bands (sidewalk + median) --------------------------------------------------------

/** Look of one raised band: its two face colours, its flat-top HEIGHT (a geometry height, never a
 * GROUND_STACK rung) and the horizontal run of its road-facing kerb chamfer. */
interface BandStyle {
  readonly faceColor: string;
  readonly topColor: string;
  readonly topY: number;
  readonly chamferWu: number;
}

const SIDEWALK_BAND: BandStyle = {
  faceColor: SIDEWALK.curbFaceColor,
  topColor: SIDEWALK.color,
  topY: CURB_TOP_Y,
  chamferWu: CURB_CHAMFER_WU,
};

/** The median's band style for a strip of `medianWidth` — same kerb step and kerb-face tone as the
 * sidewalk (one city, one kerb), grass on top, and the grass-fraction-capped chamfer. */
function medianBandStyle(medianWidth: number): BandStyle {
  const half = medianWidth / 2;
  const capped = (medianWidth * (1 - MEDIAN_GRASS_MIN_FRACTION)) / 2;
  return {
    faceColor: ROAD_MEDIAN.curbFaceColor,
    topColor: ROAD_MEDIAN.grassColor,
    topY: ROAD_MEDIAN.curbHeightWu,
    chamferWu: Math.min(CURB_CHAMFER_WU, capped, half),
  };
}

/** One raised band on one edge, for a single along-segment. `roadEdge` is the edge coord on the
 * perpendicular axis; `outSign` is which way the band extends (+1 = larger perp, −1 = smaller).
 * Emits: the road-facing CHAMFER (asphalt level → band top over `style.chamferWu`) + the flat top
 * face at `style.topY`. `axis` 'ew' means the segment runs along X (perp = Z); 'ns' means along Z
 * (perp = X). Used for BOTH the raised sidewalk (D5) and the Phase 75 median. */
function emitBand(
  sink: Sink,
  c: Color,
  axis: 'ew' | 'ns',
  aLo: number,
  aHi: number,
  roadEdge: number,
  outSign: 1 | -1,
  bandWidth: number,
  style: BandStyle,
): void {
  const chamferOuter = roadEdge + outSign * style.chamferWu;
  const topOuter = roadEdge + outSign * bandWidth;
  // Order the perp pair so z0<z1 / x0<x1 (winding contract). Chamfer: y is ROAD_Y at the roadEdge,
  // style.topY at chamferOuter; the flat top is style.topY across.
  if (axis === 'ew') {
    // perp = Z. along = X (aLo<aHi already).
    const pRoad = roadEdge;
    const pCh = chamferOuter;
    const pTop = topOuter;
    // chamfer quad between pRoad and pCh
    const [z0c, z1c, yRoadAtZ0] = pRoad < pCh ? [pRoad, pCh, true] : [pCh, pRoad, false];
    // yA/yB/yC/yD map to corners A(x0,z0) B(x0,z1) C(x1,z1) D(x1,z0); y depends on which z is roadEdge
    const yLow = ROAD_Y;
    const yHigh = style.topY;
    const yZ0 = yRoadAtZ0 ? yLow : yHigh; // y at z0
    const yZ1 = yRoadAtZ0 ? yHigh : yLow; // y at z1
    quadYs(sink, style.faceColor, aLo, z0c, aHi, z1c, yZ0, yZ1, yZ1, yZ0, c);
    // flat top from pCh to pTop
    const zt0 = Math.min(pCh, pTop);
    const zt1 = Math.max(pCh, pTop);
    quad(sink, style.topColor, aLo, zt0, aHi, zt1, style.topY, c);
  } else {
    // perp = X. along = Z (aLo<aHi already).
    const pRoad = roadEdge;
    const pCh = chamferOuter;
    const pTop = topOuter;
    const [x0c, x1c, yRoadAtX0] = pRoad < pCh ? [pRoad, pCh, true] : [pCh, pRoad, false];
    const yLow = ROAD_Y;
    const yHigh = style.topY;
    const yX0 = yRoadAtX0 ? yLow : yHigh;
    const yX1 = yRoadAtX0 ? yHigh : yLow;
    // corners A(x0,z0) B(x0,z1) C(x1,z1) D(x1,z0): y depends on X → A,B share x0; C,D share x1.
    quadYs(sink, style.faceColor, x0c, aLo, x1c, aHi, yX0, yX0, yX1, yX1, c);
    const xt0 = Math.min(pCh, pTop);
    const xt1 = Math.max(pCh, pTop);
    quad(sink, style.topColor, xt0, aLo, xt1, aHi, style.topY, c);
  }
}

/** One run of raised sidewalk: which street/side it belongs to, the ribbon edge it stands on, and
 * the along-segments it actually occupies (intersection curb cuts already removed, and — Phase 75 —
 * any stretch that a higher-ranked parallel ribbon has swallowed). */
export interface SidewalkBandRun {
  readonly street: Street;
  readonly side: 1 | -1;
  /** Ribbon edge coordinate on the perpendicular axis the band stands on. */
  readonly roadEdge: number;
  readonly segments: readonly Interval[];
}

/**
 * THE one derivation of "where does raised sidewalk exist", shared by the visual band and the
 * collider boxes.
 *
 * Phase 75: a band is dropped over any stretch where its own perpendicular footprint lies inside
 * ANY parallel ribbon — the Bay/York merge would otherwise stand York's entire west sidewalk,
 * raised 0.12 wu, in the middle of Bay's carriageway (and, with SIDEWALK.colliders ever turned on,
 * put a kerb there), and Bay's east sidewalk on the strip of York that survived the union.
 * Suppression is by overlap, not containment: a partially-covered band leaves a sidewalk gap rather
 * than a raised strip on live asphalt, because "no raised band on somebody's road" is the invariant
 * that matters.
 */
export function sidewalkBandRuns(streets: readonly Street[], intersections: readonly Intersection[]): SidewalkBandRun[] {
  const sw = SIDEWALK.widthWu;
  const runs: SidewalkBandRun[] = [];
  for (const street of streets) {
    const r = street.ribbon;
    const crossings = crossingsOn(street, intersections);
    const covers = parallelRibbons(street, streets);
    const isEw = street.axis === 'ew';
    const [lo, hi] = isEw ? [r.minX, r.maxX] : [r.minY, r.maxY];
    const edges: readonly { readonly side: 1 | -1; readonly roadEdge: number }[] = isEw
      ? [
          { side: -1, roadEdge: r.minY }, // north (extends toward -z)
          { side: 1, roadEdge: r.maxY }, // south (extends toward +z)
        ]
      : [
          { side: -1, roadEdge: r.minX }, // west
          { side: 1, roadEdge: r.maxX }, // east
        ];
    for (const { side, roadEdge } of edges) {
      const outer = roadEdge + side * sw;
      const covered = coveredAlong(street, covers, Math.min(roadEdge, outer), Math.max(roadEdge, outer));
      const segments = freeIntervals(lo, hi, [...crossingBoxes(crossings, CURB_CUT_SETBACK_WU), ...covered], MIN_SEGMENT_WU);
      if (segments.length > 0) runs.push({ street, side, roadEdge, segments });
    }
  }
  return runs;
}

// --- the painted curb strips (Phase 75 — the flicker fix) --------------------------------------

/**
 * The two painted curb strips of one street, as RECTS on the ribbon's own long edges (inside the
 * asphalt, unlike the raised sidewalk band, which stands outside it).
 */
export function curbStripRects(street: Street): readonly [MapRect, MapRect] {
  const r = street.ribbon;
  const e = ROAD_EDGE.widthWu;
  return street.axis === 'ew'
    ? [
        { minX: r.minX, minY: r.minY, maxX: r.maxX, maxY: r.minY + e },
        { minX: r.minX, minY: r.maxY - e, maxX: r.maxX, maxY: r.maxY },
      ]
    : [
        { minX: r.minX, minY: r.minY, maxX: r.minX + e, maxY: r.maxY },
        { minX: r.maxX - e, minY: r.minY, maxX: r.maxX, maxY: r.maxY },
      ];
}

/**
 * THE one derivation of "where is there curb paint" — the pieces of a street's two curb strips
 * that actually get painted, with every ribbon that outranks them (and every parallel ribbon,
 * whatever its rank) already subtracted.
 *
 * WHY THE STRIPS ARE UNION MEMBERS AND NOT DECALS (the Phase 75 flicker finding, measured
 * 2026-08-06). Until this change the strips were painted on the `roadPaint` rung, 0.006 wu ABOVE
 * the asphalt they cover — a coplanar decal over ~2,000 wu² of road, running the full length of
 * every ribbon. That separation is only ~8 depth-buffer LSBs at 31 wu and ~4 at the far end of the
 * camera's visible ground band (near 0.1 / far 1000, 24-bit depth), so WHICH SURFACE WINS was
 * decided by rasterizer rounding. Measured with a frozen-world camera-translation ladder at the
 * district-northYorkCentre vantage (31 rungs, 0.01 wu apart, `.planning/tools/p75-curb-ladder.mjs`):
 * the curb strip's on-screen pixel count swung 40.5% (19,990 → 33,593) and the asphalt's moved in
 * exact anti-phase, while every RAISED surface in the same frame held flat — sidewalk top 2.7%,
 * kerb chamfer 3.7%, median grass 0.2%. That is a winner swap, not aliasing and not parallax.
 * (Phase 75 did not create the pair — the pre-phase tree measures 7% on the same ladder — it
 * doubled the ribbon widths, which pushed the strips into the deep half of the visible band where
 * the margin is thinnest, and took the swing over the flicker sweep's escalation threshold.)
 *
 * The fix is structural rather than a bigger epsilon, because no epsilon is a proof: a painted
 * curb strip is not a mark ON the road, it IS a differently-coloured piece OF the road surface.
 * So it joins the ribbon union on `GROUND_STACK.roadSurface` and the asphalt gives up the ground
 * underneath it. The pieces are then pairwise disjoint from every other quad on that rung BY
 * CONSTRUCTION — for any pair, either one street outranks the other (and the loser's strip has the
 * winner's whole ribbon subtracted) or they are the same street (whose asphalt has these exact
 * pieces subtracted) — so the conflict cannot recur at any distance, on any GPU, at any depth
 * precision. `roadPaint.test.ts`'s existing "no two quads on the roadSurface rung overlap" law
 * covers them automatically now that they share the rung, with a positive control that re-floats
 * them onto `roadPaint` and watches it fail.
 *
 * SIDE EFFECT, deliberate: a strip now stops where a higher-ranked ribbon crosses, exactly as the
 * street's own asphalt, sidewalk band and centre dashes already do. Yonge outranks everything, so
 * the spine's curb lines are unbroken; a minor's curb line now ends at the mouth of the major it
 * crosses instead of being painted across it — which is both what a real kerb does and what the
 * raised sidewalk band beside it has always done.
 */
export function curbStripPieces(
  street: Street,
  streets: readonly Street[],
  rank: ReadonlyMap<string, number>,
): readonly MapRect[] {
  const covers = new Map<string, Street>();
  for (const o of higherRibbons(street, streets, rank)) covers.set(o.id, o);
  // Parallel ribbons cover REGARDLESS of rank — the same "a road edge marker is wrong inside a
  // road, including the winner's" rule the raised sidewalk band obeys (see `parallelRibbons`).
  for (const o of parallelRibbons(street, streets)) covers.set(o.id, o);
  const cuts = [...covers.values()].map((o) => o.ribbon);
  return curbStripRects(street).flatMap((strip) => subtractRects(strip, cuts));
}

/** One sidewalk collider box (top at CURB_TOP_Y), world XZ centre + half-extents. Mounted as a fixed
 * GROUND-group cuboid in TorontoScene behind SIDEWALK.colliders. Covers the full band width so the
 * car feels a curb bump driving road→sidewalk. */
export interface SidewalkColliderBox {
  readonly cx: number;
  readonly cz: number;
  readonly hx: number;
  readonly hz: number;
}

/** D5 curb colliders: one thin GROUND slab per raised-sidewalk segment-side (same segments as the
 * visual band). Pure — TorontoScene maps these to CuboidColliders (hy = CURB_TOP_Y/2, centreY same).
 * SIDEWALK.colliders gates whether they mount (drive-feel gate). */
export function buildSidewalkColliderBoxes(
  streets: readonly Street[],
  intersections: readonly Intersection[],
): readonly SidewalkColliderBox[] {
  const boxes: SidewalkColliderBox[] = [];
  const sw = SIDEWALK.widthWu;
  for (const run of sidewalkBandRuns(streets, intersections)) {
    const isEw = run.street.axis === 'ew';
    const bandCentre = run.roadEdge + (run.side * sw) / 2;
    for (const [a, b] of run.segments) {
      const halfAlong = (b - a) / 2;
      const alongCentre = (a + b) / 2;
      if (isEw) boxes.push({ cx: alongCentre, cz: bandCentre, hx: halfAlong, hz: sw / 2 });
      else boxes.push({ cx: bandCentre, cz: alongCentre, hx: sw / 2, hz: halfAlong });
    }
  }
  return boxes;
}

/** Emit a crosswalk zebra band spanning `[spanLo, spanHi]` (perpendicular to travel) at fixed
 * band `[bandLo, bandHi]` (along travel). `axis` = 'x' means the band spans world X (stripes run
 * along Z); 'z' means it spans world Z (stripes run along X). */
function emitCrosswalk(sink: Sink, c: Color, axis: 'x' | 'z', spanLo: number, spanHi: number, bandLo: number, bandHi: number): void {
  const step = CROSSWALK.stripeWidthWu + CROSSWALK.stripeGapWu;
  for (let s = spanLo + CROSSWALK.stripeGapWu; s + CROSSWALK.stripeWidthWu < spanHi; s += step) {
    if (axis === 'x') quad(sink, CROSSWALK.color, s, bandLo, s + CROSSWALK.stripeWidthWu, bandHi, CROSSWALK_Y, c);
    else quad(sink, CROSSWALK.color, bandLo, s, bandHi, s + CROSSWALK.stripeWidthWu, CROSSWALK_Y, c);
  }
}

/**
 * Centre-line dashes for one street.
 *
 * PHASE 75 — MEDIAN STREETS GET NO CENTRE LINE, AND NO LANE DIVIDER EITHER. Two separate calls:
 *
 *   • The dashes are painted on the exact geometric centreline, which on a median street is the
 *     middle of the raised grass strip — they would be buried under it (the median top sits at
 *     0.12 wu, the paint rung at 0.042). So they are suppressed, not relocated: on those streets
 *     the median IS the centre marker, and a far more legible one than a 0.4 wu dash.
 *   • Nothing replaces them INSIDE each carriageway. Phase 75 deliberately stays single-lane per
 *     direction (plan D5 — the extra width is drivable slack for the player, and multi-lane
 *     behaviour belongs to P80/P82), and a lane divider down the middle of a single lane would be
 *     a line telling the player to drive on one side of nothing. A carriageway divider becomes
 *     correct the day traffic actually runs two lanes per direction, and not before.
 *
 * Non-median streets are UNCHANGED: they keep the 4/5 wu dash pattern, still skipped inside every
 * intersection box, and now also skipped over any stretch swallowed by a higher-ranked parallel
 * ribbon (York's dashes would otherwise paint down the middle of Bay).
 *
 * DASH LEGIBILITY AT 2× WIDTH (the Phase 75 re-grade check, verdict: NO CHANGE). The 0.4 wu dash
 * width clears config/surfaces.ts's measured `THIN_GEOMETRY.minStripeWidthWu` (0.3) with margin and
 * is pinned by surfaces.test.ts. Width is the only quantity the doubling touched — the 4/5 wu
 * length/gap pattern runs ALONG the street and is unaffected by how wide the street is — and 0.4 wu
 * of paint on a 17.6 wu road is already ~3× the proportion a real centre line has (real markings are
 * 0.10-0.15 m). Widening it to hold the old paint-to-road ratio would read as a runway stripe, and
 * the streets that would have needed it most (spine + artery) no longer draw a centre line at all.
 */
function emitCentreDashes(sink: Sink, c: Color, street: Street, crossings: readonly { along: number; crossHalf: number }[], covered: readonly Interval[]): void {
  if (street.medianWidth > 0) return;
  const r = street.ribbon;
  const d = ROAD_EDGE.dash;
  const isEw = street.axis === 'ew';
  const [lo, hi] = isEw ? [r.minX, r.maxX] : [r.minY, r.maxY];
  const centre = isEw ? (r.minY + r.maxY) / 2 : (r.minX + r.maxX) / 2;
  for (let a = lo + d.gapWu; a + d.lengthWu < hi; a += d.lengthWu + d.gapWu) {
    const mid = a + d.lengthWu / 2;
    if (insideAnyIntersection(mid, crossings)) continue;
    if (insideAnyInterval(mid, covered)) continue;
    if (isEw) quad(sink, d.color, a, centre - d.halfWidthWu, a + d.lengthWu, centre + d.halfWidthWu, PAINT_Y, c);
    else quad(sink, d.color, centre - d.halfWidthWu, a, centre + d.halfWidthWu, a + d.lengthWu, PAINT_Y, c);
  }
}

/**
 * Build the whole road-paint geometry from the street table + intersection records. Deterministic,
 * pure (no three scene state beyond building a geometry).
 */
export function buildRoadGeometry(streets: readonly Street[], intersections: readonly Intersection[]): BufferGeometry {
  const sink: Sink = { positions: [], normals: [], colors: [] };
  const c = new Color();
  const rank = ribbonPrecedence(streets);
  const medianRuns = new Map(medianBandRuns(streets, intersections).map((run) => [run.street.id, run] as const));

  // Raised sidewalk bands along the two OUTER long edges, segmented at intersection boxes (D5) and
  // at any ground a higher-ranked parallel ribbon has taken (Phase 75).
  for (const run of sidewalkBandRuns(streets, intersections)) {
    const axis = run.street.axis === 'ew' ? 'ew' : 'ns';
    for (const [a, b] of run.segments) {
      emitBand(sink, c, axis, a, b, run.roadEdge, run.side, SIDEWALK.widthWu, SIDEWALK_BAND);
    }
  }

  for (const street of streets) {
    const r = street.ribbon; // map coords = world x/z
    const isEw = street.axis === 'ew';
    const crossings = crossingsOn(street, intersections);
    const covers = higherRibbons(street, streets, rank);
    const centre = isEw ? (r.minY + r.maxY) / 2 : (r.minX + r.maxX) / 2;

    // ASPHALT — the union (Phase 75): only the part of this ribbon that neither a higher-ranked
    // ribbon nor this street's OWN painted curb strips already cover, so no two quads ever share
    // ground on the `roadSurface` rung. Cutting by the curb strips' PAINTED PIECES (not by their
    // full rects) is what keeps the union hole-free: wherever a strip yields to a parallel ribbon
    // it is not painted, so the asphalt must keep that ground rather than give it to nobody.
    const curbPieces = curbStripPieces(street, streets, rank);
    for (const piece of subtractRects(r, [...covers.map((o) => o.ribbon), ...curbPieces])) {
      quad(sink, ROAD_COLORS[street.cls], piece.minX, piece.minY, piece.maxX, piece.maxY, ROAD_Y, c);
    }

    // Curb strips along the two long edges — emitted at ROAD_Y, on the ground the asphalt above
    // has already given up. See `curbStripPieces` for why they are union members and not decals.
    for (const piece of curbPieces) {
      quad(sink, ROAD_EDGE.color, piece.minX, piece.minY, piece.maxX, piece.maxY, ROAD_Y, c);
    }

    emitCentreDashes(sink, c, street, crossings, coveredAlong(street, covers, centre, centre));

    // THE MEDIAN (Phase 75) — a raised grass strip down the ribbon's middle, two kerb chamfers
    // facing the two carriageways. WHERE it exists (crossing cut-outs, terminus insets and the
    // ribbon-union covers) is derived by `roadStrips.medianBandRuns`, NOT here: Phase 75's T4
    // planting pass stands props on this grass and must read the identical segments, so the
    // derivation lives in the three-free module both sides import. This emitter just draws what
    // that run reports. Emission stays INSIDE the per-street loop so the merged geometry's vertex
    // order is byte-for-byte what it was before the derivation moved.
    const medianRun = medianRuns.get(street.id);
    if (medianRun !== undefined) {
      const style = medianBandStyle(street.medianWidth);
      const axis = isEw ? 'ew' : 'ns';
      for (const [a, b] of medianRun.segments) {
        emitBand(sink, c, axis, a, b, medianRun.centre - medianRun.half, 1, medianRun.half, style);
        emitBand(sink, c, axis, a, b, medianRun.centre + medianRun.half, -1, medianRun.half, style);
      }
    }
  }

  // Crosswalk zebras at signalized intersections (both classes full — spine/artery/major). The
  // band RECTS come from world/toronto/crosswalks.ts (Phase 40): the placement arbiter registers
  // the same rects as `crosswalkBand` zone claims so lane closures can't land on a live crossing,
  // and a single derivation guarantees the paint and the gate describe the same geometry.
  for (const band of crosswalkBands(intersections)) {
    if (band.stripeAxis === 'x') {
      // Crossing the NS street: stripes are laid across world X, band runs along world Z.
      emitCrosswalk(sink, c, 'x', band.minX, band.maxX, band.minZ, band.maxZ);
    } else {
      emitCrosswalk(sink, c, 'z', band.minZ, band.maxZ, band.minX, band.maxX);
    }
  }

  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(sink.positions, 3));
  g.setAttribute('normal', new Float32BufferAttribute(sink.normals, 3));
  g.setAttribute('color', new Float32BufferAttribute(sink.colors, 3));
  g.computeBoundingSphere();
  return g;
}
