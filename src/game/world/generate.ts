// Seeded city generator — the single producer of WorldData (world/types.ts). PURE
// TypeScript: zero three/rapier/react imports, fully synchronous, target < 50 ms. The
// same seed always yields a deeply-equal WorldData (test-proven), so runs are shareable
// and reproducible from the score screen (TDD §5.4).
//
// Consumers of the result (documented on each type in world/types.ts):
//   Phase 5  rendering/instancing — tiles, blocks, buildings, district grouping,
//   Phase 6  destruction physics  — parking-lot tiles → parked cars; transformer HP,
//   Phase 7  civilian traffic     — the traffic graph (stubbed here; Task 2 fills it),
//   Phase 9  spawn director       — road tiles inside the spawn ring,
//   Phase 13 power grid           — districts + one transformer lot each,
//   Phase 19 landmarks            — reserved (always-empty in v1) landmark slots.
//
// Pipeline (order matters — later steps read what earlier ones stamped):
//   1. road skeleton  → outer ring road + seeded arterials on both axes
//   2. tiles          → type + district for every cell
//   3. blocks         → flood-fill contiguous non-road regions (4-neighbour)
//   4. districts      → the 4×4 blackout grid (TDD §5.8)
//   5. transformers   → exactly one fenced corner lot per district
//   6. block fill     → per-block kind + non-overlapping building footprints
//   7. graph          → buildTrafficGraph() (Phase 4 stub)

import { WORLD, WORLD_GEN } from '../config';
import { createRng, type Rng } from './rng';
import { buildTrafficGraph } from './trafficGraph';
import {
  districtIdAt,
  tileIndex,
  type Block,
  type BuildingFootprint,
  type District,
  type Tile,
  type TileType,
  type TransformerLot,
  type WorldData,
} from './types';

/** The kind rolled per block during fill — the keys of WORLD_GEN.blockKindWeights. */
type BlockKind = keyof typeof WORLD_GEN.blockKindWeights;

/**
 * Generate the whole city for `seed`. Deterministic and pure — see the file header for the
 * pipeline and consumers.
 */
export function generate(seed: number): WorldData {
  const N = WORLD.tiles; // grid dimension (single source of truth — never hardcode 64)
  const [minGap, maxGap] = WORLD.arterialEvery;

  // Two independent streams so cosmetic rolls (heights) can never shift structure.
  const root = createRng(seed);
  const layout = root.fork('layout');
  const cosmetic = root.fork('cosmetic');

  // --- 1. Road skeleton ----------------------------------------------------------------
  // The map PERIMETER is a ring road (col/row 0 and N-1). This makes the lattice fully
  // edge-connected, so barriers and the south lakefront sit just OUTSIDE a drivable ring
  // and no block is ever stranded against a map edge. Interior arterials are walked with a
  // seeded [minGap,maxGap] step; consecutive interior gaps are therefore always in that
  // range. The ring is SEPARATE from that spacing — the leftover gap between the outermost
  // arterial and the ring is whatever the walk lands on (see generate.test.ts).
  const arterialCols = walkArterials(layout.fork('arterials-x'), N, minGap, maxGap);
  const arterialRows = walkArterials(layout.fork('arterials-y'), N, minGap, maxGap);
  const colIsArterial = toFlags(arterialCols, N);
  const rowIsArterial = toFlags(arterialRows, N);
  const isRoad = (col: number, row: number): boolean =>
    col === 0 ||
    row === 0 ||
    col === N - 1 ||
    row === N - 1 ||
    colIsArterial[col] ||
    rowIsArterial[row];

  // --- 2. Tiles: type + district (blockId filled in step 3) -----------------------------
  // Working arrays kept mutable through the pipeline; frozen into readonly Tile records at
  // the end. Non-road tiles default to 'building'; block fill overrides to park/parkingLot.
  const type: TileType[] = new Array<TileType>(N * N);
  const blockId: number[] = new Array<number>(N * N).fill(-1);
  for (let row = 0; row < N; row++) {
    for (let col = 0; col < N; col++) {
      type[tileIndex(col, row)] = isRoad(col, row) ? 'road' : 'building';
    }
  }

  // --- 3. Blocks: flood-fill contiguous non-road regions --------------------------------
  const blocks: Block[] = [];
  for (let row = 0; row < N; row++) {
    for (let col = 0; col < N; col++) {
      const start = tileIndex(col, row);
      if (type[start] === 'road' || blockId[start] !== -1) continue;
      const id = blocks.length;
      const tileIndices = floodFill(start, N, type, blockId, id);
      blocks.push({ id, districtId: districtIdAt(col, row), tileIndices });
    }
  }

  // --- 4. Districts: 4×4 grid of 16×16-tile blackout units (TDD §5.8) --------------------
  const districts: District[] = [];
  const perDistrict = N / WORLD.districts; // 16
  for (let id = 0; id < WORLD.districts * WORLD.districts; id++) {
    const dCol = id % WORLD.districts;
    const dRow = Math.floor(id / WORLD.districts);
    districts.push({ id, dCol, dRow, col0: dCol * perDistrict, row0: dRow * perDistrict });
  }

  // --- 5. Transformer lots: exactly one per district ------------------------------------
  // `reserved` tiles are removed from footprint packing so a building never lands on the
  // fenced transformer lot.
  const transformers: TransformerLot[] = [];
  const reserved = new Set<number>();
  for (const d of districts) {
    const idx = pickTransformerTile(d, perDistrict, type, layout.fork(`transformer:${d.id}`));
    type[idx] = 'transformerLot';
    reserved.add(idx);
    transformers.push({ districtId: d.id, col: idx % N, row: Math.floor(idx / N) });
  }

  // --- 6. Block fill: kind per block + footprint packing --------------------------------
  const buildings: BuildingFootprint[] = [];
  const kindEntries = Object.entries(WORLD_GEN.blockKindWeights) as [BlockKind, number][];
  for (const block of blocks) {
    const kind = weightedPick(layout.fork(`kind:${block.id}`), kindEntries, (e) => e[1])[0];
    fillBlock(
      block,
      kind,
      N,
      type,
      reserved,
      buildings,
      layout.fork(`pack:${block.id}`),
      cosmetic.fork(`height:${block.id}`),
    );
  }

  // --- 7. Freeze tiles + build the (stubbed) traffic graph ------------------------------
  const tiles: Tile[] = new Array<Tile>(N * N);
  for (let row = 0; row < N; row++) {
    for (let col = 0; col < N; col++) {
      const idx = tileIndex(col, row);
      tiles[idx] = {
        col,
        row,
        type: type[idx],
        districtId: districtIdAt(col, row),
        blockId: blockId[idx],
      };
    }
  }
  const graph = buildTrafficGraph(tiles);

  return { seed, tiles, blocks, buildings, transformers, districts, graph, landmarkSlots: [] };
}

// --- Road skeleton helpers ---------------------------------------------------------------

/**
 * Interior arterial lines on one axis. Starts one seeded [minGap,maxGap] gap in from the
 * col/row-0 ring and steps by a fresh seeded gap until it passes the far ring at N-1, so
 * every consecutive interior gap is in [minGap,maxGap] by construction. Never returns 0 or
 * N-1 (those are the ring). Always returns at least one line (the first step is < N-1).
 */
function walkArterials(rng: Rng, N: number, minGap: number, maxGap: number): number[] {
  const lines: number[] = [];
  let cursor = rng.int(minGap, maxGap);
  while (cursor < N - 1) {
    lines.push(cursor);
    cursor += rng.int(minGap, maxGap);
  }
  return lines;
}

/** Boolean lookup: flags[i] is true iff i is one of the given line indices. */
function toFlags(lines: readonly number[], N: number): boolean[] {
  const flags = new Array<boolean>(N).fill(false);
  for (const l of lines) flags[l] = true;
  return flags;
}

/**
 * 4-neighbour flood fill from `start` over non-road tiles, stamping `id` into blockId as it
 * goes. Returns the block's tile indices sorted ascending (row-major) — a deterministic
 * order the packer relies on.
 */
function floodFill(
  start: number,
  N: number,
  type: readonly TileType[],
  blockId: number[],
  id: number,
): number[] {
  const indices: number[] = [];
  const stack: number[] = [start];
  blockId[start] = id;
  while (stack.length > 0) {
    const idx = stack.pop();
    if (idx === undefined) break; // unreachable (guarded by length) — satisfies the type
    indices.push(idx);
    const col = idx % N;
    const row = (idx - col) / N;
    const neighbours = [
      row > 0 ? idx - N : -1,
      row < N - 1 ? idx + N : -1,
      col > 0 ? idx - 1 : -1,
      col < N - 1 ? idx + 1 : -1,
    ];
    for (const n of neighbours) {
      if (n >= 0 && type[n] !== 'road' && blockId[n] === -1) {
        blockId[n] = id;
        stack.push(n);
      }
    }
  }
  indices.sort((a, b) => a - b);
  return indices;
}

// --- Transformer placement ---------------------------------------------------------------

/**
 * Choose the transformer tile for one district (TDD §5.8). Prefers a block CORNER adjacent
 * to road — a non-road tile with a road neighbour on both a vertical and a horizontal side,
 * which reads as a fenced street-corner lot. Falls back through: edge tiles (road on one
 * axis only) → deep-interior non-road tiles → (a safety net that is unreachable given the
 * ring + arterial grid always leaves non-road tiles in every district) any tile at all,
 * converted outright. Guaranteed to return a valid index for every district on every seed.
 */
function pickTransformerTile(
  d: District,
  perDistrict: number,
  type: readonly TileType[],
  rng: Rng,
): number {
  const corners: number[] = [];
  const edges: number[] = [];
  const interiors: number[] = [];
  const all: number[] = [];
  for (let row = d.row0; row < d.row0 + perDistrict; row++) {
    for (let col = d.col0; col < d.col0 + perDistrict; col++) {
      const idx = tileIndex(col, row);
      all.push(idx);
      if (type[idx] === 'road') continue;
      // Non-road tiles never touch the perimeter ring, so all four neighbours are in bounds.
      const roadV =
        type[tileIndex(col, row - 1)] === 'road' || type[tileIndex(col, row + 1)] === 'road';
      const roadH =
        type[tileIndex(col - 1, row)] === 'road' || type[tileIndex(col + 1, row)] === 'road';
      if (roadV && roadH) corners.push(idx);
      else if (roadV || roadH) edges.push(idx);
      else interiors.push(idx);
    }
  }
  const pool =
    corners.length > 0
      ? corners
      : edges.length > 0
        ? edges
        : interiors.length > 0
          ? interiors
          : all;
  return rng.pick(pool);
}

// --- Block fill --------------------------------------------------------------------------

/**
 * Fill one block: parks/parking lots retype every (non-reserved) tile; building blocks keep
 * the default 'building' type and overlay non-overlapping footprints. Towers pack 2×2 only;
 * a block too small/skinny for even one 2×2 degrades to smallBuildings so it never renders
 * empty. Reserved (transformer) tiles are never retyped and never packed over.
 */
function fillBlock(
  block: Block,
  kind: BlockKind,
  N: number,
  type: TileType[],
  reserved: ReadonlySet<number>,
  buildings: BuildingFootprint[],
  packRng: Rng,
  heightRng: Rng,
): void {
  if (kind === 'park' || kind === 'parkingLot') {
    const t: TileType = kind === 'park' ? 'park' : 'parkingLot';
    for (const idx of block.tileIndices) {
      if (!reserved.has(idx)) type[idx] = t;
    }
    return;
  }

  // Building blocks. blockSet bounds every footprint to this block; occupied starts with
  // the reserved (transformer) tiles so packing skips them and never double-covers a tile.
  const blockSet = new Set(block.tileIndices);
  const occupied = new Set<number>(reserved);
  const effective: BlockKind =
    kind === 'tower' && !anyFits(block, blockSet, occupied, N, 2, 2) ? 'smallBuildings' : kind;

  for (const idx of block.tileIndices) {
    if (occupied.has(idx)) continue;
    const col = idx % N;
    const row = (idx - col) / N;

    // Towers are always 2×2; small buildings roll a weighted size.
    let w = 2;
    let h = 2;
    if (effective === 'smallBuildings') {
      const shape = weightedPick(packRng, WORLD_GEN.footprintSizes, (s) => s.weight);
      w = shape.w;
      h = shape.h;
    }
    if (!fits(col, row, w, h, blockSet, occupied, N)) continue; // leftover paved yard

    for (let dr = 0; dr < h; dr++) {
      for (let dc = 0; dc < w; dc++) {
        occupied.add(tileIndex(col + dc, row + dr));
      }
    }
    const fpKind: BuildingFootprint['kind'] = effective === 'tower' ? 'tower' : 'small';
    const [minH, maxH] = fpKind === 'tower' ? WORLD_GEN.towerHeightM : WORLD_GEN.smallHeightM;
    const heightM = Math.round((minH + heightRng.next() * (maxH - minH)) * 100) / 100;
    buildings.push({ col, row, w, h, kind: fpKind, heightM, districtId: districtIdAt(col, row) });
  }
}

/** True iff a w×h footprint anchored at (col,row) lands entirely on free in-block tiles. */
function fits(
  col: number,
  row: number,
  w: number,
  h: number,
  blockSet: ReadonlySet<number>,
  occupied: ReadonlySet<number>,
  N: number,
): boolean {
  for (let dr = 0; dr < h; dr++) {
    for (let dc = 0; dc < w; dc++) {
      const c = col + dc;
      const r = row + dr;
      if (c >= N || r >= N) return false;
      const idx = tileIndex(c, r);
      if (!blockSet.has(idx) || occupied.has(idx)) return false;
    }
  }
  return true;
}

/** True iff a w×h footprint fits anywhere in the block given current occupancy. */
function anyFits(
  block: Block,
  blockSet: ReadonlySet<number>,
  occupied: ReadonlySet<number>,
  N: number,
  w: number,
  h: number,
): boolean {
  for (const idx of block.tileIndices) {
    const col = idx % N;
    const row = (idx - col) / N;
    if (fits(col, row, w, h, blockSet, occupied, N)) return true;
  }
  return false;
}

// --- Weighted choice ---------------------------------------------------------------------

/**
 * Pick one item with probability proportional to weightOf(item). Consumes exactly one
 * `rng.next()`, so the number of items never changes how far the stream advances.
 */
function weightedPick<T>(rng: Rng, items: readonly T[], weightOf: (item: T) => number): T {
  let total = 0;
  for (const it of items) total += weightOf(it);
  let r = rng.next() * total;
  for (const it of items) {
    r -= weightOf(it);
    if (r < 0) return it;
  }
  return items[items.length - 1]; // float round-off guard
}
