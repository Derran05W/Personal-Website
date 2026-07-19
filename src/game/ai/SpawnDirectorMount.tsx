// R3F mount for the pursuit spawn director (Phase 9; Phase 30 D1/D2 re-seat onto the NavProvider).
// Named `SpawnDirectorMount.tsx` (not `SpawnDirector.tsx`) to stay case-distinct from
// `spawnDirector.ts` — TypeScript rejects two modules differing only in case (TS1149), same reason
// ai/TrafficMount.tsx sits next to ai/traffic.ts. Owns one SpawnDirectorController for its
// lifetime, publishes it through ai/pursuitTypes.ts's `unitsRef` (so BUSTED proximity, the pursuit
// mesh, sirens, and debug tooling read the pool), publishes the active NavProvider
// (ai/navProvider.ts) so roadNav + squadCoordinator read the same map, and drives the controller
// from the Rapier step hooks:
//   • stepBefore in useBeforePhysicsStep — staggered 10 Hz think() scheduling, alongside the
//     unit factories' own force-application before-step hooks (frame order, TDD §6).
//   • stepAfter in useAfterPhysicsStep — pool maintenance (despawn far/wrecked, fill to cap).
//
// It also subscribes the two lifecycle events the director reacts to (the controller itself
// stays event-free/testable):
//   • tierChanged → requestFill(): fill the NEW cap immediately (TDD §5.5).
//   • runEnded    → despawnAll():  drain the pool on WRECKED/BUSTED/quit and the retry path.
//
// The MAP is abstracted behind the NavProvider: `SpawnDirector` builds a LegacyNavProvider from a
// WorldData (the legacy 64×64 world — behaviour byte-identical to pre-Phase-30), and
// `TorontoPursuitDirector` builds a TorontoNavProvider (the thermometer map). Both feed the SAME
// controller through a shared core — the director's composition tables/caps/stagger/hysteresis are
// untouched; only the candidate set + nav queries swap. The candidate ring stays 60–90 m absolute.
//
// MUST live inside <Physics> (it reads the Rapier context via the step hooks) and be keyed on the
// world seed/run nonce alongside the city/traffic so the pool tears down and rebuilds cleanly on
// regenerate/retry. The unit factories (ai/units/*) register themselves at import — integration
// (game/index.tsx) imports them so a registered factory exists before this mount fills a cap.

import { useEffect, useMemo, useRef } from 'react';
import { useAfterPhysicsStep, useBeforePhysicsStep } from '@react-three/rapier';
import { SpawnDirectorController } from './spawnDirector';
import { createRng } from '../world/rng';
import { unitsRef } from './pursuitTypes';
import { gameEvents } from '../state/events';
import {
  createLegacyNavProvider,
  resetNavProvider,
  setNavProvider,
  type NavProvider,
} from './navProvider';
import { createTorontoNavProvider } from './torontoNavProvider';
import type { WorldData } from '../world/types';

/** The shared mount core: owns one controller bound to a NavProvider for its lifetime. */
function PursuitDirectorCore({ provider, seed }: { provider: NavProvider; seed: number }) {
  const controllerRef = useRef<SpawnDirectorController | null>(null);
  // Spawn candidates are a pure function of the provider (world); recompute only when it changes.
  const roadPoints = useMemo(() => provider.spawnCandidates(), [provider]);

  useEffect(() => {
    const controller = new SpawnDirectorController({
      roadPoints,
      rng: createRng(seed).fork('spawnDirector'),
      // Approach-bias context (Phase 16 Task 5) when the provider supplies one (legacy = graph
      // nodes + tile grid); Toronto returns undefined → the uniform behind-camera ring pick.
      nav: provider.spawnNav(),
    });
    controllerRef.current = controller;
    unitsRef.current = controller.api;
    // Publish the provider so pursuit units road-follow (roadNav) and SWAT flank-clamp
    // (squadCoordinator) read the same map. Cleared on teardown/regenerate/retry below.
    setNavProvider(provider);

    const offTier = gameEvents.on('tierChanged', () => controller.requestFill());
    const offEnd = gameEvents.on('runEnded', () => controller.despawnAll());

    return () => {
      offTier();
      offEnd();
      controller.dispose();
      if (unitsRef.current === controller.api) unitsRef.current = null;
      controllerRef.current = null;
      resetNavProvider();
    };
  }, [roadPoints, seed, provider]);

  useBeforePhysicsStep(() => {
    controllerRef.current?.stepBefore();
  });

  useAfterPhysicsStep(() => {
    controllerRef.current?.stepAfter();
  });

  return null;
}

export interface SpawnDirectorProps {
  /** Generated city — its road tiles are the spawn candidate set (via the legacy provider). */
  readonly world: WorldData;
  /** World seed — forks the deterministic 'spawnDirector' rng (kind rolls, ring pick, spawn
   * jitter). */
  readonly seed: number;
}

/** Legacy 64×64-world pursuit director (byte-identical to pre-Phase-30). */
export function SpawnDirector({ world, seed }: SpawnDirectorProps) {
  const provider = useMemo(() => createLegacyNavProvider(world), [world]);
  return <PursuitDirectorCore provider={provider} seed={seed} />;
}

/** Toronto thermometer-map pursuit director (Phase 30). Same controller, Toronto NavProvider. */
export function TorontoPursuitDirector({ seed }: { readonly seed: number }) {
  const provider = useMemo(() => createTorontoNavProvider(), []);
  return <PursuitDirectorCore provider={provider} seed={seed} />;
}
