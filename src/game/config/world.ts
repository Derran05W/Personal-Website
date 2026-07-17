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
  // Ground slab thickness (m). The TOP face stays at y=0 (the wheel-ray contract) — this is
  // only how far the slab extends DOWNWARD, so it never affects gameplay visuals or feel.
  // Thickened 1 → 30 m in the Phase 6 wave-2 fall-through session: cheap insurance so that
  // even if a chassis ever got below the surface, there is deep solid ground to land on and
  // no thin-shell bottom to exit through. (The load-bearing fall-through fix is the vehicle
  // suspension catch — VEHICLE_TUNING.safety; this slab depth is defense-in-depth.)
  groundThicknessM: 30,
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
    // Lowered 3 → 2 alongside the tower height cut (below): fewer, shorter towers reduce
    // how often the fixed §5.3 camera (eye height ≈ 14 m) is fully occluded by a tower
    // adjacent to the road. Phase 5 look-check decision — accept brief occlusion,
    // Smashy-style; a fade shader remains a Phase 16 candidate if the user disagrees.
    tower: 2,
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
  // Cut from [25, 45] at Phase 5 integration (camera-occlusion decision — see
  // blockKindWeights.tower above). Still ~2× the small range, so towers read as towers.
  towerHeightM: [16, 28],
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

// Procedural geometry dimensions for the instanced city (world/geometry/*.ts, Phase 5 Task
// 2). Every builder there is parameterless except buildings (which take a bucketed variant
// spec) — one canonical geometry per street-prop archetype, shared by every instance via
// InstancedMesh. All lengths in metres; kept small on purpose (thousands of instances city-
// wide multiply whatever a single variant costs).
export const PROP_DIMS = {
  // Window-grid + parapet tunables (world/geometry/buildings.ts). All windows on one
  // building share ONE wall tone (windowSeed-rolled) and the SAME emissive cell
  // (windowWarm) — whether a given building instance actually glows is a per-instance
  // attribute set elsewhere (TDD §5.8), not baked into the geometry.
  building: {
    floorHeightM: 4, // target vertical spacing between window rows
    windowColSpacingM: 4, // target horizontal spacing between window columns
    windowWidthM: 1.4,
    windowHeightM: 1.8,
    windowSideMarginM: 1.2, // clearance from a wall's side edges before the first/last column
    windowBottomMarginM: 1.5, // clearance from ground level (no street-level windows)
    windowTopMarginM: 1, // clearance from the roofline
    windowInsetM: 0.04, // window quads sit this far proud of the wall plane (z-fight guard)
    parapetHeightM: 1.2, // tower-only roof lip, stacked on top of the wall height
    // Representative heights rendered per kind (see buildingVariantKey/bucketHeightM) —
    // both the instancing consumer and this module derive buckets from the SAME
    // WORLD_GEN.smallHeightM/towerHeightM range split into this many equal spans, so they
    // can never disagree.
    heightBuckets: 3,
  },
  streetlight: {
    poleHeightM: 5.5,
    poleRadiusM: 0.09,
    poleSides: 8,
    armLengthM: 1.3,
    armThicknessM: 0.1,
    headWidthM: 0.5,
    headDepthM: 0.4,
    headHeightM: 0.3,
  },
  trafficLight: {
    poleHeightM: 3.4,
    poleRadiusM: 0.08,
    poleSides: 8,
    headWidthM: 0.4,
    headHeightM: 1,
    headDepthM: 0.28,
    cellSizeM: 0.24,
    cellGapM: 0.06, // vertical spacing between the 3 stacked signal cells
    cellInsetM: 0.03, // signal cell quads sit this far proud of the head's front face
  },
  tree: {
    trunkHeightM: 1.3,
    trunkRadiusM: 0.15,
    trunkSides: 6,
    foliageSides: 8,
    foliageTiers: 3,
    foliageBaseRadiusM: 1.15, // bottom (widest) tier's base radius
    foliageShrink: 0.68, // each higher tier's base radius = previous * this
    foliageTierHeightM: 1, // each tier's own base-to-apex height
    foliageOverlapM: 0.4, // each tier starts this far below the previous tier's base
  },
  bench: {
    seatWidthM: 1.6,
    seatDepthM: 0.42,
    seatThicknessM: 0.08,
    seatHeightM: 0.45, // ground clearance to the underside of the seat
    backHeightM: 0.5,
    backThicknessM: 0.06,
    legThicknessM: 0.08,
  },
  hydrant: {
    bodyHeightM: 0.55,
    bodyRadiusM: 0.14,
    bodySides: 8,
    capHeightM: 0.12,
    capRadiusM: 0.17,
    nozzleRadiusM: 0.05,
    nozzleLengthM: 0.12,
  },
  mailbox: {
    postHeightM: 0.9,
    postRadiusM: 0.05,
    postSides: 6,
    bodyWidthM: 0.45,
    bodyHeightM: 0.4,
    bodyDepthM: 0.35,
  },
  fenceSegment: {
    lengthM: 2.5, // divides WORLD.tileSize (10) exactly — 4 segments close one tile edge
    heightM: 1.2,
    postThicknessM: 0.07,
    railThicknessM: 0.05,
    crossbarThicknessM: 0.04,
  },
  transformerBox: {
    widthM: 1.5,
    depthM: 1.1,
    heightM: 1.6,
    plinthHeightM: 0.15,
    plinthOutsetM: 0.08,
    knobRadiusM: 0.06,
    knobHeightM: 0.2,
    knobSides: 6,
    knobCount: 3,
  },
  // Parked car (Phase 6 Task 4): a chunky low-poly sedan echoing RustySedanMesh's
  // proportions (vehicles/RustySedanMesh.tsx), built ground-up (origin y=0) instead of
  // chassis-centered since this is a static world prop, not a physics-driven mesh. Overall
  // footprint lands close to the ~4.4 x 1.5 x 1.9 m target: bodyBottomM + bodyHeightM +
  // cabinHeightM ~= 1.54 m tall, bodyWidthM 1.9 m wide, bodyLengthM 4.4 m long (bumpers add
  // a little more at each end, same spirit as RustySedanMesh's bumper overhang).
  parkedCar: {
    bodyWidthM: 1.9,
    bodyHeightM: 0.8,
    bodyLengthM: 4.4,
    bodyBottomM: 0.32, // ground clearance to the body's underside
    cabinWidthM: 1.5,
    cabinLengthM: 2.1,
    cabinHeightM: 0.42,
    cabinZOffsetM: -0.15, // aft shift off body center, sedan-ish greenhouse
    bumperWidthM: 1.82,
    bumperHeightM: 0.24,
    bumperDepthM: 0.16,
    bumperCenterYM: 0.28,
    lightWidthM: 0.32,
    lightHeightM: 0.14,
    lightInsetM: 0.02, // light quads sit this far proud of the body's front/rear face
    wheelRadiusM: 0.35,
    wheelWidthM: 0.26,
    halfTrackM: 0.8,
    frontZM: 1.5,
    rearZM: -1.55,
  },
} as const;

export const PROPS = {
  // Dynamic prop pool cap (posts, hydrants, benches, parked cars once struck). TDD §7.
  // Also the per-archetype dynamic InstancedMesh size (world/propDynamics.ts) — every
  // archetype's flying-prop mesh is allocated this many slots, of which at most this many
  // are ever live GLOBALLY (the pool cap is a single global budget, never per-archetype).
  dynamicPoolCap: 60,
  // Dynamic props auto-sleep and despawn after this many seconds. TDD §7.
  despawnAfterSec: 20,
  // Parked-car hit points (Phase 6 Task 4) — heavier/tougher than a transformer (30 hp,
  // POWER_GRID.transformerHp) since a parked car is a much bigger mass to total; tuned
  // alongside the damage resolver (sibling task) against feel, not a TDD-given number.
  parkedCarHp: 40,

  // --- Fixed → dynamic swap (Phase 6 Task 2, world/propDynamics.ts; reused verbatim by
  //     Phase 12 tank explosions) ---------------------------------------------------------
  // The "everything is nailed down until you hit it" trick: a street prop lives as a zero-
  // cost fixed collider until an impact whose contact force reaches its per-archetype
  // threshold knocks it into the dynamic pool, inheriting a launch impulse.
  //
  // Per-archetype rigid-body mass (kg) the prop is given the instant it swaps. Toy-physics
  // plausible, not real — heavier props shove/tumble more ponderously under an equal launch
  // impulse (F = ma), which is exactly the intended mass-feel. FEEL-TUNABLE PLACEHOLDERS
  // (Phase 06 plan proposal table); tune live via leva against how a drive-through reads.
  // transformerBox is intentionally ABSENT: it is HP-based (registry kind 'transformer'),
  // killed by the damage resolver, and never impulse-swaps through propDynamics.
  masses: {
    mailbox: 30,
    fenceSegment: 40,
    bench: 60,
    hydrant: 90,
    streetlight: 120,
    trafficLight: 150,
    tree: 200,
    parkedCar: 1200,
  },
  // Per-archetype contact-force magnitude (N) an impact must REACH to swap the prop to
  // dynamic; below it the prop stays nailed down (love-taps are free — TDD §5.10). An
  // archetype absent here never impulse-swaps (the swap gate treats a missing threshold as
  // "not swappable"). FEEL-TUNABLE PLACEHOLDERS — calibrated live via the debug sliders
  // once the real contact spine (combat/contacts.ts) feeds true Rapier forces.
  forceThresholds: {
    mailbox: 300,
    bench: 300,
    fenceSegment: 300,
    streetlight: 600,
    hydrant: 600,
    trafficLight: 600,
    tree: 800,
    parkedCar: 1500,
  },
  // Launch feel once swapped. The impulse applied at the contact point (so the prop tumbles):
  //   dir     = normalize(propPos − impactPoint), then dir.y += launchUpKick
  //   impulse = dir × min(forceMag, launchForceCap) × launchImpulseScale
  // All FEEL-TUNABLE PLACEHOLDERS.
  launchImpulseScale: 0.14, // N → kg·m/s toss conversion (a solid hit throws a post satisfyingly)
  launchUpKick: 0.55, // +Y added to the unit horizontal launch dir → arc + tumble
  launchForceCap: 9000, // clamp runaway contact forces so one huge hit can't over-launch (N)
  // Settling damping on a freshly-swapped body so it comes to rest (and auto-sleeps) within
  // a few seconds instead of skating forever. Feel-tunable placeholders.
  settleLinearDamping: 0.4,
  settleAngularDamping: 0.6,
} as const;

// Prop-placement density/geometry tunables consumed only by world/propPlacements.ts (Phase
// 5 Task 2). Purely cosmetic placement — never shifts the LAYOUT rng stream (placements
// fork a dedicated 'props' child of the world seed), so retuning any of these can never
// change generate.ts's golden hash.
export const PROP_PLACEMENT = {
  // Streetlights: one per this many qualifying (road-adjacent) road tiles walked in
  // row-major order.
  streetlightStrideRoadTiles: 2,
  // How far a streetlight sits from its road tile's own center, toward the curb edge
  // bordering the sidewalk (m) — must stay under WORLD.tileSize/2.
  streetlightEdgeOffsetM: 4,
  // Fraction of true 4-way intersections (road tile with a road neighbour on both axes)
  // that actually get a traffic light — keeps them sparse, not on every corner.
  trafficLightProbability: 0.35,
  // How far a traffic light sits from its intersection tile's center, toward one of its
  // 4 diagonal corners (m).
  trafficLightCornerOffsetM: 3.5,
  // Trees per park tile, inclusive range.
  parkTreesRange: [2, 4] as readonly [number, number],
  // Chance a park tile also gets one bench.
  parkBenchProbability: 0.5,
  // Keep jittered park props at least this far from the tile's own edges (m).
  parkEdgeMarginM: 1.5,
  // Hydrants/mailboxes: sparse on road-adjacent building tiles — one placement roughly
  // every [min,max] eligible tiles walked in row-major order (re-rolled per placement).
  edgePropSampleEvery: [6, 10] as readonly [number, number],
  // How far a hydrant/mailbox sits from its tile's center, toward the road-adjacent edge (m).
  edgePropOffsetM: 3.5,
  // Fence-ring segments hug a transformer lot's tile boundary; nudged this far INSIDE the
  // tile so a segment's position always resolves back to the lot's own tileIndex (a point
  // exactly on a shared edge belongs to only one of the two tiles by convention).
  fenceEdgeInsetM: 0.1,
  // Chain-link fence ring around a transformer lot: exactly 3 of the tile's 4 sides get a
  // row of fenceSegment instances (the 4th — the road-facing side, if detectable — stays
  // open); WORLD.tileSize / PROP_DIMS.fenceSegment.lengthM segments per side (4 at the
  // current numbers).
  // Parked cars (Phase 6 Task 4): 1-3 per parkingLot tile, grid-ish — a single row of
  // slots spread along the axis perpendicular to the cars' shared facing (i.e. their width
  // axis), small per-slot position jitter on both axes, small rotation jitter off one of
  // the 4 cardinal yaws.
  parkingLotEdgeMarginM: 1.5,
  parkingLotCarsRange: [1, 3] as readonly [number, number],
  parkingLotJitterM: 0.4,
  parkingLotRotationJitterRad: 0.15,
} as const;

// Civilian traffic tunables (Phase 7, ai/traffic.ts). TDD §5.4 traffic network + §7
// civilian cars: kinematic followers on the lane graph, converted to dynamic on a hard
// player hit. All feel/density knobs — leva-live.
export const TRAFFIC_CIV = {
  // Active-car target on the default (high) quality tier; Phase 18's tiers scale it.
  activeTarget: 24,
  // Spawn ring around the player (m): outside the gameplay camera's view, inside the
  // despawn radius, mirroring the pursuit SPAWN ring shape (TDD §5.6).
  spawnRingMinM: 60,
  spawnRingMaxM: 90,
  despawnDistM: 140,
  // Per-car cruise speed range (m/s) — staggered speeds double as the anti-convoy rule.
  speedMinMps: 6,
  speedMaxMps: 11,
  // Stop-if-blocked forward ray (m) + the anti-deadlock cap: after holdCapSec blocked,
  // creep at creepSpeedMps regardless (part-file rule: jam believably, never forever).
  blockRayLengthM: 7,
  holdCapSec: 4,
  creepSpeedMps: 1.5,
  // Kinematic→dynamic conversion threshold (N) — same contact-force units as
  // PROPS.forceThresholds; a real ram, not a nudge.
  convertForceThreshold: 900,
  hp: 30,
  // Wreck detection: up-vector dot below this, sustained flipSustainSec ⇒ civWrecked.
  wreckUpDot: 0.3,
  wreckFlipSustainSec: 1.5,
  // Wrecks linger visibly (trophies) before sleep+despawn back to the pool. A converted
  // car that never actually flips (lands upright, hp still > 0) is recycled on this same
  // window measured from its conversion, so hit-but-not-wrecked debris can never starve the
  // pool of driving-car slots over a long soak (Phase 7 decision — the TDD ties linger only
  // to the wreck, but the pool is finite so converted-forever bodies must be reclaimed too).
  wreckLingerSec: 12,
  // Physical mass of a civilian car (kg) — matches PROPS.masses.parkedCar.
  massKg: 1200,
  // Settling damping applied to a freshly-converted dynamic car so it tumbles then comes to
  // rest (and auto-sleeps) within a few seconds instead of skating forever — same intent as
  // PROPS.settleLinearDamping/settleAngularDamping, tuned a touch lower so wrecks keep
  // spinning long enough for the flip check (wreckFlipSustainSec) to read a sustained roll.
  dynamicLinDamping: 0.4,
  dynamicAngDamping: 0.5,
  // On conversion the new dynamic body inherits its waypoint velocity (travel dir × the speed
  // it was moving) PLUS this fraction of the PLAYER's velocity as the impact kick — the
  // part-file gotcha: without an explicit shove the hit feels like the car was bolted down.
  convertKickScale: 0.6,
  // Kinematic yaw slews toward the travel-direction heading at most this fast (rad/s) so cars
  // arc through turns instead of snapping — a ~90° corner takes roughly 90°/(this) seconds.
  turnRateRadPerSec: 3.5,
  // Warm-up throttle: at most this many cars spawn per physics step, so filling an empty ring
  // to activeTarget costs a handful of quiet steps rather than one body-creation spike.
  maxSpawnPerStep: 4,
  // Per-spawn body tint palette (hex). traffic.ts rolls a stable CivSlot.tintIndex into this
  // array; TrafficMesh (the sibling visuals mesh) reads these colours to recolor instances.
  // Muted low-poly sedan colours — a red, a blue, silver, charcoal, taxi-yellow, and a green.
  tints: ['#c0392b', '#2c6fbb', '#dfe3e6', '#4a4f57', '#e2b23a', '#3c8d5a'],
} as const;
