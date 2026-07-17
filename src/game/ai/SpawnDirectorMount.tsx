// R3F mount for the pursuit spawn director (Phase 9). Named `SpawnDirectorMount.tsx` (not
// `SpawnDirector.tsx`) to stay case-distinct from `spawnDirector.ts` — TypeScript rejects two
// modules differing only in case (TS1149), same reason ai/TrafficMount.tsx sits next to
// ai/traffic.ts. Owns one SpawnDirectorController for its lifetime, publishes it through
// ai/pursuitTypes.ts's `unitsRef` (so BUSTED proximity, the pursuit mesh, sirens, and debug
// tooling read the pool), and drives it from the Rapier step hooks:
//   • stepBefore in useBeforePhysicsStep — staggered 10 Hz think() scheduling, alongside the
//     unit factories' own force-application before-step hooks (frame order, TDD §6).
//   • stepAfter in useAfterPhysicsStep — pool maintenance (despawn far/wrecked, fill to cap).
//
// It also subscribes the two lifecycle events the director reacts to (the controller itself
// stays event-free/testable):
//   • tierChanged → requestFill(): fill the NEW cap immediately (TDD §5.5).
//   • runEnded    → despawnAll():  drain the pool on WRECKED/BUSTED/quit and the retry path.
//
// MUST live inside <Physics> (it reads the Rapier context via the step hooks) and be keyed on
// the world seed alongside CityScape/Traffic so the pool tears down and rebuilds cleanly on
// regenerate. The unit factories (ai/units/*) register themselves at import — integration
// (game/index.tsx) imports them so a registered factory exists before this mount fills a cap.

import { useEffect, useMemo, useRef } from 'react';
import { useAfterPhysicsStep, useBeforePhysicsStep } from '@react-three/rapier';
import { SpawnDirectorController, collectRoadPoints } from './spawnDirector';
import { createRng } from '../world/rng';
import { unitsRef } from './pursuitTypes';
import { gameEvents } from '../state/events';
import type { WorldData } from '../world/types';

export interface SpawnDirectorProps {
  /** Generated city — its road tiles are the spawn candidate set. */
  readonly world: WorldData;
  /** World seed — forks the deterministic 'spawnDirector' rng (kind rolls, ring pick, spawn
   * jitter). */
  readonly seed: number;
}

export function SpawnDirector({ world, seed }: SpawnDirectorProps) {
  const controllerRef = useRef<SpawnDirectorController | null>(null);
  // Road-tile candidates are a pure function of the world; recompute only when it changes.
  const roadPoints = useMemo(() => collectRoadPoints(world.tiles), [world]);

  useEffect(() => {
    const controller = new SpawnDirectorController({
      roadPoints,
      rng: createRng(seed).fork('spawnDirector'),
    });
    controllerRef.current = controller;
    unitsRef.current = controller.api;

    const offTier = gameEvents.on('tierChanged', () => controller.requestFill());
    const offEnd = gameEvents.on('runEnded', () => controller.despawnAll());

    return () => {
      offTier();
      offEnd();
      controller.dispose();
      if (unitsRef.current === controller.api) unitsRef.current = null;
      controllerRef.current = null;
    };
  }, [roadPoints, seed]);

  useBeforePhysicsStep(() => {
    controllerRef.current?.stepBefore();
  });

  useAfterPhysicsStep(() => {
    controllerRef.current?.stepAfter();
  });

  return null;
}
