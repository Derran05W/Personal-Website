import { describe, expect, it } from 'vitest';
import { UNLOCKS } from '../config/unlocks';
import { bannerForReason, nextUnlockInfo } from './gameOverFormat';

describe('bannerForReason', () => {
  it('maps "busted" to the BUSTED banner', () => {
    expect(bannerForReason('busted')).toEqual({ label: 'BUSTED', variant: 'busted' });
  });

  it('maps "wrecked" to the WRECKED banner', () => {
    expect(bannerForReason('wrecked')).toEqual({ label: 'WRECKED', variant: 'wrecked' });
  });

  it('degrades "quit" to the WRECKED banner (no dedicated quit visual exists)', () => {
    expect(bannerForReason('quit')).toEqual({ label: 'WRECKED', variant: 'wrecked' });
  });

  it('degrades a missing reason (undefined) to WRECKED — the debug-transition case', () => {
    expect(bannerForReason(undefined)).toEqual({ label: 'WRECKED', variant: 'wrecked' });
  });

  it('degrades a null reason to WRECKED', () => {
    expect(bannerForReason(null)).toEqual({ label: 'WRECKED', variant: 'wrecked' });
  });
});

describe('nextUnlockInfo', () => {
  it('at score 0, the next unlock is Street Racer (the lowest non-zero threshold)', () => {
    expect(nextUnlockInfo(0)).toEqual({
      carName: 'Street Racer',
      remaining: UNLOCKS.streetRacer,
      threshold: UNLOCKS.streetRacer,
    });
  });

  it('remaining counts down as lifetimeScore rises', () => {
    expect(nextUnlockInfo(UNLOCKS.streetRacer - 100)?.remaining).toBe(100);
  });

  it('advances to the following car once the current next-unlock threshold is met', () => {
    expect(nextUnlockInfo(UNLOCKS.streetRacer)).toEqual({
      carName: 'Pickup',
      remaining: UNLOCKS.pickup - UNLOCKS.streetRacer,
      threshold: UNLOCKS.pickup,
    });
  });

  it('returns null once every car is unlocked (score at/above the top threshold)', () => {
    expect(nextUnlockInfo(UNLOCKS.redRocket)).toBeNull();
    expect(nextUnlockInfo(UNLOCKS.redRocket + 100_000)).toBeNull();
  });
});
