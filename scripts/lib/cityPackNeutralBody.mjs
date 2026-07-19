// Phase 29 T2 (D5) — the NEUTRAL-BODY variant transform for the seven civilian vehicle
// models. Consumed by scripts/city-pack.mjs (the `pnpm assets:pack` pipeline) as an optional
// pre-transform that emits `<id>-neutral.glb` alongside each `<id>.glb`. The goal: strip the
// authored body PAINT down to a light neutral grey so a plain instanceColor / material-color
// multiply at render time produces a TRUE body colour (a red base tinted blue reads blue),
// while glass / tyres / trim — already near-black or low-saturation — stay dark under the same
// multiply.
//
// This module is import-safe for a vitest run (no top-level side effects, no filesystem/network
// at import): only CIVILIAN_VEHICLE_IDS / neutralBodyId / baseBodyId are imported by the test.
// applyNeutralBody() is async and imports sharp lazily inside, so importing the pure exports
// never drags the (native) sharp dependency into a plain unit-test context.
//
// Two model classes (measured off the normalized GLBs, phase-29 T2 investigation):
//   • CLASS A — untextured, per-material baseColorFactor (car-a/car-b/suv/sports-car-a). The
//     body is ONE named material (e.g. "Blue"/"LightBlue"/"White"); every other material is a
//     glass/black/grey/light part. Recolour the body material's factor → light neutral grey.
//   • CLASS B — a baseColorTexture atlas carries the body colour (van: a saturated-blue block;
//     pickup-truck/sports-car-b: a mostly-WHITE shared atlas, already neutral). Recolour the
//     DOMINANT saturated hue cluster in the image → light neutral grey, leaving low-saturation
//     texels (windows/tyres/trim) and OTHER saturated hues (e.g. van's orange headlights)
//     untouched. A white atlas has no dominant saturated cluster, so it passes through unchanged.

export const NEUTRAL_SUFFIX = '-neutral';

/** The seven civilian vehicle model ids that get a neutral-body variant (police-car / bus /
 * bicycle / motorcycle are deliberately NOT here — pursuit units stay in-house, and the other
 * two are excluded from civilian variety per config/torontoDress.ts PARKED_MODELS). */
export const CIVILIAN_VEHICLE_IDS = [
  'car-a',
  'car-b',
  'suv',
  'van',
  'pickup-truck',
  'sports-car-a',
  'sports-car-b',
];

export function neutralBodyId(id) {
  return `${id}${NEUTRAL_SUFFIX}`;
}

/** Strip a trailing `-neutral` (for cap lookups / category resolution). Idempotent on base ids. */
export function baseBodyId(id) {
  return id.endsWith(NEUTRAL_SUFFIX) ? id.slice(0, -NEUTRAL_SUFFIX.length) : id;
}

// --- tuning (all provisional — verified numerically + live in phase 29) ----------------------
/** Target body grey (linear baseColorFactor) — light so an instanceColor tint reads at full
 * chroma (0xffffff leaves a bright silver; a saturated tint darkens it to that colour). */
const BODY_GREY_LINEAR = 0.82;
/** Atlas classification thresholds. */
const SAT_MIN = 0.35; // below this a texel is glass/tyre/trim → never recoloured
const VAL_MIN = 0.25; // near-black texels never count toward the body cluster
const HUE_BINS = 24; // 15° bins
const HUE_WINDOW_DEG = 40; // ± window around the dominant hue that gets neutralized
const MIN_CLUSTER_FRAC = 0.03; // a dominant saturated cluster under 3% of texels = "already neutral"

// Non-body material names (lowercased). A material whose name matches these — or /^material/ or
// atlas/mat — is glass/trim/lights, never the paint. Everything else is a body-paint candidate.
const NON_BODY_NAMES = new Set([
  'windows', 'window', 'black', 'grey', 'gray', 'headlight', 'headlights', 'taillight',
  'taillights', 'brakelight', 'brakelights', 'brake', 'glass', 'tire', 'tires', 'tyre', 'tyres',
  'wheel', 'wheels', 'chrome', 'trim', 'interior', 'seat', 'seats', 'plastic', 'rubber', 'metal',
  'dark',
]);

function isNonBodyName(name) {
  const n = (name || '').toLowerCase().trim();
  if (NON_BODY_NAMES.has(n)) return true;
  if (/^material($|[._-])/.test(n)) return true;
  if (n === 'atlas' || n === 'mat') return true;
  return false;
}

function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const v = max;
  const s = max === 0 ? 0 : d / max;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s, v };
}

/** Smallest absolute angular distance between two hues (degrees, 0..180). */
function hueDist(a, b) {
  let d = Math.abs(a - b) % 360;
  if (d > 180) d = 360 - d;
  return d;
}

/** Count per-material triangles across the document (indices ÷ 3, or positions ÷ 3 if
 * non-indexed). Used to pick the largest body-paint material. */
function materialTriUsage(document) {
  const usage = new Map();
  for (const mesh of document.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const m = prim.getMaterial();
      if (!m) continue;
      const idx = prim.getIndices();
      const pos = prim.getAttribute('POSITION');
      const tris = Math.floor((idx ? idx.getCount() : pos ? pos.getCount() : 0) / 3);
      usage.set(m, (usage.get(m) ?? 0) + tris);
    }
  }
  return usage;
}

/** CLASS A: recolour the single largest untextured body-paint material to light neutral grey.
 * Returns a report row. Logs loudly (and reports fallback=true) if it can't find exactly one
 * body material — the caller's signal that the preferred path did not cleanly apply. */
function neutralizeMaterials(document, id) {
  const usage = materialTriUsage(document);
  const candidates = document
    .getRoot()
    .listMaterials()
    .filter((m) => !m.getBaseColorTexture() && !isNonBodyName(m.getName()))
    .map((m) => ({ m, tris: usage.get(m) ?? 0 }))
    .sort((a, b) => b.tris - a.tris);

  if (candidates.length === 0) return { touched: [], fallback: false }; // textured model → atlas path
  if (candidates.length > 1) {
    console.warn(
      `  NEUTRAL ${id}: ${candidates.length} body-paint candidates (${candidates
        .map((c) => c.m.getName())
        .join(', ')}) — recolouring the largest ("${candidates[0].m.getName()}"), FALLBACK-flagged`,
    );
  }
  const body = candidates[0].m;
  const [, , , a] = body.getBaseColorFactor();
  body.setBaseColorFactor([BODY_GREY_LINEAR, BODY_GREY_LINEAR, BODY_GREY_LINEAR, a ?? 1]);
  return { touched: [body.getName() || '(unnamed)'], fallback: candidates.length > 1 };
}

/** CLASS B: recolour the dominant saturated hue cluster of every baseColorTexture image to a
 * light neutral grey. Returns per-texture reports. */
async function neutralizeTextures(document) {
  const sharp = (await import('sharp')).default;
  const textures = new Set();
  for (const m of document.getRoot().listMaterials()) {
    const t = m.getBaseColorTexture();
    if (t) textures.add(t);
  }
  const reports = [];
  for (const tex of textures) {
    const img = tex.getImage();
    if (!img) continue;
    const { data, info } = await sharp(Buffer.from(img))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;
    const total = width * height;

    // Hue histogram over saturated, non-dark texels.
    const bins = new Array(HUE_BINS).fill(0);
    for (let i = 0; i < data.length; i += channels) {
      const { h, s, v } = rgbToHsv(data[i], data[i + 1], data[i + 2]);
      if (s > SAT_MIN && v > VAL_MIN) bins[Math.min(HUE_BINS - 1, Math.floor(h / (360 / HUE_BINS)))]++;
    }
    let domBin = 0;
    for (let b = 1; b < HUE_BINS; b++) if (bins[b] > bins[domBin]) domBin = b;
    const domFrac = bins[domBin] / total;
    if (domFrac < MIN_CLUSTER_FRAC) {
      reports.push({ tex: tex.getName() || '(tex)', size: `${width}x${height}`, cluster: null, domFrac });
      continue; // white / near-neutral atlas → passthrough
    }
    const domHue = (domBin + 0.5) * (360 / HUE_BINS);

    let recoloured = 0;
    for (let i = 0; i < data.length; i += channels) {
      const { h, s, v } = rgbToHsv(data[i], data[i + 1], data[i + 2]);
      if (s > SAT_MIN && hueDist(h, domHue) <= HUE_WINDOW_DEG) {
        const grey = Math.max(0, Math.min(255, Math.round((0.5 * v + 0.45) * 255)));
        data[i] = grey;
        data[i + 1] = grey;
        data[i + 2] = grey;
        recoloured++;
      }
    }
    const out = await sharp(data, { raw: { width, height, channels } }).png().toBuffer();
    tex.setImage(new Uint8Array(out));
    tex.setMimeType('image/png');
    reports.push({
      tex: tex.getName() || '(tex)',
      size: `${width}x${height}`,
      cluster: `hue~${Math.round(domHue)}° (${(domFrac * 100).toFixed(0)}% texels, ${recoloured} recoloured)`,
      domFrac,
    });
  }
  return reports;
}

/**
 * The pre-transform city-pack.mjs applies (right after io.read, before dedup) to produce the
 * neutral-body variant. Mutates `document` in place. Runs BOTH paths: the material path recolours
 * an untextured body; the texture path recolours a textured body's dominant saturated cluster. A
 * given model exercises exactly one of the two (untextured vs textured body); the other is a
 * no-op. Returns a { class, touched, fallback } report the caller logs.
 */
export async function applyNeutralBody(document, id = '?') {
  const mat = neutralizeMaterials(document, id);
  const tex = await neutralizeTextures(document);
  const texRecoloured = tex.filter((r) => r.cluster !== null);
  const cls = mat.touched.length > 0 ? 'A(material)' : texRecoloured.length > 0 ? 'B(atlas)' : 'B(passthrough)';
  const touched =
    mat.touched.length > 0
      ? mat.touched.join(', ')
      : texRecoloured.length > 0
        ? texRecoloured.map((r) => `${r.tex}: ${r.cluster}`).join('; ')
        : 'none (already neutral)';
  return { class: cls, touched, fallback: mat.fallback };
}
