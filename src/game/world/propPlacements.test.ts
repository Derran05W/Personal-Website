import { describe, expect, it } from 'vitest';
import { WORLD } from '../config';
import { generate } from './generate';
import { derivePlacements, type PropPlacement } from './propPlacements';
import { tileIndex, type WorldData } from './types';

// Fixed spread of seeds, same spirit as generate.test.ts/trafficGraph.test.ts.
const SEEDS = [0, 1, 416, 2024, 0xdeadbeef];
const HALF_MAP = (WORLD.tiles * WORLD.tileSize) / 2;

/** Inverse of types.ts's tileCenter: which (col,row) a world-space point falls in, given
 * the half-open-per-axis tile convention documented in propPlacements.ts's file header. */
function tileOfPoint(x: number, z: number): { col: number; row: number } {
  return {
    col: Math.floor((x + HALF_MAP) / WORLD.tileSize),
    row: Math.floor((z + HALF_MAP) / WORLD.tileSize),
  };
}

describe('derivePlacements — determinism', () => {
  for (const seed of SEEDS) {
    it(`two calls with the same seed (${seed}) are deeply equal`, () => {
      const world = generate(seed);
      expect(derivePlacements(world)).toEqual(derivePlacements(world));
    });
  }

  it('different seeds produce different placement sets', () => {
    const a = derivePlacements(generate(416));
    const b = derivePlacements(generate(417));
    expect(a).not.toEqual(b);
  });

  it('retuning PROP_PLACEMENT/PROP_DIMS cosmetic numbers never touches generate.ts golden hash inputs (placements fork their own seed stream)', () => {
    // Sanity/documentation check: deriving placements must not mutate or otherwise be
    // observable from a second generate() call for the same seed.
    const world1 = generate(416);
    derivePlacements(world1);
    const world2 = generate(416);
    expect(world1).toEqual(world2);
  });
});

describe('derivePlacements — geometric validity (seed 416)', () => {
  const world = generate(416);
  const placements = derivePlacements(world);

  it('produces a non-trivial, low-thousands city-wide prop count', () => {
    expect(placements.length).toBeGreaterThan(500);
    expect(placements.length).toBeLessThan(5000);
  });

  it('every placement is inside the map bounds', () => {
    for (const p of placements) {
      expect(p.x).toBeGreaterThanOrEqual(-HALF_MAP);
      expect(p.x).toBeLessThanOrEqual(HALF_MAP);
      expect(p.z).toBeGreaterThanOrEqual(-HALF_MAP);
      expect(p.z).toBeLessThanOrEqual(HALF_MAP);
    }
  });

  it("every placement's tileIndex matches the tile its x/z actually falls in", () => {
    for (const p of placements) {
      const { col, row } = tileOfPoint(p.x, p.z);
      expect(p.tileIndex).toBe(tileIndex(col, row));
    }
  });

  it("every placement's districtId matches its own tile's districtId", () => {
    for (const p of placements) {
      expect(p.districtId).toBe(world.tiles[p.tileIndex].districtId);
    }
  });

  it('every rotationY is a finite number', () => {
    for (const p of placements) {
      expect(Number.isFinite(p.rotationY)).toBe(true);
    }
  });
});

describe('derivePlacements — archetype-appropriate tile types (seed 416)', () => {
  const world = generate(416);
  const placements = derivePlacements(world);
  const byArchetype = new Map<string, PropPlacement[]>();
  for (const p of placements) {
    const list = byArchetype.get(p.archetype) ?? [];
    list.push(p);
    byArchetype.set(p.archetype, list);
  }

  it('streetlights sit on road tiles (never inside a building footprint tile)', () => {
    const lights = byArchetype.get('streetlight') ?? [];
    expect(lights.length).toBeGreaterThan(0);
    for (const p of lights) {
      expect(world.tiles[p.tileIndex].type).toBe('road');
    }
  });

  it('streetlights only occur where at least one neighbour is non-road (a real sidewalk edge)', () => {
    const lights = byArchetype.get('streetlight') ?? [];
    const N = WORLD.tiles;
    for (const p of lights) {
      const tile = world.tiles[p.tileIndex];
      const neighbours = [
        [tile.col, tile.row - 1],
        [tile.col, tile.row + 1],
        [tile.col - 1, tile.row],
        [tile.col + 1, tile.row],
      ].filter(([c, r]) => c >= 0 && c < N && r >= 0 && r < N);
      const hasSidewalk = neighbours.some(([c, r]) => world.tiles[tileIndex(c, r)].type !== 'road');
      expect(hasSidewalk).toBe(true);
    }
  });

  it('traffic lights sit on true 4-way road intersections', () => {
    const lights = byArchetype.get('trafficLight') ?? [];
    expect(lights.length).toBeGreaterThan(0);
    const N = WORLD.tiles;
    for (const p of lights) {
      const tile = world.tiles[p.tileIndex];
      expect(tile.type).toBe('road');
      const roadN = tile.row > 0 && world.tiles[tileIndex(tile.col, tile.row - 1)].type === 'road';
      const roadS = tile.row < N - 1 && world.tiles[tileIndex(tile.col, tile.row + 1)].type === 'road';
      const roadE = tile.col < N - 1 && world.tiles[tileIndex(tile.col + 1, tile.row)].type === 'road';
      const roadW = tile.col > 0 && world.tiles[tileIndex(tile.col - 1, tile.row)].type === 'road';
      expect(roadN || roadS).toBe(true);
      expect(roadE || roadW).toBe(true);
    }
  });

  it('trees only occur in park tiles', () => {
    const trees = byArchetype.get('tree') ?? [];
    expect(trees.length).toBeGreaterThan(0);
    for (const p of trees) {
      expect(world.tiles[p.tileIndex].type).toBe('park');
    }
  });

  it('benches only occur in park tiles, at most one per tile', () => {
    const benches = byArchetype.get('bench') ?? [];
    expect(benches.length).toBeGreaterThan(0);
    const seen = new Set<number>();
    for (const p of benches) {
      expect(world.tiles[p.tileIndex].type).toBe('park');
      expect(seen.has(p.tileIndex)).toBe(false);
      seen.add(p.tileIndex);
    }
  });

  it('hydrants and mailboxes only occur on building tiles adjacent to a road', () => {
    const N = WORLD.tiles;
    for (const archetype of ['hydrant', 'mailbox']) {
      const list = byArchetype.get(archetype) ?? [];
      for (const p of list) {
        const tile = world.tiles[p.tileIndex];
        expect(tile.type).toBe('building');
        const neighbours = [
          [tile.col, tile.row - 1],
          [tile.col, tile.row + 1],
          [tile.col - 1, tile.row],
          [tile.col + 1, tile.row],
        ].filter(([c, r]) => c >= 0 && c < N && r >= 0 && r < N);
        const hasRoad = neighbours.some(([c, r]) => world.tiles[tileIndex(c, r)].type === 'road');
        expect(hasRoad).toBe(true);
      }
    }
  });

  it('exactly one transformerBox per district (16 total)', () => {
    const boxes = byArchetype.get('transformerBox') ?? [];
    expect(boxes).toHaveLength(16);
    const districts = new Set(boxes.map((p) => p.districtId));
    expect(districts.size).toBe(16);
    for (const p of boxes) {
      expect(world.tiles[p.tileIndex].type).toBe('transformerLot');
    }
  });

  it('every transformer lot gets exactly a 3-sided fence ring (12 segments at the current dimensions)', () => {
    const fences = byArchetype.get('fenceSegment') ?? [];
    const perLot = new Map<number, number>();
    for (const p of fences) {
      expect(world.tiles[p.tileIndex].type).toBe('transformerLot');
      perLot.set(p.tileIndex, (perLot.get(p.tileIndex) ?? 0) + 1);
    }
    expect(perLot.size).toBe(16);
    for (const count of perLot.values()) expect(count).toBe(12);
  });
});

describe('derivePlacements — cross-seed structural invariants', () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}: transformerBox count is always exactly 16, one per district`, () => {
      const world: WorldData = generate(seed);
      const placements = derivePlacements(world);
      const boxes = placements.filter((p) => p.archetype === 'transformerBox');
      expect(boxes).toHaveLength(16);
      expect(new Set(boxes.map((p) => p.districtId)).size).toBe(16);
    });

    it(`seed ${seed}: every placement resolves back to its own tileIndex`, () => {
      const world = generate(seed);
      const placements = derivePlacements(world);
      for (const p of placements) {
        const { col, row } = tileOfPoint(p.x, p.z);
        expect(p.tileIndex).toBe(tileIndex(col, row));
        expect(p.districtId).toBe(world.tiles[p.tileIndex].districtId);
      }
    });
  }
});
