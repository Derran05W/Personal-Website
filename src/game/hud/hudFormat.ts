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

/** `playerHp` as a 0-100 fill percent of `maxHp` for the HP silhouette's vertical gauge.
 * Phase 17: cars have different max HP (racer 60 … streetcar 260), so the percent is
 * hp/maxHp — a full-health racer shows a FULL bar, not a 60% one. `maxHp` defaults to the
 * pre-Phase-17 reference 100 (also keeps every existing test's expectations intact).
 * Defensive about non-finite/nonpositive inputs, same reasoning as formatScore. */
export function hpFillPercent(hp: number, maxHp = 100): number {
  if (!Number.isFinite(hp) || !Number.isFinite(maxHp) || maxHp <= 0) return 0;
  return Math.min(100, Math.max(0, (hp / maxHp) * 100));
}

/** TDD §9: HP silhouette "fill color shifting green→amber→red under 30%" — red below 30%,
 * amber in the mid band, green otherwise (thresholds are PERCENT of the car's max, so a
 * streetcar at 70/260 reads red exactly like a sedan at 27/100). Presentation-only
 * thresholds (not a gameplay tunable), so they're literals here rather than game/config —
 * same call as minimapMath.ts's TILE_COLORS for the same reason, one level more
 * player-facing. */
export function hpColor(hp: number, maxHp = 100): string {
  const pct = hpFillPercent(hp, maxHp);
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
