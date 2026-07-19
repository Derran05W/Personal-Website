import { describe, expect, it } from 'vitest';
import { buildStreets } from './streets';
import { buildTorontoRoadGraph } from './roadGraph';
import {
  advanceCursor,
  cursorPoint,
  selectSpawnNode,
  type PathCursor,
  type Vec2,
} from '../../ai/traffic';
import { TORONTO_TRAFFIC, torontoTrafficRoster } from '../../config/torontoTraffic';
import type { TrafficGraph } from '../types';

const graph: TrafficGraph = buildTorontoRoadGraph(buildStreets().streets);

describe('Toronto road graph — TrafficGraph adapter shape (D3)', () => {
  it('is a non-trivial TrafficGraph the civilian system can consume', () => {
    expect(graph.nodes.length).toBeGreaterThan(100);
    expect(graph.edges.length).toBeGreaterThan(graph.nodes.length); // bidirectional links
    expect(graph.outEdges.length).toBe(graph.nodes.length);
  });

  it('every node carries the fields ai/traffic reads (x, z, kind) and finite coords', () => {
    for (const n of graph.nodes) {
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.z)).toBe(true);
      expect(n.kind === 'intersection' || n.kind === 'waypoint').toBe(true);
    }
  });

  it('has NO sink nodes — every node has ≥1 out-edge (advanceCursor never dead-ends)', () => {
    for (let i = 0; i < graph.outEdges.length; i++) {
      expect(graph.outEdges[i].length, `node ${i}`).toBeGreaterThan(0);
    }
  });

  it('every edge references valid node indices', () => {
    for (const e of graph.edges) {
      expect(e.from).toBeGreaterThanOrEqual(0);
      expect(e.from).toBeLessThan(graph.nodes.length);
      expect(e.to).toBeGreaterThanOrEqual(0);
      expect(e.to).toBeLessThan(graph.nodes.length);
    }
  });

  it('tileIndex is -1 map-wide (documented debt — nothing may read it) yet traffic ignores it', () => {
    // ai/traffic reads ONLY x/z/kind + edges/outEdges, so the -1 is inert for the civilian system.
    expect(graph.nodes.every((n) => n.tileIndex === -1)).toBe(true);
  });
});

describe('Toronto graph drives ai/traffic pure movement (D3)', () => {
  it('selectSpawnNode finds a ring node near a downtown point', () => {
    // Use a real graph node as the "player" position so the ring is guaranteed populated.
    const anchor = graph.nodes[Math.floor(graph.nodes.length / 2)];
    const firstEdge = (ids: readonly number[]): number => ids[0];
    const node = selectSpawnNode(
      graph.nodes,
      anchor.x,
      anchor.z,
      0,
      -1,
      { spawnRingMinM: 0, spawnRingMaxM: 400 },
      firstEdge,
    );
    expect(node).toBeGreaterThanOrEqual(0);
  });

  it('advanceCursor traverses many edges from a node without stalling, staying finite', () => {
    const start = graph.nodes[0];
    const firstOut = graph.edges[graph.outEdges[0][0]];
    const to = graph.nodes[firstOut.to];
    const c: PathCursor = {
      fromX: start.x,
      fromZ: start.z,
      toX: to.x,
      toZ: to.z,
      toNodeId: firstOut.to,
      segLenM: Math.hypot(to.x - start.x, to.z - start.z) || 1,
      progressM: 0,
    };
    const firstEdge = (ids: readonly number[]): number => ids[0];
    const out: Vec2 = { x: 0, z: 0 };
    for (let step = 0; step < 200; step++) {
      advanceCursor(c, 6, graph, firstEdge);
      cursorPoint(c, out);
      expect(Number.isFinite(out.x)).toBe(true);
      expect(Number.isFinite(out.z)).toBe(true);
    }
  });
});

describe('Toronto traffic roster (D3)', () => {
  it('resolves the tier-scaled roster 16 / 24 / 32', () => {
    expect(torontoTrafficRoster('low')).toBe(16);
    expect(torontoTrafficRoster('med')).toBe(24);
    expect(torontoTrafficRoster('high')).toBe(32);
    expect(TORONTO_TRAFFIC.rosterByTier.high).toBeGreaterThan(TORONTO_TRAFFIC.rosterByTier.med);
    expect(TORONTO_TRAFFIC.rosterByTier.med).toBeGreaterThan(TORONTO_TRAFFIC.rosterByTier.low);
  });
});
