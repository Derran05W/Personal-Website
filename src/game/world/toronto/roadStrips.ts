// PHASE 75 (T4) — THE PURE STRIP ALGEBRA the road paint and the median planting share.
//
// `roadPaint.ts` owns the road's GEOMETRY (it builds a THREE.BufferGeometry). This module owns the
// question that geometry answers first: *which along-street intervals of which street does a strip
// actually occupy* — the interval algebra, the ribbon-union precedence, the crossing cut-outs, and
// (new at T4) `medianBandRuns`, the single derivation of WHERE THERE IS GRASS on a median.
//
// WHY IT IS ITS OWN MODULE, and why it must stay three-free: the median planting is placed by
// `world/toronto/furniture.ts`, which is a documented pure-TS layer ("no three/react") feeding the
// pure composition root `composeWorld.ts` (same contract). A planter may only stand where the paint
// actually emits grass, so the placer has to read the SAME segments the emitter does — and it can
// only do that if the derivation lives below the geometry. Re-deriving the cut-outs in the placer
// would be a second source of truth for "where is the median", i.e. exactly the drift the Phase 40
// arbiter exists to prevent: the paint and the planting would disagree the first time either
// setback moved, and a planter would float on bare asphalt at a crossing.
//
// Everything here moved verbatim from roadPaint.ts (Phase 75 T1), which re-exports the names its
// own tests and TorontoScene already import, so no call site changed.

import { CROSSWALK, LANE_OFFSET_WU, ROAD_CLASSES, WAYPOINT_SPACING_WU } from '../../config/torontoMap';
import { CAR_REF } from '../../config/cityPackScale';
import type { Intersection } from './roadGraph';
import type { MapRect, Street } from './streets';

/** Closed interval along a street's own axis. */
export type Interval = readonly [number, number];

/** Drop raised/painted slivers shorter than this (a raised nub reads as noise). */
export const MIN_SEGMENT_WU = 2;

/** Extra gap each side of a crossing box where the raised SIDEWALK band stops (wu) — room for the
 * crosswalk to land on bare asphalt. */
export const CURB_CUT_SETBACK_WU = 1.0;

/**
 * PHASE 75 — extra gap each side of a crossing box where the MEDIAN stops (wu), measured beyond the
 * cross street's half-width exactly like CURB_CUT_SETBACK_WU. Deeper than the sidewalk's cut for a
 * concrete reason: the zebra bands sit at `CROSSWALK.setbackWu` past the box and are
 * `CROSSWALK.bandWu` deep, and a raised 0.12 wu grass strip would BURY the 0.048 wu zebra rung it
 * crosses (occlusion, not z-fight — but the crossing would read as interrupted by a lawn). The
 * median resumes one sidewalk-setback beyond the far edge of the painted band, so every zebra lands
 * on bare asphalt. Derived from the crosswalk geometry, never a picked number.
 */
export const MEDIAN_CUT_SETBACK_WU = CROSSWALK.setbackWu + CROSSWALK.bandWu + CURB_CUT_SETBACK_WU;

/**
 * PHASE 75 — the traffic graph's `MIN_SEGS`, mirrored. roadGraph.ts subdivides every inter-hub gap
 * into `max(MIN_SEGS, round(gap / WAYPOINT_SPACING_WU))` steps per direction. The value is private
 * there and this is a deliberate, LAW-TESTED mirror rather than an import: the road strips have no
 * other business reading the traffic graph, and roadPaint.test.ts measures every realised step at a
 * median terminus off the real built graph and fails if this mirror (or the bound below) drifts.
 */
const GRAPH_MIN_STEPS_PER_GAP = 2;

/**
 * PHASE 75 — the longest single inter-hub STEP the graph can realise (wu). `gap / n` with
 * `n = max(MIN_SEGS, round(gap / SPACING))` is largest at a rounding boundary, where
 * `gap = (n + 0.5) x SPACING` gives a step of `SPACING x (n + 0.5) / n`. That decreases in n, so
 * the maximum sits at the smallest legal n — the MIN_SEGS floor — i.e. 1.25 x SPACING.
 */
export const MAX_GRAPH_STEP_WU = (WAYPOINT_SPACING_WU * (GRAPH_MIN_STEPS_PER_GAP + 0.5)) / GRAPH_MIN_STEPS_PER_GAP;

/**
 * PHASE 75 — how far short of a street's own END the median stops (wu).
 *
 * A street's terminus is a HUB, and roadGraph.ts's hubs sit on the bare centreline (unoffset, so
 * turns and BFS connectivity stay shared) while the waypoints between hubs are laterally offset
 * into their travel lane. A car leaving a terminus therefore swings from the centreline out to
 * `LANE_OFFSET_WU[cls]` over the first step — and on a median street that swing STARTS INSIDE THE
 * GRASS. Running the strip to the tip would put a kerb across the one manoeuvre every departure
 * from that end has to make.
 *
 * Derived, per street, from the geometry of that swing: the transition crosses the strip edge at
 * along-fraction `medianHalfWidth / laneOffset` of its step, and the car's own body has to clear
 * too, so
 *
 *     inset = (medianHalfWidth / laneOffset) x MAX_GRAPH_STEP_WU + CAR_REF.lengthWu / 2
 *
 * — 11.34 wu on the spine, 12.25 on an artery. Both sit above every measured requirement at the
 * five real dead-end tips (Yonge 10.43 / 4.67, Spadina 6.31, Bloor 7.39 / 9.79) because the step
 * term is a worst-case BOUND rather than each tip's own gap: one formula, no per-street literals,
 * and roadPaint.test.ts measures the real requirement off the built graph and asserts the cover.
 *
 * Applied at BOTH ends unconditionally. A terminus that is really a junction (University's two
 * ends, Spadina's north) already loses more than this to MEDIAN_CUT_SETBACK_WU, so the extra
 * exclusion is a no-op there and no tip has to be classified.
 */
export function medianTerminusInsetWu(street: Street): number {
  if (street.medianWidth <= 0) return 0;
  return (street.medianHalfWidth / LANE_OFFSET_WU[street.cls]) * MAX_GRAPH_STEP_WU + CAR_REF.lengthWu / 2;
}

// --- interval algebra (shared by every strip-shaped emitter) --------------------------------

/** Merge a set of intervals into a sorted, disjoint set. */
export function mergeIntervals(ivs: readonly Interval[]): Interval[] {
  const sorted = [...ivs].sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const iv of sorted) {
    const last = merged[merged.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else merged.push([iv[0], iv[1]]);
  }
  return merged;
}

/** `[lo,hi]` minus `excluded`, dropping any remainder shorter than `minLen`. THE one subtraction
 * every strip-shaped emitter runs (sidewalk bands, median bands, curb strips) so a segment can
 * never be computed two slightly different ways. */
export function freeIntervals(lo: number, hi: number, excluded: readonly Interval[], minLen: number): Interval[] {
  const free: [number, number][] = [];
  let cursor = lo;
  for (const [elo, ehi] of mergeIntervals(excluded)) {
    if (elo > cursor) free.push([cursor, Math.min(elo, hi)]);
    cursor = Math.max(cursor, ehi);
    if (cursor >= hi) break;
  }
  if (cursor < hi) free.push([cursor, hi]);
  return free.filter(([a, b]) => b - a >= minLen);
}

export function insideAnyInterval(v: number, ivs: readonly Interval[]): boolean {
  return ivs.some(([a, b]) => v > a && v < b);
}

// --- the ribbon union (Phase 75) --------------------------------------------------------------

/**
 * Ribbon precedence: **wider class wins, ties broken by street id**. Lower number = outranks. This
 * is the class ordering (spine > artery > major > minor) that config/torontoMap.ts already
 * law-tests, read off the widths themselves rather than re-typed as a second rank table.
 *
 * THE TIE-BREAK IS NOT ARBITRARY — it is `roadGraph.ts`'s. Phase 75's traffic-graph work landed
 * `swallowedSpans()`, which decides the same "who yields" question for LANE CHAINS using
 * `other.width > street.width || (equal && other.id < street.id)`. The two modules ask different
 * questions on purpose — the render union asks "does any ground get painted twice?" (rect overlap,
 * including every perpendicular intersection box), the graph asks "is this still an independent
 * carriageway?" (centreline containment) — but they must never disagree about WHICH street of a
 * pair gives way, or the graph would suppress York's lanes while the render clipped Bay's asphalt.
 * Ordering by id rather than by table position makes the two rules name the same winner by
 * construction; `roadPaint.test.ts` proves it against `swallowedSpans` directly, and proves the
 * subsumption (everything the graph calls swallowed, the union has already taken away).
 *
 * WHY A UNION AT ALL — and why we LET BAY AND YORK MERGE. Bay St and York St sit 7.52 wu apart on
 * the Part-8-compacted map (a projection artifact of the Bay/York proxy anchors that
 * namedBuildings.ts has worked around since Phase 24). At Phase 75's doubled widths Bay's half-
 * width alone (8.8) exceeds that gap, so Bay's ribbon COVERS York's centreline entirely and the two
 * rectangles overlap by 7.88 wu over York's whole 313 wu span. They were already tangent at −0.18 wu
 * before this phase, so this is a pre-existing compaction artifact that doubling merely exposes.
 *
 * The alternatives were both closed: shrinking either street is geometrically impossible (Bay's
 * half-width alone eats the gap) and deleting a street is forbidden by the phase's scope. So the
 * decision is to LET THEM MERGE into one wide asphalt expanse — which is what a 7.5 wu-apart pair
 * of downtown streets would actually look like — and to make that merge STRUCTURALLY SOUND rather
 * than accidental: exactly one asphalt quad covers any given patch of ground. Note York's WEST
 * frontage line is well outside Bay's ribbon and is untouched, so the named buildings there
 * (RBC/CIBC Square, which already hug York's edge for the same anchor reason) are unaffected.
 */
export function ribbonPrecedence(streets: readonly Street[]): ReadonlyMap<string, number> {
  const ordered = streets
    .map((s) => ({ id: s.id, width: s.width }))
    .sort((a, b) => b.width - a.width || (a.id < b.id ? -1 : 1));
  return new Map(ordered.map((o, rank) => [o.id, rank] as const));
}

export function rectsOverlap(a: MapRect, b: MapRect): boolean {
  return a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;
}

/** Every ribbon that outranks `street` and actually overlaps its rectangle. Used by the emitters
 * that describe a street's OWN surface — asphalt, centre dashes, the median — where only the
 * loser of the overlap yields. */
export function higherRibbons(street: Street, streets: readonly Street[], rank: ReadonlyMap<string, number>): Street[] {
  const own = rank.get(street.id)!;
  return streets.filter((o) => o.id !== street.id && rank.get(o.id)! < own && rectsOverlap(o.ribbon, street.ribbon));
}

/**
 * Every PARALLEL ribbon that overlaps `street`'s rectangle, regardless of rank. Used by the
 * emitters that mark where a road ENDS — the raised sidewalk band and the painted curb strip —
 * because those are wrong inside anybody's asphalt, including the winner's.
 *
 * Concretely: on the Bay/York merge, rank alone would drop York's west sidewalk (correct) but keep
 * BAY's east sidewalk, which stands on the strip of York's carriageway that survived the union —
 * a raised kerb in the middle of the merged expanse, and precisely what roadPaint.test.ts's
 * "every collider box sits OUTSIDE every ribbon" invariant has been exempting since Part-8.
 */
export function parallelRibbons(street: Street, streets: readonly Street[]): Street[] {
  return streets.filter((o) => o.id !== street.id && o.axis === street.axis && rectsOverlap(o.ribbon, street.ribbon));
}

/**
 * The along-street intervals over which a strip of `street`'s own paint, occupying the
 * PERPENDICULAR range `[pLo, pHi]`, lies inside a higher-ranked PARALLEL ribbon — i.e. where that
 * paint would be drawn on somebody else's asphalt. Pass `pLo === pHi` for a zero-width strip (the
 * centreline dashes) and the test becomes strict containment of that single coordinate.
 *
 * Only PARALLEL covers are considered: a perpendicular ribbon's overlap is an intersection box,
 * which every emitter handles by its own rule (dashes skip it, the sidewalk band cuts out for the
 * curb cut, and the curb strips deliberately run straight through — paint on a higher rung over
 * whichever asphalt won the box, never coplanar with it).
 */
export function coveredAlong(street: Street, covers: readonly Street[], pLo: number, pHi: number): Interval[] {
  const out: Interval[] = [];
  for (const c of covers) {
    if (c.axis !== street.axis) continue;
    const cPerp: Interval = street.axis === 'ew' ? [c.ribbon.minY, c.ribbon.maxY] : [c.ribbon.minX, c.ribbon.maxX];
    const disjoint = pLo === pHi ? pLo <= cPerp[0] || pLo >= cPerp[1] : pHi <= cPerp[0] || pLo >= cPerp[1];
    if (disjoint) continue;
    out.push(street.axis === 'ew' ? [c.ribbon.minX, c.ribbon.maxX] : [c.ribbon.minY, c.ribbon.maxY]);
  }
  return out;
}

// --- crossings --------------------------------------------------------------------------------

/** One place a street is crossed: the along-coordinate on its own axis + the intersection box's
 * half-span there (the CROSSING street's own half-width). */
export interface RoadCrossing {
  readonly along: number;
  readonly crossHalf: number;
}

/** Along-coords of every crossing on `street` + the cross street's half-width there. */
export function crossingsOn(street: Street, intersections: readonly Intersection[]): RoadCrossing[] {
  return intersections
    .filter((c) => (street.axis === 'ns' ? c.nsId === street.id : c.ewId === street.id))
    .map((c) => ({
      along: street.axis === 'ns' ? c.y : c.x,
      crossHalf: ROAD_CLASSES[street.axis === 'ns' ? c.ewCls : c.nsCls] / 2,
    }));
}

export function insideAnyIntersection(along: number, crossings: readonly RoadCrossing[]): boolean {
  return crossings.some((c) => Math.abs(along - c.along) < c.crossHalf);
}

/** The intersection boxes of `street`, widened by `setbackWu` on each side, as intervals. */
export function crossingBoxes(crossings: readonly RoadCrossing[], setbackWu: number): Interval[] {
  return crossings.map((c): Interval => [c.along - c.crossHalf - setbackWu, c.along + c.crossHalf + setbackWu]);
}

// --- the median band (Phase 75) -----------------------------------------------------------------

/**
 * One street's grass median, as pure data: the perpendicular centre it straddles, its half-width,
 * and the along-street segments that ACTUALLY carry grass — crossing cut-outs, terminus insets and
 * higher-ranked-ribbon covers all already removed.
 */
export interface MedianBandRun {
  readonly street: Street;
  /** Perpendicular coordinate of the strip's centreline (map x for 'ns', map y for 'ew'). */
  readonly centre: number;
  /** Half the strip's width (wu) — the strip spans `centre ± half`. */
  readonly half: number;
  readonly segments: readonly Interval[];
}

/**
 * THE one derivation of "where is there median grass", shared by the paint that draws it
 * (roadPaint.ts's `buildRoadGeometry`) and the planting that stands on it (furniture.ts's
 * `buildMedianPlanting`). Streets with no median produce no run at all.
 *
 * Three exclusions, in the order the strip meets them:
 *   1. CROSSINGS — each intersection box widened by MEDIAN_CUT_SETBACK_WU, so every zebra band
 *      lands on bare asphalt rather than on a raised lawn.
 *   2. HIGHER-RANKED PARALLEL RIBBONS — the ribbon-union rule every other emitter obeys. No median
 *      street is covered by one today (spine/artery are the only median classes), but the rule is
 *      applied rather than assumed away.
 *   3. TERMINUS INSETS — `medianTerminusInsetWu` at BOTH span ends, clearing the centreline-hub →
 *      offset-lane swing a car makes leaving a dead end.
 */
export function medianBandRuns(streets: readonly Street[], intersections: readonly Intersection[]): MedianBandRun[] {
  const rank = ribbonPrecedence(streets);
  const runs: MedianBandRun[] = [];
  for (const street of streets) {
    if (street.medianWidth <= 0) continue;
    const r = street.ribbon;
    const isEw = street.axis === 'ew';
    const [lo, hi] = isEw ? [r.minX, r.maxX] : [r.minY, r.maxY];
    const centre = isEw ? (r.minY + r.maxY) / 2 : (r.minX + r.maxX) / 2;
    const half = street.medianHalfWidth;
    const covers = higherRibbons(street, streets, rank);
    const covered = coveredAlong(street, covers, centre - half, centre + half);
    const inset = medianTerminusInsetWu(street);
    const segments = freeIntervals(
      lo,
      hi,
      [...crossingBoxes(crossingsOn(street, intersections), MEDIAN_CUT_SETBACK_WU), ...covered, [lo, lo + inset], [hi - inset, hi]],
      MIN_SEGMENT_WU,
    );
    if (segments.length > 0) runs.push({ street, centre, half, segments });
  }
  return runs;
}
