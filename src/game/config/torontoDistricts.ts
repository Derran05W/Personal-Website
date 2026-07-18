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

export interface TorontoDistrictDef {
  readonly id: DistrictId;
  /** §6 display name. */
  readonly name: string;
  /** Subtle ground-fill hex under the block (§6 "tint" column), muted for permanent blue hour. */
  readonly groundTint: string;
  /** 3-5 hex colours for filler-building walls, drawn from the §4 material family the §6
   * "filler stock" column maps to. Filler buildings inherit this automatically (§6 rule);
   * only named buildings (Phase 24) override. */
  readonly fillerColors: readonly string[];
  /** [min, max] filler-stock building height in REAL metres (Phase 24 named towers are exempt —
   * §3c's height curve is applied to a seeded value from this range by the massing generator). */
  readonly heightRangeM: readonly [number, number];
  readonly density: DistrictDensity;
  /** Declarative rect bounds — resolved against buildStreets() + zone constants in districts.ts. */
  readonly bounds: DistrictBoundsRef;
}

const street = (id: string): DistrictBoundsEdge => ({ street: id });
const zone = (z: DistrictZoneEdge): DistrictBoundsEdge => ({ zone: z });

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
    heightRangeM: [60, 220],
    density: 'medium',
    bounds: { west: street('university'), east: street('yonge'), north: street('queen'), south: street('front') },
  },
  {
    id: 'entertainment',
    name: 'Entertainment District',
    groundTint: '#33283f',
    fillerColors: ['#4a4650', '#3d3944', '#5c5666', '#302c38'],
    heightRangeM: [15, 45],
    density: 'medium',
    bounds: { west: street('spadina'), east: street('university'), north: street('queen'), south: street('king') },
  },
  {
    id: 'kingWest',
    name: 'King West',
    groundTint: '#453329',
    fillerColors: ['#8a5a42', '#7a4d38', '#96684e', '#6b4230'],
    heightRangeM: [12, 30],
    density: 'medium',
    bounds: { west: street('bathurst'), east: street('spadina'), north: street('queen'), south: street('front') },
  },
  {
    id: 'queenWest',
    name: 'Queen West',
    groundTint: '#454034',
    fillerColors: ['#8f8a80', '#a39d8f', '#726d63', '#bdb6a6'],
    heightRangeM: [9, 16],
    density: 'dense',
    bounds: { west: street('bathurst'), east: street('university'), north: street('dundas'), south: street('queen') },
  },
  {
    id: 'chinatownKensington',
    name: 'Chinatown / Kensington Market',
    groundTint: '#3a2f24',
    fillerColors: ['#8f8a80', '#7d5048', '#5c7355', '#a39d8f', '#726d63'],
    heightRangeM: [8, 14],
    density: 'dense',
    bounds: { west: street('bathurst'), east: street('spadina'), north: street('college'), south: street('dundas') },
  },
  {
    id: 'yongeDundasQueen',
    name: 'Yonge-Dundas to Queen',
    groundTint: '#3f3a2c',
    fillerColors: ['#8f8a80', '#a39d8f', '#726d63', '#9aa3ad'],
    heightRangeM: [20, 80],
    density: 'dense',
    // Bent from the brief's first draft (yonge->church) — narrowed to bay->church so its west
    // edge shares the bay corner with uoft/bloorYorkville instead of overlapping them (see
    // module header + districts.ts).
    bounds: { west: street('bay'), east: street('church'), north: street('college'), south: street('queen') },
  },
  {
    id: 'churchWellesley',
    name: 'Church-Wellesley',
    groundTint: '#33283a',
    fillerColors: ['#a68a4a', '#8f7640', '#bfa25c', '#7a6436'],
    heightRangeM: [10, 20],
    density: 'medium',
    bounds: { west: street('church'), east: street('jarvis'), north: zone('bloor'), south: street('college') },
  },
  {
    id: 'uoft',
    name: 'U of T / Discovery District',
    groundTint: '#2e332e',
    fillerColors: ['#b7a06a', '#a08d5c', '#5c5a52', '#726f66'],
    heightRangeM: [15, 40],
    density: 'sparse',
    // Bent from the brief's first draft (spadina->bay) — narrowed to spadina->university so it
    // doesn't overlap bloorYorkville (see module header + districts.ts).
    bounds: { west: street('spadina'), east: street('university'), north: zone('bloor'), south: street('college') },
  },
  {
    id: 'stLawrence',
    name: 'St Lawrence / Old Town',
    groundTint: '#3d3527',
    fillerColors: ['#8a5a42', '#96684e', '#a3714f', '#7a4d38'],
    heightRangeM: [12, 25],
    density: 'medium',
    bounds: { west: street('yonge'), east: street('jarvis'), north: street('king'), south: street('front') },
  },
  {
    id: 'harbourfront',
    name: 'Harbourfront',
    groundTint: '#28313a',
    fillerColors: ['#2e4a5c', '#3d5f73', '#264256', '#4a6f82'],
    heightRangeM: [40, 120],
    density: 'medium',
    bounds: { west: zone('downtownWest'), east: zone('downtownEast'), north: street('front'), south: zone('shore') },
  },
  {
    id: 'bloorYorkville',
    name: 'Bloor / Yorkville',
    groundTint: '#3a3527',
    fillerColors: ['#b7a06a', '#c9b686', '#a08d5c', '#d4c398'],
    heightRangeM: [20, 90],
    density: 'medium',
    // Bent from the brief's first draft (bay->jarvis) — becomes university->church, the middle
    // strip between uoft and churchWellesley (see module header + districts.ts).
    bounds: { west: street('university'), east: street('church'), north: zone('bloor'), south: street('college') },
  },
  {
    id: 'northYorkCentre',
    name: 'North York Centre',
    groundTint: '#2a3436',
    fillerColors: ['#2e5c56', '#3d7368', '#2e4a5c', '#3d5f73'],
    heightRangeM: [40, 150],
    density: 'medium',
    bounds: { west: zone('capsuleWest'), east: zone('capsuleEast'), north: street('parkhome'), south: zone('sheppard') },
  },
  {
    id: 'willowdaleFinch',
    name: 'Willowdale / Finch Strip',
    groundTint: '#3a2e28',
    fillerColors: ['#8f8a80', '#726d63', '#a3653f', '#bdb6a6'],
    heightRangeM: [8, 15],
    density: 'dense',
    bounds: { west: zone('capsuleWest'), east: zone('capsuleEast'), north: zone('capsuleTop'), south: street('parkhome') },
  },
  {
    id: 'genericDowntown',
    name: 'Downtown (generic)',
    groundTint: '#33363c',
    fillerColors: ['#454b54', '#383d45', '#525862', '#2c313a'],
    heightRangeM: [10, 40],
    density: 'medium',
    // The "universe" rect districts.ts subtracts every other downtown-zone district's rect
    // from — the true per-district output is the complement (may be several rects).
    bounds: { west: zone('downtownWest'), east: zone('downtownEast'), north: zone('bloor'), south: zone('shore') },
  },
  {
    id: 'foldCorridor',
    name: 'Midtown Fold Corridor',
    groundTint: '#2e3136',
    fillerColors: ['#454b54', '#383d45', '#3a4048'],
    heightRangeM: [8, 14],
    density: 'sparse',
    bounds: { west: zone('foldWest'), east: zone('foldEast'), north: zone('sheppard'), south: zone('bloor') },
  },
] as const;
