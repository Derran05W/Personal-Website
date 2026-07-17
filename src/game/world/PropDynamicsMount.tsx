// R3F mount for the dynamic-prop pool (Phase 6 Task 2). Owns a <group> that hosts the
// per-archetype dynamic InstancedMeshes the PropSwapController (world/propDynamics.ts) adds
// imperatively, subscribes the controller to the impact source, and drives its per-step tick
// from useAfterPhysicsStep. MUST live inside <Physics> (uses the Rapier context + the
// after-step hook); mount it keyed on the world seed alongside CityScape so the pool tears
// down cleanly on regenerate.
//
// The `source` prop is the seam: integration passes combat/contacts.ts's `onImpact`. When it
// is omitted, a DEV-only TEMPORARY driver (module-local below) stands in so this task is
// self-verifiable before the contact spine lands — it manufactures ImpactRecords from the
// player's proximity/speed and from window.__smashyProps hooks, then feeds them through the
// REAL swap path. In production an omitted source is an inert no-op. The orchestrator wires
// `source={onImpact}` at integration, after which none of the temporary scaffold runs.

import { useEffect, useRef } from 'react';
import { useAfterPhysicsStep, useRapier, type RapierContext } from '@react-three/rapier';
import { Group, Quaternion, Vector3 } from 'three';
import { PROPS, dynamicPropPoolCap, interactionGroups } from '../config';
import { getGameState } from '../state/store';
import { getEntity, type EntityEntry } from './registry';
import { playerVehicle } from '../vehicles/playerRef';
import { PropSwapController, type Vec3 } from './propDynamics';
import type { ImpactHandler, ImpactRecord } from '../combat/types';

type RapierWorld = RapierContext['world'];
type RapierNamespace = RapierContext['rapier'];

export interface PropDynamicsProps {
  /**
   * Impact source: called once with the swap handler, returns an unsubscribe. Integration
   * passes combat/contacts.ts's `onImpact`. When omitted, a DEV-only temporary driver stands
   * in (see file header); in production an omitted source is inert (no swaps).
   */
  readonly source?: (handler: ImpactHandler) => () => void;
}

export function PropDynamics({ source }: PropDynamicsProps) {
  const { world, rapier } = useRapier();
  const groupRef = useRef<Group>(null);
  const controllerRef = useRef<PropSwapController | null>(null);

  useEffect(() => {
    const group = groupRef.current;
    if (group === null) return;
    // Phase 18: size the dynamic-prop pool for the current quality tier (read once at mount —
    // a mid-run quality change applies on the next keyed remount, per the quality-system doc).
    const poolCap = dynamicPropPoolCap(PROPS.dynamicPoolCap, getGameState().settings.quality);
    const controller = new PropSwapController(world, rapier, group, poolCap);
    controllerRef.current = controller;

    let unsub: (() => void) | undefined;
    if (source !== undefined) {
      unsub = source((record) => controller.handleImpact(record));
    } else if (import.meta.env.DEV) {
      unsub = installTempWindowHooks(world, rapier, controller);
    }

    return () => {
      unsub?.();
      controller.dispose();
      controllerRef.current = null;
    };
  }, [world, rapier, source]);

  useAfterPhysicsStep(() => {
    const controller = controllerRef.current;
    if (controller === null) return;
    controller.update();
    // TEMP proximity driver (isolated verification only; the real `source` replaces it and
    // this branch never runs once wired).
    if (source === undefined && import.meta.env.DEV) tempProximityStep(world, rapier, controller);
  });

  return <group ref={groupRef} />;
}

// ===========================================================================================
// TEMPORARY isolated-verification driver (DEV-only; the import.meta.env.DEV guards at the
// call sites dead-code-eliminate it from prod builds). See the file header. Momentum-proxy
// forces are NOT Rapier's true contact forces — thresholds get recalibrated against the real
// contact spine post-integration.
// ===========================================================================================

// forceMag ≈ playerSpeed × this. Tuned so a crawl (< ~1.2 m/s) stays below every threshold
// (love-taps free) while cruising speed clears them (6 m/s → 1500 N ≈ parkedCar).
const TEMP_FORCE_PER_SPEED = 250;
// Proximity ball at the car's front bumper — small so only a near-frontal overlap (a real
// "hit"), not merely passing a curbside pole, triggers a swap.
const TEMP_FRONT_OFFSET_M = 2.2;
const TEMP_HIT_RADIUS_M = 1.3;
const TEMP_FORWARD = new Vector3(0, 0, 1);
const TEMP_IDENTITY_ROT = { x: 0, y: 0, z: 0, w: 1 } as const;
const tempQuat = new Quaternion();
const tempVec = new Vector3();

/** Iterate live `propStatic` colliders overlapping a ball at `center`, calling `cb`. Filters
 * as if the player (so buildings/ground/etc. are considered then rejected by the predicate). */
function queryStaticProps(
  world: RapierWorld,
  rapier: RapierNamespace,
  center: Vec3,
  radius: number,
  cb: (handle: number, entry: EntityEntry) => void,
): void {
  const shape = new rapier.Ball(radius);
  world.intersectionsWithShape(
    center,
    TEMP_IDENTITY_ROT,
    shape,
    (collider) => {
      const entry = getEntity(collider.handle);
      if (entry !== undefined && entry.kind === 'propStatic') cb(collider.handle, entry);
      return true; // keep going — collect every overlapping prop
    },
    undefined,
    interactionGroups('PLAYER'),
  );
}

function synthImpact(handle: number, entry: EntityEntry, point: Vec3, forceMag: number): ImpactRecord {
  return { aHandle: handle, bHandle: -1, a: entry, b: undefined, forceMag, point };
}

/** Per-step proximity swap: overlap a small ball with the car's front bumper and swap any
 * fixed prop there, with a speed-derived force so slow nudges leave props nailed down. */
function tempProximityStep(
  world: RapierWorld,
  rapier: RapierNamespace,
  controller: PropSwapController,
): void {
  const model = playerVehicle.current;
  if (model === null) return;
  const state = model.readState();
  const forceMag = state.speed * TEMP_FORCE_PER_SPEED;
  if (forceMag <= 0) return;
  const { position, rotation } = state.pose;
  tempQuat.set(rotation.x, rotation.y, rotation.z, rotation.w);
  tempVec.copy(TEMP_FORWARD).applyQuaternion(tempQuat).multiplyScalar(TEMP_FRONT_OFFSET_M);
  const front: Vec3 = { x: position.x + tempVec.x, y: position.y + tempVec.y, z: position.z + tempVec.z };
  queryStaticProps(world, rapier, front, TEMP_HIT_RADIUS_M, (handle, entry) => {
    controller.handleImpact(synthImpact(handle, entry, front, forceMag));
  });
}

declare global {
  interface Window {
    /** DEV-only prop-swap debug surface (temporary verification driver — see file header). */
    __smashyProps?: {
      /** Live dynamic-pool occupancy (≤ PROPS.dynamicPoolCap). */
      occupancy: () => number;
      /** Accumulated sim seconds (despawn polling). */
      simTime: () => number;
      /** Swap the single nearest fixed prop within `radius` m of the player (default 3.5). */
      swapNearest: (radius?: number) => number;
      /** Swap EVERY fixed prop within `radius` m of the player (default 10) with a force above
       * all thresholds — drives pool-overflow / eviction verification. Returns count swapped. */
      burst: (radius?: number) => number;
      /** World positions of fixed props within `radius` m of the player (default 30) — lets a
       * scripted drive-through aim the car at a real pole. */
      props: (radius?: number) => { x: number; y: number; z: number; archetype: string }[];
    };
  }
}

function installTempWindowHooks(
  world: RapierWorld,
  rapier: RapierNamespace,
  controller: PropSwapController,
): () => void {
  const playerPos = (): Vec3 | null => playerVehicle.current?.readState().pose.position ?? null;

  window.__smashyProps = {
    occupancy: () => controller.occupancy(),
    simTime: () => controller.getSimTime(),
    swapNearest: (radius = 3.5) => {
      const center = playerPos();
      if (center === null) return 0;
      let best: { handle: number; entry: EntityEntry; d2: number } | null = null;
      queryStaticProps(world, rapier, center, radius, (handle, entry) => {
        const c = world.getCollider(handle)?.translation();
        if (c === undefined) return;
        const d2 = (c.x - center.x) ** 2 + (c.y - center.y) ** 2 + (c.z - center.z) ** 2;
        if (best === null || d2 < best.d2) best = { handle, entry, d2 };
      });
      if (best === null) return 0;
      const hit = best as { handle: number; entry: EntityEntry; d2: number };
      controller.handleImpact(synthImpact(hit.handle, hit.entry, center, 1e5));
      return 1;
    },
    burst: (radius = 10) => {
      const center = playerPos();
      if (center === null) return 0;
      const targets: { handle: number; entry: EntityEntry }[] = [];
      queryStaticProps(world, rapier, center, radius, (handle, entry) => {
        targets.push({ handle, entry });
      });
      for (const t of targets) controller.handleImpact(synthImpact(t.handle, t.entry, center, 1e5));
      return targets.length;
    },
    props: (radius = 30) => {
      const center = playerPos();
      if (center === null) return [];
      const out: { x: number; y: number; z: number; archetype: string }[] = [];
      queryStaticProps(world, rapier, center, radius, (handle, entry) => {
        const c = world.getCollider(handle)?.translation();
        if (c !== undefined && entry.archetype !== undefined) {
          out.push({ x: c.x, y: c.y, z: c.z, archetype: entry.archetype });
        }
      });
      return out;
    },
  };

  return () => {
    delete window.__smashyProps;
  };
}
