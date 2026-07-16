// WorldData — the single typed output of seeded world generation (TDD §5.4, §5.8) and
// the single input to every world consumer:
//   Phase 5 rendering/instancing (buildings, props, palette; district-grouped buffers),
//   Phase 6 physics props (parking lots → parked cars; transformer HP),
//   Phase 7 civilian traffic (graph followers),
//   Phase 9 spawn director (road tiles in the spawn ring),
//   Phase 13 powergrid (districts + transformer lots),
//   Phase 19 landmarks (reserved slots).
// Everything here is pure data — zero three/rapier imports, fully serializable, and
// deterministic for a given seed (test-proven in world/generate.test.ts).
//
// Frame conventions (locked during Phase 3): 1 unit = 1 m, Y-up, +Z is world SOUTH.
// The map is centered on the origin: tile (col, row) spans
//   x ∈ [(col − tiles/2) · tileSize, +tileSize), z ∈ [(row − tiles/2) · tileSize, +tileSize)
// so col grows toward +X (east) and row grows toward +Z (south). Row `tiles − 1` is the
// lakefront edge (TDD §5.4: south edge is water).

import { WORLD } from '../config';

export type TileType = 'road' | 'building' | 'park' | 'parkingLot' | 'transformerLot';

/** One 10 m map tile. `grid[tileIndex(col,row)]`. */
export interface Tile {
  readonly col: number; // 0..WORLD.tiles-1, grows toward +X
  readonly row: number; // 0..WORLD.tiles-1, grows toward +Z (south)
  readonly type: TileType;
  /** 0..15 — which 16×16-tile district this tile belongs to (TDD §5.8). */
  readonly districtId: number;
  /** Contiguous non-road region id, or -1 on road tiles. */
  readonly blockId: number;
}

/** A contiguous non-road region bounded by roads/map edge, before/after fill. */
export interface Block {
  readonly id: number;
  /** District of the block's top-left tile (blocks can straddle districts; tiles carry
   * their own districtId — this is only a convenience for coarse queries). */
  readonly districtId: number;
  /** Tile indices (into WorldData.tiles) composing the block. */
  readonly tileIndices: readonly number[];
}

/** Axis-aligned building footprint in tile space; placeholder boxes now (Phase 4),
 * real instanced variants in Phase 5. */
export interface BuildingFootprint {
  readonly col: number;
  readonly row: number;
  /** Footprint size in tiles: 1×1..2×2 small, 2×2 towers (TDD §5.4). */
  readonly w: number;
  readonly h: number;
  readonly kind: 'small' | 'tower';
  /** Seeded height in meters — placeholder scale-feel now, Phase 5 variant input. */
  readonly heightM: number;
  readonly districtId: number;
}

/** Exactly one per district (TDD §5.8): fenced corner lot with the transformer prop. */
export interface TransformerLot {
  readonly districtId: number;
  readonly col: number;
  readonly row: number;
}

/** 16×16-tile district (4×4 grid of them). Phase 13's blackout unit. */
export interface District {
  readonly id: number; // 0..15, id = dRow * 4 + dCol
  readonly dCol: number;
  readonly dRow: number;
  /** Tile-space origin (top-left tile col/row). */
  readonly col0: number;
  readonly row0: number;
}

/** Directed traffic-graph node. Positions are WORLD-space (x,z), lane offset already
 * applied (right-hand side of travel direction) — followers consume positions as-is. */
export interface TrafficNode {
  readonly id: number;
  readonly x: number;
  readonly z: number;
  readonly kind: 'intersection' | 'waypoint';
  /** Tile the node sits on (always a road tile — test-proven). */
  readonly tileIndex: number;
}

export interface TrafficEdge {
  readonly from: number; // TrafficNode id
  readonly to: number;
}

/** Directed graph civilians follow (Phase 7). Pursuit AI never paths on it (TDD §5.4). */
export interface TrafficGraph {
  readonly nodes: readonly TrafficNode[];
  readonly edges: readonly TrafficEdge[];
  /** outEdges[nodeId] = ids of edges leaving that node (turn choices at intersections). */
  readonly outEdges: readonly (readonly number[])[];
}

/** Reserved Toronto-landmark placement (Phase 19). Always empty in v1 generation —
 * typed now so consumers handle the field from day one. */
export interface LandmarkSlot {
  readonly id: string;
  readonly col: number;
  readonly row: number;
  readonly w: number;
  readonly h: number;
}

/** The whole generated city. Pure data; deterministic per seed. */
export interface WorldData {
  readonly seed: number;
  /** Flat 64×64, index = row * WORLD.tiles + col (see tileIndex). */
  readonly tiles: readonly Tile[];
  readonly blocks: readonly Block[];
  readonly buildings: readonly BuildingFootprint[];
  /** Length 16, sorted by districtId. */
  readonly transformers: readonly TransformerLot[];
  /** Length 16, sorted by id. */
  readonly districts: readonly District[];
  readonly graph: TrafficGraph;
  readonly landmarkSlots: readonly LandmarkSlot[];
}

// --- Tile-space helpers (shared by generator, rendering, minimap, tests) ---------------

export function tileIndex(col: number, row: number): number {
  return row * WORLD.tiles + col;
}

/** World-space center of a tile. Map is centered on the origin. */
export function tileCenter(col: number, row: number): { x: number; z: number } {
  const half = (WORLD.tiles * WORLD.tileSize) / 2;
  return {
    x: col * WORLD.tileSize - half + WORLD.tileSize / 2,
    z: row * WORLD.tileSize - half + WORLD.tileSize / 2,
  };
}

/** District id for a tile position (4×4 grid of 16×16 tiles). */
export function districtIdAt(col: number, row: number): number {
  const per = WORLD.tiles / WORLD.districts; // 16
  return Math.floor(row / per) * WORLD.districts + Math.floor(col / per);
}
