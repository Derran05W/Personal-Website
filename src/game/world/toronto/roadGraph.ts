// The Toronto traffic graph + render ribbons (TORONTO-MAP-SPEC-v2.md §10.1, phase-22-plan
// Decisions). Emits the EXISTING world/types.ts TrafficGraph shape so it is drop-in
// shape-compatible with the legacy 64×64 world; ai/traffic consumption is deferred to the
// Phase 23 parity flip.
//
// Graph = shared, UNOFFSET hub nodes wherever two centrelines cross (or a street simply ends)
// + TWO direction-offset waypoint chains per street between adjacent hubs — one per travel
// direction, laterally offset toward its right-hand side (LANE_OFFSET_WU, config/torontoMap.ts)
// — with DIRECTED edges only (never both ways over the same nodes) and an outEdges turn-choice
// index. Coordinates are WORLD-space via mapToWorld (map x→x, map y→z). tileIndex is -1
// everywhere — a DOCUMENTED debt: there is no tile grid on this map, so nothing may read
// tileIndex until the Phase 23 parity flip wires one.
//
// PHASE 31 LANE-OFFSET FIX (Part-8, live-diagnosed head-on jam): before this, the graph emitted
// ONE waypoint chain per street with edges laid both ways over the SAME nodes, so opposing
// civilian traffic met head-on in the same lane (a 14-car jam wall proven live on Yonge, x=1500
// z 247-285). Fix model: hubs (intersections AND a street's own dead-end stops) stay exactly as
// before — ONE shared, unoffset node per crossing, so turns/BFS connectivity are untouched — but
// the waypoints BETWEEN two adjacent hubs now come in two direction-specific, laterally offset
// chains, each carrying edges in ONLY that direction. A hub therefore gets an incoming edge from
// each chain arriving at it and an outgoing edge to each chain departing it (its own street's
// continuation in both directions, plus — at a real intersection — the crossing street's two
// chains), which is exactly the turn choice set the old single-chain graph offered, just now
// direction-safe. At a genuine dead end (no crossing street) the hub still gets an outgoing edge
// for free, from the return/reverse chain's own start — a natural U-turn, and the reason no node
// is ever left with zero out-edges (torontoTraffic.test.ts's no-sink-nodes invariant).
// Right-hand traffic convention (matches ai/traffic.ts's rightOf(dir) exactly): southbound (map
// +y) offsets toward x-offset (west); northbound toward x+offset (east); eastbound (map +x)
// toward y+offset (south); westbound toward y-offset (north).
//
// Every inter-hub gap is subdivided into AT LEAST 2 steps per direction (never 1, i.e. never a
// bare hub-to-hub edge) specifically so that even the shortest gaps in the map (the rail-lands
// cluster's ~7.5 wu King/Front/Bremner/Queens-Quay corner) still get a real, laterally-offset
// waypoint between the two directions — a direct hub-to-hub link would have no lane separation
// at all and reintroduce the exact same head-on bug on that one block. See roadGraph.test.ts's
// waypoint-spacing test for the resulting (documented, expected) short edges this produces.
//
// Determinism: node ids come from sorting every unique node position by (x, then z); the graph
// is a pure function of the street table (no Math.random / Date).

import { LANE_OFFSET_WU, ROAD_COLORS, WAYPOINT_SPACING_WU, type RoadClass } from '../../config/torontoMap';
import { mapToWorld, type MapPoint } from './projection';
import type { Street } from './streets';
import type { TrafficEdge, TrafficGraph, TrafficNode } from '../types';

/** A road ribbon for the scene: a WORLD-space axis-aligned rect + its class and colour. */
export interface Ribbon {
  readonly streetId: string;
  readonly cls: RoadClass;
  /** Resolved from ROAD_COLORS[cls] — carried so the scene needs no config lookup. */
  readonly color: string;
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
}

const CROSS_EPS = 1e-6;
// Quantum for de-duplicating coincident node positions (shared crossings). 1e-3 wu ≪ the
// smallest real inter-node gap (~12.5 wu), so it only ever merges truly-coincident points.
const KEY_Q = 1e3;

interface Crossing {
  readonly x: number;
  readonly y: number;
  readonly nsId: string;
  readonly ewId: string;
}

/** All centreline crossings that fall inside BOTH streets' spans. */
function findCrossings(ns: readonly Street[], ew: readonly Street[]): Crossing[] {
  const out: Crossing[] = [];
  for (const a of ns) {
    for (const b of ew) {
      const x = a.centerline;
      const y = b.centerline;
      const onEw = x >= b.span[0] - CROSS_EPS && x <= b.span[1] + CROSS_EPS;
      const onNs = y >= a.span[0] - CROSS_EPS && y <= a.span[1] + CROSS_EPS;
      if (onEw && onNs) out.push({ x, y, nsId: a.id, ewId: b.id });
    }
  }
  return out;
}

/** One street crossing: MAP-space position (x, y — same convention as Street.centerline/span,
 * NOT world/mapToWorld'd) + both streets' ids and classes. Phase 25.6 (D16): the public surface
 * `findCrossings` never had — furniture.ts (traffic-light/stop-sign placement rules) and the
 * road-paint builder (crosswalks, dash-skip) both key off this. */
export interface Intersection {
  readonly x: number;
  readonly y: number;
  readonly nsId: string;
  readonly ewId: string;
  readonly nsCls: RoadClass;
  readonly ewCls: RoadClass;
}

/** Every street-centreline crossing, MAP-space, in a stable deterministic order (sorted by x
 * then y — same convention buildTorontoRoadGraph uses for node ids). Pure function of the
 * street table; no randomness. */
export function listIntersections(streets: readonly Street[]): readonly Intersection[] {
  const ns = streets.filter((s) => s.axis === 'ns');
  const ew = streets.filter((s) => s.axis === 'ew');
  const streetById = new Map(streets.map((s) => [s.id, s]));
  return findCrossings(ns, ew)
    .map((c): Intersection => ({
      x: c.x,
      y: c.y,
      nsId: c.nsId,
      ewId: c.ewId,
      nsCls: streetById.get(c.nsId)!.cls,
      ewCls: streetById.get(c.ewId)!.cls,
    }))
    .sort((a, b) => a.x - b.x || a.y - b.y);
}

const keyOf = (x: number, y: number): string => `${Math.round(x * KEY_Q)}:${Math.round(y * KEY_Q)}`;

/**
 * Minimum steps to subdivide one inter-hub gap into, PER DIRECTION (never 1 — see file header:
 * a bare hub-to-hub edge has no lane separation, so every gap gets at least one interior,
 * laterally-offset waypoint even when it's shorter than a full WAYPOINT_SPACING_WU step).
 */
const MIN_SEGS = 2;

/**
 * Build the TrafficGraph. A private node registry keyed by quantized position lets a crossing
 * shared by two streets collapse to one shared, UNOFFSET hub node (upgraded to 'intersection'
 * the moment any street sees it as a real crossing); the waypoints BETWEEN hubs are direction-
 * offset and directed-only (see file header — this is the Phase 31 lane-offset fix).
 */
export function buildTorontoRoadGraph(streets: readonly Street[]): TrafficGraph {
  const ns = streets.filter((s) => s.axis === 'ns');
  const ew = streets.filter((s) => s.axis === 'ew');
  const crossings = findCrossings(ns, ew);

  const nodeMap = new Map<string, { x: number; y: number; kind: TrafficNode['kind'] }>();
  // Directed adjacency: outAdj.get(fromKey) is the set of toKeys reachable by ONE edge. Unlike
  // the pre-Phase-31 `link()`, this never adds the reverse automatically.
  const outAdj = new Map<string, Set<string>>();

  const upsert = (x: number, y: number, kind: TrafficNode['kind']): string => {
    const k = keyOf(x, y);
    const existing = nodeMap.get(k);
    if (existing) {
      if (kind === 'intersection') existing.kind = 'intersection';
      return k;
    }
    nodeMap.set(k, { x, y, kind });
    return k;
  };
  const addDirected = (from: string, to: string): void => {
    if (from === to) return;
    (outAdj.get(from) ?? outAdj.set(from, new Set()).get(from)!).add(to);
  };

  for (const street of streets) {
    const [lo, hi] = street.span;
    // crossing coordinates along THIS street (y for an 'ns' street, x for an 'ew' street)
    const crossVals = crossings
      .filter((c) => (street.axis === 'ns' ? c.nsId === street.id : c.ewId === street.id))
      .map((c) => (street.axis === 'ns' ? c.y : c.x));
    const crossSet = new Set(crossVals.map((v) => Math.round(v * KEY_Q)));
    const isCross = (v: number): boolean => crossSet.has(Math.round(v * KEY_Q));

    // ordered, de-duplicated stops: the two ends + every crossing on the street
    const stops = [...new Set([lo, hi, ...crossVals].map((v) => Math.round(v * KEY_Q) / KEY_Q))].sort(
      (p, q) => p - q,
    );

    const toXY = (v: number): MapPoint => (street.axis === 'ns' ? { x: street.centerline, y: v } : { x: v, y: street.centerline });
    // Shared, unoffset hub for stop value v — an intersection if some cross street lands here,
    // else this street's own dead-end. Idempotent (upsert), so calling it twice for the same v
    // (once as a segment's "next", once as the following segment's "prev") is harmless.
    const hubKey = (v: number): string => {
      const p = toXY(v);
      return upsert(p.x, p.y, isCross(v) ? 'intersection' : 'waypoint');
    };

    // Right-hand-traffic lane offset (matches ai/traffic.ts's rightOf(dir) — see file header):
    // increasing v is south for an 'ns' street (offset toward -x, west) or east for an 'ew'
    // street (offset toward +y, south); decreasing v is the mirror.
    const forwardSign = street.axis === 'ns' ? -1 : 1;
    const reverseSign = -forwardSign;
    const laneOffset = LANE_OFFSET_WU[street.cls];
    const offsetXY = (v: number, sign: number): MapPoint =>
      street.axis === 'ns'
        ? { x: street.centerline + sign * laneOffset, y: v }
        : { x: v, y: street.centerline + sign * laneOffset };

    for (let i = 1; i < stops.length; i++) {
      const prevV = stops[i - 1];
      const v = stops[i];
      const hubPrev = hubKey(prevV);
      const hubNext = hubKey(v);
      const d = v - prevV; // stops is sorted ascending, so always > 0
      const segs = Math.max(MIN_SEGS, Math.round(d / WAYPOINT_SPACING_WU));

      // Forward chain: hubPrev -> ... -> hubNext, offset to forwardSign's side, directed only
      // in the direction of increasing v.
      let cursor = hubPrev;
      for (let j = 1; j < segs; j++) {
        const vv = prevV + ((v - prevV) * j) / segs;
        const wp = offsetXY(vv, forwardSign);
        const wKey = upsert(wp.x, wp.y, 'waypoint');
        addDirected(cursor, wKey);
        cursor = wKey;
      }
      addDirected(cursor, hubNext);

      // Reverse chain: hubNext -> ... -> hubPrev, offset to reverseSign's (opposite) side,
      // directed only in the direction of decreasing v. Distinct nodes from the forward chain
      // (opposite lateral offset at the same along-axis position), so no edge here can ever be
      // the reverse of a forward-chain edge.
      cursor = hubNext;
      for (let j = segs - 1; j >= 1; j--) {
        const vv = prevV + ((v - prevV) * j) / segs;
        const wp = offsetXY(vv, reverseSign);
        const wKey = upsert(wp.x, wp.y, 'waypoint');
        addDirected(cursor, wKey);
        cursor = wKey;
      }
      addDirected(cursor, hubPrev);
    }
  }

  // Stable node ids: sort every unique position by (x, then y).
  const keys = [...nodeMap.keys()].sort((a, b) => {
    const na = nodeMap.get(a)!;
    const nb = nodeMap.get(b)!;
    return na.x - nb.x || na.y - nb.y;
  });
  const idOf = new Map<string, number>(keys.map((k, i) => [k, i]));

  const nodes: TrafficNode[] = keys.map((k, i) => {
    const n = nodeMap.get(k)!;
    const [wx, wz] = mapToWorld({ x: n.x, y: n.y });
    return { id: i, x: wx, z: wz, kind: n.kind, tileIndex: -1 };
  });

  const edges: TrafficEdge[] = [];
  const outEdges: number[][] = nodes.map(() => []);
  for (let i = 0; i < keys.length; i++) {
    const neighbours = [...(outAdj.get(keys[i]) ?? [])].map((k) => idOf.get(k)!).sort((a, b) => a - b);
    for (const to of neighbours) {
      outEdges[i].push(edges.length);
      edges.push({ from: i, to });
    }
  }

  return { nodes, edges, outEdges };
}

/** World-space render ribbons — one per street (map ribbon → world via mapToWorld). */
export function buildRibbons(streets: readonly Street[]): Ribbon[] {
  return streets.map((street) => {
    const [minX, minZ] = mapToWorld({ x: street.ribbon.minX, y: street.ribbon.minY });
    const [maxX, maxZ] = mapToWorld({ x: street.ribbon.maxX, y: street.ribbon.maxY });
    return {
      streetId: street.id,
      cls: street.cls,
      color: ROAD_COLORS[street.cls],
      minX,
      minZ,
      maxX,
      maxZ,
    };
  });
}
