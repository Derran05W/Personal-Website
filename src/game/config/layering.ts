// Phase 39 — THE GROUND-STACK / WALL-STACK LADDER. The single source of truth for every
// near-coplanar vertical (and facade-normal) offset in the city.
//
// LAW after Phase 39 (`.planning/immersion-overhaul-overview.md` rule 4: "the ground-stack
// layering ladder is law after Phase 39"): no module may invent a new hand-picked Y epsilon or
// wall inset. Every producer of a flat ground quad, a road decal, a facade decal or a
// colliderless surface-hugging prop reads its rung from here. New rungs are APPENDED or spliced
// deliberately (moving neighbours as needed to keep the minimum separation) — never squeezed in
// silently. `config/layering.test.ts` pins every rung exactly and enforces strict ascent +
// minimum separation; `config/layeringGuard.test.ts` source-scans the eight producer files so a
// stray literal can't creep back in.
//
// WHY (the `.planning/part-10-placement-integrity.md` audit, 2026-07-26): offsets were picked
// per file with no shared ladder, and four real z-fight collisions were live in the shipped
// Toronto world — the user's "flashing thing":
//   1. SKID.yOffset 0.030 === placesLayer.ts's rainbow-crosswalk stripe Y 0.030 (EXACT tie —
//      braking over Church Street tore the street art).
//   2. SEARCHLIGHT.ground.yOffset 0.050 === TorontoScene.tsx's WATER_Y 0.050 (EXACT tie — the
//      heli ground pool strobed against the lake plane whenever the beam crossed the shore).
//   3. The city-pack `manhole-cover` model was placed at y=0, putting its top face at
//      0.0183 wu — landing essentially ON the road ribbon's own 0.020 surface, so every manhole
//      z-fought the asphalt it sat in. Fixed by SURFACE_ANCHOR.road (see below).
//   4. infill.ts's laneway `debris-papers` (0.0028 wu tall) sat at y=0, exactly coplanar with
//      the merged ground quads. Fixed by SURFACE_ANCHOR.ground.
//
// SEPARATION RATIONALE: a 0.004 wu ground step and a 0.01 wu wall step both clear the depth
// precision available at the play camera's near/far range by a wide margin, while staying far
// below the ~0.12 wu curb height — i.e. invisible as a height difference, decisive as a depth
// difference. The ground rungs below are spaced 0.006 apart (1.5× the minimum) so a future
// insertion has room.
//
// NOT A RUNG: `SIDEWALK.curbHeightWu` (0.12) is a geometry HEIGHT — a raised curb the car can
// see and (visually) climb — not a coplanarity epsilon. It stays in `config/torontoMap.ts` and
// roadPaint.ts derives CURB_TOP_Y from it; the guard test exempts that derivation explicitly.
//
// This module is a LEAF: it imports nothing, so any config or world module can read it without
// risking a cycle.

/** Minimum vertical gap (wu) between two adjacent GROUND_STACK rungs. Law-tested. */
export const MIN_GROUND_SEP_WU = 0.004;

/** Minimum facade-normal gap (wu) between two adjacent WALL_STACK rungs. Law-tested. */
export const MIN_WALL_SEP_WU = 0.01;

/**
 * The ground stack, bottom → top. Declaration order IS the paint order: a later rung always
 * paints over an earlier one. Every value is in world units above the ground collider's top
 * face (y = 0).
 */
export const GROUND_STACK = {
  /** Merged ground quads — sits exactly on the ground collider's top face. */
  ground: 0.0,
  /** District ground-tint quads (TorontoScene's per-district colour wash). */
  districtTint: 0.008,
  /** Park grass quads (was 0.010 — moved up one step to clear the tint by the full minimum). */
  parkGround: 0.012,
  /** World-edge barrier / jersey-row box FLOORS (P37's BOX_BASE_LIFT_WU; value unchanged). */
  edgeBoxBase: 0.016,
  /** Road ribbons (the asphalt). */
  roadSurface: 0.02,
  /** Road paint: curb strips + centre-line dashes (was 0.025 = roadSurface + 0.005). */
  roadPaint: 0.026,
  /** Crosswalk zebra bands (was 0.027 = roadSurface + 0.007 — only 0.002 above the paint). */
  crosswalk: 0.032,
  /** Painted street art — the Church Street rainbow crosswalk (was 0.030). */
  placesRoadArt: 0.038,
  /** Skid-mark decal quads (was 0.030 — an EXACT TIE with the rainbow crosswalk). Skids paint
   * OVER placesRoadArt so street art never tears under braking, and BELOW `water` so marks
   * vanish the moment they'd cross the lake plane. */
  skid: 0.048,
  /** Explosion scorch decals (was 0.035) — over skids, so a blast on a skid trail reads. */
  scorch: 0.054,
  /** The lake's visual plane (was 0.050). */
  water: 0.06,
  /** Ground FX — the helicopter searchlight's ground pool (was 0.050, an EXACT TIE with the
   * water plane). Top of the stack: aircraft light paints over everything, including the lake. */
  groundFx: 0.066,
} as const;

/**
 * The wall stack: how far a decal/inset quad sits PROUD OF (or inset into) a facade along its
 * face normal, in world units. Same rules as the ground stack — declaration order is paint
 * order, later wins, minimum separation enforced.
 */
export const WALL_STACK = {
  /** Legacy parked-car head/tail-light quads (config/world.ts's `lightInsetM`). */
  lightInset: 0.02,
  /** Legacy procedural-building window quads (config/world.ts's `windowInsetM`). */
  windowInset: 0.04,
  /** Bank CROWN decals, proud of the tower facade (config/torontoMaterials.ts's
   * CROWN_DECAL.offsetWu — and the hand-copied duplicate that used to live in
   * TorontoScene.tsx's `decalTransform`, now deleted). */
  crownDecal: 0.05,
  /** Venue FASCIA bands / places decals (was 0.06 — only 0.01 from crownDecal, i.e. exactly AT
   * the minimum with zero headroom, and a real risk where a named tower also carries a venue
   * band on the same facade). */
  fasciaBand: 0.07,
} as const;

/**
 * Placement anchors for COLLIDERLESS props whose own geometry is (near-)flat and would
 * otherwise be authored sitting at y = 0. The renderer floors a model at its placement y
 * (cityPackBaked's `lift`), so anchoring a flat prop is purely a matter of setting that y.
 *
 * Props with real height and/or a collider are NOT anchored — their bottom face is invisible
 * under the fixed §5.3 camera, and moving them would change collision/feel.
 */
export const SURFACE_ANCHOR = {
  /** Props resting on ASPHALT (manhole covers, road-bit plates). One full ground separation
   * above the ribbon so the prop's own base can never share the road surface's depth. */
  road: GROUND_STACK.roadSurface + MIN_GROUND_SEP_WU,
  /** Props resting on bare DIRT / laneway ground (debris papers, the sunk floor-hole's top
   * face). Sits above `districtTint` and deliberately dodges the `parkGround` rung so a laneway
   * prop that happens to overlap a park edge still resolves cleanly. */
  ground: GROUND_STACK.districtTint + 0.006,
} as const;
