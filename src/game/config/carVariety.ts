// Toronto civilian-car variety DATA (Phase 29 D4). The model-weight table + the 12-colour
// Toronto street-car palette + the HSV-jitter / anti-repeat tuning that the PURE algorithm in
// vehicles/carVariety.ts consumes. House rule: config numbers live only in config/ — this module
// holds every tunable; carVariety.ts holds no literals of its own.
//
// The 7 civilian vehicle models are the pack's non-pursuit cars. police-car/bus/bicycle/
// motorcycle are deliberately excluded (a parked cruiser reads as a pursuit unit; no transit-lane
// story; kickstand/lean fiddliness) — the same exclusions the retired config/torontoDress.ts
// PARKED_MODELS carried, now the single source of truth for BOTH street-parked cars and moving
// traffic (Phase 29 folded them into one variety system).
//
// NEUTRAL-BODY variant seam (Phase 29 D5): every civilian model has a `<id>-neutral` GLB emitted
// by scripts/city-pack.mjs (its saturated body cells remapped to a light neutral grey, glass/tires/
// trim untouched) so a plain instanceColor/material-colour multiply produces a TRUE body colour.
// Civilian-variety render contexts (traffic mesh, street-parked cars, parking-lot cars) load the
// neutral id; every other context loads the original. `neutralVehicleModelId` is the ONE place that
// maps base → neutral at runtime (the pipeline's mjs mirror is scripts/lib/cityPackNeutralBody.mjs;
// both are the trivial `${id}-neutral` suffix — kept in sync by the manifest drift-guard test that
// asserts the neutral entry exists for every civilian id).

/** Suffix the pipeline appends to a civilian vehicle id for its neutral-body variant. */
export const NEUTRAL_BODY_SUFFIX = '-neutral';

/** Base civilian model id → its neutral-body variant id (the geometry civilian-variety contexts
 * render so instanceColor tints read as true body colours). */
export function neutralVehicleModelId(baseId: string): string {
  return `${baseId}${NEUTRAL_BODY_SUFFIX}`;
}

export interface CarModelWeight {
  readonly id: string;
  readonly weight: number;
}

/** Weighted civilian-vehicle model set (D4). Matches the retired PARKED_MODELS weights exactly;
 * now shared by traffic + parked + lot cars. Weights are relative (normalized by the picker). */
export const CIVILIAN_CAR_MODELS: readonly CarModelWeight[] = [
  { id: 'car-a', weight: 0.3 },
  { id: 'car-b', weight: 0.25 },
  { id: 'suv', weight: 0.2 },
  { id: 'van', weight: 0.1 },
  { id: 'pickup-truck', weight: 0.1 },
  { id: 'sports-car-a', weight: 0.025 },
  { id: 'sports-car-b', weight: 0.025 },
] as const;

/** The two sports models bias their colour roll toward saturated palette entries (D4). */
export const SPORTS_MODEL_IDS: readonly string[] = ['sports-car-a', 'sports-car-b'];

export type CarColorFamily =
  | 'white'
  | 'silver'
  | 'grey'
  | 'black'
  | 'red'
  | 'blue'
  | 'green'
  | 'yellow';

export interface CarColorEntry {
  /** Base body colour (sRGB hex) — the neutral-body variant tinted by this multiplies to it. */
  readonly hex: string;
  /** Anti-repeat groups by family: no identical (model + family) within the last-N picks. */
  readonly family: CarColorFamily;
  /** Civilian pick weight (relative). */
  readonly weight: number;
  /** Sports models up-weight `saturated` entries by SPORTS_SATURATED_BIAS. */
  readonly saturated: boolean;
}

/**
 * The 12-colour Toronto street-car palette (D4). White/black/grey/silver dominate (~65% of the
 * neutral+colour weight); red/blue are the minority colours; green/burgundy/taxi-yellow are the
 * rare accents. Every hex is the FINAL desired body colour — the neutral-body variant renders as a
 * light grey, so instanceColor(hex) multiplies to approximately this on screen.
 */
export const TORONTO_CAR_PALETTE: readonly CarColorEntry[] = [
  // Neutrals (~65% combined) — white / silver / grey / black dominate the street.
  { hex: '#e9eaec', family: 'white', weight: 0.15, saturated: false }, // white
  { hex: '#c3c8cd', family: 'silver', weight: 0.13, saturated: false }, // silver
  { hex: '#cfc7b6', family: 'silver', weight: 0.05, saturated: false }, // champagne
  { hex: '#828991', family: 'grey', weight: 0.12, saturated: false }, // grey
  { hex: '#3f444b', family: 'grey', weight: 0.09, saturated: false }, // charcoal
  { hex: '#232529', family: 'black', weight: 0.11, saturated: false }, // black
  // Minority colours — red / blue.
  { hex: '#b23a30', family: 'red', weight: 0.1, saturated: true }, // red
  { hex: '#35618e', family: 'blue', weight: 0.085, saturated: true }, // blue
  { hex: '#2a3c5e', family: 'blue', weight: 0.04, saturated: true }, // navy
  // Rare accents — green / burgundy / taxi-yellow.
  { hex: '#2f6f52', family: 'green', weight: 0.035, saturated: true }, // racing green
  { hex: '#6c2a34', family: 'red', weight: 0.02, saturated: true }, // burgundy
  { hex: '#d8a12a', family: 'yellow', weight: 0.01, saturated: true }, // taxi yellow (rarest)
] as const;

/** Per-pick HSV jitter so two cars of the "same" palette colour aren't pixel-identical (D4).
 * Small: hue in degrees, sat/val in [0,1] units — applied ± around the base colour, seeded. */
export const CAR_COLOR_JITTER = {
  hueDeg: 5,
  sat: 0.05,
  val: 0.05,
} as const;

/** Anti-repeat window (D4): no identical (model id + colour family) within the last N picks of a
 * sequence. 3 = "no back-to-back-to-back same-look car". */
export const CAR_VARIETY_ANTI_REPEAT_WINDOW = 3;

/** How many times the colour is re-rolled to escape the anti-repeat window before the pick is
 * accepted anyway (guards a degenerate palette where every colour of a family is exhausted). */
export const CAR_VARIETY_MAX_REROLLS = 8;

/** Sports models multiply every `saturated` palette entry's weight by this in their colour roll,
 * so a sports car reads red/blue/green/yellow far more often than silver/grey (D4). At 10, ~82% of
 * sports cars pick a saturated colour (vs ~44% for a regular car). */
export const SPORTS_SATURATED_BIAS = 10;
