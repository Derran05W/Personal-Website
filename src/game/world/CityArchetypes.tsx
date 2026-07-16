// Mounts the instanced city: one InstancedMesh per archetype variant, built from the
// pre-assembled, district-sorted sets in world/cityInstances.ts (see that file's header
// for the instanceId invariant this pair guards).

import { useEffect, useMemo } from 'react';
import { getCityMaterial } from './palette';
import {
  clearArchetypeRegistry,
  createArchetypeMesh,
  registerArchetypeHandles,
} from './instancing';
import type { ArchetypeInstanceSet } from './cityInstances';

/**
 * Mounts one InstancedMesh per archetype variant from pre-assembled sets.
 *
 * Construction is PURE (useMemo: geometry + createArchetypeMesh — no global writes), so a
 * StrictMode double-render at worst builds a discarded duplicate that never uploads to the
 * GPU (upload happens on first draw) and is plain-GC'd. The side effects — handle
 * registration (the Phase 13 blackout/debug-tint lookup) and geometry disposal — live in
 * effects with exact cleanup pairing.
 */
export function CityArchetypes({ sets }: { sets: readonly ArchetypeInstanceSet[] }) {
  const built = useMemo(
    () =>
      sets.map((set) => {
        const geometry = set.buildGeometry();
        const { mesh, emissiveAttr } = createArchetypeMesh(geometry, getCityMaterial(), set.sources);
        return { set, geometry, mesh, emissiveAttr };
      }),
    [sets],
  );

  useEffect(() => {
    for (const b of built) {
      registerArchetypeHandles(b.set.archetype, {
        name: b.set.archetype,
        variantKey: b.set.variantKey,
        mesh: b.mesh,
        emissiveAttr: b.emissiveAttr,
        ranges: b.set.ranges,
      });
    }
    return () => {
      // Handles all belong to this mount; a full clear is exact here (regenerate = one
      // CityScape remount = one CityArchetypes lifetime).
      clearArchetypeRegistry();
      for (const b of built) b.geometry.dispose();
    };
  }, [built]);

  return (
    <>
      {built.map((b) => (
        <primitive key={b.set.variantKey} object={b.mesh} />
      ))}
    </>
  );
}
