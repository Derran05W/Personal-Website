// Phase 25.6 (D16/D18) — furniture.ts tests: traffic-light signalization rule correctness
// against known crossings, sidewalk-vs-road placement, exclusion-awareness, caps, district
// ordering, determinism.
import { describe, expect, it } from 'vitest';
import { PLAYABLE_POLYGON, pointInPolygon } from './polygon';
import { buildNamedBuildings } from './namedBuildings';
import { buildPlacesLayer } from './placesLayer';
import { buildRibbons, listIntersections } from './roadGraph';
import { buildStreets, type MapRect } from './streets';
import {
  BENCH_ROW,
  BUS_STOP_ROW,
  HYDRANT_ROW,
  MANHOLE_ROW,
  PARKED,
  POWER_BOX,
  TORONTO_TIER_IDENTITY,
  TRAFFIC_LIGHT,
  TRAFFIC_LIGHT_FULL_CLASSES,
  TRASH_CAN_ROW,
  TREE_ROW,
  type TorontoTierParams,
} from '../../config/torontoDress';
import { QUALITY_TIERS } from '../../config/quality';
import { resolveCityPackScale } from '../../config/cityPackScale';
import { ROAD_CLASSES, type RoadClass } from '../../config/torontoMap';
import { TORONTO_DISTRICTS } from '../../config/torontoDistricts';
import { getCityPackModel, hasCityPackModel } from '../../assets/cityPackManifest';
import { buildFurniture, type FurniturePlacement, type ParkedVehicle } from './furniture';

const SEED = 416; // the repo's canonical dev seed (phase-04/18 notes)

const layout = buildFurniture(SEED);
const { streets } = buildStreets();
const intersections = listIntersections(streets);
const ribbonsWorld = buildRibbons(streets).map((r) => ({ minX: r.minX, minY: r.minZ, maxX: r.maxX, maxY: r.maxZ }) as MapRect);

function mapPointOf(position: readonly [number, number, number]): { x: number; y: number } {
  return { x: position[0], y: position[2] };
}

function pointInRect(p: { x: number; y: number }, r: MapRect): boolean {
  return p.x >= r.minX && p.x <= r.maxX && p.y >= r.minY && p.y <= r.maxY;
}

function onAnyRibbon(placement: { readonly position: readonly [number, number, number] }): boolean {
  const p = mapPointOf(placement.position);
  return ribbonsWorld.some((r) => pointInRect(p, r));
}

describe('buildFurniture — determinism', () => {
  it('two independent builds are deep-equal', () => {
    const again = buildFurniture(SEED);
    expect(again).toEqual(layout);
  });

  it('a different seed changes at least one placement (not a hardcoded/frozen layout)', () => {
    const other = buildFurniture(SEED + 1);
    expect(other.trees.items).not.toEqual(layout.trees.items);
  });
});

describe('traffic lights — signalization rule (D16)', () => {
  it('King x Bay (major x major, both "full" classes) gets 3 of its 4 corner masts (Bay/York proxy artifact drops the 4th)', () => {
    // Part-8 (D1) compaction closes the Bay/York centreline gap (see namedBuildings.ts's
    // documented "Bay/York proxy artifact" and roadPaint.test.ts's matching exception) into a
    // ~0.2 wu ribbon overlap right at this corner — one of the four corner clamps lands ON
    // York's ribbon and is dropped by the D10 no-furniture-on-ribbon invariant. Every OTHER
    // signalized 4-corner intersection still mounts all 4 masts (see the map-wide check below).
    const idx = intersections.findIndex(
      (c) => (c.nsId === 'bay' && c.ewId === 'king') || (c.nsId === 'king' && c.ewId === 'bay'),
    );
    expect(idx).toBeGreaterThanOrEqual(0);
    const masts = layout.trafficLights.filter((m) => m.intersectionIndex === idx);
    expect(masts.length).toBe(3);
  });

  // Live-verification FIX 2 (Part-8, "density/life flip"): on the 6.6-8.8 wu dieted roads the
  // resolved ~7.2-wu-wide mast arm (at the old 1.35 scale override) spanned the entire road, with
  // the head hovering near the car at intersection centres. cityPackScale.ts's 'traffic-light'
  // override dropped 1.35 -> 1.0. Asserts the mast's resolved arm reach, measured from its corner
  // position (ribbon edge + TRAFFIC_LIGHT.cornerOffsetWu), stays short of EVERY full-class
  // pairing's nearer crossing-street centreline (min of the two corner-to-centreline distances) —
  // for every combination TRAFFIC_LIGHT_FULL_CLASSES can produce at a signalized intersection.
  describe('mast arm reach stays short of the crossing centreline (every full-class pairing)', () => {
    // The pack model's own bounding box doesn't tell us exactly where the pole sits inside it, so
    // a small allowance (well under the >2 wu the old 1.35 scale overshot by) covers that
    // measurement uncertainty without hiding a real regression.
    const ARM_REACH_TOLERANCE_WU = 0.2;
    const reach = getCityPackModel('traffic-light').nativeDims.w * resolveCityPackScale('traffic-light');

    const pairs: readonly (readonly [RoadClass, RoadClass])[] = TRAFFIC_LIGHT_FULL_CLASSES.flatMap((ns) =>
      TRAFFIC_LIGHT_FULL_CLASSES.map((ew): readonly [RoadClass, RoadClass] => [ns, ew]),
    );

    it.each(pairs)('%s x %s: reach (%#) stays short of the nearer centreline', (nsCls, ewCls) => {
      const nsHalf = ROAD_CLASSES[nsCls] / 2 + TRAFFIC_LIGHT.cornerOffsetWu;
      const ewHalf = ROAD_CLASSES[ewCls] / 2 + TRAFFIC_LIGHT.cornerOffsetWu;
      const nearerCentreline = Math.min(nsHalf, ewHalf);
      expect(reach, `${nsCls}x${ewCls} reach=${reach.toFixed(2)} vs ${nearerCentreline.toFixed(2)}`).toBeLessThanOrEqual(
        nearerCentreline + ARM_REACH_TOLERANCE_WU,
      );
    });

    it('would have failed badly under the pre-Part-8-retune 1.35 scale (regression guard)', () => {
      const oldReach = getCityPackModel('traffic-light').nativeDims.w * 1.35;
      const tightest = Math.min(
        ...pairs.map(([nsCls, ewCls]) => Math.min(ROAD_CLASSES[nsCls] / 2 + TRAFFIC_LIGHT.cornerOffsetWu, ROAD_CLASSES[ewCls] / 2 + TRAFFIC_LIGHT.cornerOffsetWu)),
      );
      expect(oldReach).toBeGreaterThan(tightest + ARM_REACH_TOLERANCE_WU);
    });
  });

  it('a minor x major crossing (john x queen) gets exactly 2 diagonal masts, no stop sign', () => {
    const idx = intersections.findIndex(
      (c) => (c.nsId === 'john' && c.ewId === 'queen') || (c.nsId === 'queen' && c.ewId === 'john'),
    );
    expect(idx).toBeGreaterThanOrEqual(0);
    const crossing = intersections[idx];
    // Sanity: one side is genuinely "minor", the other "major" (the diagonal rule's premise).
    expect([crossing.nsCls, crossing.ewCls].sort()).toEqual(['major', 'minor']);
    const masts = layout.trafficLights.filter((m) => m.intersectionIndex === idx);
    expect(masts.length).toBe(2);
  });

  it('signalized (both classes full) intersections get UP TO 4 masts; diagonal (one full) up to 2; minor x minor 0 masts', () => {
    // Phase 25.8 (D10): the no-furniture-on-ribbon invariant DROPS boundary corner masts that
    // clampInsidePolygon nudges onto a ribbon (e.g. int 0 = Bathurst×Bloor, the SW map corner, keeps
    // 2 of 4). So an interior signalized intersection keeps all 4, but a boundary one keeps fewer —
    // the count is a MAXIMUM per classification, never exceeded, and interior ones hit the max. The
    // strict "no mast on any ribbon" side of this is asserted map-wide in furnitureRibbon.test.ts.
    const FULL = new Set(['spine', 'artery', 'major']);
    let checkedSignalized = 0;
    let checkedDiagonal = 0;
    let checkedStopSign = 0;
    let signalizedFull = 0; // interior intersections that keep all 4
    intersections.forEach((c, idx) => {
      const nsFull = FULL.has(c.nsCls);
      const ewFull = FULL.has(c.ewCls);
      const masts = layout.trafficLights.filter((m) => m.intersectionIndex === idx);
      if (nsFull && ewFull) {
        expect(masts.length, `intersection ${idx}`).toBeGreaterThanOrEqual(1);
        expect(masts.length, `intersection ${idx}`).toBeLessThanOrEqual(4);
        if (masts.length === 4) signalizedFull++;
        checkedSignalized++;
      } else if (nsFull || ewFull) {
        expect(masts.length, `intersection ${idx}`).toBeGreaterThanOrEqual(1);
        expect(masts.length, `intersection ${idx}`).toBeLessThanOrEqual(2);
        checkedDiagonal++;
      } else {
        expect(masts.length, `intersection ${idx}`).toBe(0);
        checkedStopSign++;
      }
    });
    expect(checkedSignalized).toBeGreaterThan(0);
    expect(checkedDiagonal).toBeGreaterThan(0);
    // The vast majority of signalized intersections are interior → keep all 4 (only the handful of
    // boundary ones are trimmed by the invariant); this keeps the test's detection power.
    expect(signalizedFull).toBeGreaterThan(checkedSignalized / 2);
    // stop-sign (minor x minor) crossings: ≤ 1 stop sign each (the invariant may drop a boundary one).
    expect(layout.stopSigns.items.length).toBeLessThanOrEqual(checkedStopSign);
  });

  it('every mast model id is "traffic-light" and every stop sign is "stop-sign" (real manifest ids)', () => {
    for (const m of layout.trafficLights) expect(hasCityPackModel(m.modelId)).toBe(true);
    for (const s of layout.stopSigns.items) expect(hasCityPackModel(s.modelId)).toBe(true);
  });

  it('every mast intersectionIndex is a valid index into listIntersections', () => {
    for (const m of layout.trafficLights) {
      expect(m.intersectionIndex).toBeGreaterThanOrEqual(0);
      expect(m.intersectionIndex).toBeLessThan(intersections.length);
    }
  });
});

describe('sidewalk rows never overlap a road ribbon', () => {
  const rowCategories: readonly { readonly name: string; readonly items: readonly FurniturePlacement[] }[] = [
    { name: 'trees', items: layout.trees.items },
    { name: 'hydrants', items: layout.hydrants.items },
    { name: 'benches', items: layout.benches.items },
    { name: 'trashCans', items: layout.trashCans.items },
    { name: 'busStops', items: layout.busStops.items },
  ];

  for (const { name, items } of rowCategories) {
    it(`${name}: no placement lands inside a road ribbon`, () => {
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) {
        expect(onAnyRibbon(item), JSON.stringify(item.position)).toBe(false);
      }
    });
  }
});

describe('manholes and parked vehicles are always ON their ribbon (on-road, D16/D18)', () => {
  it('every manhole lands inside some road ribbon', () => {
    expect(layout.manholes.items.length).toBeGreaterThan(0);
    for (const m of layout.manholes.items) {
      expect(onAnyRibbon(m), JSON.stringify(m.position)).toBe(true);
    }
  });

  it('every parked vehicle lands inside some road ribbon (the outer asphalt lane)', () => {
    expect(layout.parked.items.length).toBeGreaterThan(0);
    for (const p of layout.parked.items) {
      expect(onAnyRibbon(p), JSON.stringify(p.position)).toBe(true);
    }
  });
});

describe('everything lies inside the playable polygon', () => {
  const allPlacements: readonly { readonly position: readonly [number, number, number] }[] = [
    ...layout.trafficLights,
    ...layout.stopSigns.items,
    ...layout.powerBoxes.items,
    ...layout.trees.items,
    ...layout.hydrants.items,
    ...layout.benches.items,
    ...layout.trashCans.items,
    ...layout.busStops.items,
    ...layout.manholes.items,
    ...layout.parked.items,
  ];

  it('every placement (all categories) is inside PLAYABLE_POLYGON', () => {
    expect(allPlacements.length).toBeGreaterThan(0);
    for (const p of allPlacements) {
      expect(pointInPolygon(mapPointOf(p.position), PLAYABLE_POLYGON), JSON.stringify(p.position)).toBe(true);
    }
  });
});

describe('exclusion-aware — nothing spawns inside a named-building or places-layer footprint', () => {
  const named = buildNamedBuildings();
  const places = buildPlacesLayer(named);
  const exclusions = [...named.exclusions, ...places.exclusions];

  const categories: readonly { readonly name: string; readonly items: readonly { readonly position: readonly [number, number, number] }[] }[] = [
    { name: 'powerBoxes', items: layout.powerBoxes.items },
    { name: 'trees', items: layout.trees.items },
    { name: 'hydrants', items: layout.hydrants.items },
    { name: 'benches', items: layout.benches.items },
    { name: 'trashCans', items: layout.trashCans.items },
    { name: 'busStops', items: layout.busStops.items },
    { name: 'parked', items: layout.parked.items },
  ];

  for (const { name, items } of categories) {
    it(`${name}: no placement's centre lies inside a named/places exclusion rect`, () => {
      for (const item of items) {
        const p = mapPointOf(item.position);
        const inside = exclusions.some((r) => p.x > r.minX && p.x < r.maxX && p.y > r.minY && p.y < r.maxY);
        expect(inside, JSON.stringify(item.position)).toBe(false);
      }
    });
  }
});

describe('caps — every category respects its config/torontoDress.ts capMapWide', () => {
  it('trees <= cap', () => expect(layout.trees.items.length).toBeLessThanOrEqual(TREE_ROW.capMapWide));
  it('hydrants <= cap', () => expect(layout.hydrants.items.length).toBeLessThanOrEqual(HYDRANT_ROW.capMapWide));
  it('benches <= cap', () => expect(layout.benches.items.length).toBeLessThanOrEqual(BENCH_ROW.capMapWide));
  it('trashCans <= cap', () => expect(layout.trashCans.items.length).toBeLessThanOrEqual(TRASH_CAN_ROW.capMapWide));
  it('busStops <= cap', () => expect(layout.busStops.items.length).toBeLessThanOrEqual(BUS_STOP_ROW.capMapWide));
  it('manholes <= cap', () => expect(layout.manholes.items.length).toBeLessThanOrEqual(MANHOLE_ROW.capMapWide));
  it('powerBoxes <= cap', () => expect(layout.powerBoxes.items.length).toBeLessThanOrEqual(POWER_BOX.capMapWide));
  it('parked <= cap (200, D9 perf budget)', () => expect(layout.parked.items.length).toBeLessThanOrEqual(PARKED.cap));
});

describe('parked vehicles — model set + exclusions (D18)', () => {
  const EXCLUDED_IDS = new Set(['police-car', 'bus', 'bicycle', 'motorcycle']);

  it('every parked vehicle uses a real manifest id, never an excluded one', () => {
    for (const p of layout.parked.items as readonly ParkedVehicle[]) {
      expect(hasCityPackModel(p.modelId), p.modelId).toBe(true);
      expect(EXCLUDED_IDS.has(p.modelId), p.modelId).toBe(false);
    }
  });
});

describe('district-ordered ranges (sacred convention)', () => {
  const DISTRICT_ORDER_INDEX = new Map(TORONTO_DISTRICTS.map((d, i) => [d.id, i]));

  const rangedCategories: readonly { readonly name: string; readonly ordered: { readonly items: readonly unknown[]; readonly ranges: readonly { readonly districtId: string; readonly start: number; readonly count: number }[] } }[] = [
    { name: 'trees', ordered: layout.trees },
    { name: 'hydrants', ordered: layout.hydrants },
    { name: 'benches', ordered: layout.benches },
    { name: 'trashCans', ordered: layout.trashCans },
    { name: 'busStops', ordered: layout.busStops },
    { name: 'manholes', ordered: layout.manholes },
    { name: 'powerBoxes', ordered: layout.powerBoxes },
    { name: 'parked', ordered: layout.parked },
    { name: 'stopSigns', ordered: layout.stopSigns },
  ];

  for (const { name, ordered } of rangedCategories) {
    it(`${name}: ranges are contiguous, cover every item exactly once, and follow config order`, () => {
      let expectedStart = 0;
      let lastOrderIndex = -1;
      for (const r of ordered.ranges) {
        expect(r.start, name).toBe(expectedStart);
        expect(r.count, name).toBeGreaterThan(0);
        const orderIndex = DISTRICT_ORDER_INDEX.get(r.districtId as never)!;
        expect(orderIndex, `${name}: ${r.districtId} out of config order`).toBeGreaterThan(lastOrderIndex);
        lastOrderIndex = orderIndex;
        expectedStart += r.count;
      }
      expect(expectedStart, name).toBe(ordered.items.length);
    });
  }
});

describe('counts — every category is non-empty on the real map (sanity, not a size claim)', () => {
  it('matches layout.counts exactly for every category', () => {
    expect(layout.counts).toEqual({
      trafficLights: layout.trafficLights.length,
      stopSigns: layout.stopSigns.items.length,
      powerBoxes: layout.powerBoxes.items.length,
      trees: layout.trees.items.length,
      hydrants: layout.hydrants.items.length,
      benches: layout.benches.items.length,
      trashCans: layout.trashCans.items.length,
      busStops: layout.busStops.items.length,
      manholes: layout.manholes.items.length,
      parked: layout.parked.items.length,
    });
  });

  it('every category except stopSigns is non-empty on the real map', () => {
    expect(layout.trafficLights.length).toBeGreaterThan(0);
    expect(layout.powerBoxes.items.length).toBeGreaterThan(0);
    expect(layout.trees.items.length).toBeGreaterThan(0);
    expect(layout.hydrants.items.length).toBeGreaterThan(0);
    expect(layout.benches.items.length).toBeGreaterThan(0);
    expect(layout.trashCans.items.length).toBeGreaterThan(0);
    expect(layout.busStops.items.length).toBeGreaterThan(0);
    expect(layout.manholes.items.length).toBeGreaterThan(0);
    expect(layout.parked.items.length).toBeGreaterThan(0);
  });
});

// --- Phase 25.8 (T2/D8) quality-tier wiring -----------------------------------------------

function tierParamsOf(tier: keyof typeof QUALITY_TIERS): TorontoTierParams {
  const t = QUALITY_TIERS[tier];
  return {
    dressDensityScalar: t.dressDensityScalar,
    frontageOccupancyScalar: t.frontageOccupancyScalar,
    parkedCarKeepFraction: t.parkedCarKeepFraction,
  };
}

describe('buildFurniture — Phase 25.8 (D8) quality-tier wiring', () => {
  const HIGH = tierParamsOf('high');
  const MED = tierParamsOf('med');
  const LOW = tierParamsOf('low');

  it('the high tier resolves to exactly TORONTO_TIER_IDENTITY (the default)', () => {
    expect(HIGH).toEqual(TORONTO_TIER_IDENTITY);
  });

  it('high tier is byte-identical to the pre-tier (no-arg) output — golden', () => {
    expect(buildFurniture(SEED, HIGH)).toEqual(layout);
    expect(buildFurniture(SEED, HIGH)).toEqual(buildFurniture(SEED));
  });

  it('same (seed, tier) -> deep-equal output (determinism)', () => {
    expect(buildFurniture(SEED, LOW)).toEqual(buildFurniture(SEED, LOW));
  });

  it('dressDensityScalar thins every row-spacing category monotonically (low <= med <= high)', () => {
    const high = buildFurniture(SEED, HIGH);
    const med = buildFurniture(SEED, MED);
    const low = buildFurniture(SEED, LOW);
    for (const cat of ['trees', 'hydrants', 'benches', 'trashCans', 'busStops', 'manholes'] as const) {
      expect(low[cat].items.length, cat).toBeLessThanOrEqual(med[cat].items.length);
      expect(med[cat].items.length, cat).toBeLessThanOrEqual(high[cat].items.length);
    }
    // Trees are the biggest category and comfortably clear of their capMapWide at every tier on
    // this seed, so they're guaranteed to actually move (not just tie at a shared cap).
    expect(low.trees.items.length).toBeLessThan(high.trees.items.length);
  });

  it('intersection-rule furniture (masts/stop-signs/power-boxes) is NEVER scaled by tier', () => {
    const high = buildFurniture(SEED, HIGH);
    const low = buildFurniture(SEED, LOW);
    expect(low.trafficLights.length).toBe(high.trafficLights.length);
    expect(low.stopSigns.items.length).toBe(high.stopSigns.items.length);
    expect(low.powerBoxes.items.length).toBe(high.powerBoxes.items.length);
  });

  it('parkedCarKeepFraction scales PARKED.cap (the low-tier dynamic-body-budget driver)', () => {
    const high = buildFurniture(SEED, HIGH);
    const med = buildFurniture(SEED, MED);
    const low = buildFurniture(SEED, LOW);
    expect(high.parked.items.length).toBeLessThanOrEqual(PARKED.cap);
    expect(med.parked.items.length).toBeLessThanOrEqual(Math.round(PARKED.cap * QUALITY_TIERS.med.parkedCarKeepFraction));
    expect(low.parked.items.length).toBeLessThanOrEqual(Math.round(PARKED.cap * QUALITY_TIERS.low.parkedCarKeepFraction));
    expect(low.parked.items.length).toBeLessThan(med.parked.items.length);
    expect(med.parked.items.length).toBeLessThan(high.parked.items.length);
    // The plan's worked numbers at this PARKED.cap (200): 200/120/50.
    expect(low.parked.items.length).toBeLessThanOrEqual(50);
  });

  it('district ranges stay contiguous/valid under low-tier thinning (sacred convention holds at every tier)', () => {
    const low = buildFurniture(SEED, LOW);
    for (const ordered of [low.trees, low.parked, low.hydrants, low.manholes]) {
      let cursor = 0;
      for (const r of ordered.ranges) {
        expect(r.start).toBe(cursor);
        expect(r.count).toBeGreaterThan(0);
        cursor += r.count;
      }
      expect(cursor).toBe(ordered.items.length);
    }
  });
});

describe('collider specs (D12)', () => {
  it('tree trunk collider is small and narrow (never the canopy box)', () => {
    const { treeTrunk } = layout.colliderSpecs;
    expect(treeTrunk.hx).toBe(TREE_ROW.trunkHalfWidthWu);
    expect(treeTrunk.hz).toBe(TREE_ROW.trunkHalfWidthWu);
    expect(treeTrunk.hy).toBeGreaterThan(0);
    // A canopy box would be several wu wide; the trunk must stay sub-metre.
    expect(treeTrunk.hx).toBeLessThan(1);
  });

  it('bus-stop collider has positive half-extents on every axis', () => {
    const { busStop } = layout.colliderSpecs;
    expect(busStop.hx).toBeGreaterThan(0);
    expect(busStop.hy).toBeGreaterThan(0);
    expect(busStop.hz).toBeGreaterThan(0);
  });

  it('parked body spec matches config/torontoDress.ts PARKED.body verbatim', () => {
    expect(layout.colliderSpecs.parkedBody).toEqual(PARKED.body);
  });
});
