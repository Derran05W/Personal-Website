// Phase 46 (Part 11) — BESPOKE NAMED-BUILDING SIGNAGE: one small CanvasTexture atlas holding the
// wordmarks that belong to individual landmarks ("UNION STATION" carved into a limestone frieze,
// "ROYAL YORK" in red rooftop neon), plus the pixel font that draws them.
//
// WHY NOT THE 32×32 LOGO ATLAS: `logoAtlas.ts`'s cells are 32 px squares — a homage MARK, sized
// for a brand glyph. A 13-character wordmark in 32 px is an illegible smear; the frieze band on
// Union's colonnade is a real architectural element and has to read as letters. This is the
// `routeBoardAtlas.ts` / rail-lands sign-texture precedent (Phase 41 / Phase 45), not a new idea:
// a wide, low cell per wordmark, drawn once, sampled by UV-sliced quads.
//
// FILTERING IS THE PHASE-41 LAW, APPLIED UP FRONT: these bands ARE minified in play (a ~1.5 wu
// letter band read from across Front Street), which is exactly the route-board defect — an unmipped
// minified pixel wordmark strobes on every camera move. So: `generateMipmaps` ON,
// NearestMipmapLinear MINIFICATION, and NearestFilter MAGNIFICATION so the near-range pixel-art
// look is untouched (config/surfaces.ts ATLAS_POLICY's `mippedText` verdict).
//
// ONE TEXTURE FOR THE WHOLE SEAM: every builder's sign quads merge into a single mesh in
// namedGeometry.ts, so the entire phase's lettering costs +1 draw call no matter how many
// landmarks eventually carry a wordmark. Adding a cell is one entry in NAMED_SIGN_ATLAS.cells.
//
// Pure except for `makeNamedSignTexture()`, which touches a canvas and is therefore called only by
// the scene layer; the cell table, the UV maths and the aspect rule stay unit-testable.

import { CanvasTexture, NearestFilter, NearestMipmapLinearFilter, SRGBColorSpace } from 'three';
import { lookForMaterial } from '../../config/torontoMaterials';

/** Every wordmark cell in the atlas. Phase 46 ships two; later landmark phases append. */
export type NamedSignCellId = 'union-frieze' | 'royal-york-neon';

/** How a cell is painted. `carved` = light incised letters on the building's own limestone (a
 * frieze, not a sign board); `neon` = a lit tube wordmark on a dark backing plate (a rooftop sign). */
export type NamedSignStyle = 'carved' | 'neon';

interface NamedSignCell {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly text: string;
  readonly style: NamedSignStyle;
}

/**
 * The atlas. Cell ASPECTS are load-bearing rather than layout convenience: a quad's height is
 * derived from its width × the cell aspect, so a squarer cell would push a frieze band through the
 * cornice above it. 256×32 (aspect 0.125) is the shape a legible wordmark takes on a long
 * classical facade; the neon cell is a little taller because a rooftop sign reads from further out.
 * Rows below y = 72 are deliberately free for the landmark phases after this one.
 */
export const NAMED_SIGN_ATLAS = {
  width: 256,
  height: 128,
  cells: {
    'union-frieze': { x: 0, y: 0, w: 256, h: 32, text: 'UNION STATION', style: 'carved' },
    'royal-york-neon': { x: 0, y: 32, w: 256, h: 40, text: 'ROYAL YORK', style: 'neon' },
  },
} as const satisfies {
  readonly width: number;
  readonly height: number;
  readonly cells: Readonly<Record<NamedSignCellId, NamedSignCell>>;
};

/**
 * UV rect for a cell. Same flipY convention as logoAtlas.logoCellUv and railLands.signCellUv: the
 * canvas's top row maps to v → 1, so a cell's pixel rect (measured from the top) inverts into
 * v-space.
 */
export function namedSignCellUv(cell: NamedSignCellId): { u0: number; v0: number; u1: number; v1: number } {
  const c = NAMED_SIGN_ATLAS.cells[cell];
  return {
    u0: c.x / NAMED_SIGN_ATLAS.width,
    u1: (c.x + c.w) / NAMED_SIGN_ATLAS.width,
    v0: 1 - (c.y + c.h) / NAMED_SIGN_ATLAS.height,
    v1: 1 - c.y / NAMED_SIGN_ATLAS.height,
  };
}

/** height / width of a cell — the ONE rule a sign quad's height is derived through. */
export function namedSignCellAspect(cell: NamedSignCellId): number {
  const c = NAMED_SIGN_ATLAS.cells[cell];
  return c.h / c.w;
}

// --- the 5×7 pixel font ---------------------------------------------------------------------------
// A COMPLETE A–Z (plus space), unlike the 12-letter subsets railLands/routeBoard carry: this atlas
// is the shared home for every future landmark wordmark, and a missing glyph that silently renders
// as a blank is the kind of defect nobody notices until a screenshot.

const GLYPH_W = 5;
const GLYPH_H = 7;

const FONT: Readonly<Record<string, readonly string[]>> = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  J: ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
};
const BLANK: readonly string[] = ['00000', '00000', '00000', '00000', '00000', '00000', '00000'];

/** Every glyph this font can draw — exported so a test can assert a cell's text is drawable. */
export const NAMED_SIGN_GLYPHS: readonly string[] = [...Object.keys(FONT), ' '];

function drawGlyph(ctx: CanvasRenderingContext2D, ch: string, x: number, y: number, scale: number): void {
  const glyph = FONT[ch] ?? BLANK;
  for (let row = 0; row < GLYPH_H; row++) {
    const bits = glyph[row];
    for (let col = 0; col < GLYPH_W; col++) {
      if (bits[col] === '1') ctx.fillRect(x + col * scale, y + row * scale, scale, scale);
    }
  }
}

/** A horizontal wordmark, centred in the cell and auto-scaled to fit. Returns the pen geometry so
 * a second pass (the carved shadow / the neon halo) can re-draw it offset by a pixel. */
function drawWord(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  cy: number,
  maxW: number,
  maxH: number,
  dx = 0,
  dy = 0,
): void {
  const letters = [...text];
  const scaleW = Math.floor(maxW / (letters.length * (GLYPH_W + 1)));
  const scale = Math.max(1, Math.min(scaleW, Math.floor(maxH / GLYPH_H)));
  const totalW = letters.length * GLYPH_W * scale + (letters.length - 1) * scale;
  let penX = cx - totalW / 2 + dx;
  const y = cy - (GLYPH_H * scale) / 2 + dy;
  for (const ch of letters) {
    if (ch !== ' ') drawGlyph(ctx, ch, penX, y, scale);
    penX += (GLYPH_W + 1) * scale;
  }
}

// --- palettes -------------------------------------------------------------------------------------
// The carved plate IS the building's own §4 limestone fill, read from config/torontoMaterials.ts —
// never a hand-copied hex, so a palette change moves the frieze with the facade it sits on.

const CARVED_PLATE = lookForMaterial('limestone').fill;
const CARVED_INK = '#e4d5ab'; // sunlit face of an incised letter
const CARVED_SHADOW = '#7f6c42'; // its shadowed lower edge — what makes it read as CARVED, not painted
const NEON_PLATE = '#141118'; // the sign's dark backing frame
const NEON_INK = '#ff4b4b'; // researcher-verified: the Royal York rooftop sign is RED neon
const NEON_GLOW = '#8c2530'; // one-pixel halo around each tube

/**
 * Bake the shared signage atlas. Called ONCE by the scene layer (canvas work — never in a pure
 * module path). Returns a texture with the Phase-41 minification policy already applied.
 */
export function makeNamedSignTexture(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = NAMED_SIGN_ATLAS.width;
  canvas.height = NAMED_SIGN_ATLAS.height;
  const tex = new CanvasTexture(canvas);
  tex.magFilter = NearestFilter;
  tex.minFilter = NearestMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = SRGBColorSpace;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    // jsdom has no 2d context; the pure cell/UV maths above is what the tests exercise.
    tex.needsUpdate = true;
    return tex;
  }
  ctx.imageSmoothingEnabled = false;
  // The whole canvas starts as limestone so an un-drawn margin around a carved cell blends into
  // the facade instead of showing a black plate edge.
  ctx.fillStyle = CARVED_PLATE;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (const id of Object.keys(NAMED_SIGN_ATLAS.cells) as NamedSignCellId[]) {
    const c = NAMED_SIGN_ATLAS.cells[id];
    const cx = c.x + c.w / 2;
    const cy = c.y + c.h / 2;
    const maxW = c.w - 12;
    const maxH = c.h - 8;
    if (c.style === 'carved') {
      ctx.fillStyle = CARVED_PLATE;
      ctx.fillRect(c.x, c.y, c.w, c.h);
      ctx.fillStyle = CARVED_SHADOW;
      drawWord(ctx, c.text, cx, cy, maxW, maxH, 1, 1);
      ctx.fillStyle = CARVED_INK;
      drawWord(ctx, c.text, cx, cy, maxW, maxH);
    } else {
      ctx.fillStyle = NEON_PLATE;
      ctx.fillRect(c.x, c.y, c.w, c.h);
      ctx.fillStyle = NEON_GLOW;
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
        drawWord(ctx, c.text, cx, cy, maxW, maxH, dx, dy);
      }
      ctx.fillStyle = NEON_INK;
      drawWord(ctx, c.text, cx, cy, maxW, maxH);
    }
  }

  tex.needsUpdate = true;
  return tex;
}
