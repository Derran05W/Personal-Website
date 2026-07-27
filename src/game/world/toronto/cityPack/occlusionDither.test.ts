// Phase 36 (T1) — the screen-door occlusion-fade capability, tested where it is testable headlessly:
// the GLSL string transforms (presence, placement, idempotence), the program-cache-key divergence,
// the A.5 coverage law re-expressed in dithered pixels, and the two per-instance write helpers'
// offset math + needsUpdate discipline. The visual result is live-only (T4's evidence set).
import { describe, expect, it } from 'vitest';
import {
  BoxGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  type BatchedMesh,
  type WebGLProgramParametersWithUniforms,
  type WebGLRenderer,
} from 'three';
import { FADE_MIN } from '../occlusionFade';
import {
  BAYER_4X4,
  OCC_FADE_ATTRIBUTE,
  bayerThreshold,
  ditherCoverage,
  ditherVariantOf,
  ensureInstancedFadeAttribute,
  getBatchedFadeAt,
  injectFadeFragment,
  injectFadeVertex,
  patchBatchedFade,
  patchInstancedFade,
  setBatchedFadeAt,
  setInstancedFadeAt,
  setupInstancedFade,
} from './occlusionDither';

/** Stand-ins for three's real shader sources: only the chunk markers the injectors anchor on
 * matter, and these are the exact markers meshbasic/lambert/standard carry (three 0.185). */
const VERT = `#include <common>
#include <batching_pars_vertex>
#include <color_pars_vertex>
void main() {
	#include <color_vertex>
	#include <begin_vertex>
	#include <project_vertex>
}`;
const FRAG = `#include <common>
#include <color_pars_fragment>
void main() {
	#include <map_fragment>
	#include <color_fragment>
	#include <opaque_fragment>
}`;

/** Run a patched material's onBeforeCompile over the stand-in sources and hand back the result. */
function compile(material: MeshBasicMaterial | MeshLambertMaterial): { vertexShader: string; fragmentShader: string } {
  const shader = { vertexShader: VERT, fragmentShader: FRAG, uniforms: {} };
  material.onBeforeCompile(
    shader as unknown as WebGLProgramParametersWithUniforms,
    null as unknown as WebGLRenderer,
  );
  return shader;
}

/** Minimal structural stand-in for a populated BatchedMesh's private colors texture. */
function fakeBatchedMesh(instances: number): {
  mesh: BatchedMesh;
  texture: { image: { data: Float32Array }; needsUpdate: boolean };
} {
  const texture = { image: { data: new Float32Array(instances * 4).fill(1) }, needsUpdate: false };
  return { mesh: { _colorsTexture: texture } as unknown as BatchedMesh, texture };
}

describe('occlusionDither — Bayer matrix + A.5 coverage law', () => {
  it('is a permutation of 0..15 (a valid ordered-dither kernel)', () => {
    expect([...BAYER_4X4].sort((a, b) => a - b)).toEqual([...Array(16).keys()]);
  });

  it('thresholds tile every 4 px and stay inside (0, 1)', () => {
    expect(bayerThreshold(5, 9)).toBeCloseTo(bayerThreshold(1, 1), 12);
    expect(bayerThreshold(-3, -3)).toBeCloseTo(bayerThreshold(1, 1), 12);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        expect(bayerThreshold(x, y)).toBeGreaterThan(0);
        expect(bayerThreshold(x, y)).toBeLessThan(1);
      }
    }
  });

  it('coverage at FADE_MIN satisfies A.5 (≤ 0.4 effective alpha)', () => {
    // Quantization means the kept fraction is a multiple of 1/16 — the law must hold on the
    // QUANTIZED value, not the nominal fade. 0.35 → 6/16 = 0.375.
    expect(ditherCoverage(FADE_MIN)).toBeCloseTo(0.375, 12);
    expect(ditherCoverage(FADE_MIN)).toBeLessThanOrEqual(0.4);
  });

  it('coverage is monotonic and reaches full opacity at fade 1', () => {
    expect(ditherCoverage(1)).toBe(1);
    expect(ditherCoverage(0)).toBe(0);
    let prev = -1;
    for (let f = 0; f <= 1.0001; f += 0.05) {
      const c = ditherCoverage(f);
      expect(c).toBeGreaterThanOrEqual(prev);
      prev = c;
    }
  });
});

describe('occlusionDither — GLSL injection', () => {
  it('batched vertex reads the colors-texture alpha texel, under a compile guard', () => {
    const out = injectFadeVertex(VERT, 'batched');
    expect(out).toContain('varying float vOccFade;');
    expect(out).toContain('vOccFade = getBatchingColor( getIndirectIndex( gl_DrawID ) ).a;');
    expect(out).toContain('#if defined( USE_BATCHING ) && defined( USE_BATCHING_COLOR )');
    // Fully-opaque default so an unbatched compile context still renders normally.
    expect(out).toContain('vOccFade = 1.0;');
    // Injected AFTER its anchors (the varying is a pars-level decl; the read is in main).
    expect(out.indexOf('varying float vOccFade;')).toBeGreaterThan(out.indexOf('#include <common>'));
    expect(out.indexOf('getBatchingColor')).toBeGreaterThan(out.indexOf('#include <begin_vertex>'));
    // The batched variant must NOT declare an attribute (BatchedMesh has no per-instance attrs).
    expect(out).not.toContain(`attribute float ${OCC_FADE_ATTRIBUTE}`);
  });

  it('instanced vertex reads the occFade attribute', () => {
    const out = injectFadeVertex(VERT, 'instanced');
    expect(out).toContain(`attribute float ${OCC_FADE_ATTRIBUTE};`);
    expect(out).toContain('vOccFade = occFade;');
    expect(out).not.toContain('getBatchingColor');
  });

  it('fragment injects the Bayer test after <color_fragment> and restores alpha', () => {
    const out = injectFadeFragment(FRAG);
    expect(out).toContain('float occDitherThreshold( const in vec2 fragCoord )');
    expect(out).toContain('discard;');
    expect(out).toContain('gl_FragCoord.xy');
    // The alpha restore MUST come after <color_fragment> (that chunk is what contaminates
    // diffuseColor.a with the batching-colour alpha via USE_COLOR_ALPHA).
    expect(out.indexOf('diffuseColor.a = opacity;')).toBeGreaterThan(out.indexOf('#include <color_fragment>'));
    expect(out.indexOf('diffuseColor.a = opacity;')).toBeLessThan(out.indexOf('#include <opaque_fragment>'));
  });

  it('the discard test is skipped at fade 1 (settled surfaces are untouched)', () => {
    // String-level proof of the short-circuit: the condition is gated on vOccFade being below the
    // opaque epsilon, so a fade of 1 can never discard regardless of the threshold.
    expect(injectFadeFragment(FRAG)).toContain('if ( vOccFade < 1.0 - 1e-3 &&');
  });

  it('is idempotent — double injection never double-injects', () => {
    for (const variant of ['batched', 'instanced'] as const) {
      const once = injectFadeVertex(VERT, variant);
      expect(injectFadeVertex(once, variant)).toBe(once);
    }
    const fragOnce = injectFadeFragment(FRAG);
    expect(injectFadeFragment(fragOnce)).toBe(fragOnce);
  });
});

describe('occlusionDither — material patching', () => {
  it('patches an unlit MeshBasicMaterial (the shipped arm)', () => {
    const m = new MeshBasicMaterial();
    patchBatchedFade(m);
    expect(ditherVariantOf(m)).toBe('batched');
    const { vertexShader, fragmentShader } = compile(m);
    expect(vertexShader).toContain('vOccFade');
    expect(fragmentShader).toContain('occDitherThreshold');
  });

  it('patches a lit material too (per material object, not per class)', () => {
    const lit = new MeshLambertMaterial();
    const unpatched = new MeshLambertMaterial();
    patchInstancedFade(lit);
    expect(compile(lit).vertexShader).toContain(`attribute float ${OCC_FADE_ATTRIBUTE};`);
    // The sibling material of the SAME class is untouched.
    expect(ditherVariantOf(unpatched)).toBeUndefined();
    expect(compile(unpatched).vertexShader).toBe(VERT);
  });

  it('double-patching the same variant is a no-op (idempotent)', () => {
    const m = new MeshBasicMaterial();
    patchBatchedFade(m);
    patchBatchedFade(m);
    patchBatchedFade(m);
    const out = compile(m).vertexShader;
    expect(out.match(/varying float vOccFade;/g)).toHaveLength(1);
  });

  it('throws when a material is re-patched with the other variant', () => {
    const m = new MeshBasicMaterial();
    patchBatchedFade(m);
    expect(() => patchInstancedFade(m)).toThrow(/already patched/);
  });

  it('gives patched and unpatched materials different program cache keys', () => {
    const plain = new MeshBasicMaterial();
    const batched = new MeshBasicMaterial();
    const instanced = new MeshBasicMaterial();
    patchBatchedFade(batched);
    patchInstancedFade(instanced);
    const keys = [plain, batched, instanced].map((m) => m.customProgramCacheKey());
    expect(new Set(keys).size).toBe(3);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it('flags the material for recompile so an already-compiled program is replaced', () => {
    const m = new MeshBasicMaterial();
    const before = m.version;
    patchBatchedFade(m);
    expect(m.version).toBeGreaterThan(before);
  });
});

describe('occlusionDither — batched write helper', () => {
  it('writes the alpha texel at instanceId * 4 + 3 and leaves rgb alone', () => {
    const { mesh, texture } = fakeBatchedMesh(3);
    texture.image.data.set([0.2, 0.3, 0.4, 1], 4); // instance 1's rgb tint
    expect(setBatchedFadeAt(mesh, 1, FADE_MIN)).toBe(true);
    expect(texture.image.data[7]).toBeCloseTo(FADE_MIN, 6);
    expect([...texture.image.data.slice(4, 7)]).toEqual([0.2, 0.3, 0.4].map((v) => Math.fround(v)));
    // Neighbours untouched.
    expect(texture.image.data[3]).toBe(1);
    expect(texture.image.data[11]).toBe(1);
    expect(getBatchedFadeAt(mesh, 1)).toBeCloseTo(FADE_MIN, 6);
  });

  it('flags needsUpdate only when the value actually changed', () => {
    const { mesh, texture } = fakeBatchedMesh(2);
    expect(setBatchedFadeAt(mesh, 0, 1)).toBe(false); // already 1
    expect(texture.needsUpdate).toBe(false);
    expect(setBatchedFadeAt(mesh, 0, 0.5)).toBe(true);
    expect(texture.needsUpdate).toBe(true);
    texture.needsUpdate = false;
    expect(setBatchedFadeAt(mesh, 0, 0.5)).toBe(false); // unchanged → no upload
    expect(texture.needsUpdate).toBe(false);
  });

  it('clamps out-of-range fades and no-ops out-of-range instances', () => {
    const { mesh, texture } = fakeBatchedMesh(2);
    setBatchedFadeAt(mesh, 0, -3);
    expect(texture.image.data[3]).toBe(0);
    setBatchedFadeAt(mesh, 1, 9);
    expect(texture.image.data[7]).toBe(1);
    expect(setBatchedFadeAt(mesh, 5, 0.5)).toBe(false);
    expect(setBatchedFadeAt(mesh, -1, 0.5)).toBe(false);
  });

  it('is null-safe before the colors texture exists (pre-populate / StrictMode)', () => {
    const bare = { _colorsTexture: null } as unknown as BatchedMesh;
    expect(setBatchedFadeAt(bare, 0, FADE_MIN)).toBe(false);
    expect(getBatchedFadeAt(bare, 0)).toBe(1);
  });
});

describe('occlusionDither — instanced write helper', () => {
  const makeMesh = (count: number) => new InstancedMesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial(), count);

  it('creates the attribute default-filled 1 (nothing fades until asked)', () => {
    const mesh = makeMesh(4);
    const attr = ensureInstancedFadeAttribute(mesh.geometry, mesh.count);
    expect(attr).toBeInstanceOf(InstancedBufferAttribute);
    expect(attr.count).toBe(4);
    expect([...(attr.array as Float32Array)]).toEqual([1, 1, 1, 1]);
    // Re-running returns the SAME attribute (idempotent under a StrictMode double effect).
    expect(ensureInstancedFadeAttribute(mesh.geometry, mesh.count)).toBe(attr);
  });

  it('writes a fade, flags needsUpdate only on change, and clamps', () => {
    const mesh = makeMesh(3);
    const attr = ensureInstancedFadeAttribute(mesh.geometry, mesh.count);
    // three's BufferAttribute.needsUpdate is write-only (it bumps `version`), so the upload flag is
    // observed through the version counter.
    expect(setInstancedFadeAt(mesh, 2, FADE_MIN)).toBe(true);
    expect(attr.getX(2)).toBeCloseTo(FADE_MIN, 6);
    expect(attr.version).toBe(1);
    expect(setInstancedFadeAt(mesh, 2, FADE_MIN)).toBe(false);
    expect(attr.version).toBe(1); // unchanged → no re-upload
    expect(attr.getX(0)).toBe(1); // neighbours untouched
    setInstancedFadeAt(mesh, 0, 4);
    expect(attr.getX(0)).toBe(1);
    setInstancedFadeAt(mesh, 1, -4);
    expect(attr.getX(1)).toBe(0);
  });

  it('no-ops for out-of-range indices and for a mesh without the attribute', () => {
    const mesh = makeMesh(2);
    expect(setInstancedFadeAt(mesh, 0, 0.5)).toBe(false); // no attribute yet
    ensureInstancedFadeAttribute(mesh.geometry, mesh.count);
    expect(setInstancedFadeAt(mesh, 7, 0.5)).toBe(false);
    expect(setInstancedFadeAt(mesh, -1, 0.5)).toBe(false);
  });

  it('setupInstancedFade wires attribute + material patch in one call', () => {
    const mesh = makeMesh(5);
    setupInstancedFade(mesh);
    expect(mesh.geometry.getAttribute(OCC_FADE_ATTRIBUTE)).toBeInstanceOf(InstancedBufferAttribute);
    const material = Array.isArray(mesh.material) ? mesh.material[0]! : mesh.material;
    expect(ditherVariantOf(material)).toBe('instanced');
    // Idempotent: a second call (StrictMode) neither throws nor double-patches.
    setupInstancedFade(mesh);
    expect(setInstancedFadeAt(mesh, 4, FADE_MIN)).toBe(true);
  });
});
