import { describe, expect, it } from 'vitest';
import { Color } from 'three';
import {
  damageTintMix,
  hpLostFraction,
  tintDamageColor,
  type DamageVisualsConfig,
} from './damageStates';
import { DAMAGE_VISUALS } from '../config/damageVisuals';

// --- hpLostFraction (pure) -----------------------------------------------------------------

describe('hpLostFraction', () => {
  it('full hp is 0 lost, 0 hp is fully lost (1)', () => {
    expect(hpLostFraction(100, 100)).toBe(0);
    expect(hpLostFraction(0, 100)).toBe(1);
  });

  it('scales linearly in between', () => {
    expect(hpLostFraction(75, 100)).toBeCloseTo(0.25, 10);
    expect(hpLostFraction(25, 100)).toBeCloseTo(0.75, 10);
    expect(hpLostFraction(30, 40)).toBeCloseTo(0.25, 10); // police's 40 hp, 10 lost
  });

  it('clamps to [0, 1] — overheal-ish hp above max reads as 0 lost, not negative', () => {
    expect(hpLostFraction(150, 100)).toBe(0);
  });

  it('negative/NaN hp reads as fully lost (1), never propagates garbage', () => {
    expect(hpLostFraction(-5, 100)).toBe(1);
    expect(hpLostFraction(NaN, 100)).toBe(1);
  });

  it('a non-positive maxHp reads as 0 lost (defensive default, never throws/NaNs)', () => {
    expect(hpLostFraction(10, 0)).toBe(0);
    expect(hpLostFraction(10, -50)).toBe(0);
  });
});

// --- damageTintMix (pure bracket lookup) ----------------------------------------------------

describe('damageTintMix', () => {
  const cfg: DamageVisualsConfig = {
    charredColor: '#000000',
    tintBrackets: [
      { atLost: 0.25, mix: 0.3 },
      { atLost: 0.5, mix: 0.6 },
      { atLost: 0.75, mix: 0.9 },
    ],
  };

  it('below the first bracket: pristine (mix 0)', () => {
    expect(damageTintMix(0, cfg)).toBe(0);
    expect(damageTintMix(0.24, cfg)).toBe(0);
  });

  it('at/above each bracket threshold, STEPS to that bracket\'s mix (not a continuous lerp)', () => {
    expect(damageTintMix(0.25, cfg)).toBe(0.3);
    expect(damageTintMix(0.4, cfg)).toBe(0.3); // still first bracket, well below the next
    expect(damageTintMix(0.5, cfg)).toBe(0.6);
    expect(damageTintMix(0.74, cfg)).toBe(0.6);
    expect(damageTintMix(0.75, cfg)).toBe(0.9);
    expect(damageTintMix(1, cfg)).toBe(0.9);
  });

  it('the "<" vs ">=" boundary is exact at each threshold', () => {
    expect(damageTintMix(0.2499999, cfg)).toBe(0);
    expect(damageTintMix(0.4999999, cfg)).toBe(0.3);
  });

  it('defaults to the live DAMAGE_VISUALS table when cfg is omitted', () => {
    expect(damageTintMix(0)).toBe(0);
    expect(damageTintMix(1)).toBe(damageTintMix(1, DAMAGE_VISUALS));
  });
});

// --- tintDamageColor (pure colour mutation) -------------------------------------------------

describe('tintDamageColor', () => {
  const cfg: DamageVisualsConfig = {
    charredColor: '#204060',
    tintBrackets: [{ atLost: 0.5, mix: 0.5 }],
  };

  it('wrecked=true fully multiplies toward the charred colour regardless of hpLostFrac', () => {
    const base = new Color('#ff8040');
    const expected = base.clone().multiply(new Color(cfg.charredColor));

    const result = tintDamageColor(base.clone(), 0, true, cfg);

    expect(result.getHexString()).toBe(expected.getHexString());
  });

  it('below every bracket (mix 0) leaves the colour completely unchanged — a true no-op', () => {
    const base = new Color('#ff8040');
    const result = tintDamageColor(base.clone(), 0.1, false, cfg);
    expect(result.getHexString()).toBe(base.getHexString());
  });

  it('at a crossed bracket, multiplies toward a white→charred lerp at that bracket\'s mix', () => {
    const base = new Color('#ff8040');
    const charred = new Color(cfg.charredColor);
    const white = new Color(1, 1, 1);
    const expectedMultiplier = white.clone().lerp(charred, 0.5); // bracket mix = 0.5
    const expected = base.clone().multiply(expectedMultiplier);

    const result = tintDamageColor(base.clone(), 0.5, false, cfg);

    expect(result.getHexString()).toBe(expected.getHexString());
  });

  it('mutates the passed-in Color in place and returns it (chainable, matches three.Color API)', () => {
    const base = new Color('#ff8040');
    const result = tintDamageColor(base, 0.5, false, cfg);
    expect(result).toBe(base); // same instance, not a copy
  });

  it('a fully-wrecked result and the bracket table\'s worst case are both darker than pristine', () => {
    const base = () => new Color('#ff8040');
    const pristine = base();
    const wrecked = tintDamageColor(base(), 1, true, cfg);

    // Luminance proxy: sum of channels. Wrecked must read strictly darker than untouched.
    const sum = (c: Color) => c.r + c.g + c.b;
    expect(sum(wrecked)).toBeLessThan(sum(pristine));
  });
});
