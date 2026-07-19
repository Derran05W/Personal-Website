// The playable-map boundary — the §1 "thermometer": a full-width downtown block, a narrow
// fold corridor, and a North York capsule on top. Everything here is pure geometry in map
// world-units (wu), y-down = south, matching projection.ts.
//
// Part-8 (D1/D2, "density/life flip"): the polygon compacts with projection.ts's DENSITY.scale.
// x-extents compress about the Yonge spine (x=1500) via `scaleAboutYonge`; y-edges are the SAME
// live ZONE_BOUNDARIES projection.ts derives (the fold segment exempt). BASE_X below records the
// §1 spec's original (pre-compaction) x literals — never re-literalized past this point.

import { YONGE_X, ZONE_BOUNDARIES } from './projection';
import { DENSITY } from '../../config/torontoMap';

/** A polygon vertex in map space (world-units). */
export interface MapVertex {
  readonly x: number;
  readonly y: number;
}

/** §1 BASE (pre-compaction) x literals: the capsule, fold corridor, and downtown block extents. */
const BASE_X = {
  capsuleWest: 1100,
  capsuleEast: 1900,
  foldWest: 1200,
  foldEast: 1800,
  downtownWest: 0,
  downtownEast: 2400,
} as const;

/** Compresses a BASE x literal about the Yonge spine by DENSITY.scale — the one function every
 * x-extent below (and every other module's re-derived x literal) goes through. */
export function scaleAboutYonge(x: number): number {
  return YONGE_X + (x - YONGE_X) * DENSITY.scale;
}

const CAPSULE_WEST = scaleAboutYonge(BASE_X.capsuleWest);
const CAPSULE_EAST = scaleAboutYonge(BASE_X.capsuleEast);
const FOLD_WEST = scaleAboutYonge(BASE_X.foldWest);
const FOLD_EAST = scaleAboutYonge(BASE_X.foldEast);
const DOWNTOWN_WEST = scaleAboutYonge(BASE_X.downtownWest);
const DOWNTOWN_EAST = scaleAboutYonge(BASE_X.downtownEast);

/** The three zones' LIVE (compacted) x-extents — the single source every other module (streets.ts's
 * ZONE_X, torontoSceneHelpers.ts's GROUND_RECTS/WATER_RECT) re-derives from instead of re-literalizing. */
export const ZONE_X_EXTENTS = {
  capsule: [CAPSULE_WEST, CAPSULE_EAST],
  fold: [FOLD_WEST, FOLD_EAST],
  downtown: [DOWNTOWN_WEST, DOWNTOWN_EAST],
} as const satisfies Record<string, readonly [number, number]>;

/**
 * The playable polygon, derived from the §1 shape — 12 vertices, clockwise, y-down.
 * capsule (y ZONE_BOUNDARIES[0..1], x CAPSULE_WEST–CAPSULE_EAST) → fold corridor
 * (y ZONE_BOUNDARIES[1..2], x FOLD_WEST–FOLD_EAST) → downtown block
 * (y ZONE_BOUNDARIES[2..4], x DOWNTOWN_WEST–DOWNTOWN_EAST, water band below ZONE_BOUNDARIES[3]).
 */
export const PLAYABLE_POLYGON: readonly MapVertex[] = [
  { x: CAPSULE_WEST, y: ZONE_BOUNDARIES[0] },
  { x: CAPSULE_EAST, y: ZONE_BOUNDARIES[0] },
  { x: CAPSULE_EAST, y: ZONE_BOUNDARIES[1] },
  { x: FOLD_EAST, y: ZONE_BOUNDARIES[1] },
  { x: FOLD_EAST, y: ZONE_BOUNDARIES[2] },
  { x: DOWNTOWN_EAST, y: ZONE_BOUNDARIES[2] },
  { x: DOWNTOWN_EAST, y: ZONE_BOUNDARIES[4] },
  { x: DOWNTOWN_WEST, y: ZONE_BOUNDARIES[4] },
  { x: DOWNTOWN_WEST, y: ZONE_BOUNDARIES[2] },
  { x: FOLD_WEST, y: ZONE_BOUNDARIES[2] },
  { x: FOLD_WEST, y: ZONE_BOUNDARIES[1] },
  { x: CAPSULE_WEST, y: ZONE_BOUNDARIES[1] },
] as const;

/** Camera clamp padding (spec §1): the camera stays this far inside the polygon so the void
 * never shows at default zoom. */
export const CAMERA_CLAMP_PADDING_WU = 80;

const EPS = 1e-6;

/** Signed area via the shoelace formula. Positive for the given (§1) winding, so the raw
 * value is the true +area for PLAYABLE_POLYGON (6,780,000 wu²). */
export function polygonArea(poly: readonly MapVertex[]): number {
  let sum = 0;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

function orient(a: MapVertex, b: MapVertex, c: MapVertex): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

/** Is c on segment a–b, given a,b,c already collinear? */
function onCollinearSeg(a: MapVertex, b: MapVertex, c: MapVertex): boolean {
  return (
    Math.min(a.x, b.x) - EPS <= c.x &&
    c.x <= Math.max(a.x, b.x) + EPS &&
    Math.min(a.y, b.y) - EPS <= c.y &&
    c.y <= Math.max(a.y, b.y) + EPS
  );
}

/** Do segments p1–p2 and p3–p4 intersect (proper crossing or a touch at a non-shared point)? */
function segmentsIntersect(p1: MapVertex, p2: MapVertex, p3: MapVertex, p4: MapVertex): boolean {
  const d1 = orient(p3, p4, p1);
  const d2 = orient(p3, p4, p2);
  const d3 = orient(p1, p2, p3);
  const d4 = orient(p1, p2, p4);
  // Proper crossing: all four orientations non-zero, p1,p2 straddle line p3p4 AND p3,p4
  // straddle line p1p2 (CLRS). Zero orientations are handled as collinear touches below.
  if (d1 !== 0 && d2 !== 0 && d3 !== 0 && d4 !== 0 && d1 > 0 !== d2 > 0 && d3 > 0 !== d4 > 0) {
    return true;
  }
  // Collinear-touch cases.
  if (d1 === 0 && onCollinearSeg(p3, p4, p1)) return true;
  if (d2 === 0 && onCollinearSeg(p3, p4, p2)) return true;
  if (d3 === 0 && onCollinearSeg(p1, p2, p3)) return true;
  if (d4 === 0 && onCollinearSeg(p1, p2, p4)) return true;
  return false;
}

/**
 * A polygon is simple when no two NON-ADJACENT edges intersect. Adjacent edges legitimately
 * share their common vertex (and the wrap-around edge n-1 ↔ edge 0 too), so those pairs are
 * skipped; every other pair must be disjoint.
 */
export function isSimplePolygon(poly: readonly MapVertex[]): boolean {
  const n = poly.length;
  if (n < 3) return false;
  for (let i = 0; i < n; i++) {
    const a1 = poly[i];
    const a2 = poly[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      // adjacency: shared endpoint between edge i and edge j (includes the 0↔n-1 wrap).
      if (j === i || j === (i + 1) % n || (j + 1) % n === i) continue;
      const b1 = poly[j];
      const b2 = poly[(j + 1) % n];
      if (segmentsIntersect(a1, a2, b1, b2)) return false;
    }
  }
  return true;
}

/** Distance from point p to segment a–b. */
function pointSegmentDistance(p: MapVertex, a: MapVertex, b: MapVertex): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Minimum distance from p to the polygon boundary (0 on an edge). */
export function distanceToBoundary(p: MapVertex, poly: readonly MapVertex[]): number {
  let min = Infinity;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const d = pointSegmentDistance(p, poly[i], poly[(i + 1) % n]);
    if (d < min) min = d;
  }
  return min;
}

/**
 * Point-in-polygon by ray casting. BOUNDARY-INCLUSIVE: a point lying on any edge counts as
 * inside (an on-edge check runs before the crossing count, since ray casting is otherwise
 * ambiguous exactly on the boundary).
 */
export function pointInPolygon(p: MapVertex, poly: readonly MapVertex[]): boolean {
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    if (pointSegmentDistance(p, poly[i], poly[(i + 1) % n]) <= EPS) return true;
  }
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    const crosses = yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

/** Unit inward normal of edge a→b (points into the polygon). Winding-agnostic: it probes a
 * hair off the edge midpoint and keeps whichever normal lands inside. */
function inwardNormal(a: MapVertex, b: MapVertex, poly: readonly MapVertex[]): MapVertex {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const probe = 0.5;
  if (pointInPolygon({ x: mid.x + nx * probe, y: mid.y + ny * probe }, poly)) {
    return { x: nx, y: ny };
  }
  return { x: -nx, y: -ny };
}

/**
 * Nearest point at least `paddingWu` inside the polygon. If p is already ≥ padding deep it is
 * returned unchanged; otherwise every edge is offset inward by padding (and shrunk padding at
 * each end so convex corners inset diagonally), p is projected onto each offset segment, and
 * the CLOSEST candidate that is itself ≥ padding inside (validated against ALL edges — so
 * concave-corner candidates that sit too near another wall are rejected) is returned. A ring of
 * known-deep interior anchors is the last-resort fallback, guaranteeing the result is always a
 * valid ≥-padding point — which makes clampToPolygon idempotent.
 */
export function clampToPolygon(p: MapVertex, paddingWu: number): MapVertex {
  const P = PLAYABLE_POLYGON;
  if (pointInPolygon(p, P) && distanceToBoundary(p, P) >= paddingWu - EPS) {
    return p;
  }

  const isSafe = (q: MapVertex): boolean =>
    pointInPolygon(q, P) && distanceToBoundary(q, P) >= paddingWu - EPS;

  let best: MapVertex | null = null;
  let bestD2 = Infinity;
  const consider = (q: MapVertex): void => {
    if (!isSafe(q)) return;
    const d2 = (q.x - p.x) * (q.x - p.x) + (q.y - p.y) * (q.y - p.y);
    if (d2 < bestD2) {
      bestD2 = d2;
      best = q;
    }
  };

  const n = P.length;
  for (let i = 0; i < n; i++) {
    const a = P[i];
    const b = P[(i + 1) % n];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len === 0) continue;
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    const nrm = inwardNormal(a, b, P);
    const inset = Math.min(paddingWu, len / 2); // shrink ends so convex corners inset diagonally
    const a2 = { x: a.x + nrm.x * paddingWu + ux * inset, y: a.y + nrm.y * paddingWu + uy * inset };
    const b2 = { x: b.x + nrm.x * paddingWu - ux * inset, y: b.y + nrm.y * paddingWu - uy * inset };
    // project p onto segment a2–b2
    const sx = b2.x - a2.x;
    const sy = b2.y - a2.y;
    const seg2 = sx * sx + sy * sy;
    let t = seg2 === 0 ? 0 : ((p.x - a2.x) * sx + (p.y - a2.y) * sy) / seg2;
    t = Math.max(0, Math.min(1, t));
    consider({ x: a2.x + t * sx, y: a2.y + t * sy });
  }

  if (best) return best;
  // Fallback: nearest guaranteed-deep interior anchor (capsule / corridor / downtown centres),
  // re-derived from the same ZONE_BOUNDARIES/DOWNTOWN_* constants above (never hand-picked twice).
  const anchors: readonly MapVertex[] = [
    { x: YONGE_X, y: (ZONE_BOUNDARIES[0] + ZONE_BOUNDARIES[1]) / 2 }, // capsule centre
    { x: YONGE_X, y: (ZONE_BOUNDARIES[1] + ZONE_BOUNDARIES[2]) / 2 }, // fold corridor centre
    { x: (DOWNTOWN_WEST + DOWNTOWN_EAST) / 2, y: (ZONE_BOUNDARIES[2] + ZONE_BOUNDARIES[3]) / 2 }, // downtown centre
  ];
  let fb = anchors[0];
  let fbD2 = Infinity;
  for (const q of anchors) {
    const d2 = (q.x - p.x) * (q.x - p.x) + (q.y - p.y) * (q.y - p.y);
    if (d2 < fbD2) {
      fbD2 = d2;
      fb = q;
    }
  }
  return fb;
}
