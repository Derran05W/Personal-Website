// Toronto map v2 — deterministic traffic-light lamp-phase clock (Phase 25.6 D17). Pure
// sim-time-in / phase-out function: no react/three, no internal mutable state, no per-call
// allocation (every value returned is a primitive). Cosmetic only — no traffic AI reads this
// this phase (documented in D17); it exists purely so the lamp-quad overlay
// (world/toronto/cityPack, a mounting task) can write `instanceColor` on phase change without
// tracking timing logic itself.
//
// D17's closed question: palette-texture UV cycling on the shared city-pack atlas is NOT
// feasible without shader surgery (per-instance UV offsets don't exist on InstancedMesh/
// BatchedMesh without material patching). What ships instead is documented at the mounting call
// site (a separate task) — this module only owns "what phase is intersection X's mast in at
// sim-time T", not how that gets drawn.

import { LAMP_CLOCK, LAMP_COLORS } from '../../config/torontoDress';

export type LampAxis = 'ns' | 'ew';
export type LampPhase = 'green' | 'amber' | 'red';

/** One full NS-then-EW cycle: NS gets (green + amber), then EW gets (green + amber), then
 * repeats. At any sim-time exactly one axis is non-red. */
const HALF_CYCLE_MS = LAMP_CLOCK.greenMs + LAMP_CLOCK.amberMs;
const CYCLE_MS = 2 * HALF_CYCLE_MS;

/** Positive modulo (JS `%` can return negative for negative `t` — sim time is expected to be
 * non-negative, but this stays correct even if a caller feeds a small negative jitter). */
function mod(t: number, m: number): number {
  return ((t % m) + m) % m;
}

/**
 * The phase (`green`/`amber`/`red`) a mast controlling `axis` is showing at `simTimeMs`, with an
 * optional per-intersection `parityOffsetMs` (D16: alternate intersections offset by half a
 * cycle for visual variety — furniture.ts assigns this deterministically per intersection, not
 * per mast). Pure: same inputs -> same output, every call.
 */
export function lampPhase(simTimeMs: number, axis: LampAxis, parityOffsetMs = 0): LampPhase {
  const t = mod(simTimeMs + parityOffsetMs, CYCLE_MS);
  const activeAxis: LampAxis = t < HALF_CYCLE_MS ? 'ns' : 'ew';
  if (axis !== activeAxis) return 'red';
  const tInHalf = t < HALF_CYCLE_MS ? t : t - HALF_CYCLE_MS;
  return tInHalf < LAMP_CLOCK.greenMs ? 'green' : 'amber';
}

/** Emissive hex colour for a phase (config/torontoDress.ts LAMP_COLORS — single source, no
 * hand-repeated hexes at the mounting call site). */
export function lampColor(phase: LampPhase): string {
  return LAMP_COLORS[phase];
}

/** Deterministic per-intersection phase offset (D16 "axis parity per intersection" — alternate
 * intersections desync by half a cycle so the whole map doesn't blink in lockstep). `index` is
 * any stable per-intersection integer (e.g. its position in listIntersections' sorted output). */
export function parityOffsetForIntersection(index: number): number {
  return index % 2 === 0 ? 0 : HALF_CYCLE_MS;
}
