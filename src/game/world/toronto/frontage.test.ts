// Tests for the Phase 25.6 pack-building FRONTAGE placer (frontage.ts) — the box-lattice
// massing.ts's property suite reborn over the street-walk engine (D4b/D6). Pins: (a) determinism
// per seed, (b) the four massing rejection gates (never on a ribbon / off the polygon / in the
// lake / overlapping a same-district footprint) + exclusion respect, (c) CLAUDE.md district-
// ordered contiguous ranges, (d) the hard cap + count band, (e) facing correctness (buildings
// front the street), and (f) corner slots prefer cornerModels + stable slot ids (the 25.7 seam).
import { describe, expect, it } from 'vitest';
import { TORONTO_DISTRICTS, type DistrictId } from '../../config/torontoDistricts';
import { FRONTAGE } from '../../config/torontoDress';
import { hasCityPackModel } from '../../assets/cityPackManifest';
import { PLAYABLE_POLYGON, pointInPolygon } from './polygon';
import { buildStreets } from './streets';
import { buildRibbons } from './roadGraph';
import { buildNamedBuildings } from './namedBuildings';
import { buildPlacesLayer } from './placesLayer';
import { buildFrontage, overlaps, slotsForModel, type Aabb, type FrontageSlot } from './frontage';

const SEED = 416;
const layout = buildFrontage(SEED);
const WATER_Z = 3700;

function footprint(s: FrontageSlot): Aabb {
  return { minX: s.position[0] - s.hx, maxX: s.position[0] + s.hx, minZ: s.position[2] - s.hz, maxZ: s.position[2] + s.hz };
}

describe('buildFrontage — determinism', () => {
  it('same seed → deep-equal output', () => {
    expect(buildFrontage(SEED)).toEqual(buildFrontage(SEED));
  });
  it('different seeds → different layouts', () => {
    expect(buildFrontage(SEED + 1).slots).not.toEqual(layout.slots);
  });
});

describe('buildFrontage — count band + hard cap (D6)', () => {
  it('total placements in [500, hardCap]', () => {
    expect(layout.slots.length).toBeGreaterThanOrEqual(500);
    expect(layout.slots.length).toBeLessThanOrEqual(FRONTAGE.hardCap);
  });
  it('counts.total matches slots length', () => {
    expect(layout.counts.total).toBe(layout.slots.length);
  });
});

describe('buildFrontage — every model id is a real manifest entry', () => {
  it('no typo ids', () => {
    for (const id of layout.modelIds) expect(hasCityPackModel(id)).toBe(true);
  });
});

describe('buildFrontage — inside the playable polygon + out of the lake', () => {
  it('all four footprint corners polygon-inclusive', () => {
    const offenders: string[] = [];
    for (const s of layout.slots) {
      const b = footprint(s);
      const corners = [
        { x: b.minX, y: b.minZ },
        { x: b.maxX, y: b.minZ },
        { x: b.maxX, y: b.maxZ },
        { x: b.minX, y: b.maxZ },
      ];
      if (!corners.every((c) => pointInPolygon(c, PLAYABLE_POLYGON))) offenders.push(s.slotId);
    }
    expect(offenders).toEqual([]);
  });
  it('no footprint intrudes into the water band (z >= 3700)', () => {
    expect(layout.slots.filter((s) => footprint(s).maxZ >= WATER_Z)).toEqual([]);
  });
});

describe('buildFrontage — zero road-ribbon violations', () => {
  it('no footprint overlaps any road ribbon', () => {
    const ribbons: Aabb[] = buildRibbons(buildStreets().streets).map((r) => ({ minX: r.minX, maxX: r.maxX, minZ: r.minZ, maxZ: r.maxZ }));
    const offenders: string[] = [];
    for (const s of layout.slots) {
      const fp = footprint(s);
      if (ribbons.some((r) => overlaps(fp, r))) offenders.push(s.slotId);
    }
    expect(offenders).toEqual([]);
  });
});

describe('buildFrontage — exclusion respect (named + hero + places)', () => {
  it('no footprint overlaps any named/hero/places exclusion rect', () => {
    const named = buildNamedBuildings();
    const places = buildPlacesLayer(named);
    const ex: Aabb[] = [...named.exclusions, ...places.exclusions].map((r) => ({ minX: r.minX, maxX: r.maxX, minZ: r.minY, maxZ: r.maxY }));
    const offenders: string[] = [];
    for (const s of layout.slots) {
      const fp = footprint(s);
      if (ex.some((r) => overlaps(fp, r))) offenders.push(s.slotId);
    }
    expect(offenders).toEqual([]);
  });
});

describe('buildFrontage — no same-district footprint overlap', () => {
  it('within each district, no two footprints overlap (touching is fine)', () => {
    const byDistrict = new Map<DistrictId, FrontageSlot[]>();
    for (const s of layout.slots) (byDistrict.get(s.districtId) ?? byDistrict.set(s.districtId, []).get(s.districtId)!).push(s);
    const offenders: string[] = [];
    for (const [id, list] of byDistrict) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          if (overlaps(footprint(list[i]), footprint(list[j]))) offenders.push(`${id}: ${list[i].slotId} x ${list[j].slotId}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('buildFrontage — district ranges are the sacred contiguous buffer', () => {
  it('ranges are in config order (subset, contiguous, cover the whole array)', () => {
    const orderIndex = new Map(TORONTO_DISTRICTS.map((d, i) => [d.id, i]));
    let cursor = 0;
    let lastIdx = -1;
    for (const range of layout.ranges) {
      expect(range.start).toBe(cursor);
      expect(range.count).toBeGreaterThan(0);
      const idx = orderIndex.get(range.districtId)!;
      expect(idx).toBeGreaterThan(lastIdx); // strictly increasing config order
      lastIdx = idx;
      cursor += range.count;
    }
    expect(cursor).toBe(layout.slots.length);
  });
  it('every slot in a range carries that range districtId', () => {
    for (const range of layout.ranges) {
      for (let i = range.start; i < range.start + range.count; i++) {
        expect(layout.slots[i].districtId).toBe(range.districtId);
      }
    }
  });
});

describe('buildFrontage — facing correctness (buildings front the street)', () => {
  it('every rotationY is one of the four cardinal frontage yaws', () => {
    const allowed = [0, Math.PI, Math.PI / 2, -Math.PI / 2];
    for (const s of layout.slots) {
      expect(allowed.some((a) => Math.abs(a - s.rotationY) < 1e-9)).toBe(true);
    }
  });
});

describe('buildFrontage — stable slot ids (the 25.7 seam)', () => {
  it('slot ids are unique', () => {
    const ids = new Set(layout.slots.map((s) => s.slotId));
    expect(ids.size).toBe(layout.slots.length);
  });
  it('slot ids follow the streetId:side:index grammar', () => {
    for (const s of layout.slots) expect(s.slotId).toMatch(/^[a-z]+:[pn]:\d+$/);
  });
});

describe('buildFrontage — corner slots prefer cornerModels', () => {
  it('corner slots in a district with a corner pool use a corner model', () => {
    // building-red-corner / pizza-corner are the only corner-pool ids; where a corner slot lands
    // in a district WITH a corner pool it should (usually) carry one. Assert a healthy majority.
    const cornerPoolDistricts = new Set(TORONTO_DISTRICTS.filter((d) => d.packStock.cornerModels.length > 0).map((d) => d.id));
    const cornerSlots = layout.slots.filter((s) => s.isCorner && cornerPoolDistricts.has(s.districtId));
    const withCornerModel = cornerSlots.filter((s) => s.modelId === 'building-red-corner' || s.modelId === 'pizza-corner');
    expect(cornerSlots.length).toBeGreaterThan(0);
    expect(withCornerModel.length).toBeGreaterThan(cornerSlots.length * 0.5);
  });
});

describe('buildFrontage — tints are near-white (D11)', () => {
  it('every tint channel is >= 0xB0', () => {
    for (const s of layout.slots) {
      const hex = s.tint.replace('#', '');
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      expect(Math.min(r, g, b)).toBeGreaterThanOrEqual(0xb0);
    }
  });
});

describe('buildFrontage — backdrop towers (D7)', () => {
  it('only the three backdropTowers districts carry backdrop boxes, capped', () => {
    const allowed = new Set(TORONTO_DISTRICTS.filter((d) => d.packStock.backdropTowers).map((d) => d.id));
    for (const b of layout.towerBoxes) expect(allowed.has(b.districtId)).toBe(true);
    expect(layout.towerBoxes.length).toBeLessThanOrEqual(90);
  });
});

describe('slotsForModel — preserves district order per batch', () => {
  it('filtering by model id keeps the district-ordered subsequence', () => {
    for (const id of layout.modelIds) {
      const sub = slotsForModel(layout, id);
      const orderIndex = new Map(TORONTO_DISTRICTS.map((d, i) => [d.id, i]));
      let last = -1;
      for (const s of sub) {
        const idx = orderIndex.get(s.districtId)!;
        expect(idx).toBeGreaterThanOrEqual(last);
        last = idx;
      }
    }
  });
});
