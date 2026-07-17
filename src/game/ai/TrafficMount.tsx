// R3F mount for the civilian traffic system (Phase 7). File is `TrafficMount.tsx` rather than
// `Traffic.tsx` because a `Traffic.tsx` next to `traffic.ts` differs only in case, which
// TypeScript rejects (TS1149) — the core stays `traffic.ts` (the phase deliverable), the mount
// takes a case-distinct name. Owns a TrafficController (ai/traffic.ts)
// for its lifetime, publishes it through ai/trafficTypes.ts's `trafficRef` (so TrafficMesh and
// debug tooling can read the pose slots), subscribes it to the contact spine, and drives its
// two per-step passes from the Rapier step hooks:
//   • stepBefore in useBeforePhysicsStep — kinematic movement is written with
//     setNextKinematic* BEFORE the world integrates, so contacts are generated (part-file
//     gotcha: never useFrame for kinematic motion).
//   • stepAfter in useAfterPhysicsStep — dynamic-car pose copy, wreck detection, despawn, and
//     spawn maintenance, alongside the other frame-order resolvers (TDD §6).
//
// MUST live inside <Physics> (it reads the Rapier context + the step hooks). Mount it keyed on
// the world seed alongside CityScape so the pool tears down and rebuilds cleanly on regenerate.
//
// The `source` prop is the seam: integration passes combat/contacts.ts's `onImpact`. When
// omitted the controller still runs (traffic flows) but nothing ever converts — harmless, and
// keeps the component inert if mounted before the contact spine is wired.

import { useEffect, useRef } from 'react';
import { useAfterPhysicsStep, useBeforePhysicsStep, useRapier } from '@react-three/rapier';
import { TrafficController } from './traffic';
import { trafficRef } from './trafficTypes';
import type { TrafficGraph } from '../world/types';
import type { ImpactHandler } from '../combat/types';

export interface TrafficProps {
  /** Lane graph the civilians follow (world.graph). */
  readonly graph: TrafficGraph;
  /** World seed — forks the deterministic 'traffic' rng stream for spawn/turn/tint rolls. */
  readonly seed: number;
  /** Impact source: called once with the conversion handler, returns an unsubscribe.
   * Integration passes combat/contacts.ts's `onImpact`. */
  readonly source?: (handler: ImpactHandler) => () => void;
}

export function Traffic({ graph, seed, source }: TrafficProps) {
  const { world, rapier } = useRapier();
  const controllerRef = useRef<TrafficController | null>(null);

  useEffect(() => {
    const controller = new TrafficController(world, rapier, graph, seed);
    controllerRef.current = controller;
    trafficRef.current = controller.api;

    const unsub = source?.((record) => controller.handleImpact(record));

    return () => {
      unsub?.();
      controller.dispose();
      if (trafficRef.current === controller.api) trafficRef.current = null;
      controllerRef.current = null;
    };
  }, [world, rapier, graph, seed, source]);

  useBeforePhysicsStep(() => {
    controllerRef.current?.stepBefore();
  });

  useAfterPhysicsStep(() => {
    controllerRef.current?.stepAfter();
  });

  return null;
}
