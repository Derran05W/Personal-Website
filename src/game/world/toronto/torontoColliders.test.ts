// Tests for Phase 29 T1's registry-entry builders (world/toronto/torontoColliders.ts) — the
// pure logic backing every Toronto collider's registration seam (CityDress.tsx/TorontoScene.tsx
// consume these; see this suite for why they're split out, mirroring
// world/worldCollidersLogic.ts's own component-free-module precedent).
//
// "Registry coverage counts per layer" (phase-29-plan.md T1 brief): for every real layout at
// seeds 416 and 9417, every placement that gets a collider produces EXACTLY one registrable
// entry with a valid kind/archetype/hp/districtId — derived from the actual built layouts, not
// hardcoded totals (a seed/tuning change can never silently desync this suite from reality).
import { describe, expect, it } from 'vitest';
import { TORONTO_DISTRICTS } from '../../config/torontoDistricts';
import { PROPS } from '../../config';
import { POWER_BOX } from '../../config/torontoDress';
import { buildFrontage } from './frontage';
import { buildFurniture } from './furniture';
import { buildInfill } from './infill';
import { buildNamedBuildings, HERO_LOTS } from './namedBuildings';
import { buildPlacesLayer } from './placesLayer';
import { buildDistricts, torontoDistrictIndex, torontoDistrictIndexAt, TORONTO_DISTRICT_COUNT } from './districts';
import {
  torontoBuildingEntry,
  torontoBuildingEntryAt,
  torontoBusStopEntry,
  torontoConeEntry,
  torontoFurnitureEntry,
  torontoParkedCarEntry,
  torontoTransformerEntry,
  torontoTreeEntry,
} from './torontoColliders';

const SEEDS = [416, 9417];
const districts = buildDistricts();

function isValidDistrictIndex(n: number): boolean {
  return Number.isInteger(n) && n >= 0 && n < TORONTO_DISTRICT_COUNT;
}

describe('TORONTO_DISTRICT_COUNT / torontoDistrictIndex', () => {
  it('is 15 (the 13 §6 rows + genericDowntown + foldCorridor)', () => {
    expect(TORONTO_DISTRICT_COUNT).toBe(15);
    expect(TORONTO_DISTRICTS.length).toBe(15);
  });

  it('maps every DistrictId to a unique index covering 0..14 exactly once (bijective)', () => {
    const indices = TORONTO_DISTRICTS.map((d) => torontoDistrictIndex(d.id));
    expect(new Set(indices).size).toBe(15);
    expect([...indices].sort((a, b) => a - b)).toEqual([...Array(15).keys()]);
  });

  it('throws for an unknown DistrictId', () => {
    expect(() => torontoDistrictIndex('not-a-real-district' as never)).toThrow();
  });
});

describe.each(SEEDS)('registry coverage per layer — seed %d', (seed) => {
  const frontage = buildFrontage(seed);
  const furniture = buildFurniture(seed);
  const infill = buildInfill(seed, frontage);
  const named = buildNamedBuildings();
  const places = buildPlacesLayer(named);

  it('frontage slots + cornerFills + infill.fixed → one building entry each, valid districtId', () => {
    const items = [...frontage.slots, ...frontage.cornerFills, ...infill.fixed];
    expect(items.length).toBeGreaterThan(0);
    for (const s of items) {
      const entry = torontoBuildingEntry(s.districtId);
      expect(entry.kind).toBe('building');
      expect(entry.hp).toBeUndefined(); // indestructible
      expect(isValidDistrictIndex(entry.districtId)).toBe(true);
      expect(entry.districtId).toBe(torontoDistrictIndex(s.districtId));
    }
  });

  it('backdrop towers (frontage.towerBoxes + infill.boxes) → one building entry each', () => {
    const boxes = [...frontage.towerBoxes, ...infill.boxes];
    for (const b of boxes) {
      const entry = torontoBuildingEntry(b.districtId);
      expect(entry.kind).toBe('building');
      expect(isValidDistrictIndex(entry.districtId)).toBe(true);
    }
  });

  it('power boxes → one transformer entry each, hp = POWER_BOX.hp, instanceId matches its slot', () => {
    const boxes = furniture.powerBoxes.items;
    expect(boxes.length).toBeGreaterThan(0);
    boxes.forEach((p, i) => {
      const entry = torontoTransformerEntry(p.districtId, i);
      expect(entry.kind).toBe('transformer');
      expect(entry.hp).toBe(POWER_BOX.hp);
      expect(entry.instanceId).toBe(i);
      expect(isValidDistrictIndex(entry.districtId)).toBe(true);
    });
  });

  it('parked cars → one propDynamic/parkedCar entry each, hp = PROPS.parkedCarHp', () => {
    const cars = furniture.parked.items;
    expect(cars.length).toBeGreaterThan(0);
    for (const c of cars) {
      const entry = torontoParkedCarEntry(c.districtId);
      expect(entry.kind).toBe('propDynamic');
      expect(entry.archetype).toBe('parkedCar');
      expect(entry.hp).toBe(PROPS.parkedCarHp);
      expect(isValidDistrictIndex(entry.districtId)).toBe(true);
    }
  });

  it('lane-closure cones → propDynamic entries, no hp, districtId -1 (no source field)', () => {
    // torontoConeEntry() takes no per-cone data (DynamicConeSpec carries no districtId — see
    // torontoColliders.ts's file header), so every cone in this layout produces the identical
    // entry shape; asserting once is representative of all infill.cones.length placements.
    expect(infill.cones.length).toBeGreaterThanOrEqual(0);
    const entry = torontoConeEntry();
    expect(entry.kind).toBe('propDynamic');
    expect(entry.hp).toBeUndefined();
    expect(entry.districtId).toBe(-1);
  });

  it('tree trunks → one propStatic/tree entry each; bus stops → propStatic/busStop (Phase 30 T2 debt-1)', () => {
    furniture.trees.items.forEach((t, i) => {
      const entry = torontoTreeEntry(t.districtId, i);
      expect(entry.kind).toBe('propStatic');
      expect(entry.archetype).toBe('tree');
      expect(entry.instanceId).toBe(i);
      expect(isValidDistrictIndex(entry.districtId)).toBe(true);
    });
    expect(furniture.busStops.items.length).toBeGreaterThan(0);
    furniture.busStops.items.forEach((b, i) => {
      const entry = torontoBusStopEntry(b.districtId, i);
      expect(entry.kind).toBe('propStatic');
      expect(entry.archetype).toBe('busStop');
      expect(entry.instanceId).toBe(i);
      expect(isValidDistrictIndex(entry.districtId)).toBe(true);
    });
  });

  it('hydrants/benches/trash-cans/traffic-lights/stop-signs → one propStatic entry each with a real archetype (Phase 30 T2 debt-1)', () => {
    expect(furniture.hydrants.items.length).toBeGreaterThan(0);
    furniture.hydrants.items.forEach((h, i) => {
      const entry = torontoFurnitureEntry('hydrant', h.districtId, i);
      expect(entry.kind).toBe('propStatic');
      expect(entry.archetype).toBe('hydrant');
      expect(entry.instanceId).toBe(i);
      expect(isValidDistrictIndex(entry.districtId)).toBe(true);
    });

    expect(furniture.benches.items.length).toBeGreaterThan(0);
    furniture.benches.items.forEach((b, i) => {
      const entry = torontoFurnitureEntry('bench', b.districtId, i);
      expect(entry.kind).toBe('propStatic');
      expect(entry.archetype).toBe('bench');
      expect(entry.instanceId).toBe(i);
    });

    expect(furniture.trashCans.items.length).toBeGreaterThan(0);
    furniture.trashCans.items.forEach((t, i) => {
      const entry = torontoFurnitureEntry('trashCan', t.districtId, i);
      expect(entry.kind).toBe('propStatic');
      expect(entry.archetype).toBe('trashCan');
      expect(entry.instanceId).toBe(i);
    });

    expect(furniture.trafficLights.length).toBeGreaterThan(0);
    furniture.trafficLights.forEach((m, i) => {
      const entry = torontoFurnitureEntry('trafficLight', m.districtId, i);
      expect(entry.kind).toBe('propStatic');
      expect(entry.archetype).toBe('trafficLight');
      expect(entry.instanceId).toBe(i);
    });

    expect(furniture.stopSigns.items.length).toBeGreaterThan(0);
    furniture.stopSigns.items.forEach((s, i) => {
      const entry = torontoFurnitureEntry('stopSign', s.districtId, i);
      expect(entry.kind).toBe('propStatic');
      expect(entry.archetype).toBe('stopSign');
      expect(entry.instanceId).toBe(i);
    });
  });

  it('named buildings + hero lots + places boxes → spatially-resolved building entries, real (non -1) districts', () => {
    const namedBoxes = named.placements.flatMap((p) => p.boxes);
    expect(namedBoxes.length).toBeGreaterThan(0);
    for (const box of namedBoxes) {
      const idx = torontoDistrictIndexAt(box.cx, box.cz, districts);
      expect(isValidDistrictIndex(idx)).toBe(true); // every named building sits inside a district
      expect(torontoBuildingEntryAt(idx).kind).toBe('building');
    }

    expect(HERO_LOTS.length).toBe(2);
    for (const lot of HERO_LOTS) {
      const cx = (lot.minX + lot.maxX) / 2;
      const cz = (lot.minY + lot.maxY) / 2;
      const idx = torontoDistrictIndexAt(cx, cz, districts);
      expect(isValidDistrictIndex(idx)).toBe(true);
    }

    const placeBoxes = [...places.placements.filter((p) => p.box !== null).map((p) => p.box!), places.sankofa.box];
    expect(placeBoxes.length).toBeGreaterThan(0);
    for (const box of placeBoxes) {
      const idx = torontoDistrictIndexAt(box.cx, box.cz, districts);
      expect(isValidDistrictIndex(idx)).toBe(true);
    }
  });

  it('total registrable count per layer is non-trivial (nothing silently dropped)', () => {
    const buildingCount =
      frontage.slots.length + frontage.cornerFills.length + infill.fixed.length + frontage.towerBoxes.length + infill.boxes.length;
    expect(buildingCount).toBeGreaterThan(400); // matches the ~2,700-entry scale phase-29-plan.md flags
    expect(furniture.powerBoxes.items.length).toBeGreaterThan(0);
    expect(furniture.trees.items.length).toBeGreaterThan(0);
    expect(furniture.busStops.items.length).toBeGreaterThan(0);
    expect(furniture.parked.items.length).toBeGreaterThan(0);
  });
});
