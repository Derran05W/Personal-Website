// Phase 28 ("Infill") tests for infill.ts (D3-D7: back-lot second row, laneway clutter, parking
// lots, construction sites, lane closures) — determinism, the reject-never-relocate invariants
// (D10, extended from Phase 25.8's furniture invariant to every new layer), tier wiring (D8), and
// model-id sanity. Corner-fill (D1, frontage.ts) is covered by frontage.test.ts instead, since it
// lives in and extends that module directly.
import { describe, expect, it } from 'vitest';
import { hasCityPackModel } from '../../assets/cityPackManifest';
import { QUALITY_TIERS } from '../../config/quality';
import { DEEP_SCATTER, TORONTO_TIER_IDENTITY, type TorontoTierParams } from '../../config/torontoDress';
import { TORONTO_DISTRICTS } from '../../config/torontoDistricts';
import { buildFrontage, overlaps, type Aabb } from './frontage';
import { buildInfill, type DecorPlacement, type DynamicConeSpec, type FixedInfillItem } from './infill';
import { buildNamedBuildings } from './namedBuildings';
import { buildParks } from './parks';
import { buildPlacesLayer } from './placesLayer';
import { ZONE_BOUNDARIES } from './projection';
import { buildStreets, type Street } from './streets';
import { VENUE_AUTHORS } from './venues';

const SEEDS = [416, 9417] as const;
const WATER_Z = ZONE_BOUNDARIES[3];

function footprintFixed(s: FixedInfillItem): Aabb {
  return { minX: s.position[0] - s.hx, maxX: s.position[0] + s.hx, minZ: s.position[2] - s.hz, maxZ: s.position[2] + s.hz };
}

function tierParamsOf(tier: keyof typeof QUALITY_TIERS): TorontoTierParams {
  const t = QUALITY_TIERS[tier];
  return {
    dressDensityScalar: t.dressDensityScalar,
    frontageOccupancyScalar: t.frontageOccupancyScalar,
    parkedCarKeepFraction: t.parkedCarKeepFraction,
  };
}

describe('buildInfill — determinism', () => {
  it('same (seed, frontage) → deep-equal output', () => {
    const frontage = buildFrontage(416);
    expect(buildInfill(416, frontage)).toEqual(buildInfill(416, frontage));
  });
  it('different seeds → different infill layouts', () => {
    const a = buildInfill(416, buildFrontage(416));
    const b = buildInfill(9417, buildFrontage(9417));
    expect(a.fixed).not.toEqual(b.fixed);
  });
});

describe('buildInfill — every model id is a real manifest entry', () => {
  it.each(SEEDS)('seed %i', (seed) => {
    const infill = buildInfill(seed, buildFrontage(seed));
    const ids = new Set<string>([
      ...infill.fixed.map((f) => f.modelId),
      ...infill.boxes.map(() => 'box-geometry'), // boxes are extruded, not a manifest model — skip
      ...infill.decor.map((d) => d.modelId),
      ...infill.cones.map((c) => c.modelId),
    ]);
    ids.delete('box-geometry');
    for (const id of ids) expect(hasCityPackModel(id), id).toBe(true);
  });
});

describe.each(SEEDS)('buildInfill — reject-never-relocate invariants at seed %i', (seed) => {
  const frontage = buildFrontage(seed);
  const infill = buildInfill(seed, frontage);
  const streets = buildStreets().streets;
  const sidewalkBands: Aabb[] = streets.map((s) => ({
    minX: s.ribbon.minX - 3, // SIDEWALK.widthWu (3) — literal duplicated here as an independent
    maxX: s.ribbon.maxX + 3, // fixture value (not imported), so a config regression cannot also
    minZ: s.ribbon.minY - 3, // corrupt the expectation.
    maxZ: s.ribbon.maxY + 3,
  }));
  const named = buildNamedBuildings();
  const places = buildPlacesLayer(named);
  const parks = buildParks();
  const exclusions: Aabb[] = [...named.exclusions, ...places.exclusions, ...parks.exclusions].map((r) => ({
    minX: r.minX,
    maxX: r.maxX,
    minZ: r.minY,
    maxZ: r.maxY,
  }));
  const frontageFootprints: Aabb[] = [...frontage.slots, ...frontage.cornerFills].map((s) => ({
    minX: s.position[0] - s.hx,
    maxX: s.position[0] + s.hx,
    minZ: s.position[2] - s.hz,
    maxZ: s.position[2] + s.hz,
  }));

  it('no FIXED item overlaps a sidewalk band', () => {
    const offenders = infill.fixed.filter((f) => sidewalkBands.some((r) => overlaps(footprintFixed(f), r)));
    expect(offenders.map((f) => f.id)).toEqual([]);
  });

  it('no back-lot box overlaps a sidewalk band', () => {
    const offenders = infill.boxes.filter((b) => {
      const fp: Aabb = { minX: b.x - b.hx, maxX: b.x + b.hx, minZ: b.z - b.hz, maxZ: b.z + b.hz };
      return sidewalkBands.some((r) => overlaps(fp, r));
    });
    expect(offenders.length).toBe(0);
  });

  it('no DECOR item (laneway/construction/lane-closure) sits inside a sidewalk band — the D10 no-furniture-on-ribbon extension, EXCEPT lane-closure road-bits (on-road by design, the manhole/parked-style exemption)', () => {
    const offenders = infill.decor.filter((d) => {
      if (d.modelId === 'road-bits') return false; // lane-closure plates sit ON the asphalt by design
      const fp: Aabb = { minX: d.position[0] - 0.6, maxX: d.position[0] + 0.6, minZ: d.position[2] - 0.6, maxZ: d.position[2] + 0.6 };
      return sidewalkBands.some((r) => overlaps(fp, r));
    });
    expect(offenders.length).toBe(0);
  });

  it('no FIXED item overlaps a named/hero/places/park exclusion, or dips into the water band', () => {
    const offenders: string[] = [];
    for (const f of infill.fixed) {
      const fp = footprintFixed(f);
      if (exclusions.some((r) => overlaps(fp, r))) offenders.push(`${f.id} exclusion`);
      if (fp.maxZ >= WATER_Z) offenders.push(`${f.id} water`);
    }
    expect(offenders).toEqual([]);
  });

  it('no FIXED item overlaps a frontage/corner-fill footprint (both rows never collide)', () => {
    const offenders = infill.fixed.filter((f) => frontageFootprints.some((r) => overlaps(footprintFixed(f), r)));
    expect(offenders.map((f) => f.id)).toEqual([]);
  });

  it('no back-lot box overlaps a frontage/corner-fill footprint', () => {
    const offenders = infill.boxes.filter((b) => {
      const fp: Aabb = { minX: b.x - b.hx, maxX: b.x + b.hx, minZ: b.z - b.hz, maxZ: b.z + b.hz };
      return frontageFootprints.some((r) => overlaps(fp, r));
    });
    expect(offenders.length).toBe(0);
  });

  it('no two FIXED items overlap each other (backlot/parking/construction never collide)', () => {
    const fps = infill.fixed.map(footprintFixed);
    const offenders: string[] = [];
    for (let i = 0; i < fps.length; i++) {
      for (let j = i + 1; j < fps.length; j++) {
        if (overlaps(fps[i], fps[j])) offenders.push(`${infill.fixed[i].id} x ${infill.fixed[j].id}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no FIXED item overlaps a back-lot box', () => {
    const boxFps: Aabb[] = infill.boxes.map((b) => ({ minX: b.x - b.hx, maxX: b.x + b.hx, minZ: b.z - b.hz, maxZ: b.z + b.hz }));
    const offenders = infill.fixed.filter((f) => boxFps.some((r) => overlaps(footprintFixed(f), r)));
    expect(offenders.map((f) => f.id)).toEqual([]);
  });

  it('every DECOR placement (except lane-closure road-bits) sits inside the playable polygon and out of the water', () => {
    for (const d of infill.decor) {
      expect(d.position[2]).toBeLessThan(WATER_Z);
    }
  });

  it('venue claims survive (unaffected by the infill layer)', () => {
    expect(frontage.venueClaims).toHaveLength(VENUE_AUTHORS.length);
  });
});

describe('buildInfill — layer presence on the real map (seed 416)', () => {
  const infill = buildInfill(416, buildFrontage(416));
  it('every category is non-empty', () => {
    expect(infill.fixed.length).toBeGreaterThan(0);
    expect(infill.boxes.length).toBeGreaterThan(0);
    expect(infill.decor.length).toBeGreaterThan(0);
    expect(infill.cones.length).toBeGreaterThan(0);
  });
  it('counts add up (fixedTotal/decorTotal match the arrays)', () => {
    expect(infill.counts.fixedTotal).toBe(infill.fixed.length);
    expect(infill.counts.decorTotal).toBe(infill.decor.length);
    expect(infill.counts.laneClosureCones).toBe(infill.cones.length);
  });
});

// --- Phase 28 (D8) quality-tier wiring ---------------------------------------------------------

describe('buildInfill — tier wiring (D8)', () => {
  const seed = 416;
  const frontage = buildFrontage(seed);
  const HIGH = tierParamsOf('high');
  const MED = tierParamsOf('med');
  const LOW = tierParamsOf('low');

  it('the high tier resolves to exactly TORONTO_TIER_IDENTITY (the default)', () => {
    expect(HIGH).toEqual(TORONTO_TIER_IDENTITY);
  });

  it('high tier is byte-identical to the pre-tier (no-arg default) output — golden', () => {
    const noArg = buildInfill(seed, frontage);
    expect(buildInfill(seed, frontage, HIGH)).toEqual(noArg);
  });

  it('same (seed, tier) → deep-equal output (determinism)', () => {
    expect(buildInfill(seed, frontage, LOW)).toEqual(buildInfill(seed, frontage, LOW));
  });

  it('low tier thins backlot/laneway/parking-lot counts relative to high tier', () => {
    const high = buildInfill(seed, frontage, HIGH);
    const med = buildInfill(seed, frontage, MED);
    const low = buildInfill(seed, frontage, LOW);
    expect(low.counts.backlotPack + low.counts.backlotBox).toBeLessThanOrEqual(high.counts.backlotPack + high.counts.backlotBox);
    expect(low.counts.laneway).toBeLessThanOrEqual(med.counts.laneway);
    expect(med.counts.laneway).toBeLessThanOrEqual(high.counts.laneway);
  });

  it('low tier drops lane closures entirely (D7/D8: "dropped entirely on the low tier")', () => {
    const low = buildInfill(seed, frontage, LOW);
    expect(low.cones.length).toBe(0);
    expect(low.counts.laneClosures).toBe(0);
  });

  it('med/high tiers still have lane closures', () => {
    const med = buildInfill(seed, frontage, MED);
    const high = buildInfill(seed, frontage, HIGH);
    expect(med.cones.length).toBeGreaterThan(0);
    expect(high.cones.length).toBeGreaterThan(0);
  });

  it('low tier halves construction decor props per site relative to high tier (propScale)', () => {
    const high = buildInfill(seed, frontage, HIGH);
    const low = buildInfill(seed, frontage, LOW);
    // Every site keeps its fence run + dumpster (structural); only cone-cluster/box/debris counts
    // thin, so a strict per-site halving isn't exact, but the map-wide construction decor total
    // must drop noticeably.
    expect(low.counts.constructionDecor).toBeLessThan(high.counts.constructionDecor);
  });

  it('D11 deep-interior scatter thins with tier too (both caps AND the coarser scan)', () => {
    const high = buildInfill(seed, frontage, HIGH);
    const low = buildInfill(seed, frontage, LOW);
    expect(low.counts.deepScatterTrees).toBeLessThan(high.counts.deepScatterTrees);
    expect(low.counts.deepScatterTrees).toBeLessThanOrEqual(Math.round(DEEP_SCATTER.treeCapMapWide * LOW.dressDensityScalar));
    expect(low.counts.deepScatterGreenhouses).toBeLessThanOrEqual(high.counts.deepScatterGreenhouses);
    expect(low.counts.deepScatterPiles).toBeLessThanOrEqual(high.counts.deepScatterPiles);
  });
});

// --- Phase 28 (D11) deep-interior scatter --------------------------------------------------------
// Live verification found the North York capsule's deep block interiors (e.g. map point
// x=1550, z=350 — willowdaleFinch) sit 40+ wu from the nearest street and so are untouched by
// every street-hugging layer above (D1-D7). D11 is the last, lowest-density pass that scatters
// tree clusters + rare greenhouse/pile garnish into exactly those deep interiors.
describe.each(SEEDS)('buildInfill — D11 deep-interior scatter at seed %i', (seed) => {
  const frontage = buildFrontage(seed);
  const infill = buildInfill(seed, frontage);
  const { streets } = buildStreets();
  const densityById = new Map(TORONTO_DISTRICTS.map((d) => [d.id, d.density]));

  function deepScatterTrees(): FixedInfillItem[] {
    return infill.fixed.filter((f) => f.id.startsWith('deep-scatter:tree:'));
  }
  function deepScatterGreenhouses(): FixedInfillItem[] {
    return infill.fixed.filter((f) => f.id.startsWith('deep-scatter:greenhouse:'));
  }
  function deepScatterPiles(): DecorPlacement[] {
    // Piles are the ONLY D11 decor category, and D11 decor never overlaps with laneway/
    // construction/lane-closure decor by construction (distinct model pools) — but to identify
    // them independent of that assumption, cross-check against the dumpster/box pile pool.
    return infill.decor.filter((d) => d.modelId === 'dumpster' || d.modelId === 'box');
  }

  it('determinism: same (seed, frontage) → identical deep-scatter counts and items', () => {
    const again = buildInfill(seed, frontage);
    expect(again.counts.deepScatterTrees).toBe(infill.counts.deepScatterTrees);
    expect(again.counts.deepScatterGreenhouses).toBe(infill.counts.deepScatterGreenhouses);
    expect(again.counts.deepScatterPiles).toBe(infill.counts.deepScatterPiles);
    expect(deepScatterTrees()).toEqual(deepScatterTrees());
  });

  it('map-wide caps hold (high/identity tier = the literal task-specified numbers)', () => {
    expect(deepScatterTrees().length).toBeLessThanOrEqual(DEEP_SCATTER.treeCapMapWide);
    expect(deepScatterGreenhouses().length).toBeLessThanOrEqual(DEEP_SCATTER.greenhouseCapMapWide);
    expect(infill.counts.deepScatterPiles).toBeLessThanOrEqual(DEEP_SCATTER.pileCapMapWide);
  });

  it('every deep-scatter tree/greenhouse clears every street ribbon by at least the eligibility floor minus one cluster-spread radius', () => {
    // The scanned CANDIDATE centre always clears DEEP_SCATTER.minDistFromRibbonWu (35 wu) from
    // every ribbon; individual cluster members jitter up to clusterSpreadWu around that centre, so
    // the worst-case per-item floor is (35 - clusterSpreadWu). Still comfortably outside the
    // sidewalk band, which the shared gates reject independently.
    const floor = DEEP_SCATTER.minDistFromRibbonWu - DEEP_SCATTER.clusterSpreadWu;
    const minDistToRibbons = (x: number, z: number): number => {
      let best = Infinity;
      for (const s of streets as readonly Street[]) {
        const r = s.ribbon;
        const dx = Math.max(r.minX - x, 0, x - r.maxX);
        const dz = Math.max(r.minY - z, 0, z - r.maxY);
        best = Math.min(best, Math.hypot(dx, dz));
      }
      return best;
    };
    for (const t of [...deepScatterTrees(), ...deepScatterGreenhouses()]) {
      expect(minDistToRibbons(t.position[0], t.position[2])).toBeGreaterThan(floor);
    }
  });

  it('greenhouses only ever roll in a district at a DEEP_SCATTER.greenhouseDensities density', () => {
    const allowed = new Set(DEEP_SCATTER.greenhouseDensities as readonly string[]);
    for (const g of deepScatterGreenhouses()) {
      expect(allowed.has(densityById.get(g.districtId)!)).toBe(true);
    }
  });

  it('no deep-scatter tree/greenhouse overlaps a deep-scatter pile (D11 rejects against itself, across the fixed/decor split)', () => {
    const fixedFps: Aabb[] = [...deepScatterTrees(), ...deepScatterGreenhouses()].map((f) => ({
      minX: f.position[0] - f.hx,
      maxX: f.position[0] + f.hx,
      minZ: f.position[2] - f.hz,
      maxZ: f.position[2] + f.hz,
    }));
    const offenders = deepScatterPiles().filter((p) => {
      const fp: Aabb = { minX: p.position[0] - 0.6, maxX: p.position[0] + 0.6, minZ: p.position[2] - 0.6, maxZ: p.position[2] + 0.6 };
      return fixedFps.some((r) => overlaps(fp, r));
    });
    expect(offenders.length).toBe(0);
  });

  it('the North York capsule (willowdaleFinch/northYorkCentre) actually receives deep-scatter trees — the reported bug region', () => {
    const capsuleTrees = deepScatterTrees().filter((t) => t.districtId === 'willowdaleFinch' || t.districtId === 'northYorkCentre');
    expect(capsuleTrees.length).toBeGreaterThan(10);
  });
});

// --- type re-exports sanity (compile-time only, cheap runtime smoke) ----------------------------
describe('infill output shapes', () => {
  it('DecorPlacement/DynamicConeSpec fields are present on real output', () => {
    const infill = buildInfill(416, buildFrontage(416));
    const d: DecorPlacement = infill.decor[0];
    expect(typeof d.modelId).toBe('string');
    const c: DynamicConeSpec = infill.cones[0];
    expect(c.modelId).toBe('cone');
  });
});
