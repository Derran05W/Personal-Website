// Civilian-traffic visuals (Phase 7 Task 2; TDD §7 civilian cars). Renders every slot of
// ai/traffic.ts's CivSlot pool (the seam: ai/trafficTypes.ts) as ONE InstancedMesh reusing
// world/geometry/parkedCar.ts's buildParkedCar() body — the established procedural-sedan
// language (world/geometry/parkedCar.ts's own header) — with per-instance tint standing in
// for a second geometry variant, exactly like the parked-car lot's InstanceSource.color path
// (world/cityInstances.ts) and the fixed→dynamic prop pool's geometry-clone discipline
// (world/propDynamics.ts's getOrCreateDynamic). This module owns ONLY rendering: it reads
// `trafficRef` every frame and never mutates a slot or the pool itself (ai/traffic.ts, a
// concurrent sibling task, owns the pool/movement/conversion/wreck state machine).
//
// aEmissiveOn: the shared palette material (world/palette.ts's getCityMaterial) requires
// every geometry it renders to carry this per-instance attribute (its onBeforeCompile patch
// samples it unconditionally) — civilians are never a blackout participant (like parked cars,
// per buildParkedCar's own header), so it is allocated once, all-zero, and never written
// again after the initial setup.
//
// Tint source: world/cityInstances.ts's PARKED_CAR_TINTS is exactly this shape of palette but
// is a module-private const (not exported), and this task's ground rules forbid touching that
// file — so a dedicated (visually similar, not identical) TRAFFIC tint palette is defined
// below instead of reaching into that module.
//
// Update strategy: every live instance's matrix + colour is rewritten unconditionally each
// frame (no per-slot dirty tracking). TRAFFIC_CIV.activeTarget tops out at a few dozen
// instances — cheap enough that a change-detection heuristic would cost more than it saves
// (propDynamics.ts's dirty-flag discipline exists because ITS pool can hold up to
// PROPS.dynamicPoolCap = 60 *sleeping* bodies that legitimately never move; civilian slots
// are either free (zeroed once and left alone until reused) or actively driving/tumbling, so
// "always write" and "only write when dirty" cost about the same here).

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  Color,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  Matrix4,
  Object3D,
  Vector3,
  type InstancedMesh,
} from 'three';
import { TRAFFIC_CIV } from '../config';
import { hpLostFraction, tintDamageColor } from '../fx/damageStates';
import { buildParkedCar } from '../world/geometry/parkedCar';
import { getCityMaterial } from '../world/palette';
import { trafficRef } from './trafficTypes';

// A small muted palette distinct from (but in the same spirit as) cityInstances.ts's
// PARKED_CAR_TINTS — see the file header for why this can't just import that one. Indexed by
// CivSlot.tintIndex (wraps via modulo so an out-of-range roll never throws).
const TRAFFIC_TINTS: readonly Color[] = [
  new Color('#5a6b8c'), // dusty blue
  new Color('#8c5a5a'), // brick red
  new Color('#6b6b6b'), // gunmetal grey
  new Color('#7a7a52'), // olive drab
  new Color('#3f4854'), // dark slate
  new Color('#a08a5c'), // tan
];

const WHITE = new Color(1, 1, 1);
const Y_AXIS = new Vector3(0, 1, 0);

// A single reusable hide matrix (propDynamics.ts's ZERO_MATRIX pattern) — zero scale
// collapses a free/out-of-range slot to an invisible degenerate point. setMatrixAt copies
// it, so sharing one read-only instance across every hidden slot is safe.
const ZERO_MATRIX = new Matrix4().makeScale(0, 0, 0);

// Hot-path scratch (module scope — the useFrame body allocates nothing per instance).
const _dummy = new Object3D();
const _color = new Color();

export function TrafficMesh() {
  const meshRef = useRef<InstancedMesh>(null);
  const capacity = TRAFFIC_CIV.activeTarget;

  // buildParkedCar() already returns a brand-new BufferGeometry per call (no shared/cached
  // singleton to alias), but this mesh still clones it before tagging on aEmissiveOn — same
  // discipline propDynamics.ts documents for its dynamic archetypes, and cheap insurance
  // against buildParkedCar ever gaining a memoized fast path later.
  const geometry = useMemo(() => {
    const g = buildParkedCar().clone();
    const emissive = new InstancedBufferAttribute(new Float32Array(capacity), 1); // all-zero
    emissive.setUsage(DynamicDrawUsage); // never rewritten, but keep it dynamic-friendly
    g.setAttribute('aEmissiveOn', emissive);
    return g;
    // capacity is read from a live-tunable config leaf but only sized ONCE, at mount — see
    // the file header's tints/capacity note in TrafficMesh's leva companion (devPanel.tsx):
    // changing it live does not resize an already-mounted InstancedMesh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const material = useMemo(() => getCityMaterial(), []);

  // Dispose the cloned geometry on unmount (the shared material is a memoized singleton —
  // never disposed here, matching every other getCityMaterial() consumer).
  useEffect(() => {
    return () => geometry.dispose();
  }, [geometry]);

  // Initial fill: every instance starts hidden, instanceColor allocated (white — irrelevant
  // while hidden). Mirrors fx/SkidMarks.tsx's setup effect.
  useEffect(() => {
    const mesh = meshRef.current;
    if (mesh === null) return;
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    for (let i = 0; i < capacity; i++) {
      mesh.setMatrixAt(i, ZERO_MATRIX);
      mesh.setColorAt(i, WHITE);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor !== null) {
      mesh.instanceColor.setUsage(DynamicDrawUsage);
      mesh.instanceColor.needsUpdate = true;
    }
  }, [capacity]);

  // Priority-0 (default) useFrame: runs before core/frameOrder.tsx's priority-1 camera/render
  // pass (fx/SkidMarks.tsx's same convention), so this frame's traffic pose lands in this
  // frame's render.
  useFrame(() => {
    const mesh = meshRef.current;
    if (mesh === null) return;
    const slots = trafficRef.current?.slots;

    for (let i = 0; i < capacity; i++) {
      const slot = slots?.[i];
      if (slot === undefined || slot.state === null) {
        mesh.setMatrixAt(i, ZERO_MATRIX);
        continue;
      }

      _dummy.position.set(slot.x, slot.y, slot.z);
      if (slot.dynamic) {
        // 'converted' / 'wrecked': physics owns the full orientation.
        _dummy.quaternion.set(slot.qx, slot.qy, slot.qz, slot.qw);
      } else {
        // 'driving': kinematic follower — yaw-only, along the travel direction.
        _dummy.quaternion.setFromAxisAngle(Y_AXIS, slot.yaw);
      }
      _dummy.scale.set(1, 1, 1);
      _dummy.updateMatrix();
      mesh.setMatrixAt(i, _dummy.matrix);

      _color.copy(TRAFFIC_TINTS[slot.tintIndex % TRAFFIC_TINTS.length] ?? WHITE);
      // Phase 16: graduated damage tint (25/50/75% HP lost) on top of the base tint, full
      // charred at 'wrecked' — see fx/damageStates.ts's tintDamageColor header.
      tintDamageColor(_color, hpLostFraction(slot.hp, TRAFFIC_CIV.hp), slot.state === 'wrecked');
      mesh.setColorAt(i, _color);
    }

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
  });

  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, material, capacity]}
      frustumCulled={false}
      castShadow
    />
  );
}
