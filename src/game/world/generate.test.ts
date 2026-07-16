import { describe, expect, it } from 'vitest';
import { WORLD } from '../config';
import { generate } from './generate';
import { districtIdAt, tileIndex, type TileType, type WorldData } from './types';

const N = WORLD.tiles;
const [MIN_GAP, MAX_GAP] = WORLD.arterialEvery;
const VALID_TYPES: readonly TileType[] = ['road', 'building', 'park', 'parkingLot', 'transformerLot'];
const SEEDS = [0, 1, 416, 2024, 0xdeadbeef]; // fixed spread for structural checks

/** FNV-1a 32-bit hash of a string → 8-char hex. Stable across platforms (integer ops). */
function stableHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Columns whose every tile is road === ring cols {0, N-1} ∪ arterial cols. */
function fullRoadCols(w: WorldData): number[] {
  const cols: number[] = [];
  for (let col = 0; col < N; col++) {
    let all = true;
    for (let row = 0; row < N; row++) {
      if (w.tiles[tileIndex(col, row)].type !== 'road') {
        all = false;
        break;
      }
    }
    if (all) cols.push(col);
  }
  return cols;
}

function fullRoadRows(w: WorldData): number[] {
  const rows: number[] = [];
  for (let row = 0; row < N; row++) {
    let all = true;
    for (let col = 0; col < N; col++) {
      if (w.tiles[tileIndex(col, row)].type !== 'road') {
        all = false;
        break;
      }
    }
    if (all) rows.push(row);
  }
  return rows;
}

describe('generate — determinism', () => {
  it('two calls with the same seed are deeply equal', () => {
    expect(generate(416)).toEqual(generate(416));
  });

  it('different seeds produce different cities', () => {
    expect(generate(416)).not.toEqual(generate(417));
  });

  // Golden hash: pins the entire output for seed 416 so accidental generator drift fails
  // loudly. An INTENTIONAL generator change must recompute and update this constant.
  it('matches the pinned golden hash for seed 416', () => {
    // Hash history: '477d3671' pre-traffic-graph stub era → '2d72d2a1' when the real
    // buildTrafficGraph() landed → '6611450f' when Phase 5's camera-occlusion decision
    // retuned WORLD_GEN tower weight/heights → 'a7181498' street-front tower zoning →
    // '71399c6f' street-front small-height cap (road-adjacent smalls roll only the lowest
    // bucket so the follow camera clears their roofs).
    expect(stableHash(JSON.stringify(generate(416)))).toBe('71399c6f');
  });
});

describe('generate — WorldData shape', () => {
  const w = generate(416);

  it('has a 64×64 flat tile grid', () => {
    expect(w.tiles).toHaveLength(N * N);
  });

  it('exposes the seed, 16 districts, a populated traffic graph, and no landmark slots', () => {
    expect(w.seed).toBe(416);
    expect(w.districts).toHaveLength(WORLD.districts * WORLD.districts);
    w.districts.forEach((d, i) => expect(d.id).toBe(i));
    // Structural invariants live in trafficGraph.test.ts; here we only pin that generate()
    // wires the real builder (non-empty, consistent shape).
    expect(w.graph.nodes.length).toBeGreaterThan(0);
    expect(w.graph.edges.length).toBeGreaterThan(0);
    expect(w.graph.outEdges).toHaveLength(w.graph.nodes.length);
    expect(w.landmarkSlots).toEqual([]);
    expect(w.blocks.length).toBeGreaterThan(0);
    expect(w.buildings.length).toBeGreaterThan(0);
  });
});

describe('generate — tile invariants (all seeds)', () => {
  it('every tile has a valid type, correct districtId, and road ⇔ blockId -1', () => {
    for (const seed of SEEDS) {
      const w = generate(seed);
      for (let row = 0; row < N; row++) {
        for (let col = 0; col < N; col++) {
          const t = w.tiles[tileIndex(col, row)];
          expect(t.col).toBe(col);
          expect(t.row).toBe(row);
          expect(VALID_TYPES).toContain(t.type);
          expect(t.districtId).toBe(districtIdAt(col, row));
          if (t.type === 'road') expect(t.blockId).toBe(-1);
          else expect(t.blockId).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });
});

describe('generate — road network', () => {
  it('the perimeter is a ring road on every seed', () => {
    for (const seed of SEEDS) {
      const w = generate(seed);
      for (let i = 0; i < N; i++) {
        expect(w.tiles[tileIndex(i, 0)].type).toBe('road');
        expect(w.tiles[tileIndex(i, N - 1)].type).toBe('road');
        expect(w.tiles[tileIndex(0, i)].type).toBe('road');
        expect(w.tiles[tileIndex(N - 1, i)].type).toBe('road');
      }
    }
  });

  it('BFS from any road tile reaches every road tile (4-neighbour connectivity)', () => {
    for (const seed of SEEDS) {
      const w = generate(seed);
      const roads = new Set<number>();
      w.tiles.forEach((t, idx) => {
        if (t.type === 'road') roads.add(idx);
      });
      const start = roads.values().next().value as number;
      const seen = new Set<number>([start]);
      const stack = [start];
      while (stack.length > 0) {
        const idx = stack.pop() as number;
        const col = idx % N;
        const row = (idx - col) / N;
        const neighbours = [
          row > 0 ? idx - N : -1,
          row < N - 1 ? idx + N : -1,
          col > 0 ? idx - 1 : -1,
          col < N - 1 ? idx + 1 : -1,
        ];
        for (const n of neighbours) {
          if (n >= 0 && roads.has(n) && !seen.has(n)) {
            seen.add(n);
            stack.push(n);
          }
        }
      }
      expect(seen.size).toBe(roads.size);
    }
  });

  // Interior arterials are the full-road lines excluding the two ring lines {0, N-1}. Ring
  // interaction: the walk starts a seeded gap in from col/row 0, so the near-ring gap (0 →
  // first arterial) is also in [MIN_GAP, MAX_GAP]; the FAR-ring gap (last arterial → N-1) is
  // whatever remainder is left and is deliberately NOT constrained, so it is excluded here.
  it('consecutive interior arterial gaps are within [4, 6] on both axes', () => {
    for (const seed of SEEDS) {
      const w = generate(seed);
      for (const lines of [fullRoadCols(w), fullRoadRows(w)]) {
        const interior = lines.filter((l) => l !== 0 && l !== N - 1);
        expect(interior.length).toBeGreaterThan(0);
        // Near-ring gap: 0 → first interior arterial.
        expect(interior[0]).toBeGreaterThanOrEqual(MIN_GAP);
        expect(interior[0]).toBeLessThanOrEqual(MAX_GAP);
        // Arterial-to-arterial gaps.
        for (let i = 1; i < interior.length; i++) {
          const gap = interior[i] - interior[i - 1];
          expect(gap).toBeGreaterThanOrEqual(MIN_GAP);
          expect(gap).toBeLessThanOrEqual(MAX_GAP);
        }
      }
    }
  });
});

describe('generate — transformer lots (TDD §5.8)', () => {
  it('places exactly one per district (0..15) on a transformerLot tile, every seed', () => {
    for (const seed of SEEDS) {
      const w = generate(seed);
      expect(w.transformers).toHaveLength(WORLD.districts * WORLD.districts);
      // One per district id, sorted.
      expect(w.transformers.map((t) => t.districtId)).toEqual(
        Array.from({ length: WORLD.districts * WORLD.districts }, (_, i) => i),
      );
      // Each sits on a transformerLot tile inside its own district.
      for (const t of w.transformers) {
        const tile = w.tiles[tileIndex(t.col, t.row)];
        expect(tile.type).toBe('transformerLot');
        expect(tile.districtId).toBe(t.districtId);
      }
      // No stray transformerLot tiles beyond the 16 recorded lots.
      expect(w.tiles.filter((tile) => tile.type === 'transformerLot')).toHaveLength(16);
    }
  });
});

describe('generate — building footprints', () => {
  it('are in bounds, on non-road tiles, sized 1..2, in-block, and never overlap', () => {
    for (const seed of SEEDS) {
      const w = generate(seed);
      const occupied = new Set<number>();
      for (const b of w.buildings) {
        expect([1, 2]).toContain(b.w);
        expect([1, 2]).toContain(b.h);
        expect(b.heightM).toBeGreaterThan(0);
        const anchorBlock = w.tiles[tileIndex(b.col, b.row)].blockId;
        expect(anchorBlock).toBeGreaterThanOrEqual(0);
        for (let dr = 0; dr < b.h; dr++) {
          for (let dc = 0; dc < b.w; dc++) {
            const col = b.col + dc;
            const row = b.row + dr;
            expect(col).toBeLessThan(N);
            expect(row).toBeLessThan(N);
            const idx = tileIndex(col, row);
            const tile = w.tiles[idx];
            expect(tile.type).not.toBe('road'); // footprints never pave a road
            expect(tile.type).not.toBe('transformerLot'); // never on the fenced lot
            expect(tile.blockId).toBe(anchorBlock); // never crosses a block boundary
            expect(occupied.has(idx)).toBe(false); // pairwise non-overlapping
            occupied.add(idx);
          }
        }
      }
    }
  });

  it('zoning: no tower footprint tile is adjacent to a road (street-front stays low-rise)', () => {
    // Phase 5 camera-occlusion rule (see fillBlock) — the fixed follow camera must never
    // end up inside a roadside tower.
    for (const seed of SEEDS) {
      const w = generate(seed);
      for (const b of w.buildings) {
        if (b.kind !== 'tower') continue;
        for (let dr = 0; dr < b.h; dr++) {
          for (let dc = 0; dc < b.w; dc++) {
            const col = b.col + dc;
            const row = b.row + dr;
            const neighbours = [
              [col, row - 1],
              [col, row + 1],
              [col - 1, row],
              [col + 1, row],
            ] as const;
            for (const [nc, nr] of neighbours) {
              if (nc < 0 || nr < 0 || nc >= N || nr >= N) continue;
              expect(w.tiles[tileIndex(nc, nr)].type).not.toBe('road');
            }
          }
        }
      }
    }
  });
});

describe('generate — performance', () => {
  it('runs well under budget (median of 5 < 100 ms; target < 50 ms)', () => {
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      generate(1000 + i);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const median = times[2];
    console.log(`generate() median of 5 runs: ${median.toFixed(2)} ms`);
    expect(median).toBeLessThan(100);
  });
});
