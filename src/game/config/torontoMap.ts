// Toronto map v2 — road-class widths, render colours, graph tuning, and the spawn point.
// Single source of truth for the "thermometer" street grid (docs/map/TORONTO-MAP-SPEC-v2.md
// §3a). Consumed by world/toronto/streets.ts (street table + ribbons) and roadGraph.ts
// (traffic graph). Pure data, no three/react — deterministic.
//
// A.6 (spec) explicitly DEFERS exact road widths to playtest: the §3a table gives ranges
// (artery 32–34, major 26–30, minor 16–20); we pick the midpoints here and leave them
// live-tunable. If the minor class clips during drifts on the King & Bay / Yonge drive,
// widen `minor` to 20 and re-test before touching anything else (A.6's rule).

/**
 * Road-class ribbon widths in world-units (§3a). Deliberately oversized (~2–2.8× real) so
 * arcade Smashy-Road handling has room. `spine` (Yonge) is the widest — it must read as the
 * legible vertical that anchors the whole shape (§2).
 */
export const ROAD_CLASSES = {
  spine: 36, // Yonge — §3a fixed 36
  artery: 33, // University, Bloor, Spadina — §3a 32–34 midpoint
  major: 28, // King/Queen/Dundas/College/Front/Bay/Church/Jarvis/Bathurst/Finch/Sheppard/QueensQuay — §3a 26–30 midpoint
  minor: 18, // Richmond/Adelaide/John/Portland/York/Bremner/ParkHome — §3a 16–20 midpoint
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
 * Light curb strips along each ribbon's long edges (Phase 22 live-pass finding): §3a roads
 * are deliberately wider (36 wu spine) than the fixed camera's ~20-40 wu near footprint, so
 * ON the road the frame is a single flat colour — without edge lines there is literally
 * nothing to read. Rendered into the same merged unlit geometry as the ribbons.
 */
export const ROAD_EDGE = {
  widthWu: 1.4,
  color: '#7e8791',
  // Centre-line dashes: the near-frame readability anchor — curbs sit at the frame edges
  // on the 36 wu spine, but the dashes stay dead-centre under the car at every speed.
  dash: {
    lengthWu: 6,
    gapWu: 7,
    halfWidthWu: 0.55,
    color: '#b8a86a',
  },
} as const;

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
