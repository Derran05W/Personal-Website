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
// Y-LAYERING (all a hair above the ground slab; higher = paints on top): road ribbon < curb strips
// < crosswalk zebra < raised sidewalk top (curbHeightWu, well above the paint). mapToWorld is the
// identity swap, so street map coords ARE world x/z.

import { BufferGeometry, Color, Float32BufferAttribute } from 'three';
import { CROSSWALK, ROAD_CLASSES, ROAD_COLORS, ROAD_EDGE, SIDEWALK } from '../../config/torontoMap';
import { TRAFFIC_LIGHT_FULL_CLASSES } from '../../config/torontoDress';
import type { Intersection } from './roadGraph';
import type { Street } from './streets';

const ROAD_Y = 0.02;
const PAINT_Y = ROAD_Y + 0.005; // curbs + dashes
const CROSSWALK_Y = ROAD_Y + 0.007; // above the curbs so the zebra reads on the asphalt

// D5 raised-sidewalk geometry.
const CURB_TOP_Y = SIDEWALK.curbHeightWu; // flat top face height (0.12)
const CURB_CHAMFER_WU = 0.7; // horizontal run of the sloped road-facing curb face (reads top-down)
const CURB_CUT_SETBACK_WU = 1.0; // extra gap each side of a crossing box (room for the crosswalk)
const MIN_SEGMENT_WU = 2; // drop slivers shorter than this (a raised nub reads as noise)

const FULL_CLASSES = new Set<string>(TRAFFIC_LIGHT_FULL_CLASSES);

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

/** Along-coords of every crossing on `street` + the cross street's half-width there (the
 * intersection-box half-span along this street). */
function crossingsOn(street: Street, intersections: readonly Intersection[]): { along: number; crossHalf: number }[] {
  return intersections
    .filter((c) => (street.axis === 'ns' ? c.nsId === street.id : c.ewId === street.id))
    .map((c) => ({
      along: street.axis === 'ns' ? c.y : c.x,
      crossHalf: ROAD_CLASSES[street.axis === 'ns' ? c.ewCls : c.nsCls] / 2,
    }));
}

function insideAnyIntersection(along: number, crossings: readonly { along: number; crossHalf: number }[]): boolean {
  return crossings.some((c) => Math.abs(along - c.along) < c.crossHalf);
}

/** The free along-segments of a street's ribbon span minus the intersection boxes (each crossing ±
 * crossHalf + CURB_CUT_SETBACK), merged. The raised sidewalk (D5) only sits inside these, so the
 * band cuts out at every crossing = a natural curb cut where the crosswalk lands. Shared by the
 * visual band and the collider boxes so the two can never drift. */
export function sidewalkSegments(
  lo: number,
  hi: number,
  crossings: readonly { along: number; crossHalf: number }[],
): readonly [number, number][] {
  const excluded: [number, number][] = crossings
    .map((c): [number, number] => [c.along - c.crossHalf - CURB_CUT_SETBACK_WU, c.along + c.crossHalf + CURB_CUT_SETBACK_WU])
    .sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const iv of excluded) {
    const last = merged[merged.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else merged.push([iv[0], iv[1]]);
  }
  const free: [number, number][] = [];
  let cursor = lo;
  for (const [elo, ehi] of merged) {
    if (elo > cursor) free.push([cursor, Math.min(elo, hi)]);
    cursor = Math.max(cursor, ehi);
    if (cursor >= hi) break;
  }
  if (cursor < hi) free.push([cursor, hi]);
  return free.filter(([a, b]) => b - a >= MIN_SEGMENT_WU);
}

/** One raised sidewalk band on one ribbon edge, for a single along-segment. `roadEdge` is the ribbon
 * edge coord on the perpendicular axis; `outSign` is which way the sidewalk extends (+1 = larger
 * perp, −1 = smaller). Emits: the road-facing CHAMFER (asphalt level → curb top over CURB_CHAMFER_WU)
 * + the flat top face at CURB_TOP_Y. `axis` 'ew' means the segment runs along X (perp = Z); 'ns'
 * means along Z (perp = X). */
function emitBand(
  sink: Sink,
  c: Color,
  axis: 'ew' | 'ns',
  aLo: number,
  aHi: number,
  roadEdge: number,
  outSign: 1 | -1,
  sw: number,
): void {
  const chamferOuter = roadEdge + outSign * CURB_CHAMFER_WU;
  const topOuter = roadEdge + outSign * sw;
  // Order the perp pair so z0<z1 / x0<x1 (winding contract). Chamfer: y is ROAD_Y at the roadEdge,
  // CURB_TOP_Y at chamferOuter; the flat top is CURB_TOP_Y across.
  if (axis === 'ew') {
    // perp = Z. along = X (aLo<aHi already).
    const pRoad = roadEdge;
    const pCh = chamferOuter;
    const pTop = topOuter;
    // chamfer quad between pRoad and pCh
    const [z0c, z1c, yRoadAtZ0] = pRoad < pCh ? [pRoad, pCh, true] : [pCh, pRoad, false];
    // yA/yB/yC/yD map to corners A(x0,z0) B(x0,z1) C(x1,z1) D(x1,z0); y depends on which z is roadEdge
    const yLow = ROAD_Y;
    const yHigh = CURB_TOP_Y;
    const yZ0 = yRoadAtZ0 ? yLow : yHigh; // y at z0
    const yZ1 = yRoadAtZ0 ? yHigh : yLow; // y at z1
    quadYs(sink, SIDEWALK.curbFaceColor, aLo, z0c, aHi, z1c, yZ0, yZ1, yZ1, yZ0, c);
    // flat top from pCh to pTop
    const zt0 = Math.min(pCh, pTop);
    const zt1 = Math.max(pCh, pTop);
    quad(sink, SIDEWALK.color, aLo, zt0, aHi, zt1, CURB_TOP_Y, c);
  } else {
    // perp = X. along = Z (aLo<aHi already).
    const pRoad = roadEdge;
    const pCh = chamferOuter;
    const pTop = topOuter;
    const [x0c, x1c, yRoadAtX0] = pRoad < pCh ? [pRoad, pCh, true] : [pCh, pRoad, false];
    const yLow = ROAD_Y;
    const yHigh = CURB_TOP_Y;
    const yX0 = yRoadAtX0 ? yLow : yHigh;
    const yX1 = yRoadAtX0 ? yHigh : yLow;
    // corners A(x0,z0) B(x0,z1) C(x1,z1) D(x1,z0): y depends on X → A,B share x0; C,D share x1.
    quadYs(sink, SIDEWALK.curbFaceColor, x0c, aLo, x1c, aHi, yX0, yX0, yX1, yX1, c);
    const xt0 = Math.min(pCh, pTop);
    const xt1 = Math.max(pCh, pTop);
    quad(sink, SIDEWALK.color, xt0, aLo, xt1, aHi, CURB_TOP_Y, c);
  }
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
  for (const street of streets) {
    const r = street.ribbon;
    const crossings = crossingsOn(street, intersections);
    if (street.axis === 'ew') {
      const segs = sidewalkSegments(r.minX, r.maxX, crossings);
      for (const [a, b] of segs) {
        const hx = (b - a) / 2;
        const cx = (a + b) / 2;
        // north band z in [minY-sw, minY]; south z in [maxY, maxY+sw]
        boxes.push({ cx, cz: r.minY - sw / 2, hx, hz: sw / 2 });
        boxes.push({ cx, cz: r.maxY + sw / 2, hx, hz: sw / 2 });
      }
    } else {
      const segs = sidewalkSegments(r.minY, r.maxY, crossings);
      for (const [a, b] of segs) {
        const hz = (b - a) / 2;
        const cz = (a + b) / 2;
        boxes.push({ cx: r.minX - sw / 2, cz, hx: sw / 2, hz });
        boxes.push({ cx: r.maxX + sw / 2, cz, hx: sw / 2, hz });
      }
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
 * Build the whole road-paint geometry from the street table + intersection records. Deterministic,
 * pure (no three scene state beyond building a geometry).
 */
export function buildRoadGeometry(streets: readonly Street[], intersections: readonly Intersection[]): BufferGeometry {
  const sink: Sink = { positions: [], normals: [], colors: [] };
  const c = new Color();
  const e = ROAD_EDGE.widthWu;
  const d = ROAD_EDGE.dash;
  const sw = SIDEWALK.widthWu;

  for (const street of streets) {
    const r = street.ribbon; // map coords = world x/z
    const isEw = street.axis === 'ew';
    const crossings = crossingsOn(street, intersections);

    // Raised sidewalk bands along the two OUTER long edges, segmented at intersection boxes (D5).
    if (isEw) {
      const segs = sidewalkSegments(r.minX, r.maxX, crossings);
      for (const [a, b] of segs) {
        emitBand(sink, c, 'ew', a, b, r.minY, -1, sw); // north (extends toward -z)
        emitBand(sink, c, 'ew', a, b, r.maxY, 1, sw); // south (extends toward +z)
      }
    } else {
      const segs = sidewalkSegments(r.minY, r.maxY, crossings);
      for (const [a, b] of segs) {
        emitBand(sink, c, 'ns', a, b, r.minX, -1, sw); // west (extends toward -x)
        emitBand(sink, c, 'ns', a, b, r.maxX, 1, sw); // east (extends toward +x)
      }
    }

    // Asphalt ribbon.
    quad(sink, ROAD_COLORS[street.cls], r.minX, r.minY, r.maxX, r.maxY, ROAD_Y, c);

    if (isEw) {
      // Curbs along the north/south edges.
      quad(sink, ROAD_EDGE.color, r.minX, r.minY, r.maxX, r.minY + e, PAINT_Y, c);
      quad(sink, ROAD_EDGE.color, r.minX, r.maxY - e, r.maxX, r.maxY, PAINT_Y, c);
      // Centre-line dashes along X, skipped inside intersection boxes.
      const cz = (r.minY + r.maxY) / 2;
      for (let x = r.minX + d.gapWu; x + d.lengthWu < r.maxX; x += d.lengthWu + d.gapWu) {
        const mid = x + d.lengthWu / 2;
        if (insideAnyIntersection(mid, crossings)) continue;
        quad(sink, d.color, x, cz - d.halfWidthWu, x + d.lengthWu, cz + d.halfWidthWu, PAINT_Y, c);
      }
    } else {
      quad(sink, ROAD_EDGE.color, r.minX, r.minY, r.minX + e, r.maxY, PAINT_Y, c);
      quad(sink, ROAD_EDGE.color, r.maxX - e, r.minY, r.maxX, r.maxY, PAINT_Y, c);
      const cx = (r.minX + r.maxX) / 2;
      for (let z = r.minY + d.gapWu; z + d.lengthWu < r.maxY; z += d.lengthWu + d.gapWu) {
        const mid = z + d.lengthWu / 2;
        if (insideAnyIntersection(mid, crossings)) continue;
        quad(sink, d.color, cx - d.halfWidthWu, z, cx + d.halfWidthWu, z + d.lengthWu, PAINT_Y, c);
      }
    }
  }

  // Crosswalk zebras at signalized intersections (both classes full — spine/artery/major).
  for (const it of intersections) {
    if (!FULL_CLASSES.has(it.nsCls) || !FULL_CLASSES.has(it.ewCls)) continue;
    const nsHalf = ROAD_CLASSES[it.nsCls] / 2; // box half-span along world X
    const ewHalf = ROAD_CLASSES[it.ewCls] / 2; // box half-span along world Z
    const gap = CROSSWALK.setbackWu;
    const band = CROSSWALK.bandWu;
    // North / south of the box: cross the NS street (span world X), band along world Z.
    emitCrosswalk(sink, c, 'x', it.x - nsHalf, it.x + nsHalf, it.y - ewHalf - gap - band, it.y - ewHalf - gap);
    emitCrosswalk(sink, c, 'x', it.x - nsHalf, it.x + nsHalf, it.y + ewHalf + gap, it.y + ewHalf + gap + band);
    // East / west of the box: cross the EW street (span world Z), band along world X.
    emitCrosswalk(sink, c, 'z', it.y - ewHalf, it.y + ewHalf, it.x + nsHalf + gap, it.x + nsHalf + gap + band);
    emitCrosswalk(sink, c, 'z', it.y - ewHalf, it.y + ewHalf, it.x - nsHalf - gap - band, it.x - nsHalf - gap);
  }

  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(sink.positions, 3));
  g.setAttribute('normal', new Float32BufferAttribute(sink.normals, 3));
  g.setAttribute('color', new Float32BufferAttribute(sink.colors, 3));
  g.computeBoundingSphere();
  return g;
}
