import { describe, expect, it } from 'vitest';
import { distanceFalloff, nearestPursuers, resolveMasterGainTarget } from './sirens';

// jsdom has no Web Audio implementation, so only the pure decision logic (distance
// falloff, nearest-N selection, mute/pause/not-PLAYING gain gating) is unit-tested here —
// see sirens.ts's file header for the full verification-scope note.

describe('nearestPursuers', () => {
  it('returns candidates sorted ascending by distance to the player', () => {
    const result = nearestPursuers(0, 0, [
      { id: 1, x: 30, z: 0 },
      { id: 2, x: 5, z: 0 },
      { id: 3, x: 10, z: 0 },
    ]);
    expect(result.map((r) => r.id)).toEqual([2, 3, 1]);
  });

  it('caps the result at maxCount, keeping only the nearest', () => {
    const result = nearestPursuers(
      0,
      0,
      [
        { id: 1, x: 1, z: 0 },
        { id: 2, x: 2, z: 0 },
        { id: 3, x: 3, z: 0 },
        { id: 4, x: 4, z: 0 },
      ],
      2,
    );
    expect(result.map((r) => r.id)).toEqual([1, 2]);
  });

  it('returns everything when there are fewer candidates than maxCount', () => {
    const result = nearestPursuers(0, 0, [{ id: 7, x: 3, z: 4 }], 3);
    expect(result).toEqual([{ id: 7, dist: 5 }]);
  });

  it('returns an empty array for no candidates', () => {
    expect(nearestPursuers(0, 0, [])).toEqual([]);
  });

  it('computes straight-line (XZ) distance correctly', () => {
    const result = nearestPursuers(1, 1, [{ id: 1, x: 4, z: 5 }]);
    expect(result[0].dist).toBe(5); // 3-4-5 triangle
  });
});

describe('distanceFalloff', () => {
  it('is 1 at distance 0', () => {
    expect(distanceFalloff(0, 90)).toBe(1);
  });

  it('is 0 at exactly the falloff radius', () => {
    expect(distanceFalloff(90, 90)).toBe(0);
  });

  it('is 0 beyond the falloff radius (clamped, not negative)', () => {
    expect(distanceFalloff(500, 90)).toBe(0);
  });

  it('is linear in between', () => {
    expect(distanceFalloff(45, 90)).toBeCloseTo(0.5);
  });

  it('clamps a defensively-negative distance to 1, not >1', () => {
    expect(distanceFalloff(-10, 90)).toBe(1);
  });

  it('treats a non-finite distance as silence (0)', () => {
    expect(distanceFalloff(NaN, 90)).toBe(0);
    expect(distanceFalloff(Infinity, 90)).toBe(0);
  });

  it('uses SIRENS.falloffRadiusM as the default radius', () => {
    // 90 is the config default (config/audio.ts) — asserted directly to catch an
    // accidental default drift without importing the config module here.
    expect(distanceFalloff(90)).toBe(0);
    expect(distanceFalloff(0)).toBe(1);
  });
});

describe('resolveMasterGainTarget', () => {
  const cfg = { voiceGain: 0.35 };

  it('is 0 when muted, regardless of machine state', () => {
    expect(resolveMasterGainTarget(true, 'PLAYING', cfg)).toBe(0);
    expect(resolveMasterGainTarget(true, 'PAUSED', cfg)).toBe(0);
  });

  it('is cfg.voiceGain while PLAYING and not muted', () => {
    expect(resolveMasterGainTarget(false, 'PLAYING', cfg)).toBe(0.35);
  });

  it('is 0 while PAUSED (even unmuted)', () => {
    expect(resolveMasterGainTarget(false, 'PAUSED', cfg)).toBe(0);
  });

  it('is 0 while GAMEOVER (even unmuted)', () => {
    expect(resolveMasterGainTarget(false, 'GAMEOVER', cfg)).toBe(0);
  });

  it('is 0 in GARAGE/BOOT/LOADING — sirens have nothing to play before a run starts', () => {
    expect(resolveMasterGainTarget(false, 'GARAGE', cfg)).toBe(0);
    expect(resolveMasterGainTarget(false, 'BOOT', cfg)).toBe(0);
    expect(resolveMasterGainTarget(false, 'LOADING', cfg)).toBe(0);
  });
});
