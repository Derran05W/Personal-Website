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
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  Matrix3,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  Vector3,
  type Material,
  type Object3D,
} from 'three';
import { getCityPackModel } from './cityPackManifest';
// Deliberately the ZERO-DEPENDENCY names module, never cityPackPlayerCar.mjs itself (which pulls
// in @gltf-transform/functions + a lazy `sharp` import, Node-only — see that file's own header).
import { PLAYER_NODE_NAMES } from '../../../scripts/lib/cityPackPlayerCarNames.mjs';

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

/**
 * Phase 31 T2 (D6) — folds `matrix` into a fresh Float32 position/normal/uv/index geometry,
 * de-quantizing the raw KHR_mesh_quantization attributes `useCityPackModel`/`useCityPackPartModel`
 * hand back. A general-purpose sibling of world/toronto/cityPack/cityPackBaked.ts's bakeGeometry
 * (same technique — that module is Toronto-specific, applying a vertex-gradient bake `vehicles/`
 * has no business depending on, so this is its own small copy rather than a cross-layer import).
 * Includes the same winding-flip fix for a mirrored (negative-determinant) `matrix`: folding a
 * mirror flips every triangle's handedness, which would otherwise back-face-cull the whole mesh.
 */
export function dequantizeGeometry(source: BufferGeometry, matrix: Matrix4): BufferGeometry {
  const pos = source.getAttribute('position');
  const count = pos.count;
  const outPos = new Float32Array(count * 3);
  const v = new Vector3();
  for (let i = 0; i < count; i++) {
    v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(matrix);
    outPos[i * 3] = v.x;
    outPos[i * 3 + 1] = v.y;
    outPos[i * 3 + 2] = v.z;
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(outPos, 3));

  const normal = source.getAttribute('normal');
  if (normal) {
    const nm = new Matrix3().getNormalMatrix(matrix);
    const outN = new Float32Array(count * 3);
    const n = new Vector3();
    for (let i = 0; i < count; i++) {
      n.set(normal.getX(i), normal.getY(i), normal.getZ(i)).applyMatrix3(nm).normalize();
      outN[i * 3] = n.x;
      outN[i * 3 + 1] = n.y;
      outN[i * 3 + 2] = n.z;
    }
    g.setAttribute('normal', new Float32BufferAttribute(outN, 3));
  }

  const uv = source.getAttribute('uv');
  if (uv) {
    const outUv = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      outUv[i * 2] = uv.getX(i);
      outUv[i * 2 + 1] = uv.getY(i);
    }
    g.setAttribute('uv', new Float32BufferAttribute(outUv, 2));
  }

  const flip = matrix.determinant() < 0;
  const idxArray: number[] = [];
  const src = source.getIndex();
  if (src) {
    const arr = src.array;
    for (let i = 0; i < arr.length; i++) idxArray.push(arr[i]);
  } else {
    for (let i = 0; i < count; i++) idxArray.push(i);
  }
  if (flip) {
    for (let i = 0; i + 2 < idxArray.length; i += 3) {
      const tmp = idxArray[i + 1];
      idxArray[i + 1] = idxArray[i + 2];
      idxArray[i + 2] = tmp;
    }
  }
  g.setIndex(idxArray);

  // The city-pack pipeline strips NORMAL/TANGENT from every model (scripts/city-pack.mjs's
  // stripNormalsForUnlitPipeline — the whole pack renders unlit elsewhere in the game, so normals
  // are pointless dead weight there). The player car renders LIT (flatShading, same convention as
  // every other player-car mesh) and has no baked normal to fold, so compute one fresh from the
  // final triangle data whenever the source had none — cheap (one pass, done once per mount) and
  // avoids depending on any WebGL missing-vertex-attribute fallback behaviour.
  if (!normal) g.computeVertexNormals();
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/** One named part (body or a wheel) of a `-player` variant GLB — raw quantized geometry +
 * material + the mesh node's world matrix (baseMatrix), same shape as CityPackModel/
 * extractSingleModel above. */
export interface PlayerCarPackPart {
  readonly geometry: BufferGeometry;
  readonly material: Material;
  readonly baseMatrix: Matrix4;
}

/** The full extracted `-player` variant: a body (every model has one) and up to 3 wheel parts.
 * The wheel fields are null for a model with no separable wheel geometry (documented fallback —
 * currently only 'bus'; scripts/lib/cityPackPlayerCar.mjs's file header). */
export interface PlayerCarPackModel {
  readonly body: PlayerCarPackPart;
  readonly wheelFrontLeft: PlayerCarPackPart | null;
  readonly wheelFrontRight: PlayerCarPackPart | null;
  readonly wheelRear: PlayerCarPackPart | null;
}

function extractNamedPart(mesh: Mesh): PlayerCarPackPart {
  const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  return { geometry: mesh.geometry, material, baseMatrix: mesh.matrixWorld.clone() };
}

/**
 * Resolves a canonical part name to its Mesh. A glTF node whose mesh has exactly one primitive
 * loads as a single three.js Mesh named after the node — the common case. A node whose mesh has
 * MORE than one primitive (pickup-truck-player/sports-car-b-player's 2-material body — the D3
 * pipeline's `palette({min: 2})` floor keeps at least 2 distinct materials, so join({keepMeshes:
 * true}) can't fully merge those two into one) loads as a three.js Group named after the node,
 * with per-primitive Mesh CHILDREN named "<node>_1"/"<node>_2" — MEASURED empirically (a
 * "player-car GLB scene had no body mesh" runtime crash on exactly these two ids, headless-proof
 * during this task). Takes the Group's first Mesh child in that case — the same "first material
 * wins" simplification extractSingleModel above already applies to any multi-material single-mesh
 * pack model (`Array.isArray(found.material) ? found.material[0] : found.material`), so a player
 * car's body behaves identically to every other pack vehicle already shipped with this trait
 * (pickup-truck/sports-car-b's BASE ids have the same 2-material body and the same simplification).
 */
function resolveNamedMesh(scene: Object3D, name: string): Mesh | null {
  let found: Object3D | null = null;
  scene.traverse((obj) => {
    if (found === null && obj.name === name && (obj instanceof Mesh || obj instanceof Group)) found = obj;
  });
  if (found === null) return null;
  const obj: Object3D = found;
  if (obj instanceof Mesh) return obj;
  for (const child of obj.children) {
    if (child instanceof Mesh) return child;
  }
  return null;
}

/**
 * Extracts a `-player` variant GLB's named parts (scripts/lib/cityPackPlayerCar.mjs's pipeline
 * output: nodes named 'body' / 'wheel-front-left' / 'wheel-front-right' / 'wheel-rear'). Unlike
 * extractSingleModel (which grabs the first Mesh it finds — correct for the single-prim, join()'d
 * outputs every other pack model produces), a player-car variant is DELIBERATELY multi-mesh, so
 * this looks each part up by its exact canonical name instead (see resolveNamedMesh for the
 * Group-wrapping wrinkle a multi-material body introduces).
 */
function extractPlayerCarModel(scene: Object3D): PlayerCarPackModel {
  scene.updateMatrixWorld(true);

  const bodyMesh = resolveNamedMesh(scene, PLAYER_NODE_NAMES.body);
  if (!bodyMesh) {
    throw new Error(`cityPack: player-car GLB scene had no "${PLAYER_NODE_NAMES.body}" mesh`);
  }

  const wheelFrontLeftMesh = resolveNamedMesh(scene, PLAYER_NODE_NAMES.wheelFrontLeft);
  const wheelFrontRightMesh = resolveNamedMesh(scene, PLAYER_NODE_NAMES.wheelFrontRight);
  const wheelRearMesh = resolveNamedMesh(scene, PLAYER_NODE_NAMES.wheelRear);

  return {
    body: extractNamedPart(bodyMesh),
    wheelFrontLeft: wheelFrontLeftMesh ? extractNamedPart(wheelFrontLeftMesh) : null,
    wheelFrontRight: wheelFrontRightMesh ? extractNamedPart(wheelFrontRightMesh) : null,
    wheelRear: wheelRearMesh ? extractNamedPart(wheelRearMesh) : null,
  };
}

/**
 * Loads one `-player` variant city-pack model by manifest id (e.g. 'car-a-player') and returns
 * its named parts. Suspends (drei useGLTF) exactly like useCityPackModel — mount consumers under
 * a <Suspense> boundary. Same `useDraco=false` meshopt-only wiring.
 */
export function usePlayerCarPackModel(id: string): PlayerCarPackModel {
  const entry = getCityPackModel(id);
  const gltf = useGLTF(entry.url, false);
  return useMemo(() => extractPlayerCarModel(gltf.scene), [gltf.scene]);
}

/**
 * Folds a part's baseMatrix into world-space float geometry, EXCLUDING the translation component
 * (rotation + scale only — a zero-translation Matrix4). Used for wheel parts: the pipeline
 * (cityPackPlayerCar.mjs) already recentred each wheel node so its hub sits at the local origin;
 * baking translation back in here would undo that and break the runtime's ability to layer a
 * per-frame spin rotation.x on top. Body parts use `dequantizeGeometry(part.geometry,
 * part.baseMatrix)` directly instead (the full matrix — a body has no pivot to preserve).
 */
export function dequantizeWheelGeometry(part: PlayerCarPackPart): BufferGeometry {
  const position = new Vector3();
  const quaternion = new Quaternion();
  const scale = new Vector3();
  part.baseMatrix.decompose(position, quaternion, scale);
  const rotateScaleOnly = new Matrix4().compose(new Vector3(0, 0, 0), quaternion, scale);
  return dequantizeGeometry(part.geometry, rotateScaleOnly);
}
