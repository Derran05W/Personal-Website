import { describe, expect, it } from 'vitest';
import {
  GROUND_RECTS,
  SIGNPOSTS,
  TORONTO_SPAWN_POSE,
  WATER_RECT,
  rectCorners,
  rectWorldBox,
} from './torontoSceneHelpers';
import { PLAYABLE_POLYGON, pointInPolygon } from './polygon';
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
