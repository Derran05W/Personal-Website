// Phase 42 — the flicker detector's camera-jitter seam (fx/cameraJitterRef.ts + the tail of
// fx/cameraRig.ts's updateCameraRig).
//
// The property under test is the one the whole detector rests on: the jitter must be a PURE
// TRANSLATION. Both the eye and the look target move by the same offset, so the view direction is
// bit-identical between a jittered and an un-jittered frame and the only difference in the rendered
// image is where the rasterization grid falls. If it moved only the eye, every frame would re-project
// (the whole image would "toggle") and the detector would measure nothing.
//
// Driven through updateCameraRig itself — the real seam, with the real rig state — rather than
// through a re-implementation, so a future refactor that drops the offset from either the position
// or the lookAt fails here. (The rig's read is DEV-gated, exactly like the Phase 39 polygonOffset
// instrument; vitest runs with import.meta.env.DEV true, which is the branch that ships to the dev
// server the sweep drives.)
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PerspectiveCamera } from 'three';
import { resetCameraRig, updateCameraRig } from './cameraRig';
import { cameraJitter } from './cameraJitterRef';
import { playerVehicle } from '../vehicles/playerRef';
import type { IVehicleModel, VehicleState } from '../vehicles/IVehicleModel';

/** Minimal PerspectiveCamera stand-in (cameraRig.test.ts's `makeFakeCamera`, plus a RECORDED
 * lookAt — that is the half of the pair this file exists to check). */
function makeFakeCamera(fov = 38) {
  return {
    fov,
    position: {
      x: 0,
      y: 0,
      z: 0,
      set(x: number, y: number, z: number) {
        this.x = x;
        this.y = y;
        this.z = z;
      },
    },
    look: { x: 0, y: 0, z: 0 },
    lookAt(x: number, y: number, z: number) {
      this.look = { x, y, z };
    },
    updateProjectionMatrix() {},
  };
}

/** Stationary stub car at the origin — a constant pose means the smoothed follow position is
 * constant, so any difference between two runs is exactly the jitter. */
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

/** One deterministic rig frame from a cold start (the snap frame — no accumulated lerp state). */
function coldFrame(): { pos: { x: number; y: number; z: number }; look: { x: number; y: number; z: number } } {
  resetCameraRig();
  const cam = makeFakeCamera();
  updateCameraRig(cam as unknown as PerspectiveCamera, 1 / 60);
  return { pos: { x: cam.position.x, y: cam.position.y, z: cam.position.z }, look: { ...cam.look } };
}

beforeEach(() => {
  playerVehicle.current = makeStubModel();
});

afterEach(() => {
  playerVehicle.current = null;
  cameraJitter.x = 0;
  cameraJitter.z = 0;
  resetCameraRig();
});

describe('cameraJitter ref', () => {
  it('is {0, 0} by default — the shipped/at-rest value, so production framing is untouched', () => {
    expect(cameraJitter.x).toBe(0);
    expect(cameraJitter.z).toBe(0);
  });
});

describe('updateCameraRig — jitter application', () => {
  it('offsets the eye AND the look target by exactly the same vector (pure translation)', () => {
    const base = coldFrame();

    cameraJitter.x = 0.05;
    cameraJitter.z = -0.03;
    const jittered = coldFrame();

    expect(jittered.pos.x - base.pos.x).toBeCloseTo(0.05, 10);
    expect(jittered.pos.y - base.pos.y).toBeCloseTo(0, 10); // ground-plane only
    expect(jittered.pos.z - base.pos.z).toBeCloseTo(-0.03, 10);

    expect(jittered.look.x - base.look.x).toBeCloseTo(0.05, 10);
    expect(jittered.look.y - base.look.y).toBeCloseTo(0, 10);
    expect(jittered.look.z - base.look.z).toBeCloseTo(-0.03, 10);
  });

  it('leaves the view DIRECTION bit-identical (eye→target vector unchanged)', () => {
    const base = coldFrame();
    cameraJitter.x = 0.05;
    cameraJitter.z = 0.05;
    const jittered = coldFrame();

    const dir = (f: typeof base) => ({
      x: f.look.x - f.pos.x,
      y: f.look.y - f.pos.y,
      z: f.look.z - f.pos.z,
    });
    const a = dir(base);
    const b = dir(jittered);
    expect(b.x).toBeCloseTo(a.x, 12);
    expect(b.y).toBeCloseTo(a.y, 12);
    expect(b.z).toBeCloseTo(a.z, 12);
  });

  it('is inert at {0, 0} — a frame with the ref untouched matches the pre-Phase-42 framing', () => {
    const a = coldFrame();
    const b = coldFrame();
    expect(b.pos).toEqual(a.pos);
    expect(b.look).toEqual(a.look);
  });

  it('does not feed back into the rig state — a jittered frame followed by a cleared one returns exactly to base', () => {
    const base = coldFrame();

    // Jitter for a frame, then clear it and keep stepping the SAME rig state (no reset): if the
    // offset had been folded into the smoothed lerp position it would persist here.
    cameraJitter.x = 0.5;
    cameraJitter.z = 0.5;
    const cam = makeFakeCamera();
    resetCameraRig();
    updateCameraRig(cam as unknown as PerspectiveCamera, 1 / 60);
    cameraJitter.x = 0;
    cameraJitter.z = 0;
    for (let i = 0; i < 5; i++) updateCameraRig(cam as unknown as PerspectiveCamera, 1 / 60);

    expect(cam.position.x).toBeCloseTo(base.pos.x, 10);
    expect(cam.position.y).toBeCloseTo(base.pos.y, 10);
    expect(cam.position.z).toBeCloseTo(base.pos.z, 10);
  });
});
