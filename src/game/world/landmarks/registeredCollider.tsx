// Shared safe collider-registration primitives for the Phase 19 landmark colliders — mirrors
// world/CityColliders.tsx's RegisteredCollider (see that file's header for the full StrictMode
// rationale): react-three-rapier's collider components call a function `ref` prop exactly ONCE
// at creation and NEVER with `null` on destroy, so a REF OBJECT + this wrapper's own
// useEffect cleanup (not a ref callback) is required to register/unregister correctly under
// React 19 StrictMode's mount->cleanup->remount churn. Reused here instead of duplicated
// because CN Tower/Stadium/Flatiron each mount 1-2 landmark colliders through the exact same
// pattern.

import { useEffect, useRef } from 'react';
import { CuboidCollider, CylinderCollider, type RapierCollider } from '@react-three/rapier';
import { registerEntity, unregisterEntity, type EntityEntry } from '../registry';

export interface RegisteredCuboidColliderProps {
  readonly entry: EntityEntry;
  readonly halfExtents: readonly [number, number, number];
  readonly position: readonly [number, number, number];
  readonly rotationY?: number;
  /** Phase 29 (Toronto parked-vehicle/lane-closure-cone registration): passed straight through
   * to CuboidCollider's own `mass` prop when the collider sits on a DYNAMIC RigidBody (a fixed
   * body ignores it). Undefined (the original, pre-29 default) omits the prop entirely, so
   * every existing fixed-collider call site is unaffected. */
  readonly mass?: number;
}

export function RegisteredCuboidCollider({
  entry,
  halfExtents,
  position,
  rotationY = 0,
  mass,
}: RegisteredCuboidColliderProps) {
  const colliderRef = useRef<RapierCollider>(null);
  useEffect(() => {
    const collider = colliderRef.current;
    if (!collider) return;
    registerEntity(collider.handle, entry);
    return () => unregisterEntity(collider.handle);
  }, [entry]);
  return (
    <CuboidCollider
      ref={colliderRef}
      args={[halfExtents[0], halfExtents[1], halfExtents[2]]}
      position={[position[0], position[1], position[2]]}
      rotation={[0, rotationY, 0]}
      mass={mass}
    />
  );
}

export interface RegisteredCylinderColliderProps {
  readonly entry: EntityEntry;
  readonly halfHeight: number;
  readonly radius: number;
  readonly position: readonly [number, number, number];
}

export function RegisteredCylinderCollider({
  entry,
  halfHeight,
  radius,
  position,
}: RegisteredCylinderColliderProps) {
  const colliderRef = useRef<RapierCollider>(null);
  useEffect(() => {
    const collider = colliderRef.current;
    if (!collider) return;
    registerEntity(collider.handle, entry);
    return () => unregisterEntity(collider.handle);
  }, [entry]);
  return (
    <CylinderCollider ref={colliderRef} args={[halfHeight, radius]} position={[position[0], position[1], position[2]]} />
  );
}
