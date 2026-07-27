// Phase 45 — the Rogers Centre night program's BRAIN. Everything the stadium's lights decide over
// time, as pure functions of (config, seed, tMs). No three, no React, no canvas, no clock reads,
// and no powergrid: the DIMMING decision is made by the caller and arrives here as a boolean, so
// this module stays a pure function of its arguments (the blackout WIRING lives one layer out, in
// rogersNightMaterial.ts, which is allowed to read the grid).
//
// This is cnNightProgram.ts's sibling and follows the same three laws:
//   1. FREEZE-AWARENESS BY CONSTRUCTION. Every function takes `tMs` explicitly; the one caller
//      (TorontoScene's HeroesLayer) passes `core/simClock.ts`'s `simNowMs()`. When the Phase 42
//      flicker harness freezes the world the board freezes with it, so a frozen world really is two
//      byte-identical frames. A module that read `performance.now()` itself would be invisible to
//      that seam and would (correctly) light up the detector. The dark FADE is stepped by the
//      caller's own dt (see `stepDarkLevel`) for the same reason: a frozen clock ⇒ dt 0 ⇒ no motion.
//   2. ONE HOME FOR THE TIMING. The GLSL patch does ONLY spatial mapping (which column is this
//      fragment, which emissive selector is this vertex). Every phase and intensity is computed
//      here, once per frame, on the CPU — unit-testable at 60 Hz in vitest without a canvas.
//   3. RUN IDENTITY. Tonight's scheme comes off the RUN SEED through a NAMED fork, exactly like the
//      tower's palette, so the same seed replays the same board (retry included) and adding a
//      future roll can never shift an existing seed's city.

import { createRng } from '../rng';
import { ROGERS_CENTRE, type RogersJumboScheme } from '../../config/rogersCentre';

/** The colour-block scheme a run's board is showing tonight. */
export interface RogersProgramSelection {
  readonly schemeIndex: number;
  readonly schemeName: string;
}

/** Pick an index from `weights` using one roll in [0,1). Weights need not be normalized. */
function weightedIndex(weights: readonly number[], roll: number): number {
  let total = 0;
  for (const w of weights) total += Math.max(0, w);
  if (total <= 0) return 0;
  let acc = 0;
  const target = roll * total;
  for (let i = 0; i < weights.length; i++) {
    acc += Math.max(0, weights[i]!);
    if (target < acc) return i;
  }
  return weights.length - 1;
}

/**
 * Tonight's board for `seed`. NAMED fork ('rogers-jumbotron') — never an unforked roll off the
 * world stream, which would make the city itself depend on how many times this file rolls.
 */
export function resolveRogersProgram(seed: number): RogersProgramSelection {
  const rng = createRng(seed).fork('rogers-jumbotron');
  const schemeIndex = Math.min(
    ROGERS_CENTRE.jumbotron.schemes.length - 1,
    weightedIndex(ROGERS_CENTRE.jumbotron.schemeWeights, rng.next()),
  );
  return { schemeIndex, schemeName: ROGERS_CENTRE.jumbotron.schemes[schemeIndex]!.name };
}

/** Clamp an index into the scheme list (defensive: the index can come off a dev override). */
export function schemeAt(index: number): RogersJumboScheme {
  const i = Number.isFinite(index) ? Math.floor(index) : 0;
  const clamped = Math.max(0, Math.min(ROGERS_CENTRE.jumbotron.schemes.length - 1, i));
  return ROGERS_CENTRE.jumbotron.schemes[clamped]!;
}

/** Positive modulo — `tMs` is monotonic here, but the guard keeps the fns total. */
function wrap(value: number, period: number): number {
  if (!(period > 0)) return 0;
  return ((value % period) + period) % period;
}

/**
 * The board's per-frame state.
 *  • `scroll` ∈ [0,1) — how far the colour blocks have travelled across the board. The shader
 *    floors it into a whole-column shift, so the blocks step one column at a time the way a real
 *    LED board does, rather than sliding sub-pixel (which is exactly the shimmer the Phase 41
 *    surface law forbids on thin features).
 *  • `bandPhase` ∈ [0,1) — the centre of the brighter band sweeping across the columns.
 */
export function jumboPhaseAt(
  tMs: number,
  cfg: typeof ROGERS_CENTRE.jumbotron = ROGERS_CENTRE.jumbotron,
): { scroll: number; bandPhase: number } {
  return {
    scroll: wrap(tMs, cfg.scrollPeriodMs) / cfg.scrollPeriodMs,
    bandPhase: wrap(tMs, cfg.bandPeriodMs) / cfg.bandPeriodMs,
  };
}

/**
 * One step of the blackout fade: move `current` (0 = lit, 1 = blacked out) toward `dark`'s target
 * by `dtMs` worth of the configured fade. Pure and total — a negative or absurd dt (a sim-clock
 * reset on retry, a tab that was hidden for a minute) clamps instead of overshooting, and dt 0 (a
 * FROZEN world) returns `current` unchanged, which is what keeps the flicker detector honest.
 *
 * LINEAR, not an exponential lerp: `fadeMs` then means what its name says (the lights are all the
 * way out that many milliseconds after the power fails), instead of a time constant that only ever
 * gets 63 % of the way there. It also makes the fade's duration something a screenshot script can
 * wait out exactly.
 */
export function stepDarkLevel(
  current: number,
  dark: boolean,
  dtMs: number,
  cfg: typeof ROGERS_CENTRE.blackout = ROGERS_CENTRE.blackout,
): number {
  const from = Number.isFinite(current) ? Math.max(0, Math.min(1, current)) : 0;
  const target = dark ? 1 : 0;
  if (!(dtMs > 0) || !(cfg.fadeMs > 0)) return from;
  const stepAmount = dtMs / cfg.fadeMs;
  return target > from ? Math.min(target, from + stepAmount) : Math.max(target, from - stepAmount);
}

/**
 * The multiplier every program emissive is scaled by at dark level `level` — 1 when lit, the
 * configured floor (emergency lighting) when fully dark. Exported because the shader takes `uDark`
 * and `uDarkFloor` separately: this is the same formula, available to tests and to any CPU-side
 * consumer that needs to reason about the on-screen brightness.
 */
export function darkGainFor(level: number, cfg: typeof ROGERS_CENTRE.blackout = ROGERS_CENTRE.blackout): number {
  const clamped = Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0;
  return 1 - clamped * (1 - cfg.floor);
}
