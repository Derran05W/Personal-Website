// Phase 44 — pure tests for the CN Tower night-program config (config/cnTower.ts). Pins the LAW,
// not the literals: CAR 621's 20–40 flashes/minute obstruction-beacon envelope, palette/weight
// table shape, and that every weight is actually positive (so no mode/palette can silently
// starve). Mirrors config/rendering.test.ts's style — a dedicated file per config leaf rather than
// folding into the catch-all config.test.ts, since this leaf is Part-11-specific and sizeable.
import { describe, expect, it } from 'vitest';
import { CN_TOWER } from './cnTower';

describe('CN_TOWER — palette table', () => {
  it('palettes and paletteWeights are the same length', () => {
    expect(CN_TOWER.paletteWeights).toHaveLength(CN_TOWER.palettes.length);
  });

  it('every palette has 4 parseable hex colours', () => {
    const hex6 = /^#[0-9a-fA-F]{6}$/;
    for (const p of CN_TOWER.palettes) {
      expect(p.ringA).toMatch(hex6);
      expect(p.ringB).toMatch(hex6);
      expect(p.crest).toMatch(hex6);
      expect(p.flood).toMatch(hex6);
    }
  });

  it('entry 0 is the canon red/white scheme, named "canada"', () => {
    expect(CN_TOWER.palettes[0]!.name).toBe('canada');
  });

  it('every palette weight is positive (no palette can silently starve)', () => {
    for (const w of CN_TOWER.paletteWeights) expect(w).toBeGreaterThan(0);
  });

  it('every palette name is unique', () => {
    const names = CN_TOWER.palettes.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('CN_TOWER — mode weights', () => {
  it('all three modes (solid/pulse/chase) have a positive weight', () => {
    expect(CN_TOWER.modeWeights.solid).toBeGreaterThan(0);
    expect(CN_TOWER.modeWeights.pulse).toBeGreaterThan(0);
    expect(CN_TOWER.modeWeights.chase).toBeGreaterThan(0);
  });

  it('solid dominates (the real tower holds a scheme far more than it moves)', () => {
    expect(CN_TOWER.modeWeights.solid).toBeGreaterThan(CN_TOWER.modeWeights.pulse);
    expect(CN_TOWER.modeWeights.solid).toBeGreaterThan(CN_TOWER.modeWeights.chase);
  });
});

describe('CN_TOWER — beacon cadence (CAR 621 envelope, map-researcher round 2026-07-27)', () => {
  it('the double-flash group lands inside the regulatory 20–40 flashes/minute envelope', () => {
    const flashesPerMinute = (2 * 60_000) / CN_TOWER.beacon.periodMs;
    expect(flashesPerMinute).toBeGreaterThanOrEqual(20);
    expect(flashesPerMinute).toBeLessThanOrEqual(40);
  });

  it('a flash + its decay tail never runs into the group\'s second flash', () => {
    expect(CN_TOWER.beacon.flashMs + CN_TOWER.beacon.decayMs).toBeLessThan(CN_TOWER.beacon.gapMs);
  });

  it('the second flash + its decay tail finishes before the period repeats', () => {
    expect(CN_TOWER.beacon.gapMs + CN_TOWER.beacon.flashMs + CN_TOWER.beacon.decayMs).toBeLessThan(
      CN_TOWER.beacon.periodMs,
    );
  });

  it('beacon colour is a parseable hex colour', () => {
    expect(CN_TOWER.beacon.color).toMatch(/^#[0-9a-fA-F]{6}$/);
  });
});

describe('CN_TOWER — ring/crest/flood intensity bounds', () => {
  it('ring pulse min < max, chase idle is a dimmer fraction of peak', () => {
    expect(CN_TOWER.ring.pulseMinIntensity).toBeLessThan(CN_TOWER.ring.pulseMaxIntensity);
    expect(CN_TOWER.ring.chaseIdle).toBeGreaterThan(0);
    expect(CN_TOWER.ring.chaseIdle).toBeLessThan(1);
  });

  it('every period is positive (guards the wrap() helper\'s division)', () => {
    expect(CN_TOWER.ring.pulsePeriodMs).toBeGreaterThan(0);
    expect(CN_TOWER.ring.chasePeriodMs).toBeGreaterThan(0);
    expect(CN_TOWER.crest.sweepPeriodMs).toBeGreaterThan(0);
    expect(CN_TOWER.beacon.periodMs).toBeGreaterThan(0);
  });

  it('crest is subtler than the ring (mandate: the fins are lit columns, not a second hero)', () => {
    expect(CN_TOWER.crest.intensity).toBeLessThan(CN_TOWER.ring.solidIntensity);
  });

  it('crest base floor is below full intensity (there is a travelling band to see)', () => {
    expect(CN_TOWER.crest.base).toBeGreaterThan(0);
    expect(CN_TOWER.crest.base).toBeLessThan(1);
  });

  it('flood intensity is positive but moderate (reads as wash, not a second light source)', () => {
    expect(CN_TOWER.flood.intensity).toBeGreaterThan(0);
    expect(CN_TOWER.flood.intensity).toBeLessThan(CN_TOWER.ring.solidIntensity);
  });
});
