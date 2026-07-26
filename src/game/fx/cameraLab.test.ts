// Phase 33 camera lab — the preset table, the live-apply path, the rig modifier hook and preset
// D's spring arm.
//
// Two of these describe blocks are load-bearing beyond this phase:
//   • the per-preset rest-geometry pins (eye height + horizontal radius from the spherical math)
//     are the numbers the USER GATE compares, and Phase 34 seeds its §5.3 law test from whichever
//     row wins;
//   • "a null modifier is today's rig, bit-for-bit" is the guarantee that everything here can
//     exist without touching a shipped frame.
// fx/cameraRig.test.ts's 69 existing cases are deliberately untouched — the modifier hook is
// exercised here, in the lab's own file, so the rig suite stays exactly as it was.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PerspectiveCamera } from 'three';
import { CAMERA, CAMERA_PRESETS } from '../config/camera';
import {
  applyCameraPreset,
  createSpringArmState,
  findCameraPreset,
  getCameraPreset,
  getSpringArmState,
  presetRestGeometry,
  probeNearField,
  resetSpringArm,
  springArmOf,
  stepSpringArm,
} from './cameraLab';
import {
  getCameraRigModifier,
  resetBaseFov,
  resetCameraRig,
  setCameraRigModifier,
  setDeathCause,
  setDeathPullback,
  updateCameraRig,
} from './cameraRig';
import { clearClipIndex, setClipIndex, type ClipAabb } from '../world/toronto/cameraClipIndex';
import { playerVehicle } from '../vehicles/playerRef';
import type { IVehicleModel, VehicleState } from '../vehicles/IVehicleModel';

// The shipped rig, captured BEFORE any test applies a preset — both the reference preset A is
// pinned against and the state every test restores (CAMERA is a runtime-mutable block).
const SHIPPED = {
  yawDeg: CAMERA.yawDeg,
  pitchDeg: CAMERA.pitchDeg,
  baseDist: CAMERA.baseDist,
  fov: CAMERA.fov,
} as const;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function restoreShippedCamera(): void {
  const block = CAMERA as object as Mutable<Record<string, number>>;
  block.yawDeg = SHIPPED.yawDeg;
  block.pitchDeg = SHIPPED.pitchDeg;
  block.baseDist = SHIPPED.baseDist;
  block.fov = SHIPPED.fov;
}

/** Minimal PerspectiveCamera stand-in — the same surface updateCameraRig touches, mirroring
 * fx/cameraRig.test.ts's fake (position.set / lookAt / fov / updateProjectionMatrix). */
function makeFakeCamera(fov: number = SHIPPED.fov) {
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

type FakeCamera = ReturnType<typeof makeFakeCamera>;
const asCamera = (cam: FakeCamera): PerspectiveCamera => cam as unknown as PerspectiveCamera;

/** A stationary stub vehicle at the origin: the rig's ideal is then a pure spherical offset, so a
 * converged camera position is directly comparable against the geometry under test. */
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

/** Run the rig to convergence (the damping is exponential; 600 frames at 60 fps leaves ~1e-22 of
 * the initial error) and return the settled camera position. */
function converge(cam: FakeCamera, frames = 600): { x: number; y: number; z: number } {
  for (let i = 0; i < frames; i++) updateCameraRig(asCamera(cam), 1 / 60);
  return { x: cam.position.x, y: cam.position.y, z: cam.position.z };
}

const box = (minX: number, maxX: number, minZ: number, maxZ: number, maxY = 40): ClipAabb => ({
  minX,
  maxX,
  minY: 0,
  maxY,
  minZ,
  maxZ,
});

afterEach(() => {
  setCameraRigModifier(null);
  resetSpringArm();
  clearClipIndex();
  restoreShippedCamera();
  resetBaseFov();
  resetCameraRig();
  playerVehicle.current = null;
  // E is the shipped rig (Phase 34 adoption) — restoring the ACTIVE PRESET ID to 'A' here would
  // leave every test's afterEach state lying about which rig a fresh session reports. The
  // subsequent restoreShippedCamera() is technically redundant against E (applying E already
  // writes the exact SHIPPED numbers), but it's kept as the belt-and-suspenders reset it always
  // was — cheap, and it stops mattering if a future preset ever stops being field-identical.
  applyCameraPreset('E', null); // active id back to the shipped rig
  restoreShippedCamera();
});

// --- the table ---------------------------------------------------------------------------------

describe('CAMERA_PRESETS — table invariants', () => {
  it('holds exactly the five lab candidates, with unique ids', () => {
    expect(CAMERA_PRESETS.map((p) => p.id)).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(new Set(CAMERA_PRESETS.map((p) => p.id)).size).toBe(CAMERA_PRESETS.length);
  });

  // Phase 34 moved this invariant off A (the pre-adoption rig, kept as the comparison control)
  // and onto the winning candidate: an identity test that doesn't point at the TRUE shipped rig
  // makes a fresh dev session lie about what it is running.
  it('preset E IS the shipped camera, field for field (the identity invariant)', () => {
    const e = findCameraPreset('E');
    expect(e).not.toBeNull();
    expect({ yawDeg: e?.yawDeg, pitchDeg: e?.pitchDeg, baseDist: e?.baseDist, fov: e?.fov }).toEqual(SHIPPED);
  });

  it('every preset is a physically sane rig', () => {
    for (const p of CAMERA_PRESETS) {
      expect(p.pitchDeg, p.id).toBeGreaterThan(0);
      expect(p.pitchDeg, p.id).toBeLessThan(90);
      expect(p.baseDist, p.id).toBeGreaterThan(0);
      expect(p.fov, p.id).toBeGreaterThan(10);
      expect(p.fov, p.id).toBeLessThan(120);
      expect(p.label.length, p.id).toBeGreaterThan(0);
    }
  });

  it('keeps ONE bearing across the table (the lab varies pitch/distance/lens, not yaw)', () => {
    for (const p of CAMERA_PRESETS) expect(p.yawDeg, p.id).toBe(SHIPPED.yawDeg);
  });

  it('only the canyon-aware candidate declares a spring arm, and its caps are usable', () => {
    for (const p of CAMERA_PRESETS) {
      expect(springArmOf(p) !== undefined, p.id).toBe(p.id === 'D');
    }
    const arm = springArmOf(CAMERA_PRESETS[3]);
    expect(arm?.maxPitchLiftDeg).toBeGreaterThan(0);
    expect(arm?.maxPullInM).toBeGreaterThan(0);
    expect(arm?.easeSec).toBeGreaterThan(0);
    expect(arm?.clearHoldSec).toBeGreaterThan(0);
    expect(arm?.probeAheadM).toBeGreaterThan(0);
  });

  // THE GATE NUMBERS: eye height = baseDist·sin(pitch), horizontal radius = baseDist·cos(pitch),
  // at rest (no speed zoom, no tier zoom, no death beat). Pinned to 2 dp so a retune during the
  // lab loop is a deliberate edit here, not a silent drift — Phase 34 promotes the winning row.
  const REST_GEOMETRY: readonly (readonly [string, number, number])[] = [
    ['A', 18.39, 15.43],
    ['B', 23.75, 14.84],
    ['C', 26.81, 22.5],
    ['D', 18.39, 15.43],
    ['E', 22.05, 13.78], // re-pinned with the corridor-airspace tune (58/26 — see config comment)
  ];

  for (const [id, eyeHeight, horizontalRadius] of REST_GEOMETRY) {
    it(`preset ${id} rests at eye ${eyeHeight} wu / radius ${horizontalRadius} wu`, () => {
      const preset = findCameraPreset(id);
      expect(preset).not.toBeNull();
      const geom = presetRestGeometry(preset!);
      expect(geom.eyeHeight).toBeCloseTo(eyeHeight, 2);
      expect(geom.horizontalRadius).toBeCloseTo(horizontalRadius, 2);
    });
  }

  it('the candidates that exist to clear the ~19.4 wu pack streetwall actually do', () => {
    for (const id of ['B', 'C', 'E']) {
      expect(presetRestGeometry(findCameraPreset(id)!).eyeHeight, id).toBeGreaterThan(19.4);
    }
    // ...and the control deliberately does not — that IS the problem being measured.
    expect(presetRestGeometry(findCameraPreset('A')!).eyeHeight).toBeLessThan(19.4);
  });
});

// --- applying a preset -------------------------------------------------------------------------

describe('applyCameraPreset', () => {
  it('defaults to reporting the shipped rig', () => {
    expect(getCameraPreset()).toBe('E');
  });

  it('writes the four geometry leaves into the runtime CAMERA block', () => {
    const cam = makeFakeCamera();
    expect(applyCameraPreset('B', asCamera(cam))).toBe(true);
    const b = findCameraPreset('B')!;
    expect(CAMERA.yawDeg).toBe(b.yawDeg);
    expect(CAMERA.pitchDeg).toBe(b.pitchDeg);
    expect(CAMERA.baseDist).toBe(b.baseDist);
    expect(CAMERA.fov).toBe(b.fov);
    expect(getCameraPreset()).toBe('B');
  });

  it('pushes the FOV onto the live camera and rebuilds its projection', () => {
    const cam = makeFakeCamera();
    const updatesBefore = cam.projectionUpdates;
    applyCameraPreset('C', asCamera(cam));
    expect(cam.fov).toBe(findCameraPreset('C')!.fov);
    expect(cam.projectionUpdates).toBe(updatesBefore + 1);
  });

  it('rejects an unknown id without touching anything', () => {
    expect(applyCameraPreset('Z', null)).toBe(false);
    expect(getCameraPreset()).toBe('E');
    expect(CAMERA.baseDist).toBe(SHIPPED.baseDist);
  });

  it('applies the config side even without a live camera (only the lens needs the instance)', () => {
    expect(applyCameraPreset('E', null)).toBe(true);
    expect(CAMERA.pitchDeg).toBe(findCameraPreset('E')!.pitchDeg);
    expect(CAMERA.fov).toBe(findCameraPreset('E')!.fov);
  });

  it('arms the spring arm for D and disarms it for every other preset', () => {
    expect(getCameraRigModifier()).toBeNull();
    applyCameraPreset('D', null);
    expect(getCameraRigModifier()).not.toBeNull();
    applyCameraPreset('A', null);
    expect(getCameraRigModifier()).toBeNull();
  });

  it('round-trips back to the shipped rig when E is re-applied', () => {
    applyCameraPreset('C', null);
    applyCameraPreset('E', null);
    expect({
      yawDeg: CAMERA.yawDeg,
      pitchDeg: CAMERA.pitchDeg,
      baseDist: CAMERA.baseDist,
      fov: CAMERA.fov,
    }).toEqual(SHIPPED);
  });
});

// --- the FOV-kick base latch --------------------------------------------------------------------

describe('resetBaseFov (FOV latch relatching)', () => {
  beforeEach(() => {
    resetCameraRig();
    resetBaseFov();
    playerVehicle.current = makeStubModel();
  });

  it('WITHOUT a relatch, the rig stomps an external FOV write back to the latched base', () => {
    const cam = makeFakeCamera(45);
    updateCameraRig(asCamera(cam), 1 / 60); // latches base = 45
    cam.fov = 31; // an external write, exactly what a naive preset switch would do
    updateCameraRig(asCamera(cam), 1 / 60);
    expect(cam.fov).toBe(45);
  });

  it('relatching lets the new lens stand', () => {
    const cam = makeFakeCamera(45);
    updateCameraRig(asCamera(cam), 1 / 60);
    cam.fov = 31;
    resetBaseFov();
    updateCameraRig(asCamera(cam), 1 / 60);
    expect(cam.fov).toBe(31);
  });

  it('applyCameraPreset relatches for you — a mid-session switch holds its FOV', () => {
    const cam = makeFakeCamera(SHIPPED.fov);
    updateCameraRig(asCamera(cam), 1 / 60);
    applyCameraPreset('C', asCamera(cam));
    const expected = findCameraPreset('C')!.fov;
    for (let i = 0; i < 10; i++) updateCameraRig(asCamera(cam), 1 / 60);
    expect(cam.fov).toBe(expected);
  });
});

// --- the rig modifier hook ----------------------------------------------------------------------

describe('camera rig modifier — composition', () => {
  beforeEach(() => {
    resetCameraRig();
    playerVehicle.current = makeStubModel();
  });

  it('is null by default (production never registers one)', () => {
    expect(getCameraRigModifier()).toBeNull();
  });

  it('with no modifier, the rig settles at exactly baseDist / baseDist·sin(pitch)', () => {
    const settled = converge(makeFakeCamera());
    expect(Math.hypot(settled.x, settled.y, settled.z)).toBeCloseTo(CAMERA.baseDist, 6);
    expect(settled.y).toBeCloseTo(CAMERA.baseDist * Math.sin((CAMERA.pitchDeg * Math.PI) / 180), 6);
  });

  it('a zero-offset modifier is bit-for-bit identical to no modifier at all', () => {
    const bare = makeFakeCamera();
    const frames: number[] = [];
    for (let i = 0; i < 50; i++) {
      updateCameraRig(asCamera(bare), 1 / 60);
      frames.push(bare.position.x, bare.position.y, bare.position.z);
    }

    resetCameraRig();
    setCameraRigModifier(() => ({ pitchOffsetDeg: 0, distOffset: 0 }));
    const hooked = makeFakeCamera();
    const hookedFrames: number[] = [];
    for (let i = 0; i < 50; i++) {
      updateCameraRig(asCamera(hooked), 1 / 60);
      hookedFrames.push(hooked.position.x, hooked.position.y, hooked.position.z);
    }
    expect(hookedFrames).toEqual(frames);
  });

  it('distOffset moves the settled follow distance by exactly that many metres', () => {
    setCameraRigModifier(() => ({ pitchOffsetDeg: 0, distOffset: -6 }));
    const settled = converge(makeFakeCamera());
    expect(Math.hypot(settled.x, settled.y, settled.z)).toBeCloseTo(CAMERA.baseDist - 6, 6);
  });

  it('pitchOffsetDeg lifts the settled eye by exactly that many degrees', () => {
    setCameraRigModifier(() => ({ pitchOffsetDeg: 10, distOffset: 0 }));
    const settled = converge(makeFakeCamera());
    expect(settled.y).toBeCloseTo(CAMERA.baseDist * Math.sin(((CAMERA.pitchDeg + 10) * Math.PI) / 180), 6);
  });

  it('is called once per frame with the live player/camera state', () => {
    let calls = 0;
    let lastDt = 0;
    let firstCamY = 0;
    let firstPlayerY = Number.NaN;
    setCameraRigModifier((ctx) => {
      if (calls === 0) {
        firstCamY = ctx.camPos.y;
        firstPlayerY = ctx.playerPos.y;
      }
      calls++;
      lastDt = ctx.dt;
      return { pitchOffsetDeg: 0, distOffset: 0 };
    });
    updateCameraRig(asCamera(makeFakeCamera()), 1 / 30);
    updateCameraRig(asCamera(makeFakeCamera()), 1 / 30);
    expect(calls).toBe(2);
    expect(lastDt).toBeCloseTo(1 / 30, 12);
    // Called AFTER the cold-start snap, so camPos is already a real lens position (the stub car
    // sits at the origin, so this is the rest eye height) rather than an uninitialised zero.
    expect(firstCamY).toBeCloseTo(CAMERA.baseDist * Math.sin((CAMERA.pitchDeg * Math.PI) / 180), 6);
    expect(firstPlayerY).toBe(0);
  });

  it('composes ADDITIVELY with the death beat instead of replacing it', () => {
    setDeathPullback(true);
    setDeathCause('wrecked');
    setCameraRigModifier(() => ({ pitchOffsetDeg: 5, distOffset: -3 }));
    const settled = converge(makeFakeCamera());
    const expectedDist = CAMERA.baseDist + CAMERA.deathPullback - 3;
    const expectedPitch = CAMERA.pitchDeg + CAMERA.cinematic.wreckedPitchOffsetDeg + 5;
    expect(Math.hypot(settled.x, settled.y, settled.z)).toBeCloseTo(expectedDist, 6);
    expect(settled.y).toBeCloseTo(expectedDist * Math.sin((expectedPitch * Math.PI) / 180), 6);
    setDeathPullback(false);
  });

  it('clearing the modifier restores the stock framing on the next frame', () => {
    setCameraRigModifier(() => ({ pitchOffsetDeg: 0, distOffset: -6 }));
    converge(makeFakeCamera(), 120);
    setCameraRigModifier(null);
    const settled = converge(makeFakeCamera());
    expect(Math.hypot(settled.x, settled.y, settled.z)).toBeCloseTo(CAMERA.baseDist, 6);
  });
});

// --- the spring arm ------------------------------------------------------------------------------

describe('spring arm — pure easing core', () => {
  const cfg = { maxPitchLiftDeg: 12, maxPullInM: 6, easeSec: 0.25, clearHoldSec: 0.3, probeAheadM: 8 };

  it('starts fully released', () => {
    expect(createSpringArmState()).toEqual({ lift: 0, pull: 0, clearSec: 0 });
  });

  it('rises toward the caps at the rate limit (cap ÷ easeSec per second)', () => {
    const s = createSpringArmState();
    stepSpringArm(s, true, cfg.easeSec / 2, cfg);
    expect(s.lift).toBeCloseTo(cfg.maxPitchLiftDeg / 2, 9);
    expect(s.pull).toBeCloseTo(cfg.maxPullInM / 2, 9);
  });

  it('reaches — and never exceeds — the caps', () => {
    const s = createSpringArmState();
    for (let i = 0; i < 100; i++) stepSpringArm(s, true, 1 / 60, cfg);
    expect(s.lift).toBe(cfg.maxPitchLiftDeg);
    expect(s.pull).toBe(cfg.maxPullInM);
  });

  it('a full engage takes easeSec regardless of dt granularity', () => {
    const coarse = createSpringArmState();
    stepSpringArm(coarse, true, cfg.easeSec, cfg);
    const fine = createSpringArmState();
    for (let i = 0; i < 15; i++) stepSpringArm(fine, true, cfg.easeSec / 15, cfg);
    expect(coarse.lift).toBeCloseTo(fine.lift, 9);
    expect(fine.lift).toBeCloseTo(cfg.maxPitchLiftDeg, 9);
  });

  it('HOLDS through a clear gap shorter than clearHoldSec (grazing a corner must not strobe)', () => {
    const s = createSpringArmState();
    for (let i = 0; i < 30; i++) stepSpringArm(s, true, 1 / 60, cfg); // engaged, at cap
    expect(s.lift).toBe(cfg.maxPitchLiftDeg);
    // 0.25 s of clear — under the 0.3 s hold, so the arm must not move at all.
    for (let i = 0; i < 15; i++) stepSpringArm(s, false, 1 / 60, cfg);
    expect(s.clearSec).toBeCloseTo(0.25, 9);
    expect(s.lift).toBe(cfg.maxPitchLiftDeg);
    expect(s.pull).toBe(cfg.maxPullInM);
  });

  it('releases once the clear streak outlasts clearHoldSec', () => {
    const s = createSpringArmState();
    for (let i = 0; i < 30; i++) stepSpringArm(s, true, 1 / 60, cfg);
    for (let i = 0; i < 60; i++) stepSpringArm(s, false, 1 / 60, cfg); // 1 s clear
    expect(s.lift).toBe(0);
    expect(s.pull).toBe(0);
  });

  it('a single blocked frame restarts the hold clock', () => {
    const s = createSpringArmState();
    for (let i = 0; i < 15; i++) stepSpringArm(s, false, 1 / 60, cfg);
    expect(s.clearSec).toBeCloseTo(0.25, 9);
    stepSpringArm(s, true, 1 / 60, cfg);
    expect(s.clearSec).toBe(0);
  });

  it('treats easeSec = 0 as an instant snap rather than dividing by zero', () => {
    const s = createSpringArmState();
    stepSpringArm(s, true, 1 / 60, { ...cfg, easeSec: 0 });
    expect(s.lift).toBe(cfg.maxPitchLiftDeg);
    expect(Number.isFinite(s.pull)).toBe(true);
  });
});

describe('spring arm — near-field probe', () => {
  const cfg = { maxPitchLiftDeg: 12, maxPullInM: 6, easeSec: 0.25, clearHoldSec: 0.3, probeAheadM: 8 };
  const eye = { x: 0, y: 10, z: 0 };
  const car = { x: 30, y: 0.5, z: 0 };

  it('reads clear with nothing indexed', () => {
    clearClipIndex();
    expect(probeNearField(eye, car, cfg)).toBe(false);
  });

  it('reads blocked when the eye is INSIDE building volume', () => {
    setClipIndex([box(-5, 5, -5, 5)]);
    expect(probeNearField(eye, car, cfg)).toBe(true);
  });

  it('reads blocked for an occluder inside the probe reach', () => {
    setClipIndex([box(3, 6, -5, 5)]);
    expect(probeNearField(eye, car, cfg)).toBe(true);
  });

  it('reads CLEAR for an occluder on the boresight but beyond the probe reach', () => {
    // A building 15 m out still hides the car — but the arm is a near-field response, not a
    // line-of-sight one: reacting to the whole segment would leave it permanently engaged in a
    // solid streetwall.
    setClipIndex([box(15, 20, -5, 5)]);
    expect(probeNearField(eye, car, cfg)).toBe(false);
  });

  it('reads clear for an occluder off to the side of the boresight', () => {
    setClipIndex([box(3, 6, 20, 30)]);
    expect(probeNearField(eye, car, cfg)).toBe(false);
  });

  it('reads clear (and never NaNs) when the camera is on top of the car', () => {
    setClipIndex([box(3, 6, -5, 5)]);
    expect(probeNearField(car, car, cfg)).toBe(false);
  });

  it('drives the live modifier: preset D lifts and pulls in inside a canyon', () => {
    playerVehicle.current = makeStubModel(); // car at the origin
    resetCameraRig();
    applyCameraPreset('D', null);
    // A slab wrapping the whole settled camera position — the eye is inside it from frame one.
    setClipIndex([box(-60, 60, -60, 60, 60)]);
    const settled = converge(makeFakeCamera());
    const arm = springArmOf(findCameraPreset('D')!)!;
    const expectedDist = CAMERA.baseDist - arm.maxPullInM;
    const expectedPitch = CAMERA.pitchDeg + arm.maxPitchLiftDeg;
    expect(getSpringArmState()).toEqual({ lift: arm.maxPitchLiftDeg, pull: arm.maxPullInM, clearSec: 0 });
    expect(Math.hypot(settled.x, settled.y, settled.z)).toBeCloseTo(expectedDist, 6);
    expect(settled.y).toBeCloseTo(expectedDist * Math.sin((expectedPitch * Math.PI) / 180), 6);
  });
});
