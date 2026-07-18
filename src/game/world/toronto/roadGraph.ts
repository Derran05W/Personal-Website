// The Toronto traffic graph + render ribbons (TORONTO-MAP-SPEC-v2.md §10.1, phase-22-plan
// Decisions). Emits the EXISTING world/types.ts TrafficGraph shape so it is drop-in
// shape-compatible with the legacy 64×64 world; ai/traffic consumption is deferred to the
// Phase 23 parity flip.
//
// Graph = intersection nodes wherever two centrelines cross inside both spans + waypoint nodes
// every ~WAYPOINT_SPACING_WU between adjacent stops (crossings and street ends), with directed
// edges both ways and an outEdges turn-choice index. Coordinates are WORLD-space via mapToWorld
// (map x→x, map y→z). tileIndex is -1 everywhere — a DOCUMENTED debt: there is no tile grid on
// this map, so nothing may read tileIndex until the Phase 23 parity flip wires one.
//
// Determinism: node ids come from sorting every unique node position by (x, then z); the graph
// is a pure function of the street table (no Math.random / Date).

import { ROAD_COLORS, WAYPOINT_SPACING_WU, type RoadClass } from '../../config/torontoMap';
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
 * Build the TrafficGraph. A private node registry keyed by quantized position lets a crossing
 * shared by two streets collapse to one node (upgraded to 'intersection'); waypoints between
 * stops stay distinct.
 */
export function buildTorontoRoadGraph(streets: readonly Street[]): TrafficGraph {
  const ns = streets.filter((s) => s.axis === 'ns');
  const ew = streets.filter((s) => s.axis === 'ew');
  const crossings = findCrossings(ns, ew);

  const nodeMap = new Map<string, { x: number; y: number; kind: TrafficNode['kind'] }>();
  const adjacency = new Map<string, Set<string>>();

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
  const link = (a: string, b: string): void => {
    if (a === b) return;
    (adjacency.get(a) ?? adjacency.set(a, new Set()).get(a)!).add(b);
    (adjacency.get(b) ?? adjacency.set(b, new Set()).get(b)!).add(a);
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

    for (let i = 0; i < stops.length; i++) {
      const v = stops[i];
      const p = toXY(v);
      const key = upsert(p.x, p.y, isCross(v) ? 'intersection' : 'waypoint');
      if (i === 0) continue;
      // subdivide the segment from the previous stop into ~WAYPOINT_SPACING_WU steps
      const prevV = stops[i - 1];
      const prevP = toXY(prevV);
      let prevKey = upsert(prevP.x, prevP.y, isCross(prevV) ? 'intersection' : 'waypoint');
      const d = Math.abs(v - prevV);
      const segs = Math.max(1, Math.round(d / WAYPOINT_SPACING_WU));
      for (let j = 1; j < segs; j++) {
        const vv = prevV + ((v - prevV) * j) / segs;
        const wp = toXY(vv);
        const wKey = upsert(wp.x, wp.y, 'waypoint');
        link(prevKey, wKey);
        prevKey = wKey;
      }
      link(prevKey, key);
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
    const neighbours = [...(adjacency.get(keys[i]) ?? [])].map((k) => idOf.get(k)!).sort((a, b) => a - b);
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
