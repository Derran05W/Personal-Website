// R3F mount for the streetcar traffic system (Phase 19 Task 3). Named `StreetcarMount.tsx`
// (not `Streetcar.tsx`/`streetcar.ts`) to keep this file's exported component name
// (`StreetcarTraffic`) descriptive on its own and stay clear of ai/traffic.ts's own
// TrafficMount.tsx naming rationale (case-collision avoidance — not a concern here since the
// logic module is `streetcarTraffic.ts`, already case-distinct). Owns a StreetcarController
// (ai/streetcarTraffic.ts) for its lifetime, publishes it through ai/streetcarTypes.ts's
// `streetcarRef` (so StreetcarMesh and debug tooling can read the pose slots), subscribes it to
// the contact spine, and drives its two per-step passes from the Rapier step hooks — exactly
// ai/TrafficMount.tsx's shape, kept as a SEPARATE mount/controller/mesh trio (not folded into
// Traffic/TrafficMount) because the two systems' data models genuinely differ (fixed avenue
// loop vs. branching lane graph) even though they share the same lifecycle shape and pure
// helpers (see streetcarTraffic.ts's header).
//
// Integration note (this task must not edit game/index.tsx — see the phase-19 task brief): the
// live app's existing `<Traffic key=... graph={world.graph} seed={seed} source={onImpact} />`
// call only passes `world.graph`, not the full `world` this component needs (for
// world.landmarks.streetcarAvenues). Wiring this in is ONE line for the integrator:
//   <StreetcarTraffic key={`streetcar-${worldKey}`} world={world} seed={seed} source={onImpact} />
// mounted inside <Physics> alongside <Traffic>/<TrafficMesh> (and <StreetcarMesh/> next to
// <TrafficMesh/>). Until that line exists nothing calls this component, so there is zero
// behavioural change to the live app from this task alone — the defensive "no avenues data"
// path this component and streetcarTraffic.ts implement also covers "not mounted at all".
//
// MUST live inside <Physics> (it reads the Rapier context + the step hooks) and be keyed on the
// world seed alongside CityScape/Traffic so the roster tears down and rebuilds cleanly on
// regenerate.

import { useEffect, useMemo, useRef } from 'react';
import { useAfterPhysicsStep, useBeforePhysicsStep, useRapier } from '@react-three/rapier';
import { getStreetcarAvenues, StreetcarController } from './streetcarTraffic';
import { streetcarRef } from './streetcarTypes';
import type { ImpactHandler } from '../combat/types';

export interface StreetcarTrafficProps {
  /** The generated city. Only `world.landmarks?.streetcarAvenues` is read (defensively — see
   * streetcarTraffic.ts's getStreetcarAvenues header); everything else is ignored. */
  readonly world: unknown;
  /** World seed — forks the deterministic 'streetcar' rng stream (recycle placement rolls). */
  readonly seed: number;
  /** Impact source: called once with the conversion handler, returns an unsubscribe.
   * Integration passes combat/contacts.ts's `onImpact` — the SAME source ai/TrafficMount.tsx's
   * `<Traffic>` subscribes; both controllers coexist on it independently (see
   * combat/contacts.ts's `handlers: Set<ImpactHandler>` — multiple subscribers are supported by
   * design, each one only reacts to collider handles it registered itself). */
  readonly source?: (handler: ImpactHandler) => () => void;
}

export function StreetcarTraffic({ world, seed, source }: StreetcarTrafficProps) {
  const { world: rapierWorld, rapier } = useRapier();
  const controllerRef = useRef<StreetcarController | null>(null);

  // Pure derivation of world -> avenues (see getStreetcarAvenues's header for the defensive
  // read); recomputed only when the world reference changes.
  const avenues = useMemo(() => getStreetcarAvenues(world), [world]);

  useEffect(() => {
    const controller = new StreetcarController(rapierWorld, rapier, avenues, seed);
    controllerRef.current = controller;
    streetcarRef.current = controller.api;

    const unsub = source?.((record) => controller.handleImpact(record));

    return () => {
      unsub?.();
      controller.dispose();
      if (streetcarRef.current === controller.api) streetcarRef.current = null;
      controllerRef.current = null;
    };
  }, [rapierWorld, rapier, avenues, seed, source]);

  useBeforePhysicsStep(() => {
    controllerRef.current?.stepBefore();
  });

  useAfterPhysicsStep(() => {
    controllerRef.current?.stepAfter();
  });

  return null;
}
