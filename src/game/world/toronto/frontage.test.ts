// Tests for the Phase 25.6 pack-building FRONTAGE placer (frontage.ts) — the box-lattice
// massing.ts's property suite reborn over the street-walk engine (D4b/D6). Pins: (a) determinism
// per seed, (b) the four massing rejection gates (never on a ribbon / off the polygon / in the
// lake / overlapping a same-district footprint) + exclusion respect, (c) CLAUDE.md district-
// ordered contiguous ranges, (d) the hard cap + count band, (e) facing correctness (buildings
// front the street), and (f) corner slots prefer cornerModels + stable slot ids (the 25.7 seam).
import { describe, expect, it } from 'vitest';
import { TORONTO_DISTRICTS, type DistrictId } from '../../config/torontoDistricts';
import { FRONTAGE, TORONTO_TIER_IDENTITY, type TorontoTierParams } from '../../config/torontoDress';
import { QUALITY_TIERS } from '../../config/quality';
import { hasCityPackModel } from '../../assets/cityPackManifest';
import { PLAYABLE_POLYGON, pointInPolygon } from './polygon';
import { ZONE_BOUNDARIES } from './projection';
import { buildStreets } from './streets';
import { buildRibbons } from './roadGraph';
import { buildNamedBuildings } from './namedBuildings';
import { buildPlacesLayer } from './placesLayer';
import { BACKDROP_RIBBON_MARGIN_WU, buildFrontage, overlaps, slotsForModel, type Aabb, type FrontageSlot } from './frontage';
import { VENUE_AUTHORS } from './venues';
import { FACADE_MODEL_IDS } from '../../config/venueDressing';

const SEED = 416;
const layout = buildFrontage(SEED);
const WATER_Z = ZONE_BOUNDARIES[3]; // Part-8 (D1): live (compacted) shore y — was a stale 3700 literal

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
  it('no footprint intrudes into the water band (z >= the live shore y)', () => {
    expect(layout.slots.filter((s) => footprint(s).maxZ >= WATER_Z)).toEqual([]);
  });
});

describe('buildFrontage — road-ribbon violations', () => {
  const ribbons: Aabb[] = buildRibbons(buildStreets().streets).map((r) => ({ minX: r.minX, maxX: r.maxX, minZ: r.minZ, maxZ: r.maxZ }));
  // Penetration depth (wu) of a footprint into a ribbon: the smaller overlap dimension (the axis the
  // facade pokes through the curb), 0 when they don't overlap.
  const penetration = (fp: Aabb, r: Aabb): number => {
    const ox = Math.min(fp.maxX, r.maxX) - Math.max(fp.minX, r.minX);
    const oz = Math.min(fp.maxZ, r.maxZ) - Math.max(fp.minZ, r.minZ);
    return ox > 0 && oz > 0 ? Math.min(ox, oz) : 0;
  };

  it('no GENERIC slot footprint overlaps any road ribbon (the strict 900-slot invariant)', () => {
    const offenders: string[] = [];
    for (const s of layout.slots) {
      if (s.venueId !== undefined) continue; // claimed corner slots carry a bounded overhang — below
      const fp = footprint(s);
      if (ribbons.some((r) => overlaps(fp, r))) offenders.push(s.slotId);
    }
    expect(offenders).toEqual([]);
  });

  it('every CLAIMED slot pokes a ribbon by at most the claim tolerance (the McDonald\'s corner overhang)', () => {
    // frontage.ts's CLAIM_RIBBON_TOLERANCE_WU (1.5) — a claimed pizza-corner may sit at a real
    // intersection corner with a ~0.7 wu authentic overhang; nothing may exceed the tolerance.
    const CLAIM_RIBBON_TOLERANCE_WU = 1.5;
    const offenders: string[] = [];
    for (const s of layout.slots.filter((sl) => sl.venueId !== undefined)) {
      const fp = footprint(s);
      const worst = Math.max(0, ...ribbons.map((r) => penetration(fp, r)));
      if (worst > CLAIM_RIBBON_TOLERANCE_WU + 1e-6) offenders.push(`${s.venueId} (${worst.toFixed(2)} wu)`);
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

  // Live-verification FIX 1 (Part-8, "density/life flip"): BACKDROP_TOWER.setbackFromFacadeWu
  // was an ABSOLUTE 18 wu while block interiors compacted ×DENSITY.scale — boxes could reach a
  // street ribbon or an adjacent block. Now DENSITY-derived AND the placer explicitly rejects
  // (never relocates) any candidate whose footprint intersects a ribbon (+ BACKDROP_RIBBON_MARGIN_WU),
  // the water band, or a hero/named-building/park exclusion. Checked over the WHOLE build at two
  // seeds, not just a sample.
  describe('zero backdrop-footprint overlap with any street ribbon, at two seeds', () => {
    it.each([SEED, SEED + 9001])('seed %i: no backdrop box overlaps a ribbon inflated by BACKDROP_RIBBON_MARGIN_WU', (s) => {
      const l = s === SEED ? layout : buildFrontage(s);
      const ribbons = buildRibbons(buildStreets().streets).map((r): Aabb => ({
        minX: r.minX - BACKDROP_RIBBON_MARGIN_WU,
        maxX: r.maxX + BACKDROP_RIBBON_MARGIN_WU,
        minZ: r.minZ - BACKDROP_RIBBON_MARGIN_WU,
        maxZ: r.maxZ + BACKDROP_RIBBON_MARGIN_WU,
      }));
      const offenders: string[] = [];
      l.towerBoxes.forEach((b, i) => {
        const fp: Aabb = { minX: b.x - b.hx, maxX: b.x + b.hx, minZ: b.z - b.hz, maxZ: b.z + b.hz };
        if (ribbons.some((r) => overlaps(fp, r))) offenders.push(`towerBoxes[${i}] (${b.districtId})`);
      });
      expect(offenders).toEqual([]);
      expect(l.towerBoxes.length).toBeGreaterThan(0);
    });
  });

  it('no backdrop box overlaps a named/hero/places/park exclusion, or dips into the water band', () => {
    const named = buildNamedBuildings();
    const places = buildPlacesLayer(named);
    const ex: Aabb[] = [...named.exclusions, ...places.exclusions].map((r) => ({
      minX: r.minX,
      maxX: r.maxX,
      minZ: r.minY,
      maxZ: r.maxY,
    }));
    const offenders: string[] = [];
    layout.towerBoxes.forEach((b, i) => {
      const fp: Aabb = { minX: b.x - b.hx, maxX: b.x + b.hx, minZ: b.z - b.hz, maxZ: b.z + b.hz };
      if (ex.some((r) => overlaps(fp, r))) offenders.push(`towerBoxes[${i}] exclusion`);
      if (fp.maxZ >= WATER_Z) offenders.push(`towerBoxes[${i}] water`);
    });
    expect(offenders).toEqual([]);
  });

  // Additional finding beyond the live-verification ask: at the tighter compacted spacing, two
  // adjacent backdrop rows (e.g. financial/harbourfront meeting at Front St) could fuse into one
  // oversized mass — 8 self-overlapping pairs at seed 416 pre-fix. The placer now also rejects a
  // candidate against every already-kept backdrop footprint.
  it.each([SEED, SEED + 9001])('seed %i: no two backdrop boxes overlap each other', (s) => {
    const l = s === SEED ? layout : buildFrontage(s);
    const offenders: string[] = [];
    for (let i = 0; i < l.towerBoxes.length; i++) {
      for (let j = i + 1; j < l.towerBoxes.length; j++) {
        const a = l.towerBoxes[i];
        const b = l.towerBoxes[j];
        const fa: Aabb = { minX: a.x - a.hx, maxX: a.x + a.hx, minZ: a.z - a.hz, maxZ: a.z + a.hz };
        const fb: Aabb = { minX: b.x - b.hx, maxX: b.x + b.hx, minZ: b.z - b.hz, maxZ: b.z + b.hz };
        if (overlaps(fa, fb)) offenders.push(`towerBoxes[${i}] x towerBoxes[${j}]`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

// --- Phase 25.7 (T2) venue-claim engine -----------------------------------------------------

describe('buildFrontage — venue claims (T2/D1)', () => {
  it('resolves exactly one claim per VENUE_AUTHORS row (18), unique venueIds', () => {
    expect(layout.venueClaims).toHaveLength(VENUE_AUTHORS.length);
    const ids = layout.venueClaims.map((c) => c.venueId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(ids)).toEqual(new Set(VENUE_AUTHORS.map((a) => a.id)));
  });

  it('every claim occupies a REAL slot: its slotId is a live slot carrying its venueId, 1:1', () => {
    const slotById = new Map(layout.slots.map((s) => [s.slotId, s]));
    for (const claim of layout.venueClaims) {
      const slot = slotById.get(claim.slotId);
      expect(slot, claim.venueId).toBeDefined();
      expect(slot!.venueId, claim.venueId).toBe(claim.venueId);
      // The claim's world geometry matches the slot it occupies (venueDress derives off the claim).
      expect(slot!.modelId).toBe(claim.modelId);
      expect(slot!.position).toEqual(claim.position);
      expect(slot!.rotationY).toBe(claim.rotationY);
      expect([slot!.hx, slot!.hy, slot!.hz]).toEqual([claim.hx, claim.hy, claim.hz]);
      expect(slot!.districtId).toBe(claim.districtId);
      expect(slot!.tint).toBe(claim.pastelTint);
    }
  });

  it('exactly the claimed slots carry a venueId (every other slot has none)', () => {
    const tagged = layout.slots.filter((s) => s.venueId !== undefined);
    expect(tagged).toHaveLength(layout.venueClaims.length);
    expect(new Set(tagged.map((s) => s.venueId))).toEqual(new Set(layout.venueClaims.map((c) => c.venueId)));
  });

  it('eviction: no GENERIC slot reuses a claimed slotId, and no generic footprint overlaps a claim', () => {
    const claimIds = new Set(layout.venueClaims.map((c) => c.slotId));
    const claimFps = layout.venueClaims.map((c) => footprint(layout.slots.find((s) => s.slotId === c.slotId)!));
    for (const s of layout.slots) {
      if (s.venueId !== undefined) continue;
      expect(claimIds.has(s.slotId)).toBe(false); // the claimed candidate id is never re-emitted generic
      const fp = footprint(s);
      expect(claimFps.some((cf) => overlaps(fp, cf)), s.slotId).toBe(false);
    }
  });

  it('claims are SEED-INDEPENDENT (the lattice is pure geometry) — byte-identical across seeds', () => {
    const a = JSON.stringify(buildFrontage(SEED).venueClaims);
    const b = JSON.stringify(buildFrontage(SEED + 7).venueClaims);
    const c = JSON.stringify(buildFrontage(99).venueClaims);
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it('claims are exempt from thinToCap — all 18 survive AND total slots ≤ hardCap', () => {
    expect(layout.slots.filter((s) => s.venueId !== undefined)).toHaveLength(VENUE_AUTHORS.length);
    expect(layout.slots.length).toBeLessThanOrEqual(FRONTAGE.hardCap);
  });

  it('every claim facade model is rb-blank / gb-blank / pizza-corner', () => {
    const allowed = new Set<string>([FACADE_MODEL_IDS.brick, FACADE_MODEL_IDS.clean, FACADE_MODEL_IDS.corner]);
    for (const c of layout.venueClaims) expect(allowed.has(c.modelId), c.venueId).toBe(true);
  });

  it("McDonald's @ Queen×Spadina lands on a CORNER candidate → pizza-corner (D3 designed hit)", () => {
    const mcd = layout.venueClaims.find((c) => c.venueId === 'mcdonalds-spadina')!;
    expect(mcd).toBeDefined();
    expect(mcd.streetId).toBe('spadina');
    expect(mcd.isCorner).toBe(true);
    expect(mcd.modelId).toBe(FACADE_MODEL_IDS.corner);
    // The tagged slot agrees.
    expect(layout.slots.find((s) => s.slotId === mcd.slotId)!.modelId).toBe(FACADE_MODEL_IDS.corner);
  });

  it('claims sort FIRST within their district (earliest insertion order)', () => {
    // For each district that holds a claim, the claim indices in `slots` precede that district's
    // generic indices (claims carry the earliest `order`).
    const byDistrict = new Map<DistrictId, { idx: number; claimed: boolean }[]>();
    layout.slots.forEach((s, idx) => {
      const arr = byDistrict.get(s.districtId) ?? [];
      arr.push({ idx, claimed: s.venueId !== undefined });
      byDistrict.set(s.districtId, arr);
    });
    for (const [, arr] of byDistrict) {
      const lastClaim = arr.reduce((m, e) => (e.claimed ? Math.max(m, e.idx) : m), -1);
      const firstGeneric = arr.reduce((m, e) => (!e.claimed && e.idx < m ? e.idx : m), Infinity);
      if (lastClaim >= 0 && firstGeneric !== Infinity) expect(lastClaim).toBeLessThan(firstGeneric);
    }
  });

  it('claim facing is derived from the fronted street axis+side (all four cardinals valid)', () => {
    const allowed = new Set(['north', 'south', 'east', 'west']);
    for (const c of layout.venueClaims) expect(allowed.has(c.facing), c.venueId).toBe(true);
  });
});

// --- Phase 25.8 (T2/D8) quality-tier wiring ---------------------------------------------------

function tierParamsOf(tier: keyof typeof QUALITY_TIERS): TorontoTierParams {
  const t = QUALITY_TIERS[tier];
  return {
    dressDensityScalar: t.dressDensityScalar,
    frontageOccupancyScalar: t.frontageOccupancyScalar,
    parkedCarKeepFraction: t.parkedCarKeepFraction,
  };
}

describe('buildFrontage — Phase 25.8 (D8) quality-tier wiring', () => {
  const HIGH = tierParamsOf('high');
  const LOW = tierParamsOf('low');

  it('the high tier resolves to exactly TORONTO_TIER_IDENTITY (the default)', () => {
    expect(HIGH).toEqual(TORONTO_TIER_IDENTITY);
  });

  it('high tier is byte-identical to the pre-tier (no-arg) output — golden', () => {
    expect(buildFrontage(SEED, HIGH)).toEqual(layout);
    expect(buildFrontage(SEED, HIGH)).toEqual(buildFrontage(SEED));
  });

  it('same (seed, tier) -> deep-equal output (determinism)', () => {
    expect(buildFrontage(SEED, LOW)).toEqual(buildFrontage(SEED, LOW));
  });

  it('low tier still resolves and survives every venue claim (forced-occupied + thin-exempt)', () => {
    const low = buildFrontage(SEED, LOW);
    expect(low.venueClaims).toHaveLength(VENUE_AUTHORS.length);
    const tagged = low.slots.filter((s) => s.venueId !== undefined);
    expect(tagged).toHaveLength(VENUE_AUTHORS.length);
    expect(new Set(tagged.map((s) => s.venueId))).toEqual(new Set(VENUE_AUTHORS.map((a) => a.id)));
  });

  it('frontageOccupancyScalar changes the generic-slot roll (a different building subset is kept), even though FRONTAGE.hardCap keeps the RENDERED total flat on this map', () => {
    const high = buildFrontage(SEED, HIGH);
    const low = buildFrontage(SEED, LOW);
    // Both tiers' raw (pre-cap) candidate pool comfortably exceeds FRONTAGE.hardCap (900) even at
    // the low-tier 0.75x occupancy scalar, so thinToCap always trims to exactly the cap — the
    // scalar's visible effect on THIS map is which 900 buildings get kept, not how many.
    expect(low.slots.length).toBe(FRONTAGE.hardCap);
    expect(high.slots.length).toBe(FRONTAGE.hardCap);
    expect(low.slots.map((s) => s.slotId)).not.toEqual(high.slots.map((s) => s.slotId));
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
