// Pure formatting/derivation helpers for the gameplay HUD (hud/Hud.tsx). Split out of the
// component file so they stay unit-testable in plain vitest (no React, no DOM) and so
// Hud.tsx itself only exports components — react-refresh's `only-export-components` rule
// (eslint.config.js's `reactRefresh.configs.vite`) flags a file that mixes component and
// non-component exports; this mirrors hud/minimapMath.ts's split for the same reason.

/** Integer, thousands-separated score readout (e.g. `1234.7` -> `"1,235"`). Non-finite or
 * negative inputs clamp to 0 — score is monotonic in practice (TDD §5.10), but the HUD
 * must never render "-1"/"NaN" off a stray bad read. */
export function formatScore(score: number): string {
  const safe = Number.isFinite(score) ? score : 0;
  const rounded = Math.max(0, Math.round(safe));
  return rounded.toLocaleString('en-US');
}

/** Clamp `playerHp` to a 0-100 fill percent for the HP silhouette's vertical gauge. Not
 * contract-guaranteed to already be in range (defensive, same reasoning as formatScore). */
export function hpFillPercent(hp: number): number {
  if (!Number.isFinite(hp)) return 0;
  return Math.min(100, Math.max(0, hp));
}

/** TDD §9: HP silhouette "fill color shifting green→amber→red under 30%" — red below 30%,
 * amber in the mid band, green otherwise. Presentation-only thresholds (not a gameplay
 * tunable), so they're literals here rather than game/config — same call as
 * minimapMath.ts's TILE_COLORS for the same reason, one level more player-facing. */
export function hpColor(hp: number): string {
  const pct = hpFillPercent(hp);
  if (pct < 30) return '#ef4444'; // red-500
  if (pct < 60) return '#f59e0b'; // amber-500 (matches --color-accent)
  return '#4ade80'; // green-400
}

/** 0-5 filled wanted stars for a given tier (store.tier, tierForHeat's output). Clamped
 * defensively so the HUD can never try to light a 6th star even if a future config change
 * grows config/heat.ts's tierThresholds past 5 entries. */
export function filledStarCount(tier: number): number {
  if (!Number.isFinite(tier)) return 0;
  return Math.min(5, Math.max(0, Math.trunc(tier)));
}
