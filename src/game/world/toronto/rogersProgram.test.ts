// Phase 45 — pure tests for the Rogers Centre night program's brain (world/toronto/rogersProgram.ts).
// Mirrors cnNightProgram.test.ts: seeded run identity, phase functions that are pure functions of
// tMs (the freeze-awareness contract the Phase 42 flicker detector depends on), and a source scan
// proving the module really is pure — no clock, no three, no powergrid.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROGERS_CENTRE } from '../../config/rogersCentre';
import { createRng } from '../rng';
import { darkGainFor, jumboPhaseAt, resolveRogersProgram, schemeAt, stepDarkLevel } from './rogersProgram';

describe('resolveRogersProgram — the board is part of the run identity', () => {
  it('is a pure function of the seed (same seed → same scheme, retry included)', () => {
    for (const seed of [0, 1, 416, 99999, 2 ** 31]) {
      expect(resolveRogersProgram(seed)).toEqual(resolveRogersProgram(seed));
    }
  });

  it('names the scheme it picked, and the index is always in range', () => {
    for (let seed = 0; seed < 200; seed++) {
      const sel = resolveRogersProgram(seed);
      expect(sel.schemeIndex).toBeGreaterThanOrEqual(0);
      expect(sel.schemeIndex).toBeLessThan(ROGERS_CENTRE.jumbotron.schemes.length);
      expect(sel.schemeName).toBe(ROGERS_CENTRE.jumbotron.schemes[sel.schemeIndex]!.name);
    }
  });

  it('different seeds really do produce different boards (the roll is not stuck)', () => {
    const seen = new Set<number>();
    for (let seed = 0; seed < 400; seed++) seen.add(resolveRogersProgram(seed).schemeIndex);
    expect(seen.size).toBeGreaterThan(1);
  });

  it('rolls off the NAMED fork, never the bare seed stream', () => {
    // The law that keeps a future roll in this module from shifting an existing seed's CITY: the
    // pick must be reproducible from createRng(seed).fork('rogers-jumbotron') alone.
    const seed = 4242;
    const roll = createRng(seed).fork('rogers-jumbotron').next();
    const weights = ROGERS_CENTRE.jumbotron.schemeWeights;
    const total = weights.reduce((a, b) => a + b, 0);
    let acc = 0;
    let expected = weights.length - 1;
    for (let i = 0; i < weights.length; i++) {
      acc += weights[i]!;
      if (roll * total < acc) {
        expected = i;
        break;
      }
    }
    expect(resolveRogersProgram(seed).schemeIndex).toBe(expected);
    // …and it is NOT the unforked stream's first roll (that one belongs to the world).
    expect(createRng(seed).next()).not.toBe(roll);
  });
});

describe('schemeAt — total and clamped (dev overrides come off untyped inputs)', () => {
  it('clamps out-of-range and non-finite indices instead of throwing', () => {
    expect(schemeAt(-5)).toBe(ROGERS_CENTRE.jumbotron.schemes[0]);
    expect(schemeAt(999)).toBe(ROGERS_CENTRE.jumbotron.schemes[ROGERS_CENTRE.jumbotron.schemes.length - 1]);
    expect(schemeAt(Number.NaN)).toBe(ROGERS_CENTRE.jumbotron.schemes[0]);
    expect(schemeAt(1.7)).toBe(ROGERS_CENTRE.jumbotron.schemes[1]);
  });
});

describe('jumboPhaseAt — a pure function of tMs (freeze-awareness by construction)', () => {
  it('same tMs → identical output (a FROZEN world paints two identical frames)', () => {
    for (const t of [0, 137, 5_000, 1_234_567]) {
      expect(jumboPhaseAt(t)).toEqual(jumboPhaseAt(t));
    }
  });

  it('both phases stay in [0,1) and wrap at their own periods', () => {
    const cfg = ROGERS_CENTRE.jumbotron;
    for (let t = 0; t < 20_000; t += 97) {
      const p = jumboPhaseAt(t);
      expect(p.scroll).toBeGreaterThanOrEqual(0);
      expect(p.scroll).toBeLessThan(1);
      expect(p.bandPhase).toBeGreaterThanOrEqual(0);
      expect(p.bandPhase).toBeLessThan(1);
    }
    expect(jumboPhaseAt(cfg.scrollPeriodMs).scroll).toBeCloseTo(0, 9);
    expect(jumboPhaseAt(cfg.bandPeriodMs).bandPhase).toBeCloseTo(0, 9);
    expect(jumboPhaseAt(cfg.scrollPeriodMs / 2).scroll).toBeCloseTo(0.5, 9);
  });

  it('advances monotonically within a period (the blocks travel one way)', () => {
    const cfg = ROGERS_CENTRE.jumbotron;
    let last = -1;
    for (let t = 0; t < cfg.scrollPeriodMs; t += cfg.scrollPeriodMs / 50) {
      const s = jumboPhaseAt(t).scroll;
      expect(s).toBeGreaterThan(last);
      last = s;
    }
  });

  it('a negative or absurd tMs is still total (no NaN can reach a uniform)', () => {
    for (const t of [-1_000, -0.5, 1e12]) {
      const p = jumboPhaseAt(t);
      expect(Number.isFinite(p.scroll)).toBe(true);
      expect(Number.isFinite(p.bandPhase)).toBe(true);
      expect(p.scroll).toBeGreaterThanOrEqual(0);
      expect(p.scroll).toBeLessThan(1);
    }
  });
});

describe('stepDarkLevel — the blackout fade (stepped by SIM-time dt, so a freeze freezes it)', () => {
  it('dt 0 holds — a frozen world does not fade', () => {
    expect(stepDarkLevel(0.42, true, 0)).toBe(0.42);
    expect(stepDarkLevel(0.42, false, 0)).toBe(0.42);
  });

  it('a backwards clock (a retry resetting the sim clock) contributes nothing', () => {
    expect(stepDarkLevel(0.3, true, -500)).toBe(0.3);
  });

  it('converges to fully dark within the configured fade, and never overshoots', () => {
    const dt = 16.7;
    let level = 0;
    let elapsed = 0;
    while (elapsed < ROGERS_CENTRE.blackout.fadeMs * 3) {
      level = stepDarkLevel(level, true, dt);
      expect(level).toBeGreaterThanOrEqual(0);
      expect(level).toBeLessThanOrEqual(1);
      elapsed += dt;
    }
    expect(level).toBeGreaterThan(0.95);
  });

  it('relights the same way (the fade is symmetric — debug relight must not strand it dark)', () => {
    let level = 1;
    for (let t = 0; t < ROGERS_CENTRE.blackout.fadeMs * 3; t += 16.7) level = stepDarkLevel(level, false, 16.7);
    expect(level).toBeLessThan(0.05);
  });

  it('is LINEAR — fadeMs is the duration, not a time constant', () => {
    let level = 0;
    const dt = ROGERS_CENTRE.blackout.fadeMs / 100;
    for (let i = 0; i < 50; i++) level = stepDarkLevel(level, true, dt);
    expect(level).toBeCloseTo(0.5, 6); // half the fade → half way, exactly
    for (let i = 0; i < 50; i++) level = stepDarkLevel(level, true, dt);
    expect(level).toBeCloseTo(1, 6);
  });

  it('one dt larger than the whole fade lands exactly on the target, not past it', () => {
    expect(stepDarkLevel(0, true, ROGERS_CENTRE.blackout.fadeMs * 10)).toBe(1);
    expect(stepDarkLevel(1, false, ROGERS_CENTRE.blackout.fadeMs * 10)).toBe(0);
  });

  it('a non-finite incoming level is repaired rather than propagated', () => {
    expect(Number.isFinite(stepDarkLevel(Number.NaN, true, 16))).toBe(true);
  });
});

describe('darkGainFor — what the shader multiplies every program emissive by', () => {
  it('is 1 when lit and the configured floor when fully dark', () => {
    expect(darkGainFor(0)).toBe(1);
    expect(darkGainFor(1)).toBeCloseTo(ROGERS_CENTRE.blackout.floor, 9);
  });
  it('is monotonic in between, and the floor is a dim glow — not a black hole in the mesh', () => {
    expect(darkGainFor(0.5)).toBeLessThan(darkGainFor(0.25));
    expect(darkGainFor(0.5)).toBeGreaterThan(darkGainFor(0.75));
    expect(ROGERS_CENTRE.blackout.floor).toBeGreaterThan(0);
    expect(ROGERS_CENTRE.blackout.floor).toBeLessThan(0.2);
  });
});

describe('rogersProgram.ts is PURE — the property the whole architecture rests on', () => {
  // Source scan (the cnBlackoutLaw.test.ts / layeringGuard.test.ts idiom): this module may not
  // read a clock, touch three, or learn about the power grid. The blackout DECISION is made one
  // layer out (rogersNightMaterial.ts, which legitimately imports powergrid) and arrives here as a
  // boolean — that split is what keeps every timing function unit-testable and freeze-aware.
  const source = readFileSync(resolve(process.cwd(), 'src/game/world/toronto/rogersProgram.ts'), 'utf-8');
  const codeLines = source
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'));

  it('imports nothing from powergrid/ or three', () => {
    for (const line of codeLines) {
      expect(line).not.toMatch(/from\s*['"][^'"]*powergrid[^'"]*['"]/);
      expect(line).not.toMatch(/from\s*['"]three['"]/);
    }
  });

  it('never reads a clock itself (every function takes tMs)', () => {
    for (const line of codeLines) {
      expect(line).not.toMatch(/performance\.now|Date\.now|simNowMs/);
    }
  });
});
