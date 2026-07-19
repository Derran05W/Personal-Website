// Phase 31 (Part-8 D2/D3, T1) — Toronto transit ref pair. Mirrors ai/streetcarTypes.ts's
// `streetcarRef` singleton shape exactly, but as TWO separate refs (bus, streetcar) because
// Toronto mounts one StreetcarController per MODE (different tuning/chassis — see
// ai/streetcarTraffic.ts's StreetcarControllerOptions), each publishing its own slot array. Using
// the legacy `streetcarRef` singleton for either would collide with the other mode's controller
// (and, pre-Phase-32, with the legacy branch's own streetcar mount — that branch no longer exists
// in the runtime graph as of the Phase 32 flip, config/worldSource.ts).
import type { StreetcarApi } from './streetcarTypes';

/** Set by world/toronto/TorontoTransit.tsx's bus mount; null before the first PLAYING mount OR
 * whenever the Toronto branch isn't mounted at all. */
export const torontoBusRef: { current: StreetcarApi | null } = { current: null };

/** Set by world/toronto/TorontoTransit.tsx's streetcar mount. */
export const torontoStreetcarRef: { current: StreetcarApi | null } = { current: null };

/** Per-slot route id (world/toronto/transitRoster.ts's assignment, e.g. "97"), index-aligned
 * with the matching StreetcarApi's `slots` array — published alongside the pose ref so debug
 * tooling (core/debugBridge.ts) can report WHICH route a given slot is driving without threading
 * route identity through the physics controller itself. Empty when the mode isn't mounted. */
export const torontoBusRouteIdsRef: { current: readonly string[] } = { current: [] };
export const torontoStreetcarRouteIdsRef: { current: readonly string[] } = { current: [] };
