// Mount for the pooled dynamic-light system (Phase 13 Task 3; TDD §5.8/§8.2). Renders the
// LIGHT_POOL.size real <pointLight>s and drives them every frame from the pure core in
// powergrid/lightPool.ts. The pool trails the player and snaps each light to the nearest LIT
// streetlight head; blacked-out districts never receive one. Mirrors fx/Explosions.tsx's
// pooled-PointLight discipline: unassigned lights park at y=PARK_Y with intensity 0, and the
// per-frame hot path allocates nothing (all scratch is loop-scoped numbers, the states array
// is mutated in place).
//
// FRAME MODEL:
//   - ~LIGHT_POOL.reassignHz (5 Hz): recompute the nearest-lit assignment (assign()).
//   - every frame: advance each light's fade (stepFade()) and write its transform/intensity.
// Reads the live player pose through vehicles/playerRef (module ref, per the store's "no
// per-frame hot data in zustand" rule); parks the whole pool when there is no live run.
//
// DARK-DISTRICT WIRING: the dark-district state is read through lightPool.ts's injectable
// seam. This mount wires that seam to the SAME canonical "is district N dark" notion every
// other Phase 13 consumer uses (Task 4's debug bridge, the minimap overlay): a district is
// dark if grid.ts's immediate power state says so (`gridRef.current.lit[d] === false`, flips
// the instant a transformer dies) OR emitters.ts's visual state says so
// (`isDistrictDark(d)`, flips once the ~0.6 s flicker settles). The OR means a district is
// excluded from the moment its power fails — a light already there fades out, none ever
// *enters* a dark district — and keeps the pool consistent with what the minimap/debug tools
// report even before the orchestrator mounts grid.ts's `initPowerGrid` subscription. The
// read is defensive: an out-of-range/absent entry is treated as lit (never wrongly dark).
// Both imports are READ-only (grid/emitters state APIs); this touches neither module. Falls
// back to lightPool.ts's all-lit default until this effect runs.

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import type { PointLight } from 'three';
import { LIGHT_POOL } from '../config';
import type { WorldData } from '../world/types';
import { playerVehicle } from '../vehicles/playerRef';
import { gridRef } from './grid';
import { isDistrictDark as emittersIsDistrictDark } from './emitters';
import {
  assign,
  createLightState,
  getDarkPredicate,
  setDistrictDarkSource,
  stepFade,
  streetlightEmitters,
  type LightState,
} from './lightPool';

const SIZE = LIGHT_POOL.size;
const REASSIGN_INTERVAL = 1 / LIGHT_POOL.reassignHz;
// Parked lights sit far below the map with intensity 0 — same trick as fx/Explosions.tsx's
// pooled point lights (EXPLOSION.light.parkY).
const PARK_Y = -100;

export function LightPool({ world }: { world: WorldData }) {
  // Streetlight emitters for this world — derived (and cached) once. `world` is stable for a
  // mounted instance (the game keys this component on the world, remounting on regenerate),
  // so a stale emitter index can never outlive its world.
  const emitters = useMemo(() => streetlightEmitters(world), [world]);

  // Refs to the real lights, indexed by pool slot.
  const lightsRef = useRef<(PointLight | null)[]>([]);

  // Per-slot fade runtime. Lazy-ref-init (fx/Explosions.tsx idiom) — plain mutable state, not
  // a useMemo (which react-hooks' immutability rule would treat as frozen).
  const statesRef = useRef<LightState[] | null>(null);
  if (statesRef.current === null) {
    statesRef.current = Array.from({ length: SIZE }, () => createLightState());
  }

  // Reassignment accumulator.
  const accRef = useRef(0);

  // Wire the pool's dark-district read to the canonical combined state (see file header). The
  // predicate reads live state on every call; the strict `=== false` keeps an out-of-range/
  // absent district treated as lit.
  useEffect(() => {
    setDistrictDarkSource(
      (districtId) =>
        gridRef.current.lit[districtId] === false || emittersIsDistrictDark(districtId),
    );
    return () => setDistrictDarkSource(null);
  }, []);

  useFrame((_, dt) => {
    const states = statesRef.current;
    if (!states) return;

    const player = playerVehicle.current?.readState();
    if (!player) {
      // No live run (GARAGE / between regenerations) — park the whole pool.
      for (let i = 0; i < SIZE; i += 1) {
        const s = states[i];
        s.current = -1;
        s.desired = -1;
        s.phase = 'steady';
        s.intensity = 0;
        s.t = 0;
        const light = lightsRef.current[i];
        if (light) {
          light.intensity = 0;
          light.position.set(0, PARK_Y, 0);
        }
      }
      accRef.current = 0;
      return;
    }

    const px = player.pose.position.x;
    const pz = player.pose.position.z;

    // ~5 Hz reassignment.
    accRef.current += dt;
    if (accRef.current >= REASSIGN_INTERVAL) {
      accRef.current = 0;
      assign(
        states,
        emitters,
        px,
        pz,
        getDarkPredicate(),
        SIZE,
        LIGHT_POOL.hysteresisPct,
        LIGHT_POOL.fadeSec,
      );
    }

    // Every frame: advance fades and drive the real lights.
    for (let i = 0; i < SIZE; i += 1) {
      const s = states[i];
      stepFade(s, dt, LIGHT_POOL.fadeSec);
      const light = lightsRef.current[i];
      if (!light) continue;
      if (s.current === -1) {
        light.intensity = 0;
        light.position.set(0, PARK_Y, 0);
      } else {
        const e = emitters[s.current];
        light.position.set(e.x, LIGHT_POOL.headHeightM, e.z);
        light.intensity = LIGHT_POOL.intensity * s.intensity;
      }
    }
  });

  return (
    <>
      {Array.from({ length: SIZE }, (_, i) => (
        <pointLight
          key={i}
          ref={(el) => {
            lightsRef.current[i] = el;
          }}
          intensity={0}
          distance={LIGHT_POOL.distanceM}
          decay={2}
          color={LIGHT_POOL.color}
          castShadow={false}
          position={[0, PARK_Y, 0]}
        />
      ))}
    </>
  );
}
