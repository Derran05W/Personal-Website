// Phase 31 (Part-8 D3, T1) — the shared route-number board overlay: a small individual (non-
// instanced) plane per transit-vehicle slot, reading whichever controller's slots (`apiRef`) the
// caller passes — reused for BOTH the bus roster (torontoBusRef) and the streetcar roster
// (torontoStreetcarRef), decoupled from either body's own rendering. Individual meshes (not
// InstancedMesh) because each slot's board may show a DIFFERENT route (a different UV row of the
// shared atlas) — mirrors ParkedVehicles.tsx's "shared baked geometry per group, individual mesh
// per placement" shape, except the "group" here is by-ROW (route), not by model id.
//
// Small roster (<=12 total across both modes): individual, frustum-culled meshes cost nothing
// noticeable, and this stays decoupled from ai/StreetcarMesh.tsx's InstancedMesh body (which has
// no per-instance-child mechanism).

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { DoubleSide, Mesh, MeshBasicMaterial, type BufferGeometry } from 'three';
import type { StreetcarApi } from '../../../ai/streetcarTypes';
import { buildRouteBoardAtlas, buildRouteBoardGeometry, type RouteBoardEntry } from '../routeBoardAtlas';

export interface TransitRouteBoardsProps {
  readonly apiRef: { current: StreetcarApi | null };
  readonly capacity: number;
  /** Per-slot {id, label} — length MUST equal `capacity` (mount-captured, from
   * world/toronto/transitRoster.ts's assignment). */
  readonly entries: readonly RouteBoardEntry[];
  /** Height (wu) above the vehicle's own ground-up origin the board's centre sits at
   * (config/torontoTransit.ts ROUTE_BOARD.busHeightWu / streetcarHeightWu). */
  readonly heightWu: number;
}

/** Per-slot transit route boards. Capacity 0 renders nothing. */
export function TransitRouteBoards({ apiRef, capacity, entries, heightWu }: TransitRouteBoardsProps) {
  const atlas = useMemo(() => buildRouteBoardAtlas(entries), [entries]);
  useEffect(() => () => atlas.texture.dispose(), [atlas]);

  const material = useMemo(
    () => new MeshBasicMaterial({ map: atlas.texture, side: DoubleSide, toneMapped: false }),
    [atlas],
  );
  useEffect(() => () => material.dispose(), [material]);

  // One geometry per DISTINCT route row (shared across every slot showing that route).
  const geometries = useMemo(() => {
    const byRow = new Map<number, BufferGeometry>();
    return entries.map((e) => {
      const row = atlas.rowIndex.get(e.id) ?? 0;
      const existing = byRow.get(row);
      if (existing) return existing;
      const g = buildRouteBoardGeometry(row, atlas.rowCount);
      byRow.set(row, g);
      return g;
    });
  }, [entries, atlas]);
  useEffect(() => {
    return () => {
      const disposed = new Set<BufferGeometry>();
      for (const g of geometries) {
        if (!disposed.has(g)) {
          g.dispose();
          disposed.add(g);
        }
      }
    };
  }, [geometries]);

  const meshRefs = useRef<(Mesh | null)[]>([]);

  useFrame(() => {
    const slots = apiRef.current?.slots;
    for (let i = 0; i < capacity; i++) {
      const mesh = meshRefs.current[i];
      if (mesh === null || mesh === undefined) continue;
      const slot = slots?.[i];
      if (slot === undefined || slot.state === null) {
        mesh.visible = false;
        continue;
      }
      mesh.visible = true;
      mesh.position.set(slot.x, slot.y + heightWu, slot.z);
      // Rotation intentionally NOT synced to the vehicle's yaw (live-verification fix — see
      // routeBoardAtlas.ts's buildRouteBoardGeometry doc comment): the board lies flat, normal
      // +Y, always face-on to the fixed camera regardless of which way the vehicle is heading.
    }
  });

  if (capacity === 0) return null;
  return (
    <>
      {Array.from({ length: capacity }).map((_, i) => (
        <mesh
          key={i}
          ref={(el) => {
            meshRefs.current[i] = el;
          }}
          geometry={geometries[i]}
          material={material}
          visible={false}
        />
      ))}
    </>
  );
}
