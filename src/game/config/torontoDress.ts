// Toronto map v2 — street furniture + parked-vehicle placement tuning (Phase 25.6 D16/D18,
// CLAUDE.md CITY-PACK REAPPROACH criterion 3). Single source of truth for every spacing/
// density/offset/cap number world/toronto/furniture.ts consumes — no magic numbers there.
// Pure data, no three/react. Offsets are measured in wu FROM THE RIBBON EDGE (a street's
// `halfWidth`, i.e. the outer edge of the asphalt/curb) unless documented otherwise, matching
// the D6 frontage engine's own convention (facade line = ribbon edge + SIDEWALK.widthWu) so a
// future SIDEWALK.widthWu retune re-flows both frontage and furniture together.

import { DENSITY } from './torontoMap';
import { TORONTO_DISTRICTS, type DistrictId } from './torontoDistricts';

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
/** A composable prefab: perimeter fence + 2 cone clusters + road-bits plates + a floor-hole +
 * dumpster + boxes + debris-papers + a seeded-subset billboard. Reserved BEFORE back-lot/parking
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
