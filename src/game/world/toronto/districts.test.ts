// Tests for the phase-23 district-rect derivation (TORONTO-MAP-SPEC-v2.md §6, phase-23-plan
// Task 1 brief): every rect must sit inside the playable polygon, no two districts' rects may
// overlap (touching is fine), the union must near-fully cover the downtown zone and the capsule,
// every §6 row must be present with sane data, and the whole build must be deterministic.
import { describe, expect, it } from 'vitest';
import { TORONTO_DISTRICTS, type DistrictId } from '../../config/torontoDistricts';
import { hasCityPackModel } from '../../assets/cityPackManifest';
import { PLAYABLE_POLYGON, pointInPolygon, type MapVertex } from './polygon';
import { ZONE_BOUNDARIES } from './projection';
import { buildDistricts, districtAt, type MapRect } from './districts';

const districts = buildDistricts();
const allRectsFlat: readonly { readonly id: DistrictId; readonly rect: MapRect }[] = districts.flatMap(({ def, rects }) =>
  rects.map((rect) => ({ id: def.id, rect })),
);

const HEX_RE = /^#[0-9a-f]{6}$/i;

function rectCorners(r: MapRect): readonly MapVertex[] {
  return [
    { x: r.minX, y: r.minY },
    { x: r.maxX, y: r.minY },
    { x: r.minX, y: r.maxY },
    { x: r.maxX, y: r.maxY },
  ];
}

const EPS = 1e-6;

/** True if a and b share more than a zero-area sliver (touching edges/corners are fine). */
function interiorOverlap(a: MapRect, b: MapRect): boolean {
  return a.minX < b.maxX - EPS && a.maxX > b.minX + EPS && a.minY < b.maxY - EPS && a.maxY > b.minY + EPS;
}

function pointInRect(p: MapVertex, r: MapRect): boolean {
  return p.x >= r.minX - EPS && p.x <= r.maxX + EPS && p.y >= r.minY - EPS && p.y <= r.maxY + EPS;
}

/** Regular-grid coverage estimate: fraction of polygon-interior sample points within
 * [minY,maxY) that land inside at least one of `rects`. `step` in wu. */
function gridCoverage(minY: number, maxY: number, rects: readonly MapRect[], step: number): number {
  let total = 0;
  let covered = 0;
  // Full map x-range comfortably spans every band (0..2400 covers downtown; capsule 1100..1900
  // is a subset) — sampling outside the polygon is free since pointInPolygon filters it out.
  for (let x = -50; x <= 2450; x += step) {
    for (let y = minY; y < maxY; y += step) {
      const p = { x, y };
      if (!pointInPolygon(p, PLAYABLE_POLYGON)) continue;
      total++;
      if (rects.some((r) => pointInRect(p, r))) covered++;
    }
  }
  return total === 0 ? 1 : covered / total;
}

describe('buildDistricts — §6 rows present + config sanity', () => {
  const EXPECTED_IDS: readonly DistrictId[] = [
    'financial',
    'entertainment',
    'kingWest',
    'queenWest',
    'chinatownKensington',
    'yongeDundasQueen',
    'churchWellesley',
    'uoft',
    'stLawrence',
    'harbourfront',
    'bloorYorkville',
    'northYorkCentre',
    'willowdaleFinch',
    'genericDowntown',
    'foldCorridor',
  ];

  it('has exactly the 13 §6 rows + genericDowntown + foldCorridor, in that order', () => {
    expect(TORONTO_DISTRICTS.map((d) => d.id)).toEqual(EXPECTED_IDS);
    expect(districts.map((d) => d.def.id)).toEqual(EXPECTED_IDS);
  });

  it.each(TORONTO_DISTRICTS)('$id: heightRangeM is (0, 300] and min < max', (def) => {
    const [min, max] = def.heightRangeM;
    expect(min).toBeGreaterThan(0);
    expect(max).toBeLessThanOrEqual(300);
    expect(min).toBeLessThan(max);
  });

  it.each(TORONTO_DISTRICTS)('$id: groundTint is a valid hex colour', (def) => {
    expect(def.groundTint).toMatch(HEX_RE);
  });

  it.each(TORONTO_DISTRICTS)('$id: fillerColors has 3-5 valid hex colours', (def) => {
    expect(def.fillerColors.length).toBeGreaterThanOrEqual(3);
    expect(def.fillerColors.length).toBeLessThanOrEqual(5);
    for (const c of def.fillerColors) expect(c).toMatch(HEX_RE);
  });

  it.each(TORONTO_DISTRICTS)('$id: density is one of dense/medium/sparse', (def) => {
    expect(['dense', 'medium', 'sparse']).toContain(def.density);
  });
});

// Phase 25.6 (D10) — packStock config sanity, same it.each pattern as the block above.
describe('buildDistricts — packStock (D10 city-pack model/tint mapping)', () => {
  it.each(TORONTO_DISTRICTS)('$id: every models/cornerModels id is a real city-pack manifest id', (def) => {
    for (const entry of [...def.packStock.models, ...def.packStock.cornerModels]) {
      expect(hasCityPackModel(entry.id), `${def.id}: unknown city-pack id "${entry.id}"`).toBe(true);
      expect(entry.weight, `${def.id}: ${entry.id} weight`).toBeGreaterThan(0);
    }
  });

  it.each(TORONTO_DISTRICTS)('$id: models is non-empty; cornerModels is empty only for a backdropTowers district', (def) => {
    expect(def.packStock.models.length, def.id).toBeGreaterThan(0);
    if (def.packStock.cornerModels.length === 0) {
      expect(def.packStock.backdropTowers, `${def.id}: empty cornerModels without backdropTowers`).toBe(true);
    }
  });

  it.each(TORONTO_DISTRICTS)('$id: tints has 3+ near-white hex colours (every channel >= 0xb8, D11)', (def) => {
    expect(def.packStock.tints.length).toBeGreaterThanOrEqual(3);
    for (const hex of def.packStock.tints) {
      expect(hex, def.id).toMatch(HEX_RE);
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      for (const channel of [r, g, b]) {
        expect(channel, `${def.id} ${hex}`).toBeGreaterThanOrEqual(0xb8);
      }
    }
  });

  it.each(TORONTO_DISTRICTS)('$id: treeDensity is one of none/sparse/rows', (def) => {
    expect(['none', 'sparse', 'rows']).toContain(def.packStock.treeDensity);
  });

  it('pizza-corner never exceeds weight 0.05 within any cornerModels pool, and is absent from financial', () => {
    for (const def of TORONTO_DISTRICTS) {
      const pizza = def.packStock.cornerModels.find((e) => e.id === 'pizza-corner');
      if (def.id === 'financial') {
        expect(pizza, 'financial must not carry pizza-corner').toBeUndefined();
        continue;
      }
      if (pizza) expect(pizza.weight).toBeLessThanOrEqual(0.05);
    }
  });

  it('rb-blank/gb-blank appear in every FAMILY district\'s filler mix (criterion: "7 types + 2 blanks")', () => {
    // The three "big-building only" tower districts (D10's explicit carve-out, same set as
    // backdropTowers) are the one documented exception — they have no street-level family/blank
    // facades at all, just the standalone tower model.
    for (const def of TORONTO_DISTRICTS) {
      if (def.packStock.backdropTowers) continue;
      const ids = new Set(def.packStock.models.map((e) => e.id));
      expect(ids.has('rb-blank') || ids.has('gb-blank'), def.id).toBe(true);
    }
  });

  it('exactly the three tower districts (financial/harbourfront/northYorkCentre) carry backdropTowers', () => {
    const withTowers = TORONTO_DISTRICTS.filter((d) => d.packStock.backdropTowers === true).map((d) => d.id).sort();
    expect(withTowers).toEqual(['financial', 'harbourfront', 'northYorkCentre'].sort());
  });
});

describe('buildDistricts — every rect lies inside PLAYABLE_POLYGON', () => {
  it.each(allRectsFlat)('$id rect corners are all polygon-inclusive', ({ rect }) => {
    for (const corner of rectCorners(rect)) {
      expect(pointInPolygon(corner, PLAYABLE_POLYGON)).toBe(true);
    }
  });

  it('every rect is non-degenerate (positive width and height)', () => {
    for (const { id, rect } of allRectsFlat) {
      expect(rect.maxX - rect.minX, `${id} width`).toBeGreaterThan(0);
      expect(rect.maxY - rect.minY, `${id} height`).toBeGreaterThan(0);
    }
  });
});

describe('buildDistricts — no interior overlap between different districts', () => {
  it('no two rects from different districts overlap (touching edges are fine)', () => {
    const offenders: string[] = [];
    for (let i = 0; i < allRectsFlat.length; i++) {
      for (let j = i + 1; j < allRectsFlat.length; j++) {
        const a = allRectsFlat[i];
        const b = allRectsFlat[j];
        if (a.id === b.id) continue; // genericDowntown's own rects may abut; never overlap by construction either
        if (interiorOverlap(a.rect, b.rect)) {
          offenders.push(`${a.id} x ${b.id}: [${a.rect.minX},${a.rect.minY},${a.rect.maxX},${a.rect.maxY}] vs [${b.rect.minX},${b.rect.minY},${b.rect.maxX},${b.rect.maxY}]`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('genericDowntown rects do not overlap each other', () => {
    const generic = districts.find((d) => d.def.id === 'genericDowntown')!.rects;
    for (let i = 0; i < generic.length; i++) {
      for (let j = i + 1; j < generic.length; j++) {
        expect(interiorOverlap(generic[i], generic[j])).toBe(false);
      }
    }
  });
});

describe('buildDistricts — coverage', () => {
  it('covers >= 95% of the downtown zone (y 1830-3700 intersect polygon)', () => {
    const allRects = allRectsFlat.map((r) => r.rect);
    const coverage = gridCoverage(ZONE_BOUNDARIES[2], ZONE_BOUNDARIES[3], allRects, 20);
    expect(coverage).toBeGreaterThanOrEqual(0.95);
  });

  it('covers >= 95% of the capsule (y 0-1170)', () => {
    const allRects = allRectsFlat.map((r) => r.rect);
    const coverage = gridCoverage(ZONE_BOUNDARIES[0], ZONE_BOUNDARIES[1], allRects, 20);
    expect(coverage).toBeGreaterThanOrEqual(0.95);
  });

  it('genericDowntown alone accounts for the downtown-zone gap area (sanity: named rows are not 100% of downtown)', () => {
    const namedDowntownRects = allRectsFlat.filter((r) => r.id !== 'genericDowntown' && r.id !== 'foldCorridor' && r.id !== 'northYorkCentre' && r.id !== 'willowdaleFinch').map((r) => r.rect);
    const coverageWithoutGeneric = gridCoverage(ZONE_BOUNDARIES[2], ZONE_BOUNDARIES[3], namedDowntownRects, 20);
    expect(coverageWithoutGeneric).toBeLessThan(0.95); // proves genericDowntown is doing real work
  });
});

describe('districtAt — probe points resolve to the right district', () => {
  function centerOf(rect: MapRect): MapVertex {
    return { x: (rect.minX + rect.maxX) / 2, y: (rect.minY + rect.maxY) / 2 };
  }

  it.each(districts)('$def.id: its own rect centre resolves back to it', ({ def, rects }) => {
    const probe = centerOf(rects[0]);
    expect(districtAt(probe, districts)?.id).toBe(def.id);
  });

  it('a point outside every rect (deep in the water band) resolves to undefined', () => {
    expect(districtAt({ x: 1200, y: 3900 }, districts)).toBeUndefined();
  });
});

describe('buildDistricts — determinism', () => {
  it('two independent builds are deep-equal', () => {
    const a = buildDistricts();
    const b = buildDistricts();
    expect(a).toEqual(b);
  });
});
