// WorldData — the single typed output of seeded world generation (TDD §5.4, §5.8) and
// the single input to every world consumer:
//   Phase 5 rendering/instancing (buildings, props, palette; district-grouped buffers),
//   Phase 6 physics props (parking lots → parked cars; transformer HP),
//   Phase 7 civilian traffic (graph followers),
//   Phase 9 spawn director (road tiles in the spawn ring),
//   Phase 13 powergrid (districts + transformer lots),
//   Phase 19 landmarks (Toronto landmark layer — WorldData.landmarks, the reserved
//            CN-Tower/stadium/flatiron lots, Kensington/midtown district picks, and the
//            two streetcar avenues; see LandmarkData).
// Everything here is pure data — zero three/rapier imports, fully serializable, and
// deterministic for a given seed (test-proven in world/generate.test.ts).
//
// Frame conventions (locked during Phase 3): 1 unit = 1 m, Y-up, +Z is world SOUTH.
// The map is centered on the origin: tile (col, row) spans
//   x ∈ [(col − tiles/2) · tileSize, +tileSize), z ∈ [(row − tiles/2) · tileSize, +tileSize)
// so col grows toward +X (east) and row grows toward +Z (south). Row `tiles − 1` is the
// lakefront edge (TDD §5.4: south edge is water).

import { WORLD } from '../config';

// 'landmark' (Phase 19): a tile reserved for a Toronto set-piece (CN Tower / stadium /
// flatiron). Cleared like a lot — no building footprint packs onto it and no street prop
// derives on it (propPlacements.ts filters by the other types, so 'landmark' is skipped
// everywhere by construction) — leaving the ground bare for Task 2's standalone mesh to mount.
export type TileType = 'road' | 'building' | 'park' | 'parkingLot' | 'transformerLot' | 'landmark';

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

/** Reserved Toronto-landmark placement (Phase 4 stub). SUPERSEDED by `LandmarkData` /
 * `WorldData.landmarks` (Phase 19); `landmarkSlots` is retained as an always-empty field only
 * to keep older WorldData literals (test mocks) compiling — new code reads `landmarks`. */
export interface LandmarkSlot {
  readonly id: string;
  readonly col: number;
  readonly row: number;
  readonly w: number;
  readonly h: number;
}

// --- Toronto landmark layer (Phase 19, TDD §13) ------------------------------------------
// generate() reserves a handful of landmark lots (retyping their tiles to 'landmark' and
// clearing any building/prop that would collide), tags two districts with a "personality",
// and picks two streetcar avenues — all seeded, so the same seed yields identical landmarks.

/** A world-space point on the flat ground plane (y implied 0). */
export interface LandmarkPoint {
  readonly x: number;
  readonly z: number;
}

/** CN Tower slot: a single reserved 'landmark' tile near the south-center lakefront. Task 2
 * renders the stylized tower (base-cylinder collider only) centered at {x,z}. */
export interface CnTowerLandmark extends LandmarkPoint {
  readonly col: number;
  readonly row: number;
}

/** Stadium slot: a reserved w×h 'landmark' footprint on the lakefront beside the CN Tower.
 * {x,z} is the footprint CENTER; col/row is the NW (min-col, min-row) anchor tile. */
export interface StadiumLandmark extends LandmarkPoint {
  readonly col: number;
  readonly row: number;
  readonly w: number;
  readonly h: number;
}

/** Flatiron slot: a single reserved 'landmark' corner tile at an (orthogonal) arterial
 * intersection. `rot` is the Y-yaw in radians (world +Z-is-forward convention,
 * `atan2(dx, dz)`) that points the wedge's sharp end toward the intersection corner. */
export interface FlatironLandmark extends LandmarkPoint {
  readonly col: number;
  readonly row: number;
  readonly rot: number;
}

/** One streetcar avenue: an ordered MEDIAN centerline polyline — tile-center {x,z} points (NOT
 * the lane-offset traffic-graph nodes; streetcars ride the middle of the road) spanning a full
 * arterial line from one ring-road end to the other. Task 3 (ai/streetcarTraffic.ts) consumes
 * each avenue DIRECTLY as this point array (it validates length ≥ 2 and finite x/z, then builds
 * a there-and-back kinematic loop), so the shape is deliberately a bare polyline, not an object.
 * The generator's selection rule (two longest arterials, tie-break lower road id) is documented
 * in world/landmarkGen.ts — it isn't carried on the seam because no consumer needs it. */
export type LanePath = readonly LandmarkPoint[];

/** The whole Phase 19 landmark layer for one world. Optional on WorldData so mocks and older
 * consumers read it defensively (`world.landmarks?.…`); ALWAYS populated by generate(). */
export interface LandmarkData {
  readonly cnTower: CnTowerLandmark;
  readonly stadium: StadiumLandmark;
  readonly flatiron: FlatironLandmark;
  /** District whose buildings render narrow, colorful and low-rise (Kensington). */
  readonly kensingtonDistrictId: number;
  /** District biased to the tallest tower variants — density/height reads as midtown. */
  readonly midtownDistrictId: number;
  /** The two longest arterials (tie-break: lower road id), each a median centerline polyline
   * (see LanePath). Length 2 for a real world. */
  readonly streetcarAvenues: readonly LanePath[];
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
  /** Phase 19 Toronto landmark layer. Optional in the type (read defensively — see
   * LandmarkData) but always present on a generate()'d world. */
  readonly landmarks?: LandmarkData;
  /** @deprecated Phase 4 stub, always []. Use `landmarks`. Kept only for mock compatibility. */
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
