// World generation, power grid, and prop-pool tunables. TDD §5.4 (world),
// §5.8 (power grid), §7 (props).
export const WORLD = {
  // 64 x 64 tiles @ 10 m/tile = 640 m x 640 m playable. TDD §5.4.
  tiles: 64,
  tileSize: 10,
  // District grid is 4x4 (16 districts total), each 16x16 tiles. TDD §5.8.
  districts: 4,
  // Arterial roads every 4-6 tiles in both axes. TDD §5.4.
  arterialEvery: [4, 6],
  // South edge is lakefront water (instant WRECKED on entry); other three edges are
  // highway barriers + fencing. No invisible walls — the edge is diegetic. TDD §5.4.
} as const;

// Map boundary tunables (TDD §5.4): south edge is lakefront water (Phase 4 emits
// `enteredWater` + logs it; Phase 9 wires the instant-WRECKED consequence), the other
// three edges (N/E/W) are highway barriers. All physics-relevant (collider/plane
// dimensions), so they live here rather than as component-local literals in
// world/CityScape.tsx, the sole consumer.
export const BOUNDARY = {
  // Ground slab margin beyond the 640x640 playable map, on every edge (m) — keeps the
  // slab comfortably under the barrier ring with a couple meters to spare.
  groundMarginM: 10,
  // South lakefront water: how far south of the map edge the plane/sensor extends, and
  // how wide (wider than the map so it reads as unbroken lake past the map's SE/SW
  // corners, not a thin flooded strip poking past them).
  waterLengthM: 200,
  waterWidthM: 700,
  // WATER sensor collider full height (m) — Rapier colliders need real thickness; tall
  // enough to catch the player at any reasonable off-the-edge trajectory near y=0.
  waterColliderHeightM: 6,
  // Highway barrier dimensions (TDD §5.4: the map edge must be diegetic, never an
  // invisible wall). Runs the three non-lake (N/E/W) edges just outside the ring road.
  barrierHeightM: 1,
  barrierThicknessM: 0.4,
  // How far outside the outer ring-road tile edge the barrier centerline sits (m) —
  // clear of the drivable ring lane, still well inside the ground slab margin.
  barrierOffsetM: 2,
  // Fell-out-of-world safety net: if the player chassis ever drops below this world Y,
  // respawn it at the map's spawn pose. Catches (a) the lake, until Phase 9 wires
  // enteredWater -> instant WRECKED, and (b) a rare main-thread-stall fall-through where
  // the raycast suspension misses its first PLAYING steps and the car free-falls from
  // spawn (measured signature: pure vertical fall, x/z frozen; root-cause investigation
  // backlogged for Phase 6's physics session). The map is flat — nothing legitimate is
  // ever below about -1 m — so -5 fires within ~1 s of a genuine fall while staying
  // clear of ordinary suspension bounce.
  fellOutResetY: -5,
} as const;

// Seeded-generation tunables consumed only by world/generate.ts. Everything here is a
// PLACEHOLDER GUESS pending the Phase 5 look check (the first time the city is rendered
// with real instancing/palette) — these numbers shape block mix and building silhouettes,
// so expect to retune them against how the map actually reads. TDD §5.4.
export const WORLD_GEN = {
  // Dev/default map seed (Toronto area code). Provisional pick — the Phase 5 look check
  // chooses a good-looking keeper once real rendering exists. The store boots with this;
  // runs re-roll or keep it via the garage/debug UI.
  defaultSeed: 416,
  // Relative weights for the kind rolled per block during fill. A dense, built-up city
  // with a scattering of open space: mostly small buildings, a handful of tower blocks,
  // some parking (Phase 6 fills these with parked-car props) and parks. Weights are
  // arbitrary — only their ratios matter. TDD §5.4 block set.
  blockKindWeights: {
    smallBuildings: 6,
    tower: 3,
    parkingLot: 2,
    park: 2,
  },
  // Relative weights for a single building footprint's tile size inside a smallBuildings
  // block (w×h in tiles, 1×1..2×2 per TDD §5.4). 1×1 dominates so streets read fine-
  // grained; the larger shapes give the occasional bigger structure. A footprint that
  // doesn't fit the remaining space degrades to a leftover paved yard, so these are
  // preferences, not guarantees.
  footprintSizes: [
    { w: 1, h: 1, weight: 5 },
    { w: 1, h: 2, weight: 2 },
    { w: 2, h: 1, weight: 2 },
    { w: 2, h: 2, weight: 2 },
  ],
  // Seeded building height range in metres [min, max], drawn from a COSMETIC rng stream
  // (separate from layout, so retuning heights never shifts where footprints land).
  // Placeholder scale-feel only — Phase 5 owns real silhouettes. Small = low-rise;
  // tower = midtown-ish (TDD §5.4 "mid towers").
  smallHeightM: [6, 14],
  towerHeightM: [25, 45],
} as const;

// Traffic-graph tunables consumed only by world/trafficGraph.ts (Phase 4 Task 2; the
// graph is what Phase 7 civilian followers drive along). Purely geometric — the graph is
// a deterministic function of the tile grid, no rng involved, so these are the only two
// numbers that shape it.
export const TRAFFIC = {
  // Lateral offset (metres) from a road tile's centre-line to a lane node's position,
  // toward the right-hand side of that lane's travel direction (right-hand traffic, TDD
  // §5.4). Must stay comfortably under half the tile size (5 m) so every node lands inside
  // its own tile.
  laneOffsetM: 2.5,
  // Spacing (in tiles) between waypoint nodes along a straight lane stretch, between one
  // intersection and the next. Keeps the Phase 7 follower graph coarse (fewer nodes =
  // cheaper) while still dense enough that a kinematic follower doesn't visibly cut
  // corners on long arterials.
  waypointSpacingTiles: 2,
} as const;

export const POWER_GRID = {
  // Transformer hit points. TDD §5.8.
  transformerHp: 30,
  // Flicker duration across the district before emitters switch off. TDD §5.8.
  flickerSec: 0.6,
  // Real dynamic PointLight pool size assigned to nearest lit emitters around the
  // player; TDD §5.8 specifies a range of 4-6 — using the upper bound.
  lightPoolSize: 6,
} as const;

export const PROPS = {
  // Dynamic prop pool cap (posts, hydrants, benches, parked cars once struck). TDD §7.
  dynamicPoolCap: 60,
  // Dynamic props auto-sleep and despawn after this many seconds. TDD §7.
  despawnAfterSec: 20,
  // PLACEHOLDER — TDD §7 says static props swap to dynamic "on an impact impulse above
  // threshold" without giving a number; tune once the physics/damage systems exist.
  wakeImpulseThreshold: 100,
} as const;
