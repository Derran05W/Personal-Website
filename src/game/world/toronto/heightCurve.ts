// Height compression (TORONTO-MAP-SPEC-v2.md §3c). A LINEAR height map would make the CN
// Tower 46× a corner shop and it would wall off the chase camera. A power curve keeps the
// tower the tallest thing on the map "by a clear margin, never a wall": it collapses the
// CN:shop ratio from ~46× to ~10× while staying monotonic, so relative heights still read.

/** h_game = COEFFICIENT · h_real_m ^ EXPONENT. */
export const COEFFICIENT = 2.05 as const;
export const EXPONENT = 0.6 as const;
/** shadow_wu = SHADOW_FACTOR · h_game (an optional blob-shadow radius hint, §A.1). */
export const SHADOW_FACTOR = 0.35 as const;

/** Real building height in metres → game height in world-units (§3c power curve). */
export function hGame(realM: number): number {
  return COEFFICIENT * Math.pow(realM, EXPONENT);
}

/** Game height (wu) → blob-shadow radius hint (wu). */
export function shadowWu(h: number): number {
  return SHADOW_FACTOR * h;
}
