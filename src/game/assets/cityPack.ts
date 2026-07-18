// Phase 25.5 (D6/D8) — the runtime loader + material seam for the optimized city-pack GLBs.
// This is the ONE place the game reaches drei's useGLTF against a manifest URL; every consumer
// (world/toronto/cityPack/*) goes through useCityPackModel/preloadCityPack so the loader wiring
// (meshopt decoder, single-prim extraction, public/-served URLs) lives in exactly one module.
//
// Loader wiring (D4/D6): drei 10.7.7's useGLTF sets three-stdlib's MeshoptDecoder unconditionally
// (verified in node_modules/@react-three/drei/core/Gltf.js) — our GLBs are meshopt-compressed
// (EXT_meshopt_compression), so meshopt decoding needs NO CDN fetch and NO extra deps. We pass
// `useDraco=false` so drei never even instantiates a DRACOLoader (its default decoder path is a
// gstatic CDN URL — never fetched for non-draco files, but declining draco outright keeps the
// self-contained ethos airtight and provably fetch-free).
//
// Single-prim extraction (D3/D7): the D3 pipeline (palette→join) collapses every model to ONE
// primitive + ONE material with a baked palette/texture map — so each GLB yields exactly one
// mesh, and N placements of it become ONE InstancedMesh / ONE draw call (world/toronto/cityPack/
// CityPackInstances.tsx). quantize() (also D3) leaves the mesh's vertex attributes in normalized
// integer space with a de-quantization transform on the NODE, so we must NOT bake that transform
// into the (integer) geometry attributes — instead we hand the instancer the raw shared geometry
// PLUS the node's world matrix (`baseMatrix`), which it folds into every per-instance matrix. That
// keeps the quantized attributes intact (GPU dequantizes via the normalized flag) while still
// placing the model correctly.
//
// Phase 25.8 (D9) supersession note: CLAUDE.md's Phase 25.8 checklist row still reads "13 MB
// pack → Draco/lazy-load strategy so the shell stays < 150 KB and game boot stays sane" — that
// concern was already fully retired by this module + scripts/city-pack.mjs back in 25.5/25.6, not
// by anything in 25.8. The pipeline's OUTPUT (meshopt, not Draco — see the loader-wiring note
// above) is streamed from `public/` (no bundling, no CDN): 52 GLBs / 381 KB total on disk
// (verified via `du` over public/city-pack + public root GLBs), and this module's own decoder
// code adds only ~22 KB gz to the LAZY game chunk. The SHELL chunk (src/app/, paints before the
// game loads) carries none of it — `pnpm check:shell` gates that at 96.79 KB gz against a 150 KB
// budget, comfortably green. 25.8 verified these numbers again (build audit, D9c) rather than
// re-litigating them; the checklist line itself gets its wording caught up at the phase's exit.

import { useMemo } from 'react';
import { useGLTF } from '@react-three/drei';
import {
  Box3,
  Color,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  type BufferGeometry,
  type Material,
  type Object3D,
} from 'three';
import { getCityPackModel } from './cityPackManifest';

/** The single-primitive render data extracted from one optimized city-pack GLB. */
export interface CityPackModel {
  /** The model's single BufferGeometry — RAW (quantized attributes intact), shared across every
   * InstancedMesh built from this id. Never mutated or disposed here (drei owns the cache). */
  readonly geometry: BufferGeometry;
  /** The model's single source material (post-pipeline: one material with a baked palette/texture
   * `map`). Consumers render it directly (lit A/B arm) or convert it via `toUnlit` (unlit arm). */
  readonly material: Material;
  /** The mesh node's world matrix within the GLB scene (identity scene root). Folds the
   * KHR_mesh_quantization de-quant transform + any authored node transform into placement — the
   * instancer multiplies this INTO every per-instance matrix rather than baking it into the
   * (integer) geometry. */
  readonly baseMatrix: Matrix4;
  /** World-units-per-native-unit is applied by the consumer (config/cityPackScale.ts); this is the
   * native-space Y offset that lands the model's own floor at the placement's y (most models author
   * floor≈0, but a few — e.g. the bench — sit their origin mid-body). Multiply by the scale factor
   * at placement time. */
  readonly groundOffsetNative: number;
}

/** Pulls the single post-pipeline prim (geometry + material + node matrix) out of a loaded GLB
 * scene. The D3 join() guarantees exactly one drawable mesh; we take the first Mesh we find. */
function extractSingleModel(scene: Object3D): CityPackModel {
  scene.updateMatrixWorld(true);
  let mesh: Mesh | null = null;
  scene.traverse((obj) => {
    if (mesh === null && obj instanceof Mesh) mesh = obj;
  });
  if (mesh === null) {
    throw new Error('cityPack: loaded GLB scene contained no Mesh (expected one post-pipeline prim)');
  }
  // `mesh` is definitely a Mesh past the guard, but TS narrows the closure-assigned local back to
  // never/null across the traverse boundary — re-alias through a typed const to keep it lint-clean.
  const found: Mesh = mesh;
  const material = Array.isArray(found.material) ? found.material[0] : found.material;
  const baseMatrix = found.matrixWorld.clone();

  if (!found.geometry.boundingBox) found.geometry.computeBoundingBox();
  const nativeBox = new Box3().copy(found.geometry.boundingBox!).applyMatrix4(baseMatrix);

  return {
    geometry: found.geometry,
    material,
    baseMatrix,
    groundOffsetNative: -nativeBox.min.y,
  };
}

/**
 * Loads one city-pack model by manifest id and returns its single-prim render data. Suspends
 * (drei useGLTF) until the GLB streams from public/assets/city-pack/<id>.glb — mount consumers
 * under a <Suspense> boundary. `useDraco=false` → meshopt-only, provably no decoder CDN fetch.
 */
export function useCityPackModel(id: string): CityPackModel {
  const entry = getCityPackModel(id);
  const gltf = useGLTF(entry.url, false);
  // The scene identity is stable across re-renders (drei caches per URL), so this memo extracts
  // once per loaded model rather than re-traversing every render.
  return useMemo(() => extractSingleModel(gltf.scene), [gltf.scene]);
}

/** Preloads the given model ids (drei useGLTF.preload) so a consumer's first mount doesn't stall.
 * Same `useDraco=false` meshopt-only wiring as useCityPackModel. Safe to call outside React. */
export function preloadCityPack(ids: readonly string[]): void {
  for (const id of ids) {
    useGLTF.preload(getCityPackModel(id).url, false);
  }
}

/**
 * Phase 25.5 (D8) — the UNLIT A/B arm. Converts a pack material to a MeshBasicMaterial that keeps
 * the baked palette/texture `map`, base color, and vertex-color flag, with `toneMapped=false` (the
 * house unlit-literal trick — ACES at blue hour otherwise crushes low-luminance surfaces to black).
 * A fresh material each call (owned by the caller → disposed on unmount). Structural read of the
 * source (every three material carries color/map/opacity), so no MeshStandardMaterial import. */
export function toUnlit(source: Material): MeshBasicMaterial {
  const src = source as Material & {
    map?: MeshBasicMaterial['map'];
    color?: Color;
    vertexColors?: boolean;
  };
  const unlit = new MeshBasicMaterial({
    map: src.map ?? null,
    color: src.color ? src.color.clone() : new Color(0xffffff),
    vertexColors: src.vertexColors ?? false,
    transparent: source.transparent,
    opacity: source.opacity,
    alphaTest: source.alphaTest,
    side: source.side,
  });
  unlit.toneMapped = false;
  return unlit;
}
