// Phase 25.5 (D7) — the reusable city-pack instancer. Given ONE model id + an array of placements
// ({position, rotationY, tint}), it renders a SINGLE InstancedMesh built from that model's single
// post-pipeline prim: one draw call for N placements of the same model (the concrete answer to the
// phase's instancing criterion). Per-instance tint rides `instanceColor`, which three multiplies
// over the palette/texture sample in its color_vertex chain — so a near-white tint subtly recolours
// the whole textured model (D7's "author tints near-white-down"), and the default (0xffffff) leaves
// the baked palette untouched.
//
// The model's node matrix (baseMatrix — carries KHR_mesh_quantization de-quant + any authored node
// transform) is folded INTO every per-instance matrix (see assets/cityPack.ts on why we don't bake
// it into the quantized geometry). Uniform scale comes from config/cityPackScale.ts; the model's
// own floor is lifted to the placement's y via groundOffsetNative × scale.

import { useEffect, useMemo, useRef } from 'react';
import {
  Color,
  Matrix4,
  Quaternion,
  Vector3,
  type InstancedMesh,
} from 'three';
import { useCityPackModel, toUnlit } from '../../../assets/cityPack';
import { resolveCityPackScale } from '../../../config/cityPackScale';

/** One placement of a city-pack model. */
export interface CityPackPlacement {
  /** World position of the model's footprint centre; the model's floor is grounded at `y`. */
  readonly position: readonly [number, number, number];
  /** Yaw about world Y (radians), applied about the model's own vertical axis. Default 0. */
  readonly rotationY?: number;
  /** Per-instance tint multiplied over the palette texture (D7). Default 0xffffff (no change). */
  readonly tint?: Color | number | string;
}

const Y_AXIS = new Vector3(0, 1, 0);

export interface CityPackInstancesProps {
  /** Manifest model id (assets/cityPackManifest.ts). */
  readonly id: string;
  readonly placements: readonly CityPackPlacement[];
  /** A/B material arm: true → MeshBasicMaterial + map, toneMapped=false (D8 unlit-literal); false →
   * the GLB's real (lit) material. Threaded from the `cityPackUnlit` dev toggle. */
  readonly unlit: boolean;
  /** Whether the instances cast shadows (buildings yes; tiny props/scale-row can skip). Default true. */
  readonly castShadow?: boolean;
}

export function CityPackInstances({ id, placements, unlit, castShadow = true }: CityPackInstancesProps) {
  const { geometry, material, baseMatrix, groundOffsetNative } = useCityPackModel(id);
  const scale = resolveCityPackScale(id);

  // Lit arm renders the shared source material directly; unlit arm creates (and owns → disposes) a
  // MeshBasicMaterial. Rebuilt only when the arm flips.
  const renderMaterial = useMemo(() => (unlit ? toUnlit(material) : material), [material, unlit]);
  useEffect(
    () => () => {
      if (renderMaterial !== material) renderMaterial.dispose();
    },
    [renderMaterial, material],
  );

  const ref = useRef<InstancedMesh>(null);
  useEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const place = new Matrix4();
    const quat = new Quaternion();
    const trans = new Vector3();
    const scaleVec = new Vector3(scale, scale, scale);
    const color = new Color();
    const lift = groundOffsetNative * scale;
    placements.forEach((p, i) => {
      quat.setFromAxisAngle(Y_AXIS, p.rotationY ?? 0);
      trans.set(p.position[0], p.position[1] + lift, p.position[2]);
      place.compose(trans, quat, scaleVec); // T · R · S
      place.multiply(baseMatrix); // … · baseMatrix  (dequant + node transform)
      mesh.setMatrixAt(i, place);
      color.set(p.tint ?? 0xffffff);
      mesh.setColorAt(i, color);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [placements, scale, baseMatrix, groundOffsetNative, geometry]);

  if (placements.length === 0) return null;

  return (
    <instancedMesh
      ref={ref}
      args={[undefined, undefined, placements.length]}
      castShadow={castShadow}
      frustumCulled={false}
    >
      <primitive object={geometry} attach="geometry" />
      <primitive object={renderMaterial} attach="material" />
    </instancedMesh>
  );
}
