// Phase 36 (T3) — the occlusion-v2 stats accumulator. These numbers ARE the phase's acceptance
// evidence (the pass is invisible to a screenshot by construction), so the rules that produce them
// are pinned rather than trusted: the average must be a real rolling mean over a bounded window,
// the max must survive the window rolling past it, and an unmeasured session must be
// distinguishable from a free one.
import { afterEach, describe, expect, it } from 'vitest';
import { readOcclusionPassStats, recordOcclusionPass, resetOcclusionStats } from './occlusionStats';

afterEach(() => {
  resetOcclusionStats();
});

describe('occlusion pass stats', () => {
  it('reads as "nothing measured" before the first frame (the sanity gate)', () => {
    const s = readOcclusionPassStats();
    expect(s.passSamples).toBe(0);
    expect(s.passMsAvg).toBe(0); // MUST be read together with passSamples — 0 ms ≠ free
    expect(s.fadedTargets).toBe(0);
    expect(s.minFade).toBe(1);
  });

  it('snapshots the fade figures (they describe THIS frame, not a running total)', () => {
    recordOcclusionPass(7, 0.35, 0.1);
    recordOcclusionPass(2, 0.8, 0.1);
    const s = readOcclusionPassStats();
    expect(s.fadedTargets).toBe(2);
    expect(s.minFade).toBe(0.8);
  });

  it('averages the cost over the frames recorded so far', () => {
    recordOcclusionPass(0, 1, 0.1);
    recordOcclusionPass(0, 1, 0.3);
    const s = readOcclusionPassStats();
    expect(s.passSamples).toBe(2);
    expect(s.passMsAvg).toBeCloseTo(0.2, 12);
  });

  it('rolls: a long quiet stretch pushes an old spike out of the AVERAGE but not out of the MAX', () => {
    recordOcclusionPass(0, 1, 5); // the spike
    for (let i = 0; i < 200; i++) recordOcclusionPass(0, 1, 0.1); // > one window of quiet frames
    const s = readOcclusionPassStats();
    expect(s.passMsAvg).toBeCloseTo(0.1, 12); // the spike has aged out of the window
    expect(s.passMsMax).toBe(5); // ...but is still on the record
    expect(s.passSamples).toBe(120); // window bound holds — no unbounded growth
  });

  it('resets everything', () => {
    recordOcclusionPass(9, 0.35, 4);
    resetOcclusionStats();
    expect(readOcclusionPassStats()).toEqual({
      fadedTargets: 0,
      minFade: 1,
      passMsAvg: 0,
      passMsMax: 0,
      passSamples: 0,
    });
  });
});
