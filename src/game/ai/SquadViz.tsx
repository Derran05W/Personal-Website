// Dev-only in-scene SWAT-squad visualizer (Phase 10 Task 1). Draws the two flank-slot targets as
// upright posts and a line from each CLAIMED slot to its claimant unit, so the coordinated flank
// (ai/squad.ts / ai/squadCoordinator.ts) is legible while tuning. Same code-split + leva-toggle
// pattern as world/GraphViz.tsx: game/index.tsx lazy-imports it behind `import.meta.env.DEV` and
// only mounts it when the `squadViz` dev toggle (core/devToggles.ts) is on, so neither this module
// nor its geometry work ever ships in a production chunk.
//
// It reads the coordinator's PUBLISHED state (getFlankTargets/getSquadClaims) rather than
// recomputing — the coordinator publishes the two targets every run even before SWAT exist, so
// the posts are visible immediately (a great sanity check that the along-velocity / facing base
// direction and the drivable-clamp are behaving), and claim lines appear the moment SWAT spawn and
// lock onto a slot. Reads unitsRef for claimant world positions. Pure-visual: mutates nothing.

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  BufferGeometry,
  DynamicDrawUsage,
  Float32BufferAttribute,
  Mesh,
  type LineSegments,
} from 'three';
import { getFlankTargets, getSquadClaims } from './squadCoordinator';
import { unitsRef } from './pursuitTypes';

const POST_COLOR = '#22e6c8'; // flank-slot markers
const LINE_COLOR = '#ffd23f'; // slot → claimant
const POST_HEIGHT = 3;
const POST_Y = POST_HEIGHT / 2; // base sits on the ground
const LINE_Y = 0.5; // just above the road, like GraphViz
const MAX_SLOTS = 2; // SWAT flanking is always exactly two slots (TDD §5.6)

export default function SquadViz() {
  // Two persistent post meshes (one per possible slot), shown/hidden per frame by scaling.
  const postRefs = useRef<(Mesh | null)[]>([]);
  const lineRef = useRef<LineSegments>(null);

  // Preallocated claim-line geometry: MAX_SLOTS segments × 2 endpoints × 3 floats, updated in place.
  const lineGeometry = useMemo(() => {
    const g = new BufferGeometry();
    const attr = new Float32BufferAttribute(new Float32Array(MAX_SLOTS * 2 * 3), 3);
    attr.setUsage(DynamicDrawUsage);
    g.setAttribute('position', attr);
    g.setDrawRange(0, 0);
    return g;
  }, []);

  useEffect(() => () => lineGeometry.dispose(), [lineGeometry]);

  useFrame(() => {
    const targets = getFlankTargets();
    const claims = getSquadClaims();
    const slots = unitsRef.current?.slots;

    // Posts at each slot target; scale 0 to hide unused ones.
    for (let i = 0; i < MAX_SLOTS; i++) {
      const post = postRefs.current[i];
      if (!post) continue;
      const t = targets[i];
      if (t === undefined) {
        post.scale.setScalar(0);
        continue;
      }
      post.position.set(t.x, POST_Y, t.z);
      post.scale.setScalar(1);
      post.updateMatrix();
    }

    // Claim lines: slot target → claimant unit position.
    const positions = lineGeometry.getAttribute('position') as Float32BufferAttribute;
    let seg = 0;
    for (const claim of claims) {
      const target = targets.find((tt) => tt.id === claim.slotId);
      const unit = slots?.find((s) => s.id === claim.unitId);
      if (!target || !unit || seg >= MAX_SLOTS) continue;
      const o = seg * 6;
      positions.array[o + 0] = target.x;
      positions.array[o + 1] = LINE_Y;
      positions.array[o + 2] = target.z;
      positions.array[o + 3] = unit.x;
      positions.array[o + 4] = LINE_Y;
      positions.array[o + 5] = unit.z;
      seg++;
    }
    positions.needsUpdate = true;
    lineGeometry.setDrawRange(0, seg * 2);
  });

  return (
    <>
      {Array.from({ length: MAX_SLOTS }, (_, i) => (
        <mesh
          key={i}
          ref={(m) => {
            postRefs.current[i] = m;
          }}
          matrixAutoUpdate={false}
          frustumCulled={false}
        >
          <boxGeometry args={[0.6, POST_HEIGHT, 0.6]} />
          <meshBasicMaterial color={POST_COLOR} transparent opacity={0.6} />
        </mesh>
      ))}
      <lineSegments ref={lineRef} geometry={lineGeometry} frustumCulled={false}>
        <lineBasicMaterial color={LINE_COLOR} />
      </lineSegments>
    </>
  );
}
