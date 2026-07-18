// Phase 25.6 (D13) — the "baked" city-pack geometry seam shared by the BatchedMesh renderer
// (CityPackBatched.tsx) and the parked-vehicle bodies (ParkedVehicles.tsx). The 25.5 loader
// (assets/cityPack.ts) hands back RAW quantized geometry (KHR_mesh_quantization: normalized-int
// position attributes with the de-quant transform sitting on the node `baseMatrix`) — perfect for
// InstancedMesh (which folds baseMatrix into every per-instance matrix), but a hazard for
// BatchedMesh, whose internal buffers copy the attribute types verbatim and whose per-object
// frustum bounds are computed off the geometry itself. So here we DE-QUANTIZE once per model:
// fold baseMatrix into a fresh Float32 position/normal buffer (model-space, floor near y=0). The
// result is a plain float geometry BatchedMesh ingests cleanly AND a parked <mesh> can wear with a
// single uniform scale — no baseMatrix wrangling downstream, and the quantization-choke risk the
// D13 fallback existed for simply doesn't arise.

import { useEffect, useMemo } from 'react';
import { BufferGeometry, Float32BufferAttribute, Matrix3, Vector3 } from 'three';
import { useCityPackModel } from '../../../assets/cityPack';
import { getCityPackModel } from '../../../assets/cityPackManifest';
import { resolveCityPackScale } from '../../../config/cityPackScale';
import { gradientLuminanceAt, vertexGradientActive } from '../../../config/torontoCohesion';

/** De-quantized render data for one pack model, ready for BatchedMesh / a plain scaled <mesh>. */
export interface BakedCityPackModel {
  /** Float32, model-space (baseMatrix folded in), guaranteed indexed. Owned by the caller —
   * disposed on unmount by the hook below. */
  readonly geometry: BufferGeometry;
  /** Uniform world scale (config/cityPackScale.ts). */
  readonly scale: number;
  /** World-units the model must be lifted so its own floor lands at the placement's y. */
  readonly lift: number;
}

/** Fold `baseMatrix` into a fresh Float32 geometry (position + normal + uv + index), so the
 * output carries no normalized-int attributes and no node transform. When `gradient` is true, a
 * per-vertex luminance color attribute (D4 vertex-gradient bake, config/torontoCohesion.ts) is
 * written — a vertical ramp over the baked bbox Y (floor→roof) that gives an unlit box vertical
 * form. `gradient` false (or strength 0) writes NO color attribute → byte-identical to before. */
export function bakeGeometry(
  source: BufferGeometry,
  baseMatrix: import('three').Matrix4,
  gradient = false,
): BufferGeometry {
  const pos = source.getAttribute('position');
  const count = pos.count;
  const outPos = new Float32Array(count * 3);
  const v = new Vector3();
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < count; i++) {
    v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(baseMatrix);
    outPos[i * 3] = v.x;
    outPos[i * 3 + 1] = v.y;
    outPos[i * 3 + 2] = v.z;
    if (v.y < minY) minY = v.y;
    if (v.y > maxY) maxY = v.y;
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(outPos, 3));

  // D4 vertex-gradient bake (building family only, gated by the caller). Luminance-only ramp over
  // the baked bbox Y; strength 0 skips it entirely (kill-switch → no attribute, no vertexColors).
  if (gradient && vertexGradientActive()) {
    const span = maxY - minY;
    const outCol = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const t = span > 1e-6 ? (outPos[i * 3 + 1] - minY) / span : 0;
      const lum = gradientLuminanceAt(t);
      outCol[i * 3] = lum;
      outCol[i * 3 + 1] = lum;
      outCol[i * 3 + 2] = lum;
    }
    g.setAttribute('color', new Float32BufferAttribute(outCol, 3));
  }

  const normal = source.getAttribute('normal');
  if (normal) {
    const nm = new Matrix3().getNormalMatrix(baseMatrix);
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

  // Index. BatchedMesh wants a consistent index across its geometries — guarantee one (sequential
  // if the source was non-indexed). CRITICAL: some pack models carry a node `baseMatrix` with a
  // NEGATIVE determinant (a mirror/flip on one axis). Folding that into the geometry flips every
  // triangle's handedness, so the faces end up pointing INWARD — back-face culled, invisible, while
  // still counting triangles. (The InstancedMesh path dodges this because three re-derives face
  // winding per draw.) So when the fold is a mirror, reverse each triangle's winding here to keep
  // the baked faces pointing outward.
  const flip = baseMatrix.determinant() < 0;
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

  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/** Loads a pack model and returns its de-quantized baked geometry + scale + ground lift. Suspends
 * (via useCityPackModel) until the GLB streams; the baked geometry is memoized per loaded model
 * and disposed on unmount. */
export function useBakedCityPackModel(id: string): BakedCityPackModel & { material: import('three').Material } {
  const model = useCityPackModel(id);
  const scale = resolveCityPackScale(id);
  // D4 vertex-gradient bake applies to the BUILDING FAMILY only (never furniture/vehicles/props):
  // per-category flag off the manifest, exactly the cityPackScale category seam.
  const category = getCityPackModel(id).category;
  const gradient = category === 'building' || category === 'building-blank';
  // The bake reads VERTEX_GRADIENT_BAKE at build time; a strength retune applies on the next model
  // mount / HMR reload (config mutation doesn't re-render, so it is not a useMemo dependency).
  const geometry = useMemo(
    () => bakeGeometry(model.geometry, model.baseMatrix, gradient),
    [model.geometry, model.baseMatrix, gradient],
  );
  useEffect(() => () => geometry.dispose(), [geometry]);
  const lift = useMemo(() => -(geometry.boundingBox?.min.y ?? 0) * scale, [geometry, scale]);
  return { geometry, scale, lift, material: model.material };
}
