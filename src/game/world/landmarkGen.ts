// Toronto landmark layer (Phase 19, TDD §13) — the seeded reservation + selection helpers the
// generator (world/generate.ts) calls to produce WorldData.landmarks. Consumers documented on
// LandmarkData (world/types.ts): Task 2 mounts the CN Tower / stadium / flatiron meshes on the
// reserved 'landmark' lots and reads the Kensington/midtown district ids for archetype swaps;
// Task 3 drives streetcars along `streetcarAvenues`.
//
// PURE and deterministic. `reserveLandmarkLots` MUTATES the in-flight tile `type` array and the
// generator's `reserved` set (exactly like the transformer step it runs beside), retyping each
// chosen tile to 'landmark' so no building packs onto it and no street prop derives on it
// (propPlacements.ts filters by the other tile types, so 'landmark' is skipped everywhere by
// construction). Everything else here is a read-only derivation. All rng comes from forks the
// caller passes in, so the same seed yields identical landmarks (test-proven in
// generate.test.ts). ZERO three/rapier imports — safe for the pure generator.

import { WORLD } from '../config';
import type { Rng } from './rng';
import {
  tileCenter,
  tileIndex,
  type LandmarkData,
  type LandmarkPoint,
  type LanePath,
  type TileType,
  type WorldData,
} from './types';

// --- Tunables (generator-shaping placeholders; landmarks are structural, not gameplay) ----

/** Stadium footprint sizes (w×h tiles), tried LARGEST → smallest until one fits a clear
 * lakefront lot. Capped at 5 wide/tall: interior blocks between arterials (every 4-6 tiles)
 * are at most 5 tiles across, so a bigger rectangle could never sit clear of a road. 3×3
 * always fits (the minimum inter-arterial block is 3×3), so a lot is guaranteed. */
const STADIUM_SIZES: readonly (readonly [number, number])[] = [
  [5, 4],
  [4, 4],
  [4, 3],
  [3, 3],
];

/** Seeded ± jitter (tiles) on the stadium's ideal center column, so the south-center lot
 * slides a little by seed instead of pinning to dead-center every time ("stable-feeling"). */
const STADIUM_COL_JITTER = 4;

// --- Reserved-lot selection (mutates type + reserved) -------------------------------------

/** The three reserved landmark lots, in tile space (world positions are derived later by
 * {@link assembleLandmarks}). */
export interface ReservedLots {
  readonly cnTower: { readonly col: number; readonly row: number };
  readonly stadium: { readonly col: number; readonly row: number; readonly w: number; readonly h: number };
  readonly flatiron: { readonly col: number; readonly row: number; readonly rot: number };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Reserve the CN Tower + stadium (south-center lakefront) and the flatiron corner lot,
 * retyping each tile to 'landmark' and adding it to `reserved` (so block fill and transformer
 * placement skip them). Returns the chosen lots in tile space. Called after districts, before
 * transformer placement and block fill.
 */
export function reserveLandmarkLots(
  N: number,
  type: TileType[],
  reserved: Set<number>,
  rng: Rng,
): ReservedLots {
  const inBounds = (col: number, row: number): boolean =>
    col >= 0 && col < N && row >= 0 && row < N;
  const isRoad = (col: number, row: number): boolean =>
    inBounds(col, row) && type[tileIndex(col, row)] === 'road';
  // A tile a landmark lot may claim: in bounds, not a road, not already reserved/landmarked.
  const buildable = (col: number, row: number): boolean => {
    if (!inBounds(col, row)) return false;
    const idx = tileIndex(col, row);
    return type[idx] !== 'road' && type[idx] !== 'landmark' && !reserved.has(idx);
  };
  const reserve = (col: number, row: number): void => {
    const idx = tileIndex(col, row);
    type[idx] = 'landmark';
    reserved.add(idx);
  };

  const stadium = reserveStadium(N, buildable, reserve, rng.fork('stadium'));
  const cnTower = reserveCnTower(stadium, buildable, reserve);
  const flatiron = reserveFlatiron(N, isRoad, buildable, reserve, rng.fork('flatiron'));
  return { cnTower, stadium, flatiron };
}

/** Southernmost clear rectangle near the (seed-jittered) center column: prefer the biggest
 * footprint that fits, and among rows the one closest to the lakefront (row N-2), tie-broken
 * toward the ideal center column. */
function reserveStadium(
  N: number,
  buildable: (col: number, row: number) => boolean,
  reserve: (col: number, row: number) => void,
  rng: Rng,
): ReservedLots['stadium'] {
  const idealCol = clamp(Math.round(N / 2) + rng.int(-STADIUM_COL_JITTER, STADIUM_COL_JITTER), 1, N - 2);

  const footprintClear = (col0: number, row0: number, w: number, h: number): boolean => {
    for (let dr = 0; dr < h; dr++) {
      for (let dc = 0; dc < w; dc++) {
        if (!buildable(col0 + dc, row0 + dr)) return false;
      }
    }
    return true;
  };

  for (const [w, h] of STADIUM_SIZES) {
    // row0 descending = south edge (row0+h-1) descending: the first row that admits a clear
    // footprint is the southernmost lot for this size. row0 ∈ [1, N-1-h] keeps the footprint
    // off both ring roads (rows 0 and N-1).
    for (let row0 = N - 1 - h; row0 >= 1; row0--) {
      let bestCol = -1;
      let bestDist = Infinity;
      for (let col0 = 1; col0 <= N - 1 - w; col0++) {
        if (!footprintClear(col0, row0, w, h)) continue;
        const centerCol = col0 + (w - 1) / 2;
        const dist = Math.abs(centerCol - idealCol);
        if (dist < bestDist) {
          bestDist = dist;
          bestCol = col0; // ascending scan ⇒ lowest col0 wins ties naturally
        }
      }
      if (bestCol >= 0) {
        for (let dr = 0; dr < h; dr++) for (let dc = 0; dc < w; dc++) reserve(bestCol + dc, row0 + dr);
        return { col: bestCol, row: row0, w, h };
      }
    }
  }
  // Unreachable: a 3×3 clear rectangle always exists between arterials (see STADIUM_SIZES).
  throw new Error('reserveStadium: no clear lakefront lot found');
}

/** CN Tower point: prefer a clear tile just NORTH of the stadium (tower behind the stadium,
 * facing the lake), then the north row across the footprint, then east/west flanks. Falls back
 * to the stadium's own north-center tile (already reserved) if the stadium fills its block. */
function reserveCnTower(
  stadium: ReservedLots['stadium'],
  buildable: (col: number, row: number) => boolean,
  reserve: (col: number, row: number) => void,
): ReservedLots['cnTower'] {
  const { col: sc, row: sr, w, h } = stadium;
  const centerCol = sc + Math.floor((w - 1) / 2);
  const candidates: (readonly [number, number])[] = [[centerCol, sr - 1]];
  for (let c = sc; c < sc + w; c++) candidates.push([c, sr - 1]); // rest of the north row
  for (let r = sr; r < sr + h; r++) {
    candidates.push([sc - 1, r]); // west flank
    candidates.push([sc + w, r]); // east flank
  }
  for (const [c, r] of candidates) {
    if (buildable(c, r)) {
      reserve(c, r);
      return { col: c, row: r };
    }
  }
  // Fallback: share the stadium's north-center tile (tower sits on the lot's north edge).
  return { col: centerCol, row: sr };
}

/** Flatiron corner: a buildable tile with a road neighbour on BOTH a vertical and a horizontal
 * side (a block corner where two orthogonal arterials meet — every road here is a full line, so
 * these are always true intersections). Seeded pick from candidates kept clear of the map edges
 * and the lakefront band; `rot` points the wedge toward the intersection diagonal. */
function reserveFlatiron(
  N: number,
  isRoad: (col: number, row: number) => boolean,
  buildable: (col: number, row: number) => boolean,
  reserve: (col: number, row: number) => void,
  rng: Rng,
): ReservedLots['flatiron'] {
  interface Corner {
    readonly col: number;
    readonly row: number;
    readonly dc: number;
    readonly dr: number;
  }
  const collect = (loCol: number, hiCol: number, loRow: number, hiRow: number): Corner[] => {
    const out: Corner[] = [];
    for (let row = loRow; row <= hiRow; row++) {
      for (let col = loCol; col <= hiCol; col++) {
        if (!buildable(col, row)) continue;
        const roadN = isRoad(col, row - 1);
        const roadS = isRoad(col, row + 1);
        const roadW = isRoad(col - 1, row);
        const roadE = isRoad(col + 1, row);
        if ((!roadN && !roadS) || (!roadW && !roadE)) continue; // needs a corner
        out.push({ col, row, dc: roadW ? -1 : 1, dr: roadN ? -1 : 1 });
      }
    }
    return out;
  };
  // Prefer corners away from edges + the southern lakefront band; widen if (implausibly) none.
  let corners = collect(4, N - 5, 4, N - 9);
  if (corners.length === 0) corners = collect(2, N - 3, 2, N - 3);
  const pick = corners[rng.int(0, corners.length - 1)];
  reserve(pick.col, pick.row);
  // yaw such that local +Z points toward (dc,dr), the intersection diagonal (propPlacements'
  // shared yawToward convention: atan2(dx, dz)).
  return { col: pick.col, row: pick.row, rot: Math.atan2(pick.dc, pick.dr) };
}

// --- District personality picks -----------------------------------------------------------

/**
 * Pick the Kensington and midtown districts from an eligible pool (caller excludes the spawn
 * district, the lakefront district row, and any district holding a reserved landmark lot). Two
 * distinct ids when the pool allows. Deterministic from `rng`. Returns -1s only if the pool is
 * empty (defensive — never happens for a real 16-district world).
 */
export function pickPersonalityDistricts(
  eligible: readonly number[],
  rng: Rng,
): { kensingtonDistrictId: number; midtownDistrictId: number } {
  if (eligible.length === 0) return { kensingtonDistrictId: -1, midtownDistrictId: -1 };
  const kensingtonDistrictId = eligible[rng.int(0, eligible.length - 1)];
  const rest = eligible.filter((id) => id !== kensingtonDistrictId);
  const midtownDistrictId = rest.length > 0 ? rest[rng.int(0, rest.length - 1)] : kensingtonDistrictId;
  return { kensingtonDistrictId, midtownDistrictId };
}

// --- Streetcar avenues --------------------------------------------------------------------

/**
 * The two streetcar avenues = the two LONGEST interior arterials, tie-break lower road id.
 * Every interior arterial is a FULL road line spanning the whole map (trafficGraph.ts derives
 * the graph from exactly that property), so their drivable lengths are identical — the "two
 * longest" rule therefore resolves entirely through the tie-break. Road ids are assigned
 * deterministically: N/S columns (ascending) first, then E/W rows (ascending). Result: the two
 * lowest-id N/S arterials — two parallel uptown avenues streetcars run end-to-end.
 *
 * Each returned avenue is a bare LanePath — the MEDIAN centerline polyline (tile centers, no
 * lane offset; streetcars ride the middle of the road) from one ring end to the other. Shape is
 * exactly what Task 3 (ai/streetcarTraffic.ts) consumes directly (a `{x,z}[]` it validates and
 * loops); the axis/road-id provenance stays internal to this selection.
 */
export function buildStreetcarAvenues(
  arterialCols: readonly number[],
  arterialRows: readonly number[],
  N: number,
): LanePath[] {
  interface Cand {
    readonly axis: 'ns' | 'ew';
    readonly roadIndex: number;
    readonly roadId: number;
    readonly length: number;
  }
  const span = N * WORLD.tileSize; // identical for every full line
  const cands: Cand[] = [];
  let roadId = 0;
  for (const col of [...arterialCols].sort((a, b) => a - b)) {
    cands.push({ axis: 'ns', roadIndex: col, roadId: roadId++, length: span });
  }
  for (const row of [...arterialRows].sort((a, b) => a - b)) {
    cands.push({ axis: 'ew', roadIndex: row, roadId: roadId++, length: span });
  }
  cands.sort((a, b) => b.length - a.length || a.roadId - b.roadId);
  return cands.slice(0, Math.min(2, cands.length)).map((c) => centerline(c.axis, c.roadIndex, N));
}

/** The full-map median centerline of one arterial line, as a {x,z} polyline (one point per
 * tile, ring end to ring end). */
function centerline(axis: 'ns' | 'ew', roadIndex: number, N: number): LandmarkPoint[] {
  const pts: LandmarkPoint[] = [];
  for (let i = 0; i < N; i++) {
    const { x, z } = axis === 'ns' ? tileCenter(roadIndex, i) : tileCenter(i, roadIndex);
    pts.push({ x, z });
  }
  return pts;
}

// --- World-space assembly -----------------------------------------------------------------

/** World-space center of a w×h footprint anchored at NW tile (col,row). */
function footprintCenterWorld(col: number, row: number, w: number, h: number): LandmarkPoint {
  const nw = tileCenter(col, row);
  return {
    x: nw.x + ((w - 1) / 2) * WORLD.tileSize,
    z: nw.z + ((h - 1) / 2) * WORLD.tileSize,
  };
}

/** Turn the tile-space reserved lots + district picks + avenues into the final LandmarkData
 * (with world-space positions on each lot). */
export function assembleLandmarks(
  lots: ReservedLots,
  kensingtonDistrictId: number,
  midtownDistrictId: number,
  streetcarAvenues: readonly LanePath[],
): LandmarkData {
  const tower = tileCenter(lots.cnTower.col, lots.cnTower.row);
  const flat = tileCenter(lots.flatiron.col, lots.flatiron.row);
  const stadiumC = footprintCenterWorld(lots.stadium.col, lots.stadium.row, lots.stadium.w, lots.stadium.h);
  return {
    cnTower: { col: lots.cnTower.col, row: lots.cnTower.row, x: tower.x, z: tower.z },
    stadium: {
      col: lots.stadium.col,
      row: lots.stadium.row,
      w: lots.stadium.w,
      h: lots.stadium.h,
      x: stadiumC.x,
      z: stadiumC.z,
    },
    flatiron: { col: lots.flatiron.col, row: lots.flatiron.row, rot: lots.flatiron.rot, x: flat.x, z: flat.z },
    kensingtonDistrictId,
    midtownDistrictId,
    streetcarAvenues,
  };
}

// --- Debug teleport helper ----------------------------------------------------------------

/** World-space center of a district (debug teleport target). */
export function districtCenterWorld(districtId: number): LandmarkPoint {
  const per = WORLD.tiles / WORLD.districts;
  const dCol = districtId % WORLD.districts;
  const dRow = Math.floor(districtId / WORLD.districts);
  const nw = tileCenter(dCol * per, dRow * per);
  return {
    x: nw.x + ((per - 1) / 2) * WORLD.tileSize,
    z: nw.z + ((per - 1) / 2) * WORLD.tileSize,
  };
}

/** One teleport target the dev panel wires into a button. */
export interface LandmarkTeleport {
  readonly id: string;
  readonly x: number;
  readonly z: number;
}

/**
 * LANDMARK_POINTS-style helper: id → {x,z} for every landmark, for the orchestrator's
 * teleport-to-landmark debug buttons. Empty for a world without a landmark layer (read
 * defensively). Districts resolve to their center; each streetcar avenue to its midpoint.
 */
export function landmarkTeleportPoints(world: WorldData): readonly LandmarkTeleport[] {
  const L = world.landmarks;
  if (!L) return [];
  const out: LandmarkTeleport[] = [
    { id: 'CN Tower', x: L.cnTower.x, z: L.cnTower.z },
    { id: 'Stadium', x: L.stadium.x, z: L.stadium.z },
    { id: 'Flatiron', x: L.flatiron.x, z: L.flatiron.z },
  ];
  if (L.kensingtonDistrictId >= 0) {
    const c = districtCenterWorld(L.kensingtonDistrictId);
    out.push({ id: 'Kensington', x: c.x, z: c.z });
  }
  if (L.midtownDistrictId >= 0) {
    const c = districtCenterWorld(L.midtownDistrictId);
    out.push({ id: 'Midtown', x: c.x, z: c.z });
  }
  L.streetcarAvenues.forEach((av, i) => {
    const mid = av[Math.floor(av.length / 2)];
    if (mid) out.push({ id: `Streetcar ${i + 1}`, x: mid.x, z: mid.z });
  });
  return out;
}
