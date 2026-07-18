// Data-level tests only (per phase-24-plan.md's risk table: jsdom has `document` but
// `canvas.getContext('2d')` returns null there, so getLogoAtlas() itself is never exercised
// here — visuals are proven by live screenshots elsewhere). Every OTHER export is pure
// data/math and is fully covered: brand list, cell-index/UV math, and the texture-config flags
// (asserted against a plain object per the plan's suggested pattern, not a real CanvasTexture).

import { NearestFilter, SRGBColorSpace } from 'three';
import { describe, expect, it } from 'vitest';
import {
  LOGO_ATLAS_LAYOUT,
  LOGO_BRANDS,
  type LogoBrand,
  type TextureLike,
  configureLogoTexture,
  logoCellIndex,
  logoCellUv,
} from './logoAtlas';

describe('LOGO_BRANDS — brand list', () => {
  it('has exactly the five Phase 24 bank brands', () => {
    expect(LOGO_BRANDS).toEqual(['td', 'rbc', 'bmo', 'cibc', 'scotiabank']);
  });

  it('is unique (no duplicate brand keys)', () => {
    expect(new Set(LOGO_BRANDS).size).toBe(LOGO_BRANDS.length);
  });
});

describe('LOGO_ATLAS_LAYOUT — atlas grid', () => {
  it('is a single row, one 32×32 cell per brand', () => {
    expect(LOGO_ATLAS_LAYOUT.cellSize).toBe(32);
    expect(LOGO_ATLAS_LAYOUT.rows).toBe(1);
    expect(LOGO_ATLAS_LAYOUT.cols).toBe(LOGO_BRANDS.length);
  });

  it('derives a 160×32 canvas (5 cols × 32px, 1 row × 32px)', () => {
    expect(LOGO_ATLAS_LAYOUT.width).toBe(160);
    expect(LOGO_ATLAS_LAYOUT.height).toBe(32);
  });
});

describe('logoCellIndex — pure, no canvas', () => {
  it('assigns each brand its stable column index, in LOGO_BRANDS order', () => {
    LOGO_BRANDS.forEach((brand, expected) => {
      expect(logoCellIndex(brand)).toBe(expected);
    });
  });

  it('td=0, rbc=1, bmo=2, cibc=3, scotiabank=4 (locked ordering)', () => {
    expect(logoCellIndex('td')).toBe(0);
    expect(logoCellIndex('rbc')).toBe(1);
    expect(logoCellIndex('bmo')).toBe(2);
    expect(logoCellIndex('cibc')).toBe(3);
    expect(logoCellIndex('scotiabank')).toBe(4);
  });

  it('throws on an unknown brand', () => {
    expect(() => logoCellIndex('unknown' as LogoBrand)).toThrow(/unknown brand/);
  });
});

describe('logoCellUv — exact fractions per index', () => {
  it('computes u0/u1 as index/cols and (index+1)/cols, v spanning the full [0,1] row', () => {
    const cols = LOGO_ATLAS_LAYOUT.cols;
    LOGO_BRANDS.forEach((brand, index) => {
      const uv = logoCellUv(brand);
      expect(uv.u0).toBeCloseTo(index / cols, 12);
      expect(uv.u1).toBeCloseTo((index + 1) / cols, 12);
      expect(uv.v0).toBe(0);
      expect(uv.v1).toBe(1);
    });
  });

  it('td (index 0) occupies u [0, 0.2]', () => {
    expect(logoCellUv('td')).toEqual({ u0: 0, v0: 0, u1: 0.2, v1: 1 });
  });

  it('scotiabank (last index) occupies u [0.8, 1]', () => {
    expect(logoCellUv('scotiabank')).toEqual({ u0: 0.8, v0: 0, u1: 1, v1: 1 });
  });

  it('cells are contiguous and non-overlapping across the whole row', () => {
    const sorted = [...LOGO_BRANDS].sort((a, b) => logoCellIndex(a) - logoCellIndex(b));
    for (let i = 1; i < sorted.length; i++) {
      expect(logoCellUv(sorted[i]).u0).toBeCloseTo(logoCellUv(sorted[i - 1]).u1, 12);
    }
    expect(logoCellUv(sorted[0]).u0).toBe(0);
    expect(logoCellUv(sorted[sorted.length - 1]).u1).toBe(1);
  });
});

describe('configureLogoTexture — "must stay crunchy" flags (A.5)', () => {
  function fakeTexture(): TextureLike {
    return {
      magFilter: -1,
      minFilter: -1,
      generateMipmaps: true,
      colorSpace: 'not-set',
      needsUpdate: false,
    };
  }

  it('sets nearest-neighbour sampling both ways', () => {
    const tex = fakeTexture();
    configureLogoTexture(tex);
    expect(tex.magFilter).toBe(NearestFilter);
    expect(tex.minFilter).toBe(NearestFilter);
  });

  it('disables mipmaps', () => {
    const tex = fakeTexture();
    configureLogoTexture(tex);
    expect(tex.generateMipmaps).toBe(false);
  });

  it('sets sRGB colour space', () => {
    const tex = fakeTexture();
    configureLogoTexture(tex);
    expect(tex.colorSpace).toBe(SRGBColorSpace);
  });

  it('marks the texture for upload', () => {
    const tex = fakeTexture();
    configureLogoTexture(tex);
    expect(tex.needsUpdate).toBe(true);
  });
});
