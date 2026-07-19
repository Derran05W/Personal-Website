// The Toronto thermometer-map NavProvider (Phase 30 D1). Answers the four pursuit nav questions
// (see ai/navProvider.ts) off world/toronto's road graph + street ribbons instead of a tile grid:
//
//   • isDrivable(x,z)        — point-in-ribbon test over the §3a street rectangles (world space).
//   • nearestRoadPoint(x,z)  — clamp the point onto the nearest ribbon rectangle (returns it
//                              unchanged when already on a ribbon), so a SWAT flank slot that
//                              landed in a building/void snaps onto the closest road.
//   • nextWaypoint(a→b)      — BFS first-hop over the lane graph: the neighbour of a's nearest
//                              node that lies on a shortest node-path to b's nearest node. BFS
//                              (not greedy) so the narrow Yonge stem between downtown / midtown /
//                              North York never dead-ends a chase. Cheap (976 nodes / ~1.2k edges
//                              post Phase-31 direction-offset lanes — was 505/~1.1k pre-fix; the
//                              adjacency below is now built off DIRECTED edges, which is exactly
//                              what a lane-respecting BFS should walk).
//   • spawnCandidates()      — every lane-graph node as a RoadPoint (all on-road by construction,
//                              so the director's uniform behind-camera ring pick converges; no
//                              approach-bias context needed → spawnNav() is undefined).
//
// A prebuilt uniform-grid SPATIAL HASH over the graph nodes backs the two nearest-node lookups
// nextWaypoint needs (10 Hz × ≤10 pursuers) — nearest is an expanding-ring search with the same
// conservative early-out ai/squad.clampToDrivable uses, unit-tested against a brute-force scan.
//
// Pure geometry, no three/rapier — the street table + graph + ribbons are pure functions of the
// §3a data (world/toronto/streets.ts, roadGraph.ts), so this whole provider unit-tests headless.

import { WAYPOINT_SPACING_WU } from '../config/torontoMap';
import type { TrafficGraph } from '../world/types';
import { buildTorontoRoadGraph, buildRibbons, type Ribbon } from '../world/toronto/roadGraph';
import { buildStreets } from '../world/toronto/streets';
import type { NavProvider, NavPoint } from './navProvider';
import type { RoadPoint, SpawnNavContext } from './spawnDirector';

// Spatial-hash cell size: one waypoint spacing. Nodes sit ~this far apart along a street, so a
// query point lands within a couple of rings of its nearest node. Derived from config (no magic).
const CELL = WAYPOINT_SPACING_WU;

/** A uniform-grid spatial hash over planar points, with a correct expanding-ring nearest query.
 * Prebuilt once per world (the graph is seed-independent). */
class NodeHash {
  private readonly buckets = new Map<string, number[]>();
  private readonly maxRing: number;
  private readonly nodes: readonly NavPoint[];

  constructor(nodes: readonly NavPoint[]) {
    this.nodes = nodes;
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.x < minX) minX = n.x;
      if (n.z < minZ) minZ = n.z;
      if (n.x > maxX) maxX = n.x;
      if (n.z > maxZ) maxZ = n.z;
      const k = keyOf(cellOf(n.x), cellOf(n.z));
      (this.buckets.get(k) ?? this.buckets.set(k, []).get(k)!).push(i);
    }
    // Worst-case rings to scan: the grid's Chebyshev extent + 1 (safety cap so a query far outside
    // the map still terminates). Finite even for an empty node list (extents stay ±Infinity → 0).
    const spanCells = Number.isFinite(minX)
      ? Math.max(1, Math.ceil((maxX - minX) / CELL), Math.ceil((maxZ - minZ) / CELL))
      : 0;
    this.maxRing = spanCells + 2;
  }

  /** Index of the node nearest (x,z), or −1 for an empty node set. Expanding Chebyshev rings with
   * the clampToDrivable early-out: once the best hit is within r·CELL, no ring > r can beat it. */
  nearest(x: number, z: number): number {
    const cx = cellOf(x);
    const cz = cellOf(z);
    let best = -1;
    let bestD2 = Infinity;
    for (let r = 0; r <= this.maxRing; r++) {
      for (const [gx, gz] of ringCells(cx, cz, r)) {
        const bucket = this.buckets.get(keyOf(gx, gz));
        if (bucket === undefined) continue;
        for (const i of bucket) {
          const dx = this.nodes[i].x - x;
          const dz = this.nodes[i].z - z;
          const d2 = dx * dx + dz * dz;
          if (d2 < bestD2) {
            bestD2 = d2;
            best = i;
          }
        }
      }
      // Any node in a ring beyond r is at least r·CELL away (the query point sits inside ring 0's
      // cell) — once our best is that close, farther rings can't improve it.
      if (best >= 0) {
        const ringMin = r * CELL;
        if (ringMin * ringMin >= bestD2) break;
      }
    }
    return best;
  }
}

function cellOf(v: number): number {
  return Math.floor(v / CELL);
}
function keyOf(cx: number, cz: number): string {
  return `${cx}:${cz}`;
}

/** (cx,cz) cells at exactly Chebyshev distance r from (cx0,cz0) — the ring shell (r=0 → the centre
 * cell itself). Mirrors squad.ringTiles. */
function ringCells(cx0: number, cz0: number, r: number): [number, number][] {
  if (r === 0) return [[cx0, cz0]];
  const out: [number, number][] = [];
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
      out.push([cx0 + dx, cz0 + dz]);
    }
  }
  return out;
}

/** Squared distance from (x,z) to its clamp onto ribbon rect `rib`, plus the clamp point. */
function clampToRibbon(rib: Ribbon, x: number, z: number): { x: number; z: number; d2: number } {
  const cxp = x < rib.minX ? rib.minX : x > rib.maxX ? rib.maxX : x;
  const czp = z < rib.minZ ? rib.minZ : z > rib.maxZ ? rib.maxZ : z;
  const dx = cxp - x;
  const dz = czp - z;
  return { x: cxp, z: czp, d2: dx * dx + dz * dz };
}

/** BFS first-hop over the graph's adjacency: the id of the neighbour of `from` on a shortest
 * node-path to `target`, or `from` itself when from === target / unreachable / isolated. */
function bfsFirstHop(adjacency: readonly (readonly number[])[], from: number, target: number): number {
  if (from === target) return from;
  const parent = new Int32Array(adjacency.length).fill(-2); // -2 = unvisited, -1 = root
  parent[from] = -1;
  const queue: number[] = [from];
  let head = 0;
  while (head < queue.length) {
    const node = queue[head++];
    for (const next of adjacency[node]) {
      if (parent[next] !== -2) continue;
      parent[next] = node;
      if (next === target) {
        // Backtrack to the hop directly out of `from`.
        let cur = next;
        while (parent[cur] !== from) {
          cur = parent[cur];
          if (cur < 0) return from; // defensive (unreachable via a broken chain)
        }
        return cur;
      }
      queue.push(next);
    }
  }
  return from; // target unreachable from this component — hold position (physical layer copes)
}

/**
 * Build the Toronto NavProvider. The street table, lane graph, ribbons, spatial hash, and
 * adjacency are all derived once (seed-independent pure geometry).
 */
export function createTorontoNavProvider(): NavProvider {
  const streets = buildStreets().streets;
  const graph: TrafficGraph = buildTorontoRoadGraph(streets);
  const ribbons = buildRibbons(streets);
  const nodes = graph.nodes;
  const hash = new NodeHash(nodes);

  // Adjacency (node id → neighbour node ids) for BFS, built directly off the graph's edges to
  // avoid the edge-index indirection. Phase 31: the graph's edges are DIRECTED lane edges (the
  // direction-offset fix — see roadGraph.ts's file header), so this BFS now walks legal travel
  // directions only; the graph stays strongly connected (every hub has both a forward and a
  // return chain), so a route always exists, it just may no longer be the straight-line shortest
  // hop count where that would mean cutting against a lane's direction.
  const adjacency: number[][] = nodes.map(() => []);
  for (const edge of graph.edges) adjacency[edge.from].push(edge.to);

  const candidates: RoadPoint[] = nodes.map((n) => ({ x: n.x, z: n.z, tileIndex: n.id }));

  return {
    isDrivable(x, z) {
      for (const rib of ribbons) {
        if (x >= rib.minX && x <= rib.maxX && z >= rib.minZ && z <= rib.maxZ) return true;
      }
      return false;
    },
    nearestRoadPoint(x, z) {
      let best: NavPoint = { x, z };
      let bestD2 = Infinity;
      for (const rib of ribbons) {
        const c = clampToRibbon(rib, x, z);
        if (c.d2 === 0) return { x, z }; // already on a ribbon
        if (c.d2 < bestD2) {
          bestD2 = c.d2;
          best = { x: c.x, z: c.z };
        }
      }
      return best;
    },
    nextWaypoint(fromX, fromZ, targetX, targetZ) {
      if (nodes.length === 0) return null;
      const fromNode = hash.nearest(fromX, fromZ);
      const targetNode = hash.nearest(targetX, targetZ);
      if (fromNode < 0 || targetNode < 0) return null;
      const hop = bfsFirstHop(adjacency, fromNode, targetNode);
      const n = nodes[hop];
      return { x: n.x, z: n.z };
    },
    spawnCandidates() {
      return candidates;
    },
    spawnNav(): SpawnNavContext | undefined {
      return undefined; // candidates are all lane nodes → uniform behind-camera ring pick converges
    },
  };
}
