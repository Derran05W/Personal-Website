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
