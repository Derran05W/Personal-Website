// Phase 31 (Part-8 D2, T1) — the generic Toronto transit mount. Constructs ONE
// StreetcarController (streetcarTraffic.ts, UNFORKED) over a caller-supplied, already-resolved
// `avenues` array (world/toronto/transitRoster.ts's seeded weighted assignment — NOT read off
// `world.landmarks`, unlike the legacy ai/StreetcarMount.tsx's duck-typed world prop), and
// publishes its api into a CALLER-OWNED ref (never the legacy `streetcarRef` singleton — see
// ai/torontoTransitRefs.ts). Reused for BOTH the Toronto bus mount and the Toronto streetcar
// mount (world/toronto/TorontoTransit.tsx mounts this component twice, with different
// `avenues`/`apiRef`/`options`) — this is the "thin mount, one controller class" shape the phase
// brief calls for.
//
// Same lifecycle shape as ai/StreetcarMount.tsx: MUST live inside <Physics> (reads the Rapier
// context + step hooks) and be keyed on the world seed by the caller so the roster tears down and
// rebuilds cleanly on regenerate/retry.

import { useEffect, useRef } from 'react';
import { useAfterPhysicsStep, useBeforePhysicsStep, useRapier } from '@react-three/rapier';
import { StreetcarController, type AvenuePath, type StreetcarControllerOptions } from './streetcarTraffic';
import type { StreetcarApi } from './streetcarTypes';
import type { ImpactHandler } from '../combat/types';

export interface TorontoTransitMountProps {
  /** Pre-resolved, pre-assigned polylines — one per roster slot (world/toronto/transitRoster.ts).
   * Length drives the controller's roster size when `options.exactRosterSize` is true. */
  readonly avenues: readonly AvenuePath[];
  readonly seed: number;
  /** Impact source (combat/contacts.ts's `onImpact`) — same multi-subscriber seam every other
   * civilian/streetcar controller subscribes to. */
  readonly source?: (handler: ImpactHandler) => () => void;
  /** Caller-owned ref this mount publishes the controller's api into (ai/torontoTransitRefs.ts's
   * `torontoBusRef` / `torontoStreetcarRef` — NEVER the legacy `streetcarRef` singleton, which
   * would collide between the two modes). */
  readonly apiRef: { current: StreetcarApi | null };
  readonly options?: StreetcarControllerOptions;
}

export function TorontoTransitMount({ avenues, seed, source, apiRef, options }: TorontoTransitMountProps) {
  const { world: rapierWorld, rapier } = useRapier();
  const controllerRef = useRef<StreetcarController | null>(null);

  useEffect(() => {
    const controller = new StreetcarController(rapierWorld, rapier, avenues, seed, options);
    controllerRef.current = controller;
    apiRef.current = controller.api;

    const unsub = source?.((record) => controller.handleImpact(record));

    return () => {
      unsub?.();
      controller.dispose();
      if (apiRef.current === controller.api) apiRef.current = null;
      controllerRef.current = null;
    };
  }, [rapierWorld, rapier, avenues, seed, source, apiRef, options]);

  useBeforePhysicsStep(() => {
    controllerRef.current?.stepBefore();
  });

  useAfterPhysicsStep(() => {
    controllerRef.current?.stepAfter();
  });

  return null;
}
