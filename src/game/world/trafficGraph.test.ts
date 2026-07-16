import { describe, expect, it } from 'vitest';
import { TRAFFIC, WORLD } from '../config';
import { generate } from './generate';
import { buildTrafficGraph } from './trafficGraph';
import {
  districtIdAt,
  tileCenter,
  tileIndex,
  type Tile,
  type TrafficGraph,
  type TrafficNode,
} from './types';

const N = WORLD.tiles;
// Fixed spread of seeds for structural/statistical checks — same spirit as generate.test.ts.
const SEEDS = [0, 1, 416, 2024, 0xdeadbeef];

type Direction = 'N' | 'S' | 'E' | 'W';

// --- Hand-built fixture -------------------------------------------------------------------
// tileIndex()/tileCenter() (world/types.ts) are hard-wired to WORLD.tiles (64), so any
// fixture must still be a full 64x64 array — but the ROAD PATTERN inside it can be as small
// as we like. Three full North/South columns (20, 23, 26) and three full East/West rows
// (30, 33, 36); every other tile is 'building'. Every gap between consecutive lines is 3
// tiles — exactly one more than TRAFFIC.waypointSpacingTiles (2) — so each gap produces
// exactly one waypoint between its two intersections. Small enough to hand-count nodes and
// edges exactly (see the "exact counts" test below for the arithmetic).
const FIXTURE_COLS = [20, 23, 26];
const FIXTURE_ROWS = [30, 33, 36];

function buildFixtureTiles(): Tile[] {
  const colSet = new Set(FIXTURE_COLS);
  const rowSet = new Set(FIXTURE_ROWS);
  const tiles: Tile[] = new Array(N * N);
  for (let row = 0; row < N; row++) {
    for (let col = 0; col < N; col++) {
      // A tile is road iff its column or its row is one of the chosen full lines — this
      // makes every chosen column/row a FULL line (every tile on it is road), which is the
      // only thing buildTrafficGraph looks for.
      const isRoadTile = colSet.has(col) || rowSet.has(row);
      tiles[tileIndex(col, row)] = {
        col,
        row,
        type: isRoadTile ? 'road' : 'building',
        districtId: districtIdAt(col, row),
        blockId: isRoadTile ? -1 : 0,
      };
    }
  }
  return tiles;
}

// --- Shared helpers -------------------------------------------------------------------

/** Independently re-derives which cardinal direction a node represents from its lateral
 * offset off its tile's center — mirrors the locked frame convention (+Z south, right-hand
 * traffic: right = forward x up, i.e. right.x = -forward.z, right.z = forward.x), not
 * trafficGraph.ts's internals, so this is a real cross-check. North/South lanes offset
 * along X (right of N is +X/east, right of S is -X/west); East/West lanes offset along Z
 * (right of E is +Z/south, right of W is -Z/north). */
function directionOf(node: TrafficNode): Direction {
  const col = node.tileIndex % N;
  const row = (node.tileIndex - col) / N;
  const center = tileCenter(col, row);
  const dx = node.x - center.x;
  const dz = node.z - center.z;
  const off = TRAFFIC.laneOffsetM;
  const eps = 1e-6;
  if (Math.abs(dx - off) < eps && Math.abs(dz) < eps) return 'N';
  if (Math.abs(dx + off) < eps && Math.abs(dz) < eps) return 'S';
  if (Math.abs(dz - off) < eps && Math.abs(dx) < eps) return 'E';
  if (Math.abs(dz + off) < eps && Math.abs(dx) < eps) return 'W';
  throw new Error(`node ${node.id} offset (${dx},${dz}) doesn't match any cardinal direction`);
}

function findNode(graph: TrafficGraph, col: number, row: number, dir: Direction): TrafficNode {
  const idx = tileIndex(col, row);
  const match = graph.nodes.find((n) => n.tileIndex === idx && directionOf(n) === dir);
  if (!match) throw new Error(`no ${dir} node at (${col},${row})`);
  return match;
}

function hasEdge(graph: TrafficGraph, from: number, to: number): boolean {
  return graph.outEdges[from].some((edgeIdx) => graph.edges[edgeIdx].to === to);
}

/** BFS reachable-set size following outEdges from `startId`, including itself. */
function reachableCount(graph: TrafficGraph, startId: number): number {
  const seen = new Set<number>([startId]);
  const stack = [startId];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined) break;
    for (const edgeIdx of graph.outEdges[id]) {
      const to = graph.edges[edgeIdx].to;
      if (!seen.has(to)) {
        seen.add(to);
        stack.push(to);
      }
    }
  }
  return seen.size;
}

// --- Generic invariants, checked on every seed's REAL generated graph -----------------

describe('buildTrafficGraph — generic invariants (real generator, multiple seeds)', () => {
  it.each(SEEDS)('seed %i: every node sits on a road tile', (seed) => {
    const w = generate(seed);
    for (const n of w.graph.nodes) {
      expect(w.tiles[n.tileIndex].type).toBe('road');
    }
  });

  it.each(SEEDS)('seed %i: every node is laterally offset within tile bounds', (seed) => {
    const w = generate(seed);
    const half = WORLD.tileSize / 2;
    for (const n of w.graph.nodes) {
      const col = n.tileIndex % N;
      const row = (n.tileIndex - col) / N;
      const center = tileCenter(col, row);
      const dist = Math.hypot(n.x - center.x, n.z - center.z);
      expect(dist).toBeLessThan(half); // offset must land inside the tile
      expect(dist).toBeCloseTo(TRAFFIC.laneOffsetM, 6); // and be exactly the configured offset
    }
  });

  it.each(SEEDS)('seed %i: node id equals its array index', (seed) => {
    const w = generate(seed);
    w.graph.nodes.forEach((n, i) => expect(n.id).toBe(i));
  });

  it.each(SEEDS)('seed %i: every edge endpoint is a valid node id', (seed) => {
    const w = generate(seed);
    const count = w.graph.nodes.length;
    for (const e of w.graph.edges) {
      expect(e.from).toBeGreaterThanOrEqual(0);
      expect(e.from).toBeLessThan(count);
      expect(e.to).toBeGreaterThanOrEqual(0);
      expect(e.to).toBeLessThan(count);
    }
  });

  it.each(SEEDS)('seed %i: outEdges is consistent with edges (round-trip both ways)', (seed) => {
    const w = generate(seed);
    const { nodes, edges, outEdges } = w.graph;
    expect(outEdges).toHaveLength(nodes.length);
    // Every edge is listed in its `from` node's outEdges, exactly once.
    for (let i = 0; i < edges.length; i++) {
      const bucket = outEdges[edges[i].from];
      expect(bucket.filter((idx) => idx === i)).toHaveLength(1);
    }
    // Every outEdges entry actually points back to an edge whose `from` is that node.
    outEdges.forEach((bucket, nodeId) => {
      for (const edgeIdx of bucket) {
        expect(edges[edgeIdx].from).toBe(nodeId);
      }
    });
  });

  it.each(SEEDS)('seed %i: no dead ends — every node has at least one outgoing edge', (seed) => {
    const w = generate(seed);
    for (const bucket of w.graph.outEdges) {
      expect(bucket.length).toBeGreaterThan(0);
    }
  });

  it.each(SEEDS)('seed %i: includes at least one waypoint node (spacing < arterial gap)', (seed) => {
    const w = generate(seed);
    expect(w.graph.nodes.some((n) => n.kind === 'waypoint')).toBe(true);
    expect(w.graph.nodes.some((n) => n.kind === 'intersection')).toBe(true);
  });

  // Strong connectivity is NOT required (locked decision), but turns must actually connect
  // lanes together: from a handful of sample start nodes per seed, following outEdges
  // should reach a healthy share of the whole graph. Measured during authoring: all 3
  // sample starts x all 5 seeds reach 100% of their graph's nodes (a right-hand-traffic
  // grid with left/right turns at every intersection is effectively one strongly connected
  // component). 50% is a deliberately generous floor — well below the observed 100% — so
  // this stays a sanity check on turn wiring rather than a de facto strong-connectivity
  // requirement.
  const MIN_REACHABLE_RATIO = 0.5;
  it.each(SEEDS)('seed %i: reaches >= 50%% of nodes from sample starts', (seed) => {
    const w = generate(seed);
    const total = w.graph.nodes.length;
    const starts = [0, Math.floor(total / 2), total - 1];
    for (const start of starts) {
      const ratio = reachableCount(w.graph, start) / total;
      expect(ratio).toBeGreaterThanOrEqual(MIN_REACHABLE_RATIO);
    }
  });
});

describe('buildTrafficGraph — determinism', () => {
  it('same tiles produce a deeply-equal graph across repeated calls', () => {
    const w = generate(416);
    const a = buildTrafficGraph(w.tiles);
    const b = buildTrafficGraph(w.tiles);
    expect(a).toEqual(b);
  });

  it.each(SEEDS)('seed %i: generate() itself is deterministic in its graph output', (seed) => {
    expect(generate(seed).graph).toEqual(generate(seed).graph);
  });
});

describe('buildTrafficGraph — seed 416 node/edge counts (informational, logged)', () => {
  it('logs node/edge counts for seed 416', () => {
    const w = generate(416);
    console.log(
      `seed 416: ${w.graph.nodes.length} nodes, ${w.graph.edges.length} edges ` +
        `(${w.graph.nodes.filter((n) => n.kind === 'intersection').length} intersection, ` +
        `${w.graph.nodes.filter((n) => n.kind === 'waypoint').length} waypoint)`,
    );
    expect(w.graph.nodes.length).toBeGreaterThan(0);
    expect(w.graph.edges.length).toBeGreaterThan(0);
  });
});

// --- Exact expectations on the hand-built fixture ---------------------------------------

describe('buildTrafficGraph — hand-built fixture (exact expectations)', () => {
  const tiles = buildFixtureTiles();
  const graph = buildTrafficGraph(tiles);

  it('exact node counts: 60 total, 36 intersection, 24 waypoint', () => {
    // 3 vertical lines x 3 horizontal lines = 9 intersection tiles.
    // Each line has 5 "stops" (3 intersections + 2 waypoints, gap=3, spacing=2):
    //   vertical lines' row-stops:    [30, 32, 33, 35, 36]
    //   horizontal lines' col-stops:  [20, 22, 23, 25, 26]
    // 3 vertical lines x 5 stops x 2 directions (N,S) = 30 nodes.
    // 3 horizontal lines x 5 stops x 2 directions (E,W) = 30 nodes.
    // Total = 60. Intersection-kind: (3 intersection-stops x 2 dirs x 3 lines) x 2 axes = 36.
    // Waypoint-kind: (2 waypoint-stops x 2 dirs x 3 lines) x 2 axes = 24.
    expect(graph.nodes).toHaveLength(60);
    expect(graph.nodes.filter((n) => n.kind === 'intersection')).toHaveLength(36);
    expect(graph.nodes.filter((n) => n.kind === 'waypoint')).toHaveLength(24);
  });

  it('exact edge count: 48 chain edges + 72 turn edges = 120', () => {
    // Chain edges: each of the 3 vertical lines contributes (5-1) South + (5-1) North = 8;
    // x3 lines = 24. Same for the 3 horizontal lines (East/West) = 24. Total chain = 48.
    // Turn edges: 9 intersection tiles x 4 incoming directions x 2 turns (left+right) = 72.
    expect(graph.edges).toHaveLength(120);
    graph.outEdges.reduce((sum, bucket) => sum + bucket.length, 0);
    expect(graph.outEdges.reduce((sum, bucket) => sum + bucket.length, 0)).toBe(120);
  });

  it('waypoint nodes land exactly where expected (col 22 and col 25 on row-30 line)', () => {
    const waypointCols = graph.nodes
      .filter((n) => n.kind === 'waypoint' && (n.tileIndex - (n.tileIndex % N)) / N === 30)
      .map((n) => n.tileIndex % N);
    expect(new Set(waypointCols)).toEqual(new Set([22, 25]));
  });

  it('a known intersection (col 23, row 33) has straight, left, and right edges, no U-turn', () => {
    // South-bound node arriving at (23,33) from the north (23,30).
    const southHere = findNode(graph, 23, 33, 'S');
    const northHere = findNode(graph, 23, 33, 'N');
    const eastHere = findNode(graph, 23, 33, 'E');
    const westHere = findNode(graph, 23, 33, 'W');

    // Straight-through: south continues to the next stop south (waypoint at row 35).
    const southNext = findNode(graph, 23, 35, 'S');
    expect(hasEdge(graph, southHere.id, southNext.id)).toBe(true);

    // Right turn from South is West; left turn from South is East (compass clockwise
    // N->E->S->W->N: right of S is W, left of S is E).
    expect(hasEdge(graph, southHere.id, westHere.id)).toBe(true);
    expect(hasEdge(graph, southHere.id, eastHere.id)).toBe(true);

    // No U-turn: south-bound never connects directly to the north-bound node at the same
    // tile, and vice versa.
    expect(hasEdge(graph, southHere.id, northHere.id)).toBe(false);
    expect(hasEdge(graph, northHere.id, southHere.id)).toBe(false);
    expect(hasEdge(graph, eastHere.id, westHere.id)).toBe(false);
    expect(hasEdge(graph, westHere.id, eastHere.id)).toBe(false);
  });

  it('every node is on a road tile and offset exactly TRAFFIC.laneOffsetM from tile center', () => {
    for (const n of graph.nodes) {
      expect(tiles[n.tileIndex].type).toBe('road');
      const col = n.tileIndex % N;
      const row = (n.tileIndex - col) / N;
      const center = tileCenter(col, row);
      expect(Math.hypot(n.x - center.x, n.z - center.z)).toBeCloseTo(TRAFFIC.laneOffsetM, 6);
    }
  });

  it('no dead ends and node id == index on the fixture too', () => {
    graph.nodes.forEach((n, i) => expect(n.id).toBe(i));
    for (const bucket of graph.outEdges) expect(bucket.length).toBeGreaterThan(0);
  });

  it('is deterministic across repeated calls on the same fixture tiles', () => {
    expect(buildTrafficGraph(tiles)).toEqual(buildTrafficGraph(tiles));
  });
});
