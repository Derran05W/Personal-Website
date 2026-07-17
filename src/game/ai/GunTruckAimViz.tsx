// Dev-only LOS/aim visualizer for ★4 gun trucks (Phase 11 Task 3 debug deliverable;
// phase-11-plan.md Task 3 point 3). combat/turret.ts (Task 2, a concurrent sibling —
// combat/* is off-limits to this task to EDIT, but its exported pure/imperative helpers
// are fair game to READ) landed mid-session and exports exactly the LOS primitive this
// viz needs: `castBuildingClear` (single BUILDING-only raycast) + its `LOS_RAY_GROUPS`
// mask. This component uses those directly rather than hand-rolling a second copy of the
// same raycast — so the debug line's green/red verdict is now the IDENTICAL LOS test the
// real turret's fire gate runs, not just an equivalent one.
//
// Still a DELIBERATE, DOCUMENTED partial duplication, debug-only: there is no per-unit
// exported LIVE state to read instead (ai/units/gunTruck.ts's Turret instances and their
// engagement-range/slip-gate checks are private to that module, not surfaced on
// UnitSlot/PursuitApi), so this component still runs its OWN raycast per gun-truck slot
// every frame rather than reading a cached verdict off the real turret. And per this
// task's brief, "canFire" here is deliberately narrowed to LOS ALONE (green = clear LOS,
// red = blocked) — it does NOT model the 35 m engagement clamp, 2.5 s burst cooldown, or
// lateral-slip fire gate (combat/turret.ts's `canFire`/`FireGateParams`), which are
// irrelevant to "is the line of sight itself clear" and out of this debug tool's scope.
//
// Same code-split + leva-toggle pattern as ai/SquadViz.tsx / world/GraphViz.tsx: intended
// to be mounted only under `import.meta.env.DEV` AND the `aimViz` dev toggle
// (core/devToggles.ts) — this file itself has no DEV guard of its own (same as SquadViz.tsx
// and GraphViz.tsx), the guard lives at the call site that lazy-imports it.

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { useRapier } from '@react-three/rapier';
import {
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  Float32BufferAttribute,
  LineBasicMaterial,
  type BufferAttribute,
  type LineSegments,
} from 'three';
import { castBuildingClear } from '../combat/turret';
import { unitsRef } from './pursuitTypes';
import { playerVehicle } from '../vehicles/playerRef';

// Safety margin above the ★4 gun-truck concurrent cap (phase-11-plan.md decision: ≤2) — a
// couple of spare slots costs nothing and avoids a hard visual cutoff if that cap is ever
// retuned upward without this file being revisited.
const MAX_LINES = 4;

// Rough turret/window height above each vehicle's chassis-centre pose (m) — cosmetic only,
// keeps the debug line from grazing the road surface.
const LOS_HEIGHT = 0.6;

const CLEAR_COLOR = new Color('#22e6a0'); // LOS clear
const BLOCKED_COLOR = new Color('#ef4444'); // LOS blocked by a building
const _c = new Color();

export default function GunTruckAimViz() {
  const lineRef = useRef<LineSegments>(null);
  const { world, rapier } = useRapier();

  // Reused scratch: one Ray instance, mutated per cast — castBuildingClear (combat/turret.ts)
  // writes ray.origin/ray.dir itself each call, this component just owns the persistent
  // instance. Lazy-ref-init (SkidMarks.tsx's `if (runtimeRef.current === null) …` idiom)
  // rather than useMemo: eslint-plugin-react-hooks' immutability rule treats anything
  // reachable from a useMemo return as forever-immutable, which a Rapier `Ray` — whose
  // whole API is "construct once, mutate .origin/.dir every cast" — fundamentally cannot
  // honor. A ref's `.current` is the recognized escape hatch for exactly this "created
  // once, mutated many times outside render" shape.
  const rayRef = useRef<InstanceType<typeof rapier.Ray> | null>(null);
  if (rayRef.current === null) {
    rayRef.current = new rapier.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
  }
  const ray = rayRef.current;

  const geometry = useMemo(() => {
    const g = new BufferGeometry();
    const position = new Float32BufferAttribute(new Float32Array(MAX_LINES * 2 * 3), 3);
    position.setUsage(DynamicDrawUsage);
    const color = new Float32BufferAttribute(new Float32Array(MAX_LINES * 2 * 3), 3);
    color.setUsage(DynamicDrawUsage);
    g.setAttribute('position', position);
    g.setAttribute('color', color);
    g.setDrawRange(0, 0);
    return g;
  }, []);

  const material = useMemo(() => new LineBasicMaterial({ vertexColors: true }), []);

  useEffect(() => {
    return () => {
      geometry.dispose();
      material.dispose();
    };
  }, [geometry, material]);

  useFrame(() => {
    const line = lineRef.current;
    const player = playerVehicle.current;
    const slots = unitsRef.current?.slots;
    if (!line || !player || !slots || slots.length === 0) {
      geometry.setDrawRange(0, 0);
      return;
    }

    const { position: playerPos } = player.readState().pose;
    const positions = geometry.getAttribute('position') as BufferAttribute;
    const colors = geometry.getAttribute('color') as BufferAttribute;

    let seg = 0;
    for (const slot of slots) {
      if (seg >= MAX_LINES) break;
      if (slot.kind !== 'gunTruck' || slot.state !== 'pursuing') continue;

      const from = { x: slot.x, y: slot.y + LOS_HEIGHT, z: slot.z };
      const to = { x: playerPos.x, y: playerPos.y + LOS_HEIGHT, z: playerPos.z };
      const clear = castBuildingClear(world, ray, from, to);

      const o = seg * 6;
      positions.array[o + 0] = slot.x;
      positions.array[o + 1] = slot.y + LOS_HEIGHT;
      positions.array[o + 2] = slot.z;
      positions.array[o + 3] = playerPos.x;
      positions.array[o + 4] = playerPos.y + LOS_HEIGHT;
      positions.array[o + 5] = playerPos.z;
      _c.copy(clear ? CLEAR_COLOR : BLOCKED_COLOR);
      colors.array[o + 0] = _c.r;
      colors.array[o + 1] = _c.g;
      colors.array[o + 2] = _c.b;
      colors.array[o + 3] = _c.r;
      colors.array[o + 4] = _c.g;
      colors.array[o + 5] = _c.b;
      seg += 1;
    }

    positions.needsUpdate = true;
    colors.needsUpdate = true;
    geometry.setDrawRange(0, seg * 2);
  });

  return <lineSegments ref={lineRef} geometry={geometry} material={material} frustumCulled={false} />;
}
