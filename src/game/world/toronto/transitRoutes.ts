// Phase 31 (Part-8 D1/D2, T1) — build-time route -> polyline resolver for the TTC-homage
// transit roster. Pure TS: no three/react, no fs at runtime (mirrors world/toronto/streets.ts's
// own span-reference resolution exactly — every endpoint is a RESOLVED REFERENCE against the
// street table, never a magic map-space number).
//
// data/toronto/transit-routes.json (schema-gated by data.ts/data.test.ts) is imported directly
// at runtime — the SAME approved deviation namedBuildings.ts/heroes.ts already take for
// building-specs.json ("the game genuinely consumes the spec at runtime now"): the file is a
// few KB and the resolved routes are load-bearing gameplay data (roster polylines), not a
// research-bookkeeping artifact.
//
// Each route's segments reference OTHER streets by id as endpoint tokens ("start"/"end" or a
// cross-street id) — resolved the same way streets.ts resolves its own SpanEnd tokens: given the
// full street table, a cross-street reference's centreline gives the along-coordinate where the
// two cross. This is why every one of the 15 routes in the data file needed NO new literal
// coordinates: 97 Yonge's Queens Quay/Finch clip, the Finch/Sheppard Yonge-splits, and every
// streetcar's downtown-block span all fall straight out of streets.ts's existing table.
//
// PHASE 31 LANE-OFFSET FIX (Part-8, live-diagnosed wrong-way bug): a BUS route used to resolve to
// ONE open polyline at a single fixed kerb offset, driven there-and-back (ai/streetcarTraffic.ts's
// 'bounce' cursor mode) — so the return leg drove the SAME physical lane as the outbound leg,
// which is the oncoming lane from the return direction's point of view (a kinematic body is
// immovable, so the player/civs pinned dead behind a wrong-way bus — proven live on Yonge).
// A bus route now resolves to a CLOSED LOOP (resolveBusLoop below): the outbound leg rides each
// segment's direction-correct lane (LANE_OFFSET_WU, config/torontoMap.ts — the SAME right-hand
// civilian lane geometry roadGraph.ts's traffic graph uses, via laneSignForSegment), the return
// leg re-walks the same segments in reverse order/direction (so its lane is automatically the
// OPPOSITE side), and the two legs join at both tips — the path's own last point closes back onto
// its first. ai/streetcarTraffic.ts's new 'loop' cursor mode (AvenueCursorMode) wraps a bus
// forward through this forever, never reflecting into what would be the oncoming lane.
// STREETCARS are deliberately UNCHANGED: they still resolve via resolveRoute to a single OPEN
// centreline polyline (TORONTO_TRANSIT_OFFSET.streetcarOffsetWu, 0 — the P19 "implacable median"
// design) and still drive it there-and-back ('bounce', the controller's default) — a real
// streetcar ROW is a single shared track, not a two-lane road, so there is no "wrong lane" to fix.

import transitRoutesJson from '../../../../data/toronto/transit-routes.json';
import { LANE_OFFSET_WU } from '../../config/torontoMap';
import { TORONTO_TRANSIT_OFFSET } from '../../config/torontoTransit';
import type { TransitMode, TransitRoute, TransitRouteSegment, TransitRoutesFile } from './data';
import { mapToWorld, type MapPoint } from './projection';
import { buildStreets, type Street, type StreetAxis } from './streets';

const EPS = 1e-6;

/** One resolved segment: the street it rides + its along-street span (map-space, min <= max —
 * see Street.span's own convention), BEFORE any perpendicular mode offset. Exposed separately
 * from `mapPoints` (below) because furniture.ts's route-derived bus-stop eligibility (D5) needs
 * the raw along-street coverage, not the offset polyline. */
export interface ResolvedTransitSegment {
  readonly streetId: string;
  readonly lo: number;
  readonly hi: number;
}

export interface ResolvedTransitRoute {
  readonly id: string;
  readonly name: string;
  readonly mode: TransitMode;
  readonly note: string;
  readonly segments: readonly ResolvedTransitSegment[];
  /** Map-space polyline in travel order (>= 2 points). A BUS route's polyline is a CLOSED LOOP
   * (direction-correct LANE_OFFSET_WU lane out, the opposite lane back, joined at both tips —
   * see this file's header); a STREETCAR route's polyline is an OPEN centreline (0 offset),
   * driven there-and-back by the controller's default 'bounce' cursor mode. */
  readonly mapPoints: readonly MapPoint[];
}

/** Along-street coordinate (map space) for an endpoint token: the street's own span bound
 * ("start"/"end"), or — for any other token — the id of a PERPENDICULAR street, whose
 * centreline gives the crossing coordinate (exactly streets.ts's own SpanEnd 'street' case). */
function resolveEndpointAlong(
  street: Street,
  token: string,
  streetById: ReadonlyMap<string, Street>,
  routeId: string,
): number {
  if (token === 'start') return street.span[0];
  if (token === 'end') return street.span[1];
  const cross = streetById.get(token);
  if (!cross) {
    throw new Error(
      `transitRoutes: route "${routeId}" segment on street "${street.id}" references unknown endpoint/street id "${token}"`,
    );
  }
  if (cross.axis === street.axis) {
    throw new Error(
      `transitRoutes: route "${routeId}" segment on street "${street.id}" references "${token}", which shares its axis (expected a perpendicular cross-street)`,
    );
  }
  return cross.centerline;
}

/** Point at along-street coordinate `along` on `street`, offset `perpWu` perpendicular to the
 * centreline (same convention as furniture.ts's pointAlong / roadGraph.ts's toXY). */
function pointAt(street: Street, along: number, perpWu: number): MapPoint {
  return street.axis === 'ns' ? { x: street.centerline + perpWu, y: along } : { x: along, y: street.centerline + perpWu };
}

/**
 * Right-hand-traffic lane sign for one directed segment traversal, MATCHING roadGraph.ts's own
 * civilian lane-offset convention EXACTLY (see that file's header comment): increasing
 * along-value is "forward" — south for an 'ns' street, east for an 'ew' street — and offsets
 * toward forwardSign's side; decreasing along-value (travelling the other way) is the mirror.
 * Exported for direct unit testing (Phase 31 wrong-way regression — transitRoutes.test.ts).
 */
export function laneSignForSegment(axis: StreetAxis, fromAlong: number, toAlong: number): number {
  const forwardSign = axis === 'ns' ? -1 : 1;
  return toAlong >= fromAlong ? forwardSign : -forwardSign;
}

/** Push `a` (deduped against the last pushed point) then `b` (always) — the shared polyline-
 * building step both resolveRoute (streetcar, constant offset) and resolveBusLoop (per-segment,
 * direction-signed offset) use. */
function emitSegmentPoints(points: MapPoint[], a: MapPoint, b: MapPoint): void {
  const last = points[points.length - 1];
  if (last === undefined || Math.hypot(last.x - a.x, last.y - a.y) > EPS) points.push(a);
  points.push(b);
}

function resolveSegment(
  routeId: string,
  seg: TransitRouteSegment,
  streetById: ReadonlyMap<string, Street>,
): { street: Street; fromAlong: number; toAlong: number } {
  const street = streetById.get(seg.street);
  if (!street) {
    throw new Error(`transitRoutes: route "${routeId}" references unknown street id "${seg.street}"`);
  }
  const clamp = (v: number): number => Math.max(street.span[0], Math.min(street.span[1], v));
  const fromAlong = clamp(resolveEndpointAlong(street, seg.from, streetById, routeId));
  const toAlong = clamp(resolveEndpointAlong(street, seg.to, streetById, routeId));
  return { street, fromAlong, toAlong };
}

/** STREETCAR resolution — UNCHANGED by the Phase 31 lane fix (see this file's header): a single
 * OPEN polyline at a constant perpendicular offset (TORONTO_TRANSIT_OFFSET.streetcarOffsetWu, 0
 * — the true centreline), walked there-and-back by the controller's default 'bounce' mode. */
function resolveRoute(route: TransitRoute, streetById: ReadonlyMap<string, Street>): ResolvedTransitRoute {
  const perp = TORONTO_TRANSIT_OFFSET.streetcarOffsetWu;
  const segments: ResolvedTransitSegment[] = [];
  const points: MapPoint[] = [];

  for (const seg of route.segments) {
    const { street, fromAlong, toAlong } = resolveSegment(route.id, seg, streetById);
    segments.push({ streetId: street.id, lo: Math.min(fromAlong, toAlong), hi: Math.max(fromAlong, toAlong) });
    emitSegmentPoints(points, pointAt(street, fromAlong, perp), pointAt(street, toAlong, perp));
  }

  if (points.length < 2) {
    throw new Error(`transitRoutes: route "${route.id}" resolved to a degenerate polyline (<2 points)`);
  }

  return { id: route.id, name: route.name, mode: route.mode, note: route.note, segments, mapPoints: points };
}

/**
 * BUS resolution (Phase 31 lane fix — see this file's header): a CLOSED LOOP. The outbound leg
 * walks `route.segments` in order, each on its own direction-correct LANE_OFFSET_WU lane
 * (laneSignForSegment); the return leg walks the SAME segments in reverse order with `from`/`to`
 * swapped (so laneSignForSegment naturally resolves to the opposite side — no separate "reverse
 * sign" branch needed); the loop closes by appending a final copy of the very first point once
 * the return leg's last point stops short of it (the near-tip join — the far-tip join happens
 * for free where the outbound's last point meets the return's first point, same along-coordinate,
 * opposite lane).
 *
 * `segments` (the public along-street coverage furniture.ts's bus-stop eligibility, D5, reads) is
 * populated from the OUTBOUND leg only — the return leg rides the identical streets/spans, so
 * doubling it would add no new coverage, only duplicate ranges.
 */
function resolveBusLoop(route: TransitRoute, streetById: ReadonlyMap<string, Street>): ResolvedTransitRoute {
  const resolved = route.segments.map((seg) => resolveSegment(route.id, seg, streetById));
  const segments: ResolvedTransitSegment[] = resolved.map(({ street, fromAlong, toAlong }) => ({
    streetId: street.id,
    lo: Math.min(fromAlong, toAlong),
    hi: Math.max(fromAlong, toAlong),
  }));

  const points: MapPoint[] = [];
  const emit = (street: Street, fromAlong: number, toAlong: number): void => {
    const offset = laneSignForSegment(street.axis, fromAlong, toAlong) * LANE_OFFSET_WU[street.cls];
    emitSegmentPoints(points, pointAt(street, fromAlong, offset), pointAt(street, toAlong, offset));
  };

  for (const r of resolved) emit(r.street, r.fromAlong, r.toAlong); // outbound, segment order
  for (let i = resolved.length - 1; i >= 0; i--) {
    const r = resolved[i];
    emit(r.street, r.toAlong, r.fromAlong); // return: reverse order + reversed direction
  }

  // Close the loop back to its own start (the near-tip join).
  const first = points[0];
  const last = points[points.length - 1];
  if (first !== undefined && last !== undefined && Math.hypot(last.x - first.x, last.y - first.y) > EPS) {
    points.push({ x: first.x, y: first.y });
  }

  if (points.length < 2) {
    throw new Error(`transitRoutes: route "${route.id}" resolved to a degenerate polyline (<2 points)`);
  }

  return { id: route.id, name: route.name, mode: route.mode, note: route.note, segments, mapPoints: points };
}

/** Every route in data/toronto/transit-routes.json, resolved against the CURRENT street table
 * (world/toronto/streets.ts's buildStreets() — itself a pure function of anchors.json + config,
 * so this recomputes cleanly if either ever changes). Pure, deterministic, no caching (matches
 * every other Toronto builder's convention — buildFurniture/buildDistricts etc. all recompute
 * fresh per call). Throws loudly (an unknown street/endpoint id, or a same-axis cross-reference)
 * rather than silently dropping a malformed route — transit-routes.json's structure is
 * code-adjacent data (D1), not agent-patched research data, so a bad edit should fail CI.
 */
export function buildTransitRoutes(): readonly ResolvedTransitRoute[] {
  const { streets } = buildStreets();
  const streetById = new Map(streets.map((s) => [s.id, s]));
  const file = transitRoutesJson as TransitRoutesFile;
  return file.routes.map((route) => (route.mode === 'bus' ? resolveBusLoop(route, streetById) : resolveRoute(route, streetById)));
}

/** World-space (mapToWorld'd) version of a resolved route's polyline — the exact shape
 * ai/streetcarTraffic.ts's AvenuePath needs ({x, z} points). */
export function routeWorldPoints(route: ResolvedTransitRoute): { x: number; z: number }[] {
  return route.mapPoints.map((p) => {
    const [x, z] = mapToWorld(p);
    return { x, z };
  });
}

export interface BusRouteCoverage {
  readonly streetId: string;
  readonly lo: number;
  readonly hi: number;
}

/** Map-space along-street coverage ranges for every BUS route's segments only (D5: route-derived
 * bus stops — streetcars are a different vehicle class with no stop furniture wired this phase).
 * Consumed by world/toronto/furniture.ts's bus-stop row eligibility. */
export function busRouteStreetCoverage(routes: readonly ResolvedTransitRoute[] = buildTransitRoutes()): readonly BusRouteCoverage[] {
  const out: BusRouteCoverage[] = [];
  for (const route of routes) {
    if (route.mode !== 'bus') continue;
    for (const seg of route.segments) out.push({ streetId: seg.streetId, lo: seg.lo, hi: seg.hi });
  }
  return out;
}

/** True if along-street coordinate `along` on `streetId` falls inside ANY bus route's coverage
 * (D5's exact eligibility test — furniture.ts calls this per candidate stop). */
export function isOnBusRoute(streetId: string, along: number, coverage: readonly BusRouteCoverage[]): boolean {
  return coverage.some((c) => c.streetId === streetId && along >= c.lo && along <= c.hi);
}
