import { describe, expect, it } from 'vitest';
import { CollisionGroup } from '../config';
import {
  LOS_RAY_GROUPS,
  Turret,
  canFire,
  dampAngle,
  inEngagementRange,
  lateralSpeed,
  maxYawStep,
  slipOk,
  turretMuzzle,
  wrapAngle,
  yawToward,
} from './turret';

const GATE = { engagementRangeM: 35, slipGateMps: 4 };

describe('dampAngle (rate-limited world-aim slew)', () => {
  it('clamps a large step to ±maxStep along the shortest arc', () => {
    // target 90° to the right, but only 0.1 rad of slew allowed this step.
    expect(dampAngle(0, Math.PI / 2, 0.1)).toBeCloseTo(0.1, 6);
    expect(dampAngle(0, -Math.PI / 2, 0.1)).toBeCloseTo(-0.1, 6);
  });

  it('snaps to the target when the remaining delta is within maxStep', () => {
    expect(dampAngle(0, 0.05, 0.1)).toBeCloseTo(0.05, 6);
    expect(dampAngle(1, 1, 0.1)).toBeCloseTo(1, 6);
  });

  it('takes the SHORT way around the ±π seam, not the long way', () => {
    // from 3.0 rad toward -3.0 rad: shortest arc crosses π (delta ≈ +0.283), not −6.
    const next = dampAngle(3.0, -3.0, 1.0);
    // +0.283 is within maxStep 1.0, so it snaps to -3.0 (wrapped), moving the SHORT way.
    expect(wrapAngle(next - -3.0)).toBeCloseTo(0, 6);
  });

  it('converges monotonically toward the target over repeated steps', () => {
    let a = 0;
    for (let i = 0; i < 100; i++) a = dampAngle(a, Math.PI / 2, 0.05);
    expect(a).toBeCloseTo(Math.PI / 2, 4);
  });
});

describe('lateralSpeed (sideways component along chassis right axis)', () => {
  it('is zero when travelling straight forward (+Z at yaw 0)', () => {
    expect(lateralSpeed(0, 10, 0)).toBeCloseTo(0, 6);
  });

  it('equals full speed when travelling straight sideways (+X at yaw 0)', () => {
    expect(lateralSpeed(10, 0, 0)).toBeCloseTo(10, 6);
  });

  it('rotates with the chassis yaw', () => {
    // Facing +X (yaw 90°): +X is now forward → lateral 0; +Z is now sideways → lateral -5.
    const yaw = Math.PI / 2;
    expect(lateralSpeed(5, 0, yaw)).toBeCloseTo(0, 6);
    expect(Math.abs(lateralSpeed(0, 5, yaw))).toBeCloseTo(5, 6);
  });
});

describe('fire gate', () => {
  it('inEngagementRange respects the clamp', () => {
    expect(inEngagementRange(34.9, GATE)).toBe(true);
    expect(inEngagementRange(35, GATE)).toBe(true);
    expect(inEngagementRange(35.1, GATE)).toBe(false);
  });

  it('slipOk uses the absolute lateral speed', () => {
    expect(slipOk(3.9, GATE)).toBe(true);
    expect(slipOk(-3.9, GATE)).toBe(true);
    expect(slipOk(4.1, GATE)).toBe(false);
    expect(slipOk(-4.1, GATE)).toBe(false);
  });

  it('canFire requires range AND slip AND LOS all true', () => {
    const base = { distM: 20, lateralSpeedMps: 1, losClear: true, cfg: GATE };
    expect(canFire(base)).toBe(true);
    expect(canFire({ ...base, distM: 40 })).toBe(false); // out of range
    expect(canFire({ ...base, lateralSpeedMps: 6 })).toBe(false); // slipping
    expect(canFire({ ...base, losClear: false })).toBe(false); // blocked
  });
});

describe('LOS_RAY_GROUPS (buildings-only mask)', () => {
  it('decodes to membership PROJECTILE, filter BUILDING only', () => {
    const membership = LOS_RAY_GROUPS >>> 16;
    const filter = LOS_RAY_GROUPS & 0xffff;
    expect(membership).toBe(CollisionGroup.PROJECTILE);
    expect(filter).toBe(CollisionGroup.BUILDING);
    // props / ground / vehicles are NOT in the filter → they never block LOS.
    expect(filter & CollisionGroup.PROP_STATIC).toBe(0);
    expect(filter & CollisionGroup.GROUND).toBe(0);
    expect(filter & CollisionGroup.PLAYER).toBe(0);
  });
});

describe('turretMuzzle', () => {
  const cfg = { heightM: 1.35, muzzleForwardM: 1.6 };

  it('places the tip ahead along the aim and up by heightM', () => {
    // aim 0 → forward is +Z.
    const m0 = turretMuzzle({ x: 10, y: 1, z: 5 }, 0, cfg);
    expect(m0.x).toBeCloseTo(10, 6);
    expect(m0.y).toBeCloseTo(2.35, 6);
    expect(m0.z).toBeCloseTo(6.6, 6);
    // aim +90° → forward is +X.
    const m90 = turretMuzzle({ x: 10, y: 1, z: 5 }, Math.PI / 2, cfg);
    expect(m90.x).toBeCloseTo(11.6, 6);
    expect(m90.z).toBeCloseTo(5, 6);
  });
});

describe('Turret (world-space damped aim)', () => {
  it('slews toward a world target, rate-limited per step', () => {
    const t = new Turret(0);
    const step = maxYawStep(120, 1 / 60); // ~0.0349 rad
    // Player straight to the right of the chassis (world +X) → desired yaw = +π/2.
    const y1 = t.track({ x: 0, z: 0 }, { x: 100, z: 0 }, step);
    expect(y1).toBeCloseTo(step, 5); // one step's worth, not the full π/2
    // Many steps converge on the world target heading and hold it.
    for (let i = 0; i < 200; i++) t.track({ x: 0, z: 0 }, { x: 100, z: 0 }, step);
    expect(t.yaw).toBeCloseTo(Math.PI / 2, 3);
  });

  it('aim depends only on world positions, never on chassis orientation', () => {
    // track() takes no chassis yaw — the aim is a pure world quantity. Two turrets fed the same
    // chassis/target positions produce identical aim regardless of how their hulls are turned.
    const a = new Turret(0.7);
    const b = new Turret(0.7);
    const step = maxYawStep(120, 1 / 60);
    for (let i = 0; i < 200; i++) {
      a.track({ x: 5, z: 5 }, { x: -10, z: 20 }, step);
      b.track({ x: 5, z: 5 }, { x: -10, z: 20 }, step);
    }
    expect(a.yaw).toBeCloseTo(b.yaw, 9);
    // and it has converged on the true world bearing to the target (dir = target − chassis).
    expect(a.yaw).toBeCloseTo(yawToward(-15, 15), 3);
  });
});
