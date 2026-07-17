import { describe, expect, it } from 'vitest';
import { CollisionGroup } from '../config';
import { createRng } from '../world/rng';
import {
  BULLET_RAY_GROUPS,
  type BurstCfg,
  beginBurst,
  bulletDirection,
  canStartBurst,
  initialBurstState,
  pitchToward,
  pumpBurst,
  spreadAngle,
} from './hitscan';

describe('BULLET_RAY_GROUPS (what a round can hit)', () => {
  it('is membership PROJECTILE and a filter of every hittable group except pursuit', () => {
    const membership = BULLET_RAY_GROUPS >>> 16;
    const filter = BULLET_RAY_GROUPS & 0xffff;
    expect(membership).toBe(CollisionGroup.PROJECTILE);
    for (const g of ['PLAYER', 'CIVILIAN', 'PROP_STATIC', 'PROP_DYNAMIC', 'BUILDING', 'GROUND'] as const) {
      expect(filter & CollisionGroup[g]).not.toBe(0);
    }
    // No friendly fire, no projectile-on-projectile, no water.
    expect(filter & CollisionGroup.PURSUIT).toBe(0);
    expect(filter & CollisionGroup.PROJECTILE).toBe(0);
    expect(filter & CollisionGroup.WATER).toBe(0);
  });
});

describe('seeded cone spread', () => {
  it('stays within ±spreadRad', () => {
    const rng = createRng(1234).fork('burst:1');
    const spread = 0.06;
    for (let i = 0; i < 5000; i++) {
      const v = spreadAngle(rng, spread);
      expect(v).toBeGreaterThanOrEqual(-spread);
      expect(v).toBeLessThanOrEqual(spread);
    }
  });

  it('is reproducible from the same seed + fork label, and differs per burst index', () => {
    const base = 99;
    const a = createRng(base).fork('burst:1');
    const b = createRng(base).fork('burst:1');
    const c = createRng(base).fork('burst:2');
    const seqA = [spreadAngle(a, 0.05), spreadAngle(a, 0.05), spreadAngle(a, 0.05)];
    const seqB = [spreadAngle(b, 0.05), spreadAngle(b, 0.05), spreadAngle(b, 0.05)];
    const seqC = [spreadAngle(c, 0.05), spreadAngle(c, 0.05), spreadAngle(c, 0.05)];
    expect(seqA).toEqual(seqB); // same seed + label → identical dispersion
    expect(seqA).not.toEqual(seqC); // next burst → independent stream
  });
});

describe('bulletDirection', () => {
  it('is always a unit vector', () => {
    const cases: readonly [number, number, number, number][] = [
      [0, 0, 0, 0],
      [1.2, -0.3, 0.05, -0.04],
      [Math.PI, 0.5, -0.02, 0.06],
    ];
    for (const [yaw, pitch, dy, dp] of cases) {
      const d = bulletDirection(yaw, pitch, dy, dp);
      expect(Math.hypot(d.x, d.y, d.z)).toBeCloseTo(1, 9);
    }
  });

  it('returns the pure aim direction with zero offsets', () => {
    // aim 0, level → straight +Z.
    const d = bulletDirection(0, 0, 0, 0);
    expect(d.x).toBeCloseTo(0, 9);
    expect(d.y).toBeCloseTo(0, 9);
    expect(d.z).toBeCloseTo(1, 9);
  });

  it('angles down for a negative pitch', () => {
    const d = bulletDirection(0, -0.2, 0, 0);
    expect(d.y).toBeLessThan(0);
  });
});

describe('pitchToward', () => {
  it('is negative when the target sits below the muzzle', () => {
    const pitch = pitchToward({ x: 0, y: 1.5, z: 0 }, { x: 0, y: 0.5, z: 20 });
    expect(pitch).toBeLessThan(0);
  });
});

describe('burst scheduler (sim-time)', () => {
  const cfg: BurstCfg = { rounds: 3, spacingSec: 0.1, cooldownSec: 2.5 };

  it('gates a new burst on idle + cooldown', () => {
    expect(canStartBurst(initialBurstState, 0)).toBe(true);
    const firing = beginBurst(initialBurstState, 0);
    expect(firing.burstIndex).toBe(1);
    expect(canStartBurst(firing, 5)).toBe(false); // already firing
  });

  it('fires exactly 3 rounds ~100 ms apart, then holds a 2.5 s cooldown', () => {
    const dt = 1 / 60;
    let state = beginBurst(initialBurstState, 0);
    const fireTimes: number[] = [];
    // Step ~3 s of sim time.
    for (let step = 0; step < 200; step++) {
      const simTime = step * dt;
      const { fired, state: next } = pumpBurst(state, simTime, cfg);
      for (let k = 0; k < fired.length; k++) fireTimes.push(simTime);
      state = next;
    }
    expect(fireTimes).toHaveLength(3);
    // Round spacing ≈ 100 ms (within one 60 Hz step of slop).
    expect(fireTimes[0]).toBeLessThan(dt + 1e-9);
    expect(fireTimes[1] - fireTimes[0]).toBeGreaterThanOrEqual(0.1 - dt);
    expect(fireTimes[2] - fireTimes[1]).toBeGreaterThanOrEqual(0.1 - dt);
    // Burst ended → idle, cooldown ~ lastRound (0.2) + 2.5.
    expect(state.phase).toBe('idle');
    expect(state.cooldownUntilSec).toBeCloseTo(0.2 + 2.5, 6);
    expect(canStartBurst(state, 2.69)).toBe(false);
    expect(canStartBurst(state, 2.71)).toBe(true);
  });

  it('a single big hitch fires every due round at once (no dropped rounds)', () => {
    const state = beginBurst(initialBurstState, 0);
    const { fired, state: next } = pumpBurst(state, 0.25, cfg);
    expect(fired).toEqual([0, 1, 2]);
    expect(next.phase).toBe('idle');
    expect(next.cooldownUntilSec).toBeCloseTo(0.2 + 2.5, 6);
  });

  it('does not fire a round before its scheduled time', () => {
    const state = beginBurst(initialBurstState, 0);
    // At t=0 only round 0 is due; round 1 (t=0.1) is not.
    const { fired } = pumpBurst(state, 0.05, cfg);
    expect(fired).toEqual([0]);
  });

  it('pump is a no-op while idle', () => {
    const { fired, state } = pumpBurst(initialBurstState, 10, cfg);
    expect(fired).toEqual([]);
    expect(state).toEqual(initialBurstState);
  });
});
