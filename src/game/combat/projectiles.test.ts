import { describe, expect, it } from 'vitest';
import { CollisionGroup } from '../config';
import {
  SHELL_SWEEP_GROUPS,
  ShellPool,
  normalizeDir,
  sweepSegLength,
  type ShellSweep,
} from './projectiles';

describe('SHELL_SWEEP_GROUPS (what a shell detonates on)', () => {
  it('is membership PROJECTILE and a filter of every hittable group INCLUDING pursuit', () => {
    const membership = SHELL_SWEEP_GROUPS >>> 16;
    const filter = SHELL_SWEEP_GROUPS & 0xffff;
    expect(membership).toBe(CollisionGroup.PROJECTILE);
    for (const g of [
      'PLAYER',
      'PURSUIT', // shells detonate on other vehicles too — friendly fire (TDD §5.6)
      'CIVILIAN',
      'PROP_STATIC',
      'PROP_DYNAMIC',
      'BUILDING',
      'GROUND',
    ] as const) {
      expect(filter & CollisionGroup[g]).not.toBe(0);
    }
    // Never on another projectile or water.
    expect(filter & CollisionGroup.PROJECTILE).toBe(0);
    expect(filter & CollisionGroup.WATER).toBe(0);
  });
});

describe('normalizeDir', () => {
  it('returns a unit vector', () => {
    const d = normalizeDir(3, 0, 4);
    expect(Math.hypot(d.x, d.y, d.z)).toBeCloseTo(1, 9);
    expect(d.x).toBeCloseTo(0.6, 9);
    expect(d.z).toBeCloseTo(0.8, 9);
  });
  it('falls back to +Z on a zero vector', () => {
    expect(normalizeDir(0, 0, 0)).toEqual({ x: 0, y: 0, z: 1 });
  });
});

describe('sweepSegLength', () => {
  it('is speed × dt (0.75 m at 45 m/s over one 60 Hz step)', () => {
    expect(sweepSegLength(45, 1 / 60)).toBeCloseTo(0.75, 9);
    expect(sweepSegLength(3000, 1 / 60)).toBeCloseTo(50, 9);
  });
});

// --- ShellPool ------------------------------------------------------------------------------

/** A sweep that never hits — shells fly forever (until the lifetime cap). */
const clearSweep: ShellSweep = () => null;

/** Record every detonation point a pool produces. */
function detonateSpy() {
  const points: { x: number; y: number; z: number }[] = [];
  return { points, fn: (x: number, y: number, z: number) => points.push({ x, y, z }) };
}

describe('ShellPool — lifetime cap', () => {
  it('recycles a shell that never contacts anything after lifetimeSec (no detonation)', () => {
    const det = detonateSpy();
    const pool = new ShellPool({ sweep: clearSweep, detonate: det.fn, speed: 45, lifetimeSec: 4, poolSize: 4 });
    pool.spawn(-1, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 });
    expect(pool.activeCount()).toBe(1);

    const dt = 1 / 60;
    // A few steps past the 4 s cap (fixed-step float accumulation lands just under 4.0 at the
    // exact count) — the shell must be gone well before the loop ends.
    const steps = Math.ceil(4 / dt) + 5;
    for (let i = 0; i < steps; i++) pool.step(dt);

    expect(pool.activeCount()).toBe(0); // recycled at the cap
    expect(det.points).toHaveLength(0); // never detonated (never hit anything)
  });
});

describe('ShellPool — free-list recycle', () => {
  it('reuses a slot after a shell detonates', () => {
    // Sweep hits immediately (toi 0) so the first step detonates the shell and frees its slot.
    const det = detonateSpy();
    const hitNow: ShellSweep = () => ({ toi: 0, colliderHandle: 7 });
    const pool = new ShellPool({ sweep: hitNow, detonate: det.fn, speed: 45, lifetimeSec: 4, poolSize: 2 });

    pool.spawn(-1, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 });
    pool.spawn(-1, { x: 5, y: 1, z: 0 }, { x: 0, y: 0, z: 1 });
    expect(pool.activeCount()).toBe(2); // pool full

    pool.step(1 / 60); // both detonate → both slots freed
    expect(pool.activeCount()).toBe(0);
    expect(det.points).toHaveLength(2);

    // A fresh fire reuses a recycled slot rather than failing.
    pool.spawn(-1, { x: 9, y: 1, z: 0 }, { x: 0, y: 0, z: 1 });
    expect(pool.activeCount()).toBe(1);
  });

  it('recycles the OLDEST live shell when the pool is full (spawn never fails)', () => {
    const det = detonateSpy();
    const pool = new ShellPool({ sweep: clearSweep, detonate: det.fn, speed: 45, lifetimeSec: 4, poolSize: 2 });
    pool.spawn(-1, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 });
    pool.spawn(-1, { x: 1, y: 1, z: 0 }, { x: 0, y: 0, z: 1 });
    pool.spawn(-1, { x: 2, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }); // pool full → evicts oldest
    expect(pool.activeCount()).toBe(2); // capped at poolSize, never overflows
  });
});

describe('ShellPool — sweep math (detonation point)', () => {
  it('detonates at origin + dir × toi', () => {
    const det = detonateSpy();
    // Hit at toi 3 along +X from x=2 → detonation at x=5.
    const hitAt3: ShellSweep = () => ({ toi: 3, colliderHandle: 1 });
    const pool = new ShellPool({ sweep: hitAt3, detonate: det.fn, speed: 45, lifetimeSec: 4, poolSize: 1 });
    pool.spawn(-1, { x: 2, y: 1.5, z: -4 }, { x: 1, y: 0, z: 0 });
    pool.step(1 / 60);
    expect(det.points).toEqual([{ x: 5, y: 1.5, z: -4 }]);
  });
});

describe('ShellPool — no tunneling through a thin obstacle at any speed', () => {
  // A synthetic infinitely-thin wall perpendicular to +X at wallX: a solid sweep reports a hit
  // whenever the step's segment [ox, ox + maxToi] crosses the plane — exactly Rapier's solid
  // raycast behavior against a thin collider. Because the per-step sweep spans the WHOLE
  // inter-frame segment, the wall is caught however large maxToi (i.e. however fast the shell).
  function wallSweep(wallX: number): ShellSweep {
    return (ox, _oy, _oz, dx, _dy, _dz, maxToi) => {
      if (dx <= 0) return null;
      const end = ox + dx * maxToi;
      if (wallX >= ox && wallX <= end) return { toi: wallX - ox, colliderHandle: 42 };
      return null;
    };
  }

  for (const speed of [45, 300, 3000]) {
    it(`detonates AT the wall (never past it) at ${speed} m/s`, () => {
      const det = detonateSpy();
      const wallX = 10;
      const pool = new ShellPool({ sweep: wallSweep(wallX), detonate: det.fn, speed, lifetimeSec: 4, poolSize: 1 });
      pool.spawn(-1, { x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 });

      const dt = 1 / 60;
      let maxSeenX = -Infinity;
      for (let i = 0; i < 400 && pool.activeCount() > 0; i++) {
        for (const pos of pool.getShellPositions()) maxSeenX = Math.max(maxSeenX, pos.x);
        pool.step(dt);
      }

      expect(pool.activeCount()).toBe(0); // detonated, not still flying
      expect(det.points).toHaveLength(1);
      expect(det.points[0].x).toBeCloseTo(wallX, 6); // exactly at the wall
      // The point never advanced BEYOND the wall while live — proof it did not tunnel through.
      expect(maxSeenX).toBeLessThanOrEqual(wallX + 1e-9);
    });
  }
});
