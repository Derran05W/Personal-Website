// Phase 25.5 (D9/D10) — per-model runtime scale for the city-pack. game/assets/
// cityPackManifest.ts's native dims are wildly inconsistent across the pack's ~4 authorship
// clusters — near-metric cars (~1.8x1.2x4.2), toy-scale buildings (~2.4x3.5), centimetre-ish
// props (hydrant 233 "tall", tree 509, billboard 670), plus outright oddballs (trash-can
// 3.15x3.63, bus-stop 38x27). Every model's runtime scale is derived from the SEDAN — the one
// dimension the player has a direct, constant visual reference to — via two user-stated rules
// (phase-25.5-plan.md D9):
//   1. CAR_REF: the sedan's on-screen visual envelope, in world units (1 wu = 1 m).
//   2. BUILDING_FRONTAGE_TARGET_WU = 3 car lengths — every "standard building family" member
//      (shared materials/near-identical native size — building-red/green/red-corner,
//      pizza-corner, rb-blank, gb-blank) scales so building-red's own native width maps to
//      that frontage. Corners and pizza-corner reuse the SAME family factor rather than an
//      independently-computed one, so they come out narrower than the frontage target — an
//      intentional consequence (a corner piece reads as a turn in the same wall, not a
//      standalone full-frontage building), not a bug.
// big-building/brown-building are NOT part of that shared-material family (each has its own
// distinct native size), so each gets its own frontage-target factor computed from its own
// native width. Reference native widths below are read LIVE off the generated manifest
// (getCityPackModel) rather than hand-copied numbers, so a pack regen can never silently drift
// this file out of sync with what's actually on disk.
//
// Values with no derivable formula (traffic-light, bench) are the plan's literal provisional
// starting points. D14's proof-of-render mount (world/toronto/cityPack/CityPackPreview.tsx,
// the Opus builder that follows this task) screenshot-tunes the models it actually places
// (rb-blank, building-red, big-building, pizza-corner, traffic-light, bench, fire-hydrant,
// tree) and is expected to edit the constants below with a comment recording the retune, per
// the plan's verification step 7. Every other id (most props, all 11 vehicles) resolves
// through a category-default FORMULA rather than a hand-tuned number — genuinely provisional,
// flagged for 25.6's full art pass (see the plan's "Out of scope" list).

import { VEHICLE_TUNING } from './vehicles';
import { getCityPackModel, type CityPackModelEntry } from '../assets/cityPackManifest';

/** Sedan visual envelope (user-stated), in world units. Cross-check (asserted in
 * cityPackScale.test.ts, not here — config modules stay side-effect-free): the physics
 * collider (VEHICLE_TUNING.chassis) is narrower/shorter than this — wheels/bumpers/mirrors
 * push the visible car out further than the simplified physics box. `colliderWidthWu`/
 * `colliderLengthWu` are exposed here (not folded into widthWu/lengthWu) so the two stay
 * independently visible and can never silently drift apart without the cross-check test
 * noticing. */
export const CAR_REF = {
  widthWu: 2.2,
  lengthWu: 4.5,
  colliderWidthWu: VEHICLE_TUNING.chassis.halfWidth * 2,
  colliderLengthWu: VEHICLE_TUNING.chassis.halfLength * 2,
} as const;

/** 3 car lengths (user rule) — the frontage every "standard building family" member targets. */
export const BUILDING_FRONTAGE_TARGET_WU = CAR_REF.lengthWu * 3;

/** Street-furniture default cap (wu): props with no explicit override and a native height
 * above this get scaled DOWN so their tallest axis lands here; already-metric-scale props
 * (well under the cap) pass through unscaled (factor 1). Self-normalizing across the pack's
 * inconsistent authorship clusters — provisional until 25.6's per-model art pass. */
export const PROP_DEFAULT_MAX_HEIGHT_WU = 2.5;

/** Target canopy height (wu) for vegetation with no explicit override — currently only ever
 * reached by 'tree' (whose own override below computes from this same constant), but kept as
 * the category formula so a second tree species inherits a sane default instead of scale 1. */
export const VEGETATION_TARGET_HEIGHT_WU = 8.1;

/** Target height (wu) fire-hydrant's explicit override below targets. */
export const FIRE_HYDRANT_TARGET_HEIGHT_WU = 1.0;

/** Phase 25.7 (D9/T1) explicit overrides — six manifest ids the venue-dressing pass places at
 * facade/street scale, whose native dims are pack-authoring oddballs the category-default
 * formula gets visibly wrong (billboard/rock-band-poster are both >2.5 wu native height and would
 * get capped at PROP_DEFAULT_MAX_HEIGHT_WU by the generic prop formula; air-conditioner is a
 * centimetre-ish native size that would pass through near-unscaled; atm/box are already
 * metric-scale and would stay at factor-1 native size, both far smaller than the kit-authored
 * target). Kit-authoring rationale (WHY these targets) lives in config/venueDressing.ts's
 * PROP_SCALE_TARGETS — kept in sync by cityPackScale.test.ts, not by an import (cityPackScale.ts
 * is a lower-level shared asset module; venueDressing.ts is phase-specific and must not become a
 * dependency of it). Provisional; screenshot-tuned in phase-25.7 Task 5.
 * fire-exit is the one WIDTH-target override in the set (the D-table calls out "~2.4 wu wide",
 * not tall) — every other target below is a height. */
export const BILLBOARD_TARGET_HEIGHT_WU = 4.5;
export const AC_TARGET_HEIGHT_WU = 1.0;
export const ATM_TARGET_HEIGHT_WU = 1.8;
export const FIRE_EXIT_TARGET_WIDTH_WU = 2.4;
export const ROCK_BAND_POSTER_TARGET_HEIGHT_WU = 2.2;
export const BOX_TARGET_HEIGHT_WU = 0.6;

/** Phase 31 (Part-8 D1/D2, T1) — the 'bus' vehicle's native dims are a pack authoring oddball
 * (w≈50.06, h≈48.8, d≈157.46 "authoring units" — the category-default vehicle formula would map
 * its longest axis (d) onto CAR_REF.lengthWu (4.5), scaling a TTC-service bus down to sedan
 * length, visibly wrong). Explicit override targeting ~10 wu length (≈2.2 car lengths — a
 * recognizable full-size city bus alongside the sedan, without dwarfing the car-derived road
 * classes it drives — see config/torontoMap.ts ROAD_CLASSES.major = 8.8 wu, the narrowest street
 * every bus route uses). Consumed by config/torontoTransit.ts's busChassisHalfExtents() for the
 * Toronto world-traffic bus's collider/body AND by world/toronto/cityPack/TorontoBusMesh.tsx's
 * visual via the normal resolveCityPackScale('bus') path. */
export const BUS_TARGET_LENGTH_WU = 10;

function familyReferenceWidthWu(): number {
  return getCityPackModel('building-red').nativeDims.w;
}

/** The one shared factor every "standard building family" member uses (see file header). */
export const BUILDING_FAMILY_SCALE = BUILDING_FRONTAGE_TARGET_WU / familyReferenceWidthWu();

/** Explicit per-id scale overrides (D9). Every id not listed here falls back to its category
 * default formula (categoryDefaultScale below). Exported for cityPackScale.test.ts's "D9
 * computed examples pinned" coverage. */
export const CITY_PACK_SCALE_OVERRIDES: Readonly<Record<string, number>> = {
  // Standard building family — ONE factor for every member (see file header on corners).
  'building-red': BUILDING_FAMILY_SCALE,
  'building-green': BUILDING_FAMILY_SCALE,
  'building-red-corner': BUILDING_FAMILY_SCALE,
  'pizza-corner': BUILDING_FAMILY_SCALE,
  'rb-blank': BUILDING_FAMILY_SCALE,
  'gb-blank': BUILDING_FAMILY_SCALE,
  // Standalone buildings — each targets the same 3-car-length frontage off its OWN native
  // width (not part of the shared-material family above).
  'big-building': BUILDING_FRONTAGE_TARGET_WU / getCityPackModel('big-building').nativeDims.w,
  'brown-building': BUILDING_FRONTAGE_TARGET_WU / getCityPackModel('brown-building').nativeDims.w,
  // Provisional — no formula given by the plan; tune vs. the sedan in the D14 proof mount.
  // Phase 27 road-diet retune (live-verification FIX 2): 1.35 made the resolved mast arm read as
  // wide as an entire 6.6-8.8 wu dieted road, with the head hovering at car height over the
  // intersection centre. 1.0 (native scale) brings the arm back to a normal roadside proportion.
  'traffic-light': 1.0,
  'bench': 0.9,
  // Computed from the target constants above.
  'fire-hydrant': FIRE_HYDRANT_TARGET_HEIGHT_WU / getCityPackModel('fire-hydrant').nativeDims.h,
  tree: VEGETATION_TARGET_HEIGHT_WU / getCityPackModel('tree').nativeDims.h,
  // Phase 25.7 (D9/T1) — see the target-constant block above for rationale.
  billboard: BILLBOARD_TARGET_HEIGHT_WU / getCityPackModel('billboard').nativeDims.h,
  'air-conditioner': AC_TARGET_HEIGHT_WU / getCityPackModel('air-conditioner').nativeDims.h,
  atm: ATM_TARGET_HEIGHT_WU / getCityPackModel('atm').nativeDims.h,
  'fire-exit': FIRE_EXIT_TARGET_WIDTH_WU / getCityPackModel('fire-exit').nativeDims.w,
  'rock-band-poster': ROCK_BAND_POSTER_TARGET_HEIGHT_WU / getCityPackModel('rock-band-poster').nativeDims.h,
  box: BOX_TARGET_HEIGHT_WU / getCityPackModel('box').nativeDims.h,
  // Phase 31 (Part-8 D1/D2, T1) — see the target-constant comment above. 'd' (not 'w') is the
  // model's longest/forward axis (157.46 vs 50.06), matching the vehicle category formula's own
  // "whichever horizontal axis is longer" convention below.
  bus: BUS_TARGET_LENGTH_WU / getCityPackModel('bus').nativeDims.d,
};

/** Category-default scale for any id without an explicit override above. Every formula is
 * self-normalizing off the model's OWN measured native dims (never a flat constant that could
 * blow up on the pack's oddball-scale outliers) — see file header for the per-category
 * rationale. Provisional for everything that lands here; 25.6 is where these get replaced by
 * art-directed per-model numbers as each category actually goes into the world. */
function categoryDefaultScale(entry: CityPackModelEntry): number {
  switch (entry.category) {
    case 'building':
    case 'building-blank':
      // No named override (e.g. 'greenhouse', a standalone non-family structure): the shared
      // family scale reads as a plausible small-structure size rather than the 22x blowup a
      // naive frontage-formula would produce off its tiny 0.6 m native width.
      return BUILDING_FAMILY_SCALE;
    case 'vegetation':
      return entry.nativeDims.h > 0 ? VEGETATION_TARGET_HEIGHT_WU / entry.nativeDims.h : 1;
    case 'vehicle':
      // Native axis orientation is inconsistent across the pack (e.g. bicycle's longest axis
      // is its native WIDTH, not depth) — map whichever horizontal axis is longer onto the
      // sedan's length rather than assuming a fixed forward axis.
      return CAR_REF.lengthWu / Math.max(entry.nativeDims.w, entry.nativeDims.d, 1e-6);
    case 'prop':
    default:
      return entry.nativeDims.h > PROP_DEFAULT_MAX_HEIGHT_WU
        ? PROP_DEFAULT_MAX_HEIGHT_WU / entry.nativeDims.h
        : 1;
  }
}

/** Resolves the runtime scale factor for any manifest id: explicit override if the plan pins
 * one, otherwise the category default formula. Guaranteed to resolve for every id currently in
 * the manifest (cityPackScale.test.ts's "scale coverage" test proves this over the full 52). */
export function resolveCityPackScale(id: string): number {
  const entry = getCityPackModel(id);
  return CITY_PACK_SCALE_OVERRIDES[id] ?? categoryDefaultScale(entry);
}

export interface ColliderHalfExtents {
  readonly hx: number;
  readonly hy: number;
  readonly hz: number;
}

/** Pure function (D10): manifest native dims x resolved scale -> cuboid half-extents, in world
 * units, y measured from the ground (the model's own floor sits at y=0 by pack convention —
 * every measured native dim in the plan's table is a positive full extent off that floor).
 * Convex-primitive-only law (CLAUDE.md): callers mount this as a fixed CuboidCollider, never a
 * trimesh. */
export function colliderHalfExtents(id: string): ColliderHalfExtents {
  const entry = getCityPackModel(id);
  const scale = resolveCityPackScale(id);
  return {
    hx: (entry.nativeDims.w * scale) / 2,
    hy: (entry.nativeDims.h * scale) / 2,
    hz: (entry.nativeDims.d * scale) / 2,
  };
}

/** Leva-tunable knobs (CLAUDE.md convention: "all numbers live in game/config/... live-tunable
 * via leva"). The full CITY_PACK_SCALE_OVERRIDES id->factor map is exported separately above
 * (for the resolver + tests) rather than folded in here — it's ~9 generated/derived numbers,
 * not hand-tuned dials; the D14 proof pass tunes by editing this file + a comment, not by
 * dragging a slider mid-session. */
export const CITY_PACK_SCALE = {
  CAR_REF,
  BUILDING_FRONTAGE_TARGET_WU,
  PROP_DEFAULT_MAX_HEIGHT_WU,
  VEGETATION_TARGET_HEIGHT_WU,
  FIRE_HYDRANT_TARGET_HEIGHT_WU,
  BUILDING_FAMILY_SCALE,
  BILLBOARD_TARGET_HEIGHT_WU,
  AC_TARGET_HEIGHT_WU,
  ATM_TARGET_HEIGHT_WU,
  FIRE_EXIT_TARGET_WIDTH_WU,
  ROCK_BAND_POSTER_TARGET_HEIGHT_WU,
  BOX_TARGET_HEIGHT_WU,
  BUS_TARGET_LENGTH_WU,
} as const;
