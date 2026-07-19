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
  /** Phase 30 (T2 debt-1): optional handle-registration callback, called with the live
   * BatchedMesh once its instances are populated, and again with `null` on teardown/repopulate
   * (material flip, placement-count change, unmount). Opt-in — only StreetFurniture's
   * launchable categories pass this (see cityPack/batchedRegistry.ts's header for why it isn't
   * automatic for every CityPackBatched call site). */
  readonly onMesh?: (mesh: BatchedMesh | null) => void;
}

export function CityPackBatched({ id, placements, unlit, castShadow = false, onMesh }: CityPackBatchedProps) {
  const { geometry, scale, lift, material } = useBakedCityPackModel(id);

  // D4 vertex-gradient bake: the baked geometry carries a per-vertex luminance `color` attribute
  // ONLY for the building family (cityPackBaked.ts). `toUnlit` copies vertexColors from the source
  // (which has none), so the render material needs vertexColors flipped ON when the geometry carries
  // the attribute — the ramp then multiplies over the palette texture + per-instance tint. The flag
  // is baked into the material AT CREATION (never mutated post-hook): the unlit arm's toUnlit result
  // is fresh, and the lit arm clones only when it must flip (never mutating the shared source).
  const hasVertexColor = geometry.getAttribute('color') !== undefined;
  const renderMaterial = useMemo(() => {
    if (unlit) {
      const m = toUnlit(material);
      m.vertexColors = hasVertexColor;
      return m;
    }
    if (material.vertexColors !== hasVertexColor) {
      const m = material.clone();
      m.vertexColors = hasVertexColor;
      return m;
    }
    return material;
  }, [material, unlit, hasVertexColor]);
  useEffect(
    () => () => {
      if (renderMaterial !== material) renderMaterial.dispose();
    },
    [renderMaterial, material],
  );

  const vertexCount = geometry.getAttribute('position').count;
  const indexCount = geometry.getIndex()?.count ?? vertexCount;
  const ref = useRef<BatchedMesh>(null);

  // Latest-ref indirection for `onMesh` (Phase 30 T2 debt-1): the populate effect below must NOT
  // depend on onMesh's identity — a caller passing an inline arrow (StreetFurniture does, one per
  // furniture category) gets a NEW function every render, and if that were a dependency the effect
  // would re-run, hit the `instanceCount > 0` early return (already populated), and skip straight
  // past the `onMesh?.(bm)` call below without ever re-registering — a real prop, permanently
  // orphaned from the batched registry after the first parent re-render. Reading through a ref
  // keeps registration tied ONLY to the object's real populate/dispose lifecycle while always
  // calling the CURRENT callback.
  const onMeshRef = useRef(onMesh);
  useEffect(() => {
    onMeshRef.current = onMesh;
  }, [onMesh]);

  // Populate the (R3F-owned) BatchedMesh once it exists / is recreated. `renderMaterial` is in the
  // deps because args include it — a material flip recreates the object, and this re-populates the
  // fresh one. The `instanceCount` guard makes the populate idempotent under a StrictMode double
  // effect on the same object (a fresh object has 0 instances; an already-filled one is skipped).
  //
  // Phase 30 (T2 debt-1) BUG FIX: onMesh registration MUST run on every invocation of this effect
  // (not only the branch that populates), including the StrictMode-driven second invoke after the
  // first invoke's cleanup already unregistered it. The populate guard above short-circuits with
  // an early `return` — when that early return also skipped the registration call, the sequence
  // under React 19 StrictMode's dev double-invoke (effect → cleanup → effect) was: register →
  // unregister (cleanup) → [populate guard skips, registration never re-runs] → net UNREGISTERED,
  // even though the mesh was fully populated and live. Found live (Playwright verification:
  // recentImpacts showed real archetype hits at forces far over threshold, but occupancy stayed
  // 0 and registeredCategories() came back empty). Fix: populate is still guarded/idempotent, but
  // the onMesh call (and its cleanup) is UNCONDITIONAL whenever a live `bm` exists.
  useEffect(() => {
    const bm = ref.current;
    if (!bm) return;
    if (bm.instanceCount === 0) {
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
    }
    onMeshRef.current?.(bm);
    return () => onMeshRef.current?.(null);
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
