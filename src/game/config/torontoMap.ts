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

/**
 * Part-8 (D1, user directive 2026-07-18 — "density/life flip"): the whole map compacts ~0.6×
 * linearly so the city reads dense rather than empty. `scale` is the ONE knob — projection.ts
 * derives every live control-y / zone-boundary / EW_M_PER_WU from it, and polygon.ts /
 * torontoSceneHelpers.ts re-derive their rects from the same source via `scaleAboutYonge`. The
 * FOLD zone (Sheppard→Bloor, the midtown "made honest" corridor) is EXEMPT — its span stays the
 * spec's 660 wu untouched; only its START shifts to sit right after the compacted North York
 * zone. Absolute invariants that do NOT scale: the 80 wu camera-clamp padding (polygon.ts) and
 * spawn-ring metres (config/spawn.ts) — both re-anchor to the smaller polygon automatically.
 */
export const DENSITY = {
  scale: 0.6,
} as const;

/**
 * Part-8 (D4) height cut: named buildings (world/toronto/namedBuildings.ts) apply this AFTER
 * the §3c hGame() curve, so building-specs.json's expected_game_h_wu cross-check stays a pure
 * function of the curve (data.test.ts / heightCurve.test.ts untouched). Heroes (CN Tower, Rogers
 * Centre — world/toronto/heroes.ts) are exempt; district filler heights are scaled separately in
 * config/torontoDistricts.ts's heightRangeM table.
 */
export const NAMED_HEIGHT_SCALE = 0.6 as const;

/**
 * Part-8 (D3) road diet: multipliers dropped from 7/6/5/3.5 car-widths to 5/4.5/4/3 — narrower
 * streets read denser at the same CAR_REF.widthWu reference. Ordering (spine > artery > major >
 * minor) is unchanged so Yonge still reads first (§2). A.6's tune path survives: if the 3-car
 * minor (6.6 wu) clips during drifts, widen it and re-test — nothing downstream is hand-pinned.
 */
export const ROAD_CLASSES = {
  spine: CAR_REF.widthWu * 5, // Yonge — 5 player-car widths = 11.0
  artery: CAR_REF.widthWu * 4.5, // University, Bloor, Spadina — 4.5 cars = 9.9
  major: CAR_REF.widthWu * 4, // King/Queen/Dundas/College/Front/Bay/Church/Jarvis/Bathurst/Finch/Sheppard/QueensQuay — 4 cars = 8.8
  minor: CAR_REF.widthWu * 3, // Richmond/Adelaide/John/Portland/York/Bremner/ParkHome — 3 cars = 6.6
} as const;

export type RoadClass = keyof typeof ROAD_CLASSES;

/**
 * Per-class asphalt colours. Tuned in the Phase 22 live pass. These render UNLIT with tone
 * mapping off (TorontoScene) — the hex below IS the on-screen colour, chosen on a strict
 * contrast ladder: canvas void (#121a2b, darkest) < asphalt (below) < ground (#454b54,
 * lightest) < curb strips (ROAD_EDGE). Spine lightest of the asphalts so Yonge reads
 * first; class grades downward from there.
 */
// Phase 25.8 (D3 L3) ladder brighten: each asphalt hex lifted ≈ +13% luminance (the D2 probe
// found the whole unlit palette clusters in a narrow dark band — the dominant "reads dark" cause,
// bigger than fog). Class ORDERING is preserved (spine lightest → minor darkest), and the whole
// ladder (void < asphalt < ground < sidewalk < curb < crosswalk) still holds. Pre-brighten values
// for the real-GPU retune: spine #343b46 / artery #303741 / major #2c323c / minor #282e37.
export const ROAD_COLORS = {
  spine: '#3b4350',
  artery: '#373f4a',
  major: '#323844',
  minor: '#2d343e',
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
  // Phase 25.8 (D3 L3): curb lifted #7e8791 → #8b95a0 (+~10%), stays the brightest road-paint tone
  // right at the road/sidewalk seam (the curb-face read D5 leans on). Pre-brighten: #7e8791.
  color: '#8b95a0',
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
  // Part-8 (D3): 4 → 3 wu with the narrower road diet (SIDEWALK_ROW's kerb/facade offsets in
  // config/torontoDress.ts re-checked to fit inside this band).
  widthWu: 3,
  // Phase 25.8 (D3 L3): sidewalk lifted #565e68 → #616a75 (+~11%), staying between ground and
  // curb on the ladder. Pre-brighten: #565e68. curbHeightWu + curbFaceColor are the D5 raised-band
  // additions (a raised top face + a road-facing curb FACE = the "road depth" read); the band tops
  // out at curbHeightWu and everything that SITS on the sidewalk lifts by the same constant.
  color: '#616a75',
  /** D5: sidewalk raised-band top-face height above the asphalt (wu). One shared constant threaded
   * through furniture/venue-dress placement y + the optional GROUND colliders. 0.12 reads as a
   * real curb at the §5.3 camera without tripping the car. */
  curbHeightWu: 0.12,
  /** D5: the vertical road-facing curb FACE colour — a touch darker than the sidewalk top (fake AO
   * seam; THIS is the depth cue). Sits between asphalt and the sidewalk top on the ladder. */
  curbFaceColor: '#3f454e',
  /** D5 kill-switch: mount matching GROUND-group cuboid colliders under the raised band (top at
   * curbHeightWu). false ⇒ visual-only band (the car visually sinks 0.12 wu on sidewalks, near-
   * invisible at this camera). DRIVE-FEEL GATE VERDICT (25.8): OFF. With colliders on, hitting the
   * 0.12 curb at ~19 m/s launched the raycast-vehicle ~0.8 wu into the air on a perpendicular ram
   * and, worse, LAUNCHED-then-CAUGHT (stalled) on a 45° approach — both degrade the signed-off
   * driving feel, which outranks the visual (§ curb collider risk row). The visual band + curb face
   * stay; the 0.12 wu visual sink on sidewalks is near-invisible at the §5.3 camera. Constant stays
   * wired for a Part-8 retune (softer step / bevel collider) if the feel is revisited. */
  colliders: false,
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
  /** Depth of the painted band along the direction of travel (wu). Phase 27 road-diet retune
   * (live-verification FIX 3): 3 -> 2.2 — proportion on the dieted (6.6-11.0 wu) roads; the old
   * 3 wu band dominated the now-tiny intersection boxes. */
  bandWu: 2.2,
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
 *
 * Part-8 (D2): `y` is the BASE (pre-compaction) 220 wu re-derived by the DENSITY scale directly
 * (220 sits inside the north_york zone, which scales uniformly from the shared y=0 origin — the
 * same rule projection.ts's scaleBaseY encodes, inlined here to avoid a config→world import).
 */
export const TORONTO_SPAWN = {
  x: 1500,
  y: 220 * DENSITY.scale,
  /** Unit heading in MAP space: +y = south. */
  heading: { x: 0, y: 1 },
} as const;

/** Phase 29 (D2): district-blackout ground-tint visual (world/toronto/groundTintBlackout.ts's
 * darkenColorRange). Toronto has no per-archetype emissive instance buffer to flip (see that
 * module's header) — the ground tint darkening by this factor on transformerDestroyed is the
 * substitute "district blackouts must read" signal. < 1 darkens; kept above 0 so a blacked-out
 * district reads as dead asphalt, not a rendering void. STARTING POINT, live-tunable. */
export const TORONTO_BLACKOUT = {
  groundTintDarkenFactor: 0.16,
} as const;
