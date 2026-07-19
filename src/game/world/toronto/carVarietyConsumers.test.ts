import { describe, expect, it } from 'vitest';
import { buildFurniture } from './furniture';
import { buildFrontage } from './frontage';
import { buildInfill } from './infill';
import { CIVILIAN_CAR_MODELS, NEUTRAL_BODY_SUFFIX, neutralVehicleModelId } from '../../config/carVariety';
import { getCityPackModel } from '../../assets/cityPackManifest';

const CIVILIAN_IDS = new Set(CIVILIAN_CAR_MODELS.map((m) => m.id));
const HEX = /^#[0-9a-f]{6}$/;

function baseOf(neutralId: string): string {
  return neutralId.endsWith(NEUTRAL_BODY_SUFFIX)
    ? neutralId.slice(0, -NEUTRAL_BODY_SUFFIX.length)
    : neutralId;
}

describe('carVariety consumers — street-parked cars (D4/D5)', () => {
  const furniture = buildFurniture(416);

  it('every parked car carries a NEUTRAL civilian variant id + a valid tint', () => {
    expect(furniture.parked.items.length).toBeGreaterThan(0);
    for (const car of furniture.parked.items) {
      expect(car.modelId.endsWith(NEUTRAL_BODY_SUFFIX), car.modelId).toBe(true);
      expect(CIVILIAN_IDS.has(baseOf(car.modelId)), car.modelId).toBe(true);
      expect(car.tint).toMatch(HEX);
      // The neutral variant resolves in the shipped manifest (so the renderer finds it).
      expect(() => getCityPackModel(car.modelId)).not.toThrow();
      expect(getCityPackModel(car.modelId).category).toBe('vehicle');
    }
  });

  it('is deterministic in the seed', () => {
    const again = buildFurniture(416);
    expect(again.parked.items).toEqual(furniture.parked.items);
    const other = buildFurniture(9417);
    expect(other.parked.items).not.toEqual(furniture.parked.items);
  });

  it('places ≥4 distinct models and ≥4 distinct tints across the map (variety, not uniform)', () => {
    const models = new Set(furniture.parked.items.map((c) => c.modelId));
    const tints = new Set(furniture.parked.items.map((c) => c.tint));
    expect(models.size).toBeGreaterThanOrEqual(4);
    expect(tints.size).toBeGreaterThanOrEqual(6);
  });
});

describe('carVariety consumers — parking-lot cars (D4/D5)', () => {
  it('every lot car carries a NEUTRAL civilian variant id + a valid tint', () => {
    const frontage = buildFrontage(416);
    const infill = buildInfill(416, frontage);
    const lotCars = infill.fixed.filter((f) => f.id.includes('-car-'));
    expect(lotCars.length).toBeGreaterThan(0);
    for (const car of lotCars) {
      expect(car.modelId.endsWith(NEUTRAL_BODY_SUFFIX), car.modelId).toBe(true);
      expect(CIVILIAN_IDS.has(baseOf(car.modelId)), car.modelId).toBe(true);
      expect(car.tint).toMatch(HEX);
      expect(() => getCityPackModel(car.modelId)).not.toThrow();
    }
  });
});

describe('neutralVehicleModelId', () => {
  it('maps every civilian base id to a manifest neutral variant', () => {
    for (const m of CIVILIAN_CAR_MODELS) {
      const id = neutralVehicleModelId(m.id);
      expect(id).toBe(`${m.id}${NEUTRAL_BODY_SUFFIX}`);
      expect(() => getCityPackModel(id)).not.toThrow();
    }
  });
});
