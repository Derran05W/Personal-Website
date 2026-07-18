// Phase 25.6 (D13) — the per-model-type BatchedMesh renderer for the re-dressed city. Given ONE
// model id + N placements, it renders a single THREE.BatchedMesh: one draw call for every instance
// of that type AT ANY COUNT, with `perObjectFrustumCulled` so only the instances actually in the
// frustum submit triangles. That per-instance culling is the load-bearing tri-budget lever (25.6
// D9/D13): 900 frontage buildings would be ~1.3M always-rendered tris on a frustumCulled=false
// InstancedMesh, but only a fraction are ever in view at the §5.3 camera — BatchedMesh renders
// exactly those (verified live: culling OFF ≈ 1.78M tris, culling ON ≈ tens of k). Per-instance
// tint rides `setColorAt` (multiplied over the palette texture, like InstancedMesh's instanceColor
// — near-white tints subtly recolour, 0xffffff leaves it untouched).
//
// The geometry is the DE-QUANTIZED baked float geometry (cityPackBaked.ts) — baseMatrix already
// folded in — so BatchedMesh never touches normalized-int attributes (the D13-fallback hazard).
// LIFECYCLE: rendered as the R3F `<batchedMesh>` intrinsic with a ref (NOT a manually-disposed
// <primitive> — that disposes the object under StrictMode's dev double-mount while it's still being
// rendered, nulling _indirectTexture → an onBeforeRender crash). R3F owns the object: it recreates
// it from `args` whenever the placement count or material changes and disposes it on unmount, the
// same StrictMode-safe pattern CityPackInstances uses. castShadow defaults FALSE pack-wide (D14).

import { useEffect, useMemo, useRef } from 'react';
import { Color, Matrix4, Quaternion, Vector3, type BatchedMesh } from 'three';
import { toUnlit } from '../../../assets/cityPack';
import { useBakedCityPackModel } from './cityPackBaked';
import type { CityPackPlacement } from './CityPackInstances';

const Y_AXIS = new Vector3(0, 1, 0);

export interface CityPackBatchedProps {
  readonly id: string;
  readonly placements: readonly CityPackPlacement[];
  /** A/B material arm (shared `cityPackUnlit` toggle): true → unlit-literal; false → real lit. */
  readonly unlit: boolean;
  /** Pack-wide default false (D14). */
  readonly castShadow?: boolean;
}

export function CityPackBatched({ id, placements, unlit, castShadow = false }: CityPackBatchedProps) {
  const { geometry, scale, lift, material } = useBakedCityPackModel(id);

  const renderMaterial = useMemo(() => (unlit ? toUnlit(material) : material), [material, unlit]);
  useEffect(
    () => () => {
      if (renderMaterial !== material) renderMaterial.dispose();
    },
    [renderMaterial, material],
  );

  const vertexCount = geometry.getAttribute('position').count;
  const indexCount = geometry.getIndex()?.count ?? vertexCount;
  const ref = useRef<BatchedMesh>(null);

  // Populate the (R3F-owned) BatchedMesh once it exists / is recreated. `renderMaterial` is in the
  // deps because args include it — a material flip recreates the object, and this re-populates the
  // fresh one. The `instanceCount` guard makes the populate idempotent under a StrictMode double
  // effect on the same object (a fresh object has 0 instances; an already-filled one is skipped).
  useEffect(() => {
    const bm = ref.current;
    if (!bm || bm.instanceCount > 0) return;
    bm.perObjectFrustumCulled = true;
    const geometryId = bm.addGeometry(geometry);
    const m = new Matrix4();
    const q = new Quaternion();
    const t = new Vector3();
    const sv = new Vector3(scale, scale, scale);
    const c = new Color();
    for (const p of placements) {
      const instanceId = bm.addInstance(geometryId);
      q.setFromAxisAngle(Y_AXIS, p.rotationY ?? 0);
      t.set(p.position[0], p.position[1] + lift, p.position[2]);
      m.compose(t, q, sv);
      bm.setMatrixAt(instanceId, m);
      c.set(p.tint ?? 0xffffff);
      bm.setColorAt(instanceId, c);
    }
    bm.computeBoundingSphere();
  }, [geometry, scale, lift, placements, renderMaterial]);

  if (placements.length === 0) return null;
  return (
    <batchedMesh
      ref={ref}
      args={[placements.length, vertexCount, indexCount, renderMaterial]}
      castShadow={castShadow}
      frustumCulled
    />
  );
}
