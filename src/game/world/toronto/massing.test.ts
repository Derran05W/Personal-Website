// Tests for the Phase 23 filler-massing generator (TORONTO-MAP-SPEC-v2.md §3b/§6/A.4,
// phase-23-plan Task 2). The extruded coloured boxes ARE the Smashy-Road look; this suite
// pins the invariants that keep them (a) deterministic per seed, (b) never on a road or in the
// lake or outside the polygon, (c) laid out as CLAUDE.md's district-ordered contiguous ranges,
// and (d) within the §3c height envelope — plus the two flavour guarantees (count budget +
// the North York Yonge storefront strip).
import { describe, expect, it } from 'vitest';
import { TORONTO_DISTRICTS, type DistrictId } from '../../config/torontoDistricts';
import { PLAYABLE_POLYGON, pointInPolygon } from './polygon';
import { buildStreets } from './streets';
import { buildRibbons } from './roadGraph';
import { hGame } from './heightCurve';
import { buildMassing, type MassingInstance } from './massing';

const SEED = 1337;
const massing = buildMassing(SEED);

// The generator rejects footprints that intrude on any road ribbon inflated by this margin.
const SIDEWALK_MARGIN_WU = 2;
// Storefront-strip real-height envelope (willowdale/northYork Yonge frontage).
const STOREFRONT_M: readonly [number, number] = [8, 12];
const WATER_Z = 3700;
const EPS = 1e-6;

interface Aabb {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
}

function footprintAabb(inst: MassingInstance): Aabb {
  return { minX: inst.x - inst.hx, maxX: inst.x + inst.hx, minZ: inst.z - inst.hz, maxZ: inst.z + inst.hz };
}

/** Interior overlap with a small tolerance — touching edges/corners never count. */
function interiorOverlap(a: Aabb, b: Aabb, tol = 1e-3): boolean {
  return a.minX < b.maxX - tol && a.maxX > b.minX + tol && a.minZ < b.maxZ - tol && a.maxZ > b.minZ + tol;
}

describe('buildMassing — determinism', () => {
  it('same seed → deep-equal output', () => {
    expect(buildMassing(SEED)).toEqual(buildMassing(SEED));
  });

  it('different seeds → different layouts', () => {
    const other = buildMassing(SEED + 1);
    // Not a hard guarantee element-by-element, but the two full instance arrays must differ.
    expect(other.instances).not.toEqual(massing.instances);
  });
});

describe('buildMassing — every instance inside the playable polygon', () => {
  it('all four footprint corners of every instance are polygon-inclusive', () => {
    const offenders: string[] = [];
    for (const inst of massing.instances) {
      const b = footprintAabb(inst);
      const corners = [
        { x: b.minX, y: b.minZ },
        { x: b.maxX, y: b.minZ },
        { x: b.maxX, y: b.maxZ },
        { x: b.minX, y: b.maxZ },
      ];
      if (!corners.every((c) => pointInPolygon(c, PLAYABLE_POLYGON))) {
        offenders.push(`${inst.districtId} @ (${inst.x.toFixed(1)},${inst.z.toFixed(1)})`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no instance intrudes into the water band (z >= 3700)', () => {
    const wet = massing.instances.filter((inst) => inst.z + inst.hz >= WATER_Z - EPS);
    expect(wet).toEqual([]);
  });
});

describe('buildMassing — zero road-ribbon violations', () => {
  it('no footprint overlaps any ribbon inflated by the sidewalk margin', () => {
    const ribbons = buildRibbons(buildStreets().streets);
    const inflated: Aabb[] = ribbons.map((r) => ({
      minX: r.minX - SIDEWALK_MARGIN_WU,
      maxX: r.maxX + SIDEWALK_MARGIN_WU,
      minZ: r.minZ - SIDEWALK_MARGIN_WU,
      maxZ: r.maxZ + SIDEWALK_MARGIN_WU,
    }));
    const offenders: string[] = [];
    for (const inst of massing.instances) {
      const fp = footprintAabb(inst);
      for (const rib of inflated) {
        if (interiorOverlap(fp, rib)) {
          offenders.push(`${inst.districtId} @ (${inst.x.toFixed(1)},${inst.z.toFixed(1)})`);
          break;
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('buildMassing — district ranges are the sacred contiguous buffer', () => {
  it('one range per district, in config order', () => {
    const expected: readonly DistrictId[] = TORONTO_DISTRICTS.map((d) => d.id);
    expect(massing.districtRanges.map((r) => r.districtId)).toEqual(expected);
  });

  it('ranges start at 0, are contiguous, and cover the whole instance array', () => {
    let cursor = 0;
    for (const range of massing.districtRanges) {
      expect(range.start).toBe(cursor);
      expect(range.count).toBeGreaterThanOrEqual(0);
      cursor += range.count;
    }
    expect(cursor).toBe(massing.instances.length);
  });

  it('every instance in a range carries that range\'s districtId', () => {
    for (const range of massing.districtRanges) {
      for (let i = range.start; i < range.start + range.count; i++) {
        expect(massing.instances[i].districtId).toBe(range.districtId);
      }
    }
  });
});

describe('buildMassing — colliders mirror the instances', () => {
  it('one collider per instance, same footprint + height, sitting on y=0', () => {
    expect(massing.colliders.length).toBe(massing.instances.length);
    for (let i = 0; i < massing.instances.length; i++) {
      const inst = massing.instances[i];
      const col = massing.colliders[i];
      expect(col.hx).toBeCloseTo(inst.hx, 6);
      expect(col.hy).toBeCloseTo(inst.hy, 6);
      expect(col.hz).toBeCloseTo(inst.hz, 6);
      expect(col.x).toBeCloseTo(inst.x, 6);
      expect(col.z).toBeCloseTo(inst.z, 6);
      // Box sits on the ground: centre y = half-height.
      expect(col.y).toBeCloseTo(inst.hy, 6);
    }
  });
});

describe('buildMassing — heights within the §3c envelope', () => {
  it('every box height lands inside its district hGame range (storefronts included)', () => {
    const defById = new Map(TORONTO_DISTRICTS.map((d) => [d.id, d]));
    const offenders: string[] = [];
    for (const inst of massing.instances) {
      const def = defById.get(inst.districtId)!;
      let loM = def.heightRangeM[0];
      let hiM = def.heightRangeM[1];
      // The two North York districts also carry the low storefront strip.
      if (inst.districtId === 'willowdaleFinch' || inst.districtId === 'northYorkCentre') {
        loM = Math.min(loM, STOREFRONT_M[0]);
        hiM = Math.max(hiM, STOREFRONT_M[1]);
      }
      const h = inst.hy * 2;
      if (h < hGame(loM) - 1e-3 || h > hGame(hiM) + 1e-3) {
        offenders.push(`${inst.districtId}: h=${h.toFixed(2)} not in [${hGame(loM).toFixed(2)},${hGame(hiM).toFixed(2)}]`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('buildMassing — count budget (§10.2 filler city)', () => {
  it('total instance count is in the 400-800 target band (hard cap < 900)', () => {
    expect(massing.instances.length).toBeGreaterThanOrEqual(400);
    expect(massing.instances.length).toBeLessThan(900);
  });
});

describe('buildMassing — no same-district footprint overlap', () => {
  it('within each district, no two footprints overlap (touching is fine)', () => {
    const byDistrict = new Map<DistrictId, MassingInstance[]>();
    for (const inst of massing.instances) {
      (byDistrict.get(inst.districtId) ?? byDistrict.set(inst.districtId, []).get(inst.districtId)!).push(inst);
    }
    const offenders: string[] = [];
    for (const [id, list] of byDistrict) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          if (interiorOverlap(footprintAabb(list[i]), footprintAabb(list[j]))) {
            offenders.push(`${id}: ${i} x ${j}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('buildMassing — exclusion zones (Phase 24 named buildings + hero lots)', () => {
  // A couple of hand-picked map-space rects standing in for named footprints / hero lots.
  const exclusions = [
    { minX: 1200, minY: 3120, maxX: 1240, maxY: 3160 }, // financial-cluster-ish block
    { minX: 935, minY: 3375, maxX: 965, maxY: 3405 }, // CN Tower hero lot
    { minX: 1455, minY: 2760, maxX: 1481, maxY: 2895 }, // Eaton galleria strip
  ];
  const excluded = buildMassing(SEED, exclusions);

  it('no instance intersects any exclusion rect', () => {
    const offenders: string[] = [];
    for (const inst of excluded.instances) {
      const fp = footprintAabb(inst);
      for (const ex of exclusions) {
        const r: Aabb = { minX: ex.minX, minZ: ex.minY, maxX: ex.maxX, maxZ: ex.maxY };
        if (interiorOverlap(fp, r)) {
          offenders.push(`${inst.districtId} @ (${inst.x.toFixed(1)},${inst.z.toFixed(1)})`);
          break;
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('same seed + same exclusions → deep-equal output', () => {
    expect(buildMassing(SEED, exclusions)).toEqual(excluded);
  });

  it('passing no exclusions is byte-identical to the default (back-compat)', () => {
    expect(buildMassing(SEED, [])).toEqual(buildMassing(SEED));
  });
});

describe('buildMassing — North York Yonge storefront strip', () => {
  it('>= 10 small boxes hug the Yonge ribbon edges inside the capsule', () => {
    const yonge = buildStreets().streets.find((s) => s.id === 'yonge')!;
    const westEdge = yonge.ribbon.minX;
    const eastEdge = yonge.ribbon.maxX;
    const NEAR = 12;
    const strip = massing.instances.filter((inst) => {
      const inCapsule = inst.z < 1170; // capsule is map-y 0..1170 (= world z)
      const nearWest = Math.abs(inst.x - westEdge) <= NEAR;
      const nearEast = Math.abs(inst.x - eastEdge) <= NEAR;
      return inCapsule && (nearWest || nearEast);
    });
    expect(strip.length).toBeGreaterThanOrEqual(10);
  });
});
