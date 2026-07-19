// Phase 31 (Part-8 D1-D5) — TTC-homage transit tunables: tier-scaled roster sizes, the seeded
// route-weighting bias, per-mode geometry offsets, and the two StreetcarController tunings
// (bus/streetcar) the resolver + roster + mount modules consume. No magic numbers in
// world/toronto/transitRoutes.ts / transitRoster.ts / the mount/mesh components — everything
// tunable lives here, same house rule as every other Toronto config block.
//
// NOT registered in config/index.ts's CONFIG registry (leva) — same precedent as
// config/torontoTraffic.ts / config/torontoDress.ts: every Toronto-map tunable is captured ONCE
// at mount (seed/tier), never live-mutated mid-run, so it stays outside the legacy-world live
// leva panel by design (see torontoDress.ts's TorontoTierParams doc comment).

import { colliderHalfExtents } from './cityPackScale';
import { TRAFFIC_STREETCAR, type StreetcarTuning } from './streetcar';
import type { QualityTier } from './quality';

/** Tier-scaled active roster size per mode (Part-8 table: "10-14 active, tier-scaled"; this
 * phase's plan pins 12/9/6 total — split bus-heavy, matching real TTC's bus:streetcar service
 * ratio, while keeping both modes represented at every tier). Explicit per-tier tables (not
 * derived via trafficActiveTarget's generic modifier) — same idiom as config/torontoTraffic.ts's
 * rosterByTier — because 12/9/6 don't fall out of the shared {high:1, med:0.83, low:0.67}
 * modifier and the plan states them as literal targets. */
export const TORONTO_TRANSIT_ROSTER = {
  bus: { high: 8, med: 6, low: 4 },
  streetcar: { high: 4, med: 3, low: 2 },
} as const satisfies Record<'bus' | 'streetcar', Record<QualityTier, number>>;

export function torontoBusRoster(tier: QualityTier): number {
  return TORONTO_TRANSIT_ROSTER.bus[tier];
}

export function torontoStreetcarRoster(tier: QualityTier): number {
  return TORONTO_TRANSIT_ROSTER.streetcar[tier];
}

/** Seeded weighted route pick (D2: "spread across routes by seeded pick weighted toward
 * 97/501/504/510" — the showpiece full-spine/full-downtown rides). Every other route in the
 * mode's pool shares `defaultWeight`; a showpiece route's weight is multiplied by
 * `showpieceWeightMultiplier`. */
export const TORONTO_TRANSIT_WEIGHTING = {
  showpieceRouteIds: ['97', '501', '504', '510'] as readonly string[],
  showpieceWeightMultiplier: 3,
  defaultWeight: 1,
} as const;

/** Perpendicular offset (wu) applied to a STREETCAR route's resolved centreline (D2: "median for
 * streetcar ROW segments"). Streetcars run the true median/centreline (0 offset) on every
 * streetcar street — Spadina/Queens Quay have a REAL streetcar ROW median in reality, but since
 * our street model has no separate curb-lane data for streetcars, every streetcar route shares
 * the same centreline convention (a documented simplification, not a bug — see
 * phase-31-notes.md). BUS routes no longer read this: Phase 31's lane-offset fix moved buses onto
 * the direction-correct, per-class LANE_OFFSET_WU lane (config/torontoMap.ts — the SAME civilian
 * lane geometry roadGraph.ts's traffic graph uses), resolved as a closed loop
 * (world/toronto/transitRoutes.ts's resolveBusLoop) instead of a single fixed kerb offset driven
 * there-and-back — the old constant kerb offset made a bus's return leg drive the oncoming lane
 * (live-diagnosed wrong-way bug). */
export const TORONTO_TRANSIT_OFFSET = {
  streetcarOffsetWu: 0,
} as const;

/** TTC-homage livery colours (D3: "red/white body tint" + a route board). Reused as the single
 * flat tint every bus body wears (a two-tone texture isn't available without a pipeline-side
 * neutral-body GLB variant for 'bus' — T2's scripts/city-pack.mjs territory, out of scope here);
 * the board's white background + these same hexes for its border/number carry the "red/white"
 * read the rest of the way. */
export const TTC_LIVERY = {
  busBodyHex: '#e7e3da',
  busAccentHex: '#a6192e',
  boardBackgroundHex: '#f2efe6',
  boardNumberHex: '#a6192e',
  boardNameHex: '#1c1c1c',
} as const;

/** Route-board board plate size (wu) — a small nearest-neighbour CanvasTexture plane mounted
 * above each transit vehicle (D3: "small route-number board... number + short name only, NO
 * wordmark/logo"). */
export const ROUTE_BOARD = {
  widthWu: 2.2,
  heightWu: 0.9,
  /** Height (wu) above the vehicle's own ground-up origin the board's centre sits at. */
  busHeightWu: 3.6,
  streetcarHeightWu: 3.9,
} as const;

/** Bus tuning (StreetcarTuning-shaped — see config/streetcar.ts's doc comment): lighter, faster,
 * more agile than the in-house streetcar tuning, tuned relative to it and to
 * config/world.ts's TRAFFIC_CIV (a regular civilian car) so a bus reads as heavier than a car but
 * far nimbler than a streetcar-on-rails. `activeTarget` is informational only here — the
 * StreetcarController is constructed with `exactRosterSize: true` for Toronto transit, which
 * sizes the roster directly off the (seeded, pre-assigned) avenues array length instead of
 * re-deriving it via trafficActiveTarget (see ai/streetcarTraffic.ts's constructor doc comment). */
export const TTC_BUS_TUNING: StreetcarTuning = {
  activeTarget: TORONTO_TRANSIT_ROSTER.bus.high,
  speedMps: 8,
  blockRayLengthM: 9,
  convertForceThreshold: 1400,
  hp: 55,
  wreckUpDot: 0.3,
  wreckFlipSustainSec: 1.5,
  wreckLingerSec: 10,
  massKg: 2400,
  dynamicLinDamping: 0.5,
  dynamicAngDamping: 0.6,
  convertKickScale: 0.6,
  turnRateRadPerSec: 1.6,
  maxSpawnPerStep: 2,
} as const;

/** Streetcar tuning for Toronto transit reuses TRAFFIC_STREETCAR VERBATIM (the "3,600 kg
 * precedent" from the plan is this exact object — not a re-typed duplicate with the same
 * numbers). Kept as a named export so mount code never has to know it's the legacy constant
 * under the hood. */
export const TTC_STREETCAR_TUNING: StreetcarTuning = TRAFFIC_STREETCAR;

/** Bus collider/body half-extents (D2 chassis override), derived from the SAME
 * config/cityPackScale.ts resolver every world-prop pack model uses — never a duplicated
 * number. Mapped to the {halfWidth, halfHeight, halfLength} shape ai/streetcarTraffic.ts's
 * StreetcarController expects for its chassis override. */
export function busChassisHalfExtents(): { halfWidth: number; halfHeight: number; halfLength: number } {
  const h = colliderHalfExtents('bus');
  return { halfWidth: h.hx, halfHeight: h.hy, halfLength: h.hz };
}
