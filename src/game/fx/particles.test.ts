// Unit tests for the three-free particle simulation core (fx/particles.ts). Everything here
// runs in node with no WebGL: the pool, the exactly-once burst drain, the farthest-first
// starvation, the quality budget, and emitter release are all plain-number logic. The
// renderer (fx/ParticlesMount.tsx) is the only three-touching part and is verified visually,
// not here.

import { beforeEach, describe, expect, it } from 'vitest';
import {
  PARTICLE_POOL_CAPACITY,
  getParticleBuffers,
  getParticleStats,
  resetParticles,
  setParticleBudget,
  updateParticles,
} from './particles';
import { attachFxEmitter, pushFxBurst, resetFxFeed } from './particleFeed';

// Fully isolate every test: clear the pool AND the feed, and restore the full budget.
beforeEach(() => {
  resetFxFeed();
  resetParticles();
  setParticleBudget(PARTICLE_POOL_CAPACITY);
});

/** Count live particles by scanning the shared buffers (life[i] > 0 = alive) — an independent
 * check that doesn't trust getParticleStats' incremental counters. */
function scanLive(): number {
  const b = getParticleBuffers();
  let live = 0;
  for (let i = 0; i < b.capacity; i += 1) if (b.life[i] > 0) live += 1;
  return live;
}

describe('pool capacity', () => {
  it('never exceeds capacity no matter how much is demanded', () => {
    // Far more explosion embers+rings than the pool can hold.
    for (let k = 0; k < 100; k += 1) pushFxBurst('explosion', k, 0, 0);
    updateParticles(1 / 60, 0, 0, 0);

    expect(scanLive()).toBeLessThanOrEqual(PARTICLE_POOL_CAPACITY);
    expect(getParticleStats().live).toBeLessThanOrEqual(PARTICLE_POOL_CAPACITY);
    // The counters and the independent scan agree.
    expect(getParticleStats().live).toBe(scanLive());
  });

  it('recycles slots: a saturated pool drains back to empty once everything ages out', () => {
    for (let k = 0; k < 100; k += 1) pushFxBurst('impactSparks', k, 0, 0);
    updateParticles(1 / 60, 0, 0, 0);
    expect(getParticleStats().live).toBeGreaterThan(0);

    // impactSparks live at most 0.42 s — a few big steps past that frees every slot.
    for (let k = 0; k < 5; k += 1) updateParticles(0.2, 0, 0, 0);
    expect(getParticleStats().live).toBe(0);
    expect(scanLive()).toBe(0);
    // …and the pool is reusable afterward.
    pushFxBurst('impactSparks', 0, 0, 0);
    updateParticles(1 / 60, 0, 0, 0);
    expect(getParticleStats().live).toBeGreaterThan(0);
  });
});

describe('burst drain is exactly-once', () => {
  it('a burst spawns on the frame it is drained and never again', () => {
    pushFxBurst('impactSparks', 0, 0, 0); // impactSparks.main.count = 10 at intensity 1
    updateParticles(0.01, 0, 0, 0);
    const afterFirst = getParticleStats().live;
    expect(afterFirst).toBe(10);

    // No new bursts pushed: a second (tiny-dt) update must not re-consume the same burst.
    updateParticles(0.01, 0, 0, 0);
    expect(getParticleStats().live).toBe(afterFirst); // still 10 — none expired, none re-spawned
  });

  it('intensity scales the burst count', () => {
    pushFxBurst('impactSparks', 0, 0, 0, { intensity: 2 });
    updateParticles(0.01, 0, 0, 0);
    expect(getParticleStats().live).toBe(20); // 10 × 2
  });
});

describe('farthest-first starvation', () => {
  it('serves the nearest emitter and starves the farthest when the pool is scarce', () => {
    // Two fire emitters; fire.perSourceCap = 5, so each wants 5 with a 1 s step. Budget 5 =>
    // only ONE emitter's worth of slots. The near one must win.
    setParticleBudget(5);
    const near = attachFxEmitter('fire', 0, 0, 0);
    const far = attachFxEmitter('fire', 100, 0, 100);
    near.intensity = 1;
    far.intensity = 1;

    // Camera at the near emitter's position.
    updateParticles(1, 0, 0, 0);

    const b = getParticleBuffers();
    let live = 0;
    let maxDistNear = 0;
    let anyNearFar = false;
    for (let i = 0; i < b.capacity; i += 1) {
      if (b.life[i] === 0) continue;
      live += 1;
      const dNear = Math.hypot(b.px[i] - 0, b.pz[i] - 0);
      const dFar = Math.hypot(b.px[i] - 100, b.pz[i] - 100);
      if (dNear > maxDistNear) maxDistNear = dNear;
      if (dFar < 5) anyNearFar = true;
    }

    expect(live).toBe(5); // exactly the budget, all from the near emitter
    expect(maxDistNear).toBeLessThan(10); // clustered on the near emitter (spawn + one step)
    expect(anyNearFar).toBe(false); // the far emitter got nothing
  });

  it('serves everyone when demand fits the budget (no starvation)', () => {
    setParticleBudget(PARTICLE_POOL_CAPACITY);
    const a = attachFxEmitter('fire', 0, 0, 0);
    const c = attachFxEmitter('fire', 100, 0, 100);
    a.intensity = 1;
    c.intensity = 1;
    updateParticles(1, 0, 0, 0);

    // Both fired (each capped at perSourceCap 5) — particles exist near BOTH emitters.
    const b = getParticleBuffers();
    let nearA = 0;
    let nearC = 0;
    for (let i = 0; i < b.capacity; i += 1) {
      if (b.life[i] === 0) continue;
      if (Math.hypot(b.px[i], b.pz[i]) < 10) nearA += 1;
      if (Math.hypot(b.px[i] - 100, b.pz[i] - 100) < 10) nearC += 1;
    }
    expect(nearA).toBeGreaterThan(0);
    expect(nearC).toBeGreaterThan(0);
  });
});

describe('quality budget', () => {
  it('caps live particles at the configured budget', () => {
    setParticleBudget(30);
    for (let k = 0; k < 100; k += 1) pushFxBurst('explosion', k, 0, 0);
    updateParticles(1 / 60, 0, 0, 0);
    expect(getParticleStats().live).toBeLessThanOrEqual(30);
  });

  it('a shrunk budget refuses new spawns but does not kill existing particles', () => {
    // Fill toward a larger budget first.
    setParticleBudget(200);
    for (let k = 0; k < 100; k += 1) pushFxBurst('impactSparks', k, 0, 0);
    updateParticles(1 / 60, 0, 0, 0);
    const beforeShrink = getParticleStats().live;
    expect(beforeShrink).toBeGreaterThan(50);

    // Shrink below the current live count: nobody dies from the shrink itself…
    setParticleBudget(10);
    pushFxBurst('impactSparks', 0, 0, 0);
    updateParticles(0, 0, 0, 0); // dt 0 → no aging, no new spawn (budget already exceeded)
    expect(getParticleStats().live).toBe(beforeShrink); // unchanged, not culled to 10
  });
});

describe('emitter release', () => {
  it('a released emitter spawns no more particles', () => {
    const em = attachFxEmitter('fire', 0, 0, 0);
    em.intensity = 1;
    updateParticles(0.5, 0, 0, 0);
    expect(getParticleStats().live).toBeGreaterThan(0);

    em.release();
    // Age everything out; with the emitter gone, nothing replaces it → pool empties and stays empty.
    for (let k = 0; k < 10; k += 1) updateParticles(0.2, 0, 0, 0);
    expect(getParticleStats().live).toBe(0);

    // A further update must not resurrect it.
    updateParticles(0.5, 0, 0, 0);
    expect(getParticleStats().live).toBe(0);
  });
});

describe('stats', () => {
  it('reports poolSize as the fixed capacity and drawCalls per live material', () => {
    expect(getParticleStats()).toEqual({ live: 0, poolSize: PARTICLE_POOL_CAPACITY, drawCalls: 0 });

    // impactSparks is additive-only → exactly one live material → one draw call.
    pushFxBurst('impactSparks', 0, 0, 0);
    updateParticles(0.01, 0, 0, 0);
    expect(getParticleStats().drawCalls).toBe(1);

    // explosion adds an alpha smoke ring → both materials live → two draw calls.
    pushFxBurst('explosion', 0, 0, 0);
    updateParticles(0.01, 0, 0, 0);
    expect(getParticleStats().drawCalls).toBe(2);
  });
});
