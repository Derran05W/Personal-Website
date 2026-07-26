import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PerspectiveCamera } from 'three';
import {
  addShake,
  armFovKick,
  cameraDistance,
  cameraPitchOffsetDeg,
  computeCameraFrame,
  computeIdealCamPos,
  computeLookTarget,
  dampingAlpha,
  deathBeatFraming,
  easeSpeedZoom,
  getDeathCause,
  getDeathPullback,
  getCameraPosConstraint,
  getFovKick,
  getShakeTrauma,
  getSourceTrauma,
  resetCameraRig,
  resetShake,
  setCameraPosConstraint,
  setDeathCause,
  setDeathPullback,
  sphericalOffset,
  stepFovKick,
  stepShake,
  updateCameraRig,
  type Vec3,
} from './cameraRig';
import { CAMERA } from '../config/camera';
import { STARTER_TOP_SPEED } from '../config/vehicles';
import { gameEvents } from '../state/events';
import { useGameStore } from '../state/store';
import { playerVehicle } from '../vehicles/playerRef';
import type { IVehicleModel, VehicleState } from '../vehicles/IVehicleModel';

// --- fakes for the impure updateCameraRig() path -----------------------------------------
// A minimal PerspectiveCamera stand-in: only the surface updateCameraRig touches (position
// .set, lookAt, fov + updateProjectionMatrix). Records the FOV projection-update count so a
// test can assert it fires ONLY while a kick is active.
function makeFakeCamera(fov = 60) {
  const position = {
    x: 0,
    y: 0,
    z: 0,
    set(x: number, y: number, z: number) {
      this.x = x;
      this.y = y;
      this.z = z;
    },
  };
  return {
    fov,
    position,
    projectionUpdates: 0,
    lookAt() {},
    updateProjectionMatrix() {
      this.projectionUpdates += 1;
    },
  };
}

// A stationary stub vehicle at the origin — enough for the camera rig to read a stable pose,
// so the smoothed follow position is constant frame-to-frame and any camera-position change
// across a frame is purely the applied shake offset.
function makeStubModel(): IVehicleModel {
  const zero = { x: 0, y: 0, z: 0 };
  const state: VehicleState = {
    pose: { position: zero, rotation: { x: 0, y: 0, z: 0, w: 1 } },
    rawPose: { position: zero, rotation: { x: 0, y: 0, z: 0, w: 1 } },
    velocity: { x: 0, y: 0, z: 0 },
    speed: 0,
    forwardSpeed: 0,
    upright: true,
    wheels: [],
  };
  return {
    create() {},
    destroy() {},
    applyInputs() {},
    reset() {},
    readState: () => state,
  };
}

function setReducedShake(value: boolean): void {
  useGameStore.setState((s) => ({ settings: { ...s.settings, reducedShake: value } }));
}

// CAMERA.shake is a typed `as const` config block (config/camera.ts) — mutate-and-restore is
// the repo idiom for live-tuning it (core/devPanel.tsx's writeConfigLeaf uses the same
// `Mutable<>`-cast trick). Shipped default is `false` (feel-tuning pass: shake killed
// wholesale); captured once so every describe block below can restore exactly what it found.
const SHIPPED_SHAKE_ENABLED = CAMERA.shake.enabled;
function setShakeEnabled(value: boolean): void {
  (CAMERA.shake as { enabled: boolean }).enabled = value;
}

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

  it('pullback defaults to 0 (no change from the pre-Phase-9 signature)', () => {
    expect(cameraDistance(5, 2)).toBeCloseTo(cameraDistance(5, 2, 0), 12);
  });

  it('adds pullback on top of base/speed/tier zoom, additively', () => {
    expect(cameraDistance(5, 2, 6) - cameraDistance(5, 2, 0)).toBeCloseTo(6, 12);
  });
});

// The pitch half of the same ramp (Phase 34). The zoom is split across distance AND pitch because
// distance alone widens the eye's horizontal radius past the corridor-airspace bound the shipped
// rig lives inside — config/camera.ts carries the derivation, config/camera.law.test.ts pins the
// bound itself. These cases pin the SHAPE (one shared ease, linear per tier, additive with the
// external offsets) rather than the tuned degrees.
describe('cameraPitchOffsetDeg (the speed/tier pitch ramp)', () => {
  it('is 0 at a standstill with no heat, so the base pitch IS the resting pitch', () => {
    expect(cameraPitchOffsetDeg(0, 0)).toBe(0);
  });

  it('adds the full speedPitchDeg at top speed', () => {
    expect(cameraPitchOffsetDeg(STARTER_TOP_SPEED, 0)).toBeCloseTo(CAMERA.speedPitchDeg, 12);
  });

  it('rides the SAME smoothstep as the speed zoom — one ease, two outputs', () => {
    for (const fraction of [0.1, 0.25, 0.5, 0.75, 1]) {
      const speed = STARTER_TOP_SPEED * fraction;
      expect(cameraPitchOffsetDeg(speed, 0)).toBeCloseTo(CAMERA.speedPitchDeg * easeSpeedZoom(speed), 12);
    }
  });

  it('clamps past top speed and never dips below the base pitch on garbage speed', () => {
    expect(cameraPitchOffsetDeg(STARTER_TOP_SPEED * 5, 0)).toBeCloseTo(cameraPitchOffsetDeg(STARTER_TOP_SPEED, 0), 12);
    expect(cameraPitchOffsetDeg(-50, 0)).toBe(0);
  });

  it('adds tierPitchDeg per wanted tier, independent of speed', () => {
    expect(cameraPitchOffsetDeg(0, 3) - cameraPitchOffsetDeg(0, 0)).toBeCloseTo(3 * CAMERA.tierPitchDeg, 12);
    expect(cameraPitchOffsetDeg(STARTER_TOP_SPEED, 2) - cameraPitchOffsetDeg(STARTER_TOP_SPEED, 0)).toBeCloseTo(
      2 * CAMERA.tierPitchDeg,
      12,
    );
  });

  it('is what the ideal position is actually solved at (the rig reads the ramp)', () => {
    const ideal = computeIdealCamPos(v3(), { x: 0, y: 0, z: 0 }, STARTER_TOP_SPEED, 4);
    const dist = cameraDistance(STARTER_TOP_SPEED, 4);
    const pitch = ((CAMERA.pitchDeg + cameraPitchOffsetDeg(STARTER_TOP_SPEED, 4)) * Math.PI) / 180;
    expect(ideal.y).toBeCloseTo(dist * Math.sin(pitch), 9);
    expect(Math.hypot(ideal.x, ideal.z)).toBeCloseTo(dist * Math.cos(pitch), 9);
  });

  it('leaves external pitch offsets (death beat, lab modifier) ADDITIVE on top of it', () => {
    const external = 7;
    const withExternal = computeIdealCamPos(v3(), { x: 0, y: 0, z: 0 }, STARTER_TOP_SPEED, 2, 0, 0, external);
    const dist = cameraDistance(STARTER_TOP_SPEED, 2);
    const pitch = ((CAMERA.pitchDeg + cameraPitchOffsetDeg(STARTER_TOP_SPEED, 2) + external) * Math.PI) / 180;
    expect(withExternal.y).toBeCloseTo(dist * Math.sin(pitch), 9);
    // The ramp is not double-counted: dropping the external offset moves the eye by exactly the
    // difference between the two pitches, nothing more.
    const bare = computeIdealCamPos(v3(), { x: 0, y: 0, z: 0 }, STARTER_TOP_SPEED, 2);
    const barePitch = ((CAMERA.pitchDeg + cameraPitchOffsetDeg(STARTER_TOP_SPEED, 2)) * Math.PI) / 180;
    expect(withExternal.y - bare.y).toBeCloseTo(dist * (Math.sin(pitch) - Math.sin(barePitch)), 9);
  });
});

describe('death pull-back (setDeathPullback / getDeathPullback)', () => {
  beforeEach(() => resetCameraRig());

  it('defaults to false', () => {
    expect(getDeathPullback()).toBe(false);
  });

  it('round-trips true/false', () => {
    setDeathPullback(true);
    expect(getDeathPullback()).toBe(true);
    setDeathPullback(false);
    expect(getDeathPullback()).toBe(false);
  });

  it('resetCameraRig clears it back to false', () => {
    setDeathPullback(true);
    resetCameraRig();
    expect(getDeathPullback()).toBe(false);
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

  it('honors input.pullback (Phase 9 death pull-back), defaulting to 0 when omitted', () => {
    // computeCameraFrame returns a REUSED object (this file's own documented hot-path
    // contract) — extract the number immediately after each call rather than holding two
    // result references, or the second call's mutation silently overwrites the first.
    const withPullback = computeCameraFrame({
      playerPos: { x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      speed: 0,
      tier: 0,
      dt: 100, // snap
      currentCamPos: { x: 0, y: 0, z: 0 },
      pullback: 6,
    });
    const distWith = Math.hypot(withPullback.desiredCamPos.x, withPullback.desiredCamPos.y, withPullback.desiredCamPos.z);

    const without = computeCameraFrame({
      playerPos: { x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      speed: 0,
      tier: 0,
      dt: 100,
      currentCamPos: { x: 0, y: 0, z: 0 },
    });
    const distWithout = Math.hypot(without.desiredCamPos.x, without.desiredCamPos.y, without.desiredCamPos.z);

    expect(distWith - distWithout).toBeCloseTo(6, 6);
  });
});

describe('shake (trauma accumulation, cap, decay)', () => {
  beforeEach(() => resetShake());

  it('starts at rest with zero trauma and zero offset', () => {
    expect(getShakeTrauma()).toBe(0);
    const o = stepShake(1 / 60);
    expect(o).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('accumulates trauma but caps at the (default impact) source cap', () => {
    // Phase 16: a sourceless addShake defaults to the 'impact' bucket, which caps at
    // sourceCaps.impact (< maxAmplitude), NOT at the overall maxAmplitude.
    const cap = CAMERA.shake.sourceCaps.impact;
    addShake(0.1);
    expect(getShakeTrauma()).toBeCloseTo(0.1, 12);
    addShake(0.1);
    expect(getShakeTrauma()).toBeCloseTo(0.2, 12);
    addShake(10);
    expect(getShakeTrauma()).toBe(cap);
  });

  it('ignores non-positive strength', () => {
    addShake(0.3);
    addShake(-5);
    addShake(0);
    expect(getShakeTrauma()).toBeCloseTo(0.3, 12);
  });

  it('decays trauma linearly at decayPerSec', () => {
    const cap = CAMERA.shake.sourceCaps.impact;
    addShake(10); // fill the impact bucket to its cap
    stepShake(0.05);
    expect(getShakeTrauma()).toBeCloseTo(cap - CAMERA.shake.decayPerSec * 0.05, 9);
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

describe('per-source shake budgets (Phase 16)', () => {
  beforeEach(() => resetShake());

  it('a sourceless addShake defaults to the impact bucket', () => {
    addShake(0.2);
    expect(getSourceTrauma('impact')).toBeCloseTo(0.2, 12);
    expect(getSourceTrauma('explosion')).toBe(0);
    expect(getSourceTrauma('ram')).toBe(0);
    expect(getSourceTrauma('generic')).toBe(0);
  });

  it('each source accumulates into its own bucket, capped independently', () => {
    addShake(10, 'impact');
    addShake(10, 'ram');
    expect(getSourceTrauma('impact')).toBe(CAMERA.shake.sourceCaps.impact);
    expect(getSourceTrauma('ram')).toBe(CAMERA.shake.sourceCaps.ram);
    // Filling impact/ram left explosion/generic untouched — buckets are independent.
    expect(getSourceTrauma('explosion')).toBe(0);
    expect(getSourceTrauma('generic')).toBe(0);
  });

  it('a gentle source (ram) is capped below the whole budget, so it layers rather than dominates', () => {
    addShake(10, 'ram');
    expect(getShakeTrauma()).toBeLessThan(CAMERA.shake.maxAmplitude);
    expect(getShakeTrauma()).toBe(CAMERA.shake.sourceCaps.ram);
  });

  it('applied trauma is the sum of the buckets, clamped to maxAmplitude', () => {
    const sum = CAMERA.shake.sourceCaps.impact + CAMERA.shake.sourceCaps.explosion + CAMERA.shake.sourceCaps.ram;
    // Precondition: the buckets deliberately over-subscribe the overall cap, so the sum
    // clamps — that clamp is what keeps the total within maxAmplitude.
    expect(sum).toBeGreaterThan(CAMERA.shake.maxAmplitude);
    addShake(10, 'impact');
    addShake(10, 'explosion');
    addShake(10, 'ram');
    expect(getShakeTrauma()).toBe(CAMERA.shake.maxAmplitude);
  });

  it('every bucket decays together in stepShake', () => {
    addShake(10, 'impact');
    addShake(10, 'ram');
    stepShake(0.05);
    const d = CAMERA.shake.decayPerSec * 0.05;
    expect(getSourceTrauma('impact')).toBeCloseTo(CAMERA.shake.sourceCaps.impact - d, 9);
    expect(getSourceTrauma('ram')).toBeCloseTo(CAMERA.shake.sourceCaps.ram - d, 9);
  });
});

describe('FOV micro-kick (hard-impact punch)', () => {
  beforeEach(() => resetShake());

  it('an impact at/above minStrength arms the kick', () => {
    addShake(CAMERA.shake.fovKick.minStrength, 'impact');
    expect(getFovKick()).toBeGreaterThan(0);
  });

  it('an impact below minStrength does not kick the lens', () => {
    addShake(CAMERA.shake.fovKick.minStrength * 0.5, 'impact');
    expect(getFovKick()).toBe(0);
  });

  it('only the impact source arms the kick (explosion/ram/generic do not)', () => {
    addShake(10, 'explosion');
    addShake(10, 'ram');
    addShake(10, 'generic');
    expect(getFovKick()).toBe(0);
  });

  it('scales with strength (deg = strength × strengthToDeg) and caps at maxDeg', () => {
    addShake(0.4, 'impact');
    expect(getFovKick()).toBeCloseTo(0.4 * CAMERA.shake.fovKick.strengthToDeg, 9);
    resetShake();
    addShake(100, 'impact');
    expect(getFovKick()).toBe(CAMERA.shake.fovKick.maxDeg);
  });

  it('decays to a hard zero at fovKick.decayPerSec (~150 ms from a full kick)', () => {
    armFovKick(100); // saturate to maxDeg
    expect(getFovKick()).toBe(CAMERA.shake.fovKick.maxDeg);
    stepFovKick(0.05);
    expect(getFovKick()).toBeCloseTo(CAMERA.shake.fovKick.maxDeg - CAMERA.shake.fovKick.decayPerSec * 0.05, 9);
    stepFovKick(10); // way past full decay
    expect(getFovKick()).toBe(0);
    // Time to fully decay from maxDeg should land near ~150 ms (config sanity).
    expect(CAMERA.shake.fovKick.maxDeg / CAMERA.shake.fovKick.decayPerSec).toBeLessThan(0.2);
  });
});

describe('deathBeatFraming (WRECKED pull-back vs BUSTED converge)', () => {
  const FULL = CAMERA.cinematic.easeInSec;

  it('is all-zero when inactive', () => {
    expect(deathBeatFraming(false, null, 5)).toEqual({ pullback: 0, yawOffsetDeg: 0, pitchOffsetDeg: 0 });
  });

  it('WRECKED pulls BACK (positive pullback) and lifts (positive pitch) at full ease', () => {
    const f = deathBeatFraming(true, 'wrecked', FULL);
    expect(f.pullback).toBe(CAMERA.deathPullback);
    expect(f.pullback).toBeGreaterThan(0);
    expect(f.pitchOffsetDeg).toBeCloseTo(CAMERA.cinematic.wreckedPitchOffsetDeg, 9);
    expect(f.yawOffsetDeg).toBeCloseTo(CAMERA.cinematic.orbitYawDeg, 9);
  });

  it('BUSTED converges IN (negative pullback) and LOWER (negative pitch) — tighter framing', () => {
    const f = deathBeatFraming(true, 'busted', FULL);
    expect(f.pullback).toBe(CAMERA.cinematic.bustedPullback);
    expect(f.pullback).toBeLessThan(0);
    expect(f.pitchOffsetDeg).toBeLessThan(0);
    // Distinct from the WRECKED beat: pulls the opposite direction on distance.
    expect(f.pullback).toBeLessThan(deathBeatFraming(true, 'wrecked', FULL).pullback);
  });

  it('a null cause (event not yet seen) falls back to WRECKED framing', () => {
    expect(deathBeatFraming(true, null, FULL).pullback).toBe(CAMERA.deathPullback);
  });

  it('eases the orbit/pitch in via smoothstep — exactly half the drift at the ease midpoint', () => {
    const mid = deathBeatFraming(true, 'wrecked', FULL * 0.5);
    // smoothstep(0.5) = 0.5 → half the yaw drift.
    expect(mid.yawOffsetDeg).toBeCloseTo(CAMERA.cinematic.orbitYawDeg * 0.5, 9);
    // The pull-back distance itself does NOT ease here (the position lerp smooths it).
    expect(mid.pullback).toBe(CAMERA.deathPullback);
  });

  it('starts the orbit/pitch at 0 at the very start of the beat (no lurch)', () => {
    const start = deathBeatFraming(true, 'wrecked', 0);
    expect(start.yawOffsetDeg).toBe(0);
    expect(start.pitchOffsetDeg).toBe(0);
  });
});

describe('death-cause capture (WRECKED/BUSTED events → beat framing)', () => {
  beforeEach(() => {
    resetCameraRig();
    setDeathCause(null);
  });

  it('a busted event sets the cause to busted', () => {
    gameEvents.emit('busted', {});
    expect(getDeathCause()).toBe('busted');
  });

  it('a playerWrecked event sets the cause to wrecked', () => {
    gameEvents.emit('playerWrecked', {});
    expect(getDeathCause()).toBe('wrecked');
  });

  it('busted wins over a wrecked that arrives in the same lock', () => {
    gameEvents.emit('playerWrecked', {});
    gameEvents.emit('busted', {});
    expect(getDeathCause()).toBe('busted');
  });

  it('setDeathPullback(false) / resetCameraRig clears the captured cause', () => {
    gameEvents.emit('busted', {});
    setDeathPullback(false);
    expect(getDeathCause()).toBeNull();
    expect(getDeathPullback()).toBe(false);
  });
});

describe('updateCameraRig — reducedShake zeroing + FOV kick application', () => {
  beforeEach(() => {
    resetCameraRig();
    playerVehicle.current = makeStubModel();
    setReducedShake(false);
    // This block exercises the reducedShake-specific gate in isolation from the
    // CAMERA.shake.enabled master kill-switch (shipped default false — see the dedicated
    // describe below), so force the switch on for the duration of these tests.
    setShakeEnabled(true);
  });

  afterEach(() => {
    playerVehicle.current = null;
    resetCameraRig();
    setReducedShake(false);
    setShakeEnabled(SHIPPED_SHAKE_ENABLED);
  });

  it('applies the positional shake to the camera when reducedShake is OFF', () => {
    const cam = makeFakeCamera();
    updateCameraRig(cam as unknown as PerspectiveCamera, 1 / 60); // frame 1: snap, no trauma
    const rest = { x: cam.position.x, y: cam.position.y, z: cam.position.z };

    addShake(10, 'ram'); // 'ram' so we exercise ONLY positional shake, not the FOV kick
    updateCameraRig(cam as unknown as PerspectiveCamera, 1 / 120); // frame 2: jitter live

    const moved =
      Math.abs(cam.position.x - rest.x) + Math.abs(cam.position.y - rest.y) + Math.abs(cam.position.z - rest.z);
    expect(moved).toBeGreaterThan(0);
  });

  it('zeroes the positional shake when reducedShake is ON, but trauma STILL decays', () => {
    const cam = makeFakeCamera();
    updateCameraRig(cam as unknown as PerspectiveCamera, 1 / 60); // frame 1: snap to rest
    const rest = { x: cam.position.x, y: cam.position.y, z: cam.position.z };

    setReducedShake(true);
    addShake(10, 'ram'); // ram bucket = its cap
    const before = getSourceTrauma('ram');
    updateCameraRig(cam as unknown as PerspectiveCamera, 1 / 60);

    // Position is unchanged (no jitter applied)...
    expect(cam.position.x).toBeCloseTo(rest.x, 12);
    expect(cam.position.y).toBeCloseTo(rest.y, 12);
    expect(cam.position.z).toBeCloseTo(rest.z, 12);
    // ...but the trauma itself still decayed this frame (accumulate/decay, just don't apply).
    expect(getSourceTrauma('ram')).toBeLessThan(before);
    expect(getSourceTrauma('ram')).toBeCloseTo(before - CAMERA.shake.decayPerSec * (1 / 60), 9);
  });

  it('applies the FOV kick (widen + updateProjectionMatrix) when reducedShake is OFF', () => {
    const cam = makeFakeCamera(60);
    updateCameraRig(cam as unknown as PerspectiveCamera, 1 / 60); // captures baseFov=60, no kick
    const updatesBefore = cam.projectionUpdates;

    armFovKick(100); // saturate the kick
    updateCameraRig(cam as unknown as PerspectiveCamera, 1 / 240);

    expect(cam.fov).toBeGreaterThan(60);
    expect(cam.projectionUpdates).toBeGreaterThan(updatesBefore);
  });

  it('zeroes the FOV kick when reducedShake is ON (lens stays at base)', () => {
    const cam = makeFakeCamera(60);
    updateCameraRig(cam as unknown as PerspectiveCamera, 1 / 60); // baseFov=60

    setReducedShake(true);
    armFovKick(100);
    updateCameraRig(cam as unknown as PerspectiveCamera, 1 / 240);

    expect(cam.fov).toBe(60);
  });

  it('suppresses the FOV kick during the death beat (clean cinematic, no jitter)', () => {
    const cam = makeFakeCamera(60);
    updateCameraRig(cam as unknown as PerspectiveCamera, 1 / 60); // frame 1: captures baseFov=60

    armFovKick(100); // a hard hit's kick is live going into the beat...
    setDeathPullback(true); // ...but the WRECKED/BUSTED lock window suppresses it.
    // (The pull-back itself moves the camera toward a new follow distance — that's the
    // intended cinematic — so we assert only that the JITTER-family effects are gone, via the
    // FOV, which the pull-back never touches, holding at base.)
    updateCameraRig(cam as unknown as PerspectiveCamera, 1 / 240);
    expect(cam.fov).toBe(60);
    expect(getDeathPullback()).toBe(true);
  });
});

describe('updateCameraRig — CAMERA.shake.enabled master kill-switch', () => {
  beforeEach(() => {
    resetCameraRig();
    playerVehicle.current = makeStubModel();
    setReducedShake(false);
    setShakeEnabled(false); // shipped default (feel-tuning pass) — explicit for clarity
  });

  afterEach(() => {
    playerVehicle.current = null;
    resetCameraRig();
    setReducedShake(false);
    setShakeEnabled(SHIPPED_SHAKE_ENABLED);
  });

  it('zeroes both the positional shake offset and the FOV kick when disabled, even with trauma banked', () => {
    const cam = makeFakeCamera(60);
    updateCameraRig(cam as unknown as PerspectiveCamera, 1 / 60); // frame 1: snap to rest, captures baseFov=60
    const rest = { x: cam.position.x, y: cam.position.y, z: cam.position.z };

    addShake(10, 'ram'); // banks positional trauma (ram bucket)...
    armFovKick(100); // ...and saturates the FOV-kick trauma.
    updateCameraRig(cam as unknown as PerspectiveCamera, 1 / 240);

    // Position is unchanged (no jitter applied)...
    expect(cam.position.x).toBeCloseTo(rest.x, 12);
    expect(cam.position.y).toBeCloseTo(rest.y, 12);
    expect(cam.position.z).toBeCloseTo(rest.z, 12);
    // ...and the lens holds at its base FOV (no kick applied)...
    expect(cam.fov).toBe(60);
    // ...but both trauma models keep accumulating/decaying underneath — the kill-switch only
    // gates the APPLICATION point, same accumulate/decay contract as reducedShake above.
    expect(getSourceTrauma('ram')).toBeGreaterThan(0);
    expect(getFovKick()).toBeGreaterThan(0);
  });

  it('re-enabling the switch applies shake again on the very next frame (fully reversible)', () => {
    const cam = makeFakeCamera(60);
    updateCameraRig(cam as unknown as PerspectiveCamera, 1 / 60); // frame 1: snap to rest
    const rest = { x: cam.position.x, y: cam.position.y, z: cam.position.z };

    addShake(10, 'ram');
    updateCameraRig(cam as unknown as PerspectiveCamera, 1 / 240); // disabled: no movement
    expect(cam.position.x).toBeCloseTo(rest.x, 12);

    setShakeEnabled(true);
    updateCameraRig(cam as unknown as PerspectiveCamera, 1 / 120); // re-enabled: jitter resumes

    const moved =
      Math.abs(cam.position.x - rest.x) + Math.abs(cam.position.y - rest.y) + Math.abs(cam.position.z - rest.z);
    expect(moved).toBeGreaterThan(0);
  });
});

// --- position constraint hook (Phase 34 clamp rework) ------------------------------------
// The PROD-ACTIVE seam world/toronto/TorontoScene.tsx registers the polygon camera clamp into.
// The behaviour that matters (and that the deleted priority-2 clamp pass could NOT provide) is
// FEEDBACK: the constrained point becomes the rig's lerp state, so the next frame damps FROM the
// clamped position instead of regenerating the unclamped one and fighting the clamp forever.
// Shake stays OFF for this whole block (shipped default) so camera.position IS smoothedCamPos and
// every assertion can be exact rather than approximate.
describe('updateCameraRig — position constraint hook', () => {
  beforeEach(() => {
    resetCameraRig();
    playerVehicle.current = makeStubModel();
    setCameraPosConstraint(null);
  });

  afterEach(() => {
    setCameraPosConstraint(null);
    playerVehicle.current = null;
    resetCameraRig();
  });

  it('is unregistered by default, and round-trips through the getter', () => {
    expect(getCameraPosConstraint()).toBeNull();
    const fn = (): void => {};
    setCameraPosConstraint(fn);
    expect(getCameraPosConstraint()).toBe(fn);
    setCameraPosConstraint(null);
    expect(getCameraPosConstraint()).toBeNull();
  });

  it('with no constraint, the rig solves exactly the pre-Phase-34 math (frame 1 snaps to the ideal)', () => {
    const cam = makeFakeCamera();
    updateCameraRig(cam as unknown as PerspectiveCamera, 1 / 60);
    const ideal = computeIdealCamPos(v3(), { x: 0, y: 0, z: 0 }, 0, 0);
    expect(cam.position.x).toBeCloseTo(ideal.x, 12);
    expect(cam.position.y).toBeCloseTo(ideal.y, 12);
    expect(cam.position.z).toBeCloseTo(ideal.z, 12);
  });

  it('a registered identity constraint changes nothing (bit-for-bit the unconstrained sequence)', () => {
    const cam = makeFakeCamera();
    const unconstrained: number[] = [];
    for (let i = 0; i < 5; i++) {
      updateCameraRig(cam as unknown as PerspectiveCamera, 1 / 60);
      unconstrained.push(cam.position.x, cam.position.y, cam.position.z);
    }

    resetCameraRig();
    const cam2 = makeFakeCamera();
    setCameraPosConstraint(() => {}); // touches nothing
    const constrained: number[] = [];
    for (let i = 0; i < 5; i++) {
      updateCameraRig(cam2 as unknown as PerspectiveCamera, 1 / 60);
      constrained.push(cam2.position.x, cam2.position.y, cam2.position.z);
    }

    expect(constrained).toEqual(unconstrained);
  });

  it('applies the constraint on the FIRST frame (the cold-start snap), not just from frame 2', () => {
    // A respawn/teleport beside a map edge snaps rather than lerps; an unconstrained snap would
    // paint exactly one frame of void before the damping path took over.
    const cam = makeFakeCamera();
    setCameraPosConstraint((pos) => {
      pos.y = 999;
    });
    updateCameraRig(cam as unknown as PerspectiveCamera, 1 / 60); // frame 1 = the snap
    expect(cam.position.y).toBe(999);
  });

  it('feeds the constrained position back into the lerp state (next frame damps FROM it)', () => {
    // THE regression this hook exists to prevent. The stub player never moves, so the ideal camera
    // position is constant; a constraint that pins x to a value well short of it means every frame
    // after the first must arrive having lerped from the PINNED x, not from the ideal.
    const cam = makeFakeCamera();
    const ideal = computeIdealCamPos(v3(), { x: 0, y: 0, z: 0 }, 0, 0);
    const PIN_X = ideal.x - 10;
    const incomingX: number[] = [];
    setCameraPosConstraint((pos) => {
      incomingX.push(pos.x); // what the rig solved BEFORE the constraint touched it
      if (pos.x > PIN_X) pos.x = PIN_X;
    });

    // Frame 1 calls the constraint TWICE — once on the cold-start snap, once after that frame's
    // damping step. Harmless by contract (the constraint must be idempotent) and deliberate: the
    // snap must never be left unconstrained for the lab modifier or the lerp to read.
    updateCameraRig(cam as unknown as PerspectiveCamera, 1 / 60);
    expect(incomingX).toHaveLength(2);
    expect(incomingX[0]).toBeCloseTo(ideal.x, 12); // the raw snap, before pinning
    // The damping step that follows started from the PINNED snap, so it lands a lerp-fraction of
    // the way back toward the ideal — not at the ideal itself.
    expect(incomingX[1]).toBeCloseTo(PIN_X + (ideal.x - PIN_X) * CAMERA.lerp, 9);
    expect(cam.position.x).toBeCloseTo(PIN_X, 12);

    updateCameraRig(cam as unknown as PerspectiveCamera, 1 / 60); // frame 2
    // Feedback: frame 2's solve is again lerp(PIN_X → ideal.x), i.e. strictly between the two.
    // WITHOUT feedback the rig would have re-solved from its own unclamped ideal and this would
    // read exactly ideal.x — that is the old two-passes-fighting behaviour, and it fails here.
    expect(incomingX[2]).toBeCloseTo(PIN_X + (ideal.x - PIN_X) * CAMERA.lerp, 9);
    expect(incomingX[2]).toBeGreaterThan(PIN_X);
    expect(incomingX[2]).toBeLessThan(ideal.x);
    // ...and the camera itself stays pinned, frame after frame (converged, not oscillating).
    expect(cam.position.x).toBeCloseTo(PIN_X, 12);
  });

  it('unregistering restores the unconstrained rig on the very next frame', () => {
    const cam = makeFakeCamera();
    const ideal = computeIdealCamPos(v3(), { x: 0, y: 0, z: 0 }, 0, 0);
    setCameraPosConstraint((pos) => {
      pos.x = 0;
    });
    updateCameraRig(cam as unknown as PerspectiveCamera, 1 / 60);
    expect(cam.position.x).toBe(0);

    setCameraPosConstraint(null);
    // Big dt → alpha ≈ 1 → the rig snaps back to its own ideal in one step, proving nothing of the
    // constraint survived in module state beyond the position it left behind.
    updateCameraRig(cam as unknown as PerspectiveCamera, 100);
    expect(cam.position.x).toBeCloseTo(ideal.x, 6);
  });

  it('leaves the shake offset OUTSIDE the constrained state (visual offset, never fed back)', () => {
    // Shake is applied after the constraint on purpose: a hard hit may jitter the lens a few cm
    // past the clamp for a frame, but it must never become part of the position the rig damps from.
    setShakeEnabled(true);
    try {
      const cam = makeFakeCamera();
      const pinned = { x: 1, y: 2, z: 3 };
      const incoming: Vec3[] = [];
      setCameraPosConstraint((pos) => {
        incoming.push({ x: pos.x, y: pos.y, z: pos.z });
        pos.x = pinned.x;
        pos.y = pinned.y;
        pos.z = pinned.z;
      });
      updateCameraRig(cam as unknown as PerspectiveCamera, 1 / 60); // frame 1: pin, no trauma yet
      addShake(10, 'ram');
      updateCameraRig(cam as unknown as PerspectiveCamera, 1 / 120); // frame 2: jitter applied on top

      // The lens moved off the pin (shake IS applied)...
      const jitter =
        Math.abs(cam.position.x - pinned.x) + Math.abs(cam.position.y - pinned.y) + Math.abs(cam.position.z - pinned.z);
      expect(jitter).toBeGreaterThan(0);
      // ...but frame 2's solve started from the clean pinned state, not from the jittered lens.
      // (incoming[0] = frame 1's snap, incoming[1] = frame 1's damping step, incoming[2] = frame 2.)
      const solvedFrom2 = incoming[2];
      const idealPos = computeIdealCamPos(v3(), { x: 0, y: 0, z: 0 }, 0, 0);
      expect(solvedFrom2.x).toBeCloseTo(pinned.x + (idealPos.x - pinned.x) * dampingAlpha(CAMERA.lerp, 1 / 120), 9);
    } finally {
      setShakeEnabled(SHIPPED_SHAKE_ENABLED);
    }
  });
});
