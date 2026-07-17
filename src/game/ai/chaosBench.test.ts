import { describe, it, expect } from 'vitest';
import {
  nearestNodeId,
  pickNextWaypoint,
  formatBenchReport,
  yawFromQuaternion,
  type BenchReport,
} from './chaosBench';
import type { TrafficGraph, TrafficNode } from '../world/types';

// A tiny synthetic loop graph: 0 -> 1 -> 2 -> 0, plus a branch 1 -> 3 (a dead-end-ish spur,
// still with its own single outgoing edge back to 0) so pickNextWaypoint's rng-driven branch
// selection has something to actually select between. Mirrors the shape real world/
// trafficGraph.ts output (nodes carry id/x/z/kind/tileIndex; outEdges[nodeId] holds edge
// INDICES into `edges`, per that module's own doc comment).
function node(id: number, x: number, z: number): TrafficNode {
  return { id, x, z, kind: 'waypoint', tileIndex: id };
}

const GRAPH: TrafficGraph = {
  nodes: [node(0, 0, 0), node(1, 10, 0), node(2, 10, 10), node(3, 20, 0)],
  edges: [
    { from: 0, to: 1 }, // edge 0
    { from: 1, to: 2 }, // edge 1
    { from: 2, to: 0 }, // edge 2
    { from: 1, to: 3 }, // edge 3
    { from: 3, to: 0 }, // edge 4
  ],
  outEdges: [
    [0], // node 0 -> edge 0
    [1, 3], // node 1 -> edges 1 or 3 (branch)
    [2], // node 2 -> edge 2
    [4], // node 3 -> edge 4
  ],
};

describe('nearestNodeId', () => {
  it('returns the id of the closest node', () => {
    expect(nearestNodeId(GRAPH.nodes, 0.5, 0.5)).toBe(0);
    expect(nearestNodeId(GRAPH.nodes, 9, 0)).toBe(1);
    expect(nearestNodeId(GRAPH.nodes, 11, 9)).toBe(2);
    expect(nearestNodeId(GRAPH.nodes, 19, 1)).toBe(3);
  });

  it('throws on an empty node list rather than silently returning a bogus id', () => {
    expect(() => nearestNodeId([], 0, 0)).toThrow(RangeError);
  });
});

describe('pickNextWaypoint', () => {
  it('follows a single outgoing edge deterministically regardless of what pickEdge returns', () => {
    // node 0 has exactly one outgoing edge (0) -> node 1. Any pickEdge implementation that
    // honors the "return one element of the given list" contract must resolve the same way.
    expect(pickNextWaypoint(GRAPH, 0, (ids) => ids[0])).toBe(1);
    expect(pickNextWaypoint(GRAPH, 2, (ids) => ids[0])).toBe(0);
  });

  it('lets pickEdge choose between multiple outgoing edges at a branch node', () => {
    // node 1's outEdges is [1, 3] -> edges 1 (to node 2) and 3 (to node 3).
    expect(pickNextWaypoint(GRAPH, 1, (ids) => ids[0])).toBe(2);
    expect(pickNextWaypoint(GRAPH, 1, (ids) => ids[1])).toBe(3);
  });

  it('passes pickEdge exactly the arrived node’s outEdges array', () => {
    let seen: readonly number[] | null = null;
    pickNextWaypoint(GRAPH, 1, (ids) => {
      seen = ids;
      return ids[0];
    });
    expect(seen).toEqual([1, 3]);
  });

  it('degrades safely (holds position) when a node has no outgoing edges', () => {
    const deadEndGraph: TrafficGraph = {
      nodes: [node(0, 0, 0)],
      edges: [],
      outEdges: [[]],
    };
    expect(pickNextWaypoint(deadEndGraph, 0, (ids) => ids[0])).toBe(0);
  });
});

describe('yawFromQuaternion', () => {
  it('identity quaternion is yaw 0 (+Z forward, matches aiSteering’s convention)', () => {
    expect(yawFromQuaternion({ x: 0, y: 0, z: 0, w: 1 })).toBeCloseTo(0);
  });

  it('a 90° yaw about +Y reads back as +90° (π/2) — turning toward +X, the car’s right', () => {
    const half = Math.PI / 4;
    // Quaternion for +90° rotation about Y: (0, sin(45°), 0, cos(45°)).
    const q = { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) };
    expect(yawFromQuaternion(q)).toBeCloseTo(Math.PI / 2, 5);
  });

  it('a -90° yaw about +Y reads back as -90° (-π/2) — turning toward -X, the car’s left', () => {
    const half = -Math.PI / 4;
    const q = { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) };
    expect(yawFromQuaternion(q)).toBeCloseTo(-Math.PI / 2, 5);
  });
});

describe('formatBenchReport', () => {
  const BASE: BenchReport = {
    durationSec: 60,
    samples: 120,
    minFps: 45,
    avgFps: 55,
    maxDrawCalls: 130,
    maxTriangles: 250_000,
    maxPursuitUnits: 10,
    maxTrafficUnits: 24,
    heapStartMb: 40,
    heapEndMb: 55,
    heapDeltaMb: 15,
    blastsTriggered: 7,
    blastBridgeAvailable: true,
    gate: {
      tier: 'high',
      maxDrawCalls: 150,
      maxTriangles: 300_000,
      drawCallsOk: true,
      trianglesOk: true,
      ok: true,
    },
  };

  it('renders every headline number and a PASS verdict when under budget', () => {
    const text = formatBenchReport(BASE);
    expect(text).toContain('60.0s, 120 samples');
    expect(text).toContain('max 130');
    expect(text).toContain('max 250000');
    expect(text).toContain('pursuit max 10  traffic max 24');
    expect(text).toContain('7 triggered');
    expect(text).toContain('present');
    expect(text).toMatch(/PASS/);
  });

  it('renders a FAIL verdict when a gate is over budget', () => {
    const over: BenchReport = {
      ...BASE,
      maxDrawCalls: 999,
      gate: { ...BASE.gate, drawCallsOk: false, ok: false },
    };
    expect(formatBenchReport(over)).toMatch(/FAIL/);
  });

  it('renders n/a for null fps/heap readings instead of throwing or printing "null"', () => {
    const noReadings: BenchReport = {
      ...BASE,
      minFps: null,
      avgFps: null,
      heapStartMb: null,
      heapEndMb: null,
      heapDeltaMb: null,
    };
    const text = formatBenchReport(noReadings);
    expect(text).not.toContain('null');
    expect(text).toContain('n/a');
  });

  it('notes when the blastHere bridge is unavailable', () => {
    const text = formatBenchReport({ ...BASE, blastBridgeAvailable: false, blastsTriggered: 0 });
    expect(text).toContain('not wired yet');
  });
});
