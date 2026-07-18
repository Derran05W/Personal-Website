// Phase 24 bank-logo pixel atlas (TORONTO-MAP-SPEC-v2.md §4 + Addendum A.5), extended in
// Phase 26 with the retail/nostalgia cells from places.json (§4's "new additions needed"
// list + §8's places layer). ONE shared CanvasTexture — a 7×3 grid of 32×32 pixel-art
// HOMAGE cells (21 cells: the 5 Phase-24 bank brands + 16 Phase-26 retail/nostalgia brands,
// counting `discA`/`discB` separately for Sam the Record Man's 2-frame spin) — sampled by
// the CROWN decal quads namedBuildings.ts/TorontoScene.tsx author on the financial-cluster
// towers, and (from Phase 26) the FASCIA retail decals placesLayer.ts authors on storefront
// boxes (scene integration for those lands in the same phase this atlas grew in). NearestFilter
// both ways + mipmaps OFF (A.5's "decal textures sample with nearest-neighbour, mipmaps
// disabled") so the pixel art stays crunchy up close instead of blurring into a smear.
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
//
// KNOWN INTEGRATION POINT for whoever wires the Phase-26 FASCIA decals: TorontoScene.tsx's
// existing `makeDecalGeometry()` (CROWN decals only) remaps just the U coordinate of its
// PlaneGeometry, leaving V at the PlaneGeometry default [0,1] — correct only while every
// brand lives in row 0 (the single-row Phase-24 layout). Now that the atlas is a 7×3 grid,
// any decal consumer sampling a brand outside row 0 MUST also remap V using the `v0`/`v1`
// this module returns, or it will sample the full canvas height (all 3 rows) into one decal.
// Out of scope for this module (TorontoScene.tsx is a different file/phase task) — flagged
// here so the FASCIA scene-integration work does it correctly from the start.

import { CanvasTexture, NearestFilter, SRGBColorSpace } from 'three';

// --- Brands -------------------------------------------------------------------------------

/** The five Phase-24 bank brands (financial-cluster CROWN decals) followed by the sixteen
 * Phase-26 retail/nostalgia brands (places.json storefront FASCIA decals + the Sam the Record
 * Man rooftop-sign prop). Order is the atlas row-major cell order — stable once shipped
 * (cellUv math depends on index: `col = index % cols`, `row = floor(index / cols)`). */
export const LOGO_BRANDS = [
  // Phase 24 — bank towers (row 0, cols 0–4)
  'td',
  'rbc',
  'bmo',
  'cibc',
  'scotiabank',
  // Phase 26 — retail/nostalgia (row 0 cols 5–6, then rows 1–2)
  'arches', // McDonald's
  'tims', // Tim Hortons
  'hmart', // H Mart
  'loblaws', // Loblaws
  'warehouse', // Yonge Street Warehouse / Queen St. Warehouse
  'hangul', // Buk Chang Dong Soon Tofu (stylized, NOT a real word)
  'stag', // The Alley
  'tetsu', // Uncle Tetsu
  'konjiki', // Konjiki Ramen
  'discA', // Sam the Record Man — neon disc, spin frame A
  'discB', // Sam the Record Man — neon disc, spin frame B
  'realsports', // Real Sports Bar & Grill
  'mec', // MEC
  'recroom', // The Rec Room
  'apple', // Apple
  'alo', // Alo
] as const;

export type LogoBrand = (typeof LOGO_BRANDS)[number];

/** Atlas layout: a 7×3 grid of 32×32 cells (224×96 canvas) — 21 cells for LOGO_BRANDS.length
 * (21) brands, row-major (`col = index % cols`, `row = floor(index / cols)`). */
export const LOGO_ATLAS_LAYOUT = {
  cellSize: 32,
  cols: 7,
  rows: 3,
  get width(): number {
    return this.cellSize * this.cols;
  },
  get height(): number {
    return this.cellSize * this.rows;
  },
} as const;

/** The brand's row-major index in LOGO_BRANDS (pure — no canvas needed, safe in tests). */
export function logoCellIndex(brand: LogoBrand): number {
  const index = LOGO_BRANDS.indexOf(brand);
  if (index === -1) {
    throw new Error(`logoAtlas: unknown brand "${brand}"`);
  }
  return index;
}

/** Row/column of a cell index within the grid (row-major: fills row 0 left→right, then
 * row 1, then row 2 — matches getLogoAtlas()'s drawing loop). Internal — cellUv/getLogoAtlas
 * share this so the index→grid-position math can never drift between the two. */
function cellRowCol(index: number): { row: number; col: number } {
  return {
    col: index % LOGO_ATLAS_LAYOUT.cols,
    row: Math.floor(index / LOGO_ATLAS_LAYOUT.cols),
  };
}

/** UV rectangle for a brand's cell (pure — no canvas needed, safe in tests). `u0`/`u1` are
 * exact `col / cols` fractions. `v0`/`v1` follow world/palette.ts's `paletteCellUv` flipY
 * convention: getLogoAtlas() draws row 0 at the canvas TOP and never overrides three's
 * default `flipY = true`, which maps the top canvas row to `v → 1` — so row 0 sits at the
 * TOP of v-space (`v1 = 1`) and the last row sits at the BOTTOM (`v0 = 0`). With rows = 1
 * (the original Phase-24 shape) this collapses to the old `v0: 0, v1: 1` for every cell. */
export function logoCellUv(brand: LogoBrand): { u0: number; v0: number; u1: number; v1: number } {
  const index = logoCellIndex(brand);
  const { row, col } = cellRowCol(index);
  const u0 = col / LOGO_ATLAS_LAYOUT.cols;
  const u1 = (col + 1) / LOGO_ATLAS_LAYOUT.cols;
  const v0 = 1 - (row + 1) / LOGO_ATLAS_LAYOUT.rows;
  const v1 = 1 - row / LOGO_ATLAS_LAYOUT.rows;
  return { u0, v0, u1, v1 };
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

// --- Tiny 5×7 pixel font (reusable, glyphs limited to what these wordmarks need) --------------

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

/** Bare block-letter bitmaps, 5 wide × 7 tall, '1' = pixel on. Phase 24 shipped T D R B C M I S
 * (the five bank wordmarks). Phase 26 adds A E H L O P U W for the retail wordmarks (H MART,
 * LOBLAWS' "L", WAREHOUSE, REAL SPORTS, REC ROOM, ALO). Still not a full font, deliberately —
 * only the letters some cell actually draws. Generic pixel-art shapes, not a redrawing of any
 * particular typeface. */
const FONT_5X7: Readonly<Record<string, readonly string[]>> = {
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  W: ['10001', '10001', '10001', '10001', '10101', '11011', '10001'],
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
// slice" read — see phase-24-plan.md's logo-atlas decision), then (usually) an inset
// brand-colour plate, then the bright wordmark/glyph. Colours below are homage "families", not
// exact brand hex.

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

/** Filled circle — shared by the several Phase-26 cells that are round marks (Uncle Tetsu's
 * face, Konjiki's ring, the Apple silhouette's body, Sam's discs). */
function fillCircle(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  color: string,
): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
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

/** McDonald's — gold "M" (the golden arches, literally an M-shaped pair of arches) on red. */
function drawArches(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  fillCellBacking(ctx, x, y, size);
  const s = size - INSET * 2;
  fillChamferedRect(ctx, x + INSET, y + INSET, s, s, '#da291c', 3);
  drawPixelText(ctx, 'M', x + size / 2, y + size / 2, 2.6, '#ffc72c');
}

/** Tim Hortons — red oval/capsule band + white "T" (script-ish, simplified to the block font). */
function drawTims(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  fillCellBacking(ctx, x, y, size);
  const s = size - INSET * 2;
  fillCapsule(ctx, x + INSET, y + size / 2 - s * 0.36, s, s * 0.72, '#c8102e');
  drawPixelText(ctx, 'T', x + size / 2, y + size / 2, 2.4, '#ffffff');
}

/** H Mart — white "H MART" wordmark on red. */
function drawHmart(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  fillCellBacking(ctx, x, y, size);
  const s = size - INSET * 2;
  fillChamferedRect(ctx, x + INSET, y + INSET, s, s, '#e6002d', 2);
  drawPixelText(ctx, 'H MART', x + size / 2, y + size / 2, 0.75, '#ffffff');
}

/** Loblaws — orange stylized "L" on a light plate. */
function drawLoblaws(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  fillCellBacking(ctx, x, y, size);
  const s = size - INSET * 2;
  fillChamferedRect(ctx, x + INSET, y + INSET, s, s, '#f5f5f0', 3);
  drawPixelText(ctx, 'L', x + size / 2, y + size / 2, 3.0, '#f5821f');
}

/** Yonge Street Warehouse — white "WAREHOUSE" wordmark directly on the near-black backing,
 * condensed (small scale) to fit all nine letters in one 32px-wide line. */
function drawWarehouse(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  fillCellBacking(ctx, x, y, size);
  drawPixelText(ctx, 'WAREHOUSE', x + size / 2, y + size / 2, 0.5, '#ffffff');
}

/** Buk Chang Dong Soon Tofu — a generic red hangul-STYLE glyph block: geometric strokes that
 * evoke stacked syllable blocks, deliberately NOT a real hangul word/character. */
function drawHangul(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  fillCellBacking(ctx, x, y, size);
  const s = size - INSET * 2;
  fillChamferedRect(ctx, x + INSET, y + INSET, s, s, '#8b0000', 2);

  ctx.fillStyle = '#ffffff';
  // Abstract "block" 1 (upper-left): vertical stroke + two horizontal strokes.
  ctx.fillRect(x + size * 0.28, y + size * 0.16, 3, 11);
  ctx.fillRect(x + size * 0.28, y + size * 0.16, 11, 3);
  ctx.fillRect(x + size * 0.28, y + size * 0.24, 11, 3);
  // Abstract "block" 2 (lower-right): a circle stroke + short vertical tail.
  fillCircle(ctx, x + size * 0.68, y + size * 0.62, 4, '#ffffff');
  ctx.fillRect(x + size * 0.66, y + size * 0.68, 3, 9);
}

/** The Alley — white stag head silhouette (simple geometric antlers) on dark. */
function drawStag(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  // Slightly lighter than the pure backing so the silhouette still reads as an inset sign.
  fillCellBacking(ctx, x, y, size);
  const cx = x + size / 2;
  const topY = y + size * 0.42;

  ctx.fillStyle = '#f5f5f5';
  // Muzzle/head: a simple downward-pointing triangle.
  ctx.beginPath();
  ctx.moveTo(cx, y + size * 0.78);
  ctx.lineTo(cx - 6, topY);
  ctx.lineTo(cx + 6, topY);
  ctx.closePath();
  ctx.fill();

  // Ears.
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(cx + side * 6, topY);
    ctx.lineTo(cx + side * 11, topY - 4);
    ctx.lineTo(cx + side * 5, topY + 2);
    ctx.closePath();
    ctx.fill();
  }

  // Antlers: forked strokes above the head.
  ctx.strokeStyle = '#f5f5f5';
  ctx.lineWidth = 1.5;
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(cx + side * 4, topY);
    ctx.lineTo(cx + side * 9, y + size * 0.14);
    ctx.moveTo(cx + side * 6, topY - 3);
    ctx.lineTo(cx + side * 13, topY - 8);
    ctx.moveTo(cx + side * 6, y + size * 0.24);
    ctx.lineTo(cx + side * 12, y + size * 0.2);
    ctx.stroke();
  }
}

/** Uncle Tetsu — a round yellow smiling face. */
function drawTetsu(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  fillCellBacking(ctx, x, y, size);
  const cx = x + size / 2;
  const cy = y + size / 2;
  fillCircle(ctx, cx, cy, size * 0.34, '#f5c518');

  ctx.fillStyle = '#2a1a05';
  fillCircle(ctx, cx - 5, cy - 3, 1.6, '#2a1a05');
  fillCircle(ctx, cx + 5, cy - 3, 1.6, '#2a1a05');

  ctx.strokeStyle = '#2a1a05';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.arc(cx, cy + 1, 6, 0.15 * Math.PI, 0.85 * Math.PI);
  ctx.stroke();
}

/** Konjiki Ramen — a gold circle ring + wavy "noodle" strokes inside it. */
function drawKonjiki(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  fillCellBacking(ctx, x, y, size);
  const cx = x + size / 2;
  const cy = y + size / 2;

  ctx.strokeStyle = '#b8860b';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, size * 0.32, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = '#e8c874';
  ctx.lineWidth = 1.4;
  for (const dy of [-4, 0, 4]) {
    ctx.beginPath();
    ctx.moveTo(cx - 7, cy + dy - 2);
    ctx.quadraticCurveTo(cx, cy + dy + 3, cx + 7, cy + dy - 2);
    ctx.stroke();
  }
}

/** Shared "vinyl disc" body for Sam the Record Man's two spin frames: a dark disc + small
 * bright centre label, then `startAngles` (radians) each get a short lit rim arc — swapping
 * which angles are lit between discA/discB (offset by 45°) is what reads as "spin" when the
 * two frames alternate in-scene. */
function drawDiscFrame(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  startAngles: readonly number[],
): void {
  fillCellBacking(ctx, x, y, size);
  const cx = x + size / 2;
  const cy = y + size / 2;
  const r = size * 0.4;

  fillCircle(ctx, cx, cy, r, '#1a1a1a');
  fillCircle(ctx, cx, cy, r * 0.28, '#e8352c');

  ctx.strokeStyle = '#ff5c4d';
  ctx.lineWidth = 2.4;
  const segmentWidth = Math.PI / 8; // 22.5° lit segment per rim light
  for (const start of startAngles) {
    ctx.beginPath();
    ctx.arc(cx, cy, r - 1.5, start, start + segmentWidth);
    ctx.stroke();
  }
}

/** Sam the Record Man — spin frame A: rim segments lit at 0°/90°/180°/270°. */
function drawDiscA(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  drawDiscFrame(ctx, x, y, size, [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]);
}

/** Sam the Record Man — spin frame B: rim segments lit at 45°/135°/225°/315° (the
 * complementary offset from frame A — alternating the two frames reads as rotation). */
function drawDiscB(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  drawDiscFrame(ctx, x, y, size, [
    Math.PI / 4,
    (3 * Math.PI) / 4,
    (5 * Math.PI) / 4,
    (7 * Math.PI) / 4,
  ]);
}

/** Real Sports Bar & Grill — white "REAL" / "SPORTS" two-line wordmark on blue. */
function drawRealsports(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  fillCellBacking(ctx, x, y, size);
  const s = size - INSET * 2;
  fillChamferedRect(ctx, x + INSET, y + INSET, s, s, '#004c9b', 2);
  drawPixelText(ctx, 'REAL', x + size / 2, y + size / 2 - 6, 1.0, '#ffffff');
  drawPixelText(ctx, 'SPORTS', x + size / 2, y + size / 2 + 5, 0.7, '#ffffff');
}

/** MEC — a green mountain triangle with a small snow-cap notch. */
function drawMec(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  fillCellBacking(ctx, x, y, size);
  ctx.fillStyle = '#00674b';
  ctx.beginPath();
  ctx.moveTo(x + size * 0.5, y + size * 0.16);
  ctx.lineTo(x + size * 0.82, y + size * 0.78);
  ctx.lineTo(x + size * 0.18, y + size * 0.78);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = '#f5f5f5';
  ctx.beginPath();
  ctx.moveTo(x + size * 0.5, y + size * 0.16);
  ctx.lineTo(x + size * 0.58, y + size * 0.3);
  ctx.lineTo(x + size * 0.5, y + size * 0.34);
  ctx.lineTo(x + size * 0.42, y + size * 0.3);
  ctx.closePath();
  ctx.fill();
}

/** The Rec Room — red "REC" / "ROOM" two-line block-letter wordmark. */
function drawRecroom(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  fillCellBacking(ctx, x, y, size);
  const s = size - INSET * 2;
  fillChamferedRect(ctx, x + INSET, y + INSET, s, s, '#d22630', 2);
  drawPixelText(ctx, 'REC', x + size / 2, y + size / 2 - 6, 1.15, '#ffffff');
  drawPixelText(ctx, 'ROOM', x + size / 2, y + size / 2 + 6, 1.0, '#ffffff');
}

/** Apple — a white apple-body silhouette (two overlapping circles + a bite notch) with a
 * small leaf. */
function drawApple(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  fillCellBacking(ctx, x, y, size);
  const cx = x + size / 2;
  const cy = y + size / 2 + 2;

  fillCircle(ctx, cx - 4, cy, 8, '#f5f5f7');
  fillCircle(ctx, cx + 4, cy, 8, '#f5f5f7');
  fillCircle(ctx, cx + 9, cy - 2, 3.5, BACKING_PLATE); // bite notch

  ctx.fillStyle = '#8ad46e';
  ctx.beginPath();
  ctx.ellipse(cx + 3, cy - 10, 4, 2.2, -0.6, 0, Math.PI * 2);
  ctx.fill();
}

/** Alo — a small, deliberately understated "ALO" wordmark on a dark plaque. */
function drawAlo(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  fillCellBacking(ctx, x, y, size);
  const s = size - INSET * 2;
  fillChamferedRect(ctx, x + INSET, y + INSET, s, s, '#1e1e1e', 2);
  drawPixelText(ctx, 'ALO', x + size / 2, y + size / 2, 1.2, '#e8dcc8');
}

const BRAND_DRAWERS: Readonly<
  Record<LogoBrand, (ctx: CanvasRenderingContext2D, x: number, y: number, size: number) => void>
> = {
  td: drawTd,
  rbc: drawRbc,
  bmo: drawBmo,
  cibc: drawCibc,
  scotiabank: drawScotiabank,
  arches: drawArches,
  tims: drawTims,
  hmart: drawHmart,
  loblaws: drawLoblaws,
  warehouse: drawWarehouse,
  hangul: drawHangul,
  stag: drawStag,
  tetsu: drawTetsu,
  konjiki: drawKonjiki,
  discA: drawDiscA,
  discB: drawDiscB,
  realsports: drawRealsports,
  mec: drawMec,
  recroom: drawRecroom,
  apple: drawApple,
  alo: drawAlo,
};

// --- The shared atlas -------------------------------------------------------------------------

export interface LogoAtlas {
  readonly texture: CanvasTexture;
  cellUv(brand: LogoBrand): { u0: number; v0: number; u1: number; v1: number };
}

let cachedAtlas: LogoAtlas | null = null;

/**
 * THE one shared logo atlas (memoized singleton, built lazily on first call). Guards for
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
    const { row, col } = cellRowCol(index);
    BRAND_DRAWERS[brand](
      ctx,
      col * LOGO_ATLAS_LAYOUT.cellSize,
      row * LOGO_ATLAS_LAYOUT.cellSize,
      LOGO_ATLAS_LAYOUT.cellSize,
    );
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
