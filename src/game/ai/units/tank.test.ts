// Phase 12 Task 2: pure-logic coverage for tank.ts. The unit class, the 6× mass override, and the
// live chassis need a Rapier world and are verified on the dev server (see phase notes); this file
// covers the pure, Rapier-free parts the task calls out — the fire-cycle timing, the telegraph
// ramp, the lead math, and the turret rate limit — mirroring armoredPolice.test.ts's pure/live
// split. (Importing tank.ts transitively pulls PursuitVehicle, exactly as armoredPolice.test.ts
// does; only the pure exports are exercised.)

import { describe, expect, it } from 'vitest';
import {
  initialTankFireState,
  leadAimPoint,
  stepTankFire,
  telegraphProgress01,
  unitDir,
  type TankFireCfg,
  type TankFireState,
} from './tank';
import { Turret, maxYawStep, wrapAngle } from '../../combat/turret';
import { ENEMY_UNITS, TANK, TANK_UNIT } from '../../config';

const CFG: TankFireCfg = { fireCooldownSec: TANK.fireCooldown, telegraphSec: TANK.telegraphSec };
const DT = 1 / 60;

/** Run the pure fire cycle at 60 Hz for `durationSec`, gating `inRange` by sim time, collecting the
 * sim times shots fired. Mirrors the unit's monotonic sim clock (simTime = step × dt). */
function simulateFire(durationSec: number, inRange: (t: number) => boolean): number[] {
  let state = initialTankFireState(CFG);
  const fires: number[] = [];
  const steps = Math.round(durationSec / DT);
  for (let n = 1; n <= steps; n++) {
    const t = n * DT;
    const r = stepTankFire(state, t, inRange(t), CFG);
    state = r.state;
    if (r.fired) fires.push(t);
  }
  return fires;
}

describe('config invariants (TDD §5.6 tank row)', () => {
  it('ENEMY_UNITS.tank matches the spec (400 hp / 6× mass / 55% top speed / siege)', () => {
    expect(ENEMY_UNITS.tank.hp).toBe(400);
    expect(ENEMY_UNITS.tank.massFactor).toBe(6.0);
    expect(ENEMY_UNITS.tank.topSpeedPct).toBe(55);
    expect(ENEMY_UNITS.tank.behavior).toBe('siege');
  });

  it('TANK cadence + turret cap are the TDD numbers', () => {
    expect(TANK.fireCooldown).toBe(5);
    expect(TANK.telegraphSec).toBe(0.8);
    expect(TANK.turretYawDegPerSec).toBe(60);
  });

  it('TANK_UNIT aim geometry: tiny lead, 60 m engagement, muzzle matches TankMesh', () => {
    expect(TANK_UNIT.leadTimeSec).toBe(0.2);
    expect(TANK_UNIT.engagementRangeM).toBe(60);
    // Must equal TankMesh's TURRET_DECK_Y + BARREL_CENTER_Y (0.5 + 0.42) and BARREL_TIP_Z (3.2).
    expect(TANK_UNIT.turret.heightM).toBeCloseTo(0.92, 6);
    expect(TANK_UNIT.turret.muzzleForwardM).toBe(3.2);
  });
});

describe('initialTankFireState', () => {
  it('starts idle, one full period before the first shot, zero shots', () => {
    const s = initialTankFireState(CFG);
    expect(s.phase).toBe('idle');
    expect(s.shotsFired).toBe(0);
    // idle part of the period (fireCooldown − telegraph); first telegraph starts here.
    expect(s.nextReadySec).toBeCloseTo(CFG.fireCooldownSec - CFG.telegraphSec, 6);
  });
});

describe('stepTankFire — fire-cycle timing', () => {
  it('fires one shell every fireCooldown, first shot one full period after spawn', () => {
    const fires = simulateFire(16, () => true);
    expect(fires).toHaveLength(3); // 5, 10, 15 within 16 s
    expect(fires[0]).toBeCloseTo(5, 1);
    for (let i = 1; i < fires.length; i++) {
      expect(fires[i] - fires[i - 1]).toBeCloseTo(5, 1);
    }
    // Every shot is preceded by (never coincident with) a telegraph window.
    for (const t of fires) expect(t).toBeGreaterThan(CFG.telegraphSec);
  });

  it('never fires while the player stays out of engagement range', () => {
    expect(simulateFire(20, () => false)).toHaveLength(0);
  });

  it('a ready tank telegraphs the instant the player enters range, then fires ~telegraphSec later', () => {
    // Out of range until t=10 (well past the initial ready time), then in range.
    const fires = simulateFire(12, (t) => t >= 10);
    expect(fires.length).toBeGreaterThanOrEqual(1);
    // First shot ~ 10 + telegraphSec (one telegraph, no backlog of instant shells).
    expect(fires[0]).toBeGreaterThan(10);
    expect(fires[0]).toBeCloseTo(10 + CFG.telegraphSec, 1);
  });

  it('commits a shot even if the player leaves range mid-telegraph', () => {
    // In range only long enough to START the telegraph (through the first telegraph window's open),
    // then out of range: the committed shell still fires.
    const fires = simulateFire(7, (t) => t < 4.2 + DT); // range closes just after telegraph begins
    expect(fires).toHaveLength(1);
    expect(fires[0]).toBeCloseTo(5, 1);
  });
});

describe('telegraphProgress01', () => {
  const s: TankFireState = { phase: 'telegraph', telegraphStartSec: 4.2, nextReadySec: 4.2, shotsFired: 0 };

  it('ramps 0 → 1 across the telegraph window and clamps past it', () => {
    expect(telegraphProgress01(s, 4.2, CFG)).toBeCloseTo(0, 6);
    expect(telegraphProgress01(s, 4.2 + CFG.telegraphSec / 2, CFG)).toBeCloseTo(0.5, 6);
    expect(telegraphProgress01(s, 4.2 + CFG.telegraphSec, CFG)).toBeCloseTo(1, 6);
    expect(telegraphProgress01(s, 4.2 + CFG.telegraphSec + 1, CFG)).toBe(1);
  });

  it('is 0 whenever idle', () => {
    expect(telegraphProgress01({ ...s, phase: 'idle' }, 5, CFG)).toBe(0);
  });
});

describe('leadAimPoint — tiny velocity lead', () => {
  it('adds leadSec × velocity to position on every axis', () => {
    expect(leadAimPoint({ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: -5 }, 0.2)).toEqual({ x: 2, y: 0, z: -1 });
  });

  it('a stationary target leads to its own position', () => {
    expect(leadAimPoint({ x: 3, y: 1, z: 7 }, { x: 0, y: 0, z: 0 }, 0.2)).toEqual({ x: 3, y: 1, z: 7 });
  });
});

describe('unitDir', () => {
  it('returns a unit vector along the span', () => {
    const d = unitDir({ x: 0, y: 0, z: 0 }, { x: 3, y: 0, z: 4 });
    expect(Math.hypot(d.x, d.y, d.z)).toBeCloseTo(1, 6);
    expect(d.x).toBeCloseTo(0.6, 6);
    expect(d.z).toBeCloseTo(0.8, 6);
  });

  it('falls back to +Z for a degenerate span', () => {
    expect(unitDir({ x: 1, y: 1, z: 1 }, { x: 1, y: 1, z: 1 })).toEqual({ x: 0, y: 0, z: 1 });
  });
});

describe('turret rate limit (max 60°/s via combat/turret Turret + maxYawStep)', () => {
  it('maxYawStep converts the deg/s cap into per-step radians', () => {
    expect(maxYawStep(TANK.turretYawDegPerSec, DT)).toBeCloseTo(Math.PI / 180, 9); // 60°/s × 1/60 s = 1°
  });

  it('never slews the world aim faster than the cap, and converges to the bearing', () => {
    const maxStep = maxYawStep(TANK.turretYawDegPerSec, DT);
    const turret = new Turret(0);
    let prev = 0;
    // Target far along +X → desired world yaw = atan2(1000, 0) = +π/2.
    for (let i = 0; i < 200; i++) {
      const yaw = turret.track({ x: 0, z: 0 }, { x: 1000, z: 0 }, maxStep);
      expect(Math.abs(wrapAngle(yaw - prev))).toBeLessThanOrEqual(maxStep + 1e-9);
      prev = yaw;
    }
    expect(turret.yaw).toBeCloseTo(Math.PI / 2, 4);
  });

  it('reaching a 90° bearing takes at least the rate-limited number of steps (no snapping)', () => {
    const maxStep = maxYawStep(TANK.turretYawDegPerSec, DT);
    const minSteps = Math.floor(Math.PI / 2 / maxStep); // ≈ 90 steps at 1°/step
    const turret = new Turret(0);
    let reached = -1;
    for (let i = 0; i < minSteps - 1; i++) {
      turret.track({ x: 0, z: 0 }, { x: 1000, z: 0 }, maxStep);
      if (turret.yaw >= Math.PI / 2 - 1e-6) {
        reached = i;
        break;
      }
    }
    expect(reached).toBe(-1); // cannot reach π/2 before the rate limit allows
  });
});
