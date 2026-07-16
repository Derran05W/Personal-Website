// Deterministic derivation of every STREET-PROP instance in the city (TDD §5.4/§5.8; Phase
// 5 Task 2) — streetlights, traffic lights, park furniture, hydrants/mailboxes, and each
// transformer lot's fence ring + transformer box. Buildings are NOT here: they render
// straight from `world.buildings` via the instancing layer's own variant-bucketing (Task 1
// / world/geometry/buildings.ts), because a building's footprint/height are structural data
// already in WorldData, not a placement decision.
//
// PURE and deterministic: forks a dedicated 'props' child stream off the world's own seed
// (world/rng.ts's fork-by-label contract), so re-deriving placements for the same WorldData
// always yields a deeply-equal result, and retuning any PROP_PLACEMENT number can never
// perturb generate.ts's own layout/cosmetic streams or its golden hash (they're forked from
// the ROOT seed inside generate(), entirely independent of this module's fork).
//
// Tile-boundary convention (types.ts's tileCenter/tileIndex): a tile's range is the
// half-open interval [center - tileSize/2, center + tileSize/2) on each axis, so a position
// exactly ON a shared edge belongs to the tile whose LOWER bound it is, not the neighbour
// whose upper bound it is — every offset below stays strictly inside its own tile (or is
// nudged in by PROP_PLACEMENT.fenceEdgeInsetM where it would otherwise land exactly on one).

import { PROP_DIMS, PROP_PLACEMENT, WORLD } from '../config';
import type { ArchetypeName } from './archetypes';
import { createRng, type Rng } from './rng';
import { tileCenter, tileIndex, type WorldData } from './types';

export interface PropPlacement {
  readonly archetype: ArchetypeName;
  readonly x: number;
  readonly z: number;
  readonly rotationY: number;
  readonly districtId: number;
  readonly tileIndex: number;
}

interface Delta {
  readonly dc: number;
  readonly dr: number;
}

const CARDINALS: readonly Delta[] = [
  { dc: 0, dr: -1 }, // N
  { dc: 0, dr: 1 }, // S
  { dc: -1, dr: 0 }, // W
  { dc: 1, dr: 0 }, // E
];

const DIAGONALS: readonly Delta[] = [
  { dc: 1, dr: -1 },
  { dc: 1, dr: 1 },
  { dc: -1, dr: 1 },
  { dc: -1, dr: -1 },
];

/** Yaw (radians) such that local +Z points toward world direction (dx,dz) — the shared
 * convention every orientable geometry builder in world/geometry/ builds "forward" along. */
function yawToward(dx: number, dz: number): number {
  return Math.atan2(dx, dz);
}

function inBounds(col: number, row: number): boolean {
  return col >= 0 && col < WORLD.tiles && row >= 0 && row < WORLD.tiles;
}

function isRoadTile(world: WorldData, col: number, row: number): boolean {
  return inBounds(col, row) && world.tiles[tileIndex(col, row)].type === 'road';
}

/** Cardinal directions from (col,row) that step onto a non-road, in-bounds neighbour. */
function sidewalkDirs(world: WorldData, col: number, row: number): Delta[] {
  return CARDINALS.filter(({ dc, dr }) => {
    const nc = col + dc;
    const nr = row + dr;
    return inBounds(nc, nr) && world.tiles[tileIndex(nc, nr)].type !== 'road';
  });
}

/** Cardinal directions from (col,row) that step onto a road tile. */
function roadDirs(world: WorldData, col: number, row: number): Delta[] {
  return CARDINALS.filter(({ dc, dr }) => isRoadTile(world, col + dc, row + dr));
}

// --- Streetlights ----------------------------------------------------------------------------
// Placed ON the road tile itself (never the adjacent building tile — the fixed-width road
// tile has plenty of room for a curb-side pole, and this guarantees zero chance of a
// streetlight overlapping a building footprint), offset toward whichever side borders a
// sidewalk, ~every Nth qualifying road tile (stride), facing back across the road.
function streetlightPlacements(world: WorldData, rng: Rng): PropPlacement[] {
  const out: PropPlacement[] = [];
  const N = WORLD.tiles;
  let qualifying = 0;
  for (let row = 0; row < N; row++) {
    for (let col = 0; col < N; col++) {
      const idx = tileIndex(col, row);
      const tile = world.tiles[idx];
      if (tile.type !== 'road') continue;
      const dirs = sidewalkDirs(world, col, row);
      if (dirs.length === 0) continue; // mid-intersection / no adjacent sidewalk
      qualifying++;
      if (qualifying % PROP_PLACEMENT.streetlightStrideRoadTiles !== 0) continue;
      const dir = rng.pick(dirs);
      const center = tileCenter(col, row);
      const off = PROP_PLACEMENT.streetlightEdgeOffsetM;
      out.push({
        archetype: 'streetlight',
        x: center.x + dir.dc * off,
        z: center.z + dir.dr * off,
        rotationY: yawToward(-dir.dc, -dir.dr), // arm reaches back over the road
        districtId: tile.districtId,
        tileIndex: idx,
      });
    }
  }
  return out;
}

// --- Traffic lights --------------------------------------------------------------------------
// True 4-way intersections (a road tile with a road neighbour on BOTH axes — the same
// "corner" heuristic generate.ts's pickTransformerTile uses, applied to the road tile
// itself instead of an adjacent lot), sparsely sampled, offset toward one of the tile's 4
// diagonal corners.
function trafficLightPlacements(world: WorldData, rng: Rng): PropPlacement[] {
  const out: PropPlacement[] = [];
  const N = WORLD.tiles;
  for (let row = 0; row < N; row++) {
    for (let col = 0; col < N; col++) {
      const idx = tileIndex(col, row);
      const tile = world.tiles[idx];
      if (tile.type !== 'road') continue;
      const dirs = roadDirs(world, col, row);
      const vertical = dirs.some((d) => d.dc === 0);
      const horizontal = dirs.some((d) => d.dr === 0);
      if (!vertical || !horizontal) continue;
      if (rng.next() >= PROP_PLACEMENT.trafficLightProbability) continue;
      const corner = rng.pick(DIAGONALS);
      const center = tileCenter(col, row);
      const off = PROP_PLACEMENT.trafficLightCornerOffsetM;
      out.push({
        archetype: 'trafficLight',
        x: center.x + corner.dc * off,
        z: center.z + corner.dr * off,
        rotationY: yawToward(-corner.dc, -corner.dr), // faces back in toward the intersection
        districtId: tile.districtId,
        tileIndex: idx,
      });
    }
  }
  return out;
}

// --- Park furniture --------------------------------------------------------------------------
// 2-4 jittered trees + a 50/50 bench per park tile, margined off the tile edges.
const BENCH_YAWS: readonly number[] = [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2];

function jitter(rng: Rng, half: number): number {
  return (rng.next() * 2 - 1) * half;
}

function parkPlacements(world: WorldData, rng: Rng): PropPlacement[] {
  const out: PropPlacement[] = [];
  const N = WORLD.tiles;
  const half = WORLD.tileSize / 2 - PROP_PLACEMENT.parkEdgeMarginM;
  const [minTrees, maxTrees] = PROP_PLACEMENT.parkTreesRange;
  for (let row = 0; row < N; row++) {
    for (let col = 0; col < N; col++) {
      const idx = tileIndex(col, row);
      const tile = world.tiles[idx];
      if (tile.type !== 'park') continue;
      const center = tileCenter(col, row);
      const treeCount = rng.int(minTrees, maxTrees);
      for (let i = 0; i < treeCount; i++) {
        out.push({
          archetype: 'tree',
          x: center.x + jitter(rng, half),
          z: center.z + jitter(rng, half),
          rotationY: 0, // radially symmetric — orientation is cosmetically inert
          districtId: tile.districtId,
          tileIndex: idx,
        });
      }
      if (rng.next() < PROP_PLACEMENT.parkBenchProbability) {
        out.push({
          archetype: 'bench',
          x: center.x + jitter(rng, half),
          z: center.z + jitter(rng, half),
          rotationY: rng.pick(BENCH_YAWS),
          districtId: tile.districtId,
          tileIndex: idx,
        });
      }
    }
  }
  return out;
}

// --- Hydrants + mailboxes ---------------------------------------------------------------------
// Sparse on building-block tiles that border a road: one placement roughly every
// [min,max] eligible tiles (re-rolled after each placement), offset toward the road-facing
// edge, archetype coin-flipped.
const EDGE_ARCHETYPES: readonly ArchetypeName[] = ['hydrant', 'mailbox'];

function edgePropPlacements(world: WorldData, rng: Rng): PropPlacement[] {
  const out: PropPlacement[] = [];
  const N = WORLD.tiles;
  const [minGap, maxGap] = PROP_PLACEMENT.edgePropSampleEvery;
  let untilNext = rng.int(minGap, maxGap);
  for (let row = 0; row < N; row++) {
    for (let col = 0; col < N; col++) {
      const idx = tileIndex(col, row);
      const tile = world.tiles[idx];
      if (tile.type !== 'building') continue;
      const dirs = roadDirs(world, col, row);
      if (dirs.length === 0) continue;
      untilNext--;
      if (untilNext > 0) continue;
      untilNext = rng.int(minGap, maxGap);
      const dir = rng.pick(dirs);
      const center = tileCenter(col, row);
      const off = PROP_PLACEMENT.edgePropOffsetM;
      out.push({
        archetype: rng.pick(EDGE_ARCHETYPES),
        x: center.x + dir.dc * off,
        z: center.z + dir.dr * off,
        rotationY: rng.next() * Math.PI * 2, // bilateral-enough shapes — free rotation is fine
        districtId: tile.districtId,
        tileIndex: idx,
      });
    }
  }
  return out;
}

// --- Transformer lots: fence ring + transformer box -------------------------------------------
// Exactly one transformer box per district (world.transformers is already length-16,
// districtId-sorted); a 3-sided fenceSegment ring around its tile, leaving the side that
// borders a road open (falling back to a fixed side — North — when no side detectably
// borders a road, per the phase-05 brief).
type Side = 'N' | 'E' | 'S' | 'W';
const SIDE_ORDER: readonly Side[] = ['N', 'E', 'S', 'W'];
const SIDE_DELTA: Record<Side, Delta> = {
  N: { dc: 0, dr: -1 },
  E: { dc: 1, dr: 0 },
  S: { dc: 0, dr: 1 },
  W: { dc: -1, dr: 0 },
};

function detectOpeningSide(world: WorldData, col: number, row: number): Side {
  for (const side of SIDE_ORDER) {
    const { dc, dr } = SIDE_DELTA[side];
    if (isRoadTile(world, col + dc, row + dr)) return side;
  }
  return 'N'; // fixed fallback — no side detectably borders a road
}

function transformerPlacements(world: WorldData): PropPlacement[] {
  const out: PropPlacement[] = [];
  const half = WORLD.tileSize / 2;
  const segLen = PROP_DIMS.fenceSegment.lengthM;
  const perSide = Math.round(WORLD.tileSize / segLen);
  const inset = PROP_PLACEMENT.fenceEdgeInsetM;

  for (const t of world.transformers) {
    const idx = tileIndex(t.col, t.row);
    const center = tileCenter(t.col, t.row);

    out.push({
      archetype: 'transformerBox',
      x: center.x,
      z: center.z,
      rotationY: 0,
      districtId: t.districtId,
      tileIndex: idx,
    });

    const opening = detectOpeningSide(world, t.col, t.row);
    for (const side of SIDE_ORDER) {
      if (side === opening) continue;
      for (let i = 0; i < perSide; i++) {
        const along = -half + (i + 0.5) * segLen; // strictly inside (0, tileSize) along the edge
        let x: number;
        let z: number;
        let rotationY: number;
        switch (side) {
          case 'N':
            x = center.x + along;
            z = center.z - half + inset;
            rotationY = 0;
            break;
          case 'S':
            x = center.x + along;
            z = center.z + half - inset;
            rotationY = 0;
            break;
          case 'E':
            x = center.x + half - inset;
            z = center.z + along;
            rotationY = Math.PI / 2;
            break;
          case 'W':
            x = center.x - half + inset;
            z = center.z + along;
            rotationY = Math.PI / 2;
            break;
        }
        out.push({
          archetype: 'fenceSegment',
          x,
          z,
          rotationY,
          districtId: t.districtId,
          tileIndex: idx,
        });
      }
    }
  }
  return out;
}

// --- Parked cars -------------------------------------------------------------------------
// 1-3 per parkingLot tile, grid-ish: all cars in one tile share a single rolled facing (one
// of the 4 cardinal yaws), arranged as a row of slots spread along the axis PERPENDICULAR to
// that facing (i.e. the cars' own width axis — a row of cars parked side-by-side, nose all
// pointing the same way), each slot getting small independent jitter on both axes plus a
// small rotation jitter off the shared base yaw. Margined off the tile edges like
// parkPlacements above.
const PARKED_CAR_YAWS: readonly number[] = [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2];

function parkingLotPlacements(world: WorldData, rng: Rng): PropPlacement[] {
  const out: PropPlacement[] = [];
  const N = WORLD.tiles;
  const half = WORLD.tileSize / 2 - PROP_PLACEMENT.parkingLotEdgeMarginM;
  const [minCars, maxCars] = PROP_PLACEMENT.parkingLotCarsRange;
  const posJitter = PROP_PLACEMENT.parkingLotJitterM;
  const rotJitter = PROP_PLACEMENT.parkingLotRotationJitterRad;
  for (let row = 0; row < N; row++) {
    for (let col = 0; col < N; col++) {
      const idx = tileIndex(col, row);
      const tile = world.tiles[idx];
      if (tile.type !== 'parkingLot') continue;
      const center = tileCenter(col, row);
      const count = rng.int(minCars, maxCars);
      const baseYaw = rng.pick(PARKED_CAR_YAWS);
      // yaw 0/π faces ±Z, so the cars' width axis (the row) runs along X; yaw π/2/3π/2
      // faces ±X, so the row runs along Z instead.
      const rowAlongX = baseYaw === 0 || baseYaw === Math.PI;
      for (let i = 0; i < count; i++) {
        const t = count === 1 ? 0 : i / (count - 1) - 0.5; // -0.5..0.5
        const rowOffset = t * 2 * half;
        const x = center.x + (rowAlongX ? rowOffset : 0) + jitter(rng, posJitter);
        const z = center.z + (rowAlongX ? 0 : rowOffset) + jitter(rng, posJitter);
        out.push({
          archetype: 'parkedCar',
          x,
          z,
          rotationY: baseYaw + jitter(rng, rotJitter),
          districtId: tile.districtId,
          tileIndex: idx,
        });
      }
    }
  }
  return out;
}

/**
 * Derive every street-prop placement for `world`. Pure and deterministic — see the file
 * header. Order is stable (streetlights, traffic lights, park furniture, edge props,
 * transformer lots, parking lots) but callers should never depend on it beyond that
 * stability.
 */
export function derivePlacements(world: WorldData): PropPlacement[] {
  const rng = createRng(world.seed).fork('props');
  return [
    ...streetlightPlacements(world, rng.fork('streetlight')),
    ...trafficLightPlacements(world, rng.fork('trafficLight')),
    ...parkPlacements(world, rng.fork('park')),
    ...edgePropPlacements(world, rng.fork('edge')),
    ...transformerPlacements(world),
    // NEW independent fork label ('parkingLot') — per rng.ts, fork() derives purely from
    // (parent base seed, label), never from consumption order, so appending this call can
    // never perturb any of the categories above (verified by propPlacements.test.ts's
    // determinism suite, which runs unchanged against the full output including this).
    ...parkingLotPlacements(world, rng.fork('parkingLot')),
  ];
}
