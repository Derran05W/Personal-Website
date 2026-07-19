// Phase 31 (Part-8 D3, T1) — the Toronto world-traffic bus body: ONE InstancedMesh of the pack
// 'bus' model (config/cityPackScale.ts's BUS_TARGET_LENGTH_WU override), reading
// ai/torontoTransitRefs.ts's `torontoBusRef` slots (published by the StreetcarController the
// Toronto bus mount constructs with TTC_BUS_TUNING + a bus chassis override — see
// world/toronto/TorontoTransit.tsx). Mirrors world/toronto/cityPack/TorontoTrafficMesh.tsx's
// `TrafficModelBatch` shape (one InstancedMesh, matrix+colour written per frame, `.count` capped
// to active members) but simplified to a SINGLE model/tint (every TTC bus wears the same livery
// — no carVariety roll; D3 explicitly wants a uniform "TTC-homage" look, not per-bus variety).
//
// LIVERY (documented simplification, phase-31-notes.md): a true two-tone red/white bus texture
// needs a pipeline-side neutral-body GLB variant (scripts/city-pack.mjs, T2 territory, out of
// scope here) — the body wears a single light tint (TTC_LIVERY.busBodyHex) and the route board
// (TransitRouteBoards, mounted alongside) carries the TTC-red accent + white background the rest
// of the way.

import { Suspense, useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Color, DynamicDrawUsage, Matrix4, Quaternion, Vector3, type InstancedMesh } from 'three';
import { TTC_LIVERY } from '../../../config/torontoTransit';
import { hpLostFraction, tintDamageColor } from '../../../fx/damageStates';
import { toUnlit } from '../../../assets/cityPack';
import { torontoBusRef } from '../../../ai/torontoTransitRefs';
import { useBakedCityPackModel } from './cityPackBaked';

const Y_AXIS = new Vector3(0, 1, 0);

// Hot-path scratch (module scope — the useFrame body allocates nothing per instance).
const _pos = new Vector3();
const _quat = new Quaternion();
const _scaleV = new Vector3();
const _mat = new Matrix4();
const _color = new Color();

export interface TorontoBusMeshProps {
  /** Slot pool capacity — MUST equal the bus StreetcarController roster (config/
   * torontoTransit.ts's torontoBusRoster(tier)), mount-captured. */
  readonly capacity: number;
  /** Max hp for the damage-tint fraction — TTC_BUS_TUNING.hp. */
  readonly maxHp: number;
  readonly unlit: boolean;
}

function BusBody({ capacity, maxHp, unlit }: TorontoBusMeshProps) {
  const { geometry, scale, lift, material } = useBakedCityPackModel('bus');
  const renderMaterial = useMemo(() => (unlit ? toUnlit(material) : material), [material, unlit]);
  useEffect(() => () => { if (renderMaterial !== material) renderMaterial.dispose(); }, [renderMaterial, material]);

  const meshRef = useRef<InstancedMesh>(null);

  // Initial fill: every instance hidden, instanceColor allocated to the base livery tint.
  useEffect(() => {
    const mesh = meshRef.current;
    if (mesh === null) return;
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    _mat.makeScale(0, 0, 0);
    const base = new Color(TTC_LIVERY.busBodyHex);
    for (let i = 0; i < capacity; i++) {
      mesh.setMatrixAt(i, _mat);
      mesh.setColorAt(i, base);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) {
      mesh.instanceColor.setUsage(DynamicDrawUsage);
      mesh.instanceColor.needsUpdate = true;
    }
  }, [capacity]);

  useFrame(() => {
    const mesh = meshRef.current;
    if (mesh === null) return;
    const slots = torontoBusRef.current?.slots;
    _scaleV.set(scale, scale, scale);
    let k = 0;
    for (let i = 0; i < capacity; i++) {
      const slot = slots?.[i];
      if (slot === undefined || slot.state === null) continue;
      _pos.set(slot.x, slot.y + lift, slot.z);
      if (slot.dynamic) {
        _quat.set(slot.qx, slot.qy, slot.qz, slot.qw);
      } else {
        _quat.setFromAxisAngle(Y_AXIS, slot.yaw);
      }
      _mat.compose(_pos, _quat, _scaleV);
      mesh.setMatrixAt(k, _mat);
      _color.set(TTC_LIVERY.busBodyHex);
      tintDamageColor(_color, hpLostFraction(slot.hp, maxHp), slot.state === 'wrecked');
      mesh.setColorAt(k, _color);
      k++;
    }
    // Hide any remaining unpacked capacity slots (defensive — the roster is fully seeded from
    // frame 1 in practice, see ai/streetcarTraffic.ts's seedRoster, but this guards the transient
    // pre-seed frame the same way TrafficModelBatch's `.count = k` does).
    mesh.count = k;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  });

  if (capacity === 0) return null;
  return <instancedMesh ref={meshRef} args={[geometry, renderMaterial, capacity]} frustumCulled={false} castShadow />;
}

export function TorontoBusMesh(props: TorontoBusMeshProps) {
  if (props.capacity === 0) return null;
  return (
    <Suspense fallback={null}>
      <BusBody {...props} />
    </Suspense>
  );
}
