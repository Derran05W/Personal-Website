// Static physics colliders for the instanced city (Phase 5 Task 4; CLAUDE.md's entity-
// registry pattern, TDD §7 collision groups). Turns cityInstances.ts's district-sorted
// ArchetypeInstanceSet[] (buildings + street props — the SAME sets CityArchetypes.tsx renders
// from) into fixed Rapier colliders and registers every one of them in world/registry.ts, so
// Phase 6's contact spine can resolve a collider handle back to gameplay identity
// (kind/archetype/instanceId/districtId/hp) the moment it lands.
//
// Consuming `sets` (rather than raw WorldData + propPlacements.ts's PropPlacement[]) is load-
// bearing, not a style choice: cityInstances.ts's header is explicit that instance order is
// sorted-by-district exactly once, there, and "colliders must be built from THESE arrays,
// never from raw derivePlacements()/world.buildings order" — registry.ts documents
// `instanceId` as "index into the archetype's InstancedMesh", and that mesh is built from the
// SORTED order, not placement/generation order. worldCollidersLogic.ts's file header has the
// full per-set instanceId contract (and its one documented limitation, for multi-variant
// buildings).
//
// All the pure sizing/registry-entry/per-set logic lives in worldCollidersLogic.ts (kept out
// of this file so its several non-component exports don't trip react-refresh/only-export-
// components — this file exports only the two components + their prop types).
// worldColliders.test.ts (the Task 4 brief's required test filename) exercises that module
// directly.
//
// This module owns NO generation/placement/sorting logic of its own. It mounts as a sibling
// of CityArchetypes inside the same <Physics> tree; the orchestrator wires that up (see the
// Task 4 brief — this file is integrated, not self-mounting).
//
// --- Collider-mounting structure (measured + correctness decision) ------------------------
// DECLARATIVE, but NOT "one ref callback per <CuboidCollider>" as first attempted. That
// version FAILED live, reproducibly, under React 19 StrictMode: @react-three/rapier's
// <CuboidCollider> (AnyCollider internally) calls a function `ref` prop exactly ONCE, at
// creation — it never calls it with `null` on destroy (verified by reading the library's
// compiled source: useImperativeInstance's destroy path only calls
// `world.removeCollider(...)`, never `props.ref(null)`). StrictMode's mount→cleanup→remount
// dev-only churn then creates collider A, never tells a plain ref callback about its
// destruction, creates collider B (Rapier's generational arena can hand back the SAME
// numeric handle A had), and a ref-callback-based register — still holding handle A as
// "registered" — throws registry.ts's dev-mode "registered twice" guard.
//
// A from-scratch IMPERATIVE version (raw `world.createRigidBody`/`createCollider` in a
// single effect, bypassing react-three-rapier's components entirely) was also tried and
// ALSO failed live under the same StrictMode churn — with WASM-ownership panics ("attempted
// to take ownership of Rust value while it was borrowed") — because it re-implements
// object lifecycle react-three-rapier's own internals already handle safely (the pattern
// CityScape's ground/barriers/water colliders already rely on, incident-free).
//
// The fix that actually works: keep react-three-rapier fully in charge of every Collider's
// WASM lifecycle (same <RigidBody>/<CuboidCollider> JSX the rest of this codebase uses), but
// stop depending on its ref-callback's (missing) null-call for unregistering. `RegisteredCollider`
// below passes a REF OBJECT instead of a function — react-three-rapier sets `.current`
// directly and synchronously inside ITS OWN mount effect (verified: `useForwardedRef`
// returns the passed ref object as-is and a later line assigns `.current = collider`), which
// — because React runs child effects before parent effects — is guaranteed populated before
// this wrapper's OWN `useEffect` reads it. That effect's cleanup (a completely ordinary React
// mechanism, unrelated to the library's ref-callback shortcut) is what pairs the
// register/unregister correctly under any StrictMode churn.
//
// Grouping: ONE fixed <RigidBody colliders={false}> for every building (every variant set
// flattened together — only the registry entry's `archetype` differs), and ONE per street-
// prop set (cityInstances.ts builds exactly one set per prop archetype) — "bodies are the
// expensive part" per the brief; collider COUNT under those few bodies is comparatively free
// broadphase-only overhead. Live mount-time measurement (seed 416, ~3,754 colliders across
// ~3,754 RegisteredCollider wrappers + ~3,754 CuboidCollider children) is logged in the
// phase-05 handoff notes.

import { useEffect, useMemo, useRef, type ReactElement } from 'react';
import { CuboidCollider, RigidBody, type RapierCollider } from '@react-three/rapier';
import { interactionGroups } from '../config';
import type { ArchetypeInstanceSet } from './cityInstances';
import { entityCount, registerEntity, unregisterEntity, type EntityEntry } from './registry';
import { setColliders } from './worldCollidersLogic';

export interface WorldCollidersProps {
  readonly sets: readonly ArchetypeInstanceSet[];
}

const BUILDING_GROUPS = interactionGroups('BUILDING');
const PROP_STATIC_GROUPS = interactionGroups('PROP_STATIC');

interface RegisteredColliderProps {
  readonly entry: EntityEntry;
  readonly halfExtents: [number, number, number];
  readonly position: [number, number, number];
  readonly rotationY: number;
}

/**
 * One collider + its registry.ts lifecycle, paired via THIS component's own effect (see the
 * file header for why a shared ref-callback-per-item approach doesn't work here). `entry` is
 * a fresh, memoized-per-set-identity object (worldCollidersLogic.ts's setColliders), so the
 * effect only re-runs when the parent's `sets` prop actually changes.
 */
function RegisteredCollider({ entry, halfExtents, position, rotationY }: RegisteredColliderProps) {
  const colliderRef = useRef<RapierCollider>(null);
  useEffect(() => {
    const collider = colliderRef.current;
    if (!collider) return;
    registerEntity(collider.handle, entry);
    return () => unregisterEntity(collider.handle);
  }, [entry]);
  return <CuboidCollider ref={colliderRef} args={halfExtents} position={position} rotation={[0, rotationY, 0]} />;
}

export function WorldColliders({ sets }: WorldCollidersProps) {
  // Building colliders: every variant set's buildings flattened into ONE fixed RigidBody
  // parent. Memoized so an unrelated parent re-render (an unchanged `sets` identity) never
  // re-creates thousands of elements/effects for nothing.
  const buildingColliders = useMemo(() => {
    const out: ReactElement[] = [];
    for (const set of sets) {
      if (set.buildings.length === 0) continue;
      for (const { entry, box, x, z, rotationY } of setColliders(set)) {
        out.push(
          <RegisteredCollider
            key={`${set.variantKey}-${entry.instanceId}`}
            entry={entry}
            halfExtents={box.halfExtents}
            position={[x, box.centerY, z]}
            rotationY={rotationY}
          />,
        );
      }
    }
    return out;
  }, [sets]);

  // Street-prop colliders: one fixed RigidBody parent per set (== per archetype present this
  // run — cityInstances.ts builds exactly one set per prop archetype).
  const propColliderGroups = useMemo(() => {
    const groups: { key: string; colliders: ReactElement[] }[] = [];
    for (const set of sets) {
      if (set.placements.length === 0) continue;
      const colliders = setColliders(set).map(({ entry, box, x, z, rotationY }) => (
        <RegisteredCollider
          key={`${set.archetype}-${entry.instanceId}`}
          entry={entry}
          halfExtents={box.halfExtents}
          position={[x, box.centerY, z]}
          rotationY={rotationY}
        />
      ));
      groups.push({ key: set.variantKey, colliders });
    }
    return groups;
  }, [sets]);

  // Dev-only sanity check (Task 4 brief): confirms every registered collider actually landed
  // in world/registry.ts once the whole subtree (including every RegisteredCollider's own
  // mount effect, which runs before this parent effect) has committed.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    console.info('[world] registry size', entityCount());
  }, [buildingColliders, propColliderGroups]);

  return (
    <>
      <RigidBody type="fixed" colliders={false} collisionGroups={BUILDING_GROUPS}>
        {buildingColliders}
      </RigidBody>
      {propColliderGroups.map(({ key, colliders }) => (
        <RigidBody key={key} type="fixed" colliders={false} collisionGroups={PROP_STATIC_GROUPS}>
          {colliders}
        </RigidBody>
      ))}
    </>
  );
}
