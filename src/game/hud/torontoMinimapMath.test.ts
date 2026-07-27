// Phase 29 T1 — minimap source switch: pure math for the Toronto-aware dev minimap
// (torontoMinimapMath.ts). jsdom has no canvas backend (minimapMath.test.ts's own header notes
// this), so — matching that file's convention — only the coordinate math is unit-tested here;
// Minimap.tsx's actual draw path is exercised manually/via screenshots.
import { describe, expect, it } from 'vitest';
import { PLAYABLE_POLYGON } from '../world/toronto/polygon';
import { buildWorldEdge } from '../world/toronto/worldEdge';
import { HERO_LOTS } from '../world/toronto/namedBuildings';
import {
  cnTowerMapPx,
  streetEndpointsWorld,
  torontoBarrierRingSegmentsPx,
  torontoPolygonPx,
  torontoWaterEdgeSegmentPx,
  torontoWorldToMapPx,
  TORONTO_MINIMAP_STREETS,
} from './torontoMinimapMath';

const MAP_PX = 192;

describe('torontoWorldToMapPx', () => {
  it('maps every polygon vertex inside [0, mapPx] on both axes (letterboxed fit)', () => {
    for (const v of PLAYABLE_POLYGON) {
      const px = torontoWorldToMapPx(v.x, v.y, MAP_PX);
      expect(px.x).toBeGreaterThanOrEqual(-1e-6);
      expect(px.x).toBeLessThanOrEqual(MAP_PX + 1e-6);
      expect(px.y).toBeGreaterThanOrEqual(-1e-6);
      expect(px.y).toBeLessThanOrEqual(MAP_PX + 1e-6);
    }
  });

  it('south (larger map-y / world-z) maps to a larger pixel Y — lakefront reads at the bottom', () => {
    const north = torontoWorldToMapPx(1500, 0, MAP_PX);
    const south = torontoWorldToMapPx(1500, 4000, MAP_PX);
    expect(south.y).toBeGreaterThan(north.y);
  });

  it('scales linearly with mapPx for a fixed world position', () => {
    const small = torontoWorldToMapPx(1500, 2000, 96);
    const big = torontoWorldToMapPx(1500, 2000, 192);
    expect(big.x).toBeCloseTo(small.x * 2, 6);
    expect(big.y).toBeCloseTo(small.y * 2, 6);
  });

  it('the polygon spans more vertically than horizontally, so the fit is letterboxed on X (some horizontal margin)', () => {
    // Downtown (2400 wu wide) vs the full N-S extent (~4100+ wu) — vertical is the larger span,
    // so horizontal has letterbox margin: at least one polygon vertex should sit off x=0/mapPx.
    const pxs = PLAYABLE_POLYGON.map((v) => torontoWorldToMapPx(v.x, v.y, MAP_PX));
    const minX = Math.min(...pxs.map((p) => p.x));
    const maxX = Math.max(...pxs.map((p) => p.x));
    expect(minX).toBeGreaterThan(0);
    expect(maxX).toBeLessThan(MAP_PX);
  });
});

describe('torontoPolygonPx', () => {
  it('returns one pixel vertex per polygon vertex, in the same order', () => {
    const px = torontoPolygonPx(MAP_PX);
    expect(px.length).toBe(PLAYABLE_POLYGON.length);
    for (let i = 0; i < px.length; i++) {
      expect(px[i]).toEqual(torontoWorldToMapPx(PLAYABLE_POLYGON[i].x, PLAYABLE_POLYGON[i].y, MAP_PX));
    }
  });
});

describe('torontoBarrierRingSegmentsPx / torontoWaterEdgeSegmentPx (Phase 37)', () => {
  it('emits one ring segment per LAND polygon edge, every endpoint inside the canvas', () => {
    const layout = buildWorldEdge();
    const ring = torontoBarrierRingSegmentsPx(MAP_PX);
    expect(ring).toHaveLength(layout.edges.length);
    expect(ring).toHaveLength(11);
    for (const seg of ring) {
      for (const p of [seg.a, seg.b]) {
        expect(p.x).toBeGreaterThanOrEqual(-1e-6);
        expect(p.x).toBeLessThanOrEqual(MAP_PX + 1e-6);
        expect(p.y).toBeGreaterThanOrEqual(-1e-6);
        expect(p.y).toBeLessThanOrEqual(MAP_PX + 1e-6);
      }
    }
  });

  it('the water edge is its own segment, distinct from every ring segment', () => {
    const layout = buildWorldEdge();
    const water = torontoWaterEdgeSegmentPx(MAP_PX);
    expect(water.a.x).toBeGreaterThanOrEqual(-1e-6);
    expect(water.a.x).toBeLessThanOrEqual(MAP_PX + 1e-6);
    // South (larger world z) reads at the bottom of the canvas (larger pixel y) — same convention
    // torontoWorldToMapPx's own test pins — so the water edge sits at the map's southernmost row.
    const ringMaxY = Math.max(...torontoBarrierRingSegmentsPx(MAP_PX).flatMap((s) => [s.a.y, s.b.y]));
    expect(water.a.y).toBeGreaterThanOrEqual(ringMaxY - 1e-6);
    expect(water.b.y).toBeGreaterThanOrEqual(ringMaxY - 1e-6);
    // Matches the pure layout directly (not just re-deriving the same projection twice).
    const expectedA = torontoWorldToMapPx(layout.waterEdge.start.x, layout.waterEdge.start.z, MAP_PX);
    const expectedB = torontoWorldToMapPx(layout.waterEdge.end.x, layout.waterEdge.end.z, MAP_PX);
    expect(water.a).toEqual(expectedA);
    expect(water.b).toEqual(expectedB);
  });
});

describe('cnTowerMapPx (Phase 44 — the wayfinding deliverable)', () => {
  it('lands inside the map square', () => {
    const px = cnTowerMapPx(MAP_PX);
    expect(px.x).toBeGreaterThanOrEqual(-1e-6);
    expect(px.x).toBeLessThanOrEqual(MAP_PX + 1e-6);
    expect(px.y).toBeGreaterThanOrEqual(-1e-6);
    expect(px.y).toBeLessThanOrEqual(MAP_PX + 1e-6);
  });

  it('sits in the lower half of the map (harbourfront/rail-lands, south of the polygon centre)', () => {
    const px = cnTowerMapPx(MAP_PX);
    expect(px.y).toBeGreaterThan(MAP_PX / 2);
  });

  it('matches torontoWorldToMapPx applied to HERO_LOTS[0]\'s own centre (no drift between the two)', () => {
    const lot = HERO_LOTS[0];
    const expected = torontoWorldToMapPx((lot.minX + lot.maxX) / 2, (lot.minY + lot.maxY) / 2, MAP_PX);
    expect(cnTowerMapPx(MAP_PX)).toEqual(expected);
  });

  it('scales linearly with mapPx, like every other minimap-pixel helper', () => {
    const small = cnTowerMapPx(96);
    const big = cnTowerMapPx(192);
    expect(big.x).toBeCloseTo(small.x * 2, 6);
    expect(big.y).toBeCloseTo(small.y * 2, 6);
  });
});

describe('streetEndpointsWorld', () => {
  it('an ns street runs along a fixed x, varying z (its span)', () => {
    const ns = TORONTO_MINIMAP_STREETS.find((s) => s.axis === 'ns');
    expect(ns).toBeDefined();
    const { a, b } = streetEndpointsWorld(ns!);
    expect(a.x).toBe(ns!.centerline);
    expect(b.x).toBe(ns!.centerline);
    expect(a.z).not.toBe(b.z);
  });

  it('an ew street runs along a fixed z, varying x (its span)', () => {
    const ew = TORONTO_MINIMAP_STREETS.find((s) => s.axis === 'ew');
    expect(ew).toBeDefined();
    const { a, b } = streetEndpointsWorld(ew!);
    expect(a.z).toBe(ew!.centerline);
    expect(b.z).toBe(ew!.centerline);
    expect(a.x).not.toBe(b.x);
  });

  it('every street resolves to two distinct, finite endpoints', () => {
    expect(TORONTO_MINIMAP_STREETS.length).toBeGreaterThan(0);
    for (const s of TORONTO_MINIMAP_STREETS) {
      const { a, b } = streetEndpointsWorld(s);
      expect(Number.isFinite(a.x) && Number.isFinite(a.z)).toBe(true);
      expect(Number.isFinite(b.x) && Number.isFinite(b.z)).toBe(true);
      expect(a).not.toEqual(b);
    }
  });
});
