// Pure no-navmesh road-graph navigation helpers for pursuit AI (Phase 16 Task 5, the
// consolidated phase-09..12 "organic BUSTED unreachable / units wedge at distant targets" debt).
// Numbers in, numbers out — NO three.js / Rapier imports (only the pure city `TrafficGraph` +
// `Tile` data and `WORLD` config), so every function unit-tests without the wasm module, exactly
// like ai/aiSteering.ts and ai/squad.ts.
//
// Two independent capabilities the runtime service (ai/roadNav.ts) and the spawn director
// (ai/spawnDirector.ts) both draw on:
//   • GREEDY ROAD PATHING — `approachWaypoint`: from a unit's position, hop one node along the
//     directed lane graph toward the player's nearest node (the neighbour that most reduces
//     straight-line distance to that node). Greedy single-step is enough on a Manhattan road
//     grid (the map is ring + full-line arterials — world/trafficGraph.ts), and the caller
//     re-evaluates every 10 Hz think, so the unit "beads" node-to-node toward the player instead
//     of driving its nose into the building faces between them. No A*; the TDD keeps pursuit
//     OFF the graph for movement — this only produces a STEERING HINT the physical chase + the
//     3-ray avoidance still layer on top of.
//   • CHEAP TILE LINE-OF-SIGHT — `lineLosClear` / `sampleLineDrivable`: sample a handful of
//     interior points along a straight segment and score the fraction that sit on drivable
//     (road/park/parkingLot) tiles. A raycast-free "is there an open driving lane between these
//     two points" proxy, used both to decide when a unit should road-follow rather than beeline
//     and to bias spawn-ring candidates toward a clear approach.
//
// Tile frame + drivable set match ai/squad.ts's clampToDrivable (same pure city data, same
// convention) — an intentional small parallel rather than a shared import, so this stays a
// self-contained pure module (the codebase's established convention for these tiny helpers).

import { WORLD } from '../config';
import { tileIndex, type Tile, type TileType, type TrafficGraph } from '../world/types';

/** A planar point (matches ai/squad.ts's Vec2 / ai/aiSteering's target shape). */
export interface NavPoint {
  readonly x: number;
  readonly z: number;
}

/** Tile types a vehicle can drive on (buildings solid, transformer lots fenced). Mirrors
 * ai/squad.ts's DRIVABLE_TILE_TYPES. */
const DRIVABLE_TILE_TYPES: ReadonlySet<TileType> = new Set<TileType>(['road', 'park', 'parkingLot']);

function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Flat-grid (col, row) of a world-space point, clamped to the map bounds (matches
 * ai/squad.ts's worldToColRow / world/types.ts's tileCenter frame). */
export function worldToColRow(x: number, z: number): { col: number; row: number } {
  const half = (WORLD.tiles * WORLD.tileSize) / 2;
  const max = WORLD.tiles - 1;
  return {
    col: clampInt(Math.floor((x + half) / WORLD.tileSize), 0, max),
    row: clampInt(Math.floor((z + half) / WORLD.tileSize), 0, max),
  };
}

/** Is the tile under world-space (x, z) drivable? Out-of-array indices read as NOT drivable. */
export function isDrivableAt(tiles: readonly Tile[], x: number, z: number): boolean {
  const { col, row } = worldToColRow(x, z);
  const t = tiles[tileIndex(col, row)];
  return t !== undefined && DRIVABLE_TILE_TYPES.has(t.type);
}

// ===========================================================================================
// Nearest graph node (node id === array index — world/trafficGraph.ts invariant)
// ===========================================================================================

/** Index (= node id) of the graph node nearest (x, z); −1 for an empty node list. */
export function nearestNodeIndex(nodes: readonly NavPoint[], x: number, z: number): number {
  let best = -1;
  let bestD2 = Infinity;
  for (let i = 0; i < nodes.length; i++) {
    const dx = nodes[i].x - x;
    const dz = nodes[i].z - z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = i;
    }
  }
  return best;
}

/** Straight-line distance (m) to the nearest graph node; Infinity for an empty list. Backs the
 * spawn director's road-proximity bias (a road tile far from any lane node is a disconnected
 * stub — a bad place to spawn a pursuer). */
export function nearestNodeDist(nodes: readonly NavPoint[], x: number, z: number): number {
  let bestD2 = Infinity;
  for (let i = 0; i < nodes.length; i++) {
    const dx = nodes[i].x - x;
    const dz = nodes[i].z - z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD2) bestD2 = d2;
  }
  return Math.sqrt(bestD2);
}

// ===========================================================================================
// Greedy road-graph stepping
// ===========================================================================================

/**
 * The successor of `fromNodeId` (via its outEdges) whose position most reduces straight-line
 * distance to `targetNodeId`'s node — the greedy next hop toward the player. Returns
 * `fromNodeId` itself when it is already the target, has no outgoing edges, or the target node
 * is missing (defensive). Pure; the graph's own invariants (node id === index, outEdges hold
 * edge indices) come from world/trafficGraph.ts.
 */
export function greedyNextNode(graph: TrafficGraph, fromNodeId: number, targetNodeId: number): number {
  if (fromNodeId === targetNodeId) return fromNodeId;
  const outs = graph.outEdges[fromNodeId];
  if (outs === undefined || outs.length === 0) return fromNodeId;
  const target = graph.nodes[targetNodeId];
  if (target === undefined) return fromNodeId;

  let best = fromNodeId;
  let bestD2 = Infinity;
  for (const edgeIndex of outs) {
    const edge = graph.edges[edgeIndex];
    if (edge === undefined) continue;
    const n = graph.nodes[edge.to];
    if (n === undefined) continue;
    const dx = n.x - target.x;
    const dz = n.z - target.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = edge.to;
    }
  }
  return best;
}

/**
 * A road-graph waypoint to steer toward when approaching the player: the world position of the
 * greedy next node along the lane graph from the unit's nearest node toward the player's nearest
 * node. Returns null for an empty graph. When the unit and player share a nearest node (already
 * within a tile — rare, the caller only asks when they're far apart) it returns that node's
 * position. Pure.
 */
export function approachWaypoint(
  graph: TrafficGraph,
  fromX: number,
  fromZ: number,
  targetX: number,
  targetZ: number,
): NavPoint | null {
  const nodes = graph.nodes;
  if (nodes.length === 0) return null;
  const fromNode = nearestNodeIndex(nodes, fromX, fromZ);
  const targetNode = nearestNodeIndex(nodes, targetX, targetZ);
  if (fromNode < 0 || targetNode < 0) return null;
  if (fromNode === targetNode) {
    const n = nodes[targetNode];
    return { x: n.x, z: n.z };
  }
  const next = greedyNextNode(graph, fromNode, targetNode);
  const n = nodes[next];
  return { x: n.x, z: n.z };
}

// ===========================================================================================
// Cheap tile-sampled line-of-sight
// ===========================================================================================

/**
 * Fraction (0..1) of `samples` INTERIOR points along the segment (x0,z0)→(x1,z1) that sit on a
 * drivable tile. Endpoints are excluded (the unit and player are themselves on drivable ground,
 * so sampling them would bias the result) — points are taken at i/(samples+1) for i=1..samples.
 * A raycast-free proxy for "is there a clear driving lane between these points". Pure.
 */
export function sampleLineDrivable(
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  tiles: readonly Tile[],
  samples: number,
): number {
  const n = Math.max(1, Math.floor(samples));
  let drivable = 0;
  for (let i = 1; i <= n; i++) {
    const t = i / (n + 1);
    if (isDrivableAt(tiles, x0 + (x1 - x0) * t, z0 + (z1 - z0) * t)) drivable++;
  }
  return drivable / n;
}

/** True when at least `clearFrac` of the sampled interior points along the segment are drivable
 * — i.e. the straight-line approach is mostly open road, not blocked by building faces. */
export function lineLosClear(
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  tiles: readonly Tile[],
  samples: number,
  clearFrac: number,
): boolean {
  return sampleLineDrivable(x0, z0, x1, z1, tiles, samples) >= clearFrac;
}
