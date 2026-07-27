import { describe, expect, it } from 'vitest';
import {
  GROUND_RECTS,
  SIGNPOSTS,
  TORONTO_SPAWN_POSE,
  WATER_RECT,
  rectCorners,
  rectWorldBox,
} from './torontoSceneHelpers';
import { PLAYABLE_POLYGON, pointInPolygon, polygonArea } from './polygon';
import { buildStreets, type MapRect } from './streets';
import { ZONE_BOUNDARIES } from './projection';
import { LANE_OFFSET_WU } from '../../config/torontoMap';

/** Map-point for a world position (inverse of mapToWorld's identity swap): world x -> map x,
 * world z -> map y. */
function worldToMapPoint(pos: { x: number; z: number }): { x: number; y: number } {
  return { x: pos.x, y: pos.z };
}

describe('torontoSceneHelpers — everything stays inside the §1 polygon', () => {
  it('every ground rect corner is inside PLAYABLE_POLYGON', () => {
    for (const rect of GROUND_RECTS) {
      for (const c of rectCorners(rect)) {
        expect(pointInPolygon(c, PLAYABLE_POLYGON), `${JSON.stringify(c)}`).toBe(true);
      }
    }
  });

  it('the water rect corners are inside PLAYABLE_POLYGON', () => {
    for (const c of rectCorners(WATER_RECT)) {
      expect(pointInPolygon(c, PLAYABLE_POLYGON), `${JSON.stringify(c)}`).toBe(true);
    }
  });

  it('every signpost anchor is strictly inside the polygon (not on the boundary edge)', () => {
    for (const sign of SIGNPOSTS) {
      expect(pointInPolygon({ x: sign.x, y: sign.y }, PLAYABLE_POLYGON), sign.id).toBe(true);
    }
  });

  it('the spawn pose lands inside the polygon, in the downtown zone, on the Yonge spine southbound lane', () => {
    const p = worldToMapPoint(TORONTO_SPAWN_POSE.position);
    expect(pointInPolygon(p, PLAYABLE_POLYGON)).toBe(true);
    // Phase 32 (D3): the southbound lane, offset off the spine centreline — never dead-centre,
    // so the player starts in the exact lane southbound AI traffic drives.
    expect(p.x).toBeCloseTo(1500 - LANE_OFFSET_WU.spine, 5);
    // Downtown zone (Bloor -> shore), specifically mid-block between Dundas and Queen — a drift
    // guard against config/torontoMap.ts's TORONTO_SPAWN.y going stale if the anchors/DENSITY
    // scale are ever re-tuned (that literal's own doc comment records the same provenance).
    expect(p.y).toBeGreaterThan(ZONE_BOUNDARIES[2]);
    expect(p.y).toBeLessThan(ZONE_BOUNDARIES[3]);
    const { streets } = buildStreets();
    const dundas = streets.find((s) => s.id === 'dundas');
    const queen = streets.find((s) => s.id === 'queen');
    expect(dundas).toBeDefined();
    expect(queen).toBeDefined();
    expect(p.y).toBeGreaterThan(dundas!.centerline);
    expect(p.y).toBeLessThan(queen!.centerline);
    // Settle-safe height, upright (identity) facing.
    expect(TORONTO_SPAWN_POSE.position.y).toBeGreaterThan(0);
    expect(TORONTO_SPAWN_POSE.rotation).toEqual({ x: 0, y: 0, z: 0, w: 1 });
  });
});

/**
 * PHASE 37 GROUND-TRUTH GATE — "the ground tiles the polygon, exactly".
 *
 * The Part-9 audit block (and TorontoScene's old fell-out-net comment) claimed void slivers exist
 * INSIDE the shape at the step-ins, i.e. that a car could be inside PLAYABLE_POLYGON and still
 * have no ground under it. That has been false since the Part-8 D2 re-derivation: GROUND_RECTS,
 * WATER_RECT and PLAYABLE_POLYGON are all built from the SAME ZONE_X_EXTENTS/ZONE_BOUNDARIES
 * constants, so capsule ∪ fold ∪ downtown ∪ water IS the polygon.
 *
 * Phase 37 leans on that: the barrier ring (world/toronto/worldEdge.ts) is placed by insetting the
 * polygon, and every wall/dressing piece is asserted "inside the polygon" — which only means
 * "standing on ground" if this gate holds. Anything that breaks the tiling breaks the ring, so it
 * gets proven here rather than assumed: exact area, disjoint interiors, corners in, and a dense
 * two-way membership sweep.
 */
describe('torontoSceneHelpers — Phase 37 ground truth: the rects tile the §1 polygon exactly', () => {
  const TILES: readonly MapRect[] = [...GROUND_RECTS, WATER_RECT];
  const EPS = 1e-9;

  const rectArea = (r: MapRect) => (r.maxX - r.minX) * (r.maxY - r.minY);
  const rectContains = (r: MapRect, p: { x: number; y: number }) =>
    p.x >= r.minX - EPS && p.x <= r.maxX + EPS && p.y >= r.minY - EPS && p.y <= r.maxY + EPS;
  const overlapArea = (a: MapRect, b: MapRect) =>
    Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX)) *
    Math.max(0, Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY));

  it('has pairwise-disjoint interiors (they may share edges, never area)', () => {
    for (let i = 0; i < TILES.length; i++) {
      for (let j = i + 1; j < TILES.length; j++) {
        expect(overlapArea(TILES[i], TILES[j]), `tiles ${i}/${j} overlap`).toBeLessThanOrEqual(EPS);
      }
    }
  });

  it('sums to the polygon area exactly (same constants, so float-exact)', () => {
    const tiled = TILES.reduce((sum, r) => sum + rectArea(r), 0);
    const poly = polygonArea(PLAYABLE_POLYGON);
    expect(poly).toBeGreaterThan(0); // §1 winding: shoelace is +area
    expect(Math.abs(tiled - poly)).toBeLessThan(1e-6);
  });

  it('has every rect corner inside the polygon', () => {
    for (const rect of TILES) {
      for (const c of rectCorners(rect)) {
        expect(pointInPolygon(c, PLAYABLE_POLYGON), JSON.stringify(c)).toBe(true);
      }
    }
  });

  it('is two-way complete over a dense 60x60 sweep: inside the polygon <=> on a tile', () => {
    const minX = Math.min(...TILES.map((r) => r.minX));
    const maxX = Math.max(...TILES.map((r) => r.maxX));
    const minY = Math.min(...TILES.map((r) => r.minY));
    const maxY = Math.max(...TILES.map((r) => r.maxY));
    const N = 60;
    let insideSamples = 0;
    let outsideSamples = 0;
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const p = {
          x: minX + ((i + 0.5) * (maxX - minX)) / N,
          y: minY + ((j + 0.5) * (maxY - minY)) / N,
        };
        const inPoly = pointInPolygon(p, PLAYABLE_POLYGON);
        const onTile = TILES.some((r) => rectContains(r, p));
        expect(onTile, `${JSON.stringify(p)} inPoly=${inPoly} onTile=${onTile}`).toBe(inPoly);
        if (inPoly) insideSamples += 1;
        else outsideSamples += 1;
      }
    }
    // The sweep is meaningful: the bbox contains both the thermometer and the void beside it.
    expect(insideSamples).toBeGreaterThan(0);
    expect(outsideSamples).toBeGreaterThan(0);
  });
});

describe('torontoSceneHelpers — rect geometry', () => {
  it('the three ground rects are contiguous along y (capsule -> corridor -> downtown)', () => {
    expect(GROUND_RECTS[0].maxY).toBe(GROUND_RECTS[1].minY); // 1170
    expect(GROUND_RECTS[1].maxY).toBe(GROUND_RECTS[2].minY); // 1830
  });

  it('the water band starts exactly where the downtown ground ends (the shore)', () => {
    expect(GROUND_RECTS[2].maxY).toBe(WATER_RECT.minY); // 3700
  });

  it('rectWorldBox returns the rect centre + half-extents (identity map->world)', () => {
    const rect: MapRect = { minX: 1100, minY: 0, maxX: 1900, maxY: 1170 };
    const box = rectWorldBox(rect);
    expect(box.cx).toBe(1500);
    expect(box.cz).toBe(585);
    expect(box.hx).toBe(400);
    expect(box.hz).toBe(585);
  });
});
