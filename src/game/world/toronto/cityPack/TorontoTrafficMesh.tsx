// Phase 29 (D3/D4/D5) — the Toronto civilian-traffic visual. Replaces the legacy single-sedan
// InstancedMesh (ai/TrafficMesh.tsx, still used by the legacy branch) with pack-model instanced
// batches: ONE InstancedMesh per civilian vehicle model, each drawing the NEUTRAL-BODY variant
// (config/carVariety.ts) tinted per-instance by the car's carVariety colour so the street reads in
// ≥4 models / ≥6 colours.
//
// Reads the SAME ai/trafficTypes.ts `trafficRef` seam the legacy mesh reads (the controller owns
// the pool/movement/conversion — this module only renders). Per-slot model+colour is a stable,
// seeded assignment (buildCarVarietySequence keyed on slot id): a slot keeps its look for its whole
// life, so a converted/wrecked car keeps its model+colour for free (D4 requirement), and a slot
// respawns as the same "fleet car".
//
// Tri-budget lever: each InstancedMesh's `.count` is set every frame to the number of ACTIVE cars
// of that model (their slots packed into [0,count)), so hidden/free slots submit NO triangles even
// though the buffers are sized to the model's full slot partition. Total drawn instances across all
// batches = the active roster (≤32), ~48k tris worst case — well under every tier budget.

import { Suspense, useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  Color,
  DynamicDrawUsage,
  Matrix4,
  Quaternion,
  Vector3,
  type InstancedMesh,
} from 'three';
import { TRAFFIC_CIV } from '../../../config';
import { neutralVehicleModelId } from '../../../config/carVariety';
import { buildCarVarietySequence } from '../../../vehicles/carVariety';
import { hpLostFraction, tintDamageColor } from '../../../fx/damageStates';
import { toUnlit } from '../../../assets/cityPack';
import { useBakedCityPackModel } from './cityPackBaked';
import { trafficRef } from '../../../ai/trafficTypes';

const Y_AXIS = new Vector3(0, 1, 0);

// Hot-path scratch (module scope — the useFrame body allocates nothing per instance).
const _pos = new Vector3();
const _quat = new Quaternion();
const _scaleV = new Vector3();
const _mat = new Matrix4();
const _color = new Color();

interface SlotAssignment {
  readonly slotId: number;
  readonly colorHex: string;
}

/** One civilian model's batch: the neutral-body variant geometry + material, instanced across the
 * slots assigned this model, with per-frame matrix + tint writes and a `.count` capped to the
 * active members so free slots cost nothing. */
function TrafficModelBatch({
  neutralId,
  members,
  unlit,
}: {
  neutralId: string;
  members: readonly SlotAssignment[];
  unlit: boolean;
}) {
  const { geometry, scale, lift, material } = useBakedCityPackModel(neutralId);
  const renderMaterial = useMemo(() => (unlit ? toUnlit(material) : material), [material, unlit]);
  useEffect(() => () => { if (renderMaterial !== material) renderMaterial.dispose(); }, [renderMaterial, material]);

  const meshRef = useRef<InstancedMesh>(null);
  const capacity = members.length;

  // Per-member base colour (parsed once). Damage tint is applied per-frame on a copy.
  const baseColors = useMemo(() => members.map((m) => new Color(m.colorHex)), [members]);

  // Initial fill: instanceColor allocated (white), matrices zeroed. Mirrors ai/TrafficMesh.tsx.
  useEffect(() => {
    const mesh = meshRef.current;
    if (mesh === null) return;
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    _mat.makeScale(0, 0, 0);
    for (let i = 0; i < capacity; i++) {
      mesh.setMatrixAt(i, _mat);
      mesh.setColorAt(i, _color.setRGB(1, 1, 1));
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
    const slots = trafficRef.current?.slots;
    _scaleV.set(scale, scale, scale); // this batch's uniform scale — set fresh (shared scratch)
    let k = 0;
    for (let m = 0; m < members.length; m++) {
      const slot = slots?.[members[m].slotId];
      if (slot === undefined || slot.state === null) continue;
      _pos.set(slot.x, slot.y + lift, slot.z);
      if (slot.dynamic) {
        _quat.set(slot.qx, slot.qy, slot.qz, slot.qw);
      } else {
        _quat.setFromAxisAngle(Y_AXIS, slot.yaw);
      }
      _mat.compose(_pos, _quat, _scaleV);
      mesh.setMatrixAt(k, _mat);
      // Base carVariety colour, darkened by graduated damage state (Phase 16 idiom, TrafficMesh).
      _color.copy(baseColors[m]);
      tintDamageColor(_color, hpLostFraction(slot.hp, TRAFFIC_CIV.hp), slot.state === 'wrecked');
      mesh.setColorAt(k, _color);
      k++;
    }
    mesh.count = k; // only the k packed active instances draw; free slots submit no triangles
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  });

  if (capacity === 0) return null;
  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, renderMaterial, capacity]}
      frustumCulled={false}
    />
  );
}

export interface TorontoTrafficMeshProps {
  /** Slot pool capacity — MUST equal the TrafficController roster (config/torontoTraffic.ts),
   * mount-captured, so every slot has an assignment. */
  readonly capacity: number;
  /** World seed — the per-slot model+colour assignment sequence is deterministic in it. */
  readonly seed: number;
  /** Material A/B arm (shared `cityPackUnlit` toggle). */
  readonly unlit: boolean;
}

export function TorontoTrafficMesh({ capacity, seed, unlit }: TorontoTrafficMeshProps) {
  // Stable per-slot {model, colour} assignment (D4 anti-repeat sequence keyed on slot id). A slot
  // keeps its look across spawn/despawn cycles, so converted/wrecked cars keep their model+colour.
  const assignments = useMemo(() => buildCarVarietySequence(seed, capacity), [seed, capacity]);

  // Partition slot ids by BASE model → one batch per model (mapped to the neutral-body variant id).
  const batches = useMemo(() => {
    const byModel = new Map<string, SlotAssignment[]>();
    assignments.forEach((a, slotId) => {
      const arr = byModel.get(a.modelId) ?? byModel.set(a.modelId, []).get(a.modelId)!;
      arr.push({ slotId, colorHex: a.colorHex });
    });
    return [...byModel.entries()]
      .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))
      .map(([base, members]) => ({ neutralId: neutralVehicleModelId(base), members }));
  }, [assignments]);

  return (
    <Suspense fallback={null}>
      {batches.map((b) => (
        <TrafficModelBatch key={b.neutralId} neutralId={b.neutralId} members={b.members} unlit={unlit} />
      ))}
    </Suspense>
  );
}
