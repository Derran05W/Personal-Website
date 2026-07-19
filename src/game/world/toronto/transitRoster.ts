// Phase 31 (Part-8 D2, T1) — the tier-scaled, seeded roster ASSIGNMENT: which route each transit
// vehicle slot drives, weighted toward the showpiece routes (97/501/504/510). Pure TS (no three/
// Rapier) — the mount component (world/toronto/TorontoTransit.tsx) is the only consumer that
// touches React/Rapier.
//
// DESIGN NOTE (why this makes the roster "weighted" without touching StreetcarController's own
// round-robin `avenueIdx = id % avenues.length` spread): this module pre-computes an ASSIGNMENT
// array of length EXACTLY `count` (the tier roster size), one resolved route per slot, already
// chosen via the seeded weighted pick below (with repeats — a showpiece route legitimately gets
// more than one vehicle). The mount passes that array's `avenue` polylines straight through as
// StreetcarController's `avenues` param with `exactRosterSize: true`, so the controller's
// internal `size` becomes `avenues.length` (== count), and `id % avenues.length` degenerates to
// `id` — each slot gets EXACTLY the polyline this module assigned it, not a round-robin cycle
// through a small set of unique routes. See ai/streetcarTraffic.ts's constructor doc comment.

import { TORONTO_TRANSIT_WEIGHTING, torontoBusRoster, torontoStreetcarRoster } from '../../config/torontoTransit';
import type { QualityTier } from '../../config/quality';
import { createRng, type Rng } from '../rng';
import { buildTransitRoutes, routeWorldPoints, type ResolvedTransitRoute } from './transitRoutes';
import type { TransitMode } from './data';

export interface TransitWorldPoint {
  readonly x: number;
  readonly z: number;
}

export interface TransitAssignment {
  readonly slotId: number;
  readonly route: ResolvedTransitRoute;
  /** World-space polyline (mapToWorld'd) — pass straight through as one entry of
   * StreetcarController's `avenues` array. */
  readonly avenue: readonly TransitWorldPoint[];
  /** Short board label ("97 YONGE") — routeBoardAtlas.ts renders this verbatim. */
  readonly label: string;
  /** Starting phase along the route cycle, 0..1 — slots sharing a route are spread evenly
   * (rank / shareCount) so duplicate assignments never spawn co-located/lockstep (live-found
   * Phase 31: three route-97 buses superimposed at cycle-distance 0). Passed through as
   * StreetcarControllerOptions.startFracs. */
  readonly startFrac: number;
}

function weightForRoute(id: string): number {
  const base = TORONTO_TRANSIT_WEIGHTING.defaultWeight;
  return TORONTO_TRANSIT_WEIGHTING.showpieceRouteIds.includes(id)
    ? base * TORONTO_TRANSIT_WEIGHTING.showpieceWeightMultiplier
    : base;
}

/** Seeded weighted pick over `pool` (non-empty) — same weighted-pick shape as
 * vehicles/carVariety.ts's local weightedPick, re-implemented here (that helper isn't exported
 * and this module's weight function is route-id-keyed, not a generic `weightOf` field lookup). */
function weightedPickRoute(rng: Rng, pool: readonly ResolvedTransitRoute[]): ResolvedTransitRoute {
  let total = 0;
  for (const r of pool) total += weightForRoute(r.id);
  let roll = rng.next() * total;
  for (const r of pool) {
    roll -= weightForRoute(r.id);
    if (roll <= 0) return r;
  }
  return pool[pool.length - 1];
}

/** Assigns `count` transit-vehicle slots of `mode` to seeded, weighted route picks (with
 * repeats). Deterministic in `seed` (same seed -> identical assignment, in order). Empty when
 * `count <= 0` or no route of `mode` resolved (defensive — mirrors ai/streetcarTraffic.ts's own
 * "no avenues data -> zero roster, permanently" contract). */
export function assignTransitRoster(mode: TransitMode, count: number, seed: number): readonly TransitAssignment[] {
  if (count <= 0) return [];
  const routes = buildTransitRoutes().filter((r) => r.mode === mode);
  if (routes.length === 0) return [];
  const rng = createRng(seed).fork(`transit-${mode}`);
  const picks: ResolvedTransitRoute[] = [];
  for (let slotId = 0; slotId < count; slotId++) picks.push(weightedPickRoute(rng, routes));
  // Spread slots sharing a route evenly along its cycle (see TransitAssignment.startFrac).
  const shareCount = new Map<string, number>();
  for (const r of picks) shareCount.set(r.id, (shareCount.get(r.id) ?? 0) + 1);
  const rankSoFar = new Map<string, number>();
  return picks.map((route, slotId) => {
    const rank = rankSoFar.get(route.id) ?? 0;
    rankSoFar.set(route.id, rank + 1);
    return {
      slotId,
      route,
      avenue: routeWorldPoints(route),
      label: `${route.id} ${route.name.toUpperCase()}`,
      startFrac: rank / (shareCount.get(route.id) ?? 1),
    };
  });
}

/** The mount-captured bus roster for `seed`/`tier` (config/torontoTransit.ts's per-tier table). */
export function torontoBusTransitRoster(seed: number, tier: QualityTier): readonly TransitAssignment[] {
  return assignTransitRoster('bus', torontoBusRoster(tier), seed);
}

/** The mount-captured streetcar roster for `seed`/`tier`. */
export function torontoStreetcarTransitRoster(seed: number, tier: QualityTier): readonly TransitAssignment[] {
  return assignTransitRoster('streetcar', torontoStreetcarRoster(tier), seed);
}
