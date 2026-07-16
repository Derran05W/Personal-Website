// Damage, busted, and game-over tunables. TDD §5.10.
export const DAMAGE = {
  // PLACEHOLDER — TDD §5.10 gives the formula `k x relative_speed x other_mass_factor`
  // but no concrete k; tune in Phase 8 against real vehicle masses/speeds.
  collisionK: 1,
  // PLACEHOLDER — TDD §5.10: "thresholded so love-taps are free"; no number given.
  // Below this relative speed (m/s), collisions deal zero damage. Tune in Phase 8.
  minImpactSpeed: 4,
  // Hitscan bullet damage (gun truck bursts). TDD §5.10 / §5.6.
  bulletDamage: 3,
  // Visual HP thresholds: smoke below 50% HP, fire below 25% HP. TDD §5.10.
  smokeBelowHpFrac: 0.5,
  fireBelowHpFrac: 0.25,
  // Water = instant wreck (TDD §5.10) — no magnitude needed, handled as a special case
  // by the damage resolver, not a numeric tunable.
} as const;

export const BUSTED = {
  // Player speed must stay below this (m/s) ...
  maxSpeed: 1,
  // ...for this many seconds ...
  holdSec: 3,
  // ...while at least this many pursuit units ...
  minPursuers: 3,
  // ...are within this radius (m) of the player. TDD §5.10.
  pursuerRadius: 8,
} as const;
