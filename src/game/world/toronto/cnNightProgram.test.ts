// Phase 44 — tests for the CN Tower night program's pure brain (cnNightProgram.ts). No three, no
// React, no canvas: every function here takes its time explicitly, so the whole show is
// unit-testable at any tMs without a frame loop. Mirrors the module's own header claims:
//   1. FREEZE-AWARENESS — same tMs in ⇒ same output out, always (purity block below).
//   2. SEEDED SELECTION — resolveNightProgram is deterministic per seed and spreads across modes
//      and palettes; the canon 'canada' scheme dominates because it carries the heaviest weight.
//   3. THE PHASE FUNCTIONS — ringPhaseAt/beaconEnvelopeAt/crestPhaseAt are the only place the
//      show's timing logic lives; each is checked against its own documented shape.
//   4. DEV OVERRIDE — setCnProgramOverride/effectiveNightProgram compose correctly and clear
//      cleanly (try/finally so a failing assertion can never leak into another test's seed).
import { describe, expect, it } from 'vitest';
import { CN_TOWER } from '../../config/cnTower';
import {
  beaconEnvelopeAt,
  cnProgramOverride,
  crestPhaseAt,
  effectiveNightProgram,
  paletteAt,
  resolveNightProgram,
  ringPhaseAt,
  setCnProgramOverride,
  type CnProgramMode,
} from './cnNightProgram';

describe('resolveNightProgram — seeded selection', () => {
  it('is deterministic: the same seed always returns the same selection', () => {
    const a = resolveNightProgram(4242);
    const b = resolveNightProgram(4242);
    expect(a).toEqual(b);
  });

  it('spreads across at least 2 modes and 3 palettes over a 50-seed sample', () => {
    const modes = new Set<string>();
    const palettes = new Set<number>();
    for (let seed = 0; seed < 50; seed++) {
      const sel = resolveNightProgram(seed);
      modes.add(sel.mode);
      palettes.add(sel.paletteIndex);
    }
    expect(modes.size).toBeGreaterThanOrEqual(2);
    expect(palettes.size).toBeGreaterThanOrEqual(3);
  });

  it('paletteIndex is always a valid index into CN_TOWER.palettes', () => {
    for (let seed = 0; seed < 100; seed++) {
      const { paletteIndex } = resolveNightProgram(seed);
      expect(paletteIndex).toBeGreaterThanOrEqual(0);
      expect(paletteIndex).toBeLessThan(CN_TOWER.palettes.length);
    }
  });

  it('the canon "canada" scheme is the single most frequent palette across 500 seeds (weights work)', () => {
    const counts = new Map<string, number>();
    for (let seed = 0; seed < 500; seed++) {
      const { paletteName } = resolveNightProgram(seed);
      counts.set(paletteName, (counts.get(paletteName) ?? 0) + 1);
    }
    let best = '';
    let bestCount = -1;
    for (const [name, count] of counts) {
      if (count > bestCount) {
        best = name;
        bestCount = count;
      }
    }
    expect(best).toBe('canada');
  });
});

describe('paletteAt', () => {
  it('clamps out-of-range indices into the palette list', () => {
    expect(paletteAt(-5)).toEqual(CN_TOWER.palettes[0]);
    expect(paletteAt(999)).toEqual(CN_TOWER.palettes[CN_TOWER.palettes.length - 1]);
  });

  it('floors a fractional index', () => {
    expect(paletteAt(2.9)).toEqual(CN_TOWER.palettes[2]);
  });
});

describe('ringPhaseAt', () => {
  it('solid mode: constant intensity at the configured level, chasePhase always 0', () => {
    for (const t of [0, 500, 1234, 9999]) {
      const r = ringPhaseAt(t, 'solid');
      expect(r.intensity).toBe(CN_TOWER.ring.solidIntensity);
      expect(r.chasePhase).toBe(0);
    }
  });

  it('pulse mode: t=0 gives MAX (cos-based — a screenshot at sim-time 0 is the full ring)', () => {
    const r = ringPhaseAt(0, 'pulse');
    expect(r.intensity).toBeCloseTo(CN_TOWER.ring.pulseMaxIntensity, 9);
  });

  it('pulse mode: half a period gives MIN', () => {
    const r = ringPhaseAt(CN_TOWER.ring.pulsePeriodMs / 2, 'pulse');
    expect(r.intensity).toBeCloseTo(CN_TOWER.ring.pulseMinIntensity, 9);
  });

  it('pulse mode stays within [min, max] across a full period', () => {
    for (let i = 0; i <= 20; i++) {
      const t = (CN_TOWER.ring.pulsePeriodMs * i) / 20;
      const { intensity } = ringPhaseAt(t, 'pulse');
      expect(intensity).toBeGreaterThanOrEqual(CN_TOWER.ring.pulseMinIntensity - 1e-9);
      expect(intensity).toBeLessThanOrEqual(CN_TOWER.ring.pulseMaxIntensity + 1e-9);
    }
  });

  it('chase mode: phase wraps (t=periodMs behaves exactly like t=0)', () => {
    const at0 = ringPhaseAt(0, 'chase');
    const atPeriod = ringPhaseAt(CN_TOWER.ring.chasePeriodMs, 'chase');
    expect(atPeriod.chasePhase).toBeCloseTo(at0.chasePhase, 9);
  });

  it('chase mode: intensity is constant regardless of phase (the shader does the per-cell window)', () => {
    for (const t of [0, CN_TOWER.ring.chasePeriodMs / 3, CN_TOWER.ring.chasePeriodMs * 1.7]) {
      expect(ringPhaseAt(t, 'chase').intensity).toBe(CN_TOWER.ring.chaseIntensity);
    }
  });
});

describe('beaconEnvelopeAt — the double-flash strobe', () => {
  const cfg = CN_TOWER.beacon;

  it('is 1 during the first flash window [0, flashMs)', () => {
    expect(beaconEnvelopeAt(0)).toBe(1);
    expect(beaconEnvelopeAt(cfg.flashMs / 2)).toBe(1);
    expect(beaconEnvelopeAt(cfg.flashMs - 1)).toBe(1);
  });

  it('is 1 during the second flash window [gapMs, gapMs + flashMs)', () => {
    expect(beaconEnvelopeAt(cfg.gapMs)).toBe(1);
    expect(beaconEnvelopeAt(cfg.gapMs + cfg.flashMs / 2)).toBe(1);
    expect(beaconEnvelopeAt(cfg.gapMs + cfg.flashMs - 1)).toBe(1);
  });

  it('is 0 between the first decay\'s end and the second flash', () => {
    const decayEnd = cfg.flashMs + cfg.decayMs;
    // Only a real gap to sample if the config leaves one (it does: flashMs+decayMs < gapMs).
    expect(decayEnd).toBeLessThan(cfg.gapMs);
    const mid = (decayEnd + cfg.gapMs) / 2;
    expect(beaconEnvelopeAt(mid)).toBe(0);
  });

  it('is 0 from the second decay\'s end to the period repeat', () => {
    const secondDecayEnd = cfg.gapMs + cfg.flashMs + cfg.decayMs;
    expect(secondDecayEnd).toBeLessThan(cfg.periodMs);
    const mid = (secondDecayEnd + cfg.periodMs) / 2;
    expect(beaconEnvelopeAt(mid)).toBe(0);
    expect(beaconEnvelopeAt(cfg.periodMs - 1)).toBe(0);
  });

  it('stays within [0, 1] sampled every 10ms across 2 full periods', () => {
    for (let t = 0; t < cfg.periodMs * 2; t += 10) {
      const v = beaconEnvelopeAt(t);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('repeats exactly every periodMs (20 sample points)', () => {
    for (let i = 0; i < 20; i++) {
      const t = (cfg.periodMs * i) / 20 + 3.7; // an off-boundary offset, still must repeat
      expect(beaconEnvelopeAt(t)).toBeCloseTo(beaconEnvelopeAt(t + cfg.periodMs), 9);
    }
  });
});

describe('crestPhaseAt', () => {
  it('wraps into [0, 1)', () => {
    const period = CN_TOWER.crest.sweepPeriodMs;
    for (const t of [0, period / 4, period / 2, period - 1, period, period * 2.5]) {
      const phase = crestPhaseAt(t);
      expect(phase).toBeGreaterThanOrEqual(0);
      expect(phase).toBeLessThan(1);
    }
  });

  it('t=0 and t=period both give phase 0', () => {
    const period = CN_TOWER.crest.sweepPeriodMs;
    expect(crestPhaseAt(0)).toBeCloseTo(0, 9);
    expect(crestPhaseAt(period)).toBeCloseTo(0, 9);
  });
});

describe('purity — same tMs always gives the same output (freeze-awareness by construction)', () => {
  it('ringPhaseAt', () => {
    expect(ringPhaseAt(1234, 'pulse')).toEqual(ringPhaseAt(1234, 'pulse'));
    expect(ringPhaseAt(1234, 'chase')).toEqual(ringPhaseAt(1234, 'chase'));
  });
  it('beaconEnvelopeAt', () => {
    expect(beaconEnvelopeAt(777)).toBe(beaconEnvelopeAt(777));
  });
  it('crestPhaseAt', () => {
    expect(crestPhaseAt(555)).toBe(crestPhaseAt(555));
  });
});

describe('dev override — setCnProgramOverride / effectiveNightProgram', () => {
  it('a partial mode override leaves the palette on the base selection', () => {
    try {
      const seed = 9001;
      const base = resolveNightProgram(seed);
      const overrideMode: CnProgramMode = base.mode === 'chase' ? 'solid' : 'chase';
      setCnProgramOverride({ mode: overrideMode });
      const sel = effectiveNightProgram(seed);
      expect(sel.mode).toBe(overrideMode);
      expect(sel.paletteIndex).toBe(base.paletteIndex);
    } finally {
      setCnProgramOverride(null);
    }
  });

  it('a subsequent partial paletteIndex override keeps the earlier mode override (partial updates merge)', () => {
    try {
      setCnProgramOverride({ mode: 'chase' });
      setCnProgramOverride({ paletteIndex: 2 });
      const sel = effectiveNightProgram(123);
      expect(sel.mode).toBe('chase');
      expect(sel.paletteIndex).toBe(2);
      expect(sel.paletteName).toBe(paletteAt(2).name);
    } finally {
      setCnProgramOverride(null);
    }
  });

  it('null clears both fields and effectiveNightProgram matches the pure resolve again', () => {
    try {
      setCnProgramOverride({ mode: 'pulse', paletteIndex: 4 });
      expect(cnProgramOverride.mode).toBe('pulse');
      setCnProgramOverride(null);
      expect(cnProgramOverride.mode).toBeNull();
      expect(cnProgramOverride.paletteIndex).toBeNull();
      const seed = 555;
      expect(effectiveNightProgram(seed)).toEqual(resolveNightProgram(seed));
    } finally {
      setCnProgramOverride(null);
    }
  });
});
