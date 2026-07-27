// Phase 37 — the diegetic world-edge barrier ring. Pure placement math: no three, no react, no
// rapier, no rng. Given PLAYABLE_POLYGON + the street table, this module answers three questions
// and nothing else:
//
//   1. WHERE does the wall run?      -> `edges`     (one mitred, inset segment per LAND edge)
//   2. WHAT stops the car?           -> `colliders` (one long axis-aligned fixed cuboid per edge)
//   3. WHAT does the player see?     -> `dressing`  (per-theme pieces + dead-end "road closed" rows)
//
// The scene (TorontoScene.tsx) turns 2 into RegisteredCuboidColliders of kind 'barrier' and 3 into
// CityPackBatched runs + merged procedural geometry. Every tunable lives in config/torontoMap.ts's
// BARRIER block — there are no numbers in this file that a designer would want to change.
//
// SPACE CONVENTION (projection.ts): map (x, y) with y-DOWN = south; mapToWorld is the identity
// swap map(x,y) -> world[x, z]. Interior geometry below is computed in MAP space (so it can be
// checked against pointInPolygon/distanceToBoundary directly) and converted exactly once, at the
// output boundary, through mapToWorld — the axis seam stays single-sourced.
//
// THE SOUTH EDGE IS SKIPPED — LOCKED. PLAYABLE_POLYGON's one edge whose endpoints both sit on
// ZONE_BOUNDARIES[4] is the lake's outer edge; there is no wall on the water (the water sensor +
// the out-of-bounds backstop own that side). The ring is therefore a U: the two downtown W/E walls
// run the full height of the polygon, through the water band, down to the ring's south corners, so
// the U's two ends are closed and only the south SIDE is open.
//
// YAW CONVENTION: every emitted `yawRad` is a rotation about world +Y such that the piece's local
// +Z faces INWARD (toward the playable side) and its local ±X runs ALONG the edge — i.e.
// `atan2(inwardX, inwardZ)`. Pack models whose authored rest orientation differs add a constant
// per-model offset at mount time; `fence`/`cone` (BARRIER.packModelIds) already match.

import {
  BARRIER,
  EDGE_PAD_WU,
  ROAD_CLASSES,
} from '../../config/torontoMap';
import {
  PLAYABLE_POLYGON,
  ZONE_X_EXTENTS,
  distanceToBoundary,
  pointInPolygon,
  type MapVertex,
} from './polygon';
import { ZONE_BOUNDARIES, mapToWorld } from './projection';
import { STREET_DEFS, buildStreets, type Street } from './streets';

// --- output shapes -----------------------------------------------------------------------

/** Which dressing recipe an edge gets. Derived from the edge's own geometry (see `themeFor`),
 * never from a hand-written edge-index table, so a polygon re-derivation can't silently mis-theme
 * the ring. */
export type BarrierTheme =
  /** Capsule top: a solid construction-hoarding run — the north end of the map is a job site. */
  | 'hoarding'
  /** Capsule + downtown W/E flanks: pack fence panels. */
  | 'fence'
  /** Fold-corridor W/E flanks: fence + posts, a rail right-of-way. */
  | 'rail'
  /** The four step-in notch horizontals (flush with Sheppard / Bloor): hoarding + cones. */
  | 'notch';

/** One dressing piece's kind. 'fencePiece' and 'cone' render as pack models
 * (BARRIER.packModelIds); the other three are procedural boxes built by the scene. */
export type BarrierDressingKind =
  | 'fencePiece'
  | 'hoardingPanel'
  | 'railPost'
  | 'cone'
  | 'jerseyBarrier';

/** A world-space XZ point (y is the scene's business — everything here stands on the ground). */
export interface WorldPoint {
  readonly x: number;
  readonly z: number;
}

/** One land edge of the ring: the mitred, inset centreline the wall runs along. */
export interface BarrierEdge {
  /** Index into PLAYABLE_POLYGON (the edge from vertex `index` to vertex `index + 1`). */
  readonly index: number;
  readonly theme: BarrierTheme;
  /** The world axis the wall runs ALONG ('x' for an east-west wall, 'z' for a north-south one). */
  readonly runAxis: 'x' | 'z';
  /** Realised inset for THIS edge (wu): BARRIER.edgeInsetWu, or BARRIER.minEdgeInsetWu where a
   * street ribbon lies flush against the polygon edge. */
  readonly insetWu: number;
  /** Unit inward normal in world space (points at the playable interior). */
  readonly inward: WorldPoint;
  /** Mitred inset segment, world space — NOT extended by the corner-seal overlap. */
  readonly start: WorldPoint;
  readonly end: WorldPoint;
  readonly lengthWu: number;
}

/** The one edge that gets NO wall (the lake's outer edge), reported so the minimap can style it
 * as water rather than hazard, and so tests can prove exactly one edge was skipped. */
export interface BarrierWaterEdge {
  readonly index: number;
  readonly start: WorldPoint;
  readonly end: WorldPoint;
}

/** One wall segment's fixed cuboid, world space. Height is BARRIER.colliderHeightWu for every box
 * (the scene positions it at height/2 above the ground); only the XZ footprint varies. */
export interface BarrierCollider {
  readonly edgeIndex: number;
  readonly cx: number;
  readonly cz: number;
  readonly hx: number;
  readonly hz: number;
}

/** One visual piece. Ordered by edge (polygon order), then by dead-end street. */
export interface BarrierDressing {
  readonly kind: BarrierDressingKind;
  /** World x. */
  readonly x: number;
  /** World z. */
  readonly z: number;
  /** Rotation about +Y; local +Z faces inward, local ±X runs along the edge (see file header). */
  readonly yawRad: number;
  /** Owning land edge, or -1 for a street dead-end row. */
  readonly edgeIndex: number;
  /** Owning street for a dead-end row; null for edge dressing. */
  readonly streetId: string | null;
}

/** A street that dies against the ring — its last asphalt gets a jersey row across the lane. */
export interface BarrierDeadEnd {
  readonly streetId: string;
  /** The land edge this street runs into. */
  readonly edgeIndex: number;
  /** World position of the street's last centreline point. */
  readonly x: number;
  readonly z: number;
  readonly roadWidthWu: number;
  /** How many jersey barriers actually survived the polygon-clearance filter. */
  readonly barrierCount: number;
}

export interface WorldEdgeLayout {
  readonly edges: readonly BarrierEdge[];
  readonly waterEdge: BarrierWaterEdge;
  readonly colliders: readonly BarrierCollider[];
  readonly dressing: readonly BarrierDressing[];
  readonly deadEnds: readonly BarrierDeadEnd[];
}

// --- internals ---------------------------------------------------------------------------

const EPS = 1e-9;
const SHORE_Y = ZONE_BOUNDARIES[3];
const WATER_BOTTOM_Y = ZONE_BOUNDARIES[4];

/** A polygon edge in map space, pre-inset. Every PLAYABLE_POLYGON edge is axis-aligned (§1 is
 * rectilinear), which is what makes the whole module closed-form. */
interface RawEdge {
  readonly index: number;
  readonly a: MapVertex;
  readonly b: MapVertex;
  /** 'x' when the edge runs east-west (constant map y), 'y' when it runs north-south. */
  readonly runAxis: 'x' | 'y';
  /** The edge's fixed coordinate on the OTHER axis. */
  readonly fixed: number;
  /** [min, max] of the edge along `runAxis`. */
  readonly range: readonly [number, number];
  /** Inward normal (map space); one component is 0, the other ±1. */
  readonly inward: MapVertex;
  /** +1 / -1: the sign of the inward normal on the fixed axis. */
  readonly inwardSign: number;
  readonly isWater: boolean;
}

/** Unit inward normal of an axis-aligned edge: probe a hair off the midpoint and keep whichever
 * side lands inside the polygon (winding-agnostic, same technique as polygon.ts's own private
 * helper). The probe distance is tiny compared to every polygon feature (the narrowest is the
 * 60 wu notch step), so it can never pick the wrong side. */
function inwardNormalOf(a: MapVertex, b: MapVertex): MapVertex {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const probe = 0.5;
  if (pointInPolygon({ x: mid.x + nx * probe, y: mid.y + ny * probe }, PLAYABLE_POLYGON)) {
    return { x: nx, y: ny };
  }
  return { x: -nx, y: -ny };
}

/**
 * Theme from geometry, not from an index table:
 *   • east-west edge on ZONE_BOUNDARIES[0]           -> 'hoarding' (the capsule's top)
 *   • east-west edge on ZONE_BOUNDARIES[1] or [2]    -> 'notch'    (the four step-ins)
 *   • north-south edge on the FOLD's x-extents       -> 'rail'     (the corridor flanks)
 *   • every other north-south edge (capsule/downtown)-> 'fence'
 */
function themeFor(edge: RawEdge): BarrierTheme {
  if (edge.runAxis === 'x') {
    if (near(edge.fixed, ZONE_BOUNDARIES[0])) return 'hoarding';
    return 'notch';
  }
  const [foldWest, foldEast] = ZONE_X_EXTENTS.fold;
  if (near(edge.fixed, foldWest) || near(edge.fixed, foldEast)) return 'rail';
  return 'fence';
}

function near(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-6;
}

function buildRawEdges(): readonly RawEdge[] {
  const poly = PLAYABLE_POLYGON;
  const n = poly.length;
  const edges: RawEdge[] = [];
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const runAxis: 'x' | 'y' = near(a.y, b.y) ? 'x' : 'y';
    const fixed = runAxis === 'x' ? a.y : a.x;
    const lo = runAxis === 'x' ? Math.min(a.x, b.x) : Math.min(a.y, b.y);
    const hi = runAxis === 'x' ? Math.max(a.x, b.x) : Math.max(a.y, b.y);
    const inward = inwardNormalOf(a, b);
    edges.push({
      index: i,
      a,
      b,
      runAxis,
      fixed,
      range: [lo, hi],
      inward,
      inwardSign: runAxis === 'x' ? Math.sign(inward.y) : Math.sign(inward.x),
      // The lake's outer edge: BOTH endpoints on the polygon's bottom boundary.
      isWater: near(a.y, WATER_BOTTOM_Y) && near(b.y, WATER_BOTTOM_Y),
    });
  }
  return edges;
}

/**
 * Per-edge inset. Default BARRIER.edgeInsetWu, pulled back to BARRIER.minEdgeInsetWu (or to
 * whatever fits) when a street ribbon PARALLEL to the edge lies inside the inset band.
 *
 * This is the rule that keeps the ring off Bloor and Sheppard. streets.ts boundary-nudges those
 * two onto their zone edge (their outer curb IS the polygon boundary), so on the four step/notch
 * horizontals the free band is exactly 0 and the wall collapses to flush-with-the-edge. Every
 * other edge's nearest parallel ribbon is 60+ wu away and keeps the full 6.
 */
function resolveInset(edge: RawEdge, streets: readonly Street[]): number {
  const halfThickness = BARRIER.colliderThicknessWu / 2;
  let inset: number = BARRIER.edgeInsetWu;
  for (const street of streets) {
    const streetRunsAlong: 'x' | 'y' = street.axis === 'ew' ? 'x' : 'y';
    if (streetRunsAlong !== edge.runAxis) continue; // perpendicular streets are the dead-end case
    const ribbon = street.ribbon;
    const alongLo = edge.runAxis === 'x' ? ribbon.minX : ribbon.minY;
    const alongHi = edge.runAxis === 'x' ? ribbon.maxX : ribbon.maxY;
    if (alongHi <= edge.range[0] + EPS || alongLo >= edge.range[1] - EPS) continue; // no overlap
    const perpLo = edge.runAxis === 'x' ? ribbon.minY : ribbon.minX;
    const perpHi = edge.runAxis === 'x' ? ribbon.maxY : ribbon.maxX;
    // Signed depth of the ribbon's two long edges measured INWARD from the polygon edge.
    const d0 = edge.inwardSign * (perpLo - edge.fixed);
    const d1 = edge.inwardSign * (perpHi - edge.fixed);
    const nearDepth = Math.min(d0, d1);
    const farDepth = Math.max(d0, d1);
    if (farDepth <= 0) continue; // ribbon lies outside this edge entirely
    const free = Math.max(0, nearDepth);
    if (free >= inset + halfThickness) continue;
    inset = Math.min(inset, free - halfThickness);
  }
  return Math.max(BARRIER.minEdgeInsetWu, Math.min(BARRIER.edgeInsetWu, inset));
}

/**
 * Mitred inset ring. For a rectilinear polygon the offset of vertex i is the intersection of its
 * two adjacent edges' offset LINES, which — because the two edges are perpendicular and each
 * offset line only moves on that edge's fixed axis — is exactly
 * `v + n(prev) * inset(prev) + n(next) * inset(next)`. That formula is correct at convex AND at
 * reflex (the four step-in) corners, and it composes per-edge insets that differ (6 on a clean
 * edge meeting 0.5 on a Bloor-flush one) without any special-casing.
 */
function insetVertices(edges: readonly RawEdge[], insets: readonly number[]): readonly MapVertex[] {
  const n = edges.length;
  const out: MapVertex[] = [];
  for (let i = 0; i < n; i++) {
    const prev = edges[(i - 1 + n) % n];
    const next = edges[i]; // edge i starts at vertex i
    const p = insets[(i - 1 + n) % n];
    const q = insets[i];
    out.push({
      x: next.a.x + prev.inward.x * p + next.inward.x * q,
      y: next.a.y + prev.inward.y * p + next.inward.y * q,
    });
  }
  return out;
}

/** Evenly spread `pitch`-spaced centres across [lo, hi], rounding to a whole number of pitches so
 * the run starts and ends flush with the segment (no stub gap at either corner). Deterministic. */
function spreadAlong(lo: number, hi: number, pitch: number): number[] {
  const length = hi - lo;
  if (length <= 0 || pitch <= 0) return [];
  const count = Math.max(1, Math.round(length / pitch));
  const step = length / count;
  const out: number[] = [];
  for (let k = 0; k < count; k++) out.push(lo + (k + 0.5) * step);
  return out;
}

/** Dressing must stand on tiled GROUND. The only non-ground part of the polygon is the south water
 * band, which only the two downtown W/E walls reach — their colliders run through it (that is what
 * seals the ring's south corners), their visuals stop short of the shoreline. */
function isDressableGround(p: MapVertex): boolean {
  return p.y <= SHORE_Y - BARRIER.shoreClearanceWu;
}

function toWorld(p: MapVertex): WorldPoint {
  const [x, z] = mapToWorld(p);
  return { x, z };
}

/** `atan2(inwardX, inwardZ)` — see the file header's yaw convention. */
function yawFacing(inward: MapVertex): number {
  const [x, z] = mapToWorld(inward);
  return Math.atan2(x, z);
}

/** Map-space point on an edge: `along` is the coordinate on the edge's run axis, `depth` how far
 * inward of the polygon edge it sits. */
function pointOnEdge(edge: RawEdge, along: number, depth: number): MapVertex {
  const perp = edge.fixed + edge.inwardSign * depth;
  return edge.runAxis === 'x' ? { x: along, y: perp } : { x: perp, y: along };
}

// --- dead ends ---------------------------------------------------------------------------

/** The span-end token union from streets.ts's STREET_DEFS, referenced structurally so the token
 * grammar stays private to that module (it is deliberately not exported). */
type SpanEndToken = (typeof STREET_DEFS)[number]['span'][number];

/**
 * A token's resolved coordinate on the street's perpendicular axis — the same arithmetic
 * streets.ts's private `resolveEnd` does, re-derived from the SAME constants (ZONE_X_EXTENTS +
 * EDGE_PAD_WU, ZONE_BOUNDARIES[3]) rather than re-literalized. 'street' tokens read the built
 * street's own centreline, so no ordering assumption is needed.
 */
function tokenCoord(token: SpanEndToken, byId: ReadonlyMap<string, Street>): number | null {
  switch (token.t) {
    case 'lit':
      return token.v;
    case 'shore':
      return SHORE_Y;
    case 'shorePad':
      return SHORE_Y - EDGE_PAD_WU;
    case 'zone': {
      const [lo, hi] = ZONE_X_EXTENTS[token.zone];
      return token.side === 'lo' ? lo + EDGE_PAD_WU : hi - EDGE_PAD_WU;
    }
    case 'street':
      return byId.get(token.id)?.centerline ?? null;
  }
}

interface StreetEnd {
  readonly street: Street;
  readonly kind: SpanEndToken['t'];
  readonly point: MapVertex;
}

function streetEnds(streets: readonly Street[]): readonly StreetEnd[] {
  const byId = new Map(streets.map((s) => [s.id, s]));
  const ends: StreetEnd[] = [];
  for (const street of streets) {
    const def = STREET_DEFS.find((d) => d.id === street.id);
    if (!def) continue;
    for (const token of def.span) {
      const coord = tokenCoord(token, byId);
      if (coord === null) continue;
      const point: MapVertex =
        street.axis === 'ns' ? { x: street.centerline, y: coord } : { x: coord, y: street.centerline };
      ends.push({ street, kind: token.t, point });
    }
  }
  return ends;
}

/**
 * Which land edge (if any) a street end dies against. Requirements: the edge must be PERPENDICULAR
 * to the street (a parallel edge is the flush-ribbon case, handled by resolveInset), the end must
 * lie on the edge's INTERIOR side within BARRIER.deadEndProbeWu of it, and the end must fall
 * within the edge's own run. Closest match wins.
 *
 * 'shore' / 'shorePad' ends are rejected before this is called: they die on the lake, which has no
 * wall (locked) — closing them off would wall the player away from the water death.
 */
function edgeForDeadEnd(end: StreetEnd, edges: readonly RawEdge[]): RawEdge | null {
  if (end.kind === 'shore' || end.kind === 'shorePad' || end.kind === 'street') return null;
  const streetRunsAlong: 'x' | 'y' = end.street.axis === 'ew' ? 'x' : 'y';
  let best: RawEdge | null = null;
  let bestDepth = Infinity;
  for (const edge of edges) {
    if (edge.isWater) continue;
    if (edge.runAxis === streetRunsAlong) continue; // parallel — not a dead end
    const endPerp = edge.runAxis === 'x' ? end.point.y : end.point.x;
    const endAlong = edge.runAxis === 'x' ? end.point.x : end.point.y;
    const depth = edge.inwardSign * (endPerp - edge.fixed);
    if (depth <= 0 || depth > BARRIER.deadEndProbeWu) continue;
    if (endAlong < edge.range[0] - EPS || endAlong > edge.range[1] + EPS) continue;
    if (depth < bestDepth) {
      bestDepth = depth;
      best = edge;
    }
  }
  return best;
}

// --- the builder -------------------------------------------------------------------------

function computeWorldEdge(): WorldEdgeLayout {
  const rawEdges = buildRawEdges();
  const { streets } = buildStreets();

  const insets = rawEdges.map((edge) => resolveInset(edge, streets));
  const ring = insetVertices(rawEdges, insets);

  const edges: BarrierEdge[] = [];
  const colliders: BarrierCollider[] = [];
  const dressing: BarrierDressing[] = [];
  const halfThickness = BARRIER.colliderThicknessWu / 2;

  let waterEdge: BarrierWaterEdge | null = null;

  for (const edge of rawEdges) {
    const a = ring[edge.index];
    const b = ring[(edge.index + 1) % ring.length];
    if (edge.isWater) {
      // No wall on the lake (locked). Reported for the minimap's water-tone styling; the two
      // adjacent W/E walls already run down to `a`/`b`, so the ring's south CORNERS are closed
      // even though its south SIDE is open.
      waterEdge = { index: edge.index, start: toWorld(edge.a), end: toWorld(edge.b) };
      continue;
    }

    const theme = themeFor(edge);
    const inset = insets[edge.index];
    const alongA = edge.runAxis === 'x' ? a.x : a.y;
    const alongB = edge.runAxis === 'x' ? b.x : b.y;
    const alongLo = Math.min(alongA, alongB);
    const alongHi = Math.max(alongA, alongB);
    const length = alongHi - alongLo;

    edges.push({
      index: edge.index,
      theme,
      runAxis: edge.runAxis === 'x' ? 'x' : 'z',
      insetWu: inset,
      inward: toWorld(edge.inward),
      start: toWorld(a),
      end: toWorld(b),
      lengthWu: length,
    });

    // --- collider: the segment, extended by half a thickness at BOTH ends so adjacent boxes
    // overlap in a thickness x thickness square at every mitred corner (the ring is sealed).
    const centreAlong = (alongLo + alongHi) / 2;
    const centre = pointOnEdge(edge, centreAlong, inset);
    const halfAlong = length / 2 + halfThickness;
    const centreWorld = toWorld(centre);
    colliders.push({
      edgeIndex: edge.index,
      cx: centreWorld.x,
      cz: centreWorld.z,
      hx: edge.runAxis === 'x' ? halfAlong : halfThickness,
      hz: edge.runAxis === 'x' ? halfThickness : halfAlong,
    });

    // --- dressing.
    const yaw = yawFacing(edge.inward);
    const push = (kind: BarrierDressingKind, p: MapVertex): void => {
      if (!isDressableGround(p) || !pointInPolygon(p, PLAYABLE_POLYGON)) return;
      const w = toWorld(p);
      dressing.push({ kind, x: w.x, z: w.z, yawRad: yaw, edgeIndex: edge.index, streetId: null });
    };

    if (theme === 'fence' || theme === 'rail') {
      for (const along of spreadAlong(alongLo, alongHi, BARRIER.fence.pitchWu)) {
        push('fencePiece', pointOnEdge(edge, along, inset));
      }
    }
    if (theme === 'rail') {
      for (const along of spreadAlong(alongLo, alongHi, BARRIER.rail.postSpacingWu)) {
        push('railPost', pointOnEdge(edge, along, inset));
      }
    }
    if (theme === 'hoarding' || theme === 'notch') {
      const pitch = BARRIER.hoarding.panelWidthWu + BARRIER.hoarding.gapWu;
      for (const along of spreadAlong(alongLo, alongHi, pitch)) {
        push('hoardingPanel', pointOnEdge(edge, along, inset));
      }
    }
    if (theme === 'notch') {
      // Deterministic alternation instead of a scatter rng: every other cone steps one
      // BARRIER.notch.coneLateralOffsetWu further inward. Inward-only — these edges sit at the
      // 0.5 wu minimum inset, so an outward step would leave the polygon.
      const centres = spreadAlong(alongLo, alongHi, BARRIER.notch.conePitchWu);
      centres.forEach((along, k) => {
        const depth = inset + (k % 2 === 1 ? BARRIER.notch.coneLateralOffsetWu : 0);
        push('cone', pointOnEdge(edge, along, depth));
      });
    }
  }

  if (!waterEdge) {
    throw new Error('worldEdge: PLAYABLE_POLYGON has no south water edge — the §1 shape changed');
  }

  // --- dead-end "road closed" rows ---------------------------------------------------------
  const deadEnds: BarrierDeadEnd[] = [];
  const jerseyPitch = BARRIER.jersey.lengthWu + BARRIER.jersey.gapWu;
  for (const end of streetEnds(streets)) {
    const edge = edgeForDeadEnd(end, rawEdges);
    if (!edge) continue;
    const street = end.street;
    const width = ROAD_CLASSES[street.cls];
    // Inward ALONG the street: from this end toward the street's other end. The row is set back
    // BARRIER.jersey.rowInsetWu from the cut so the barriers stand fully on asphalt.
    const otherCoord =
      street.axis === 'ns'
        ? (Math.abs(end.point.y - street.span[0]) < Math.abs(end.point.y - street.span[1])
            ? street.span[1]
            : street.span[0])
        : (Math.abs(end.point.x - street.span[0]) < Math.abs(end.point.x - street.span[1])
            ? street.span[1]
            : street.span[0]);
    const endCoord = street.axis === 'ns' ? end.point.y : end.point.x;
    const sign = Math.sign(otherCoord - endCoord) || 1;
    const inward: MapVertex =
      street.axis === 'ns' ? { x: 0, y: sign } : { x: sign, y: 0 };
    const rowCentre =
      street.axis === 'ns'
        ? { x: end.point.x, y: endCoord + sign * BARRIER.jersey.rowInsetWu }
        : { x: endCoord + sign * BARRIER.jersey.rowInsetWu, y: end.point.y };
    const yaw = yawFacing(inward);
    const crossCentre = street.axis === 'ns' ? rowCentre.x : rowCentre.y;
    let count = 0;
    for (const cross of spreadAlong(crossCentre - width / 2, crossCentre + width / 2, jerseyPitch)) {
      const p: MapVertex =
        street.axis === 'ns' ? { x: cross, y: rowCentre.y } : { x: rowCentre.x, y: cross };
      // Drop anything that would interpenetrate the wall itself (only bites on the four
      // flush-ribbon edges, where the ring already occupies the road's outer wu).
      if (!pointInPolygon(p, PLAYABLE_POLYGON)) continue;
      if (distanceToBoundary(p, PLAYABLE_POLYGON) < BARRIER.jersey.edgeClearanceWu) continue;
      const w = toWorld(p);
      dressing.push({
        kind: 'jerseyBarrier',
        x: w.x,
        z: w.z,
        yawRad: yaw,
        edgeIndex: -1,
        streetId: street.id,
      });
      count += 1;
    }
    const endWorld = toWorld(end.point);
    deadEnds.push({
      streetId: street.id,
      edgeIndex: edge.index,
      x: endWorld.x,
      z: endWorld.z,
      roadWidthWu: width,
      barrierCount: count,
    });
  }

  return { edges, waterEdge, colliders, dressing, deadEnds };
}

let cached: WorldEdgeLayout | null = null;

/**
 * The whole world-edge layer. Pure and deterministic (no rng, no time, no fs) — memoized because
 * several consumers (scene colliders, batched dressing, the minimap) all want the same answer
 * within a frame. Determinism is proven across FRESH MODULE INSTANCES in worldEdge.test.ts, so the
 * memo can't hide a hidden input.
 */
export function buildWorldEdge(): WorldEdgeLayout {
  if (!cached) cached = computeWorldEdge();
  return cached;
}

/** Test/debug seam: drops the memo. Not used by the game. */
export function resetWorldEdgeCache(): void {
  cached = null;
}
