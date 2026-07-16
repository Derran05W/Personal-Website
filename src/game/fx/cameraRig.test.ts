import { beforeEach, describe, expect, it } from 'vitest';
import {
  addShake,
  cameraDistance,
  computeCameraFrame,
  computeIdealCamPos,
  computeLookTarget,
  dampingAlpha,
  easeSpeedZoom,
  getShakeTrauma,
  resetShake,
  sphericalOffset,
  stepShake,
  type Vec3,
} from './cameraRig';
import { CAMERA } from '../config/camera';
import { STARTER_TOP_SPEED } from '../config/vehicles';

const v3 = (): Vec3 => ({ x: 0, y: 0, z: 0 });

describe('easeSpeedZoom (smoothstep, clamped)', () => {
  it('is 0 at standstill and 1 at top speed', () => {
    expect(easeSpeedZoom(0)).toBe(0);
    expect(easeSpeedZoom(STARTER_TOP_SPEED)).toBeCloseTo(1, 12);
  });

  it('clamps below 0 and above top speed', () => {
    expect(easeSpeedZoom(-10)).toBe(0);
    expect(easeSpeedZoom(STARTER_TOP_SPEED * 3)).toBe(1);
  });

  it('has zero slope at the standstill end (twitch guard)', () => {
    // smoothstep flattens near 0, so a hair of speed barely moves the ease.
    const tiny = easeSpeedZoom(STARTER_TOP_SPEED * 0.02);
    expect(tiny).toBeLessThan(0.02 * 0.1);
  });

  it('is monotonically increasing across the band', () => {
    let prev = -1;
    for (let i = 0; i <= 10; i++) {
      const e = easeSpeedZoom((STARTER_TOP_SPEED * i) / 10);
      expect(e).toBeGreaterThan(prev);
      prev = e;
    }
  });
});

describe('cameraDistance (base + speed zoom + tier zoom)', () => {
  it('is baseDist at rest with no tier', () => {
    expect(cameraDistance(0, 0)).toBeCloseTo(CAMERA.baseDist, 12);
  });

  it('adds the full speedZoom at top speed', () => {
    expect(cameraDistance(STARTER_TOP_SPEED, 0)).toBeCloseTo(CAMERA.baseDist + CAMERA.speedZoom, 12);
  });

  it('clamps the speed-zoom contribution past top speed', () => {
    expect(cameraDistance(STARTER_TOP_SPEED * 5, 0)).toBeCloseTo(cameraDistance(STARTER_TOP_SPEED, 0), 12);
  });

  it('never zooms in below base for negative/garbage speed', () => {
    expect(cameraDistance(-50, 0)).toBeCloseTo(CAMERA.baseDist, 12);
  });

  it('adds tierZoom per wanted tier, independent of speed', () => {
    expect(cameraDistance(0, 3) - cameraDistance(0, 0)).toBeCloseTo(3 * CAMERA.tierZoom, 12);
    expect(cameraDistance(STARTER_TOP_SPEED, 2) - cameraDistance(STARTER_TOP_SPEED, 0)).toBeCloseTo(
      2 * CAMERA.tierZoom,
      12,
    );
  });
});

describe('sphericalOffset (fixed yaw/pitch)', () => {
  it('places the camera above the target at the requested distance', () => {
    const out = sphericalOffset(v3(), 18);
    const len = Math.hypot(out.x, out.y, out.z);
    expect(len).toBeCloseTo(18, 9);
    expect(out.y).toBeGreaterThan(0); // pitched up, looking down
    // yaw 45° → equal +x/+z horizontal components.
    expect(out.x).toBeCloseTo(out.z, 9);
    expect(out.x).toBeGreaterThan(0);
  });

  it('scales linearly with distance', () => {
    const a = sphericalOffset(v3(), 10);
    const b = sphericalOffset({ x: 0, y: 0, z: 0 }, 20);
    expect(b.x).toBeCloseTo(a.x * 2, 9);
    expect(b.y).toBeCloseTo(a.y * 2, 9);
    expect(b.z).toBeCloseTo(a.z * 2, 9);
  });
});

describe('dampingAlpha (frame-rate independent)', () => {
  it('equals CAMERA.lerp at the 60fps tuning step', () => {
    expect(dampingAlpha(CAMERA.lerp, 1 / 60)).toBeCloseTo(CAMERA.lerp, 12);
  });

  it('is 0 for dt=0 and approaches 1 for a huge dt', () => {
    expect(dampingAlpha(CAMERA.lerp, 0)).toBe(0);
    expect(dampingAlpha(CAMERA.lerp, 100)).toBeCloseTo(1, 9);
  });

  it('converges identically at 60fps (two steps) and 30fps (one step)', () => {
    const lerp = CAMERA.lerp;
    // 30fps: one big step from 0 toward 1.
    const a30 = dampingAlpha(lerp, 1 / 30);
    const oneBigStep = 0 + (1 - 0) * a30;
    // 60fps: two small steps from 0 toward 1.
    const a60 = dampingAlpha(lerp, 1 / 60);
    let x = 0;
    x = x + (1 - x) * a60;
    x = x + (1 - x) * a60;
    expect(x).toBeCloseTo(oneBigStep, 12);
  });

  it('generalizes: N steps of dt/N match one step of dt', () => {
    const lerp = 0.2;
    const dt = 1 / 20;
    const n = 8;
    const aBig = dampingAlpha(lerp, dt);
    const big = 0 + (1 - 0) * aBig;
    const aSmall = dampingAlpha(lerp, dt / n);
    let x = 0;
    for (let i = 0; i < n; i++) x = x + (1 - x) * aSmall;
    expect(x).toBeCloseTo(big, 10);
  });
});

describe('computeLookTarget (velocity lead, scaled in)', () => {
  it('collapses onto the player at a standstill (no lead)', () => {
    // Even with a live velocity vector, speed 0 means no lead → look target == player.
    const out = computeLookTarget(v3(), { x: 5, y: 2, z: -1 }, { x: 3, y: 1, z: -2 }, 0);
    expect(out).toEqual({ x: 5, y: 2, z: -1 });
  });

  it('ignores direction noise below the speed epsilon (twitch guard)', () => {
    // A jittery direction at effectively zero speed must not move the look target.
    const out = computeLookTarget(v3(), { x: 5, y: 5, z: 5 }, { x: -9, y: 2, z: 4 }, 1e-4);
    expect(out).toEqual({ x: 5, y: 5, z: 5 });
  });

  it('leads a full lookAhead metres along velocity at top speed', () => {
    const out = computeLookTarget(v3(), { x: 0, y: 0, z: 0 }, { x: STARTER_TOP_SPEED, y: 0, z: 0 }, STARTER_TOP_SPEED);
    expect(out.x).toBeCloseTo(CAMERA.lookAhead, 9);
    expect(out.y).toBeCloseTo(0, 9);
    expect(out.z).toBeCloseTo(0, 9);
  });

  it('scales the lead in with speed (less lead at half speed)', () => {
    const half = STARTER_TOP_SPEED * 0.5;
    const out = computeLookTarget(v3(), { x: 0, y: 0, z: 0 }, { x: half, y: 0, z: 0 }, half);
    // easeSpeedZoom(0.5) = 0.5 → lead = 0.5 × lookAhead.
    expect(out.x).toBeCloseTo(0.5 * CAMERA.lookAhead, 9);
    expect(out.x).toBeLessThan(CAMERA.lookAhead);
  });

  it('leads along the velocity direction, added to the player position', () => {
    // Player at x=10, driving toward +z at top speed → lead the full lookAhead along +z.
    const out = computeLookTarget(v3(), { x: 10, y: 0, z: 0 }, { x: 0, y: 0, z: STARTER_TOP_SPEED }, STARTER_TOP_SPEED);
    expect(out.x).toBeCloseTo(10, 9);
    expect(out.z).toBeCloseTo(CAMERA.lookAhead, 9);
  });
});

describe('computeCameraFrame (ideal + damping)', () => {
  it('holds still when already at the ideal position', () => {
    const ideal = computeIdealCamPos(v3(), { x: 0, y: 0, z: 0 }, 0, 0);
    const frame = computeCameraFrame({
      playerPos: { x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      speed: 0,
      tier: 0,
      dt: 1 / 60,
      currentCamPos: { x: ideal.x, y: ideal.y, z: ideal.z },
    });
    expect(frame.desiredCamPos.x).toBeCloseTo(ideal.x, 9);
    expect(frame.desiredCamPos.y).toBeCloseTo(ideal.y, 9);
    expect(frame.desiredCamPos.z).toBeCloseTo(ideal.z, 9);
    expect(frame.lookTarget).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('moves a lerp-fraction toward the ideal from a cold start', () => {
    const ideal = computeIdealCamPos(v3(), { x: 0, y: 0, z: 0 }, 0, 0);
    const frame = computeCameraFrame({
      playerPos: { x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      speed: 0,
      tier: 0,
      dt: 1 / 60,
      currentCamPos: { x: 0, y: 0, z: 0 },
    });
    // From origin, one 60fps step covers exactly CAMERA.lerp of the way.
    expect(frame.desiredCamPos.x).toBeCloseTo(ideal.x * CAMERA.lerp, 9);
    expect(frame.desiredCamPos.y).toBeCloseTo(ideal.y * CAMERA.lerp, 9);
    expect(frame.desiredCamPos.z).toBeCloseTo(ideal.z * CAMERA.lerp, 9);
  });

  it('accounts for tier zoom in the ideal it damps toward', () => {
    const frame = computeCameraFrame({
      playerPos: { x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      speed: 0,
      tier: 4,
      dt: 100, // huge dt → alpha ≈ 1 → snap to ideal
      currentCamPos: { x: 0, y: 0, z: 0 },
    });
    const ideal = computeIdealCamPos(v3(), { x: 0, y: 0, z: 0 }, 0, 4);
    expect(frame.desiredCamPos.x).toBeCloseTo(ideal.x, 6);
    expect(Math.hypot(ideal.x, ideal.y, ideal.z)).toBeCloseTo(cameraDistance(0, 4), 9);
  });
});

describe('shake (trauma accumulation, cap, decay)', () => {
  beforeEach(() => resetShake());

  it('starts at rest with zero trauma and zero offset', () => {
    expect(getShakeTrauma()).toBe(0);
    const o = stepShake(1 / 60);
    expect(o).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('accumulates trauma but caps at maxAmplitude', () => {
    addShake(0.2);
    expect(getShakeTrauma()).toBeCloseTo(0.2, 12);
    addShake(0.2);
    expect(getShakeTrauma()).toBeCloseTo(0.4, 12);
    addShake(10);
    expect(getShakeTrauma()).toBe(CAMERA.shake.maxAmplitude);
  });

  it('ignores non-positive strength', () => {
    addShake(0.3);
    addShake(-5);
    addShake(0);
    expect(getShakeTrauma()).toBeCloseTo(0.3, 12);
  });

  it('decays trauma linearly at decayPerSec', () => {
    addShake(CAMERA.shake.maxAmplitude);
    stepShake(0.1);
    expect(getShakeTrauma()).toBeCloseTo(CAMERA.shake.maxAmplitude - CAMERA.shake.decayPerSec * 0.1, 9);
  });

  it('decays to a hard zero and produces no offset at rest', () => {
    addShake(CAMERA.shake.maxAmplitude);
    const o = stepShake(10); // way past full decay
    expect(getShakeTrauma()).toBe(0);
    expect(o).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('keeps every axis offset within the (capped) trauma', () => {
    addShake(CAMERA.shake.maxAmplitude);
    for (let i = 0; i < 20; i++) {
      const o = stepShake(1 / 240);
      const bound = getShakeTrauma() + 1e-9;
      expect(Math.abs(o.x)).toBeLessThanOrEqual(bound);
      expect(Math.abs(o.y)).toBeLessThanOrEqual(bound);
      expect(Math.abs(o.z)).toBeLessThanOrEqual(bound);
    }
  });

  it('actually jitters while trauma is live', () => {
    addShake(CAMERA.shake.maxAmplitude);
    stepShake(1 / 120);
    const o = stepShake(1 / 120);
    const moved = Math.abs(o.x) + Math.abs(o.y) + Math.abs(o.z);
    expect(moved).toBeGreaterThan(0);
  });

  it('resetShake clears trauma', () => {
    addShake(CAMERA.shake.maxAmplitude);
    resetShake();
    expect(getShakeTrauma()).toBe(0);
  });
});
