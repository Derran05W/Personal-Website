import { describe, expect, it } from 'vitest';
import {
  buildCarVarietySequence,
  createCarVarietySequencer,
  hexToRgb,
  hsvToRgb,
  jitterColor,
  rgbToHex,
  rgbToHsv,
} from './carVariety';
import {
  CAR_VARIETY_ANTI_REPEAT_WINDOW,
  CIVILIAN_CAR_MODELS,
  SPORTS_MODEL_IDS,
  TORONTO_CAR_PALETTE,
} from '../config/carVariety';
import { createRng } from '../world/rng';

const HEX = /^#[0-9a-f]{6}$/;

describe('carVariety — colour math helpers', () => {
  it('hex ⇄ rgb round-trips', () => {
    expect(rgbToHex(...hexToRgb('#3a7fbf'))).toBe('#3a7fbf');
    expect(rgbToHex(0, 0, 0)).toBe('#000000');
    expect(rgbToHex(1, 1, 1)).toBe('#ffffff');
  });

  it('rgb ⇄ hsv round-trips (within rounding)', () => {
    for (const hex of ['#b23a30', '#35618e', '#2f6f52', '#e9eaec', '#232529']) {
      const [r, g, b] = hexToRgb(hex);
      const [h, s, v] = rgbToHsv(r, g, b);
      const [r2, g2, b2] = hsvToRgb(h, s, v);
      expect(Math.abs(r - r2)).toBeLessThan(0.01);
      expect(Math.abs(g - g2)).toBeLessThan(0.01);
      expect(Math.abs(b - b2)).toBeLessThan(0.01);
    }
  });

  it('jitterColor is deterministic in its rng and stays a valid hex', () => {
    const a = jitterColor(createRng(1).fork('j'), '#35618e');
    const b = jitterColor(createRng(1).fork('j'), '#35618e');
    expect(a).toBe(b);
    expect(a).toMatch(HEX);
    // A different rng sequence yields a (usually) different jitter.
    const c = jitterColor(createRng(2).fork('j'), '#35618e');
    expect(c).toMatch(HEX);
  });
});

describe('carVariety — determinism', () => {
  it('same seed ⇒ identical sequence; different seed ⇒ different', () => {
    const a = buildCarVarietySequence(4242, 200);
    const b = buildCarVarietySequence(4242, 200);
    expect(a).toEqual(b);
    const c = buildCarVarietySequence(4243, 200);
    expect(c).not.toEqual(a);
  });

  it('every pick is a real model id + a valid hex + a palette family', () => {
    const modelIds = new Set(CIVILIAN_CAR_MODELS.map((m) => m.id));
    const families = new Set(TORONTO_CAR_PALETTE.map((c) => c.family));
    for (const v of buildCarVarietySequence(9417, 500)) {
      expect(modelIds.has(v.modelId)).toBe(true);
      expect(v.colorHex).toMatch(HEX);
      expect(families.has(v.colorFamily)).toBe(true);
    }
  });
});

describe('carVariety — weighted distribution', () => {
  it('model frequencies approximate the configured weights', () => {
    const N = 40_000;
    const counts = new Map<string, number>();
    for (const v of buildCarVarietySequence(1, N)) counts.set(v.modelId, (counts.get(v.modelId) ?? 0) + 1);
    const total = CIVILIAN_CAR_MODELS.reduce((s, m) => s + m.weight, 0);
    for (const m of CIVILIAN_CAR_MODELS) {
      const observed = (counts.get(m.id) ?? 0) / N;
      const expected = m.weight / total;
      expect(Math.abs(observed - expected), m.id).toBeLessThan(0.03);
    }
  });

  it('white/black/grey/silver neutrals dominate (~65%) of the colour picks', () => {
    const N = 40_000;
    let neutral = 0;
    for (const v of buildCarVarietySequence(7, N)) {
      if (v.colorFamily === 'white' || v.colorFamily === 'silver' || v.colorFamily === 'grey' || v.colorFamily === 'black') {
        neutral++;
      }
    }
    expect(neutral / N).toBeGreaterThan(0.55);
    expect(neutral / N).toBeLessThan(0.78);
  });

  it('sports models pick saturated colours far more often than neutrals', () => {
    // Draw a long sequence and compare, among sports picks, saturated vs neutral colour share.
    const familyOf = new Map(TORONTO_CAR_PALETTE.map((c) => [c.family, c.saturated] as const));
    let sportsSat = 0;
    let sportsTotal = 0;
    for (const v of buildCarVarietySequence(31, 200_000)) {
      if (!SPORTS_MODEL_IDS.includes(v.modelId)) continue;
      sportsTotal++;
      if (familyOf.get(v.colorFamily)) sportsSat++;
    }
    expect(sportsTotal).toBeGreaterThan(500);
    expect(sportsSat / sportsTotal).toBeGreaterThan(0.78);
  });
});

describe('carVariety — anti-repeat window', () => {
  it('no identical (model + colour-family) within the last N picks', () => {
    for (const seed of [1, 2, 3, 416, 9417]) {
      const seq = buildCarVarietySequence(seed, 600);
      for (let i = 1; i < seq.length; i++) {
        for (let k = 1; k <= CAR_VARIETY_ANTI_REPEAT_WINDOW && i - k >= 0; k++) {
          const same = seq[i].modelId === seq[i - k].modelId && seq[i].colorFamily === seq[i - k].colorFamily;
          expect(same, `seed ${seed} pos ${i} vs ${i - k}`).toBe(false);
        }
      }
    }
  });

  it('createCarVarietySequencer yields well-formed picks and a model may repeat with a new family', () => {
    const seq = createCarVarietySequencer(createRng(5).fork('x'));
    const picks = Array.from({ length: 50 }, () => seq.next());
    for (const v of picks) expect(v.modelId.length).toBeGreaterThan(0);
    // A model repeating within the window is allowed as long as the colour family differs.
    let modelRepeatWithNewFamily = false;
    for (let i = 1; i < picks.length; i++) {
      if (picks[i].modelId === picks[i - 1].modelId && picks[i].colorFamily !== picks[i - 1].colorFamily) {
        modelRepeatWithNewFamily = true;
        break;
      }
    }
    expect(modelRepeatWithNewFamily).toBe(true);
  });
});
