import { describe, expect, it } from 'vitest';
import { generate } from '../world/generate';
import {
  assign,
  beginAssign,
  computeDesiredSet,
  createLightState,
  getDarkPredicate,
  setDistrictDarkSource,
  stepFade,
  streetlightEmitters,
  type DarkPredicate,
  type LightState,
  type StreetlightEmitter,
} from './lightPool';

const ALL_LIT: DarkPredicate = () => false;

/** Build a synthetic emitter row on the X axis: emitter i at (i, 0) in district `dist(i)`. */
function lineEmitters(n: number, dist: (i: number) => number): StreetlightEmitter[] {
  return Array.from({ length: n }, (_, i) => ({ x: i, z: 0, districtId: dist(i) }));
}

describe('streetlightEmitters', () => {
  it('derives only streetlights and caches per world reference', () => {
    const world = generate(12345);
    const a = streetlightEmitters(world);
    const b = streetlightEmitters(world);
    expect(a).toBe(b); // cached by WorldData reference
    expect(a.length).toBeGreaterThan(0);
    for (const e of a) {
      expect(Number.isFinite(e.x)).toBe(true);
      expect(Number.isFinite(e.z)).toBe(true);
      expect(e.districtId).toBeGreaterThanOrEqual(0);
      expect(e.districtId).toBeLessThan(world.districts.length);
    }
    // A different seed is a different WorldData object → a distinct (also-cached) result.
    const other = streetlightEmitters(generate(999));
    expect(other).not.toBe(a);
  });
});

describe('computeDesiredSet — nearest selection', () => {
  it('picks the `count` nearest lit streetlights', () => {
    const emitters = lineEmitters(10, () => 0); // all district 0, all lit
    // player at x=0 → nearest are indices 0,1,2
    const got = computeDesiredSet(emitters, 0, 0, 3, ALL_LIT, [], 0.1);
    expect(got.slice().sort((a, b) => a - b)).toEqual([0, 1, 2]);
  });

  it('returns fewer than count when fewer lit streetlights exist', () => {
    const emitters = lineEmitters(2, () => 0);
    const got = computeDesiredSet(emitters, 0, 0, 6, ALL_LIT, [], 0.1);
    expect(got.slice().sort((a, b) => a - b)).toEqual([0, 1]);
  });
});

describe('computeDesiredSet — dark exclusion', () => {
  it('never selects a streetlight in a dark district', () => {
    // Indices 0,1,2 are in dark district 9; the rest are lit district 0.
    const emitters = lineEmitters(10, (i) => (i < 3 ? 9 : 0));
    const isDark: DarkPredicate = (d) => d === 9;
    const got = computeDesiredSet(emitters, 0, 0, 4, isDark, [], 0.1);
    // Nearest by position would be 0,1,2,3 — but 0..2 are dark, so it must skip to 3,4,5,6.
    expect(got.slice().sort((a, b) => a - b)).toEqual([3, 4, 5, 6]);
    for (const idx of got) expect(emitters[idx].districtId).not.toBe(9);
  });

  it('returns empty when every lit candidate is in a dark district', () => {
    const emitters = lineEmitters(5, () => 9);
    const got = computeDesiredSet(emitters, 0, 0, 6, (d) => d === 9, [], 0.1);
    expect(got).toEqual([]);
  });
});

describe('computeDesiredSet — hysteresis stability', () => {
  // N=1 slot. Incumbent A at index 0 (x=10). Challenger B at index 1 varies.
  function withB(bx: number): number[] {
    const emitters: StreetlightEmitter[] = [
      { x: 10, z: 0, districtId: 0 },
      { x: bx, z: 0, districtId: 0 },
    ];
    // player at x=0; incumbent is index 0 (A)
    return computeDesiredSet(emitters, 0, 0, 1, ALL_LIT, [0], 0.1);
  }

  it('keeps the incumbent when a rival is only marginally closer (within ~10%)', () => {
    // B at x=9.5 → 5% closer than A (10). Incumbent retained.
    expect(withB(9.5)).toEqual([0]);
  });

  it('switches to a rival that is clearly closer (beyond ~10%)', () => {
    // B at x=8 → 20% closer than A. Incumbent evicted.
    expect(withB(8)).toEqual([1]);
  });

  it('does not thrash across repeated ticks at a near-equal distance', () => {
    const emitters: StreetlightEmitter[] = [
      { x: 10, z: 0, districtId: 0 },
      { x: 9.4, z: 0, districtId: 0 },
    ];
    let incumbent = [0];
    // B is ~6% closer than A every tick — inside the 10% band, so A must stay put.
    for (let tick = 0; tick < 5; tick += 1) {
      incumbent = computeDesiredSet(emitters, 0, 0, 1, ALL_LIT, incumbent, 0.1);
      expect(incumbent).toEqual([0]);
    }
  });
});

describe('stepFade — fade state machine', () => {
  const FADE = 0.25;

  it('a parked light stays dark', () => {
    const s = createLightState();
    stepFade(s, 0.1, FADE);
    expect(s.intensity).toBe(0);
    expect(s.current).toBe(-1);
  });

  it('assigning a parked light fades straight in (no invisible fade-out)', () => {
    const s = createLightState();
    beginAssign(s, 4, FADE);
    expect(s.phase).toBe('in');
    expect(s.current).toBe(4);
    // half a fade in → ~half intensity
    stepFade(s, FADE / 2, FADE);
    expect(s.intensity).toBeGreaterThan(0.4);
    expect(s.intensity).toBeLessThan(0.6);
    // finish
    stepFade(s, FADE, FADE);
    expect(s.phase).toBe('steady');
    expect(s.intensity).toBe(1);
    expect(s.current).toBe(4);
  });

  it('reassigning a lit light fades out old then in new, switching position at the seam', () => {
    const s: LightState = { current: 2, desired: 2, phase: 'steady', t: 0, intensity: 1 };
    beginAssign(s, 7, FADE);
    expect(s.phase).toBe('out');
    expect(s.desired).toBe(7);
    expect(s.current).toBe(2); // still at the OLD streetlight while fading out

    // fade out fully
    stepFade(s, FADE, FADE);
    expect(s.phase).toBe('in');
    expect(s.current).toBe(7); // position has switched to the new streetlight
    expect(s.intensity).toBe(0);

    // fade in fully
    stepFade(s, FADE, FADE);
    expect(s.phase).toBe('steady');
    expect(s.current).toBe(7);
    expect(s.intensity).toBe(1);
  });

  it('monotonic ramps: intensity falls during out and rises during in', () => {
    const s: LightState = { current: 1, desired: 1, phase: 'steady', t: 0, intensity: 1 };
    beginAssign(s, 5, FADE);
    let prev = s.intensity;
    // out leg
    for (let i = 0; i < 4; i += 1) {
      stepFade(s, FADE / 4, FADE);
      if (s.phase === 'out') {
        expect(s.intensity).toBeLessThanOrEqual(prev);
        prev = s.intensity;
      }
    }
    // now in the 'in' leg; intensity should climb
    prev = s.intensity;
    for (let i = 0; i < 4; i += 1) {
      stepFade(s, FADE / 4, FADE);
      expect(s.intensity).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = s.intensity;
    }
    expect(s.phase).toBe('steady');
  });

  it('preserves intensity continuity when a fade-in is interrupted by a fade-out', () => {
    const s = createLightState();
    beginAssign(s, 3, FADE); // parked → fade in
    stepFade(s, FADE / 2, FADE); // ~0.5 intensity
    const mid = s.intensity;
    expect(mid).toBeGreaterThan(0.3);
    expect(mid).toBeLessThan(0.7);
    // interrupt with a release toward park (dark-district style)
    beginAssign(s, -1, FADE);
    expect(s.phase).toBe('out');
    // one stepFade of ~0 dt must NOT pop intensity up to 1 — it should continue from `mid`.
    stepFade(s, 0, FADE);
    expect(s.intensity).toBeCloseTo(mid, 5);
  });
});

describe('assign — reconciliation invariants', () => {
  const COUNT = 6;
  const HYST = 0.1;
  const FADE = 0.25;

  function freshStates(n: number): LightState[] {
    return Array.from({ length: n }, () => createLightState());
  }

  it('never commits a light to a dark district', () => {
    const emitters = lineEmitters(20, (i) => (i < 5 ? 9 : 0)); // indices 0..4 dark
    const states = freshStates(COUNT);
    const isDark: DarkPredicate = (d) => d === 9;
    // run a few ticks so the pool settles
    for (let t = 0; t < 5; t += 1) {
      assign(states, emitters, 0, 0, isDark, COUNT, HYST, FADE);
      for (const s of states) stepFade(s, FADE, FADE);
    }
    for (const s of states) {
      if (s.desired !== -1) expect(emitters[s.desired].districtId).not.toBe(9);
      if (s.current !== -1) expect(emitters[s.current].districtId).not.toBe(9);
    }
  });

  it('is stable: identical inputs across ticks change nothing once settled', () => {
    const emitters = lineEmitters(20, () => 0);
    const states = freshStates(COUNT);
    // settle
    for (let t = 0; t < 6; t += 1) {
      assign(states, emitters, 0, 0, ALL_LIT, COUNT, HYST, FADE);
      for (const s of states) stepFade(s, FADE, FADE);
    }
    const before = states.map((s) => ({ ...s }));
    assign(states, emitters, 0, 0, ALL_LIT, COUNT, HYST, FADE);
    for (let i = 0; i < states.length; i += 1) {
      expect(states[i].phase).toBe('steady');
      expect(states[i].desired).toBe(before[i].desired);
      expect(states[i].current).toBe(before[i].current);
    }
    // all six nearest streetlights are covered exactly once
    const targets = states.map((s) => s.desired).filter((d) => d !== -1);
    expect(new Set(targets).size).toBe(targets.length); // no duplicates
    expect(targets.length).toBe(COUNT);
  });

  it('does NOT reassign a light that is mid-fade (the lock), except dark-release', () => {
    const emitters = lineEmitters(20, () => 0);
    const states = freshStates(COUNT);
    // Put one slot deliberately mid-fade toward a far target that is NOT in the nearest set.
    states[0] = { current: 15, desired: 19, phase: 'out', t: 0.05, intensity: 0.8 };
    const snapshot = { ...states[0] };
    assign(states, emitters, 0, 0, ALL_LIT, COUNT, HYST, FADE);
    // slot 0 is locked mid-fade → untouched (still heading to 19)
    expect(states[0].phase).toBe('out');
    expect(states[0].desired).toBe(snapshot.desired);
    expect(states[0].current).toBe(snapshot.current);
  });

  it('releases a settled light whose district goes dark (fade out to park)', () => {
    const emitters = lineEmitters(20, () => 0);
    const states = freshStates(COUNT);
    for (let t = 0; t < 6; t += 1) {
      assign(states, emitters, 0, 0, ALL_LIT, COUNT, HYST, FADE);
      for (const s of states) stepFade(s, FADE, FADE);
    }
    // pick a committed slot and black out its district
    const victim = states.find((s) => s.desired !== -1);
    expect(victim).toBeDefined();
    const darkDistrict = emitters[(victim as LightState).desired].districtId;
    const isDark: DarkPredicate = (d) => d === darkDistrict;
    assign(states, emitters, 0, 0, isDark, COUNT, HYST, FADE);
    // Every slot that was pointing into the now-dark district is now releasing to park.
    for (const s of states) {
      if (s.desired !== -1) expect(emitters[s.desired].districtId).not.toBe(darkDistrict);
    }
    // and it fully parks after the fade completes
    for (let t = 0; t < 4; t += 1) for (const s of states) stepFade(s, FADE, FADE);
    // re-run assign so freed slots pick up the remaining lit nearest
    assign(states, emitters, 0, 0, isDark, COUNT, HYST, FADE);
    for (const s of states) {
      if (s.current !== -1) expect(emitters[s.current].districtId).not.toBe(darkDistrict);
    }
  });
});

describe('dark-district read seam', () => {
  it('defaults to all-lit and is wired/reset via setDistrictDarkSource', () => {
    // default
    expect(getDarkPredicate()(0)).toBe(false);
    setDistrictDarkSource((d) => d === 3);
    expect(getDarkPredicate()(3)).toBe(true);
    expect(getDarkPredicate()(4)).toBe(false);
    // reset with a non-function falls back to all-lit
    setDistrictDarkSource(null);
    expect(getDarkPredicate()(3)).toBe(false);
  });
});
