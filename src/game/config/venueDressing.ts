// Phase 25.7 Task 1 (D2/D3/D4/D6/D10/D11) — business-personalization tuning: the category ->
// dressing-kit table + every number the venue claim/dress pipeline consumes. No magic numbers
// in world/toronto/venues.ts or the (later) venueDress.ts/VenueDressLayer.tsx — this module is
// the single source of truth, matching the CLAUDE.md config convention. Pure data, no three/
// react. See .planning/phases/phase-25.7-plan.md for the Decisions (D-numbers below) this file
// implements.
//
// COORDINATE CONVENTION for every DressingPropSpec offset (documented here since T3/T4 — not
// this task — are the first consumers): `alongWu` runs tangent to the claimed facade's
// street-facing edge (0 = facade centre, + = toward the venue's "right" as the facade rotationY
// faces outward); `upWu` is height above the ground (the pack models' own floor-at-y=0
// convention, config/cityPackScale.ts); `outWu` is the perpendicular distance FROM the facade
// plane the prop mounts on (`mount: 'street'` = the claimed slot's street-facing plane,
// `mount: 'flank'` = the perpendicular side wall, D4's side-band idiom) — positive = away from
// the wall, toward the camera/sidewalk.

/** The 8 kits the T1 category table resolves to (plan's "Category -> dressing table"). */
export type DressingKitId =
  | 'grocery'
  | 'bar'
  | 'cafe-fastfood'
  | 'asian-restaurant'
  | 'karaoke'
  | 'retail'
  | 'entertainment'
  | 'fine-dining';

export const DRESSING_KIT_IDS: readonly DressingKitId[] = [
  'grocery',
  'bar',
  'cafe-fastfood',
  'asian-restaurant',
  'karaoke',
  'retail',
  'entertainment',
  'fine-dining',
] as const;

/** places.json `category` string -> DressingKitId (the plan's "Category -> dressing table").
 * `signage_prop` (Sam the Record Man) is deliberately absent — that venue never claims a slot
 * (D7 exception), so it never needs a kit. */
export const PLACE_CATEGORY_TO_KIT: Readonly<Record<string, DressingKitId>> = {
  grocery_icon: 'grocery',
  grocery: 'grocery',
  bar_cheap_eats: 'bar',
  sports_bar: 'bar',
  coffee_icon: 'cafe-fastfood',
  fast_food_icon: 'cafe-fastfood',
  bubble_tea: 'cafe-fastfood',
  dessert_icon: 'cafe-fastfood',
  ramen: 'asian-restaurant',
  korean_icon: 'asian-restaurant',
  korean_bbq: 'asian-restaurant',
  karaoke: 'karaoke',
  retail_flagship: 'retail',
  entertainment: 'entertainment',
  fine_dining_icon: 'fine-dining',
};

/** Resolves a places.json category to its dressing kit; throws loudly on an unmapped category
 * (a typo'd/new places.json category should fail at build time, not silently drop dressing). */
export function kitForCategory(category: string): DressingKitId {
  const kit = PLACE_CATEGORY_TO_KIT[category];
  if (!kit) {
    throw new Error(`venueDressing: unmapped places.json category "${category}"`);
  }
  return kit;
}

// --- facade models (D3) -----------------------------------------------------------------------

/** The three city-pack manifest ids a venue claim can resolve to. `corner` only via the D3
 * corner-food rule (facadeModelFor in world/toronto/venues.ts). */
export const FACADE_MODEL_IDS = {
  brick: 'rb-blank',
  clean: 'gb-blank',
  corner: 'pizza-corner',
} as const;

/** Kits where a claimed CORNER slot swaps its facade to `pizza-corner` (D3: "food-category
 * venue whose claimed slot isCorner"). McDonald's @ Queen & Spadina is the designed hit. */
export const CORNER_FOOD_KITS: readonly DressingKitId[] = ['cafe-fastfood', 'asian-restaurant'];

// --- D3 pastel-tint derivation ------------------------------------------------------------------
// facade tint = mix(brand_color, white) iterated until every channel >= minChannel (the
// facade-crush threshold: 25.5 proved dark instanceColor multiplies the palette texture to
// near-black). accent colour (awning/fascia backing) stays the raw saturated brand_color —
// procedural geometry has no texture to crush.

export const PASTEL = {
  /** Per-iteration mix-toward-white fraction (D3/T1: "pastel mix 0.62"). */
  mixStep: 0.62,
  /** Facade-crush threshold (D3: "until every channel >= ~0.75") — every pastel channel must
   * clear this before the loop stops. */
  minChannel: 0.75,
  /** Safety cap so a pathological input (e.g. an already-white brand_color needing 0 iterations,
   * or a malformed one) can never loop unboundedly. 0->0.75 converges in 3 iterations at
   * mixStep=0.62, so this is generous headroom, not a tuned number. */
  maxIterations: 8,
} as const;

// --- D10 fascia band metrics --------------------------------------------------------------------

/** Facade "size class" a claimed model resolves to, for band-metric lookup. `bigBuilding` is
 * carried for completeness (D10 lists it explicitly) even though no current kit's facadeModelId
 * resolves there — a future corner fallback onto a big-building-only district could. */
export type FacadeSizeClass = 'family' | 'pizzaCorner' | 'bigBuilding';

export interface FasciaMetrics {
  /** Band bottom edge, world y (wu) above the slot's ground plane. */
  readonly bandBottomWu: number;
  /** Band top edge, world y (wu). */
  readonly bandTopWu: number;
  /** Inset (wu) from each facade edge before the band starts — band width = facade width -
   * 2*insetWu (D10). */
  readonly insetWu: number;
}

/** Per-facade-model-class band metrics (D10). Initial values sit in the P26 §4 range
 * (3.5-5.0 wu) the family blanks' baked ground-floor windows (~3.2 wu) sit under;
 * SCREENSHOT-TUNED against the real facades in T5 — edit here with a comment recording the
 * retune, same idiom as config/cityPackScale.ts's D14 pass. */
export const FASCIA_METRICS: Readonly<Record<FacadeSizeClass, FasciaMetrics>> = {
  family: { bandBottomWu: 3.5, bandTopWu: 5.0, insetWu: 1.0 },
  // pizza-corner's resolved frontage (~7.4 wu, config/cityPackScale.ts BUILDING_FAMILY_SCALE
  // applied to the corner's native width) is roughly half the family's 13.5 wu — a smaller
  // inset keeps the band legibly wide on the narrower facade.
  pizzaCorner: { bandBottomWu: 3.2, bandTopWu: 4.6, insetWu: 0.5 },
  bigBuilding: { bandBottomWu: 3.5, bandTopWu: 5.6, insetWu: 1.6 },
};

/** Maps a resolved facade model id to its FacadeSizeClass (T1 provisional; T3/T4 are the real
 * consumers). Unknown ids fall back to `family` (the common case — every current DressingKit
 * facadeModelId is rb-blank/gb-blank). */
export function facadeSizeClassFor(modelId: string): FacadeSizeClass {
  if (modelId === FACADE_MODEL_IDS.corner) return 'pizzaCorner';
  if (modelId === 'big-building') return 'bigBuilding';
  return 'family';
}

/** Fascia band width "read" per kit (D4/table). `full`/`wide` get a smaller inset (band reads
 * as dominating the facade); `standard` leaves more raw facade visible either side. */
export type FasciaWidthMode = 'full' | 'wide' | 'standard';

export const FASCIA_WIDTH_MODE_EXTRA_INSET_WU: Readonly<Record<FasciaWidthMode, number>> = {
  full: 0,
  wide: 0.4,
  standard: 1.0,
};

/** Karaoke's fascia backing plate (D-table: "band (magenta backing)") — a dark magenta plate
 * instead of the shared near-black BACKING_PLATE (logoAtlas.ts), so Echo Coin's band reads as
 * its own neon-sign colour even before the logo cell renders. */
export const KARAOKE_BAND_BACKING = '#2a0a20';

// --- D6 awnings (procedural, one merged mesh map-wide) -------------------------------------------

export const AWNING = {
  /** Sloped canopy depth (wu), out from the facade. */
  canopyDepthWu: 1.8,
  /** Front valance drop (wu) below the canopy's outer edge. */
  dropWu: 0.35,
  /** Canopy bottom edge, world y (wu) — clears a pedestrian's head, sits under the fascia band. */
  bottomYWu: 2.8,
} as const;

export type AwningWidthMode = 'full' | 'standard' | 'small' | 'narrow';

/** Fraction of the claimed facade width an awning spans, by kit "read" (D-table narrative:
 * grocery = full-width, cafe-fastfood = bright/standard, asian-restaurant = small warm,
 * bar = narrow dark). */
export const AWNING_WIDTH_FRACTION: Readonly<Record<AwningWidthMode, number>> = {
  full: 0.92,
  standard: 0.75,
  small: 0.55,
  narrow: 0.45,
};

// --- prop-scale targets (D9 provisional overrides, T1 -> config/cityPackScale.ts) ---------------
// The six manifest ids the plan flags as needing an explicit override (their native dims are
// pack-authoring oddballs — see cityPackScale.ts's file header). Named targets live here
// (kit-authoring reasons in wu); the derived CITY_PACK_SCALE_OVERRIDES factors live in
// cityPackScale.ts itself (single derivation point, so a target tweak here is a one-line change
// there too). Provisional; screenshot-tuned in T5.
export const PROP_SCALE_TARGETS = {
  billboardHeightWu: 4.5,
  airConditionerHeightWu: 1.0,
  atmHeightWu: 1.8,
  fireExitWidthWu: 2.4,
  rockBandPosterHeightWu: 2.2,
  boxHeightWu: 0.6,
} as const;

// --- claim tuning (D1, consumed by T2's frontage.ts claims pass) --------------------------------

export const CLAIM_TUNING = {
  /** Kits whose claimed CORNER slot swaps to pizza-corner (mirrors CORNER_FOOD_KITS — kept as
   * one bag so T2 can import a single tuning object). */
  cornerFoodKits: CORNER_FOOD_KITS,
  /** Sanity ceiling (wu) on how far a venue's authored `along` target may legitimately sit from
   * the candidate it claims — the block pitch is 15.5 wu (config/torontoDress.ts FRONTAGE), so a
   * correct nearest-candidate resolution should never need to reach further than a couple of
   * blocks even after gate rejections/fallbacks. Not a hard clamp (D1: claims must always
   * resolve) — a drift/regression signal for T2's tests. */
  maxNudgeWu: 60,
} as const;

// --- D11 queue numbers (migrated off world/toronto/placesLayer.ts's local buildQueue constants;
// placesLayer's copy retires when T3 deletes the migrated AUTHORS/queue builder) --------------

export const VENUE_QUEUE = {
  blobCount: 7,
  spacingWu: 1.2,
  /** Alternating stagger (wu) perpendicular to the line-of-queue, every other blob. */
  staggerWu: 0.7,
  /** Distance (wu) the queue line sits off the claimed facade's front edge. Phase 25.8 (D10):
   * 0.6 → 2.2 so the lineup clears the awning's 1.8 wu canopy projection (AWNING.canopyDepthWu) —
   * the P25.7 residual where queues read small/dark UNDER the awning in static top-down shots. Still
   * inside the 4 wu sidewalk band (2.2 + staggerWu 0.7 = 2.9 < 4). Pre-25.8: 0.6. */
  frontOffsetWu: 2.2,
  /** Extra length (wu) each end post sits beyond the first/last blob. */
  postExtraWu: 0.8,
} as const;

// --- fine-dining plaque (D7: Alo keeps the P26 "tiny plaque, no band" treatment) -----------------

export const FINE_DINING_PLAQUE = {
  sizeWu: 1.6,
  /** Plaque vertical centre, world y (wu) — matches the family fascia band's own vertical centre
   * so Alo's plaque sits at the same "sign height" as every other venue's band, just tiny. */
  upWu: 4.25,
  outWu: 0.06,
} as const;

// --- dressing kits (the D3/T1 "Category -> dressing table" source of truth) ---------------------

export type PropMount = 'street' | 'flank';

export interface DressingPropOffset {
  readonly alongWu: number;
  readonly upWu: number;
  readonly outWu: number;
}

export interface DressingPropSpec {
  readonly modelId: string;
  readonly count: number;
  /** One entry per instance — length must equal `count` (asserted in venues.test.ts). */
  readonly offsets: readonly DressingPropOffset[];
  /** Which facade plane the prop mounts on (D4's flank-band idiom for W/N-fronting venues). */
  readonly mount: PropMount;
  /** Yaw (radians) RELATIVE to the mounting plane's own outward-facing rotation; shared by every
   * offset in this spec (none of T1's authored specs need per-instance yaw variation). */
  readonly yaw: number;
}

export interface FasciaSpec {
  readonly present: boolean;
  readonly widthMode: FasciaWidthMode;
  /** Overrides the shared near-black backing plate (logoAtlas.ts BACKING_PLATE) for this kit's
   * band. Only karaoke uses this (D-table: "band (magenta backing)"). */
  readonly backingColorOverride?: string;
}

export interface AwningSpec {
  readonly widthMode: AwningWidthMode;
}

export interface DressingKit {
  readonly id: DressingKitId;
  /** Default facade before the D3 corner rule (always rb-blank/gb-blank — pizza-corner is a
   * claim-time override, never authored directly here). */
  readonly facadeModelId: typeof FACADE_MODEL_IDS.brick | typeof FACADE_MODEL_IDS.clean;
  /** Whether a claimed CORNER slot swaps this kit's facade to pizza-corner (D3). */
  readonly cornerRuleApplies: boolean;
  readonly fascia: FasciaSpec;
  readonly awning: AwningSpec | null;
  readonly props: readonly DressingPropSpec[];
  /** Fine-dining only (D7): a tiny plaque decal replacing the fascia band entirely. */
  readonly plaque?: typeof FINE_DINING_PLAQUE;
}

export const DRESSING_KITS: Readonly<Record<DressingKitId, DressingKit>> = {
  grocery: {
    id: 'grocery',
    facadeModelId: FACADE_MODEL_IDS.clean,
    cornerRuleApplies: false,
    fascia: { present: true, widthMode: 'full' },
    awning: { widthMode: 'full' },
    props: [
      {
        modelId: 'planter-bushes',
        count: 2,
        offsets: [
          { alongWu: -5.0, upWu: 0, outWu: 1.2 },
          { alongWu: 5.0, upWu: 0, outWu: 1.2 },
        ],
        mount: 'street',
        yaw: 0,
      },
      {
        modelId: 'flower-pot-a',
        count: 2,
        offsets: [
          { alongWu: -2.0, upWu: 0, outWu: 1.0 },
          { alongWu: 2.0, upWu: 0, outWu: 1.0 },
        ],
        mount: 'street',
        yaw: 0,
      },
      {
        // "produce-stand read" — a small cluster near the door, not a literal vertical stack.
        modelId: 'box',
        count: 3,
        offsets: [
          { alongWu: -0.6, upWu: 0, outWu: 1.6 },
          { alongWu: 0, upWu: 0, outWu: 1.8 },
          { alongWu: 0.6, upWu: 0, outWu: 1.6 },
        ],
        mount: 'street',
        yaw: 0,
      },
      {
        modelId: 'air-conditioner',
        count: 1,
        offsets: [{ alongWu: 0, upWu: 2.0, outWu: 0.15 }],
        mount: 'flank',
        yaw: Math.PI / 2,
      },
      {
        modelId: 'trash-bag-grey',
        count: 2,
        offsets: [
          { alongWu: -4.0, upWu: 0, outWu: 0.8 },
          { alongWu: 4.0, upWu: 0, outWu: 0.8 },
        ],
        mount: 'street',
        yaw: 0,
      },
    ],
  },

  bar: {
    id: 'bar',
    facadeModelId: FACADE_MODEL_IDS.brick,
    cornerRuleApplies: false,
    fascia: { present: true, widthMode: 'wide' },
    awning: { widthMode: 'narrow' },
    props: [
      {
        modelId: 'rock-band-poster',
        count: 2,
        offsets: [
          { alongWu: -2.2, upWu: 3.0, outWu: 0.12 },
          { alongWu: 2.2, upWu: 3.0, outWu: 0.12 },
        ],
        mount: 'street',
        yaw: 0,
      },
      {
        // Two fire-exit props at the same along, different up — reads as a stacked fire escape.
        modelId: 'fire-exit',
        count: 2,
        offsets: [
          { alongWu: -4.5, upWu: 0, outWu: 0.15 },
          { alongWu: -4.5, upWu: 2.6, outWu: 0.15 },
        ],
        mount: 'street',
        yaw: 0,
      },
      {
        modelId: 'air-conditioner',
        count: 1,
        offsets: [{ alongWu: 4.5, upWu: 2.2, outWu: 0.15 }],
        mount: 'street',
        yaw: 0,
      },
      {
        modelId: 'dumpster',
        count: 1,
        offsets: [{ alongWu: 6.2, upWu: 0, outWu: 1.6 }],
        mount: 'street',
        yaw: 0,
      },
    ],
  },

  'cafe-fastfood': {
    id: 'cafe-fastfood',
    facadeModelId: FACADE_MODEL_IDS.brick,
    cornerRuleApplies: true,
    fascia: { present: true, widthMode: 'standard' },
    awning: { widthMode: 'standard' },
    props: [
      {
        modelId: 'trash-can',
        count: 1,
        offsets: [{ alongWu: -2.5, upWu: 0, outWu: 1.2 }],
        mount: 'street',
        yaw: 0,
      },
      {
        modelId: 'trash-bag-grey',
        count: 1,
        offsets: [{ alongWu: -2.0, upWu: 0, outWu: 0.8 }],
        mount: 'street',
        yaw: 0,
      },
      {
        // "24 h read" — beside the door.
        modelId: 'atm',
        count: 1,
        offsets: [{ alongWu: 2.0, upWu: 0, outWu: 1.0 }],
        mount: 'street',
        yaw: 0,
      },
      {
        modelId: 'flower-pot-b',
        count: 1,
        offsets: [{ alongWu: 3.2, upWu: 0, outWu: 1.0 }],
        mount: 'street',
        yaw: 0,
      },
    ],
  },

  'asian-restaurant': {
    id: 'asian-restaurant',
    facadeModelId: FACADE_MODEL_IDS.brick,
    cornerRuleApplies: true,
    fascia: { present: true, widthMode: 'standard' },
    awning: { widthMode: 'small' },
    props: [
      {
        // "above the awning" — awning canopy bottom sits at AWNING.bottomYWu (2.8); this clears it.
        modelId: 'washing-line',
        count: 1,
        offsets: [{ alongWu: 0, upWu: 3.3, outWu: 0.5 }],
        mount: 'street',
        yaw: 0,
      },
      {
        modelId: 'air-conditioner',
        count: 2,
        offsets: [
          { alongWu: -2.8, upWu: 2.2, outWu: 0.15 },
          { alongWu: 2.8, upWu: 2.2, outWu: 0.15 },
        ],
        mount: 'street',
        yaw: 0,
      },
      {
        modelId: 'flower-pot-a',
        count: 2,
        offsets: [
          { alongWu: -0.8, upWu: 0, outWu: 1.0 },
          { alongWu: 0.8, upWu: 0, outWu: 1.0 },
        ],
        mount: 'street',
        yaw: 0,
      },
    ],
  },

  karaoke: {
    id: 'karaoke',
    facadeModelId: FACADE_MODEL_IDS.clean,
    cornerRuleApplies: false,
    fascia: { present: true, widthMode: 'standard', backingColorOverride: KARAOKE_BAND_BACKING },
    awning: null,
    props: [
      {
        // "the money prop" — facade-mounted, y 6-9 wu per the plan; 7.5 is the midpoint.
        modelId: 'billboard',
        count: 1,
        offsets: [{ alongWu: 0, upWu: 7.5, outWu: 0.3 }],
        mount: 'street',
        yaw: 0,
      },
      {
        modelId: 'air-conditioner',
        count: 2,
        offsets: [
          { alongWu: -3.0, upWu: 2.0, outWu: 0.15 },
          { alongWu: 3.0, upWu: 2.0, outWu: 0.15 },
        ],
        mount: 'street',
        yaw: 0,
      },
      {
        modelId: 'fire-exit',
        count: 1,
        offsets: [{ alongWu: 0, upWu: 0, outWu: 0.15 }],
        mount: 'street',
        yaw: 0,
      },
    ],
  },

  retail: {
    id: 'retail',
    facadeModelId: FACADE_MODEL_IDS.clean,
    cornerRuleApplies: false,
    fascia: { present: true, widthMode: 'wide' },
    awning: null,
    props: [
      {
        // "clean read" — deliberately minimal.
        modelId: 'planter-bushes',
        count: 2,
        offsets: [
          { alongWu: -3.5, upWu: 0, outWu: 1.2 },
          { alongWu: 3.5, upWu: 0, outWu: 1.2 },
        ],
        mount: 'street',
        yaw: 0,
      },
    ],
  },

  entertainment: {
    id: 'entertainment',
    facadeModelId: FACADE_MODEL_IDS.brick,
    cornerRuleApplies: false,
    fascia: { present: true, widthMode: 'wide' },
    awning: null,
    props: [
      {
        modelId: 'rock-band-poster',
        count: 2,
        offsets: [
          { alongWu: -3.0, upWu: 3.0, outWu: 0.12 },
          { alongWu: 3.0, upWu: 3.0, outWu: 0.12 },
        ],
        mount: 'street',
        yaw: 0,
      },
      {
        modelId: 'cone',
        count: 2,
        offsets: [
          { alongWu: -1.0, upWu: 0, outWu: 1.3 },
          { alongWu: 1.0, upWu: 0, outWu: 1.3 },
        ],
        mount: 'street',
        yaw: 0,
      },
      {
        modelId: 'dumpster',
        count: 1,
        offsets: [{ alongWu: 5.8, upWu: 0, outWu: 1.6 }],
        mount: 'street',
        yaw: 0,
      },
    ],
  },

  'fine-dining': {
    id: 'fine-dining',
    facadeModelId: FACADE_MODEL_IDS.clean,
    cornerRuleApplies: false,
    // "no band — tiny plaque decal only": fascia.present stays false; the plaque IS the sign.
    fascia: { present: false, widthMode: 'standard' },
    awning: null,
    plaque: FINE_DINING_PLAQUE,
    props: [
      {
        // "the joke IS the subtlety" — a single bush, nothing else.
        modelId: 'planter-bushes',
        count: 1,
        offsets: [{ alongWu: 0, upWu: 0, outWu: 1.0 }],
        mount: 'street',
        yaw: 0,
      },
    ],
  },
};
