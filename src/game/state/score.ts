// Score wiring (Phase 8 Task 1; TDD §5.10: "Score = Σ heat events + risk bonus of
// 5 × current_tier per second while ≥ ★1"). Two independent contributors, matching the
// TDD formula's two terms:
//
//   1. The "Σ heat events" term: mirrored 1:1 from `heatChanged` (see initScoreSystem
//      below) rather than re-subscribing to every original heat-causing event and
//      re-deriving its point value a second time — heatChanged already carries the
//      definitive, post-clamp delta store.addHeat applied, so this is both the simplest
//      implementation and the only one that can't drift out of sync with state/heat.ts's
//      event→delta mapping. Read literally, "Σ heat events" sums whatever raised heat —
//      that includes passive accrual's +1/sec ticks (heat.ts's accruePassive), not only
//      discrete destruction events. This is a deliberate, documented interpretation (see
//      phase-08-plan.md Task 1): passive heat gain scores the same way any other heat gain
//      does, on top of (not instead of) the risk bonus term below, which independently
//      rewards simply *staying* at a high tier.
//   2. The risk-bonus term: `accrueRisk`, driven from the same fixed-step system as
//      heat.ts's `accruePassive` (see `<HeatScoreSystem />`).
//
// config note: the plan called for adding a `config/score.ts` block if no risk-bonus
// tunable existed yet — it already does: `HEAT.riskBonusPerTierPerSec` (config/heat.ts),
// registered in the CONFIG registry (config/index.ts) as part of HEAT. No new config file
// needed; reused as-is.
import { gameEvents } from './events';
import { getGameState } from './store';
import { HEAT } from '../config/heat';

/**
 * Subscribes `heatChanged` and mirrors its (post-clamp, already-integer) delta straight
 * into score — the "Σ heat events" term. Returns a teardown; call once at mount (e.g. from
 * `<HeatScoreSystem />`'s mount effect) and call the returned function on unmount.
 */
export function initScoreSystem(): () => void {
  return gameEvents.on('heatChanged', ({ delta }) => {
    if (delta > 0) getGameState().addScore(delta);
  });
}

// --- risk bonus (TDD §5.10: "5 × current_tier per second while ≥ ★1") -----------------------
//
// Same float-accumulator shape as heat.ts's accruePassive, for the same reason: at 60 Hz,
// `riskBonusPerTierPerSec × tier × dt` is sub-1 for tier 1 (5 × 1 × 1/60 ≈ 0.083), so
// flooring every step's raw contribution before accumulating would silently discard almost
// all of it. This accumulator carries the exact fractional remainder between calls and only
// ever flushes whole points into `addScore`, so score stays an integer (matches the store's
// `score: number` field being treated as a whole-number HUD readout) while accrual is exact
// over time.
let riskAccumulator = 0;

// Same IEEE-754 boundary guard as heat.ts's FLUSH_EPSILON (see that file's comment for the
// worked example — this term's own default, 5/60 x 60 = 4.999999999999999, is exactly the
// case that motivated it). Duplicated rather than imported: it's a generic float-accumulator
// constant, not a shared heat/score concern.
const FLUSH_EPSILON = 1e-9;

/**
 * Advances the risk-bonus accumulator by `dtSec` simulated seconds, at the CURRENT tier
 * (read fresh each call, so a mid-accrual tier-up is reflected on the very next call — no
 * stale-tier lag). No-op while tier is 0; the accumulator is reset in that case too, for the
 * same "don't bank a stale fractional remainder across a heat reset" reason as
 * heat.ts's accruePassive.
 */
export function accrueRisk(dtSec: number): void {
  const { tier } = getGameState();
  if (tier < 1) {
    riskAccumulator = 0;
    return;
  }

  riskAccumulator += HEAT.riskBonusPerTierPerSec * tier * dtSec;
  const whole = Math.floor(riskAccumulator + FLUSH_EPSILON);
  if (whole > 0) {
    riskAccumulator -= whole;
    getGameState().addScore(whole);
  }
}

/** Test-only reset for the module-scope risk accumulator (mirrors combat/contacts.ts's
 * `__resetContactsForTest` pattern / heat.ts's `__resetPassiveAccumulatorForTest`). */
export function __resetRiskAccumulatorForTest(): void {
  riskAccumulator = 0;
}
