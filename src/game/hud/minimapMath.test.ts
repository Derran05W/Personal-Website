import { describe, expect, it } from 'vitest';
import { WORLD } from '../config';
import { districtIdAt, tileCenter, type WorldData } from '../world/types';
import { TILE_COLORS, worldToMapPx } from './minimapMath';

const MAP_PX = 192;

// Hand-built fixture: 8 road tiles along row 32 (near map center), 2 buildings, and a
// 2-node/1-edge sliver of the traffic graph running along the same road tiles. Enough
// structure to exercise the world→pixel transform against real WorldData shapes without
// needing the (not-yet-built, Task 1) generator.
function buildFixture(): WorldData {
  const row = 32;
  const roadTiles = Array.from({ length: 8 }, (_, col) => ({
    col,
    row,
    type: 'road' as const,
    districtId: districtIdAt(col, row),
    blockId: -1,
  }));

  const buildings = [
    { col: 10, row: 10, w: 1, h: 1, kind: 'small' as const, heightM: 6, districtId: districtIdAt(10, 10) },
    { col: 40, row: 40, w: 2, h: 2, kind: 'tower' as const, heightM: 20, districtId: districtIdAt(40, 40) },
  ];

  const nodeA = { id: 0, ...tileCenter(0, row), kind: 'waypoint' as const, tileIndex: row * WORLD.tiles + 0 };
  const nodeB = { id: 1, ...tileCenter(7, row), kind: 'waypoint' as const, tileIndex: row * WORLD.tiles + 7 };

  return {
    seed: 1,
    tiles: roadTiles,
    blocks: [],
    buildings,
    transformers: [],
    districts: [],
    graph: {
      nodes: [nodeA, nodeB],
      edges: [{ from: 0, to: 1 }],
      outEdges: [[0], []],
    },
    landmarkSlots: [],
  };
}

describe('worldToMapPx', () => {
  it('maps the world origin to the center of the map', () => {
    expect(worldToMapPx(0, 0, MAP_PX)).toEqual({ x: MAP_PX / 2, y: MAP_PX / 2 });
  });

  it('maps the NW tile-grid corner near (0,0) and the SE (lakefront) corner near (mapPx,mapPx)', () => {
    const nw = tileCenter(0, 0);
    const se = tileCenter(WORLD.tiles - 1, WORLD.tiles - 1);
    const nwPx = worldToMapPx(nw.x, nw.z, MAP_PX);
    const sePx = worldToMapPx(se.x, se.z, MAP_PX);

    expect(nwPx.x).toBeGreaterThan(0);
    expect(nwPx.y).toBeGreaterThan(0);
    expect(nwPx.x).toBeLessThan(MAP_PX / 2);
    expect(nwPx.y).toBeLessThan(MAP_PX / 2);

    expect(sePx.x).toBeGreaterThan(MAP_PX / 2);
    expect(sePx.y).toBeGreaterThan(MAP_PX / 2);
    expect(sePx.x).toBeLessThan(MAP_PX);
    expect(sePx.y).toBeLessThan(MAP_PX);
  });

  it('south (+Z, row growing) maps to a larger pixel Y — lakefront reads at the bottom', () => {
    const north = tileCenter(32, 0);
    const south = tileCenter(32, WORLD.tiles - 1);
    expect(worldToMapPx(south.x, south.z, MAP_PX).y).toBeGreaterThan(
      worldToMapPx(north.x, north.z, MAP_PX).y,
    );
  });

  it('scales linearly with mapPx for a fixed world position', () => {
    const { x, z } = tileCenter(48, 16);
    const small = worldToMapPx(x, z, 96);
    const big = worldToMapPx(x, z, 192);
    expect(big.x).toBeCloseTo(small.x * 2, 9);
    expect(big.y).toBeCloseTo(small.y * 2, 9);
  });

  it('exercises the fixture: road tiles along a row convert to equal-Y, increasing-X pixels', () => {
    const fixture = buildFixture();
    const pixels = fixture.tiles.map((tile) => {
      const { x, z } = tileCenter(tile.col, tile.row);
      return worldToMapPx(x, z, MAP_PX);
    });

    for (let i = 1; i < pixels.length; i++) {
      expect(pixels[i].x).toBeGreaterThan(pixels[i - 1].x);
      expect(pixels[i].y).toBeCloseTo(pixels[0].y, 9);
    }
  });

  it('exercises the fixture: building footprints land within the map bounds', () => {
    const fixture = buildFixture();
    for (const building of fixture.buildings) {
      const { x, z } = tileCenter(building.col, building.row);
      const px = worldToMapPx(x, z, MAP_PX);
      expect(px.x).toBeGreaterThanOrEqual(0);
      expect(px.x).toBeLessThanOrEqual(MAP_PX);
      expect(px.y).toBeGreaterThanOrEqual(0);
      expect(px.y).toBeLessThanOrEqual(MAP_PX);
    }
  });

  it('exercises the fixture: the graph edge runs from its `from` node to its `to` node in pixel space', () => {
    const fixture = buildFixture();
    const nodeById = new Map(fixture.graph.nodes.map((n) => [n.id, n]));
    const [edge] = fixture.graph.edges;
    const from = nodeById.get(edge.from)!;
    const to = nodeById.get(edge.to)!;

    const fromPx = worldToMapPx(from.x, from.z, MAP_PX);
    const toPx = worldToMapPx(to.x, to.z, MAP_PX);

    expect(toPx.x).toBeGreaterThan(fromPx.x); // node B is further east (col 7 vs col 0)
    expect(toPx.y).toBeCloseTo(fromPx.y, 9); // same row
  });
});

describe('TILE_COLORS', () => {
  it('has a distinct, non-empty color for every tile type', () => {
    const types: (keyof typeof TILE_COLORS)[] = [
      'road',
      'building',
      'park',
      'parkingLot',
      'transformerLot',
    ];
    const seen = new Set<string>();
    for (const type of types) {
      const color = TILE_COLORS[type];
      expect(color).toMatch(/^#[0-9a-f]{6}$/i);
      seen.add(color);
    }
    expect(seen.size).toBe(types.length);
  });
});
