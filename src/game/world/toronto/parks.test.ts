// Phase 25.8 (D7) — parks: named-park resolution, off-ribbon + in-polygon placement, venue-claim
// disjointness (guaranteed by the frontage exclusion seam), seeded-patch cap, and determinism.
import { describe, expect, it } from 'vitest';
import { PLAYABLE_POLYGON, pointInPolygon } from './polygon';
import { buildFrontage } from './frontage';
import { buildParks } from './parks';
import { buildStreets, type MapRect } from './streets';

const NAMED_IDS = ['queens-park', 'allan-gardens', 'berczy-park', 'grange-park', 'mel-lastman'];

function rectsOverlap(a: MapRect, b: { minX: number; maxX: number; minY: number; maxY: number }): boolean {
  const t = 1e-6;
  return a.minX < b.maxX - t && a.maxX > b.minX + t && a.minY < b.maxY - t && a.maxY > b.minY + t;
}

describe('buildParks', () => {
  const parks = buildParks();
  const streets = buildStreets().streets;

  it('is deterministic + seed-independent (no seed param; identical each call)', () => {
    const a = buildParks();
    const b = buildParks();
    expect(a.parks).toEqual(b.parks);
    expect(a.trees.length).toBe(b.trees.length);
  });

  it('resolves all 5 named parks', () => {
    for (const id of NAMED_IDS) {
      expect(parks.parks.some((p) => p.kind === 'named' && p.id === id)).toBe(true);
    }
  });

  it('every park rect is fully inside the playable polygon', () => {
    for (const p of parks.parks) {
      for (const [x, y] of [
        [p.minX, p.minY],
        [p.maxX, p.minY],
        [p.maxX, p.maxY],
        [p.minX, p.maxY],
      ] as const) {
        expect(pointInPolygon({ x, y }, PLAYABLE_POLYGON)).toBe(true);
      }
    }
  });

  it('no park rect overlaps any street ribbon (never lays grass over a road)', () => {
    for (const p of parks.parks) {
      for (const s of streets) {
        expect(rectsOverlap(s.ribbon, p)).toBe(false);
      }
    }
  });

  it('parks never overlap each other', () => {
    for (let i = 0; i < parks.parks.length; i++) {
      for (let j = i + 1; j < parks.parks.length; j++) {
        expect(rectsOverlap({ ...parks.parks[i] }, parks.parks[j])).toBe(false);
      }
    }
  });

  it('respects the seeded-patch cap (≤10)', () => {
    expect(parks.parks.filter((p) => p.kind === 'seeded').length).toBeLessThanOrEqual(10);
  });

  it('every park tree sits inside some park rect + the polygon', () => {
    for (const t of parks.trees) {
      const [x, , z] = t.position;
      expect(pointInPolygon({ x, y: z }, PLAYABLE_POLYGON)).toBe(true);
      const inSome = parks.parks.some((p) => x >= p.minX - 3 && x <= p.maxX + 3 && z >= p.minY - 3 && z <= p.maxY + 3);
      expect(inSome).toBe(true);
    }
  });
});

describe('parks ∩ venue claims = ∅ (the frontage exclusion seam)', () => {
  it('no park rect overlaps any resolved venue footprint', () => {
    const parks = buildParks();
    const claims = buildFrontage(12345).venueClaims;
    expect(claims.length).toBe(18); // all venues still resolve WITH parks in the exclusion set
    for (const c of claims) {
      const [x, , z] = c.position;
      const foot = { minX: x - c.hx, maxX: x + c.hx, minY: z - c.hz, maxY: z + c.hz };
      for (const p of parks.parks) {
        expect(rectsOverlap({ ...p }, foot)).toBe(false);
      }
    }
  });
});
