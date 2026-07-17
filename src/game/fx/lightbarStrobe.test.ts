import { describe, expect, it } from 'vitest';
import { lightbarPhase, type LightbarConfig } from './lightbarStrobe';

const cfg: LightbarConfig = { hz: 1, splitFrac: 0.5, duty: 0.5, phaseStaggerPerInstance: 0 };

describe('lightbarPhase', () => {
  it('red is lit for the first duty-fraction of its half, then dark for the rest of its half', () => {
    expect(lightbarPhase(0, 0, cfg)).toEqual({ red: 1, blue: 0 }); // cycle 0.0
    expect(lightbarPhase(0.2, 0, cfg)).toEqual({ red: 1, blue: 0 }); // cycle 0.2 < split(0.5)*duty(0.5)=0.25
    expect(lightbarPhase(0.3, 0, cfg)).toEqual({ red: 0, blue: 0 }); // cycle 0.3, within red's half but past its duty
  });

  it('blue is lit for the first duty-fraction of ITS half, then dark for the rest', () => {
    expect(lightbarPhase(0.5, 0, cfg)).toEqual({ red: 0, blue: 1 }); // cycle 0.5, start of blue's half
    expect(lightbarPhase(0.7, 0, cfg)).toEqual({ red: 0, blue: 1 }); // cycle 0.7 < 0.5+0.25
    expect(lightbarPhase(0.8, 0, cfg)).toEqual({ red: 0, blue: 0 }); // cycle 0.8, past blue's duty window
  });

  it('red and blue are never both lit at once, across a full cycle sweep', () => {
    for (let t = 0; t < 1; t += 0.01) {
      const phase = lightbarPhase(t, 0, cfg);
      expect(phase.red === 1 && phase.blue === 1).toBe(false);
    }
  });

  it('is periodic: phase at t and t + 1/hz are identical', () => {
    const hz = 3;
    const c: LightbarConfig = { hz, splitFrac: 0.5, duty: 0.6, phaseStaggerPerInstance: 0.13 };
    for (let t = 0; t < 1; t += 0.037) {
      expect(lightbarPhase(t, 2, c)).toEqual(lightbarPhase(t + 1 / hz, 2, c));
    }
  });

  it('per-instance phase stagger offsets the cycle so a fleet does not blink in lockstep', () => {
    const c: LightbarConfig = { hz: 1, splitFrac: 0.5, duty: 0.5, phaseStaggerPerInstance: 0.5 };
    // Instance 1 is offset by exactly half a cycle from instance 0 — red/blue should be swapped.
    expect(lightbarPhase(0, 0, c)).toEqual({ red: 1, blue: 0 });
    expect(lightbarPhase(0, 1, c)).toEqual({ red: 0, blue: 1 });
  });

  it('handles a negative tSec (dev clock reset / fake-clock test) without silently going dark', () => {
    // Negative t must wrap into [0,1) rather than producing a stray always-dark result.
    const atZero = lightbarPhase(0, 0, cfg);
    const atNegativeCycle = lightbarPhase(-1, 0, cfg); // one full cycle earlier at hz=1
    expect(atNegativeCycle).toEqual(atZero);
  });

  it('splitFrac 0 gives blue the whole cycle; splitFrac 1 gives red the whole cycle', () => {
    const allBlue: LightbarConfig = { hz: 1, splitFrac: 0, duty: 1, phaseStaggerPerInstance: 0 };
    const allRed: LightbarConfig = { hz: 1, splitFrac: 1, duty: 1, phaseStaggerPerInstance: 0 };
    expect(lightbarPhase(0.3, 0, allBlue)).toEqual({ red: 0, blue: 1 });
    expect(lightbarPhase(0.3, 0, allRed)).toEqual({ red: 1, blue: 0 });
  });
});
