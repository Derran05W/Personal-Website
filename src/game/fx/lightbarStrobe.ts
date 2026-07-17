// Lightbar strobe pattern (Phase 16 Task 3 polish; TDD §5.6). Pure math only — no three/R3F
// imports — consumed by ai/units/PoliceMesh.tsx and ai/units/ArmoredMesh.tsx, the only two
// live lightbar-bearing units (SWAT/gun-truck/tank/heli are deliberately unmarked, see each
// of those files' own header comment). Replaces the original Phase 9/10 ad-hoc inline
// `phase = (t*3 + i*0.13) % 1; phase < 0.5 ? 1 : 0` — a single-colour on/off gate — with a
// named, config-driven (config/fx.ts's LIGHTBAR block) pattern that ALTERNATES two colours:
// within one full cycle, red gets the first `splitFrac` share and blue the rest, and each
// colour is only actually LIT for the first `duty` fraction of its own share (a snappier
// double-flash beacon read instead of a slow 50/50 fade).

import { LIGHTBAR } from '../config/fx';

export interface LightbarConfig {
  readonly hz: number;
  readonly splitFrac: number;
  readonly duty: number;
  readonly phaseStaggerPerInstance: number;
}

/** One instance's current strobe state: 1 = lit, 0 = dark, for each colour. Never both 1 at
 * once (red and blue own disjoint slices of the cycle) — a caller wanting a physically
 * distinct blue accent (a second baked geometry/InstancedMesh) reads `.blue`, an "off" read
 * on both is a normal dark gap within either colour's own duty window. */
export interface LightbarPhase {
  readonly red: 0 | 1;
  readonly blue: 0 | 1;
}

const DARK: LightbarPhase = { red: 0, blue: 0 };

/**
 * Pure strobe evaluator. `tSec` is any monotonic clock (the live callers pass
 * `performance.now() / 1000`, matching the code this replaces); `instanceIndex` staggers a
 * fleet so units don't blink in lockstep (mirrors the old `i * 0.13`).
 */
export function lightbarPhase(
  tSec: number,
  instanceIndex: number,
  cfg: LightbarConfig = LIGHTBAR,
): LightbarPhase {
  const hz = cfg.hz > 0 ? cfg.hz : 1;
  const split = cfg.splitFrac < 0 ? 0 : cfg.splitFrac > 1 ? 1 : cfg.splitFrac;
  const duty = cfg.duty < 0 ? 0 : cfg.duty > 1 ? 1 : cfg.duty;

  // Wrap into [0, 1): JS `%` can return a negative result for negative `tSec` (dev clock
  // resets, fake-clock tests), so a second `+1 % 1` normalizes rather than letting a
  // negative cycle position silently fall through both branches below as "dark".
  const raw = tSec * hz + instanceIndex * cfg.phaseStaggerPerInstance;
  const cycle = ((raw % 1) + 1) % 1;

  if (cycle < split) {
    if (split <= 0) return DARK;
    const within = cycle / split;
    return within < duty ? { red: 1, blue: 0 } : DARK;
  }
  if (split >= 1) return DARK;
  const within = (cycle - split) / (1 - split);
  return within < duty ? { red: 0, blue: 1 } : DARK;
}
