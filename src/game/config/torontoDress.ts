// Toronto map v2 — street furniture + parked-vehicle placement tuning (Phase 25.6 D16/D18,
// CLAUDE.md CITY-PACK REAPPROACH criterion 3). Single source of truth for every spacing/
// density/offset/cap number world/toronto/furniture.ts consumes — no magic numbers there.
// Pure data, no three/react. Offsets are measured in wu FROM THE RIBBON EDGE (a street's
// `halfWidth`, i.e. the outer edge of the asphalt/curb) unless documented otherwise, matching
// the D6 frontage engine's own convention (facade line = ribbon edge + SIDEWALK.widthWu) so a
// future SIDEWALK.widthWu retune re-flows both frontage and furniture together.

import { DENSITY } from './torontoMap';
import { TORONTO_DISTRICTS, type DistrictId } from './torontoDistricts';
import { resolveCityPackScale } from './cityPackScale';
import { CAMERA, CAMERA_GROUND_BAND_MAX_WU } from './camera';
import { getCityPackModel } from '../assets/cityPackManifest';

/** Local deg→rad (config leaves stay import-light; camera.ts keeps its own private copy). */
const DRESS_DEG2RAD = Math.PI / 180;

/**
 * Which road classes count as "full" for the traffic-light signalization rule (D16): both
 * crossing streets full -> 4-corner signalized; exactly one full -> 2-corner diagonal; neither
 * -> stop-sign garnish corner. Kept as a Set-able array (not re-deriving from ROAD_CLASSES
 * directly) so the rule reads as an explicit policy choice, not an accident of the width table.
 */
export const TRAFFIC_LIGHT_FULL_CLASSES = ['spine', 'artery', 'major'] as const;

/** Resolved traffic-light footprint (world units) — manifest native dims x today's scale
 * override, read live so everything derived from the mast's real size (TRAFFIC_LIGHT's post claim,
 * LAMP_OVERLAY's head anchor) tracks either input if it ever changes. Hoisted above TRAFFIC_LIGHT
 * at Phase 75 so the post claim can derive from it too. */
function resolvedTrafficLightDims(): { readonly w: number; readonly h: number } {
  const entry = getCityPackModel('traffic-light');
  const scale = resolveCityPackScale('traffic-light');
  return { w: entry.nativeDims.w * scale, h: entry.nativeDims.h * scale };
}

const TRAFFIC_LIGHT_DIMS = resolvedTrafficLightDims();

/**
 * PHASE 75 — the mast POST's footprint half-width as a FRACTION of the resolved model width, the
 * same pin-the-quotient idiom LAMP_HEAD_ANCHOR_FRAC uses and for the same reason: the pack model's
 * bounding box is nearly all ARM, so the real post width is not derivable from the manifest, but
 * the post/model ratio is a property of the mesh and survives any scale retune.
 *
 * 0.04684 is the quotient of the Phase-40 hand-picked 0.25 wu against the model width it was
 * picked at (5.33766 x the then-1.0 scale), rounded to 5 decimals. At Phase 75's re-judged 1.74
 * override it resolves to ~0.435 wu — which is what the rendered post actually measures, and what
 * the P40 literal had silently stopped describing (it under-reported by ~0.19 wu, i.e. the arbiter
 * believed the mast was ~43 % narrower than it is). Same "claim the trunk, not the canopy"
 * convention as TREE_ROW.trunkHalfWidthWu; anchorPins.test.ts proves the derivation.
 */
export const TRAFFIC_LIGHT_POST_HALF_WIDTH_FRAC = 0.04684;

export const TRAFFIC_LIGHT = {
  /** Extra setback (wu) beyond the corner's own (nsHalfWidth, ewHalfWidth) point — "ribbon edge
   * + 0.8 on both axes" (D16). */
  cornerOffsetWu: 0.8,
  /** Which of the 4 corner positions (see furniture.ts's cornerMastPositions, index order
   * [+ns/-ew, +ns/+ew, -ns/-ew, -ns/+ew]) a 2-mast DIAGONAL intersection uses. Fixed, not
   * randomized — a diagonal intersection always mounts opposite corners. */
  diagonalCornerIndices: [0, 3] as readonly [number, number],
  /**
   * Phase 40 — the mast's PHYSICAL POST footprint half-width (wu), for the placement arbiter's
   * claim. Deliberately NOT `colliderHalfExtents('traffic-light')`, whose ~3.6 wu half-width is
   * the ARM reaching out over the roadway at LAMP_OVERLAY.headAnchor.y (3.78 wu) — far above
   * anything standing on the sidewalk, so claiming that box would falsely block a quarter of
   * every corner. Same "claim the trunk, not the canopy" convention TREE_ROW.trunkHalfWidthWu
   * established for street trees.
   *
   * PHASE 75 (T3) — NOW DERIVED, closing the note T1 left here. T1 re-judged the traffic-light
   * scale override 1.0 → 1.74 against the doubled roads (the arm has to span a 17.6-22.0 wu
   * crossing), which left this hand-picked 0.25 describing a post that no longer exists: the
   * rendered post measures ~0.435 wu half-width at that scale, so the arbiter believed the mast was
   * ~43 % narrower than it is. That is exactly the silent-drift class Phase 27 hit with
   * LAMP_OVERLAY.headAnchor, and T1 deferred it here only because widening an ARBITER input
   * re-flows every furniture category placed after the masts — churn this task owns end to end.
   * It is now TRAFFIC_LIGHT_POST_HALF_WIDTH_FRAC x the resolved model width, so a future scale
   * retune or manifest regen moves the claim WITH the mast instead of stranding it.
   * (The arm/head numbers quoted above are the pre-P75 ones; the head now sits at 6.58 wu.)
   */
  postHalfWidthWu: TRAFFIC_LIGHT_POST_HALF_WIDTH_FRAC * TRAFFIC_LIGHT_DIMS.w,
} as const;

/** Deterministic NS/EW signal-phase clock (D17), consumed by world/toronto/lampClock.ts. Cosmetic
 * only — no traffic obeys it (no AI reads it this phase). */
export const LAMP_CLOCK = {
  greenMs: 8000,
  amberMs: 1600,
} as const;

/** Lamp-quad emissive colours per phase (D17 — one InstancedMesh of small emissive quads, colour
 * written via instanceColor only on phase change). */
export const LAMP_COLORS = {
  green: '#39d15a',
  amber: '#e8b13a',
  red: '#e0453f',
} as const;

/**
 * Lamp-quad overlay geometry (D17). `headAnchor` is the head position relative to the mast model
 * origin, in RESOLVED world units, BEFORE the mast's own yaw (TrafficLampOverlay rotates this
 * offset by each mast's rotationY). Provisional — tunable live; D17's static-heads fallback stands
 * if the alignment fights back.
 *
 * Phase 41 (T3) — DERIVED, not hand-typed, specifically because of what happened at Phase 27:
 * the road-diet retune dropped cityPackScale.ts's 'traffic-light' override from 1.35 to 1.0, and
 * this constant had to be hand-rescaled to match (was {x:-5.4, y:5.1, z:0} — silently wrong for
 * one commit, caught only by a live-verification screenshot, not a test). `headAnchor` is now
 * `LAMP_HEAD_ANCHOR_FRAC x (manifest nativeDims x resolveCityPackScale('traffic-light'))`, read
 * live off getCityPackModel/resolveCityPackScale — a future manifest regen or scale retune moves
 * this anchor WITH it automatically, and anchorPins.test.ts's derivation-proof test fails loudly
 * if anyone ever reverts to a hand literal. The fractions themselves (x -0.74938, y 0.81049) are
 * pinned quotients of TODAY's resolved anchor against today's resolved dims
 * (-4.0 / (5.3377 x 1.0) and 3.78 / (4.6639 x 1.0), rounded to 5 decimals) — the head's true
 * model-relative position is empirical/screenshot-tuned, not something derivable from first
 * principles, so the fraction is the pin, not a formula.
 *
 * quadSizeWu stays a plain literal — an arbitrary emissive-quad size with no model tie.
 */
export const LAMP_HEAD_ANCHOR_FRAC = {
  x: -0.74938,
  y: 0.81049,
} as const;

// (`resolvedTrafficLightDims` / `TRAFFIC_LIGHT_DIMS` were hoisted to the top of this file at
// Phase 75 — TRAFFIC_LIGHT.postHalfWidthWu derives from the same resolved dims now.)

export const LAMP_OVERLAY = {
  headAnchor: {
    x: LAMP_HEAD_ANCHOR_FRAC.x * TRAFFIC_LIGHT_DIMS.w,
    y: LAMP_HEAD_ANCHOR_FRAC.y * TRAFFIC_LIGHT_DIMS.h,
    z: 0,
  },
  quadSizeWu: 0.7,
} as const;

/**
 * Quality-tier seam (D21): a single multiplier furniture.ts's row-spacing math divides by
 * (higher scalar = tighter spacing = more items). Default 1.0 = the numbers below, verbatim.
 * Phase 25.8 (D8) wires the ACTUAL per-tier scaling as a further multiplier on top of this —
 * see TorontoTierParams.dressDensityScalar below — so this constant stays the single "master"
 * density dial (independent of quality tier) while the tier scaling composes with it.
 */
export const DRESS_DENSITY_SCALAR = 1.0;

/**
 * Phase 25.8 (D8) — the per-render quality-tier scaling `buildFrontage`/`buildFurniture`
 * (world/toronto/frontage.ts / furniture.ts) consume as their second, OPTIONAL argument.
 * Captured ONCE at TorontoScene mount from `config/quality.ts`'s `QUALITY_TIERS[tier]` (the
 * Phase-18 "next run, at mount" precedent `world/CityScape.tsx` already uses for
 * `parkedCarKeepFraction`/`sceneryKeepFraction` — see its doc comment) and threaded through as a
 * plain data param, so neither builder ever reads the store or config/quality.ts directly and
 * both stay pure functions of `(seed, tierParams)`. A mid-run quality change can never thin a
 * live run's buildings/furniture/colliders out from under it — the new tier only applies on the
 * next mount (new seed or new run), exactly like the legacy-world tiers did.
 */
export interface TorontoTierParams {
  /** Multiplies DRESS_DENSITY_SCALAR in furniture.ts's row-spacing math (trees/hydrants/
   * benches/trash-cans/bus-stops/manholes AND parked-vehicle along-street spacing). Traffic-light
   * masts/stop-signs/power-boxes are intersection-rule furniture and are NEVER scaled — low tier
   * still signals every intersection. Sourced from QUALITY_TIERS[tier].dressDensityScalar. */
  readonly dressDensityScalar: number;
  /** Multiplies FRONTAGE.occupancy's per-density (dense/medium/sparse) probabilities in
   * frontage.ts's generic street-walk. A venue claim is forced-occupied regardless of this roll
   * and always survives thinning (D1) — only unclaimed slots thin. Sourced from
   * QUALITY_TIERS[tier].frontageOccupancyScalar. */
  readonly frontageOccupancyScalar: number;
  /** Multiplies PARKED.cap for furniture.ts's parked-vehicle hard cap (thinToCap) — the low
   * tier's real dynamic-body-budget driver (200/120/50 @ the default PARKED.cap=200). Named to
   * match the EXISTING QUALITY_TIERS.parkedCarKeepFraction field it is sourced from (Phase 18's
   * legacy-world parked-car trim) — this is a new consumer of that same tier field, not a new
   * concept. */
  readonly parkedCarKeepFraction: number;
}

/** The no-op scaling: every ratio at 1.0, so `buildFrontage(seed, TORONTO_TIER_IDENTITY)` /
 * `buildFurniture(seed, TORONTO_TIER_IDENTITY)` reproduce their pre-25.8 output byte-for-byte
 * (asserted by the high-tier golden test). This is ALSO the default value of both builders'
 * `tierParams` parameter, so every pre-25.8 call site (devPanel's venue lookups, debugBridge,
 * every existing test) that omits the second argument keeps compiling and behaving unchanged. */
export const TORONTO_TIER_IDENTITY: TorontoTierParams = {
  dressDensityScalar: 1,
  frontageOccupancyScalar: 1,
  parkedCarKeepFraction: 1,
} as const;

// --- sidewalk row placement (D16 "rows") ----------------------------------------------------
/** Where along the SIDEWALK band (config/torontoMap.ts SIDEWALK.widthWu = 4) a row sits,
 * measured from the ribbon edge. `kerb` = near the curb (trees/hydrants/manholes-adjacent
 * reads); `facade` = near the building wall (benches/trash/bus-stops), pulled in from the
 * frontage engine's own facade line (ribbon edge + SIDEWALK.widthWu) for clearance. */
// Part-8 (D3): re-checked against the narrower SIDEWALK.widthWu (4 → 3 wu) — facadeOffsetWu must
// sit inside the band (≤ 3 - some clearance), so kerb 1.2 → 1.0 / facade 3.4 → 2.4.
export const SIDEWALK_ROW = {
  kerbOffsetWu: 1.0,
  facadeOffsetWu: 2.4,
} as const;

export const POWER_BOX = {
  /** Every Nth signalized corner (seeded pick among them), sidewalk kerb row. Est. ~60 map-wide
   * (D16 arithmetic: ~50 signalized x 4 corners / 3). */
  everyNthSignalizedCorner: 3,
  capMapWide: 80,
  /** Phase 30 (T2 debt-3): Toronto's OWN transformer hit points — deliberately NOT
   * POWER_GRID.transformerHp (that constant is shared with the legacy world's transformerBox
   * and stays untouched at 30 so this retune can never regress legacy's signed-off feel).
   * P29 notes debt 3: at hp 30 a power box needed ~2 solid hits (a straight-on approach lets
   * the suspension climb the tiny 0.26 wu box with no damage; only a proper T-bone connects).
   * Halved to 15 so one solid T-bone is lethal, matching the legacy one-ram transformer feel. */
  hp: 15,
  /** Phase 30 (T2 debt-1): rigid-body mass (kg) for the flying replica once a dead box
   * launches. Feel-tunable placeholder in the streetlight/trafficLight mass range
   * (PROPS.masses) — a similar street-fixture bulk. */
  launchMassKg: 120,
  /** Phase 30 (T2 debt-1): the launch is DEATH-driven (transformerDestroyed), not a live
   * contact — there is no real Rapier contact force to read at that moment, so this stands in
   * as the "forceMag" world/propDynamics.ts's computeLaunchImpulse scales the pop off of.
   * Same order of magnitude as PROPS.forceThresholds.trafficLight (600 N). */
  deathLaunchForce: 600,
} as const;

export const TREE_ROW = {
  spacingWu: 28,
  capMapWide: 700,
  /** Trunk collider half-extents (D12: "~0.5 x h x 0.5 wu" — never the canopy box
   * colliderHalfExtents(id) would produce). hxz is fixed; hy is computed per-placement from the
   * tree's actual resolved world height (resolveCityPackScale('tree') x nativeDims.h) / 2. */
  trunkHalfWidthWu: 0.25,
} as const;

/**
 * PHASE 75 (T4) — THE GRASS MEDIAN'S PLANTING (`.planning/part-17-feel-drive-model.md`: "a raised
 * planted strip: grass, low kerb visual, sparse trees/planters from the pack via the arbiter").
 * The grass and its kerb are geometry (world/toronto/roadPaint.ts); this is what stands on them.
 *
 * MODEL — `tree`, the SAME id the sidewalk rows and the park rings use, and that reuse is a hard
 * requirement rather than a convenience: the whole planting rides the street-furniture layer's
 * EXISTING `tree` BatchedMesh (one draw call for every instance of a model at any count), so the
 * layer costs **zero new draw calls**. Any other pack id — `planter-bushes` is the only other
 * plausible fit — is in no batch this layer already renders and would cost one.
 *
 * CANOPY vs TRAVEL LANE (measured, the placement's binding constraint). The resolved tree is
 * 4.91 × 5.15 × 8.10 wu (manifest native dims × resolveCityPackScale('tree')), so its circumscribed
 * canopy half-extent is 2.576 wu against a median half-width of 1.10 — the foliage overhangs the
 * kerb by 1.476 wu each side. That is over ASPHALT, never over a LANE: the nearest travel-lane
 * flank sits at `LANE_OFFSET_WU − CAR_REF.widthWu/2` = 4.40 wu (artery) / 4.95 (spine) from the
 * centreline, so the canopy clears it by 1.82 wu on the tightest class. `medianPlanting.test.ts`
 * pins that inequality, so a tree-scale or lane-offset retune fails loudly instead of quietly
 * hanging branches over traffic. What the trees do NOT get is a footprint claim at canopy size —
 * they claim the TRUNK (TREE_ROW.trunkHalfWidthWu), the arbiter's standing "claim the trunk, not
 * the canopy" convention.
 *
 * COLLIDERS — NONE, and that is a decision, not an omission. The median is visual-only by Phase
 * 75's D2 (its 0.12 wu kerb is exactly the height Phase 25.8 measured LAUNCHING this raycast
 * vehicle, and Phase 37 measured 0.9 wu rows being curb-HOPPED — there is no height between the
 * two that behaves), and a collidable trunk in the middle of Yonge would be strictly worse than the
 * kerb we already refused. Structurally: the median planting is its OWN array on FurnitureLayout,
 * and cityPack/CityDress.tsx mounts tree trunk colliders from `trees.items` alone — keeping the two
 * arrays disjoint IS the guarantee, and furniture.test.ts asserts the disjointness.
 */
const MEDIAN_PLANTING_MODEL_ID = 'tree';

/** Resolved median-planting footprint/height (world units) — manifest native dims × today's scale,
 * read live so a pack regen or a scale retune moves every law derived from it. Same idiom as
 * `resolvedTrafficLightDims` above. */
const MEDIAN_PLANTING_DIMS = ((): { readonly canopyHalfWu: number; readonly h: number } => {
  const entry = getCityPackModel(MEDIAN_PLANTING_MODEL_ID);
  const scale = resolveCityPackScale(MEDIAN_PLANTING_MODEL_ID);
  return { canopyHalfWu: (Math.max(entry.nativeDims.w, entry.nativeDims.d) * scale) / 2, h: entry.nativeDims.h * scale };
})();

export const MEDIAN_PLANTING = {
  /** Pack model id — see the block comment: reusing the street-tree batch is what makes the layer
   * free in draw calls. */
  modelId: MEDIAN_PLANTING_MODEL_ID,
  /**
   * Circumscribed half-extent (wu) of the RESOLVED canopy — manifest native dims × today's scale,
   * read live so a pack regen or a scale retune moves it. Circumscribed (the larger of w/d) because
   * the placements take a seeded spin, the same conservative rule claimIndex.footprintHalfExtents
   * applies to every spun prop. Two consumers: the lane-clearance law above, and the placer's
   * along-strip containment (a tree's foliage may overhang the kerb, but not a crosswalk — so its
   * canopy, not just its trunk, has to fit inside the grass segment lengthwise).
   */
  canopyHalfWu: MEDIAN_PLANTING_DIMS.canopyHalfWu,
  /** Resolved canopy height (wu) — 8.10. Pinned for the "well under the eye line" law. */
  heightWu: MEDIAN_PLANTING_DIMS.h,
  /**
   * THE SPARSITY LAW, derived — never a picked pitch.
   *
   * "Sparse" has to mean something measurable, and the thing it has to be sparse *against* is the
   * frame: a strip down the middle of the road the phase exists to open up must never read as a
   * wall. So the minimum pitch is the length of median the CAMERA CAN SHOW AT ONCE. Then at most
   * one median tree is ever in shot, and "wall" is impossible by construction rather than by taste.
   *
   * `CAMERA_GROUND_BAND_MAX_WU` (28.04) is that band measured along the boresight. Every street on
   * this map is axis-aligned and the rig's yaw is fixed at 45°, so every street crosses the band
   * obliquely at exactly that angle and the run of street inside it is `band / cos(yaw)` — 39.65 wu,
   * 1.42× the sidewalk tree pitch (TREE_ROW.spacingWu, 28). Both relations are law-tested.
   */
  pitchWu: CAMERA_GROUND_BAND_MAX_WU / Math.cos(CAMERA.yawDeg * DRESS_DEG2RAD),
  /**
   * Map-wide hard cap, the same perf guard every row category carries. The pitch already bounds the
   * count: the four median-carrying streets yield 4,850.7 wu of grass across 36 segments once the
   * crossing cut-outs and terminus insets are taken out, which lands 136 trees at seed 416. This is
   * therefore headroom (against a future `major` median opt-in), NOT a shaping dial — thinning here
   * would punch holes in the even rhythm the pitch exists to create.
   */
  capMapWide: 160,
} as const;

export const HYDRANT_ROW = {
  spacingWu: 60,
  capMapWide: 140,
} as const;

export const BENCH_ROW = {
  spacingWu: 34,
  capMapWide: 160,
  /** Only placed in dense/storefront-feeling districts (density !== 'sparse'). */
} as const;

export const TRASH_CAN_ROW = {
  spacingWu: 40,
  capMapWide: 160,
} as const;

export const BUS_STOP_ROW = {
  spacingWu: 180,
  capMapWide: 50,
  /** Only on majors+ (spine/artery/major) near an intersection — never on a minor. */
  eligibleClasses: ['spine', 'artery', 'major'] as readonly string[],
  /** How close to an intersection a bus stop is allowed to sit (wu, along-street). */
  nearIntersectionWu: 40,
} as const;

export const MANHOLE_ROW = {
  spacingWu: 45,
  capMapWide: 220,
  /**
   * Offset from the edge of the street's CENTRE MARKER (not the ribbon edge — these sit ON the
   * road), alternating sides along the street (D16: "centreline +/-1.5 wu").
   *
   * PHASE 75: re-read as a clearance FROM THE CENTRE MARKER rather than from the bare centreline,
   * and resolved per street by `manholeOffsetWu` below. On a street with no median the centre
   * marker is the painted line (zero half-width) and the number is unchanged — 1.5 wu, exactly as
   * D16 wrote it. On a median street the marker is a 2.2 wu raised grass strip, and a flat 1.5 wu
   * offset put the cover's own footprint (0.36 wu half-width) 0.04 wu from the kerb chamfer, i.e.
   * a manhole grazing the planting. Nothing caught it: manholes are ON_ROAD-sanctioned in the
   * placement arbiter, so no overlap law fires. Expressed against the median half-width — the same
   * shape config/torontoMap.ts's `carriagewayCentreWu` gives the lane offset — the cover lands in
   * the carriageway on every class, by construction.
   */
  centerlineOffsetWu: 1.5,
  /** Only on spine + major (D16), never arteries/minors (keeps the count arithmetic honest). */
  eligibleClasses: ['spine', 'major'] as readonly string[],
} as const;

/**
 * PHASE 75 — the manhole row's offset from a street's centreline, given that street's resolved
 * median half-width (`Street.medianHalfWidth`, 0 where it carries none). The ONE place the rule
 * lives; world/toronto/furniture.ts reads it and never re-derives.
 *
 * Reduces EXACTLY to MANHOLE_ROW.centerlineOffsetWu when there is no median, so every non-median
 * street's covers are byte-identical to their pre-Phase-75 positions.
 */
export function manholeOffsetWu(medianHalfWidthWu: number): number {
  return medianHalfWidthWu + MANHOLE_ROW.centerlineOffsetWu;
}

export const STOP_SIGN = {
  /** Corner offset, same convention as TRAFFIC_LIGHT.cornerOffsetWu — stop-sign corners use one
   * post per intersection (not 4), placed at the first corner index. */
  cornerOffsetWu: 0.8,
  cornerIndex: 0,
} as const;

// --- parked vehicles (D18) -------------------------------------------------------------------
export const PARKED = {
  /** Map-wide hard cap (perf budget — D9). */
  cap: 200,
  /** Seeded along-street spacing range between parked slots (wu). */
  spacingRangeWu: [30, 60] as readonly [number, number],
  /** Parallel-parked on the asphalt OUTER lane: centre inset this far from the ribbon edge,
   * into the road (D18: "ribbon edge - 1.4 wu"). */
  insetFromRibbonEdgeWu: 1.4,
  /** Never within this distance (wu, along-street) of an intersection corner. */
  minDistFromCornerWu: 12,
  /**
   * Only on majors+ (spine/artery/major).
   *
   * PHASE 75 RE-JUDGEMENT (verdict: UNCHANGED, but the reason is different). The original reason —
   * "parking on a 3.5-car minor would eat the whole drivable width" — is now measurably FALSE: a
   * minor is 13.2 wu, a parked row on both sides costs 2 × CAR_REF.widthWu, and what is left is
   * 8.8 wu = 4 cars abreast, i.e. WIDER than the entire pre-Phase-75 minor. Keeping a dead
   * rationale in place is exactly the silent-drift class this phase is cleaning up, so it is
   * replaced by the real one:
   *
   * eligibility is a DISTRIBUTION question, not a capacity one. `cap` is a hard map-wide 200 with
   * even-stride thinning, so admitting ~2,600 wu of minor-street frontage to the candidate pool
   * does not add cars — it moves them OFF the mains, which are the streets the player drives and
   * the pursuit navigates. That trade is a traffic-density judgement with a measurement harness
   * attached, and Phase 79 ("Traffic v3 bodies + density: fewer cars") owns it together with `cap`
   * itself. Deciding it blind here, in a phase whose whole purpose is navigability, would be a
   * guess. REVISIT AT P79, with the two numbers moved together.
   */
  eligibleClasses: ['spine', 'artery', 'major'] as readonly string[],
  /** Rigid-body spec (D12): plain dynamic + sleep, no event/registry wiring this phase. Mass/
   * damping are data for the mounting task (Opus T5) to apply — this module never touches
   * Rapier. */
  body: {
    massKg: 1200,
    linearDamping: 4,
    angularDamping: 4,
  },
} as const;

// --- frontage buildings (D6/D7/D10/D11 — the street-walk pack-building placer) --------------
/**
 * Pack-building frontage placement tuning (world/toronto/frontage.ts). All numbers the
 * street-walk placer consumes live here — no magic numbers in frontage.ts. The building family's
 * resolved frontage is 13.5 wu (config/cityPackScale.ts BUILDING_FRONTAGE_TARGET_WU); the pitch
 * leaves a ~2 wu gap between adjacent facades so the wide models never touch along a block.
 */
// Part-8 (D5) densification: pitch tightened (15.5 → 14.0 — a narrower ~0.5 wu gap between the
// 13.5 wu frontage models), occupancy raised across the board (.85/.65/.4 → .95/.85/.65), and the
// hard cap lifted (900 → 1400) to match the denser candidate lattice + occupancy.
export const FRONTAGE = {
  /** Along-street spacing between adjacent frontage slots (wu) — 13.5 wu frontage + a tighter gap. */
  pitchWu: 14.0,
  /** Extra along-street clearance (wu) reserved on each side of an intersection box before the
   * first frontage slot of a block segment can sit — keeps facades off the crossing itself. */
  cornerClearanceWu: 3,
  /** Reference depth (wu) into the block used for the model-independent district/occupancy lookup
   * at a slot, so which district (and thus which packStock/occupancy) owns a slot never depends on
   * the specific model rolled for it (which varies its actual depth). */
  districtRefDepthWu: 6,
  /** Seeded per-slot occupancy probability by district density (D6). Denser districts line their
   * frontages nearly solid; sparse districts leave gaps. */
  occupancy: { dense: 0.95, medium: 0.85, sparse: 0.65 } as const,
  /** Hard cap on total pack-building placements (D6/D9 — the tri budget's enforceable ceiling).
   * Above this, deterministic even-stride thinning trims back to the cap. */
  hardCap: 1400,
} as const;

/**
 * D7 backdrop-tower boxes: the three tower districts (financial/harbourfront/northYorkCentre —
 * packStock.backdropTowers) get a SPARSE second row of legacy-style extruded boxes one row behind
 * the pack frontage, for distant silhouette variety the ~19 wu pack facades can't carry under the
 * §5.3 camera. Rendered through the existing box InstancedMesh path (unlit + instanceColor), §6
 * fillerColors + §3c hGame heights.
 */
export const BACKDROP_TOWER = {
  /** Along-street spacing between backdrop boxes (wu) — sparse by design. */
  pitchWu: 44,
  /** Distance (wu) the backdrop row sits behind the frontage facade line (ribbon edge + sidewalk).
   * Part-8 (live-verification FIX 1): was an ABSOLUTE 18 — block interiors compacted ×DENSITY.scale
   * but this setback didn't, so boxes landed on ribbons/adjacent blocks. Now DENSITY-derived
   * (18 × 0.6 = 10.8). The frontage.ts placer additionally REJECTS (never relocates) any backdrop
   * box whose footprint intersects a street ribbon, the water band, or a hero/named-building lot —
   * this setback is a first-pass placement bias, not the safety guarantee. */
  setbackFromFacadeWu: 18 * DENSITY.scale,
  /** Footprint side range (wu) — tower plots read wider than street filler. */
  footprintRangeWu: [10, 18] as const,
  /** Map-wide hard cap (perf — D7 "~90 total"). */
  capMapWide: 90,
} as const;

// Phase 29 (D4) superseded PARKED_MODELS: the eligible parked-vehicle model set + weights moved to
// config/carVariety.ts's CIVILIAN_CAR_MODELS (the single source of truth for BOTH parked cars and
// moving traffic, now folded into one carVariety pick with a colour palette + anti-repeat). The
// same police-car/bus/bicycle/motorcycle exclusions carry over (that file's own doc comment).

// ============================================================================================
// Phase 28 ("Infill: solid streetwall, back lots, parking lots, construction") — D1-D7 config.
// Every new placer (frontage.ts's corner-fill pass, world/toronto/infill.ts's back-lot/laneway/
// parking-lot/construction/lane-closure passes) reads its numbers from here — no magic numbers
// in the placers themselves, same house rule as every other Toronto config block above.
// ============================================================================================

// --- D1: corner fill (frontage.ts) -----------------------------------------------------------
/** Seeded per-corner-quadrant fill (frontage.ts's buildCornerFill): at each of an intersection's
 * 4 quadrants, roll this district-density occupancy for a narrow corner-pool building (reusing
 * packStock.cornerModels via the existing pickModel fallback) facing whichever adjoining street
 * is wider. Denser districts fill corners more often. */
export const CORNER_FILL = {
  occupancy: { dense: 0.7, medium: 0.5, sparse: 0.3 } as const,
  /** Map-wide hard cap (perf safety net) — most of the 4×intersections candidate lattice is
   * already rejected by geometry (ribbon/exclusion/overlap) well before this ever binds. */
  capMapWide: 700,
} as const;

// --- D2: blank-facade tint variety (frontage.ts) ---------------------------------------------
/** How many EXTRA pastel variants `paleBlankVariant` derives per district on top of its
 * packStock.tints, and how far (per RGB channel, ±) each variant may drift — clamped so every
 * channel stays >= `channelFloorHex` (the D11 near-white invariant every frontage tint must
 * satisfy, tested map-wide in frontage.test.ts). */
export const BLANK_TINT_JITTER = {
  extraVariants: 3,
  channelFloorHex: 0xb0,
  channelDeltas: [
    [12, -8, 4],
    [-6, 10, -4],
    [6, 4, -10],
  ] as readonly (readonly [number, number, number])[],
} as const;

function paleBlankVariant(baseHex: string, delta: readonly [number, number, number]): string {
  const n = parseInt(baseHex.slice(1), 16);
  const floor = BLANK_TINT_JITTER.channelFloorHex;
  const clamp = (v: number): number => Math.min(255, Math.max(floor, v));
  const r = clamp(((n >> 16) & 0xff) + delta[0]);
  const g = clamp(((n >> 8) & 0xff) + delta[1]);
  const b = clamp((n & 0xff) + delta[2]);
  return `#${(((r << 16) | (g << 8) | b) >>> 0).toString(16).padStart(6, '0')}`;
}

/** Per-district blank-facade tint palette (D2 "extra variety without new assets"): each
 * district's own near-white packStock.tints PLUS `BLANK_TINT_JITTER.extraVariants` derived pastel
 * variants (channel-clamped >= the D11 near-white floor). frontage.ts's generic walk and
 * corner-fill pass pick from THIS pool (instead of packStock.tints) only when the rolled model is
 * `rb-blank`/`gb-blank`, so blank facades read with more variety than the family/corner models
 * without authoring new hex literals per district. Computed once at module load (pure derivation
 * off TORONTO_DISTRICTS — never a second hand-authored source of truth). */
export const BLANK_TINTS: Readonly<Record<DistrictId, readonly string[]>> = Object.fromEntries(
  TORONTO_DISTRICTS.map((d): [DistrictId, readonly string[]] => {
    const base = d.packStock.tints;
    const extra = BLANK_TINT_JITTER.channelDeltas
      .slice(0, BLANK_TINT_JITTER.extraVariants)
      .map((delta, i) => paleBlankVariant(base[i % base.length], delta));
    return [d.id, [...base, ...extra]];
  }),
) as Readonly<Record<DistrictId, readonly string[]>>;

// --- D3: back-lot second row (world/toronto/infill.ts) ---------------------------------------
/** A general second row of buildings behind the frontage row, wherever the reject-never-relocate
 * gates (ribbons/exclusions/polygon/water/overlap — the SAME family frontage.ts's backdrop towers
 * already use) leave room. Replaces/absorbs nothing (BACKDROP_TOWER stays, for the 3 tower
 * districts, rendering BEHIND this row) — this is the general-district equivalent. */
export const BACKLOT = {
  /** Along-street pitch (wu) for the second-row walk — sparser than FRONTAGE.pitchWu (14.0). */
  pitchWu: 16,
  /** Extra clearance (wu) behind the ASSUMED first-row rear before the second row's own footprint
   * starts (plus its own half-depth). */
  setbackFromFrontageRearWu: 2,
  /** Assumed first-row depth (wu) used only to estimate the second row's perpendicular offset —
   * a coarse placement bias, not a safety guarantee (narrow blocks are kept honest by the shared
   * ribbon/exclusion/overlap rejection gates, which naturally reject a second row that would land
   * on the far side of a too-narrow block — no explicit "interior depth >= 16 wu" measurement
   * needed). */
  assumedFrontageDepthWu: 7.5,
  /** Fraction of second-row placements that are pack buildings (rotated to face the fronted
   * street, same convention as the frontage row) vs capped extruded boxes (§3c district heights,
   * the legacy filler look) — the remainder. */
  packFraction: 0.7,
  /** Footprint half-side range (wu) for the BOX half of the row (pack buildings use their own
   * model footprint, like frontage.ts's family/standalone scale). */
  boxHalfSideRangeWu: [4, 7] as const,
  capMapWide: 500,
} as const;

// --- D4: laneway clutter (world/toronto/infill.ts) --------------------------------------------
/** Seeded scatter rows in the gap between the frontage rear and the back-lot row (or the interior
 * edge where no back-lot row landed) — dumpster/box/trash-bag clusters, fence-piece runs, and
 * washing-line (residential districts only). All static instanced, no bodies (D4). */
export const LANEWAY = {
  spacingWu: 20,
  capMapWide: 350,
  /** How far behind the frontage facade line (wu, beyond FRONTAGE's own sidewalk) the clutter row
   * walks — inside the gap, never on the sidewalk/ribbon (checked by the shared gates). */
  offsetFromFacadeWu: 3.5,
  /** washing-line only rolls in districts at this density (a residential/park-adjacent proxy —
   * same rule spirit as D2's greenhouse gate). */
  washingLineDensities: ['sparse'] as const,
} as const;

/** Laneway clutter model pool (weighted) — reused across every eligible district (D4 keeps this
 * global, unlike packStock, since alley junk doesn't vary by material family). */
export const LANEWAY_MODELS: readonly { readonly id: string; readonly weight: number }[] = [
  { id: 'dumpster', weight: 0.3 },
  { id: 'box', weight: 0.25 },
  { id: 'trash-bag-grey', weight: 0.25 },
  { id: 'fence-piece', weight: 0.2 },
];

// --- D5: parking lots (world/toronto/infill.ts) -----------------------------------------------
/** Small seeded interior lots: perimeter fence + 4-10 static pack cars. Scanned on a coarse grid
 * over the polygon's bounding box (deterministic row-major order); every candidate clears the
 * SAME reject-never-relocate gates as every other layer. Zero dynamic bodies this phase (Phase
 * 29's registry wiring can decide whether these should shove later). */
export const PARKING_LOT = {
  scanStrideWu: 34,
  footprintHalfRangeWu: { hx: [11, 15], hz: [8, 11] } as const,
  keepProbability: 0.55,
  carsCountRange: [4, 10] as const,
  targetCount: 14,
  capMapWide: 16,
  /** Fence perimeter post pitch (wu) — how far apart along each side wall. */
  fencePitchWu: 3.6,
} as const;

// --- D6: construction sites (world/toronto/infill.ts) ------------------------------------------
/** A composable prefab: perimeter fence + 2 cone clusters + road-bits plates + dumpster + boxes
 * + debris-papers + a seeded-subset billboard (floor-hole dropped at Phase 39 — neither proud
 * nor sunk-flush read as a hole on the opaque ground). Reserved BEFORE back-lot/parking
 * (D6 placement-order rule: construction gets first pick of the big interior lots). Colliders
 * only on the fence run + dumpster + billboard (PROP_STATIC-style fixed cuboids). */
export const CONSTRUCTION = {
  scanStrideWu: 30,
  footprintHalfRangeWu: { hx: [8, 13], hz: [7, 11] } as const,
  keepProbability: 0.55,
  targetCount: 12,
  capMapWide: 14,
  fencePitchWu: 3.6,
  coneClusterSize: 3,
  /** Fraction of sites that also get a billboard (seeded subset, D6). */
  billboardFraction: 0.4,
} as const;

// --- D7: lane closures (world/toronto/infill.ts) ------------------------------------------------
/** 3-5 seeded cosmetic strips on majors (never the spine, never within `minDistFromIntersectionWu`
 * of a crossing): a road-bits plate + 5-7 cones tapering one lane. Cones are DYNAMIC sleeping
 * bodies (knockable) — no traffic-AI coupling this phase. Dropped entirely on the low tier. */
export const LANE_CLOSURE = {
  countRange: [3, 5] as const,
  coneCountRange: [5, 7] as const,
  coneSpacingWu: 2.2,
  minDistFromIntersectionWu: 30,
  /** Eligible road classes — majors+ but never the spine (D7: "never spine"). */
  eligibleClasses: ['artery', 'major'] as readonly string[],
  coneBody: { massKg: 4, linearDamping: 2, angularDamping: 2 },
} as const;

// --- D11: deep-interior scatter (world/toronto/infill.ts) --------------------------------------
/**
 * Phase 28 ("Infill") D11 — user "less open land" directive. Live verification found the North
 * York capsule's deep block interiors (e.g. map point x=1550, z=350) sit 40+ wu from the nearest
 * street (only Yonge/Finch/Parkhome cross the whole capsule — a genuinely sparse grid), so no
 * street-hugging layer above (frontage/back-lot/laneway/parking-lot/construction, D1-D7 — every
 * one of them measured from a ribbon by construction) ever reaches them, leaving a huge bare
 * district-tinted field. This is deliberately the LAST, LOWEST-density pass: a seeded scatter of
 * loose tree clusters (the bulk of the fix) plus rare garnish (greenhouse sheds, dumpster/box
 * piles) — texture for the void, never a sixth street-hugging city layer. Eligible points sit
 * strictly beyond `minDistFromRibbonWu` from EVERY street ribbon (so this pass can never compete
 * with or duplicate D3-D7, which all hug streets) and inside the polygon; every candidate still
 * clears the full reject-never-relocate exclusion family (sidewalk bands, venues/parks/hero lots,
 * water, polygon, every earlier D3-D7 footprint, and each other) like every other infill layer.
 */
export const DEEP_SCATTER = {
  /** Eligibility gate (task-specified): a candidate point must sit farther than this from every
   * street's ribbon rect. */
  minDistFromRibbonWu: 35,
  /** Coarse deterministic scan grid over the polygon's bounding box (the same "divide the base
   * spacing by densityScalar" tier idiom scanForSites/BACKLOT/LANEWAY already use). */
  scanStrideWu: 50,
  /** Seeded keep-roll per scanned cell — thins the grid further ("low density, texture not
   * city"; the eligibility gate above already does most of the real work). */
  keepProbability: 0.45,
  /** Tree-cluster size (task-specified "2-5"). */
  clusterCountRange: [2, 5] as const,
  /** Radius (wu) individual trees in a cluster jitter around the cluster's own scanned point. */
  clusterSpreadWu: 5,
  /** Content-type roll weights (weightedPick over whichever of these are ELIGIBLE at a given
   * candidate — see greenhouseDensities/pileMaxDistFromRibbonWu below). A candidate where neither
   * greenhouse nor pile qualifies always resolves to a tree cluster (the only entry left in the
   * pool). */
  contentWeights: { tree: 10, greenhouse: 1.5, pile: 2 } as const,
  /** Greenhouse sheds only ever roll in a district at this density (task: "residential/sparse-
   * density districts only") — the SAME density value LANEWAY.washingLineDensities above already
   * uses as the residential proxy (this file's own established idiom), not a new concept. */
  greenhouseDensities: ['sparse'] as const,
  /** Dumpster/box pile clusters only roll within this distance of the eligibility threshold
   * (task: "only near the back-lot band edge") — a candidate farther into the deep interior never
   * gets a pile, only trees (+ maybe a greenhouse). */
  pileMaxDistFromRibbonWu: 55,
  pileClusterCountRange: [2, 3] as const,
  /** Radius (wu) individual props in a pile cluster jitter around the cluster's own point. */
  pileSpreadWu: 1.6,
  /** Map-wide hard caps, each additionally thinned by dressDensityScalar — a lower tier gets
   * both a coarser scan (fewer candidates generated) AND a lower cap. Tree cap raised 250→450
   * at the Phase 28 live gate: 250 left the NY capsule reading bare from street level, and the
   * whole layer is one BatchedMesh draw call regardless of count. */
  treeCapMapWide: 450,
  greenhouseCapMapWide: 40,
  pileCapMapWide: 60,
} as const;
