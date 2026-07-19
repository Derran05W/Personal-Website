// Phase 29 T1 — minimap source switch: pure math for the Toronto-aware dev minimap
// (torontoMinimapMath.ts). jsdom has no canvas backend (minimapMath.test.ts's own header notes
// this), so — matching that file's convention — only the coordinate math is unit-tested here;
// Minimap.tsx's actual draw path is exercised manually/via screenshots.
import { describe, expect, it } from 'vitest';
import { PLAYABLE_POLYGON } from '../world/toronto/polygon';
import {
  streetEndpointsWorld,
  torontoPolygonPx,
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
