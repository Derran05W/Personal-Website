// Phase 44 — the CN Tower night program's BRAIN. Everything the light show decides over time, as
// pure functions of (config, seed, tMs). No three, no React, no canvas, no clock reads — and, by
// law, nothing from `powergrid/`.
//
// WHY IT'S A SEPARATE, PURE MODULE:
//   1. FREEZE-AWARENESS BY CONSTRUCTION. Every function takes `tMs` explicitly. The one caller
//      (TorontoScene's HeroesLayer) passes `core/simClock.ts`'s `simNowMs()`, so when the Phase 42
//      flicker harness freezes the world the program freezes with it — a frozen world really is
//      two byte-identical frames, and the sweep's totality gate stays meaningful. A module that
//      read `performance.now()` itself would be invisible to that seam and would (correctly) light
//      up the detector.
//   2. ONE HOME FOR THE TIMING. The GLSL patch does ONLY spatial mapping (which LED cell is this
//      fragment, how high up the fin is it). Every envelope, phase and intensity is computed here,
//      once per frame, on the CPU — so there is no CPU/GPU logic to keep in sync and the whole
//      show is unit-testable at 60 Hz in vitest without a canvas.
//   3. BLACKOUT LAW. The CN Tower stays lit through a district blackout and through DARK CITY —
//      that is the point of the money shot. Making it structurally impossible for this module to
//      learn about the grid (no import, policed by a source-scan test) means "CN stays lit" can't
//      be regressed by someone helpfully wiring it up later.

import { createRng } from '../rng';
import { CN_TOWER, type CnPalette } from '../../config/cnTower';

export type CnProgramMode = 'solid' | 'pulse' | 'chase';

/** The mode + palette a run's tower is showing tonight. */
export interface CnProgramSelection {
  readonly mode: CnProgramMode;
  readonly paletteIndex: number;
  readonly paletteName: string;
}

const MODES: readonly CnProgramMode[] = ['solid', 'pulse', 'chase'];

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
 * Tonight's program for `seed` — the run seed, so the tower's scheme is part of the run's identity
 * exactly like its city layout is (and, like every other seeded roll in this project, it comes off
 * a NAMED fork so adding a future roll can never shift an existing seed's city).
 */
export function resolveNightProgram(seed: number): CnProgramSelection {
  const rng = createRng(seed).fork('cn-night-program');
  const modeWeights = [CN_TOWER.modeWeights.solid, CN_TOWER.modeWeights.pulse, CN_TOWER.modeWeights.chase];
  const mode = MODES[weightedIndex(modeWeights, rng.next())]!;
  const paletteIndex = Math.min(
    CN_TOWER.palettes.length - 1,
    weightedIndex(CN_TOWER.paletteWeights, rng.next()),
  );
  return { mode, paletteIndex, paletteName: CN_TOWER.palettes[paletteIndex]!.name };
}

/** Clamp an index into the palette list (defensive: dev overrides come off `window`). */
export function paletteAt(index: number): CnPalette {
  const i = Number.isFinite(index) ? Math.floor(index) : 0;
  const clamped = Math.max(0, Math.min(CN_TOWER.palettes.length - 1, i));
  return CN_TOWER.palettes[clamped]!;
}

/** Positive modulo — `tMs` is monotonic here, but the guard keeps the fns total. */
function wrap(value: number, period: number): number {
  if (!(period > 0)) return 0;
  return ((value % period) + period) % period;
}

/**
 * The ring's per-frame state.
 *  • `solid` — constant brightness, both cell colours on.
 *  • `pulse` — the whole ring breathes on a sinusoid between the configured min/max.
 *  • `chase` — brightness is constant, but a window of cells centred on `chasePhase` (0..1 around
 *    the ring) is lit and the rest idle down; the shader does the per-cell window test off the
 *    phase, which is why this returns a phase rather than a per-cell array.
 */
export function ringPhaseAt(
  tMs: number,
  mode: CnProgramMode,
  cfg: typeof CN_TOWER.ring = CN_TOWER.ring,
): { chasePhase: number; intensity: number } {
  if (mode === 'pulse') {
    // cos-based so t=0 sits at the MAX — a screenshot at sim-time 0 shows the ring at full, which
    // is the frame anyone reaching for evidence wants.
    const u = (Math.cos((wrap(tMs, cfg.pulsePeriodMs) / cfg.pulsePeriodMs) * Math.PI * 2) + 1) / 2;
    return { chasePhase: 0, intensity: cfg.pulseMinIntensity + (cfg.pulseMaxIntensity - cfg.pulseMinIntensity) * u };
  }
  if (mode === 'chase') {
    return { chasePhase: wrap(tMs, cfg.chasePeriodMs) / cfg.chasePeriodMs, intensity: cfg.chaseIntensity };
  }
  return { chasePhase: 0, intensity: cfg.solidIntensity };
}

/**
 * The aircraft beacon's DOUBLE-FLASH envelope ∈ [0,1]: flash, gap, flash, then dark until the
 * period repeats. Sharp attack (a strobe fires instantly), short linear tail (a real lamp's
 * filament/afterglow), which is what stops it reading as a square wave in a 60 fps frame.
 */
export function beaconEnvelopeAt(tMs: number, cfg: typeof CN_TOWER.beacon = CN_TOWER.beacon): number {
  const t = wrap(tMs, cfg.periodMs);
  const flash = (start: number): number => {
    const dt = t - start;
    if (dt < 0) return 0;
    if (dt < cfg.flashMs) return 1;
    if (dt < cfg.flashMs + cfg.decayMs) return 1 - (dt - cfg.flashMs) / cfg.decayMs;
    return 0;
  };
  return Math.max(flash(0), flash(cfg.gapMs));
}

/** The crest wash's upward sweep phase ∈ [0,1) — 0 at the ground, 1 at the fin top. */
export function crestPhaseAt(tMs: number, cfg: typeof CN_TOWER.crest = CN_TOWER.crest): number {
  return wrap(tMs, cfg.sweepPeriodMs) / cfg.sweepPeriodMs;
}

// --- dev override ------------------------------------------------------------------------------
// A single mutable holder (the fx/decalPolygonOffsetRef.ts idiom) so the debug bridge and the leva
// panel can force a mode/palette for evidence shots without touching the run seed. Deliberately
// NOT part of the pure API above: `resolveNightProgram` and the phase functions stay pure, and the
// override is applied by the consumer (cnNightMaterial.ts's per-frame write). Defaults are null,
// so a production build is inert.

export interface CnProgramOverride {
  mode: CnProgramMode | null;
  paletteIndex: number | null;
}

export const cnProgramOverride: CnProgramOverride = { mode: null, paletteIndex: null };

/** Set (or clear, with `null`) the dev override. Partial updates keep the other field. */
export function setCnProgramOverride(next: { mode?: CnProgramMode; paletteIndex?: number } | null): void {
  if (next === null) {
    cnProgramOverride.mode = null;
    cnProgramOverride.paletteIndex = null;
    return;
  }
  if (next.mode !== undefined) cnProgramOverride.mode = next.mode;
  if (next.paletteIndex !== undefined) cnProgramOverride.paletteIndex = next.paletteIndex;
}

/**
 * The selection actually on screen for `seed` — the seeded pick with any dev override applied.
 * Allocates, so it is the READ path (debug bridge / dev panel); the per-frame uniform write
 * composes the same two inputs without allocating.
 */
export function effectiveNightProgram(seed: number): CnProgramSelection {
  const base = resolveNightProgram(seed);
  const mode = cnProgramOverride.mode ?? base.mode;
  const paletteIndex =
    cnProgramOverride.paletteIndex === null ? base.paletteIndex : cnProgramOverride.paletteIndex;
  return { mode, paletteIndex, paletteName: paletteAt(paletteIndex).name };
}
