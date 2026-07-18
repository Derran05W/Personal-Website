// Phase 25.6 (D17) — the traffic-light lamp overlay. D17's closed question: cycling the baked
// signal heads on the shared palette texture is NOT feasible without shader surgery (per-instance
// UV offsets don't exist on Instanced/BatchedMesh without patching the material). What ships
// instead is THIS: one InstancedMesh of small emissive quads (2 tris each), one per traffic-light
// mast, positioned at the model's measured head anchor (config/torontoDress.ts LAMP_OVERLAY). The
// phase (green/amber/red) comes from the deterministic sim-time clock (world/toronto/lampClock.ts);
// per-instance colour is written via `setColorAt` ONLY when a mast's phase actually changes — zero
// per-frame allocation, no writes on a steady frame. Cosmetic only: no traffic obeys it (there is
// no traffic AI on the slice). Alternating intersections desync half a cycle (parity) so the map
// never blinks in lockstep.

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Color, Object3D, Quaternion, Vector3, type InstancedMesh } from 'three';
import { LAMP_OVERLAY } from '../../../config/torontoDress';
import { lampColor, lampPhase, parityOffsetForIntersection, type LampPhase } from '../lampClock';
import type { LampMast } from '../furniture';

const Y_AXIS = new Vector3(0, 1, 0);

export function TrafficLampOverlay({ masts }: { masts: readonly LampMast[] }) {
  const ref = useRef<InstancedMesh>(null);
  // Per-mast last phase, so setColorAt fires only on a change (no steady-frame writes).
  const lastPhase = useRef<LampPhase[]>([]);

  // Static per-mast head positions (mast origin + yawed head anchor) + parity offsets — built once.
  const heads = useMemo(() => {
    const anchor = new Vector3(LAMP_OVERLAY.headAnchor.x, LAMP_OVERLAY.headAnchor.y, LAMP_OVERLAY.headAnchor.z);
    const q = new Quaternion();
    const v = new Vector3();
    return masts.map((mast) => {
      q.setFromAxisAngle(Y_AXIS, mast.rotationY);
      v.copy(anchor).applyQuaternion(q);
      return {
        position: [mast.position[0] + v.x, mast.position[1] + v.y, mast.position[2] + v.z] as [number, number, number],
        rotationY: mast.rotationY,
        axis: mast.axis,
        parity: parityOffsetForIntersection(mast.intersectionIndex),
      };
    });
  }, [masts]);

  // Place the instances once (matrices never change; only colour cycles).
  useEffect(() => {
    const mesh = ref.current;
    if (!mesh || heads.length === 0) return;
    const dummy = new Object3D();
    const color = new Color();
    lastPhase.current = new Array(heads.length);
    heads.forEach((h, i) => {
      dummy.position.set(h.position[0], h.position[1], h.position[2]);
      dummy.rotation.set(0, h.rotationY, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      const phase = lampPhase(0, h.axis, h.parity);
      lastPhase.current[i] = phase;
      color.set(lampColor(phase));
      mesh.setColorAt(i, color);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [heads]);

  const scratch = useMemo(() => new Color(), []);
  useFrame((state) => {
    const mesh = ref.current;
    if (!mesh || heads.length === 0) return;
    const simTimeMs = state.clock.elapsedTime * 1000;
    let changed = false;
    for (let i = 0; i < heads.length; i++) {
      const phase = lampPhase(simTimeMs, heads[i].axis, heads[i].parity);
      if (phase !== lastPhase.current[i]) {
        lastPhase.current[i] = phase;
        scratch.set(lampColor(phase));
        mesh.setColorAt(i, scratch);
        changed = true;
      }
    }
    if (changed && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  });

  if (masts.length === 0) return null;
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, masts.length]} frustumCulled={false}>
      <planeGeometry args={[LAMP_OVERLAY.quadSizeWu, LAMP_OVERLAY.quadSizeWu]} />
      <meshBasicMaterial toneMapped={false} />
    </instancedMesh>
  );
}
