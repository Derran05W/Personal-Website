// Phase 25.6 (D17) — lampClock.ts tests: pure sim-time-in/phase-out, NS/EW mutual exclusion,
// green->amber->red ordering, determinism, parity offset.
import { describe, expect, it } from 'vitest';
import { LAMP_CLOCK, LAMP_COLORS } from '../../config/torontoDress';
import { lampColor, lampPhase, parityOffsetForIntersection } from './lampClock';

const HALF = LAMP_CLOCK.greenMs + LAMP_CLOCK.amberMs;
const CYCLE = 2 * HALF;

describe('lampPhase — NS/EW mutual exclusion', () => {
  it('exactly one axis is non-red at any sampled sim-time', () => {
    for (let t = 0; t < CYCLE * 2; t += 137) {
      // odd step so we hit interior points, not just boundaries
      const ns = lampPhase(t, 'ns');
      const ew = lampPhase(t, 'ew');
      const nonRed = [ns, ew].filter((p) => p !== 'red');
      expect(nonRed.length, `t=${t} ns=${ns} ew=${ew}`).toBeLessThanOrEqual(1);
    }
  });

  it('NS is green for the first greenMs of the cycle, EW is red throughout', () => {
    expect(lampPhase(0, 'ns')).toBe('green');
    expect(lampPhase(LAMP_CLOCK.greenMs - 1, 'ns')).toBe('green');
    expect(lampPhase(0, 'ew')).toBe('red');
    expect(lampPhase(LAMP_CLOCK.greenMs - 1, 'ew')).toBe('red');
  });

  it('NS goes amber for the next amberMs, then EW takes over green at the half-cycle mark', () => {
    expect(lampPhase(LAMP_CLOCK.greenMs, 'ns')).toBe('amber');
    expect(lampPhase(HALF - 1, 'ns')).toBe('amber');
    expect(lampPhase(HALF, 'ew')).toBe('green');
    expect(lampPhase(HALF, 'ns')).toBe('red');
  });

  it('EW mirrors the NS half exactly one half-cycle later', () => {
    expect(lampPhase(HALF, 'ew')).toBe('green');
    expect(lampPhase(HALF + LAMP_CLOCK.greenMs - 1, 'ew')).toBe('green');
    expect(lampPhase(HALF + LAMP_CLOCK.greenMs, 'ew')).toBe('amber');
    expect(lampPhase(CYCLE - 1, 'ew')).toBe('amber');
  });

  it('wraps cleanly: phase at t and t + N*CYCLE are identical', () => {
    for (const t of [0, 500, HALF, HALF + 200, CYCLE - 1]) {
      expect(lampPhase(t + CYCLE, 'ns')).toBe(lampPhase(t, 'ns'));
      expect(lampPhase(t + 3 * CYCLE, 'ew')).toBe(lampPhase(t, 'ew'));
    }
  });
});

describe('lampPhase — purity / determinism', () => {
  it('same inputs always produce the same output', () => {
    expect(lampPhase(1234, 'ns', 500)).toBe(lampPhase(1234, 'ns', 500));
  });

  it('never returns anything outside the three phases', () => {
    for (let t = 0; t < CYCLE; t += 251) {
      expect(['green', 'amber', 'red']).toContain(lampPhase(t, 'ns'));
      expect(['green', 'amber', 'red']).toContain(lampPhase(t, 'ew'));
    }
  });
});

describe('parityOffsetForIntersection — deterministic half-cycle desync', () => {
  it('even indices offset 0, odd indices offset by exactly one half-cycle', () => {
    expect(parityOffsetForIntersection(0)).toBe(0);
    expect(parityOffsetForIntersection(2)).toBe(0);
    expect(parityOffsetForIntersection(1)).toBe(HALF);
    expect(parityOffsetForIntersection(3)).toBe(HALF);
  });

  it('an odd-indexed intersection is exactly out of phase with an even one at the same sim-time', () => {
    const t = 1000;
    const evenOffset = parityOffsetForIntersection(0);
    const oddOffset = parityOffsetForIntersection(1);
    const evenPhase = lampPhase(t, 'ns', evenOffset);
    const oddPhase = lampPhase(t, 'ns', oddOffset);
    // one is showing NS-active (green/amber), the other NS-red, or vice versa — never both
    // green/amber at once for the SAME axis under opposite parity.
    const evenActive = evenPhase !== 'red';
    const oddActive = oddPhase !== 'red';
    expect(evenActive).not.toBe(oddActive);
  });
});

describe('lampColor — resolves to config/torontoDress.ts LAMP_COLORS, no hand-repeated hexes', () => {
  it('every phase maps to its configured hex', () => {
    expect(lampColor('green')).toBe(LAMP_COLORS.green);
    expect(lampColor('amber')).toBe(LAMP_COLORS.amber);
    expect(lampColor('red')).toBe(LAMP_COLORS.red);
  });
});
