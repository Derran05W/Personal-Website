// Toronto map v2 — road-class widths, render colours, graph tuning, and the spawn point.
// Single source of truth for the "thermometer" street grid. Consumed by world/toronto/streets.ts
// (street table + ribbons) and roadGraph.ts (traffic graph). Pure data, no three/react —
// deterministic.
//
// PHASE 25.6 SUPERSESSION (D1, CLAUDE.md CITY-PACK REAPPROACH rule 4): the spec's §3a width
// table (docs/map/TORONTO-MAP-SPEC-v2.md — see the addendum at that table) and its A.6
// "defer exact widths to playtest" note are formally superseded. Widths are now DERIVED from
// CAR_REF.widthWu (config/cityPackScale.ts — the same sedan-envelope reference the city-pack
// scale system uses), whole-car-graded so every class reads as an intuitive "N cars wide" and
// the class ordering (spine > artery > major > minor) still makes Yonge read first (§2). A.6's
// tune path survives in spirit: if the 3.5-car minor (7.7 wu) clips during drifts, widen it to
// 4 cars (8.8) and re-test before touching anything else — nothing downstream is hand-pinned
// (streets/districts/roadGraph/named/places/tunnel are all street-referenced, so a width edit
// here alone re-flows the whole map).

import { CAR_REF } from './cityPackScale';

export const ROAD_CLASSES = {
  spine: CAR_REF.widthWu * 7, // Yonge — 7 player-car widths = 15.4
  artery: CAR_REF.widthWu * 6, // University, Bloor, Spadina — 6 cars = 13.2
  major: CAR_REF.widthWu * 5, // King/Queen/Dundas/College/Front/Bay/Church/Jarvis/Bathurst/Finch/Sheppard/QueensQuay — 5 cars = 11.0
  minor: CAR_REF.widthWu * 3.5, // Richmond/Adelaide/John/Portland/York/Bremner/ParkHome — 3.5 cars = 7.7
} as const;

export type RoadClass = keyof typeof ROAD_CLASSES;

/**
 * Per-class asphalt colours. Tuned in the Phase 22 live pass. These render UNLIT with tone
 * mapping off (TorontoScene) — the hex below IS the on-screen colour, chosen on a strict
 * contrast ladder: canvas void (#121a2b, darkest) < asphalt (below) < ground (#454b54,
 * lightest) < curb strips (ROAD_EDGE). Spine lightest of the asphalts so Yonge reads
 * first; class grades downward from there.
 */
export const ROAD_COLORS = {
  spine: '#343b46',
  artery: '#303741',
  major: '#2c323c',
  minor: '#282e37',
} as const satisfies Record<RoadClass, string>;

/**
 * Light curb strips along each ribbon's long edges (Phase 22 live-pass finding, re-graded
 * Phase 25.6 D2 for the car-derived ribbon widths): even at the narrower 15.4 wu spine, ON the
 * road the frame is close to a single flat colour without edge lines. Rendered into the same
 * merged unlit geometry as the ribbons.
 *
 * D2 re-grain: curb 1.4 -> 0.8 and the dash proportionally thinner (0.4 wu wide total —
 * previously a full 1.1 wu, literally half a car) — both scaled down with the narrower
 * ribbons so the paint doesn't dominate a 7.7 wu minor the way it did a 36 wu spine.
 */
export const ROAD_EDGE = {
  widthWu: 0.8,
  color: '#7e8791',
  // Centre-line dashes: the near-frame readability anchor — curbs sit at the frame edges
  // on the 36 wu spine, but the dashes stay dead-centre under the car at every speed.
  // 4/5 wu length/gap pattern, 0.4 wu total width (2 x halfWidthWu).
  dash: {
    lengthWu: 4,
    gapWu: 5,
    halfWidthWu: 0.2,
    color: '#b8a86a',
  },
} as const;

/**
 * Sidewalk band along every ribbon edge, OUTSIDE the curb strip (Phase 25.6 D2/D20 seam #2).
 * Not part of the road ribbon itself — a flat merged quad strip that gives pack-building
 * frontage rows (D6) and street furniture (D16) a surface to sit on, and the near-frame
 * readability the narrower re-grained ribbons need at street edges. Contrast ladder (unlit
 * palette, TorontoScene): canvas void (#121a2b) < asphalt (ROAD_COLORS) < ground (#454b54) <
 * sidewalk (below) < curb (ROAD_EDGE.color, brightest, right at the road/sidewalk seam).
 */
export const SIDEWALK = {
  widthWu: 4,
  color: '#565e68',
} as const;

/**
 * Painted crosswalk band across each SIGNALIZED intersection approach (Phase 25.6 D2, D20 seam
 * #1). This constant owns only the stripe geometry/colour numbers — placement is derived at
 * mount time from roadGraph.ts's `listIntersections` (the crossing point + both streets'
 * classes) by the road-paint builder, keyed the same way MegaKit's road-paint decal meshes
 * would eventually replace this quad emission. The band sits just outside the intersection box
 * (see the dash-skip rule below) and spans the full ribbon width of the approach it belongs to.
 */
export const CROSSWALK = {
  /** Depth of the painted band along the direction of travel (wu). */
  bandWu: 3,
  /** Individual stripe width, stripes run parallel to the direction of travel (wu). */
  stripeWidthWu: 0.5,
  /** Gap between adjacent stripes (wu). */
  stripeGapWu: 0.5,
  /** Gap left between the intersection box edge and the near edge of the band (wu). */
  setbackWu: 1,
  color: '#c7c4ba',
} as const;

/**
 * Dash-skip rule (Phase 25.6 D2): centre-line dashes are OMITTED inside every intersection box
 * — for a street being dashed, that's the region within the CROSS street's halfWidth of the
 * crossing point (`ROAD_CLASSES[crossStreet.cls] / 2` on each side). Deliberately not its own
 * constant: the box is derived from the same ROAD_CLASSES table the ribbons themselves use, so
 * there stays exactly one source for "how wide is an intersection". Applied by the road-paint
 * builder against roadGraph.ts's `listIntersections`.
 */

/** Target spacing (wu) between adjacent traffic-graph nodes along a street between crossings. */
export const WAYPOINT_SPACING_WU = 40;

/** How far a street's ends stop short of the polygon/zone edge it runs up against (wu). */
export const EDGE_PAD_WU = 14;

/**
 * Player spawn — a map-space point on Yonge just south of Finch (§2), facing south. South is
 * map +y, which maps to world +Z (see projection.mapToWorld); in the codebase's
 * `atan2(dx, dz)` yaw convention (world +Z is forward) south is yaw 0. Task 4's scene converts
 * this map point through mapToWorld and orients the car to `heading`.
 */
export const TORONTO_SPAWN = {
  x: 1500,
  y: 220,
  /** Unit heading in MAP space: +y = south. */
  heading: { x: 0, y: 1 },
} as const;
