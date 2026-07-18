// Phase 24 bank-logo pixel atlas (TORONTO-MAP-SPEC-v2.md §4 + Addendum A.5). ONE shared
// CanvasTexture — a 5×1 grid of 32×32 pixel-art HOMAGE cells, one per bank brand — sampled by
// the CROWN decal quads namedBuildings.ts/TorontoScene.tsx author on the financial-cluster
// towers. NearestFilter both ways + mipmaps OFF (A.5's "decal textures sample with
// nearest-neighbour, mipmaps disabled") so the pixel art stays crunchy up close instead of
// blurring into a smear.
//
// These are deliberately simplified, stylized wordmark/glyph cells — never a traced or exact
// reproduction of a real mark — per CLAUDE.md's locked "Brand logos (map layer)" decision
// (user override 2026-07-17). Every brand referenced here has a matching trademark-homage
// entry in src/app/content/credits.ts (see that file's header comment for why this project's
// actual credits page is `src/app/content/credits.ts`, not `assets/credits.json`).
//
// jsdom (the test environment) has no 2D canvas context, so getLogoAtlas() — the only function
// that touches `document` — is never exercised by unit tests (see logoAtlas.test.ts). Every
// other export here (LOGO_BRANDS, LOGO_ATLAS_LAYOUT, logoCellIndex, logoCellUv,
// configureLogoTexture) is pure data/math and IS unit-tested.

import { CanvasTexture, NearestFilter, SRGBColorSpace } from 'three';

// --- Brands -------------------------------------------------------------------------------

/** The five bank brands placed on the King×Bay financial-cluster CROWN decals this phase.
 * Order is the atlas column order — stable once shipped (cellUv math depends on index). */
export const LOGO_BRANDS = ['td', 'rbc', 'bmo', 'cibc', 'scotiabank'] as const;

export type LogoBrand = (typeof LOGO_BRANDS)[number];

/** Atlas layout: a single row of LOGO_BRANDS.length 32×32 cells (5×1 grid, 160×32 canvas). */
export const LOGO_ATLAS_LAYOUT = {
  cellSize: 32,
  cols: LOGO_BRANDS.length,
  rows: 1,
  get width(): number {
    return this.cellSize * this.cols;
  },
  get height(): number {
    return this.cellSize * this.rows;
  },
} as const;

/** The brand's column index in the atlas (pure — no canvas needed, safe in tests). */
export function logoCellIndex(brand: LogoBrand): number {
  const index = LOGO_BRANDS.indexOf(brand);
  if (index === -1) {
    throw new Error(`logoAtlas: unknown brand "${brand}"`);
  }
  return index;
}

/** UV rectangle for a brand's cell (pure — no canvas needed, safe in tests). Single row, so v
 * always spans the full [0,1] texture height; u is an exact `index / cols` fraction. */
export function logoCellUv(brand: LogoBrand): { u0: number; v0: number; u1: number; v1: number } {
  const index = logoCellIndex(brand);
  const u0 = index / LOGO_ATLAS_LAYOUT.cols;
  const u1 = (index + 1) / LOGO_ATLAS_LAYOUT.cols;
  return { u0, v0: 0, u1, v1: 1 };
}

// --- Texture config (pure — testable against a plain object, no real CanvasTexture needed) --

/** The subset of three's Texture surface configureLogoTexture touches. Kept as a small
 * structural interface (not `three`'s `Texture`) so logoAtlas.test.ts can assert against a
 * plain mutable object instead of constructing a real (canvas-backed) Texture in jsdom. */
export interface TextureLike {
  magFilter: number;
  minFilter: number;
  generateMipmaps: boolean;
  colorSpace: string;
  needsUpdate: boolean;
}

/** Applies the "must stay crunchy" texture settings (spec §4 / A.5): nearest-neighbour both
 * ways, mipmaps off, sRGB colour space. Shared by getLogoAtlas() and unit-tested directly
 * against a plain object so the flags are verified without a live canvas. */
export function configureLogoTexture(tex: TextureLike): void {
  tex.magFilter = NearestFilter;
  tex.minFilter = NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = SRGBColorSpace;
  tex.needsUpdate = true;
}

// --- Tiny 5×7 pixel font (reusable, glyphs limited to what these five wordmarks need) --------

const GLYPH_W = 5;
const GLYPH_H = 7;
const BLANK_GLYPH: readonly string[] = [
  '00000',
  '00000',
  '00000',
  '00000',
  '00000',
  '00000',
  '00000',
];

/** Bare block-letter bitmaps, 5 wide × 7 tall, '1' = pixel on. Only the letters the five brand
 * wordmarks need (T D R B C M I S) — not a full font, deliberately. Generic pixel-art shapes,
 * not a redrawing of any particular typeface. */
const FONT_5X7: Readonly<Record<string, readonly string[]>> = {
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
};

function glyphFor(ch: string): readonly string[] {
  return FONT_5X7[ch] ?? BLANK_GLYPH;
}

/** Draws `text` centred on (cx, cy) at the given per-pixel `scale`, filling each "on" font
 * pixel as a `scale × scale` square block — plain fillRect calls, no anti-aliasing tricks, so
 * the result stays obviously pixel-art even before NearestFilter resamples it in-scene. */
function drawPixelText(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  cy: number,
  scale: number,
  color: string,
): void {
  const letters = text.split('');
  const gap = scale; // one blank font-pixel of space between letters
  const totalW = letters.length * GLYPH_W * scale + Math.max(0, letters.length - 1) * gap;
  const totalH = GLYPH_H * scale;
  const originX = cx - totalW / 2;
  const originY = cy - totalH / 2;

  ctx.fillStyle = color;
  let penX = originX;
  for (const ch of letters) {
    const glyph = glyphFor(ch);
    for (let row = 0; row < GLYPH_H; row++) {
      const bits = glyph[row];
      for (let col = 0; col < GLYPH_W; col++) {
        if (bits[col] === '1') {
          ctx.fillRect(penX + col * scale, originY + row * scale, scale, scale);
        }
      }
    }
    penX += GLYPH_W * scale + gap;
  }
}

// --- Cell shapes ----------------------------------------------------------------------------
// Every cell starts with a near-black backing plate (the "lit sign box against the unlit dusk
// slice" read — see phase-24-plan.md's logo-atlas decision), then an inset brand-colour plate,
// then the bright wordmark/glyph. Colours below are homage "families", not exact brand hex.

/** Near-black backing plate common to every cell — makes the inset brand plate read as a lit
 * sign against the unlit-literal slice, same trick as world/palette.ts's emissive cells. */
const BACKING_PLATE = '#0a0d12';
const INSET = 2; // px margin between the cell edge and the brand plate

function fillCellBacking(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  ctx.fillStyle = BACKING_PLATE;
  ctx.fillRect(x, y, size, size);
}

/** Pixel-art "rounded" rect: a plain fill with the four corner pixels notched off — cheap
 * chamfer that reads as rounded at 32×32 without needing bezier/arc paths. */
function fillChamferedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
  chamfer: number,
): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x + chamfer, y);
  ctx.lineTo(x + w - chamfer, y);
  ctx.lineTo(x + w, y + chamfer);
  ctx.lineTo(x + w, y + h - chamfer);
  ctx.lineTo(x + w - chamfer, y + h);
  ctx.lineTo(x + chamfer, y + h);
  ctx.lineTo(x, y + h - chamfer);
  ctx.lineTo(x, y + chamfer);
  ctx.closePath();
  ctx.fill();
}

/** Shield-ish pentagon (flat top/sides, pointed bottom) — RBC's "block" per the brief. */
function fillShield(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + w, y);
  ctx.lineTo(x + w, y + h * 0.65);
  ctx.lineTo(x + w / 2, y + h);
  ctx.lineTo(x, y + h * 0.65);
  ctx.closePath();
  ctx.fill();
}

/** Capsule / "roundel band" — full-height stadium shape (rect with semicircular ends). */
function fillCapsule(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
): void {
  const r = h / 2;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arc(x + w - r, y + r, r, -Math.PI / 2, Math.PI / 2);
  ctx.lineTo(x + r, y + h);
  ctx.arc(x + r, y + r, r, Math.PI / 2, -Math.PI / 2);
  ctx.closePath();
  ctx.fill();
}

/** TD — white "TD" on a green rounded square. */
function drawTd(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  fillCellBacking(ctx, x, y, size);
  const s = size - INSET * 2;
  fillChamferedRect(ctx, x + INSET, y + INSET, s, s, '#00a651', 5);
  drawPixelText(ctx, 'TD', x + size / 2, y + size / 2, 2.2, '#ffffff');
}

/** RBC — gold "RBC" on a dark-blue shield-ish block. */
function drawRbc(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  fillCellBacking(ctx, x, y, size);
  const s = size - INSET * 2;
  fillShield(ctx, x + INSET, y + INSET, s, s, '#0038a8');
  drawPixelText(ctx, 'RBC', x + size / 2, y + size / 2 - 1, 1.5, '#f4c542');
}

/** BMO — white "BMO" on a blue roundel/capsule band (evokes First Canadian Place). */
function drawBmo(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  fillCellBacking(ctx, x, y, size);
  const s = size - INSET * 2;
  fillCapsule(ctx, x + INSET, y + size / 2 - s * 0.32, s, s * 0.64, '#0091d4');
  drawPixelText(ctx, 'BMO', x + size / 2, y + size / 2, 1.5, '#ffffff');
}

/** CIBC — dark-red "CIBC" wordmark on a plain white plate. */
function drawCibc(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  fillCellBacking(ctx, x, y, size);
  const s = size - INSET * 2;
  fillChamferedRect(ctx, x + INSET, y + INSET, s, s, '#f5f5f5', 2);
  drawPixelText(ctx, 'CIBC', x + size / 2, y + size / 2, 1.1, '#9e1b45');
}

/** Scotiabank — white "S" + a small globe-arc glyph on red. */
function drawScotiabank(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  fillCellBacking(ctx, x, y, size);
  const s = size - INSET * 2;
  fillChamferedRect(ctx, x + INSET, y + INSET, s, s, '#ee1c2e', 2);

  drawPixelText(ctx, 'S', x + size / 2 - 5, y + size / 2, 2.6, '#ffffff');

  // A tiny globe: a circle outline with one "equator" chord — the classic Scotiabank
  // flag-and-globe device, radically simplified to something that reads at 32px.
  const gx = x + size - 10;
  const gy = y + size / 2;
  const gr = 6;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(gx, gy, gr, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(gx - gr, gy);
  ctx.lineTo(gx + gr, gy);
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(gx, gy, gr * 0.45, gr, 0, 0, Math.PI * 2);
  ctx.stroke();
}

const BRAND_DRAWERS: Readonly<
  Record<LogoBrand, (ctx: CanvasRenderingContext2D, x: number, y: number, size: number) => void>
> = {
  td: drawTd,
  rbc: drawRbc,
  bmo: drawBmo,
  cibc: drawCibc,
  scotiabank: drawScotiabank,
};

// --- The shared atlas -------------------------------------------------------------------------

export interface LogoAtlas {
  readonly texture: CanvasTexture;
  cellUv(brand: LogoBrand): { u0: number; v0: number; u1: number; v1: number };
}

let cachedAtlas: LogoAtlas | null = null;

/**
 * THE one shared bank-logo atlas (memoized singleton, built lazily on first call). Guards for
 * non-browser callers (SSR / a Node context with no `document`) with an explicit error rather
 * than an opaque ReferenceError — mirrors world/palette.ts's `ctx === null` guard. Never call
 * this from a unit test: jsdom has `document` but `getContext('2d')` returns null there, which
 * hits the same guard. Visuals are proven by live screenshots, not this function.
 */
export function getLogoAtlas(): LogoAtlas {
  if (cachedAtlas !== null) return cachedAtlas;

  if (typeof document === 'undefined') {
    throw new Error('logoAtlas: getLogoAtlas() requires a browser document (canvas 2D context)');
  }

  const canvas = document.createElement('canvas');
  canvas.width = LOGO_ATLAS_LAYOUT.width;
  canvas.height = LOGO_ATLAS_LAYOUT.height;
  const ctx = canvas.getContext('2d');
  if (ctx === null) {
    throw new Error('logoAtlas: 2D canvas context unavailable');
  }

  for (const brand of LOGO_BRANDS) {
    const index = logoCellIndex(brand);
    BRAND_DRAWERS[brand](ctx, index * LOGO_ATLAS_LAYOUT.cellSize, 0, LOGO_ATLAS_LAYOUT.cellSize);
  }

  const texture = new CanvasTexture(canvas);
  configureLogoTexture(texture);

  cachedAtlas = { texture, cellUv: logoCellUv };
  return cachedAtlas;
}

/** Dispose + drop the singleton (hard teardown, e.g. WebGL context loss). Next getLogoAtlas()
 * rebuilds it — same contract as world/palette.ts's disposeCityMaterial(). */
export function disposeLogoAtlas(): void {
  if (cachedAtlas === null) return;
  cachedAtlas.texture.dispose();
  cachedAtlas = null;
}
