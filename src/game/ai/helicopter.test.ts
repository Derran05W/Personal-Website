import { describe, it, expect } from 'vitest';
import {
  HeliController,
  altitudeBob,
  bankAngle,
  countForTier,
  liveryForTier,
  orbitOffset,
  radiusForPresence,
  smoothstep01,
  stepPresence,
  tangentYaw,
  type Vec3,
} from './helicopter';
import { HELI } from '../config/spawn';

const CENTER: Vec3 = { x: 0, y: 0, z: 0 };
// A settle window comfortably longer than a fade (1 / fadeRate s), stepped at the controller's
// dt clamp so a fly-in or fly-out always completes inside it.
const SETTLE_STEPS = 60;

/** Run `steps` frames at the max dt, calling `onFrame` after each (for capturing transients). */
function run(c: HeliController, steps: number, center: Vec3 = CENTER, onFrame?: () => void): void {
  for (let i = 0; i < steps; i++) {
    c.update(0.1, center);
    onFrame?.();
  }
}

function dist2D(x: number, z: number, center: Vec3): number {
  return Math.hypot(x - center.x, z - center.z);
}

// --- tier tables -------------------------------------------------------------------------

describe('tier tables', () => {
  it('maps each tier to its livery (★0/★1 none, ★2 police, ★3 swat, ★4/★5 military)', () => {
    expect(liveryForTier(0)).toBeNull();
    expect(liveryForTier(1)).toBeNull();
    expect(liveryForTier(2)).toBe('police');
    expect(liveryForTier(3)).toBe('swat');
    expect(liveryForTier(4)).toBe('military');
    expect(liveryForTier(5)).toBe('military');
  });

  it('counts helicopters per tier (1 from ★2, 2 at ★5)', () => {
    expect(countForTier(0)).toBe(0);
    expect(countForTier(1)).toBe(0);
    expect(countForTier(2)).toBe(1);
    expect(countForTier(3)).toBe(1);
    expect(countForTier(4)).toBe(1);
    expect(countForTier(5)).toBe(2);
  });

  it('is safe on an out-of-range tier', () => {
    expect(liveryForTier(99)).toBeNull();
    expect(countForTier(99)).toBe(0);
  });
});

// --- orbit math --------------------------------------------------------------------------

describe('orbit math', () => {
  it('places the orbit offset on a circle of the given radius', () => {
    const a = orbitOffset(40, 0);
    expect(a.x).toBeCloseTo(40);
    expect(a.z).toBeCloseTo(0);
    const b = orbitOffset(40, Math.PI / 2);
    expect(b.x).toBeCloseTo(0);
    expect(b.z).toBeCloseTo(40);
    // Radius preserved at an arbitrary phase.
    const c = orbitOffset(40, 1.234);
    expect(Math.hypot(c.x, c.z)).toBeCloseTo(40);
  });

  it('faces the nose along the orbit tangent (project facing = (sin yaw, cos yaw))', () => {
    // At θ=0, CCW travel is toward +Z → yaw 0.
    expect(tangentYaw(0, 1)).toBeCloseTo(0);
    // At θ=π/2 (north point), CCW travel is toward −X → yaw −π/2.
    expect(tangentYaw(Math.PI / 2, 1)).toBeCloseTo(-Math.PI / 2);
  });

  it('flips the tangent yaw when the orbit direction flips', () => {
    // CW at θ=0 travels toward −Z → yaw π (opposite of CCW's 0).
    expect(Math.abs(tangentYaw(0, -1))).toBeCloseTo(Math.PI);
    // Every phase: reversing direction negates the tangent, a π heading flip.
    for (const theta of [0.3, 1.1, 2.7, 4.9]) {
      const ccw = tangentYaw(theta, 1);
      const cw = tangentYaw(theta, -1);
      const delta = Math.abs(((ccw - cw + Math.PI) % (2 * Math.PI)) - Math.PI);
      expect(delta).toBeCloseTo(Math.PI);
    }
  });

  it('banks INTO the turn — sign follows the orbit direction, magnitude clamps', () => {
    const { bankGain, bankMaxRad, orbitAngularSpeed } = HELI;
    // CCW (+) → positive (left) bank; CW (−) → negative; equal magnitude.
    const ccw = bankAngle(orbitAngularSpeed, 1, bankGain, bankMaxRad);
    const cw = bankAngle(orbitAngularSpeed, -1, bankGain, bankMaxRad);
    expect(ccw).toBeGreaterThan(0);
    expect(cw).toBeLessThan(0);
    expect(ccw).toBeCloseTo(-cw);
    expect(ccw).toBeCloseTo(bankGain * orbitAngularSpeed);
    // A high angular velocity clamps to the max lean, sign preserved.
    expect(bankAngle(10, 1, bankGain, bankMaxRad)).toBeCloseTo(bankMaxRad);
    expect(bankAngle(10, -1, bankGain, bankMaxRad)).toBeCloseTo(-bankMaxRad);
  });

  it('bobs altitude as a bounded seeded sine', () => {
    expect(altitudeBob(0, 0, 1.2, 0.6)).toBeCloseTo(0);
    for (let t = 0; t < 20; t += 0.37) {
      expect(Math.abs(altitudeBob(t, 1.9, 1.2, 0.6))).toBeLessThanOrEqual(1.2 + 1e-9);
    }
    // Distinct seeded phases desync the two ★5 helis.
    expect(altitudeBob(0, 0, 1.2, 0.6)).not.toBeCloseTo(altitudeBob(0, 2.4, 1.2, 0.6));
  });
});

// --- presence → radius / fade ------------------------------------------------------------

describe('presence fade', () => {
  it('smoothsteps and maps presence to an edge↔orbit radius', () => {
    expect(smoothstep01(-1)).toBe(0);
    expect(smoothstep01(2)).toBe(1);
    expect(smoothstep01(0.5)).toBeCloseTo(0.5);
    // presence 1 → orbit radius, presence 0 → edge radius.
    expect(radiusForPresence(1, 40, 280)).toBeCloseTo(40);
    expect(radiusForPresence(0, 40, 280)).toBeCloseTo(280);
    // Monotonic in between (mid presence sits between the two).
    const mid = radiusForPresence(0.5, 40, 280);
    expect(mid).toBeGreaterThan(40);
    expect(mid).toBeLessThan(280);
  });

  it('eases presence toward a target without overshooting either edge', () => {
    // Toward 1: reaches and clamps at 1.
    let p = 0;
    for (let i = 0; i < 40; i++) p = stepPresence(p, 1, 0.5, 0.1);
    expect(p).toBe(1);
    // A single big step never passes the target.
    expect(stepPresence(0.9, 1, 0.5, 10)).toBe(1);
    // Toward 0: reaches and clamps at 0, never negative.
    p = 1;
    for (let i = 0; i < 40; i++) p = stepPresence(p, 0, 0.5, 0.1);
    expect(p).toBe(0);
    expect(stepPresence(0.1, 0, 0.5, 10)).toBe(0);
    // Already at target: no movement.
    expect(stepPresence(1, 1, 0.5, 0.1)).toBe(1);
  });
});

// --- lifecycle state machine -------------------------------------------------------------

describe('lifecycle', () => {
  it('flies nothing at ★0/★1 and a police heli in from the edge at ★2', () => {
    const c = new HeliController();
    c.setTier(1);
    run(c, 20);
    expect(c.api.slots[0].livery).toBeNull();
    expect(c.api.slots[0].presence).toBe(0);

    c.setTier(2);
    // On the first frame the arriving heli starts near the edge (flew IN, not teleported).
    c.update(0.1, CENTER);
    expect(c.api.slots[0].livery).toBe('police');
    expect(c.api.slots[0].presence).toBeLessThan(0.2);
    expect(dist2D(c.api.slots[0].x, c.api.slots[0].z, CENTER)).toBeGreaterThan(200);

    run(c, SETTLE_STEPS);
    expect(c.api.slots[0].livery).toBe('police');
    expect(c.api.slots[0].presence).toBe(1);
    // Settled at the orbit radius.
    expect(dist2D(c.api.slots[0].x, c.api.slots[0].z, CENTER)).toBeCloseTo(HELI.orbitRadius, 0);
    // Slot 1 stays absent below ★5.
    expect(c.api.slots[1].livery).toBeNull();
  });

  it('swaps livery on a tier change by flying the old heli OUT then the new one IN', () => {
    const c = new HeliController();
    c.setTier(2);
    run(c, SETTLE_STEPS);
    expect(c.api.slots[0].livery).toBe('police');

    c.setTier(3);
    let sawPoliceDeparting = false;
    let swatAppearedFrame = -1;
    let policeDepartedFirst = true;
    let maxDistDuringSwap = 0;
    let firstSwatPresence = -1;
    let frame = 0;
    run(c, SETTLE_STEPS, CENTER, () => {
      const s = c.api.slots[0];
      const d = dist2D(s.x, s.z, CENTER);
      maxDistDuringSwap = Math.max(maxDistDuringSwap, d);
      if (s.livery === 'police' && s.presence < 1) sawPoliceDeparting = true;
      if (s.livery === 'swat') {
        // The instant SWAT first appears, police must already have been seen departing —
        // otherwise the livery would have swapped in place (a teleport).
        if (swatAppearedFrame < 0) {
          swatAppearedFrame = frame;
          firstSwatPresence = s.presence;
          if (!sawPoliceDeparting) policeDepartedFirst = false;
        }
      }
      frame++;
    });

    expect(sawPoliceDeparting).toBe(true); // old heli flew out
    expect(swatAppearedFrame).toBeGreaterThan(0); // new heli arrived after
    expect(policeDepartedFirst).toBe(true); // strict out-then-in ordering
    expect(firstSwatPresence).toBeLessThan(0.2); // new livery came IN from the edge
    expect(maxDistDuringSwap).toBeGreaterThan(200); // reached toward the map edge (no teleport)

    run(c, SETTLE_STEPS);
    expect(c.api.slots[0].livery).toBe('swat');
    expect(c.api.slots[0].presence).toBe(1);
  });

  it('fields TWO military helis at ★5, always at opposite bearings (π offset)', () => {
    const c = new HeliController();
    c.setTier(5);
    run(c, SETTLE_STEPS);

    const [a, b] = c.api.slots;
    expect(a.livery).toBe('military');
    expect(b.livery).toBe('military');
    expect(a.presence).toBe(1);
    expect(b.presence).toBe(1);

    // Antipodal about the orbit center: offsets are negatives of each other.
    const ax = a.x - CENTER.x;
    const az = a.z - CENTER.z;
    const bx = b.x - CENTER.x;
    const bz = b.z - CENTER.z;
    expect(bx).toBeCloseTo(-ax, 5);
    expect(bz).toBeCloseTo(-az, 5);
    // Never the same bearing — check the invariant across several frames.
    let minSep = Infinity;
    run(c, 30, CENTER, () => {
      const [s0, s1] = c.api.slots;
      const sep = Math.hypot(s0.x - s1.x, s0.z - s1.z);
      minSep = Math.min(minSep, sep);
    });
    expect(minSep).toBeGreaterThan(HELI.orbitRadius); // always well separated
  });

  it('drops the second heli (fly-out) when leaving ★5, and swaps the lead livery', () => {
    const c = new HeliController();
    c.setTier(5);
    run(c, SETTLE_STEPS);
    expect(c.api.slots[1].livery).toBe('military');

    c.setTier(2);
    run(c, SETTLE_STEPS + 20);
    // Slot 1 gone; lead now police.
    expect(c.api.slots[1].livery).toBeNull();
    expect(c.api.slots[1].presence).toBe(0);
    expect(c.api.slots[0].livery).toBe('police');
    expect(c.api.slots[0].presence).toBe(1);
  });

  it('runs the full forced-tier verification sequence 2→3→4→5→2 to the right liveries', () => {
    const c = new HeliController();
    const expectLead = (livery: string, count: number) => {
      expect(c.api.slots[0].livery).toBe(livery);
      expect(c.api.slots[0].presence).toBe(1);
      const active = c.api.slots.filter((s) => s.livery !== null).length;
      expect(active).toBe(count);
    };
    c.setTier(2);
    run(c, SETTLE_STEPS);
    expectLead('police', 1);
    c.setTier(3);
    run(c, SETTLE_STEPS * 2);
    expectLead('swat', 1);
    c.setTier(4);
    run(c, SETTLE_STEPS * 2);
    expectLead('military', 1);
    c.setTier(5);
    run(c, SETTLE_STEPS * 2);
    expectLead('military', 2);
    c.setTier(2);
    run(c, SETTLE_STEPS * 2);
    expectLead('police', 1);
  });

  it('advances the rotor while present and holds it while absent', () => {
    const c = new HeliController();
    c.setTier(2);
    run(c, SETTLE_STEPS);
    const spinning = c.api.slots[0].rotor;
    c.update(0.1, CENTER);
    expect(c.api.slots[0].rotor).not.toBe(spinning); // spins while flying

    // Slot 1 never flew below ★5 → its rotor stayed put.
    expect(c.api.slots[1].rotor).toBe(0);
  });

  it('orbits around the live player position it is fed each frame', () => {
    const c = new HeliController();
    c.setTier(2);
    const player: Vec3 = { x: 100, y: 0, z: -60 };
    run(c, SETTLE_STEPS, player);
    // Settled orbit is centered on the player, not the origin.
    expect(dist2D(c.api.slots[0].x, c.api.slots[0].z, player)).toBeCloseTo(HELI.orbitRadius, 0);
  });
});

// --- debug seam --------------------------------------------------------------------------

describe('debug force-tier', () => {
  it('drives the lifecycle from a forced tier, ignoring the live tier until released', () => {
    const c = new HeliController();
    c.setTier(0); // live tier: no heat, no heli
    c.debug.setForcedTier(5);
    expect(c.debug.getEffectiveTier()).toBe(5);
    run(c, SETTLE_STEPS);
    expect(c.api.slots.filter((s) => s.livery !== null).length).toBe(2);

    // Releasing the override falls back to the live tier — helis fly out.
    c.debug.setForcedTier(null);
    expect(c.debug.getForcedTier()).toBeNull();
    expect(c.debug.getEffectiveTier()).toBe(0);
    run(c, SETTLE_STEPS);
    expect(c.api.slots.filter((s) => s.livery !== null).length).toBe(0);
  });

  it('exposes the same slot references through the debug readout as the sealed api', () => {
    const c = new HeliController();
    expect(c.debug.slots()).toBe(c.api.slots);
  });
});
