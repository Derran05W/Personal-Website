// Spawn director + helicopter tunables. TDD §5.6 (spawn director, enemy caps),
// §5.7 (helicopters).
export const SPAWN = {
  // Max concurrent pursuit units per tier ★0..★5. TDD §5.5 table "Max concurrent (total)".
  caps: [0, 4, 6, 8, 9, 10],
  // TDD §5.5: ★5 caps tanks at 2 even though the total cap is 10.
  maxTanks: 2,
  // Spawn ring around the player, off-screen. TDD §5.6.
  ringMin: 60,
  ringMax: 90,
  // Despawn distance for pursuit units. TDD §5.6.
  despawnAt: 140,
  // AI decision tick rate; forces still apply every physics step. TDD §5.6.
  aiTickHz: 10,
} as const;

export const HELI = {
  // Orbit radius/altitude around the player. TDD §5.7.
  orbitRadius: 40,
  altitude: 35,
  // Helicopters per tier ★0..★5. TDD §5.7: one heli per tier >= ★2 (police/SWAT/
  // military livery by tier), ★5 adds a second military heli. Ambient only, no
  // gameplay effect in v1.
  perTier: [0, 0, 1, 1, 1, 2],
} as const;
