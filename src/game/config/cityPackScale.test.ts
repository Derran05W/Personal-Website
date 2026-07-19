// Phase 25.5 Task 2 — cityPackScale.ts tests: CAR_REF cross-check, D9 computed examples
// pinned, full-manifest scale coverage, and colliderHalfExtents (D10) math.
import { describe, expect, it } from 'vitest';
import { CITY_PACK_MANIFEST } from '../assets/cityPackManifest';
import { VEHICLE_TUNING } from './vehicles';
import { PROP_SCALE_TARGETS } from './venueDressing';
import {
  CAR_REF,
  BUILDING_FRONTAGE_TARGET_WU,
  BUILDING_FAMILY_SCALE,
  CITY_PACK_SCALE_OVERRIDES,
  resolveCityPackScale,
  colliderHalfExtents,
  BILLBOARD_TARGET_HEIGHT_WU,
  AC_TARGET_HEIGHT_WU,
  ATM_TARGET_HEIGHT_WU,
  FIRE_EXIT_TARGET_WIDTH_WU,
  ROCK_BAND_POSTER_TARGET_HEIGHT_WU,
  BOX_TARGET_HEIGHT_WU,
  BUS_TARGET_LENGTH_WU,
} from './cityPackScale';

describe('CAR_REF — cross-check against the physics collider (config/vehicles.ts)', () => {
  it('the physics collider is narrower/shorter than the visual envelope', () => {
    expect(CAR_REF.colliderWidthWu).toBeLessThan(CAR_REF.widthWu);
    expect(CAR_REF.colliderLengthWu).toBeLessThan(CAR_REF.lengthWu);
  });

  it('colliderWidthWu/colliderLengthWu track VEHICLE_TUNING.chassis half-extents x 2', () => {
    expect(CAR_REF.colliderWidthWu).toBeCloseTo(VEHICLE_TUNING.chassis.halfWidth * 2, 6);
    expect(CAR_REF.colliderLengthWu).toBeCloseTo(VEHICLE_TUNING.chassis.halfLength * 2, 6);
  });

  it('matches the documented 1.8 m x 4.0 m collider (D9 file-header claim)', () => {
    expect(CAR_REF.colliderWidthWu).toBeCloseTo(1.8, 6);
    expect(CAR_REF.colliderLengthWu).toBeCloseTo(4.0, 6);
  });
});

describe('BUILDING_FRONTAGE_TARGET_WU — 3 car lengths (user rule)', () => {
  it('equals 3 x CAR_REF.lengthWu = 13.5', () => {
    expect(BUILDING_FRONTAGE_TARGET_WU).toBeCloseTo(13.5, 6);
    expect(BUILDING_FRONTAGE_TARGET_WU).toBe(CAR_REF.lengthWu * 3);
  });
});

describe('D9 computed examples pinned', () => {
  it('standard building family scale ~5.59 (13.5 / building-red native width)', () => {
    expect(BUILDING_FAMILY_SCALE).toBeCloseTo(5.59, 1);
  });

  it('big-building scale ~2.87 (-> ~16.3 wu tall)', () => {
    expect(CITY_PACK_SCALE_OVERRIDES['big-building']).toBeCloseTo(2.87, 1);
    const bigBuilding = CITY_PACK_MANIFEST.find((e) => e.id === 'big-building')!;
    expect(bigBuilding.nativeDims.h * CITY_PACK_SCALE_OVERRIDES['big-building']).toBeCloseTo(16.3, 0);
  });

  it('brown-building scale ~5.92', () => {
    expect(CITY_PACK_SCALE_OVERRIDES['brown-building']).toBeCloseTo(5.92, 1);
  });

  it('traffic-light scale = 1.0 (Phase 27 road-diet retune, was 1.35 provisional)', () => {
    expect(CITY_PACK_SCALE_OVERRIDES['traffic-light']).toBe(1.0);
  });

  it('bench scale = 0.9 (provisional, plan-pinned)', () => {
    expect(CITY_PACK_SCALE_OVERRIDES['bench']).toBe(0.9);
  });

  it('fire-hydrant scale ~0.0043 (-> ~1.0 wu tall)', () => {
    expect(CITY_PACK_SCALE_OVERRIDES['fire-hydrant']).toBeCloseTo(0.0043, 3);
    const hydrant = CITY_PACK_MANIFEST.find((e) => e.id === 'fire-hydrant')!;
    expect(hydrant.nativeDims.h * CITY_PACK_SCALE_OVERRIDES['fire-hydrant']).toBeCloseTo(1.0, 1);
  });

  it('tree scale ~0.016 (-> ~8.1 wu tall)', () => {
    expect(CITY_PACK_SCALE_OVERRIDES['tree']).toBeCloseTo(0.016, 3);
    const tree = CITY_PACK_MANIFEST.find((e) => e.id === 'tree')!;
    expect(tree.nativeDims.h * CITY_PACK_SCALE_OVERRIDES['tree']).toBeCloseTo(8.1, 0);
  });

  it('building-red-corner and pizza-corner reuse the family scale verbatim (narrower resulting frontage, by design)', () => {
    expect(CITY_PACK_SCALE_OVERRIDES['building-red-corner']).toBe(BUILDING_FAMILY_SCALE);
    expect(CITY_PACK_SCALE_OVERRIDES['pizza-corner']).toBe(BUILDING_FAMILY_SCALE);
    const corner = CITY_PACK_MANIFEST.find((e) => e.id === 'building-red-corner')!;
    const frontage = corner.nativeDims.w * BUILDING_FAMILY_SCALE;
    expect(frontage).toBeLessThan(BUILDING_FRONTAGE_TARGET_WU);
    expect(frontage).toBeCloseTo(7.4, 0);
  });
});

describe('Phase 25.7 (D9/T1) prop-scale overrides', () => {
  it('billboard scale -> ~4.5 wu tall', () => {
    expect(CITY_PACK_SCALE_OVERRIDES['billboard']).toBeCloseTo(BILLBOARD_TARGET_HEIGHT_WU / 670, 6);
    const billboard = CITY_PACK_MANIFEST.find((e) => e.id === 'billboard')!;
    expect(billboard.nativeDims.h * CITY_PACK_SCALE_OVERRIDES['billboard']).toBeCloseTo(4.5, 4);
  });

  it('air-conditioner scale -> ~1.0 wu tall', () => {
    const ac = CITY_PACK_MANIFEST.find((e) => e.id === 'air-conditioner')!;
    expect(ac.nativeDims.h * CITY_PACK_SCALE_OVERRIDES['air-conditioner']).toBeCloseTo(1.0, 4);
  });

  it('atm scale -> ~1.8 wu tall', () => {
    const atm = CITY_PACK_MANIFEST.find((e) => e.id === 'atm')!;
    expect(atm.nativeDims.h * CITY_PACK_SCALE_OVERRIDES['atm']).toBeCloseTo(1.8, 4);
  });

  it('fire-exit scale -> ~2.4 wu WIDE (the one width-target override in the set)', () => {
    const fireExit = CITY_PACK_MANIFEST.find((e) => e.id === 'fire-exit')!;
    expect(fireExit.nativeDims.w * CITY_PACK_SCALE_OVERRIDES['fire-exit']).toBeCloseTo(2.4, 4);
  });

  it('rock-band-poster scale -> ~2.2 wu tall', () => {
    const poster = CITY_PACK_MANIFEST.find((e) => e.id === 'rock-band-poster')!;
    expect(poster.nativeDims.h * CITY_PACK_SCALE_OVERRIDES['rock-band-poster']).toBeCloseTo(2.2, 4);
  });

  it('box scale -> ~0.6 wu tall', () => {
    const box = CITY_PACK_MANIFEST.find((e) => e.id === 'box')!;
    expect(box.nativeDims.h * CITY_PACK_SCALE_OVERRIDES['box']).toBeCloseTo(0.6, 4);
  });

  it('every override differs from what the category-default formula alone would have produced (proves each is a deliberate override, not a no-op)', () => {
    for (const id of ['billboard', 'air-conditioner', 'atm', 'fire-exit', 'rock-band-poster', 'box']) {
      const entry = CITY_PACK_MANIFEST.find((e) => e.id === id)!;
      const capped = entry.nativeDims.h > 2.5 ? 2.5 / entry.nativeDims.h : 1;
      expect(CITY_PACK_SCALE_OVERRIDES[id], id).not.toBeCloseTo(capped, 6);
    }
  });

  it('local target constants stay in sync with config/venueDressing.ts PROP_SCALE_TARGETS (kit-authoring rationale lives there; the derived factor lives here — see file header)', () => {
    expect(BILLBOARD_TARGET_HEIGHT_WU).toBe(PROP_SCALE_TARGETS.billboardHeightWu);
    expect(AC_TARGET_HEIGHT_WU).toBe(PROP_SCALE_TARGETS.airConditionerHeightWu);
    expect(ATM_TARGET_HEIGHT_WU).toBe(PROP_SCALE_TARGETS.atmHeightWu);
    expect(FIRE_EXIT_TARGET_WIDTH_WU).toBe(PROP_SCALE_TARGETS.fireExitWidthWu);
    expect(ROCK_BAND_POSTER_TARGET_HEIGHT_WU).toBe(PROP_SCALE_TARGETS.rockBandPosterHeightWu);
    expect(BOX_TARGET_HEIGHT_WU).toBe(PROP_SCALE_TARGETS.boxHeightWu);
  });
});

describe('Phase 31 (Part-8 D1/D2, T1) bus scale override', () => {
  it('bus scale -> ~10 wu long (the category-default formula would have made it sedan-length)', () => {
    const bus = CITY_PACK_MANIFEST.find((e) => e.id === 'bus')!;
    expect(CITY_PACK_SCALE_OVERRIDES['bus']).toBeCloseTo(BUS_TARGET_LENGTH_WU / bus.nativeDims.d, 6);
    expect(bus.nativeDims.d * CITY_PACK_SCALE_OVERRIDES['bus']).toBeCloseTo(BUS_TARGET_LENGTH_WU, 4);
    const longestHorizontal = Math.max(bus.nativeDims.w, bus.nativeDims.d);
    const categoryDefault = CAR_REF.lengthWu / longestHorizontal;
    expect(CITY_PACK_SCALE_OVERRIDES['bus']).not.toBeCloseTo(categoryDefault, 3);
  });

  it('resolved bus collider reads as a full-size vehicle (length > 2x a sedan)', () => {
    const half = colliderHalfExtents('bus');
    expect(half.hz * 2).toBeGreaterThan(CAR_REF.lengthWu * 2);
  });
});

describe('resolveCityPackScale — full-manifest coverage', () => {
  it('resolves a positive, finite scale for every one of the 52 manifest ids', () => {
    expect(CITY_PACK_MANIFEST.length).toBeGreaterThan(0);
    for (const entry of CITY_PACK_MANIFEST) {
      const scale = resolveCityPackScale(entry.id);
      expect(scale, entry.id).toBeGreaterThan(0);
      expect(Number.isFinite(scale), entry.id).toBe(true);
    }
  });

  it('throws for an unknown id (mirrors getCityPackModel)', () => {
    expect(() => resolveCityPackScale('not-a-real-id')).toThrow();
  });

  it('vehicle-category default maps the model onto roughly car-length scale', () => {
    // 'van' has no explicit override -> falls through to the vehicle category default.
    const scale = resolveCityPackScale('van');
    const van = CITY_PACK_MANIFEST.find((e) => e.id === 'van')!;
    const longestHorizontal = Math.max(van.nativeDims.w, van.nativeDims.d);
    expect(longestHorizontal * scale).toBeCloseTo(CAR_REF.lengthWu, 4);
  });

  it('prop-category default leaves an already-small prop unscaled (factor 1)', () => {
    // 'trash-bag-grey' is already well under PROP_DEFAULT_MAX_HEIGHT_WU and has no explicit
    // override. ('atm' had this role pre-Phase-25.7 — it now has an explicit D9/T1 override, see
    // the "Phase 25.7 (D9/T1) prop-scale overrides" describe block below.)
    expect(resolveCityPackScale('trash-bag-grey')).toBe(1);
  });

  it('prop-category default caps an oversized prop at PROP_DEFAULT_MAX_HEIGHT_WU', () => {
    // 'trash-can' has no explicit override and a native height well above the cap. ('billboard'
    // had this role pre-Phase-25.7 — it now has an explicit D9/T1 override, see below.)
    const scale = resolveCityPackScale('trash-can');
    const trashCan = CITY_PACK_MANIFEST.find((e) => e.id === 'trash-can')!;
    expect(trashCan.nativeDims.h * scale).toBeCloseTo(2.5, 4);
  });
});

describe('colliderHalfExtents — D10 pure function', () => {
  it('computes half of (native dims x resolved scale) on every axis', () => {
    const id = 'fire-hydrant';
    const entry = CITY_PACK_MANIFEST.find((e) => e.id === id)!;
    const scale = resolveCityPackScale(id);
    const half = colliderHalfExtents(id);
    expect(half.hx).toBeCloseTo((entry.nativeDims.w * scale) / 2, 6);
    expect(half.hy).toBeCloseTo((entry.nativeDims.h * scale) / 2, 6);
    expect(half.hz).toBeCloseTo((entry.nativeDims.d * scale) / 2, 6);
  });

  it('fire-hydrant collider is roughly half a metre tall (~1.0 wu full height)', () => {
    expect(colliderHalfExtents('fire-hydrant').hy).toBeCloseTo(0.5, 1);
  });

  it('produces positive half-extents on every axis for every manifest id', () => {
    for (const entry of CITY_PACK_MANIFEST) {
      const half = colliderHalfExtents(entry.id);
      expect(half.hx, entry.id).toBeGreaterThan(0);
      expect(half.hy, entry.id).toBeGreaterThan(0);
      expect(half.hz, entry.id).toBeGreaterThan(0);
    }
  });

  it('throws for an unknown id', () => {
    expect(() => colliderHalfExtents('not-a-real-id')).toThrow();
  });
});
