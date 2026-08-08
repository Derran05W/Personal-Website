import { describe, it, expect } from 'vitest';
import {
  aimIndexFor,
  downtownDriveRect,
  formatDriveReport,
  nodeInRect,
  pickDowntownWaypoint,
  planWaypointRoute,
  type CameraLabDriveReport,
  type DriveRect,
} from './cameraLabDrive';
import { createRng } from '../world/rng';
import { buildDistricts } from '../world/toronto/districts';
import { ZONE_BOUNDARIES } from '../world/toronto/projection';
import type { TrafficGraph, TrafficNode } from '../world/types';

// A synthetic downtown-ish graph: a 2x3 grid ladder INSIDE the rect (ids 0-5 — every interior node
// keeps at least two forward choices once U-turns are filtered, so the seeded picker has real work
// to do), two outside spurs hanging off it (6, 7), and a fully-outside pair (8 -> {9, 6}) for the
// "no inside edge" fallback. Shape mirrors real world/toronto/roadGraph.ts output: nodes carry
// id/x/z/kind/tileIndex, and outEdges[nodeId] holds edge INDICES into `edges`.
//
//   0(10,10) — 1(50,10) — 2(90,10) — 6(150,10)outside
//      |          |          |
//   3(10,90) — 4(50,90) — 5(90,90)
//      |
//   7(10,150)outside
const RECT: DriveRect = { minX: 0, maxX: 100, minZ: 0, maxZ: 100 };

function node(id: number, x: number, z: number): TrafficNode {
  return { id, x, z, kind: 'waypoint', tileIndex: -1 };
}

const INSIDE_IDS = [0, 1, 2, 3, 4, 5];

/** Builds a TrafficGraph from undirected links (each becomes a directed edge BOTH ways — the real
 * graph's hubs offer the same U-turn-back option, which is exactly what the filter must handle). */
function buildGraph(nodes: readonly TrafficNode[], links: readonly (readonly [number, number])[]): TrafficGraph {
  const edges = links.flatMap(([a, b]) => [
    { from: a, to: b },
    { from: b, to: a },
  ]);
  const outEdges = nodes.map((n) => edges.map((_, i) => i).filter((i) => edges[i].from === n.id));
  return { nodes, edges, outEdges };
}

const GRAPH = buildGraph(
  [
    node(0, 10, 10),
    node(1, 50, 10),
    node(2, 90, 10),
    node(3, 10, 90),
    node(4, 50, 90),
    node(5, 90, 90),
    node(6, 150, 10), // outside, east
    node(7, 10, 150), // outside, south
    node(8, 200, 200), // outside, far south-east
    node(9, 300, 300), // outside, further still
  ],
  [
    [0, 1],
    [1, 2],
    [3, 4],
    [4, 5],
    [0, 3],
    [1, 4],
    [2, 5],
    [2, 6], // inside -> outside spur
    [3, 7], // inside -> outside spur
    [8, 9], // outside -> outside (far)
    [8, 6], // outside -> outside (nearer the rect centre)
  ],
);

/** The edge index for a directed hop, for tests that assert on what the picker was offered. */
function edgeIdx(from: number, to: number): number {
  const i = GRAPH.edges.findIndex((e) => e.from === from && e.to === to);
  if (i < 0) throw new Error(`no edge ${from}->${to} in the test graph`);
  return i;
}

describe('nodeInRect', () => {
  it('accepts interior points and rejects points beyond any edge', () => {
    expect(nodeInRect(RECT, { x: 50, z: 50 })).toBe(true);
    expect(nodeInRect(RECT, { x: -0.001, z: 50 })).toBe(false);
    expect(nodeInRect(RECT, { x: 100.001, z: 50 })).toBe(false);
    expect(nodeInRect(RECT, { x: 50, z: -0.001 })).toBe(false);
    expect(nodeInRect(RECT, { x: 50, z: 100.001 })).toBe(false);
  });

  it('is boundary-inclusive (a node exactly on a district edge is a downtown node)', () => {
    expect(nodeInRect(RECT, { x: 0, z: 0 })).toBe(true);
    expect(nodeInRect(RECT, { x: 100, z: 100 })).toBe(true);
  });
});

describe('pickDowntownWaypoint', () => {
  it('offers the picker ONLY the outgoing edges whose far node is inside the rect', () => {
    let seen: readonly number[] | null = null;
    // node 2 leads to 1, 5 (inside) and 6 (outside).
    pickDowntownWaypoint(GRAPH, 2, RECT, (ids) => {
      seen = ids;
      return ids[0];
    });
    expect(seen).toEqual([edgeIdx(2, 1), edgeIdx(2, 5)]);
  });

  it('never returns an outside node while an inside edge exists, whatever the picker prefers', () => {
    // A picker that always takes the LAST offered edge would grab the spur to 6 / 7 if the rect
    // filter were missing.
    expect(pickDowntownWaypoint(GRAPH, 2, RECT, (ids) => ids[ids.length - 1])).toBe(5);
    expect(pickDowntownWaypoint(GRAPH, 3, RECT, (ids) => ids[ids.length - 1])).toBe(0);
  });

  it('drops the U-turn back the way it came when another inside edge exists', () => {
    let seen: readonly number[] | null = null;
    // Arriving at 1 from 0 (heading +x): the edge back to 0 must never be offered; the straight
    // (1 -> 2) and the turn (1 -> 4) both survive.
    pickDowntownWaypoint(
      GRAPH,
      1,
      RECT,
      (ids) => {
        seen = ids;
        return ids[0];
      },
      0,
    );
    expect(seen).toEqual([edgeIdx(1, 2), edgeIdx(1, 4)]);
  });

  it('still takes the U-turn at a true dead end (nothing else is drivable)', () => {
    // Arriving at the outside spur node 7 from 3 — its only edge is back to 3.
    expect(pickDowntownWaypoint(GRAPH, 7, RECT, (ids) => ids[0], 3)).toBe(3);
  });

  it('applies no U-turn filter on the first step (no arrival heading yet)', () => {
    let seen: readonly number[] | null = null;
    pickDowntownWaypoint(GRAPH, 1, RECT, (ids) => {
      seen = ids;
      return ids[0];
    });
    expect(seen).toEqual([edgeIdx(1, 0), edgeIdx(1, 2), edgeIdx(1, 4)]);
  });

  it('falls back toward the rect centre — without consuming the rng — when no edge stays inside', () => {
    // node 8's options both leave the rect: node 9 (300,300) and node 6 (150,10). The rect centre
    // is (50,50), so node 6 wins. The picker must not be called at all (rng streams stay aligned).
    const result = pickDowntownWaypoint(GRAPH, 8, RECT, () => {
      throw new Error('pickEdge must not be consulted when no outgoing edge stays inside the rect');
    });
    expect(result).toBe(6);
  });

  it('holds position at a sink node (no outgoing edges)', () => {
    const sink: TrafficGraph = { nodes: [node(0, 10, 10)], edges: [], outEdges: [[]] };
    expect(pickDowntownWaypoint(sink, 0, RECT, (ids) => ids[0])).toBe(0);
  });
});

describe('planWaypointRoute determinism', () => {
  const plan = (seed: number, steps = 40): number[] => {
    const rng = createRng(seed).fork('cameraLabDrive');
    return planWaypointRoute(GRAPH, 0, RECT, (ids) => rng.pick(ids), steps);
  };

  it('produces the identical waypoint sequence for the same (seed, start node)', () => {
    expect(plan(1)).toEqual(plan(1));
    expect(plan(7)).toEqual(plan(7));
  });

  it('produces a different sequence for a different seed', () => {
    expect(plan(1)).not.toEqual(plan(2));
  });

  it('produces a different sequence from a different start node (same seed)', () => {
    const rngA = createRng(1).fork('cameraLabDrive');
    const rngB = createRng(1).fork('cameraLabDrive');
    const fromZero = planWaypointRoute(GRAPH, 0, RECT, (ids) => rngA.pick(ids), 40);
    const fromTwo = planWaypointRoute(GRAPH, 2, RECT, (ids) => rngB.pick(ids), 40);
    expect(fromZero).not.toEqual(fromTwo);
  });

  it('plans exactly `steps` waypoints on a graph with no sinks reachable', () => {
    expect(plan(1, 12)).toHaveLength(12);
    expect(plan(1, 40)).toHaveLength(40);
  });

  it('a longer plan is a strict prefix-extension of a shorter one (same seed)', () => {
    // Load-bearing for stopAfterWaypoints: waypoint mode raises the step budget's floor while
    // `seconds` still sets its usual value, so the SAME seed must yield the SAME opening route
    // regardless of which budget won the max(). Holds because planWaypointRoute consumes the rng
    // strictly sequentially — one pick per step, nothing skipped.
    const short = plan(5, 15);
    const long = plan(5, 45);
    expect(long.slice(0, short.length)).toEqual(short);
  });

  it('never selects a node outside the downtown rect', () => {
    const route = plan(3, 200);
    expect(route.length).toBe(200);
    for (const id of route) expect(INSIDE_IDS).toContain(id);
  });

  it('actually branches (the seeded stream is doing real work, not walking one cycle)', () => {
    expect(new Set(plan(1, 60)).size).toBeGreaterThan(2);
  });

  it('stops early at a sink node instead of padding the route', () => {
    const sinkGraph: TrafficGraph = {
      nodes: [node(0, 10, 10), node(1, 20, 20)],
      edges: [{ from: 0, to: 1 }],
      outEdges: [[0], []],
    };
    expect(planWaypointRoute(sinkGraph, 0, RECT, (ids) => ids[0], 25)).toEqual([1]);
  });

  it('does not double back on itself (the U-turn filter is applied along the whole walk)', () => {
    // Every hop in this grid has a forward alternative, so the walk must never revisit the node it
    // just left — the failure mode that kept a live 60 s drive inside an 80 m box.
    const route = plan(5, 60);
    for (let i = 2; i < route.length; i++) expect(route[i]).not.toBe(route[i - 2]);
  });
});

describe('aimIndexFor (pure-pursuit look-ahead)', () => {
  // Route 0 -> 1 -> 2 along the top row: 40 wu between nodes.
  const route = [0, 1, 2];

  it('keeps the current waypoint when it is already beyond the look-ahead', () => {
    expect(aimIndexFor(GRAPH.nodes, route, 0, 10, 60, 14)).toBe(0); // 50 wu away
  });

  it('looks past a waypoint the car is nearly on top of', () => {
    expect(aimIndexFor(GRAPH.nodes, route, 0, 8, 10, 14)).toBe(1); // 2 wu from node 0
  });

  it('walks forward as far as needed, and never past the last node', () => {
    expect(aimIndexFor(GRAPH.nodes, route, 0, 10, 10, 1000)).toBe(2);
  });

  it('never aims behind the arrival waypoint', () => {
    expect(aimIndexFor(GRAPH.nodes, route, 2, 10, 10, 14)).toBe(2);
  });
});

describe('downtownDriveRect (live Toronto data)', () => {
  const rect = downtownDriveRect();

  it('is a real, non-degenerate rect', () => {
    for (const v of [rect.minX, rect.maxX, rect.minZ, rect.maxZ]) expect(Number.isFinite(v)).toBe(true);
    expect(rect.maxX).toBeGreaterThan(rect.minX);
    expect(rect.maxZ).toBeGreaterThan(rect.minZ);
  });

  it('sits entirely inside the downtown zone band (never the fold corridor or the capsule)', () => {
    // world z === map y (mapToWorld is the identity swap); ZONE_BOUNDARIES[2] is Bloor (the
    // fold/downtown seam) and [3] is the shoreline.
    expect(rect.minZ).toBeGreaterThanOrEqual(ZONE_BOUNDARIES[2]);
    expect(rect.maxZ).toBeLessThanOrEqual(ZONE_BOUNDARIES[3]);
  });

  it('covers every district it is derived from (the financial canyon included)', () => {
    const districts = buildDistricts();
    for (const id of ['financial', 'entertainment', 'yongeDundasQueen', 'stLawrence'] as const) {
      const d = districts.find((rd) => rd.def.id === id);
      expect(d, `district ${id} must exist`).toBeDefined();
      for (const r of d?.rects ?? []) {
        expect(nodeInRect(rect, { x: r.minX, z: r.minY })).toBe(true);
        expect(nodeInRect(rect, { x: r.maxX, z: r.maxY })).toBe(true);
      }
    }
  });

  it('excludes the North York capsule districts (the drive can never wander up the stem)', () => {
    const districts = buildDistricts();
    const ny = districts.find((rd) => rd.def.id === 'northYorkCentre');
    expect(ny).toBeDefined();
    for (const r of ny?.rects ?? []) {
      expect(nodeInRect(rect, { x: (r.minX + r.maxX) / 2, z: (r.minY + r.maxY) / 2 })).toBe(false);
    }
  });

  it('is deterministic (pure function of the street table — no seed, no drift between calls)', () => {
    expect(downtownDriveRect()).toEqual(rect);
  });
});

describe('CameraLabDriveReport shape', () => {
  const report: CameraLabDriveReport = {
    stats: {
      frames: 900,
      eyeInsideFrames: 45,
      nearPlaneFrames: 90,
      occludedFrames: 180,
      occlusionHitSum: 270,
      occlusionHitMax: 4,
      clampedFrames: 9,
      boresightBlockedFrames: 360,
      boresightHitSum: 540,
      // Phase 76 readability block — a drive report carries it through unchanged (the report is a
      // snapshot of readCameraClipStats()); the accumulation rules are pinned in
      // world/toronto/cameraClipStats.test.ts, not here.
      readability: {
        frames: 900,
        onScreenPursuerSum: 0,
        onScreenPursuerMax: 0,
        sightings: 0,
        sightingDistanceSumM: 0,
        sightingDistanceMaxM: 0,
        cityCoverageSum: 108,
        cityBoxesInFrameSum: 5400,
        cityBoxesTested: 2300,
        groundBandFrames: 900,
        groundBandSumWu: 19_800,
        onScreenPursuerCount: 0,
        pursuerWarningDistanceM: null,
        cityInFrameFraction: 0.12,
        groundBandWu: 22,
      },
    },
    waypoints: [12, 34, 56],
    seconds: 60,
    seed: 1,
    waypointTarget: null,
    heatAtEnd: 0,
    tierAtEnd: 0,
    framesObserved: 900,
  };

  it('carries exactly the fields the battery reads', () => {
    expect(Object.keys(report).sort()).toEqual([
      'framesObserved',
      'heatAtEnd',
      'seconds',
      'seed',
      'stats',
      'tierAtEnd',
      'waypointTarget',
      'waypoints',
    ]);
  });

  it('formats rates against the frame denominator, not raw counts', () => {
    const text = formatDriveReport(report);
    expect(text).toContain('3 waypoints');
    expect(text).toContain('900 frames');
    expect(text).toContain('eyeInside 5.0%');
    expect(text).toContain('clamped 1.0%');
    expect(text).toContain('boresight blocked 40.0%');
    expect(text).toContain('mean depth 1.50'); // 540 hits over 360 blocked frames
    expect(text).not.toContain('CONTAMINATED');
  });

  it('flags a tiered (contaminated) run — the tier zoom changes the rig under test', () => {
    expect(formatDriveReport({ ...report, heatAtEnd: 40, tierAtEnd: 2 })).toContain('CONTAMINATED');
  });

  it('reports n/a rather than dividing by zero when the clip sampler never ran', () => {
    const text = formatDriveReport({
      ...report,
      stats: { ...report.stats, frames: 0 },
      framesObserved: 0,
    });
    expect(text).toContain('n/a');
  });
});
