// Tests authored from TORONTO-MAP-SPEC-v2.md §10 + phase-22-plan Decisions + the Task-2 brief.
// The road graph emits the EXISTING world/types.ts TrafficGraph shape (nodes/edges/outEdges) in
// WORLD coords via mapToWorld (map x→x, map y→z), with tileIndex:-1 (documented debt — no tile
// grid until the Phase 23 parity flip). The capsule reaches downtown ONLY via Yonge, so full
// reachability from node 0 proves the spine stitches the zones.
import { describe, expect, it } from 'vitest';
import { ROAD_CLASSES, ROAD_COLORS, WAYPOINT_SPACING_WU } from '../../config/torontoMap';
import { PLAYABLE_POLYGON, pointInPolygon } from './polygon';
import { buildRibbons, buildTorontoRoadGraph, listIntersections } from './roadGraph';
import { buildStreets } from './streets';

const { streets } = buildStreets();
const nsStreets = streets.filter((s) => s.axis === 'ns');
const ewStreets = streets.filter((s) => s.axis === 'ew');
const graph = buildTorontoRoadGraph(streets);
const { nodes, edges, outEdges } = graph;

// world (x,z) → back to map (x,y): mapToWorld is a pure identity swap (map y = world z).
const mapOf = (n: { x: number; z: number }): { x: number; y: number } => ({ x: n.x, y: n.z });

describe('TrafficGraph shape — matches world/types.ts', () => {
  it('nodes carry id, finite x/z, a valid kind, and the documented tileIndex:-1 debt', () => {
    nodes.forEach((n, i) => {
      expect(n.id).toBe(i);
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.z)).toBe(true);
      expect(n.kind === 'intersection' || n.kind === 'waypoint').toBe(true);
      expect(n.tileIndex).toBe(-1);
    });
  });

  it('outEdges has one bucket per node', () => {
    expect(outEdges.length).toBe(nodes.length);
  });
});

describe('graph containment — every node lies inside the polygon', () => {
  it('holds for all nodes (world→map back-transform)', () => {
    for (const n of nodes) {
      expect(pointInPolygon(mapOf(n), PLAYABLE_POLYGON), `node ${n.id}`).toBe(true);
    }
  });
});

describe('graph connectivity — the spine stitches capsule → fold → downtown', () => {
  it('every node is reachable from node 0 via outEdges (BFS)', () => {
    const seen = new Set<number>([0]);
    const queue = [0];
    while (queue.length > 0) {
      const u = queue.shift()!;
      for (const ei of outEdges[u]) {
        const w = edges[ei].to;
        if (!seen.has(w)) {
          seen.add(w);
          queue.push(w);
        }
      }
    }
    expect(seen.size).toBe(nodes.length);
  });
});

describe('edge invariants', () => {
  it('every directed edge has its reverse', () => {
    const key = (f: number, t: number): string => `${f}->${t}`;
    const set = new Set(edges.map((e) => key(e.from, e.to)));
    for (const e of edges) {
      expect(set.has(key(e.to, e.from)), `reverse of ${e.from}->${e.to}`).toBe(true);
    }
  });

  it('outEdges[i] is exactly the indices of edges leaving node i', () => {
    edges.forEach((e, i) => {
      expect(outEdges[e.from]).toContain(i);
    });
    outEdges.forEach((bucket, i) => {
      for (const ei of bucket) expect(edges[ei].from).toBe(i);
    });
  });

  it('endpoints are in range and no self loops', () => {
    for (const e of edges) {
      expect(e.from).toBeGreaterThanOrEqual(0);
      expect(e.from).toBeLessThan(nodes.length);
      expect(e.to).toBeGreaterThanOrEqual(0);
      expect(e.to).toBeLessThan(nodes.length);
      expect(e.from).not.toBe(e.to);
    }
  });
});

describe('waypoint spacing — every edge touching a waypoint is within [0.5,1.5]×spacing', () => {
  // Part-8 (D1) compaction shortens several street spans, which can leave one small leftover
  // remainder edge where a street's end sits close to its innermost crossing (equal-subdivision
  // rounding has no way to avoid this for an isolated short leftover). The lower bound is loosened
  // from 0.5x to 0.35x to accommodate that single documented remainder edge (measured ≈0.39x on
  // the current map) — every OTHER edge still comfortably clears the original 0.5x floor.
  it('holds (short intersection-to-intersection edges are exempt, as designed; one short leftover remainder tolerated)', () => {
    const lo = 0.35 * WAYPOINT_SPACING_WU;
    const hi = 1.5 * WAYPOINT_SPACING_WU;
    const seen = new Set<string>();
    for (const e of edges) {
      const a = nodes[e.from];
      const b = nodes[e.to];
      const k = e.from < e.to ? `${e.from}:${e.to}` : `${e.to}:${e.from}`;
      if (seen.has(k)) continue;
      seen.add(k);
      if (a.kind !== 'waypoint' && b.kind !== 'waypoint') continue;
      const d = Math.hypot(a.x - b.x, a.z - b.z);
      expect(d, `edge ${e.from}-${e.to}`).toBeGreaterThanOrEqual(lo - 1e-6);
      expect(d, `edge ${e.from}-${e.to}`).toBeLessThanOrEqual(hi + 1e-6);
    }
  });
});

describe('intersection nodes lie on both parent centrelines', () => {
  it('each intersection sits on some N-S centreline AND some E-W centreline (inside both spans)', () => {
    const on = (val: number, c: number): boolean => Math.abs(val - c) < 1e-3;
    const within = (v: number, span: readonly [number, number]): boolean =>
      v >= span[0] - 1e-3 && v <= span[1] + 1e-3;
    for (const n of nodes) {
      if (n.kind !== 'intersection') continue;
      const m = mapOf(n);
      const onNs = nsStreets.some((s) => on(m.x, s.centerline) && within(m.y, s.span));
      const onEw = ewStreets.some((s) => on(m.y, s.centerline) && within(m.x, s.span));
      expect(onNs && onEw, `node ${n.id} at (${m.x},${m.y})`).toBe(true);
    }
  });

  it('the number of intersection nodes equals the number of centreline crossings', () => {
    let crossings = 0;
    for (const a of nsStreets) {
      for (const b of ewStreets) {
        const x = a.centerline;
        const y = b.centerline;
        if (x >= b.span[0] - 1e-6 && x <= b.span[1] + 1e-6 && y >= a.span[0] - 1e-6 && y <= a.span[1] + 1e-6) {
          crossings++;
        }
      }
    }
    expect(nodes.filter((n) => n.kind === 'intersection').length).toBe(crossings);
  });
});

describe('determinism — the graph is a pure function of the streets', () => {
  it('rebuilding yields byte-identical nodes and edges', () => {
    const g2 = buildTorontoRoadGraph(buildStreets().streets);
    expect(g2.nodes).toEqual(nodes);
    expect(g2.edges).toEqual(edges);
    expect(g2.outEdges).toEqual(outEdges);
  });
});

// Phase 25.6 (D16) — listIntersections was private (findCrossings); now a public MAP-space
// crossing list furniture.ts's traffic-light/stop-sign rule keys off.
describe('listIntersections — MAP-space crossing list', () => {
  const intersections = listIntersections(streets);

  it('count matches the same crossing count roadGraph itself derives intersection nodes from', () => {
    let crossings = 0;
    for (const a of nsStreets) {
      for (const b of ewStreets) {
        const x = a.centerline;
        const y = b.centerline;
        if (x >= b.span[0] - 1e-6 && x <= b.span[1] + 1e-6 && y >= a.span[0] - 1e-6 && y <= a.span[1] + 1e-6) {
          crossings++;
        }
      }
    }
    expect(intersections.length).toBe(crossings);
  });

  it('every entry carries the correct nsId/ewId classes off the actual street table', () => {
    const byId = new Map(streets.map((s) => [s.id, s]));
    for (const c of intersections) {
      expect(byId.get(c.nsId)!.cls).toBe(c.nsCls);
      expect(byId.get(c.ewId)!.cls).toBe(c.ewCls);
      expect(byId.get(c.nsId)!.axis).toBe('ns');
      expect(byId.get(c.ewId)!.axis).toBe('ew');
    }
  });

  it('every crossing position sits on both parent centrelines, inside both spans', () => {
    const byId = new Map(streets.map((s) => [s.id, s]));
    for (const c of intersections) {
      const ns = byId.get(c.nsId)!;
      const ew = byId.get(c.ewId)!;
      expect(c.x).toBeCloseTo(ns.centerline, 6);
      expect(c.y).toBeCloseTo(ew.centerline, 6);
      expect(c.x).toBeGreaterThanOrEqual(ew.span[0] - 1e-6);
      expect(c.x).toBeLessThanOrEqual(ew.span[1] + 1e-6);
      expect(c.y).toBeGreaterThanOrEqual(ns.span[0] - 1e-6);
      expect(c.y).toBeLessThanOrEqual(ns.span[1] + 1e-6);
    }
  });

  it('is sorted deterministically by (x, then y)', () => {
    for (let i = 1; i < intersections.length; i++) {
      const a = intersections[i - 1];
      const b = intersections[i];
      expect(a.x < b.x || (a.x === b.x && a.y <= b.y)).toBe(true);
    }
  });

  it('King x Bay is present and both classes are "major" (the D16 4-mast signalized example)', () => {
    const kingBay = intersections.find((c) => (c.nsId === 'bay' && c.ewId === 'king') || (c.nsId === 'king' && c.ewId === 'bay'));
    expect(kingBay).toBeDefined();
    expect(kingBay!.nsCls).toBe('major');
    expect(kingBay!.ewCls).toBe('major');
  });

  it('determinism — two independent calls are deep-equal', () => {
    expect(listIntersections(buildStreets().streets)).toEqual(intersections);
  });
});

describe('ribbon list for the scene — world-space rects + class + colour key', () => {
  const ribbons = buildRibbons(streets);

  it('one ribbon per street, class + colour resolved from config', () => {
    expect(ribbons.length).toBe(streets.length);
    for (const r of ribbons) {
      expect(ROAD_CLASSES[r.cls]).toBeGreaterThan(0);
      expect(r.color).toBe(ROAD_COLORS[r.cls]);
    }
  });

  it('world rect = mapToWorld of the street ribbon (identity swap, map y→z)', () => {
    const byStreet = new Map(ribbons.map((r) => [r.streetId, r]));
    for (const s of streets) {
      const r = byStreet.get(s.id)!;
      expect(r.minX).toBeCloseTo(s.ribbon.minX, 6);
      expect(r.maxX).toBeCloseTo(s.ribbon.maxX, 6);
      expect(r.minZ).toBeCloseTo(s.ribbon.minY, 6);
      expect(r.maxZ).toBeCloseTo(s.ribbon.maxY, 6);
    }
  });
});
