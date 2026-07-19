// Toronto map v2 — street furniture + parked-vehicle placement tuning (Phase 25.6 D16/D18,
// CLAUDE.md CITY-PACK REAPPROACH criterion 3). Single source of truth for every spacing/
// density/offset/cap number world/toronto/furniture.ts consumes — no magic numbers there.
// Pure data, no three/react. Offsets are measured in wu FROM THE RIBBON EDGE (a street's
// `halfWidth`, i.e. the outer edge of the asphalt/curb) unless documented otherwise, matching
// the D6 frontage engine's own convention (facade line = ribbon edge + SIDEWALK.widthWu) so a
// future SIDEWALK.widthWu retune re-flows both frontage and furniture together.

import { DENSITY } from './torontoMap';

/**
 * Which road classes count as "full" for the traffic-light signalization rule (D16): both
 * crossing streets full -> 4-corner signalized; exactly one full -> 2-corner diagonal; neither
 * -> stop-sign garnish corner. Kept as a Set-able array (not re-deriving from ROAD_CLASSES
 * directly) so the rule reads as an explicit policy choice, not an accident of the width table.
 */
export const TRAFFIC_LIGHT_FULL_CLASSES = ['spine', 'artery', 'major'] as const;

export const TRAFFIC_LIGHT = {
  /** Extra setback (wu) beyond the corner's own (nsHalfWidth, ewHalfWidth) point — "ribbon edge
   * + 0.8 on both axes" (D16). */
  cornerOffsetWu: 0.8,
  /** Which of the 4 corner positions (see furniture.ts's cornerMastPositions, index order
   * [+ns/-ew, +ns/+ew, -ns/-ew, -ns/+ew]) a 2-mast DIAGONAL intersection uses. Fixed, not
   * randomized — a diagonal intersection always mounts opposite corners. */
  diagonalCornerIndices: [0, 3] as readonly [number, number],
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

/** Lamp-quad overlay geometry (D17). `headAnchor` is the head position relative to the mast model
 * origin, in RESOLVED world units (the traffic-light already resolves to ~7.2 wu wide / 6.3 wu tall
 * with its native arm on local −x — see config/cityPackScale.ts), BEFORE the mast's own yaw. The
 * mounting task rotates this offset by each mast's rotationY. Provisional — tunable live; D17's
 * static-heads fallback stands if the alignment fights back.
 * Phase 27 road-diet retune (live-verification FIX 2): re-scaled by 1.0/1.35 to match
 * cityPackScale.ts's 'traffic-light' override dropping from 1.35 to 1.0 (was {x:-5.4, y:5.1, z:0}). */
export const LAMP_OVERLAY = {
  headAnchor: { x: -4.0, y: 3.78, z: 0 } as const,
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
 * next mount (new seed, new run, or the torontoMap toggle), exactly like the legacy-world tiers.
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
} as const;

export const TREE_ROW = {
  spacingWu: 28,
  capMapWide: 700,
  /** Trunk collider half-extents (D12: "~0.5 x h x 0.5 wu" — never the canopy box
   * colliderHalfExtents(id) would produce). hxz is fixed; hy is computed per-placement from the
   * tree's actual resolved world height (resolveCityPackScale('tree') x nativeDims.h) / 2. */
  trunkHalfWidthWu: 0.25,
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
  /** Offset from the STREET CENTRELINE (not ribbon edge — these sit ON the road), alternating
   * sides along the street (D16: "centreline +/-1.5 wu"). */
  centerlineOffsetWu: 1.5,
  /** Only on spine + major (D16), never arteries/minors (keeps the count arithmetic honest). */
  eligibleClasses: ['spine', 'major'] as readonly string[],
} as const;

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
  /** Only on majors+ (spine/artery/major) — parking on a 3.5-car minor would eat the whole
   * drivable width. */
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

/** The eligible parked-vehicle model set + relative weights (D18) — GLOBAL, not per-district
 * (unlike packStock, which is the FILLER BUILDING mapping). `police-car`/`bus`/`bicycle`/
 * `motorcycle` are deliberate exclusions (D12/D18: a parked cruiser reads as a pursuit unit; no
 * transit-lane story; kickstand/lean fiddliness is garnish-tier at best). */
export const PARKED_MODELS: readonly { readonly id: string; readonly weight: number }[] = [
  { id: 'car-a', weight: 0.3 },
  { id: 'car-b', weight: 0.25 },
  { id: 'suv', weight: 0.2 },
  { id: 'van', weight: 0.1 },
  { id: 'pickup-truck', weight: 0.1 },
  { id: 'sports-car-a', weight: 0.025 },
  { id: 'sports-car-b', weight: 0.025 },
] as const;
