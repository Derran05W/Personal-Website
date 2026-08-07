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

import { CAR_REF, colliderHalfExtents } from './cityPackScale';
import { TRAFFIC_STREETCAR, type StreetcarTuning } from './streetcar';
import { LANE_OFFSET_WU, type RoadClass } from './torontoMap';
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

/**
 * Perpendicular geometry for a STREETCAR route's resolved track (D2: "median for streetcar ROW
 * segments").
 *
 * PHASE 31 (the reasoning this block has always carried, preserved): streetcars ran the true
 * median/centreline — a literal 0 offset. Spadina/Queens Quay have a REAL streetcar ROW median in
 * reality, and since the street model has no separate curb-lane data for streetcars, every
 * streetcar route shared that one centreline convention (a documented simplification, not a bug —
 * phase-31-notes.md). BUS routes do not read this block: Phase 31's lane-offset fix moved buses
 * onto the direction-correct, per-class LANE_OFFSET_WU lane (config/torontoMap.ts — the SAME
 * civilian lane geometry roadGraph.ts's traffic graph uses), resolved as a closed loop
 * (world/toronto/transitRoutes.ts's resolveBusLoop) instead of a single fixed kerb offset driven
 * there-and-back — the old constant kerb offset made a bus's return leg drive the oncoming lane
 * (live-diagnosed wrong-way bug).
 *
 * PHASE 75 — THE 0 IS NOW A BUG, so it is replaced by a DERIVATION (streetcarTrackOffsetWu
 * below). The road re-grade planted a one-car-wide grass median down the spine and the arteries
 * (config/torontoMap.ts's ROAD_MEDIAN), and the true centreline is now the middle of that planted
 * strip: 510 Spadina — an artery route — would have driven the whole line through the grass, and
 * every other streetcar route would have straddled the centre of a 17.6 wu road that no longer has
 * anything down the middle of it.
 *
 * WHERE THE TRACK GOES — the INNER lane, NOT the bus/civilian lane. Rejected alternative first:
 * putting streetcars on LANE_OFFSET_WU (sharing the bus lane) is wrong three times over.
 * (1) Phase 75 D5 keeps ONE lane per direction, so "sharing" means OCCUPYING it, and a streetcar
 * is a kinematic IMPLACABLE body that stops dead and never creeps (config/streetcar.ts) — parking
 * one on the only lane chain is the exact immovable-obstacle-in-a-single-lane failure the feel
 * overhaul's D2 is about. (2) A streetcar route is an OPEN there-and-back polyline ('bounce'), not
 * a direction-correct loop, so on a shared lane its return leg would drive the oncoming lane — the
 * Phase 31 wrong-way bug, re-introduced. (3) Real streetcars run the innermost lane (or a centre
 * ROW) anyway, never the kerb lane the buses use.
 *
 * So the track sits in the strip the traffic graph leaves EMPTY: between the inner kerb (the
 * median edge, or the centreline on a class that carries none) and the traffic lane's inner flank.
 * That strip is real asphalt no lane chain, bus loop or parked row occupies, which makes it a
 * de-facto dedicated ROW — the Spadina/Queens Quay read, for free, on every route. The bounce
 * still shares ONE physical track in both directions (unchanged from Phase 31's simplification —
 * a single-track line), but it can no longer meet civilian traffic head-on in a lane, because it
 * is not in a lane.
 */
export const TORONTO_TRANSIT_OFFSET = {
  /**
   * Which side of the centreline the shared single track sits on. +1 is +x on an 'ns' street
   * (east) and +y on an 'ew' street (south) — world/toronto/transitRoutes.ts's `pointAt`
   * convention. A CONSTANT, not a per-direction sign: one track, driven both ways (see above).
   * The side is arbitrary by construction — the strip is symmetric about the centreline and empty
   * on both sides — so this is a convention, not a tuning.
   */
  streetcarTrackSign: 1,
} as const;

/**
 * PHASE 75 — the streetcar track's perpendicular offset (wu) from a street's centreline: the
 * MIDPOINT of the empty strip between the inner kerb and the traffic lane, i.e.
 *
 *     (medianHalfWidth + [LANE_OFFSET_WU[cls] − CAR_REF.widthWu / 2]) / 2
 *      ^ the inner kerb      ^ the traffic lane's inner flank (a car centred on the lane)
 *
 * Derived from the same three numbers the road itself is graded from — never hand-picked — so it
 * re-flows automatically if the widths, the median or the lane rule ever move again. Resolves to
 * spine 3.025 / artery 2.75 / major 1.65 / minor 1.1 at the Phase 75 widths, each with equal
 * clearance to the kerb it sits inside and to the traffic lane it sits inboard of.
 *
 * Takes the RESOLVED median half-width (world/toronto/streets.ts's `Street.medianHalfWidth`)
 * rather than re-deriving the class policy, so a street that ever opts a median in
 * (ROAD_MEDIAN.policy 'optIn') moves its streetcar track with it. Config never imports world/, so
 * the caller passes the number in.
 */
export function streetcarTrackOffsetWu(cls: RoadClass, medianHalfWidthWu: number): number {
  const trafficLaneInnerFlankWu = LANE_OFFSET_WU[cls] - CAR_REF.widthWu / 2;
  return (medianHalfWidthWu + trafficLaneInnerFlankWu) / 2;
}

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

/** Phase 41 (T3) pinned clearance the bus route board floats above the resolved bus roofline —
 * see ROUTE_BOARD.busHeightWu's doc comment. Frozen from today's numbers (3.6 - resolved
 * ~3.0996 = ~0.5004, rounded to 3 decimals); an arbitrary "sits visibly above the roof" gap, not
 * itself derivable from anything. */
export const ROUTE_BOARD_CLEARANCE_WU = 0.5;

/** Resolved bus roofline height (wu) — the SAME colliderHalfExtents('bus') resolver
 * busChassisHalfExtents() below already reads (Phase 25.5), doubled back to a full height. Kept
 * as its own tiny function (rather than inlined) so ROUTE_BOARD's derivation reads as "roofline +
 * clearance", matching the plain-English doc comment. */
function resolvedBusRoofHeightWu(): number {
  return colliderHalfExtents('bus').hy * 2;
}

/** Route-board board plate size (wu) — a small nearest-neighbour CanvasTexture plane mounted
 * above each transit vehicle (D3: "small route-number board... number + short name only, NO
 * wordmark/logo"). */
export const ROUTE_BOARD = {
  widthWu: 2.2,
  heightWu: 0.9,
  /** Height (wu) above the vehicle's own ground-up origin the board's centre sits at.
   * Phase 41 (T3) — DERIVED: `resolvedBusRoofHeightWu() + ROUTE_BOARD_CLEARANCE_WU`, read live off
   * the same manifest-backed resolver `busChassisHalfExtents()` already uses, so a manifest regen
   * or a BUS_TARGET_LENGTH_WU retune (config/cityPackScale.ts) can never silently leave this board
   * floating inside the roof or drifting away from it uncaught — the traffic-light headAnchor's
   * exact Phase 27 drift failure mode (config/torontoDress.ts LAMP_OVERLAY), fixed the same way
   * here. anchorPins.test.ts pins the resolved value + proves the derivation reads the manifest. */
  busHeightWu: resolvedBusRoofHeightWu() + ROUTE_BOARD_CLEARANCE_WU,
  /** Stays a hand literal: the streetcar is an in-house model (config/streetcar.ts /
   * TRAFFIC_STREETCAR), not a city-pack manifest entry — there is no resolver to derive it from. */
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
