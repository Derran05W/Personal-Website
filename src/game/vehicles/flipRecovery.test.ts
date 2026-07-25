import { describe, expect, it } from 'vitest';
import { Euler, Quaternion } from 'three';
import {
  INITIAL_FLIP_RECOVERY_STATE,
  chassisUpDot,
  tickFlipRecovery,
  yawOnlyRotation,
  type FlipRecoveryState,
} from './flipRecovery';
import { PLAYER_RECOVERY } from '../config/vehicles';

const dt = 1 / 60;

/** A quaternion 180° about world X — perfectly upside-down (upDot = -1). */
function upsideDownQuat() {
  return new Quaternion().setFromAxisAngle({ x: 1, y: 0, z: 0 }, Math.PI);
}

describe('tickFlipRecovery', () => {
  it('accumulates flipSec while upDot stays below the threshold', () => {
    let s: FlipRecoveryState = INITIAL_FLIP_RECOVERY_STATE;
    for (let i = 0; i < 30; i++) {
      const r = tickFlipRecovery(s, -1, dt); // fully inverted, well below 0.3
      expect(r.fire).toBe(false);
      s = r.next;
    }
    expect(s.flipSec).toBeCloseTo(30 * dt, 10);
  });

  it('resets to 0 the instant an upright sample arrives', () => {
    let s: FlipRecoveryState = { flipSec: 1.2 };
    const r = tickFlipRecovery(s, 1, dt); // upright (upDot = 1)
    expect(r.fire).toBe(false);
    expect(r.next.flipSec).toBe(0);
    s = r.next;
    expect(s.flipSec).toBe(0);
  });

  it('fires exactly once at sustainSec of continuous flip', () => {
    let s: FlipRecoveryState = INITIAL_FLIP_RECOVERY_STATE;
    let fires = 0;
    // sustainSec (3s) worth of steps plus a margin, all flipped.
    const steps = Math.ceil(PLAYER_RECOVERY.sustainSec / dt) + 10;
    for (let i = 0; i < steps; i++) {
      const r = tickFlipRecovery(s, -1, dt);
      if (r.fire) fires++;
      s = r.next;
    }
    expect(fires).toBe(1);
  });

  it('a brief flip that recovers before sustainSec never fires (timer resets)', () => {
    let s: FlipRecoveryState = INITIAL_FLIP_RECOVERY_STATE;
    // 1 s flipped — well under the 3 s sustain.
    for (let i = 0; i < 60; i++) s = tickFlipRecovery(s, -1, dt).next;
    expect(s.flipSec).toBeCloseTo(1, 10);
    const recovered = tickFlipRecovery(s, 1, dt);
    expect(recovered.fire).toBe(false);
    expect(recovered.next.flipSec).toBe(0);
  });

  it('re-arms after firing and can fire again on a later sustained flip', () => {
    /** Ticks `upDot` continuously until `fire` is seen, then returns the post-fire state. */
    function tickUntilFire(start: FlipRecoveryState, upDot: number): FlipRecoveryState {
      let s = start;
      const maxSteps = Math.ceil(PLAYER_RECOVERY.sustainSec / dt) + 5;
      for (let i = 0; i < maxSteps; i++) {
        const r = tickFlipRecovery(s, upDot, dt);
        s = r.next;
        if (r.fire) return s;
      }
      throw new Error('expected a fire within maxSteps');
    }

    // First sustained flip -> fires once, and the returned state is re-armed (flipSec 0).
    let s = tickUntilFire(INITIAL_FLIP_RECOVERY_STATE, -1);
    expect(s.flipSec).toBe(0);

    // Briefly upright in between (the auto-reset pose lands right-side up).
    s = tickFlipRecovery(s, 1, dt).next;
    expect(s.flipSec).toBe(0);

    // Flips again for a second sustained stretch -> fires a second time.
    s = tickUntilFire(s, -1);
    expect(s.flipSec).toBe(0);
  });

  it('upDot exactly at the threshold counts as upright (boundary resets, does not accumulate)', () => {
    const s: FlipRecoveryState = { flipSec: 1.5 };
    const r = tickFlipRecovery(s, PLAYER_RECOVERY.upDotThreshold, dt);
    expect(r.next.flipSec).toBe(0);
    expect(r.fire).toBe(false);
  });
});

describe('chassisUpDot', () => {
  it('is 1 for an upright (identity) rotation', () => {
    expect(chassisUpDot({ x: 0, y: 0, z: 0, w: 1 })).toBeCloseTo(1, 10);
  });

  it('is -1 for a fully inverted (180° about X) rotation', () => {
    const q = upsideDownQuat();
    expect(chassisUpDot({ x: q.x, y: q.y, z: q.z, w: q.w })).toBeCloseTo(-1, 10);
  });

  it('is unaffected by pure yaw (spinning about world Y never flips the car)', () => {
    const q = new Quaternion().setFromAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI / 3);
    expect(chassisUpDot({ x: q.x, y: q.y, z: q.z, w: q.w })).toBeCloseTo(1, 10);
  });
});

describe('yawOnlyRotation', () => {
  it('strips pitch/roll but preserves yaw', () => {
    // Compose yaw(50°) * pitch(20°) * roll(35°) — a car flipped onto its roof at an angle.
    const yawDeg = 50;
    const composed = new Quaternion().setFromEuler(
      new Euler((20 * Math.PI) / 180, (yawDeg * Math.PI) / 180, (35 * Math.PI) / 180, 'YXZ'),
    );
    const stripped = yawOnlyRotation({ x: composed.x, y: composed.y, z: composed.z, w: composed.w });

    // Upright: the up vector now points straight up.
    const strippedQ = new Quaternion(stripped.x, stripped.y, stripped.z, stripped.w);
    expect(chassisUpDot({ x: strippedQ.x, y: strippedQ.y, z: strippedQ.z, w: strippedQ.w })).toBeCloseTo(1, 10);

    // Yaw preserved: recovering the Euler yaw from the stripped quat matches the input yaw.
    const euler = new Euler().setFromQuaternion(strippedQ, 'YXZ');
    expect(euler.y).toBeCloseTo((yawDeg * Math.PI) / 180, 10);
    expect(euler.x).toBeCloseTo(0, 10);
    expect(euler.z).toBeCloseTo(0, 10);
  });

  it('is a no-op (identity in, identity out) for an already-upright, zero-yaw pose', () => {
    const result = yawOnlyRotation({ x: 0, y: 0, z: 0, w: 1 });
    expect(result.x).toBeCloseTo(0, 10);
    expect(result.y).toBeCloseTo(0, 10);
    expect(result.z).toBeCloseTo(0, 10);
    expect(result.w).toBeCloseTo(1, 10);
  });
});
