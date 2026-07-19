// Toronto map v2 — district vibe kit (docs/map/TORONTO-MAP-SPEC-v2.md §6) as pure data.
// Single source of truth for the 13 §6 rows + two filler districts (genericDowntown,
// foldCorridor). Consumed by world/toronto/districts.ts, which resolves the declarative
// `bounds` references below against world/toronto/streets.ts (buildStreets) and the
// projection/polygon zone constants into concrete map-space rects. Pure data, no three/react.
//
// §4 material vocabulary → hex family used for `fillerColors` (muted for the permanent
// blue-hour lighting rig — CLAUDE.md locked decision):
//   glass_black  -> #262b33 family (near-black cool glass)
//   glass_blue   -> #2e4a5c family (deep teal-blue glass)
//   glass_green  -> #2e5c56 family (teal-green glass)
//   glass_gold   -> #6e5a34 family (muted brass, never bright gold under blue hour)
//   marble_white -> #a9aeb4 / #c9cdd2 family (pale cool "white glass reclad")
//   granite_red  -> #6b3a34 family (deep granite red)
//   brick_red    -> #8a5a42 family
//   brick_yellow -> #a68a4a family
//   limestone    -> #b7a06a family
//   precast_grey -> #4a4650 family (civic/brutalist grey, slight cool cast)
//   storefront   -> mixed mid-greys (#726d63 / #8f8a80 / #a39d8f family) + one warm/accent hex

/** Filler-stock building material vocabulary (§4). Drives the flat-colour extrusion look
 * (Addendum A.1/A.4) — district data below picks 3-5 hexes per district from these families. */
export type DistrictMaterial =
  | 'glass_black'
  | 'glass_blue'
  | 'glass_gold'
  | 'glass_green'
  | 'marble_white'
  | 'granite_red'
  | 'brick_red'
  | 'brick_yellow'
  | 'limestone'
  | 'precast_grey'
  | 'storefront';

/** Relative building-stock density (Task-1 brief): drives filler block subdivision size in
 * the Task-2 massing generator (dense = smaller footprints/more towers per block). */
export type DistrictDensity = 'dense' | 'medium' | 'sparse';

/** The 15 district ids: the 13 §6 rows + genericDowntown (complement filler, computed in
 * districts.ts) + foldCorridor (the sparse midtown-fold interior). */
export type DistrictId =
  | 'financial'
  | 'entertainment'
  | 'kingWest'
  | 'queenWest'
  | 'chinatownKensington'
  | 'yongeDundasQueen'
  | 'churchWellesley'
  | 'uoft'
  | 'stLawrence'
  | 'harbourfront'
  | 'bloorYorkville'
  | 'northYorkCentre'
  | 'willowdaleFinch'
  | 'genericDowntown'
  | 'foldCorridor';

/**
 * Named polygon/zone edges a district boundary can reference instead of a street centreline.
 * `bloor` / `sheppard` are the SPEC's own zone-boundary y-values (1830 / 1170 — see §1/§2 and
 * projection.ts's ZONE_BOUNDARIES), deliberately distinct from the *street* centrelines
 * `{street:'bloor'}` / `{street:'sheppard'}` (which sit a half-ribbon-width off, nudged so the
 * road ribbon itself stays inside the polygon — see streets.ts's boundary-nudge). Using the
 * zone edge for a district's top/bottom means it tiles flush against the fold corridor with
 * zero gap; using the street would leave a sliver uncovered. `foldWest`/`foldEast` are the
 * fold corridor's own x-extent (1200/1800) — not listed among the spec's polygon corners as a
 * single anchor, so they are exposed here as a named zone edge (derived in districts.ts from
 * PLAYABLE_POLYGON, never a literal) purely so foldCorridor's bounds can stay fully
 * declarative like every other district's.
 */
export type DistrictZoneEdge =
  | 'bloor'
  | 'sheppard'
  | 'shore'
  | 'capsuleTop'
  | 'capsuleWest'
  | 'capsuleEast'
  | 'downtownWest'
  | 'downtownEast'
  | 'foldWest'
  | 'foldEast';

/** One rect edge: either a street's centreline (by id — must match a world/toronto/streets.ts
 * Street.id) or a named polygon/zone edge. Resolved to a concrete coordinate in districts.ts. */
export type DistrictBoundsEdge = { readonly street: string } | { readonly zone: DistrictZoneEdge };

/** A district's rectangle, declared purely in terms of the streets/zones it sits between —
 * never a literal coordinate (districts.ts is the only place numbers get resolved). West/east
 * bound the x-span (or the district's own N-S streets); north/south bound the y-span. For
 * `genericDowntown` this is the "universe" rect districts.ts subtracts every other downtown-zone
 * district from (the complement, which may yield several rects). */
export interface DistrictBoundsRef {
  readonly west: DistrictBoundsEdge;
  readonly east: DistrictBoundsEdge;
  readonly north: DistrictBoundsEdge;
  readonly south: DistrictBoundsEdge;
}

/** One city-pack model id + its relative pick weight within a pool (frontage.ts normalizes —
 * weights need not sum to 1). `id` is a plain string (not imported from assets/cityPackManifest)
 * to keep this a zero-import pure-data file; torontoDistricts.test.ts / districts.test.ts
 * validate every id against the real manifest so a typo still fails loudly. */
export interface PackStockEntry {
  readonly id: string;
  readonly weight: number;
}

/** Street-tree row density for a district's sidewalk bands (Phase 25.6 D16, furniture.ts). */
export type TreeDensity = 'none' | 'sparse' | 'rows';

/**
 * Phase 25.6 D10 — city-pack model→district mapping. `models` is the non-corner filler pool
 * (drawn from the 5 non-corner building ids — big-building/building-red/building-green/
 * brown-building/greenhouse — plus the 2 blanks rb-blank/gb-blank; "7 types + 2 blanks" per the
 * criterion). `cornerModels` is the 2-id corner pool (building-red-corner, pizza-corner) that
 * frontage.ts prefers at intersection corner slots; an EMPTY `cornerModels` (financial,
 * harbourfront, northYorkCentre — "big-building only" districts) means the consumer falls back
 * to `models` for corner slots too — there is no dedicated corner-less-district path. Every
 * `tints` hex is a NEW near-white set (every channel >= ~0.72 / 0xB8) — 25.5 proved
 * instanceColor MULTIPLIES the palette texture, so the dark absolute §6 `fillerColors` hexes
 * would crush textured pack facades to black; `fillerColors` stays reserved for the untextured
 * backdrop boxes (D7). `pizza-corner` is capped at weight 0.05 of any `cornerModels` pool it
 * appears in (rare neighbourhood-pizza-joint read, never a majority) and is excluded entirely
 * from financial's pool (bank-tower district — a baked pizza sign there reads as a bug).
 */
export interface DistrictPackStock {
  readonly models: readonly PackStockEntry[];
  readonly cornerModels: readonly PackStockEntry[];
  readonly tints: readonly string[];
  readonly treeDensity: TreeDensity;
  /** True for the three tower districts that also get a sparse second row of legacy box
   * massing behind the pack frontage (D7) — financial, harbourfront, northYorkCentre. */
  readonly backdropTowers?: true;
}

export interface TorontoDistrictDef {
  readonly id: DistrictId;
  /** §6 display name. */
  readonly name: string;
  /** Subtle ground-fill hex under the block (§6 "tint" column), muted for permanent blue hour. */
  readonly groundTint: string;
  /** 3-5 hex colours for filler-building walls, drawn from the §4 material family the §6
   * "filler stock" column maps to. Filler buildings inherit this automatically (§6 rule);
   * only named buildings (Phase 24) override. Still used by the D7 backdrop-box path (untextured
   * geometry, absolute colour is correct there) — city-pack facades use `packStock.tints`
   * instead (see that field's doc comment for why). */
  readonly fillerColors: readonly string[];
  /** [min, max] filler-stock building height in REAL metres (Phase 24 named towers are exempt —
   * §3c's height curve is applied to a seeded value from this range by the massing generator).
   * Part-8 (D4) height cut: every row below is compressed from its pre-Part-8 value by
   * `lo' = round(lo*0.7)`, `hi' = min(110, round(hi*0.55))`, then `hi' = max(hi', lo'+4)` —
   * relative ordering between districts is preserved (financial stays tallest, etc). Named
   * towers (namedBuildings.ts) get their own NAMED_HEIGHT_SCALE (config/torontoMap.ts); heroes
   * (heroes.ts) are exempt from both. */
  readonly heightRangeM: readonly [number, number];
  readonly density: DistrictDensity;
  /** Declarative rect bounds — resolved against buildStreets() + zone constants in districts.ts. */
  readonly bounds: DistrictBoundsRef;
  /** Phase 25.6 D10 — city-pack model/tint/tree-row mapping (frontage.ts, furniture.ts). */
  readonly packStock: DistrictPackStock;
}

const street = (id: string): DistrictBoundsEdge => ({ street: id });
const zone = (z: DistrictZoneEdge): DistrictBoundsEdge => ({ zone: z });
/** PackStockEntry shorthand — keeps the per-district blocks below scannable. */
const pk = (id: string, weight: number): PackStockEntry => ({ id, weight });

// --- D10 corner-model pools (shared shorthand; every family district uses the same shape:
// building-red-corner as the workhorse, pizza-corner a rare (<=0.05) flavour pick) -----------
const CORNERS_STANDARD: readonly PackStockEntry[] = [pk('building-red-corner', 0.95), pk('pizza-corner', 0.05)];
const CORNERS_NO_PIZZA: readonly PackStockEntry[] = [pk('building-red-corner', 1)];
const CORNERS_NONE: readonly PackStockEntry[] = []; // financial/harbourfront/northYorkCentre — big-building only, frontage.ts falls back to `models`.

/**
 * The 15 districts, in §6 table order (financial → willowdaleFinch), then the two filler
 * districts (genericDowntown, foldCorridor). This order is the stable order buildDistricts()
 * returns (CLAUDE.md instance-buffer convention: district-ordered, recorded ranges).
 *
 * FINAL TILING (see districts.ts header for the resolved-number map + the geography this
 * bends): every boundary street/zone edge is SHARED between the two districts it separates —
 * rects may touch, never overlap interiors. Two §6-geography conflicts in the brief are
 * resolved here, matching the brief's own fix:
 *   - uoft narrows to spadina→university (not spadina→bay) so it doesn't eat bloorYorkville.
 *   - bloorYorkville becomes university→church (not bay→jarvis) — the middle of the three
 *     top-row downtown districts.
 *   - yongeDundasQueen narrows to bay→church (not yonge→church) so its west edge matches
 *     bloorYorkville/uoft's shared corner at bay, and churchWellesley keeps church→jarvis.
 * Net effect: three clean vertical strips along the bloor-zone/college row (uoft | bloorYorkville
 * | churchWellesley, split at university and church), sitting directly on the fold corridor's
 * south edge (zone 'bloor' = y 1830) with no seam gap.
 */
export const TORONTO_DISTRICTS: readonly TorontoDistrictDef[] = [
  {
    id: 'financial',
    name: 'Financial District',
    groundTint: '#3a3f47',
    fillerColors: ['#262b33', '#1e222a', '#3a4048', '#8f969e', '#c9cdd2'],
    heightRangeM: [42, 110],
    density: 'medium',
    bounds: { west: street('university'), east: street('yonge'), north: street('queen'), south: street('front') },
    // Bank-tower district: big-building only (no street-level family/corner facades), cool
    // blue-grey near-white tints, pizza-corner explicitly excluded (D10), backdrop towers.
    packStock: {
      models: [pk('big-building', 1)],
      cornerModels: CORNERS_NONE,
      tints: ['#c8d0d8', '#c0c8d0', '#d0d8e0'],
      treeDensity: 'sparse',
      backdropTowers: true,
    },
  },
  {
    id: 'entertainment',
    name: 'Entertainment District',
    groundTint: '#33283f',
    fillerColors: ['#4a4650', '#3d3944', '#5c5666', '#302c38'],
    heightRangeM: [11, 25],
    density: 'medium',
    bounds: { west: street('spadina'), east: street('university'), north: street('queen'), south: street('king') },
    // Brick strip (D10: "brown-building + building-red (brick)"), warm near-white tints.
    packStock: {
      models: [pk('building-red', 0.45), pk('brown-building', 0.4), pk('rb-blank', 0.1), pk('gb-blank', 0.05)],
      cornerModels: CORNERS_STANDARD,
      tints: ['#e8c8c0', '#e0c0b8', '#f0d0c8'],
      treeDensity: 'rows',
    },
  },
  {
    id: 'kingWest',
    name: 'King West',
    groundTint: '#453329',
    fillerColors: ['#8a5a42', '#7a4d38', '#96684e', '#6b4230'],
    heightRangeM: [8, 17],
    density: 'medium',
    bounds: { west: street('bathurst'), east: street('spadina'), north: street('queen'), south: street('front') },
    // Same brick flavour as entertainment (D10 groups the two), warm near-white tints.
    packStock: {
      models: [pk('brown-building', 0.45), pk('building-red', 0.4), pk('rb-blank', 0.1), pk('gb-blank', 0.05)],
      cornerModels: CORNERS_STANDARD,
      tints: ['#e0c0b8', '#e8c8c0', '#f0d0c8'],
      treeDensity: 'rows',
    },
  },
  {
    id: 'queenWest',
    name: 'Queen West',
    groundTint: '#454034',
    fillerColors: ['#8f8a80', '#a39d8f', '#726d63', '#bdb6a6'],
    heightRangeM: [6, 10],
    density: 'dense',
    bounds: { west: street('bathurst'), east: street('university'), north: street('dundas'), south: street('queen') },
    // D10 sketch: "red/green family + corners heavy, brown-building, warm tints".
    packStock: {
      models: [pk('building-red', 0.3), pk('building-green', 0.3), pk('brown-building', 0.15), pk('rb-blank', 0.15), pk('gb-blank', 0.1)],
      cornerModels: CORNERS_STANDARD,
      tints: ['#f0e0c8', '#e8d0b8', '#f0d8c0'],
      treeDensity: 'rows',
    },
  },
  {
    id: 'chinatownKensington',
    name: 'Chinatown / Kensington Market',
    groundTint: '#3a2f24',
    fillerColors: ['#8f8a80', '#7d5048', '#5c7355', '#a39d8f', '#726d63'],
    heightRangeM: [6, 10],
    density: 'dense',
    bounds: { west: street('bathurst'), east: street('spadina'), north: street('college'), south: street('dundas') },
    // D10 sketch groups chinatownKensington with queenWest/willowdale (red/green + corners
    // heavy, brown-building, warm tints) — slightly more brown-building for the market masonry.
    packStock: {
      models: [pk('brown-building', 0.35), pk('building-red', 0.25), pk('building-green', 0.2), pk('rb-blank', 0.1), pk('gb-blank', 0.1)],
      cornerModels: CORNERS_STANDARD,
      tints: ['#e8d0b8', '#f0e0c8', '#f0d8c0'],
      treeDensity: 'rows',
    },
  },
  {
    id: 'yongeDundasQueen',
    name: 'Yonge-Dundas to Queen',
    groundTint: '#3f3a2c',
    fillerColors: ['#8f8a80', '#a39d8f', '#726d63', '#9aa3ad'],
    heightRangeM: [14, 44],
    density: 'dense',
    // Bent from the brief's first draft (yonge->church) — narrowed to bay->church so its west
    // edge shares the bay corner with uoft/bloorYorkville instead of overlapping them (see
    // module header + districts.ts).
    bounds: { west: street('bay'), east: street('church'), north: street('college'), south: street('queen') },
    // D10 sketch: "family + big-building" — the retail core reads a bit taller/glassier.
    packStock: {
      models: [pk('big-building', 0.35), pk('building-red', 0.25), pk('building-green', 0.15), pk('brown-building', 0.1), pk('rb-blank', 0.1), pk('gb-blank', 0.05)],
      cornerModels: CORNERS_STANDARD,
      tints: ['#e8e0d0', '#e0d8c8', '#f0e8d8'],
      treeDensity: 'rows',
    },
  },
  {
    id: 'churchWellesley',
    name: 'Church-Wellesley',
    groundTint: '#33283a',
    fillerColors: ['#a68a4a', '#8f7640', '#bfa25c', '#7a6436'],
    heightRangeM: [7, 11],
    density: 'medium',
    bounds: { west: street('church'), east: street('jarvis'), north: zone('bloor'), south: street('college') },
    // D10 sketch groups churchWellesley with genericDowntown/foldCorridor — "mixed family".
    packStock: {
      models: [pk('building-red', 0.2), pk('building-green', 0.2), pk('brown-building', 0.2), pk('big-building', 0.1), pk('rb-blank', 0.15), pk('gb-blank', 0.15)],
      cornerModels: CORNERS_STANDARD,
      tints: ['#d8d8d8', '#d0d0d0', '#e0e0e0'],
      treeDensity: 'rows',
    },
  },
  {
    id: 'uoft',
    name: 'U of T / Discovery District',
    groundTint: '#2e332e',
    fillerColors: ['#b7a06a', '#a08d5c', '#5c5a52', '#726f66'],
    heightRangeM: [11, 22],
    density: 'sparse',
    // Bent from the brief's first draft (spadina->bay) — narrowed to spadina->university so it
    // doesn't overlap bloorYorkville (see module header + districts.ts).
    bounds: { west: street('spadina'), east: street('university'), north: zone('bloor'), south: street('college') },
    // D10 sketch: "brown-building sparse + greenhouse garnish".
    packStock: {
      models: [pk('brown-building', 0.65), pk('greenhouse', 0.15), pk('gb-blank', 0.1), pk('rb-blank', 0.1)],
      cornerModels: CORNERS_NO_PIZZA,
      tints: ['#d8d0c0', '#d0c8b8', '#e0d8c8'],
      treeDensity: 'sparse',
    },
  },
  {
    id: 'stLawrence',
    name: 'St Lawrence / Old Town',
    groundTint: '#3d3527',
    fillerColors: ['#8a5a42', '#96684e', '#a3714f', '#7a4d38'],
    heightRangeM: [8, 14],
    density: 'medium',
    bounds: { west: street('yonge'), east: street('jarvis'), north: street('king'), south: street('front') },
    // D10 sketch groups stLawrence with entertainment/kingWest — brick, warm near-white tints.
    packStock: {
      models: [pk('brown-building', 0.45), pk('building-red', 0.4), pk('rb-blank', 0.1), pk('gb-blank', 0.05)],
      cornerModels: CORNERS_STANDARD,
      tints: ['#f0d0c8', '#e8c8c0', '#e0c0b8'],
      treeDensity: 'rows',
    },
  },
  {
    id: 'harbourfront',
    name: 'Harbourfront',
    groundTint: '#28313a',
    fillerColors: ['#2e4a5c', '#3d5f73', '#264256', '#4a6f82'],
    heightRangeM: [28, 66],
    density: 'medium',
    bounds: { west: zone('downtownWest'), east: zone('downtownEast'), north: street('front'), south: zone('shore') },
    // D10 sketch: "big-building, pale-blue tints, backdropTowers" (third tower district).
    packStock: {
      models: [pk('big-building', 1)],
      cornerModels: CORNERS_NONE,
      tints: ['#c0d8e8', '#c8e0f0', '#b8d0e0'],
      treeDensity: 'sparse',
      backdropTowers: true,
    },
  },
  {
    id: 'bloorYorkville',
    name: 'Bloor / Yorkville',
    groundTint: '#3a3527',
    fillerColors: ['#b7a06a', '#c9b686', '#a08d5c', '#d4c398'],
    heightRangeM: [14, 50],
    density: 'medium',
    // Bent from the brief's first draft (bay->jarvis) — becomes university->church, the middle
    // strip between uoft and churchWellesley (see module header + districts.ts).
    bounds: { west: street('university'), east: street('church'), north: zone('bloor'), south: street('college') },
    // D10 sketch: "building-green + blanks, pale-gold tints".
    packStock: {
      models: [pk('building-green', 0.55), pk('gb-blank', 0.25), pk('rb-blank', 0.2)],
      cornerModels: CORNERS_STANDARD,
      tints: ['#f0e8c0', '#e8d8b8', '#e8e0c0'],
      treeDensity: 'rows',
    },
  },
  {
    id: 'northYorkCentre',
    name: 'North York Centre',
    groundTint: '#2a3436',
    fillerColors: ['#2e5c56', '#3d7368', '#2e4a5c', '#3d5f73'],
    heightRangeM: [28, 83],
    density: 'medium',
    bounds: { west: zone('capsuleWest'), east: zone('capsuleEast'), north: street('parkhome'), south: zone('sheppard') },
    // D10 sketch: "big-building, teal tints, backdropTowers" (third tower district).
    packStock: {
      models: [pk('big-building', 1)],
      cornerModels: CORNERS_NONE,
      tints: ['#c0e0d8', '#b8d8d0', '#c8e8e0'],
      treeDensity: 'sparse',
      backdropTowers: true,
    },
  },
  {
    id: 'willowdaleFinch',
    name: 'Willowdale / Finch Strip',
    groundTint: '#3a2e28',
    fillerColors: ['#8f8a80', '#726d63', '#a3653f', '#bdb6a6'],
    heightRangeM: [6, 10],
    density: 'dense',
    bounds: { west: zone('capsuleWest'), east: zone('capsuleEast'), north: zone('capsuleTop'), south: street('parkhome') },
    // D10 sketch: "red/green family + corners heavy, brown-building, warm tints" (grouped with
    // queenWest/chinatownKensington).
    packStock: {
      models: [pk('building-red', 0.3), pk('building-green', 0.25), pk('brown-building', 0.2), pk('rb-blank', 0.15), pk('gb-blank', 0.1)],
      cornerModels: CORNERS_STANDARD,
      tints: ['#f0d8c0', '#f0e0c8', '#e8d0b8'],
      treeDensity: 'rows',
    },
  },
  {
    id: 'genericDowntown',
    name: 'Downtown (generic)',
    groundTint: '#33363c',
    fillerColors: ['#454b54', '#383d45', '#525862', '#2c313a'],
    heightRangeM: [7, 22],
    density: 'medium',
    // The "universe" rect districts.ts subtracts every other downtown-zone district's rect
    // from — the true per-district output is the complement (may be several rects).
    bounds: { west: zone('downtownWest'), east: zone('downtownEast'), north: zone('bloor'), south: zone('shore') },
    // D10 sketch: "mixed family" (grouped with churchWellesley/foldCorridor).
    packStock: {
      models: [pk('building-red', 0.2), pk('building-green', 0.2), pk('brown-building', 0.15), pk('big-building', 0.15), pk('rb-blank', 0.15), pk('gb-blank', 0.15)],
      cornerModels: CORNERS_STANDARD,
      tints: ['#d0d0d0', '#d8d8d8', '#e0e0e0'],
      treeDensity: 'sparse',
    },
  },
  {
    id: 'foldCorridor',
    name: 'Midtown Fold Corridor',
    groundTint: '#2e3136',
    fillerColors: ['#454b54', '#383d45', '#3a4048'],
    heightRangeM: [6, 10],
    density: 'sparse',
    bounds: { west: zone('foldWest'), east: zone('foldEast'), north: zone('sheppard'), south: zone('bloor') },
    // D10 sketch: "mixed family", sparse interior — minimal corner variety.
    packStock: {
      models: [pk('building-red', 0.25), pk('building-green', 0.25), pk('brown-building', 0.2), pk('rb-blank', 0.15), pk('gb-blank', 0.15)],
      cornerModels: CORNERS_NO_PIZZA,
      tints: ['#d0d0d0', '#d8d8d8', '#e0e0e0'],
      treeDensity: 'sparse',
    },
  },
] as const;
