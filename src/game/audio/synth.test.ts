import { describe, expect, it } from 'vitest';
import {
  SEMITONE,
  SOUND_BUILDERS,
  SOUND_NAMES,
  SYNTH_PARAMS,
  bustedMotif,
  clamp01,
  cricketChirpSchedule,
  engineBaseFreq,
  engineFilterCutoff,
  engineFreqMultiplier,
  engineGritGain,
  engineTremoloRate,
  explosionVariantParams,
  impactVariantParams,
  impactVelocityGain,
  impactVelocityPitch,
  lerp,
  mulberry32,
  registerAllSounds,
  stingerMotif,
  transpose,
  wreckedMotif,
  type SoundName,
} from './synth';

// jsdom has no Web Audio API (see synth.ts's header), so ONLY the pure decision logic is unit
// tested here — the speed->frequency curves, per-variant impact seeding, tier->motif
// derivation and cricket scheduling. The impure graph builders are exercised structurally in a
// live dev page-eval (voices start/stop, no orphans, 0 console errors); audible quality is a
// human-ears check on real hardware.

describe('math helpers', () => {
  it('clamp01 clamps to [0,1] and treats non-finite as 0', () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(NaN)).toBe(0);
    expect(clamp01(Infinity)).toBe(0);
  });

  it('lerp interpolates linearly', () => {
    expect(lerp(0, 10, 0)).toBe(0);
    expect(lerp(0, 10, 1)).toBe(10);
    expect(lerp(0, 10, 0.25)).toBe(2.5);
  });

  it('SEMITONE is the twelfth root of two', () => {
    expect(SEMITONE).toBeCloseTo(1.059463, 5);
  });

  it('transpose up an octave doubles the frequency', () => {
    expect(transpose(220, 12)).toBeCloseTo(440, 6);
    expect(transpose(440, -12)).toBeCloseTo(220, 6);
    expect(transpose(440, 0)).toBeCloseTo(440, 6);
  });
});

describe('mulberry32 PRNG', () => {
  it('is deterministic for a given seed', () => {
    const a = mulberry32(1234);
    const b = mulberry32(1234);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it('produces different streams for different seeds', () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    expect(a()).not.toBe(b());
  });

  it('stays within [0,1)', () => {
    const r = mulberry32(99);
    for (let i = 0; i < 200; i++) {
      const x = r();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});

describe('engine speed/throttle curves', () => {
  it('freq multiplier spans minMul..maxMul across speed 0..1', () => {
    expect(engineFreqMultiplier(0)).toBeCloseTo(SYNTH_PARAMS.engine.minMul);
    expect(engineFreqMultiplier(1)).toBeCloseTo(SYNTH_PARAMS.engine.maxMul);
    expect(engineFreqMultiplier(0.5)).toBeCloseTo(
      (SYNTH_PARAMS.engine.minMul + SYNTH_PARAMS.engine.maxMul) / 2,
    );
  });

  it('clamps out-of-range speed', () => {
    expect(engineFreqMultiplier(-5)).toBeCloseTo(SYNTH_PARAMS.engine.minMul);
    expect(engineFreqMultiplier(5)).toBeCloseTo(SYNTH_PARAMS.engine.maxMul);
  });

  it('base freq lands in the intended ~54..162 Hz driveable range', () => {
    const idle = engineBaseFreq(0);
    const full = engineBaseFreq(1);
    expect(idle).toBeCloseTo(54, 0);
    expect(full).toBeCloseTo(162, 0);
    // Monotonic and never a whine.
    expect(engineBaseFreq(0.5)).toBeGreaterThan(idle);
    expect(engineBaseFreq(0.5)).toBeLessThan(full);
    expect(full).toBeLessThan(200);
  });

  it('filter cutoff rises monotonically with speed and is capped short of hiss', () => {
    expect(engineFilterCutoff(0)).toBe(SYNTH_PARAMS.engine.minCutoffHz);
    expect(engineFilterCutoff(1)).toBe(SYNTH_PARAMS.engine.maxCutoffHz);
    expect(engineFilterCutoff(0.5)).toBeGreaterThan(engineFilterCutoff(0.25));
    expect(engineFilterCutoff(1)).toBeLessThanOrEqual(2000);
  });

  it('tremolo rate quickens with speed', () => {
    expect(engineTremoloRate(0)).toBe(SYNTH_PARAMS.engine.tremoloMinHz);
    expect(engineTremoloRate(1)).toBe(SYNTH_PARAMS.engine.tremoloMaxHz);
    expect(engineTremoloRate(0.5)).toBeGreaterThan(engineTremoloRate(0));
  });

  it('grit gain rises with throttle from the always-on air floor', () => {
    expect(engineGritGain(0)).toBeCloseTo(SYNTH_PARAMS.engine.noiseBaseGain);
    expect(engineGritGain(1)).toBeCloseTo(
      SYNTH_PARAMS.engine.noiseBaseGain + SYNTH_PARAMS.engine.noiseGritGain,
    );
    expect(engineGritGain(0.5)).toBeGreaterThan(engineGritGain(0));
  });
});

describe('impact variants', () => {
  it('is deterministic per variant index', () => {
    expect(impactVariantParams(2)).toEqual(impactVariantParams(2));
  });

  it('produces audibly distinct variants (knock frequency differs)', () => {
    const knocks = [0, 1, 2, 3].map((i) => impactVariantParams(i).knockHz);
    const unique = new Set(knocks);
    expect(unique.size).toBe(4);
  });

  it('wraps out-of-range / negative variant indices instead of crashing', () => {
    expect(impactVariantParams(4)).toEqual(impactVariantParams(0));
    expect(impactVariantParams(-1)).toEqual(impactVariantParams(3));
    expect(impactVariantParams(1.9)).toEqual(impactVariantParams(1));
  });

  it('keeps every variant inside the configured timbre ranges', () => {
    for (let i = 0; i < SYNTH_PARAMS.impact.variantCount; i++) {
      const v = impactVariantParams(i);
      expect(v.durationSec).toBeGreaterThanOrEqual(SYNTH_PARAMS.impact.durMinMs / 1000 - 1e-9);
      expect(v.durationSec).toBeLessThanOrEqual(SYNTH_PARAMS.impact.durMaxMs / 1000 + 1e-9);
      expect(v.knockHz).toBeGreaterThanOrEqual(SYNTH_PARAMS.impact.knockMinHz);
      expect(v.knockHz).toBeLessThanOrEqual(SYNTH_PARAMS.impact.knockMaxHz);
      expect(v.filterHz).toBeGreaterThanOrEqual(SYNTH_PARAMS.impact.filterMinHz);
      expect(v.filterHz).toBeLessThanOrEqual(SYNTH_PARAMS.impact.filterMaxHz);
    }
  });

  it('velocity scales gain and pitch upward and clamps', () => {
    expect(impactVelocityGain(0)).toBeCloseTo(SYNTH_PARAMS.impact.gainMin);
    expect(impactVelocityGain(1)).toBeCloseTo(SYNTH_PARAMS.impact.gainMax);
    expect(impactVelocityGain(2)).toBeCloseTo(SYNTH_PARAMS.impact.gainMax); // clamped
    expect(impactVelocityGain(0.5)).toBeGreaterThan(impactVelocityGain(0.1));
    expect(impactVelocityPitch(0)).toBeCloseTo(SYNTH_PARAMS.impact.pitchMin);
    expect(impactVelocityPitch(1)).toBeCloseTo(SYNTH_PARAMS.impact.pitchMax);
  });
});

describe('explosion near vs far', () => {
  it('far is quieter, longer-tailed and duller (pre-lowpassed) than near', () => {
    const near = explosionVariantParams('near');
    const far = explosionVariantParams('far');
    expect(far.gain).toBeLessThan(near.gain);
    expect(far.durationSec).toBeGreaterThan(near.durationSec);
    expect(far.cutoffStartHz).toBeLessThan(near.cutoffStartHz);
    expect(far.cutoffEndHz).toBeLessThan(near.cutoffEndHz);
  });

  it('both drop toward a ~40 Hz sub gut-punch', () => {
    expect(explosionVariantParams('near').dropEndHz).toBeLessThanOrEqual(45);
    expect(explosionVariantParams('far').dropEndHz).toBeLessThanOrEqual(45);
    expect(explosionVariantParams('near').dropStartHz).toBeGreaterThan(
      explosionVariantParams('near').dropEndHz,
    );
  });

  it('returns a copy, not the shared config object (mutation-safe)', () => {
    const a = explosionVariantParams('near');
    expect(a).not.toBe(SYNTH_PARAMS.explosion.near);
    expect(a).toEqual(SYNTH_PARAMS.explosion.near);
  });
});

describe('stinger motifs (tier -> escalation)', () => {
  it('rises in register monotonically with tier', () => {
    const roots = [1, 2, 3, 4, 5].map((t) => stingerMotif(t).rootHz);
    for (let i = 1; i < roots.length; i++) {
      expect(roots[i]).toBeGreaterThan(roots[i - 1]);
    }
    // ★1 root is the config base; ★5 is transposed up (5-1)*step semitones.
    expect(roots[0]).toBeCloseTo(SYNTH_PARAMS.stinger.baseRootHz);
    expect(roots[4]).toBeCloseTo(
      transpose(SYNTH_PARAMS.stinger.baseRootHz, 4 * SYNTH_PARAMS.stinger.tierSemitoneStep),
    );
  });

  it('has 2 notes at low tiers and 3 at ★3+', () => {
    expect(stingerMotif(1).notes).toHaveLength(2);
    expect(stingerMotif(2).notes).toHaveLength(2);
    expect(stingerMotif(3).notes).toHaveLength(3);
    expect(stingerMotif(5).notes).toHaveLength(3);
  });

  it('tightens note spacing with tier (rising urgency) while staying ≈0.8 s', () => {
    const spanOf = (t: number) => {
      const notes = stingerMotif(t).notes;
      const last = notes[notes.length - 1];
      return last.atSec + last.durSec;
    };
    // Note gaps shrink from ★1 to ★5.
    const gap1 = stingerMotif(1).notes[1].atSec - stingerMotif(1).notes[0].atSec;
    const gap5 = stingerMotif(5).notes[1].atSec - stingerMotif(5).notes[0].atSec;
    expect(gap5).toBeLessThan(gap1);
    for (const t of [1, 2, 3, 4, 5]) {
      expect(spanOf(t)).toBeLessThanOrEqual(1.0);
    }
  });

  it('clamps tier to 1..5', () => {
    expect(stingerMotif(0).rootHz).toBeCloseTo(stingerMotif(1).rootHz);
    expect(stingerMotif(9).rootHz).toBeCloseTo(stingerMotif(5).rootHz);
  });

  it('note start times are non-decreasing', () => {
    const notes = stingerMotif(4).notes;
    for (let i = 1; i < notes.length; i++) {
      expect(notes[i].atSec).toBeGreaterThanOrEqual(notes[i - 1].atSec);
    }
  });
});

describe('wrecked motif', () => {
  it('descends in frequency (a falling crunch)', () => {
    const notes = wreckedMotif().notes;
    expect(notes.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < notes.length; i++) {
      expect(notes[i].freqHz).toBeLessThan(notes[i - 1].freqHz);
    }
  });
});

describe('busted motif', () => {
  it('alternates two distinct tones (hi/lo) over ~1 s', () => {
    const motif = bustedMotif();
    const freqs = new Set(motif.notes.map((n) => n.freqHz));
    expect(freqs.size).toBe(2);
    expect(freqs.has(SYNTH_PARAMS.busted.hiHz)).toBe(true);
    expect(freqs.has(SYNTH_PARAMS.busted.loHz)).toBe(true);
    const last = motif.notes[motif.notes.length - 1];
    expect(last.atSec + last.durSec).toBeCloseTo(SYNTH_PARAMS.busted.totalSec, 1);
    // hi then lo then hi...
    expect(motif.notes[0].freqHz).toBe(SYNTH_PARAMS.busted.hiHz);
    expect(motif.notes[1].freqHz).toBe(SYNTH_PARAMS.busted.loHz);
  });
});

describe('cricket chirp schedule', () => {
  it('is deterministic for a given seed', () => {
    expect(cricketChirpSchedule(42, 20)).toEqual(cricketChirpSchedule(42, 20));
  });

  it('produces the requested number of gaps, all within the configured window', () => {
    const sched = cricketChirpSchedule(3, 500);
    expect(sched).toHaveLength(500);
    for (const s of sched) {
      expect(s.gapSec).toBeGreaterThanOrEqual(SYNTH_PARAMS.ambience.crickets.minGapSec);
      expect(s.gapSec).toBeLessThanOrEqual(SYNTH_PARAMS.ambience.crickets.maxGapSec);
    }
  });

  it('varies gaps (not a constant metronome)', () => {
    const gaps = cricketChirpSchedule(11, 50).map((s) => s.gapSec);
    expect(new Set(gaps).size).toBeGreaterThan(10);
  });

  it('different seeds give different rhythms', () => {
    expect(cricketChirpSchedule(1, 10)).not.toEqual(cricketChirpSchedule(2, 10));
  });

  it('handles a zero/negative count safely', () => {
    expect(cricketChirpSchedule(1, 0)).toEqual([]);
    expect(cricketChirpSchedule(1, -5)).toEqual([]);
  });
});

describe('registration seam', () => {
  const EXPECTED_NAMES: SoundName[] = [
    'engine',
    'impact',
    'gunshot',
    'shellLaunch',
    'explosionNear',
    'explosionFar',
    'transformerHum',
    'transformerZap',
    'powerDownWhoomp',
    'ambienceCity',
    'ambienceCrickets',
    'stingerTier1',
    'stingerTier2',
    'stingerTier3',
    'stingerTier4',
    'stingerTier5',
    'stingerWrecked',
    'stingerBusted',
    'uiTick',
  ];

  it('exposes every stable registration name', () => {
    expect(SOUND_NAMES.sort()).toEqual([...EXPECTED_NAMES].sort());
  });

  it('maps every name to a builder function', () => {
    for (const name of SOUND_NAMES) {
      expect(typeof SOUND_BUILDERS[name]).toBe('function');
    }
  });

  it('registerAllSounds registers every builder exactly once through the seam', () => {
    const seen = new Map<SoundName, unknown>();
    registerAllSounds((name, builder) => {
      expect(seen.has(name)).toBe(false); // no double registration
      seen.set(name, builder);
    });
    expect([...seen.keys()].sort()).toEqual([...EXPECTED_NAMES].sort());
    for (const name of SOUND_NAMES) {
      expect(seen.get(name)).toBe(SOUND_BUILDERS[name]);
    }
  });
});
