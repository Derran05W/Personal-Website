// Directed traffic graph that civilian cars follow as kinematic bodies (TDD §5.4, Phase 7).
// Pursuit AI never paths on it — police steer physically and cut across lots/parks.
//
// MODEL (locked decision, phase-04-plan.md): center-line directed waypoints per travel
// direction, offset laterally toward the right-hand side of that direction (right-hand
// traffic). Intersection nodes join incoming lanes to outgoing lanes (straight/left/right;
// U-turns excluded). Straight-through is just the next node in a lane's own chain; turn
// edges are the extra incoming→outgoing hops added at intersections.
//
// DERIVATION — "roads are the road-typed tiles (ring + arterial rows/cols), assume nothing
// else, derive everything from tile data": a column carries North/South lanes iff EVERY
// tile in that column is road ("a full vertical line"); a row carries East/West lanes iff
// EVERY tile in that row is road ("a full horizontal line"). generate.ts always draws the
// ring and every arterial as a full-width line, so this is a lossless reconstruction of the
// road skeleton purely from `tiles` — no other assumption about layout is made. A tile is a
// true 4-way intersection iff its column AND its row both qualify; because every vertical
// line's row-range and every horizontal line's col-range are bounded by the ring (which is
// itself always a full line on both edges), every lane's chain starts and ends at a real
// intersection — no lane ever dead-ends off the edge of the map.
//
// NODE IDENTITY: `nodes[i].id === i` always — callers may index `nodes` directly instead of
// searching by id. `outEdges[nodeId]` holds indices into `edges` (TrafficGraph's own doc
// comment), built by a single pass over `edges` after they're all known.
//
// DETERMINISM: zero rng. Every loop below iterates plain ascending arrays built from the
// tile grid, so the same `tiles` always produces a deeply-equal graph (test-proven).

import { TRAFFIC, WORLD } from '../config';
import {
  tileCenter,
  tileIndex,
  type Tile,
  type TrafficEdge,
  type TrafficGraph,
  type TrafficNode,
} from './types';

type Direction = 'N' | 'S' | 'E' | 'W';

// Clockwise compass order: turnRight = next entry, turnLeft = previous entry, U-turn (two
// steps away) is never produced, which is how U-turn edges stay excluded without an
// explicit check.
const COMPASS: readonly Direction[] = ['N', 'E', 'S', 'W'];

function turnRight(dir: Direction): Direction {
  return COMPASS[(COMPASS.indexOf(dir) + 1) % 4];
}

function turnLeft(dir: Direction): Direction {
  return COMPASS[(COMPASS.indexOf(dir) + 3) % 4];
}

// Unit forward vector (dx,dz) per direction in the locked +Z-is-south frame. North is
// toward -Z (up the map), East toward +X.
const FORWARD: Record<Direction, { dx: number; dz: number }> = {
  N: { dx: 0, dz: -1 },
  S: { dx: 0, dz: 1 },
  E: { dx: 1, dz: 0 },
  W: { dx: -1, dz: 0 },
};

/**
 * Right-hand lateral unit vector for a travel direction: right = forward × up (three.js
 * Y-up convention), i.e. right.x = -forward.z, right.z = forward.x. Checked against compass
 * intuition: facing North, right hand points East — matches North America's right-hand
 * traffic (northbound lane sits on the east half of the road).
 */
function rightOf(dir: Direction): { dx: number; dz: number } {
  const f = FORWARD[dir];
  return { dx: -f.dz, dz: f.dx };
}

/** Composite key identifying one (tile, travel-direction) lane node, for the dedupe/lookup
 * map used while wiring chain and turn edges. */
function laneKey(col: number, row: number, dir: Direction): string {
  return `${col},${row},${dir}`;
}

/**
 * Ascending "stops" along one axis of travel: every entry of `crossings` (the intersection
 * positions — always kept, always the first/last stop) plus evenly spaced waypoints
 * inserted strictly between consecutive crossings, `spacingTiles` apart. Shared by every
 * line on that axis, because which rows cross a vertical line (or which cols cross a
 * horizontal line) doesn't depend on which line it is — only on the other axis's road
 * layout.
 */
function buildStops(crossings: readonly number[], spacingTiles: number): number[] {
  const stops: number[] = [];
  for (let i = 0; i < crossings.length; i++) {
    stops.push(crossings[i]);
    if (i + 1 < crossings.length) {
      const next = crossings[i + 1];
      for (let p = crossings[i] + spacingTiles; p < next; p += spacingTiles) stops.push(p);
    }
  }
  return stops;
}

/**
 * Build the directed road graph from the tile grid. See the file header for the model,
 * derivation, and invariants.
 */
export function buildTrafficGraph(tiles: readonly Tile[]): TrafficGraph {
  if (tiles.length === 0) {
    throw new Error('buildTrafficGraph: empty tile grid');
  }

  const N = WORLD.tiles;
  const isRoad = (col: number, row: number): boolean => tiles[tileIndex(col, row)].type === 'road';

  // A column (row) "fully" carries road traffic iff every tile on it is road — the ring
  // road and every arterial are drawn as full-width lines (generate.ts), so this recovers
  // exactly the set of N/S-carrying columns and E/W-carrying rows from tile data alone.
  const verticalCols: number[] = []; // cols carrying North/South lanes
  const horizontalRows: number[] = []; // rows carrying East/West lanes
  for (let col = 0; col < N; col++) {
    let full = true;
    for (let row = 0; row < N; row++) {
      if (!isRoad(col, row)) {
        full = false;
        break;
      }
    }
    if (full) verticalCols.push(col);
  }
  for (let row = 0; row < N; row++) {
    let full = true;
    for (let col = 0; col < N; col++) {
      if (!isRoad(col, row)) {
        full = false;
        break;
      }
    }
    if (full) horizontalRows.push(row);
  }

  // Stop positions shared by every line on an axis (see buildStops doc comment).
  const verticalStops = buildStops(horizontalRows, TRAFFIC.waypointSpacingTiles); // rows
  const horizontalStops = buildStops(verticalCols, TRAFFIC.waypointSpacingTiles); // cols
  const crossRowsSet = new Set(horizontalRows);
  const crossColsSet = new Set(verticalCols);

  const nodes: TrafficNode[] = [];
  const edges: TrafficEdge[] = [];
  const nodeAt = new Map<string, number>();

  const addNode = (col: number, row: number, dir: Direction, kind: TrafficNode['kind']): number => {
    const center = tileCenter(col, row);
    const right = rightOf(dir);
    const id = nodes.length; // node id === array index (invariant, see file header)
    nodes.push({
      id,
      x: center.x + right.dx * TRAFFIC.laneOffsetM,
      z: center.z + right.dz * TRAFFIC.laneOffsetM,
      kind,
      tileIndex: tileIndex(col, row),
    });
    nodeAt.set(laneKey(col, row, dir), id);
    return id;
  };
  const addEdge = (from: number, to: number): void => {
    edges.push({ from, to });
  };

  // --- Vertical lines: North/South lanes -------------------------------------------------
  for (const col of verticalCols) {
    const southIds: number[] = [];
    const northIds: number[] = [];
    for (const row of verticalStops) {
      const kind: TrafficNode['kind'] = crossRowsSet.has(row) ? 'intersection' : 'waypoint';
      southIds.push(addNode(col, row, 'S', kind));
      northIds.push(addNode(col, row, 'N', kind));
    }
    // South travels with increasing row; North travels with decreasing row.
    for (let i = 0; i < southIds.length - 1; i++) addEdge(southIds[i], southIds[i + 1]);
    for (let i = northIds.length - 1; i > 0; i--) addEdge(northIds[i], northIds[i - 1]);
  }

  // --- Horizontal lines: East/West lanes --------------------------------------------------
  for (const row of horizontalRows) {
    const eastIds: number[] = [];
    const westIds: number[] = [];
    for (const col of horizontalStops) {
      const kind: TrafficNode['kind'] = crossColsSet.has(col) ? 'intersection' : 'waypoint';
      eastIds.push(addNode(col, row, 'E', kind));
      westIds.push(addNode(col, row, 'W', kind));
    }
    // East travels with increasing col; West travels with decreasing col.
    for (let i = 0; i < eastIds.length - 1; i++) addEdge(eastIds[i], eastIds[i + 1]);
    for (let i = westIds.length - 1; i > 0; i--) addEdge(westIds[i], westIds[i - 1]);
  }

  // --- Intersection turn choices -----------------------------------------------------------
  // Every (col, row) with col a vertical-line column AND row a horizontal-line row is a true
  // 4-way intersection (both axes qualify by definition), so all four direction nodes are
  // guaranteed present here — that's why the lookups below only need a defensive skip, never
  // a thrown assertion. Straight-through is already the chain edge built above; this adds
  // only the extra left/right hops (U-turns are structurally impossible: turnLeft/turnRight
  // never yield the opposite direction).
  for (const col of verticalCols) {
    for (const row of horizontalRows) {
      for (const dir of COMPASS) {
        const from = nodeAt.get(laneKey(col, row, dir));
        if (from === undefined) continue;
        for (const turn of [turnLeft(dir), turnRight(dir)]) {
          const to = nodeAt.get(laneKey(col, row, turn));
          if (to === undefined) continue;
          addEdge(from, to);
        }
      }
    }
  }

  // --- outEdges: edge indices leaving each node, built in one pass over the final edge list.
  const outEdges: number[][] = nodes.map(() => []);
  edges.forEach((edge, edgeIndex) => outEdges[edge.from].push(edgeIndex));

  return { nodes, edges, outEdges };
}
