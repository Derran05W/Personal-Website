import { describe, it, expect } from 'vitest';
import {
  approachWaypoint,
  greedyNextNode,
  isDrivableAt,
  lineLosClear,
  nearestNodeDist,
  nearestNodeIndex,
  sampleLineDrivable,
  worldToColRow,
} from './roadPath';
import { WORLD } from '../config';
import { tileCenter, tileIndex, type Tile, type TrafficGraph } from '../world/types';

// --- graph fixture: a 4-node chain along +X with one backward option off node 1 --------------
// nodes 0..3 at (0,0),(10,0),(20,0),(30,0). Edges: 0→1, 1→2, 1→0 (backward), 2→3.
function makeGraph(): TrafficGraph {
  const nodes = [
    { id: 0, x: 0, z: 0, kind: 'intersection' as const, tileIndex: 0 },
    { id: 1, x: 10, z: 0, kind: 'waypoint' as const, tileIndex: 0 },
    { id: 2, x: 20, z: 0, kind: 'waypoint' as const, tileIndex: 0 },
    { id: 3, x: 30, z: 0, kind: 'intersection' as const, tileIndex: 0 },
  ];
  const edges = [
    { from: 0, to: 1 }, // 0
    { from: 1, to: 2 }, // 1
    { from: 1, to: 0 }, // 2  (backward from node 1)
    { from: 2, to: 3 }, // 3
  ];
  const outEdges = [[0], [1, 2], [3], []];
  return { nodes, edges, outEdges };
}

describe('nearestNodeIndex / nearestNodeDist', () => {
  const nodes = makeGraph().nodes;

  it('returns the index (= id) of the closest node', () => {
    expect(nearestNodeIndex(nodes, 22, 0)).toBe(2); // (20,0) is closest to (22,0)
    expect(nearestNodeIndex(nodes, -3, 1)).toBe(0);
  });

  it('is −1 / Infinity for an empty node list', () => {
    expect(nearestNodeIndex([], 0, 0)).toBe(-1);
    expect(nearestNodeDist([], 0, 0)).toBe(Infinity);
  });

  it('nearestNodeDist is the straight-line distance to the closest node', () => {
    expect(nearestNodeDist(nodes, 10, 0)).toBeCloseTo(0); // sits exactly on node 1
    expect(nearestNodeDist(nodes, 20, 6)).toBeCloseTo(6); // 6 m off node 2
  });
});

describe('greedyNextNode', () => {
  const graph = makeGraph();

  it('picks the successor that most reduces distance to the target node', () => {
    // From node 1, target node 3 (30,0): successor 2 (20,0) is closer than successor 0 (0,0).
    expect(greedyNextNode(graph, 1, 3)).toBe(2);
  });

  it('returns the from-node itself when it IS the target', () => {
    expect(greedyNextNode(graph, 2, 2)).toBe(2);
  });

  it('returns the from-node when it has no outgoing edges (dead end)', () => {
    expect(greedyNextNode(graph, 3, 0)).toBe(3);
  });
});

describe('approachWaypoint', () => {
  const graph = makeGraph();

  it('returns the greedy next node position from the unit toward the player', () => {
    // Unit near node 1 (x≈12), player near node 3 (x≈28) → next hop is node 2 at (20,0).
    expect(approachWaypoint(graph, 12, 0, 28, 0)).toEqual({ x: 20, z: 0 });
  });

  it('returns the shared node position when unit and player map to the same nearest node', () => {
    expect(approachWaypoint(graph, 9, 0, 11, 0)).toEqual({ x: 10, z: 0 });
  });

  it('is null for an empty graph', () => {
    const empty: TrafficGraph = { nodes: [], edges: [], outEdges: [] };
    expect(approachWaypoint(empty, 0, 0, 10, 0)).toBeNull();
  });
});

// --- tile fixtures for LOS ------------------------------------------------------------------
function allRoadGrid(): Tile[] {
  const N = WORLD.tiles;
  const tiles: Tile[] = [];
  for (let row = 0; row < N; row++) {
    for (let col = 0; col < N; col++) {
      tiles.push({ col, row, type: 'road', districtId: 0, blockId: -1 });
    }
  }
  return tiles;
}

/** Set a row's [colFrom, colTo] span to 'building' (mutates + returns the grid). */
function block(tiles: Tile[], row: number, colFrom: number, colTo: number): Tile[] {
  for (let col = colFrom; col <= colTo; col++) {
    tiles[tileIndex(col, row)] = { col, row, type: 'building', districtId: 0, blockId: 0 };
  }
  return tiles;
}

describe('worldToColRow / isDrivableAt', () => {
  it('maps a tile center back to its own (col,row)', () => {
    const c = tileCenter(30, 40);
    expect(worldToColRow(c.x, c.z)).toEqual({ col: 30, row: 40 });
  });

  it('clamps out-of-bounds world points into the grid', () => {
    const cr = worldToColRow(-1e6, 1e6);
    expect(cr.col).toBe(0);
    expect(cr.row).toBe(WORLD.tiles - 1);
  });

  it('reads the drivable flag of the tile under a world point', () => {
    const tiles = block(allRoadGrid(), 10, 15, 15);
    const roadC = tileCenter(10, 10);
    const buildingC = tileCenter(15, 10);
    expect(isDrivableAt(tiles, roadC.x, roadC.z)).toBe(true);
    expect(isDrivableAt(tiles, buildingC.x, buildingC.z)).toBe(false);
  });
});

describe('sampleLineDrivable / lineLosClear', () => {
  const from = tileCenter(10, 10);
  const to = tileCenter(20, 10);

  it('is fully clear (fraction 1) over an all-road segment', () => {
    const tiles = allRoadGrid();
    expect(sampleLineDrivable(from.x, from.z, to.x, to.z, tiles, 8)).toBe(1);
    expect(lineLosClear(from.x, from.z, to.x, to.z, tiles, 8, 0.5)).toBe(true);
  });

  it('is fully blocked (fraction 0) when the whole interior is buildings', () => {
    const tiles = block(allRoadGrid(), 10, 11, 19);
    expect(sampleLineDrivable(from.x, from.z, to.x, to.z, tiles, 8)).toBe(0);
    expect(lineLosClear(from.x, from.z, to.x, to.z, tiles, 8, 0.5)).toBe(false);
  });

  it('reports the partial drivable fraction and thresholds against clearFrac', () => {
    // Buildings on the far half (cols 15..19) → half the interior samples land on road.
    const tiles = block(allRoadGrid(), 10, 15, 19);
    const frac = sampleLineDrivable(from.x, from.z, to.x, to.z, tiles, 8);
    expect(frac).toBeCloseTo(0.5);
    expect(lineLosClear(from.x, from.z, to.x, to.z, tiles, 8, 0.4)).toBe(true); // 0.5 ≥ 0.4
    expect(lineLosClear(from.x, from.z, to.x, to.z, tiles, 8, 0.6)).toBe(false); // 0.5 < 0.6
  });
});
