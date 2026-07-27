// Phase 36 (T1) — screen-door (ordered-dither) occlusion fade for the BATCHED + INSTANCED city.
//
// WHY THIS EXISTS. A.5's occlusion law ("any mesh between the lens and the car fades to ≤ 0.4 alpha
// within 150 ms") has, since Phase 25, only ever been enforceable on the ~18 named/hero meshes that
// own a material each: occlusionFade.ts fades `material.opacity`, which is a PER-MATERIAL value. The
// P35 crosser list proved that most of what actually crosses the boresight is per-INSTANCE geometry
// sharing one material — 35 backdrop-tower boxes + 9 tower-district back-lot boxes (one
// InstancedMesh) and the pack streetwall corners (BatchedMesh). Material opacity can't fade one
// instance of those without fading all of them, and real per-instance alpha blending would drag the
// whole streetwall out of the opaque pass (sorting + overdraw + a draw-call split).
//
// THE TECHNIQUE. Screen-door transparency: keep everything in the cheap opaque pass and `discard`
// a per-pixel fraction of fragments chosen by a 4×4 ordered (Bayer) matrix indexed by
// `gl_FragCoord`. A surface at fade f keeps ≈ f of its pixels, so the car reads through the holes.
// A.5's "≤ 0.4 alpha" is re-expressed as "≤ 0.4 pixel coverage": at FADE_MIN (0.35) this matrix
// keeps 6/16 = 0.375 of pixels — under the law with margin (see `ditherCoverage`).
//
// THE PER-INSTANCE FADE CHANNEL differs per mesh class, hence the two patch variants:
//
//   * BatchedMesh → the colors-texture ALPHA texel. Verified against three 0.185 this session:
//     `_initColorsTexture()` allocates an RGBA Float32 DataTexture `.fill(1)`, and `setColorAt`
//     writes only rgb (`color.toArray(data, id*4)`). So texel alpha is a free, already-allocated,
//     already-uploaded per-instance float — ZERO new buffers, ZERO new draw calls. The vertex
//     shader reads it back with the same `getBatchingColor(getIndirectIndex(gl_DrawID))` call the
//     stock `color_vertex` chunk uses.
//   * InstancedMesh → a per-instance `occFade` InstancedBufferAttribute (instanceColor is rgb-only,
//     so there is no free alpha lane there).
//
// THE ALPHA-CONTAMINATION CAUTION (verified in WebGLProgram.js:738): `batchingColor` forces
// `#define USE_COLOR_ALPHA` in the FRAGMENT prefix, so `color_fragment` runs `diffuseColor *= vColor`
// with vColor.a carrying our fade — i.e. the opaque pass would write sub-1 alpha into the
// framebuffer as a side effect of us using that texel. The injected fragment code therefore restores
// `diffuseColor.a` immediately after `<color_fragment>` (see FRAGMENT_MAIN's comment for why it
// restores to the `opacity` uniform rather than a literal 1.0).
//
// SCOPE: this module is the capability only — shader patchers + write helpers. No scene logic, no
// targeting, no hysteresis (T2/T3 own those), and no call site flips `occludable` on yet.
//
// MAGIC-NUMBER CARVE-OUT: the Bayer matrix entries / 4×4 tile size / 1e-3 epsilons below are shader
// implementation constants, not tunables — same carve-out as fx/cameraRig.ts's shake-noise
// constants. The one number that IS a tunable (FADE_MIN) lives in occlusionFade.ts and is consumed,
// not redefined, here.

import { InstancedBufferAttribute, type BufferGeometry, type Material } from 'three';
import type { BatchedMesh, InstancedMesh, WebGLProgramParametersWithUniforms } from 'three';

/** Name of the per-instance fade attribute the instanced variant reads. */
export const OCC_FADE_ATTRIBUTE = 'occFade' as const;

/** Fades at or above this are treated as "fully opaque" — the shader skips the dither test entirely
 * so a settled surface is bit-for-bit what it was before this module existed. */
const FADE_OPAQUE_EPSILON = 1e-3;

/**
 * The classic 4×4 ordered-dither (Bayer) matrix, row-major, values 0..15. Threshold for a pixel is
 * `(value + 0.5) / 16`, giving 16 evenly-spaced thresholds in (0, 1); a fragment survives when its
 * threshold is BELOW the surface's fade. The GLSL side stores the same values in a `mat4` (which is
 * column-major, i.e. the transpose) — a transposed Bayer matrix is still a valid ordered-dither
 * kernel (it is the same set of thresholds under a 90° tile rotation), so the two agree on coverage,
 * which is the only property the A.5 law cares about.
 */
export const BAYER_4X4: readonly number[] = [
  0, 8, 2, 10,
  12, 4, 14, 6,
  3, 11, 1, 9,
  15, 7, 13, 5,
] as const;

/** JS mirror of the shader's threshold lookup, for tests and coverage math. */
export function bayerThreshold(x: number, y: number): number {
  const ix = ((x % 4) + 4) % 4;
  const iy = ((y % 4) + 4) % 4;
  return (BAYER_4X4[iy * 4 + ix]! + 0.5) / 16;
}

/**
 * Fraction of pixels a surface at `fade` keeps under the shader's discard test — the quantized
 * reality behind the continuous fade value, and the number the A.5 law must be checked against
 * (coverage, not the nominal fade). fade ≥ 1 keeps everything (the test is skipped outright).
 */
export function ditherCoverage(fade: number): number {
  if (fade >= 1 - FADE_OPAQUE_EPSILON) return 1;
  let kept = 0;
  for (let i = 0; i < 16; i++) if ((BAYER_4X4[i]! + 0.5) / 16 < fade) kept++;
  return kept / 16;
}

// --- GLSL ---------------------------------------------------------------------------------------

/** Sentinel that makes every injection idempotent at the STRING level (a material can also be
 * re-patched across a hot-reload / clone, and three may call onBeforeCompile more than once for the
 * same source). If it is already in the source, the injectors hand the source straight back. */
const SENTINEL = 'OCC_DITHER_V1';

/** Shared pars: the varying + the threshold lookup. Injected after `#include <common>` in both
 * stages (vertex needs the varying only; the fragment needs both). */
const VARYING_DECL = `varying float vOccFade; // ${SENTINEL}`;

const FRAGMENT_PARS = `${VARYING_DECL}
const mat4 occDitherBayer = mat4(
  0.0, 8.0, 2.0, 10.0,
  12.0, 4.0, 14.0, 6.0,
  3.0, 11.0, 1.0, 9.0,
  15.0, 7.0, 13.0, 5.0 );
float occDitherThreshold( const in vec2 fragCoord ) {
  int x = int( mod( fragCoord.x, 4.0 ) );
  int y = int( mod( fragCoord.y, 4.0 ) );
  return ( occDitherBayer[ y ][ x ] + 0.5 ) / 16.0;
}`;

/** Batched vertex main: pull the fade out of the colors-texture alpha texel. Guarded so an
 * unpatched/unbatched compile context (three compiles the same material for a depth/shadow pass, or
 * a caller patches a material that is later used on a plain Mesh) still COMPILES and reads fully
 * opaque instead of erroring on the undeclared `getBatchingColor`. */
const VERTEX_MAIN_BATCHED = `vOccFade = 1.0;
#if defined( USE_BATCHING ) && defined( USE_BATCHING_COLOR )
  vOccFade = getBatchingColor( getIndirectIndex( gl_DrawID ) ).a;
#endif`;

/** Instanced vertex main. NOTE: the `occFade` attribute MUST exist on the geometry — an unbound
 * attribute reads as 0 in WebGL, which would discard every fragment (an invisible mesh, not a
 * crash). `setupInstancedFade` always creates it before patching; never call `patchInstancedFade`
 * on a material without doing the same. */
const VERTEX_MAIN_INSTANCED = `vOccFade = occFade;`;

/**
 * Shared fragment main. Two statements:
 *   1. the screen-door discard, short-circuited for settled-opaque surfaces;
 *   2. the alpha restore. `diffuseColor` starts life as `vec4( diffuse, opacity )` and the batched
 *      path's `<color_fragment>` has just multiplied our fade into its `.a` (USE_COLOR_ALPHA is
 *      forced on by `batchingColor`). Restoring to the `opacity` UNIFORM — not a literal 1.0 —
 *      undoes exactly that contamination while preserving a material that legitimately ships
 *      opacity < 1. For every material this phase patches, `opacity` is 1, so this is the mandated
 *      "never write sub-1 alpha from the opaque pass" behaviour. (Deliberate no-op on the instanced
 *      variant, which has no contamination; kept shared so the invariant holds for both.)
 */
const FRAGMENT_MAIN = `if ( vOccFade < 1.0 - ${FADE_OPAQUE_EPSILON.toExponential()} && occDitherThreshold( gl_FragCoord.xy ) >= vOccFade ) discard;
diffuseColor.a = opacity;`;

/** Injection anchors — stable three 0.185 chunk markers present in every mesh material shader
 * (meshbasic — the shipped unlit arm — as well as lambert/phong/standard, i.e. the lit A/B arm). */
const ANCHOR_COMMON = '#include <common>';
const ANCHOR_BEGIN_VERTEX = '#include <begin_vertex>';
const ANCHOR_COLOR_FRAGMENT = '#include <color_fragment>';

export type DitherVariant = 'batched' | 'instanced';

/** Pure vertex-source transform (exported for unit tests — the live path goes through the patchers). */
export function injectFadeVertex(source: string, variant: DitherVariant): string {
  if (source.includes(SENTINEL)) return source;
  const pars = variant === 'instanced' ? `attribute float ${OCC_FADE_ATTRIBUTE};\n${VARYING_DECL}` : VARYING_DECL;
  const main = variant === 'instanced' ? VERTEX_MAIN_INSTANCED : VERTEX_MAIN_BATCHED;
  return source
    .replace(ANCHOR_COMMON, `${ANCHOR_COMMON}\n${pars}`)
    .replace(ANCHOR_BEGIN_VERTEX, `${ANCHOR_BEGIN_VERTEX}\n${main}`);
}

/** Pure fragment-source transform (shared by both variants). */
export function injectFadeFragment(source: string): string {
  if (source.includes(SENTINEL)) return source;
  return source
    .replace(ANCHOR_COMMON, `${ANCHOR_COMMON}\n${FRAGMENT_PARS}`)
    .replace(ANCHOR_COLOR_FRAGMENT, `${ANCHOR_COLOR_FRAGMENT}\n${FRAGMENT_MAIN}`);
}

// --- material patching --------------------------------------------------------------------------

/** Which variant each material has been patched with. Per-material-INSTANCE (never per class): the
 * unlit arm hands out a fresh MeshBasicMaterial per model and the lit arm hands out a SHARED source
 * material, so patching must be opt-in on an object the caller owns. Callers are responsible for
 * cloning a shared material before patching (CityPackBatched does). */
const patchedVariants = new WeakMap<Material, DitherVariant>();

/** The variant a material was patched with, or undefined — exported for tests/asserts. */
export function ditherVariantOf(material: Material): DitherVariant | undefined {
  return patchedVariants.get(material);
}

function patchFade(material: Material, variant: DitherVariant): void {
  const existing = patchedVariants.get(material);
  if (existing === variant) return; // idempotent: double-patch never double-injects
  if (existing !== undefined) {
    throw new Error(`occlusionDither: material already patched as '${existing}', cannot re-patch as '${variant}'`);
  }
  patchedVariants.set(material, variant);

  // Chain rather than replace: nothing in the pack path currently sets these, but a future
  // material-level patch (palette.ts-style emissive) must not be silently dropped by this one.
  const prevCompile = material.onBeforeCompile.bind(material);
  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms, renderer): void => {
    prevCompile(shader, renderer);
    shader.vertexShader = injectFadeVertex(shader.vertexShader, variant);
    shader.fragmentShader = injectFadeFragment(shader.fragmentShader);
  };
  const prevKey = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = (): string => `${prevKey()}|${SENTINEL}-${variant}`;
  // A patched material may already have compiled (R3F attaches children before effects run); force
  // the recompile so the injection can't be skipped by the program cache.
  material.needsUpdate = true;
}

/** Patch a BatchedMesh's material: per-instance fade rides the colors-texture alpha texel. */
export function patchBatchedFade(material: Material): void {
  patchFade(material, 'batched');
}

/** Patch an InstancedMesh's material: per-instance fade rides the `occFade` attribute. The geometry
 * MUST carry that attribute (see `ensureInstancedFadeAttribute` / `setupInstancedFade`). */
export function patchInstancedFade(material: Material): void {
  patchFade(material, 'instanced');
}

// --- per-instance write helpers -------------------------------------------------------------------

/** Structural view of the private BatchedMesh field three's types don't expose. `_colorsTexture` is
 * an RGBA/FloatType DataTexture allocated lazily by `_initColorsTexture()` on the first `setColorAt`
 * — CityPackBatched always calls setColorAt while populating, but this stays null-guarded because a
 * mesh can be read between construction and populate (StrictMode double-mount). */
interface BatchedColorsHost {
  readonly _colorsTexture: { readonly image: { readonly data: Float32Array }; needsUpdate: boolean } | null;
}

/** Clamp to [0, 1] AND round to float32 — both fade channels are Float32 storage, so comparing the
 * incoming double against the stored value would report "changed" forever for any value that isn't
 * exactly representable (0.35 being the very first one the fader produces), defeating the
 * only-upload-on-change guard. */
function clampFade(fade: number): number {
  return Math.fround(fade < 0 ? 0 : fade > 1 ? 1 : fade);
}

/**
 * Write one instance's fade into the BatchedMesh colors-texture alpha texel (RGBA stride 4, so
 * `instanceId * 4 + 3`). Returns whether anything changed.
 *
 * `needsUpdate` is set on the texture per changed write, which is NOT a per-write upload: three
 * consumes the flag once at render time, so N writes in a frame still cost exactly one (tiny —
 * ceil(sqrt(maxInstances))² RGBA floats) upload. Unchanged values skip the flag entirely, so a
 * settled frame uploads nothing at all.
 */
export function setBatchedFadeAt(mesh: BatchedMesh, instanceId: number, fade: number): boolean {
  const tex = (mesh as unknown as BatchedColorsHost)._colorsTexture;
  if (tex === null) return false;
  const data = tex.image.data;
  const offset = instanceId * 4 + 3;
  if (offset < 0 || offset >= data.length) return false;
  const next = clampFade(fade);
  if (data[offset] === next) return false;
  data[offset] = next;
  tex.needsUpdate = true;
  return true;
}

/** Read back an instance's fade (1 when the colors texture doesn't exist yet) — for tests + the
 * dev stats probe. */
export function getBatchedFadeAt(mesh: BatchedMesh, instanceId: number): number {
  const tex = (mesh as unknown as BatchedColorsHost)._colorsTexture;
  if (tex === null) return 1;
  const offset = instanceId * 4 + 3;
  const data = tex.image.data;
  if (offset < 0 || offset >= data.length) return 1;
  return data[offset]!;
}

/** Create (or return) the geometry's `occFade` InstancedBufferAttribute, default-filled 1 (fully
 * opaque) so an un-touched instance renders exactly as it did before this module existed. */
export function ensureInstancedFadeAttribute(geometry: BufferGeometry, count: number): InstancedBufferAttribute {
  const existing = geometry.getAttribute(OCC_FADE_ATTRIBUTE);
  if (existing instanceof InstancedBufferAttribute && existing.count >= count) return existing;
  const attr = new InstancedBufferAttribute(new Float32Array(count).fill(1), 1);
  geometry.setAttribute(OCC_FADE_ATTRIBUTE, attr);
  return attr;
}

/** Write one instance's fade into the `occFade` attribute. Returns whether anything changed (and
 * only then flags `needsUpdate`, same one-upload-per-frame reasoning as the batched setter). */
export function setInstancedFadeAt(mesh: InstancedMesh, index: number, fade: number): boolean {
  const attr = mesh.geometry.getAttribute(OCC_FADE_ATTRIBUTE);
  if (!(attr instanceof InstancedBufferAttribute)) return false;
  if (index < 0 || index >= attr.count) return false;
  const next = clampFade(fade);
  if (attr.getX(index) === next) return false;
  attr.setX(index, next);
  attr.needsUpdate = true;
  return true;
}

/**
 * One-call instanced wiring for a populate effect: ensure the attribute exists at the mesh's
 * instance count, then patch the mesh's material(s). Ordering matters — the attribute must exist
 * before the shader that reads it ever compiles (see VERTEX_MAIN_INSTANCED's note).
 */
export function setupInstancedFade(mesh: InstancedMesh): void {
  ensureInstancedFadeAttribute(mesh.geometry, mesh.count);
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const m of materials) patchInstancedFade(m);
}
