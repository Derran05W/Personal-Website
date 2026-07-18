// Data-level tests only (per phase-24-plan.md's risk table: jsdom has `document` but
// `canvas.getContext('2d')` returns null there, so getLogoAtlas() itself is never exercised
// here — visuals are proven by live screenshots elsewhere). Every OTHER export is pure
// data/math and is fully covered: brand list, cell-index/UV math, and the texture-config flags
// (asserted against a plain object per the plan's suggested pattern, not a real CanvasTexture).
//
// Phase 26 grew the atlas from a 5×1 row of bank brands to a 7×3 grid of 21 cells (5 banks +
// 16 retail/nostalgia brands, `discA`/`discB` counted separately for Sam the Record Man's
// 2-frame spin) — the UV math below now covers both axes, matching world/palette.ts's
// row/col + flipY convention (`paletteCellUv`).

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

const EXPECTED_BRANDS = [
  'td',
  'rbc',
  'bmo',
  'cibc',
  'scotiabank',
  'arches',
  'tims',
  'hmart',
  'loblaws',
  'warehouse',
  'hangul',
  'stag',
  'tetsu',
  'konjiki',
  'discA',
  'discB',
  'realsports',
  'mec',
  'recroom',
  'apple',
  'alo',
] as const;

describe('LOGO_BRANDS — brand list', () => {
  it('has exactly the five Phase-24 bank brands followed by the sixteen Phase-26 retail/nostalgia brands', () => {
    expect(LOGO_BRANDS).toEqual(EXPECTED_BRANDS);
  });

  it('has 21 entries total', () => {
    expect(LOGO_BRANDS.length).toBe(21);
  });

  it('is unique (no duplicate brand keys)', () => {
    expect(new Set(LOGO_BRANDS).size).toBe(LOGO_BRANDS.length);
  });
});

describe('LOGO_ATLAS_LAYOUT — atlas grid', () => {
  it('is a 7×3 grid of 32×32 cells (21 cells for 21 brands)', () => {
    expect(LOGO_ATLAS_LAYOUT.cellSize).toBe(32);
    expect(LOGO_ATLAS_LAYOUT.cols).toBe(7);
    expect(LOGO_ATLAS_LAYOUT.rows).toBe(3);
    expect(LOGO_ATLAS_LAYOUT.cols * LOGO_ATLAS_LAYOUT.rows).toBe(LOGO_BRANDS.length);
  });

  it('derives a 224×96 canvas (7 cols × 32px, 3 rows × 32px)', () => {
    expect(LOGO_ATLAS_LAYOUT.width).toBe(224);
    expect(LOGO_ATLAS_LAYOUT.height).toBe(96);
  });
});

describe('logoCellIndex — pure, no canvas', () => {
  it('assigns each brand its stable row-major index, in LOGO_BRANDS order', () => {
    LOGO_BRANDS.forEach((brand, expected) => {
      expect(logoCellIndex(brand)).toBe(expected);
    });
  });

  it('td=0 .. scotiabank=4 (locked Phase-24 ordering, unchanged)', () => {
    expect(logoCellIndex('td')).toBe(0);
    expect(logoCellIndex('rbc')).toBe(1);
    expect(logoCellIndex('bmo')).toBe(2);
    expect(logoCellIndex('cibc')).toBe(3);
    expect(logoCellIndex('scotiabank')).toBe(4);
  });

  it('alo (last Phase-26 brand) is index 20', () => {
    expect(logoCellIndex('alo')).toBe(20);
  });

  it('throws on an unknown brand', () => {
    expect(() => logoCellIndex('unknown' as LogoBrand)).toThrow(/unknown brand/);
  });
});

describe('logoCellUv — exact fractions per grid position', () => {
  const { cols, rows } = LOGO_ATLAS_LAYOUT;

  it('computes u0/u1 from the column and v0/v1 from the row (flipY: row 0 → v→1)', () => {
    LOGO_BRANDS.forEach((brand, index) => {
      const col = index % cols;
      const row = Math.floor(index / cols);
      const uv = logoCellUv(brand);
      expect(uv.u0).toBeCloseTo(col / cols, 12);
      expect(uv.u1).toBeCloseTo((col + 1) / cols, 12);
      expect(uv.v0).toBeCloseTo(1 - (row + 1) / rows, 12);
      expect(uv.v1).toBeCloseTo(1 - row / rows, 12);
    });
  });

  it('td (index 0: row 0, col 0) occupies u≈[0, 1/7], v≈[2/3, 1]', () => {
    const uv = logoCellUv('td');
    expect(uv.u0).toBeCloseTo(0, 12);
    expect(uv.u1).toBeCloseTo(1 / 7, 12);
    expect(uv.v0).toBeCloseTo(2 / 3, 12);
    expect(uv.v1).toBeCloseTo(1, 12);
  });

  it('alo (index 20: row 2, col 6) occupies u≈[6/7, 1], v≈[0, 1/3]', () => {
    const uv = logoCellUv('alo');
    expect(uv.u0).toBeCloseTo(6 / 7, 12);
    expect(uv.u1).toBeCloseTo(1, 12);
    expect(uv.v0).toBeCloseTo(0, 12);
    expect(uv.v1).toBeCloseTo(1 / 3, 12);
  });

  it('cells within a row are horizontally contiguous, spanning u [0,1] end to end', () => {
    for (let row = 0; row < rows; row++) {
      const rowBrands = LOGO_BRANDS.filter((_, i) => Math.floor(i / cols) === row);
      const sorted = [...rowBrands].sort((a, b) => logoCellIndex(a) - logoCellIndex(b));
      for (let i = 1; i < sorted.length; i++) {
        expect(logoCellUv(sorted[i]).u0).toBeCloseTo(logoCellUv(sorted[i - 1]).u1, 12);
      }
      expect(logoCellUv(sorted[0]).u0).toBe(0);
      expect(logoCellUv(sorted[sorted.length - 1]).u1).toBe(1);
    }
  });

  it('rows are vertically contiguous, spanning v [0,1] end to end (row 0 at the top, v→1)', () => {
    // First brand of each row (col 0), ordered row 0 → last row.
    const firstOfRow = Array.from({ length: rows }, (_, row) => LOGO_BRANDS[row * cols]);
    for (let i = 1; i < firstOfRow.length; i++) {
      // Row i's top (v1) must equal row (i-1)'s bottom (v0) — no gaps/overlaps top to bottom.
      expect(logoCellUv(firstOfRow[i]).v1).toBeCloseTo(logoCellUv(firstOfRow[i - 1]).v0, 12);
    }
    expect(logoCellUv(firstOfRow[0]).v1).toBe(1);
    expect(logoCellUv(firstOfRow[firstOfRow.length - 1]).v0).toBe(0);
  });

  it('discA and discB (Sam the Record Man 2-frame spin) are both present and occupy distinct, non-overlapping cells', () => {
    expect(LOGO_BRANDS).toContain('discA');
    expect(LOGO_BRANDS).toContain('discB');
    expect(logoCellIndex('discA')).not.toBe(logoCellIndex('discB'));
    expect(logoCellUv('discA')).not.toEqual(logoCellUv('discB'));
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
