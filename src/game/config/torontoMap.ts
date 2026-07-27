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

import { CAR_REF, resolveCityPackScale } from './cityPackScale';
import { getCityPackModel } from '../assets/cityPackManifest';

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
 * Phase 31 lane-offset fix (Part-8, live-diagnosed head-on jam): roadGraph.ts used to emit ONE
 * waypoint chain per street, with directed edges laid both ways over the SAME nodes — so
 * opposing civilian traffic met head-on in the same lane (proof: a 14-car jam wall on Yonge,
 * x=1500 z 247-285, both directions face-locked). The fix is two parallel waypoint chains per
 * street, one per travel direction, each offset perpendicular from the centreline toward its
 * right-hand side (right-hand traffic) so opposing lanes never share a node.
 *
 * Per-class offset, DERIVED (never hand-tuned per street): 0.25 x the class's own ROAD_CLASSES
 * width, capped at 2.2 wu (== CAR_REF.widthWu, one car-width) so the offset can never push a
 * lane's paint/waypoints outside its own ribbon even on the narrowest minor street (half-width
 * 3.3 wu) — checked in roadGraph.test.ts. Ordering mirrors ROAD_CLASSES: spine and artery hit
 * the cap (2.75 / 2.475 -> 2.2); major lands exactly at the cap (2.2); minor stays under it
 * (1.65). A.6's tune path applies here too: if a class's offset ever visibly straddles the
 * ribbon edge, narrow the cap (not the 0.25 factor) and re-test.
 */
export const LANE_OFFSET_WU = {
  spine: Math.min(0.25 * ROAD_CLASSES.spine, 2.2),
  artery: Math.min(0.25 * ROAD_CLASSES.artery, 2.2),
  major: Math.min(0.25 * ROAD_CLASSES.major, 2.2),
  minor: Math.min(0.25 * ROAD_CLASSES.minor, 2.2),
} as const satisfies Record<RoadClass, number>;

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

/** Collider thickness (wu) of one barrier-ring wall segment. Hoisted out of the BARRIER block
 * below only because `minEdgeInsetWu` is derived from it (an object literal cannot reference its
 * own fields). */
const BARRIER_COLLIDER_THICKNESS_WU = 1;

/** Gap between adjacent fence panels — hoisted for the same reason (`fence.pitchWu` needs it). */
const BARRIER_FENCE_GAP_WU = 0.2;

/** On-screen width (wu) of one pack `fence` panel: the manifest's native X extent x the model's
 * resolved runtime scale — MEASURED off the pack, never a copied literal, so a pack regen
 * (`pnpm assets:pack`) re-flows the fence pitch instead of silently opening gaps in the ring. */
const BARRIER_FENCE_PANEL_WIDTH_WU =
  getCityPackModel('fence').nativeDims.w * resolveCityPackScale('fence');

/**
 * Phase 37 — the diegetic world-edge barrier ring (part-9 §Phase 37; TDD §5.4 "no invisible
 * walls"). world/toronto/worldEdge.ts walks PLAYABLE_POLYGON's 11 LAND edges (the south water
 * edge is skipped — locked: no wall on the lake), insets them, and emits one long fixed cuboid
 * per edge plus per-theme visual dressing. EVERY number the builder uses lives here; worldEdge.ts
 * contains no tunables of its own.
 *
 * The ring is the diegetic primary; the universal out-of-bounds auto-WRECKED (world/toronto/
 * outOfBounds.ts) is the guaranteed backstop for anything that arcs over 3 wu of wall.
 */
export const BARRIER = {
  /**
   * How far INSIDE each land polygon edge the barrier centreline sits (wu).
   *
   * Deliberately NOT EDGE_PAD_WU (14), which is where the street table stops its ribbons: the
   * traffic graph's terminal NODES sit exactly on that pad line, so a ring at 14 would stand on
   * top of them (civilian block-rays latching onto a wall, pursuit spawn nodes in contact with
   * it). 6 wu instead:
   *   • stands on tiled ground by construction (GROUND_RECTS ∪ WATER_RECT tile the polygon
   *     exactly — proven in torontoSceneHelpers.test.ts's Phase 37 ground-truth gate);
   *   • leaves 14 − 6 − thickness/2 = 7.5 wu of clear road between a dead-end street's last
   *     asphalt and the wall it faces;
   *   • sits well inside polygon.ts's CAMERA_CLAMP_PADDING_WU (30) band, so the camera eye is
   *     already held further in than the ring — the ring never clips the lens.
   */
  edgeInsetWu: 6,
  /**
   * The floor `edgeInsetWu` collapses to on an edge that has a street ribbon lying FLUSH against
   * it. Two streets are boundary-nudged onto their zone edge by streets.ts (Bloor's north curb
   * IS the downtown block's north boundary at y=1362; Sheppard's south curb IS the capsule's
   * south boundary at y=702), so on those four step/notch edges a 6 wu inset would put a wall
   * down the middle of a live arterial. The builder detects any parallel ribbon in the inset band
   * and pulls that edge's inset back to this value — half the collider thickness, i.e. the wall's
   * outer face flush with the polygon edge and its inner face exactly `colliderThicknessWu`
   * inside. That reads as a hoarding on the road's outer shoulder (correct — the map genuinely
   * ends at that curb) and encroaches at most 1 wu of a 8.8-9.9 wu ribbon, leaving both lane
   * centres (LANE_OFFSET_WU ±2.2 from the centreline) and their car half-widths clear.
   */
  minEdgeInsetWu: BARRIER_COLLIDER_THICKNESS_WU / 2,
  /**
   * Wall height (wu). Low on purpose: it stops a car, it does NOT try to stop a launched/airborne
   * one — arcing over the top is the out-of-bounds backstop's job ("bounce or WRECKED, never a
   * fall"), and a taller ring would be the one piece of world geometry guaranteed to sit inside
   * the camera's eye-line band (CAMERA_EYE_MIN_WU 22.05) at every map edge.
   */
  colliderHeightWu: 3,
  /** Wall thickness (wu). Also the corner-seal overlap: each edge's box is extended by half this
   * at both ends so adjacent boxes overlap at the mitred corners and the ring has no gaps
   * (overlapping FIXED cuboids are free — no solver work, no jitter). */
  colliderThicknessWu: BARRIER_COLLIDER_THICKNESS_WU,
  /**
   * Invariant ceiling (wu), asserted in worldEdge.test.ts: no collider box and no dressing piece
   * may sit deeper than this into ANY street ribbon. Only the four flush-ribbon edges above can
   * intrude at all, and only into the outer ~1-1.4 wu of Bloor/Sheppard. Raising this constant
   * without re-checking the lane-clearance arithmetic in `minEdgeInsetWu` above is a bug.
   */
  maxRibbonEncroachWu: 2,
  /**
   * Dressing (not colliders) stops this far north of the shoreline (wu). The two downtown W/E
   * edges run the full height of the polygon, which includes the 240 wu water band — the COLLIDER
   * must run all the way down to seal the ring's two south corners, but a fence standing in the
   * lake reads as a bug, so visual pieces are clipped at ZONE_BOUNDARIES[3] − this.
   */
  shoreClearanceWu: 4,
  /**
   * How far from a land edge a street endpoint may be and still count as a dead end that gets a
   * "road closed" jersey row (wu). EDGE_PAD_WU (14) + edgeInsetWu (6): every zone-token street end
   * sits exactly 14 out, and Yonge's north end — the one street that stops on a literal (y=12,
   * scaleBaseY(20)) rather than a pad token — sits 12 out. Both are caught; nothing else is
   * (the next-nearest endpoint to any land edge is 59 wu away).
   */
  deadEndProbeWu: 20,
  /**
   * City-pack model ids the dressing kinds render as (assets/cityPackManifest.ts). Only two kinds
   * have a pack model; 'hoardingPanel', 'jerseyBarrier' and 'railPost' have no pack equivalent and
   * are procedural boxes built by the scene (the same precedent as 25.7's procedural awnings).
   *
   * 'fencePiece' deliberately resolves to the pack's `fence`, NOT `fence-piece`: `fence-piece`
   * resolves to a 1.12 x 0.79 wu stub (a kerb rail), far too short to read against a 3 wu wall,
   * while `fence` resolves to a 3.19 x 2.5 wu panel that reads as a real barrier at the §5.3
   * camera. Both models' native long axis is X, matching the builder's yaw convention (local +X
   * runs ALONG the edge, local +Z faces INWARD).
   */
  packModelIds: {
    fencePiece: 'fence',
    cone: 'cone',
  },
  fence: {
    /** Gap between adjacent fence panels (wu) — small enough that the run reads continuous, big
     * enough that abutting panels never share a coincident face. It is also the ring's one tri
     * lever: `fence` is a 1,040-tri model and the fence/rail edges are ~5 km of ring, so widening
     * this gap is the first thing to try if an edge vantage ever threatens the tri budget
     * (BatchedMesh per-instance frustum culling means only the ~15-20 panels actually in frame
     * ever submit triangles). */
    gapWu: BARRIER_FENCE_GAP_WU,
    /** Measured panel width (wu) — see BARRIER_FENCE_PANEL_WIDTH_WU above. */
    panelWidthWu: BARRIER_FENCE_PANEL_WIDTH_WU,
    /** Centre-to-centre spacing of fence panels along an edge (wu). The builder rounds a segment
     * to a whole number of pitches and then spreads them evenly, so the run always starts and ends
     * flush with the segment (the realised pitch lands within a few % of this). */
    pitchWu: BARRIER_FENCE_PANEL_WIDTH_WU + BARRIER_FENCE_GAP_WU,
  },
  hoarding: {
    /** Construction-hoarding panel: a plywood board on the map's construction-site edges. Width
     * is a whole-panel proportion of the 4.2 wu pitch; height sits above a car and below the
     * pack's fence so the two themes read as different structures. */
    panelWidthWu: 4,
    panelHeightWu: 2.6,
    panelThicknessWu: 0.3,
    gapWu: 0.2,
  },
  rail: {
    /** Rail-corridor theme (the fold corridor's W/E flanks): pack fence + a taller procedural post
     * every `postSpacingWu`, so the fold reads as a rail right-of-way rather than a job site. */
    postSpacingWu: 8,
    postWidthWu: 0.35,
    postHeightWu: 1.2,
  },
  notch: {
    /** Cone scatter along the two step-in notch pairs (the hoarding-themed edges that are flush
     * with Bloor/Sheppard). Deterministic, no rng: cones alternate between the barrier centreline
     * and one lateral step INWARD of it. Inward-only — a lateral step outward would push a cone
     * off the polygon on a 0.5 wu inset edge. */
    conePitchWu: 6,
    coneLateralOffsetWu: 0.6,
  },
  jersey: {
    /** Concrete jersey barrier, procedural. Length runs ACROSS the road (local +X, per the yaw
     * convention); a row of them at a dead-end street's last asphalt reads "road closed". */
    lengthWu: 2,
    widthWu: 0.7,
    /**
     * VISUAL height only. The dead-end row's COLLIDER deliberately does NOT use this: a 0.9-tall
     * thin fixed box is a curb, not a wall, to the raycast vehicle — the suspension rays hit its
     * top face and lift the chassis smoothly over it, so a car at ANY speed climbs the row like a
     * speed bump (proven live in the Phase 37 battery: creep-speed pass-through, ram-speed vault,
     * and a drop test that beached the chassis dead on the box top). The row collider instead
     * reuses `BARRIER.colliderHeightWu` (3 — the same wall height the ring proves stops the car
     * by chassis face-contact); see TorontoScene.tsx's dead-end collider mount. The 2.1 wu of
     * unmarked wall above the visible row is diegetically covered by the row itself — a stop
     * there still reads as "the road closure stopped me" — and the ring stands 8 wu behind it
     * regardless.
     */
    heightWu: 0.9,
    gapWu: 0.2,
    /** How far back from the ribbon's cut end the row's centre sits (wu), so the barriers stand
     * fully ON the asphalt instead of straddling the cut. */
    rowInsetWu: 1,
    /** Jersey positions closer than this to the polygon boundary are dropped (wu). On the four
     * flush edges (Bloor/Sheppard) the ring itself already occupies the road's outer wu, and a
     * jersey there would interpenetrate the wall. */
    edgeClearanceWu: 1.5,
  },
} as const;

/**
 * Player spawn — a map-space point on Yonge, facing south. South is map +y, which maps to world
 * +Z (see projection.mapToWorld); in the codebase's `atan2(dx, dz)` yaw convention (world +Z is
 * forward) south is yaw 0. Task 4's scene converts this map point through mapToWorld and orients
 * the car to `heading`.
 *
 * Phase 32 (D3, cold-boot default): relocated from just-south-of-Finch (North York, the Phase 22
 * dev-slice pick) to downtown Yonge between Dundas and Queen — the densest, most legible block of
 * the shipped map, and on the SOUTHBOUND lane rather than dead-centre so the player starts aligned
 * with real traffic flow instead of straddling both lanes' shared centreline.
 *
 * `x`: spine centreline (1500) minus the southbound lane's own offset (LANE_OFFSET_WU.spine —
 * roadGraph.ts's right-hand-traffic rule: southbound offsets toward −x/west). Never hand-typed as
 * a second literal — re-derived from the same constant civilian/pursuit traffic lanes use, so the
 * player spawns in the exact lane AI southbound cars drive.
 *
 * `y`: the midpoint between Dundas St and Queen St's centrelines. Both are real-anchor-derived
 * (yonge-dundas / yonge-queen, data/toronto/anchors.json via streets.ts's positionRef lookup) —
 * not expressible as a closed-form BASE-y formula the way the old Finch spot was (that zone scales
 * uniformly from a shared origin; downtown's is an affine segment anchored at Bloor, and Dundas/
 * Queen sit at fixed anchor latitudes within it) — so this is a PINNED literal, verified against
 * streets.ts's buildStreets() output (dundas.centerline ≈ 1893.47, queen.centerline ≈ 2026.34,
 * midpoint ≈ 1959.9) and drift-guarded by torontoSceneHelpers.test.ts. No cross street falls
 * between Dundas and Queen on this map, so the spawn sits mid-block, clear of every intersection.
 * The nearest named building (Eaton Centre galleria) sits entirely west of the Yonge ribbon
 * (x in [1465,1479] vs the ribbon's [1494.5,1505.5]) at any z in this range, so it never intrudes
 * regardless of the exact y chosen here.
 */
export const TORONTO_SPAWN = {
  x: 1500 - LANE_OFFSET_WU.spine,
  y: 1959.9,
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
