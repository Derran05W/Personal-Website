// Phase 36 (T3) — tests for the camera anti-clip guard's pure solver.
//
// The guard is a LAST-RESORT safety net, which makes it exactly the kind of code that is never
// exercised in a normal session and therefore never noticed when it breaks. So the properties that
// make it safe are pinned here rather than eyeballed live: it is a no-op when clear (it must not
// cost or move anything in the 99.9% case), it lands the eye on the FIRST clear point (minimal
// intervention), it is idempotent (the rig applies it to its own output and calls it twice on the
// cold-start frame — a delta-shaped guard would compound without bound), its growth is rate-capped
// while its release is not (the rig's lerp owns the release), and it never produces a NaN.
import { describe, expect, it } from 'vitest';
import {
  applyAntiClip,
  createAntiClipState,
  rateLimitPull,
  solveAntiClipPull,
  type AntiClipConfig,
  type InsideTest,
} from './cameraAntiClip';
import { CAMERA } from '../../config/camera';

const CFG: AntiClipConfig = { marginWu: 0, maxPullM: 14, slewMPerSec: 30, probeStepM: 0.5 };
const FRAME_SEC = 1 / 60;

/** A solid slab occupying x ∈ [lo, hi] at any y/z — the simplest thing that reads as "a wall the
 * eye is inside of" while keeping the arithmetic exact. */
function slab(lo: number, hi: number): InsideTest {
  return (x) => x >= lo && x <= hi;
}

const NOTHING: InsideTest = () => false;
const EVERYTHING: InsideTest = () => true;

describe('solveAntiClipPull — the minimal clear fraction', () => {
  it('is exactly 0 when the eye is already clear (the 99.9% case, one point query)', () => {
    let calls = 0;
    const inside: InsideTest = (x, y, z) => {
      calls++;
      return NOTHING(x, y, z);
    };
    expect(solveAntiClipPull({ x: 20, y: 22, z: 20 }, { x: 0, y: 0, z: 0 }, inside, CFG)).toBe(0);
    expect(calls).toBe(1); // the eye test itself, and no sampling loop
  });

  it('pulls to the FIRST clear sample, not further (minimal intervention)', () => {
    // Eye at x=10 inside a slab that ends at x=8; the car is at the origin, so the boresight runs
    // straight down −x and the first clear sample is 2 m in (probeStep 0.5 → sample 4).
    const pull = solveAntiClipPull({ x: 10, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, slab(8, 12), CFG);
    expect(pull).toBeCloseTo(2.5, 10); // first sample strictly outside the slab: 10 − 2.5 = 7.5
  });

  it('lands the eye somewhere the test reports CLEAR (the idempotence precondition)', () => {
    const inside = slab(8, 12);
    const eye = { x: 10, y: 0, z: 0 };
    const pull = solveAntiClipPull(eye, { x: 0, y: 0, z: 0 }, inside, CFG);
    expect(inside(eye.x - pull, 0, 0)).toBe(false);
  });

  it('gives up (returns 0) rather than pulling into geometry it cannot escape', () => {
    // No point within maxPullM is clear → moving would leave the eye inside, which would make the
    // next call pull AGAIN. Returning 0 keeps the guard idempotent; the fade path covers this frame.
    expect(solveAntiClipPull({ x: 10, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, EVERYTHING, CFG)).toBe(0);
  });

  it('never pulls past the car (the cap is min(maxPullM, boresight length))', () => {
    // Car 3 m away, everything solid: the search cap is the 3 m boresight, and since even the cap
    // point is inside, the answer is 0 — but crucially nothing ever sampled beyond the car.
    const seen: number[] = [];
    const inside: InsideTest = (x) => {
      seen.push(x);
      return true;
    };
    solveAntiClipPull({ x: 3, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, inside, CFG);
    expect(Math.min(...seen)).toBeGreaterThanOrEqual(0);
  });

  it('is a no-op (never NaN) when the eye sits exactly on the car', () => {
    const at = { x: 5, y: 1, z: -2 };
    const pull = solveAntiClipPull(at, { ...at }, EVERYTHING, CFG);
    expect(pull).toBe(0);
    expect(Number.isNaN(pull)).toBe(false);
  });

  it('honours the clearance margin through the injected test', () => {
    // The live path passes pointInsideAny(..., marginWu); here the margin is baked into the test to
    // prove the solver simply believes it: a fatter wall means a longer pull.
    const thin = solveAntiClipPull({ x: 10, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, slab(9, 12), CFG);
    const fat = solveAntiClipPull({ x: 10, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, slab(6, 12), CFG);
    expect(fat).toBeGreaterThan(thin);
  });
});

describe('rateLimitPull — growth capped, release free', () => {
  it('caps GROWTH at slewMPerSec × dt', () => {
    expect(rateLimitPull(14, 0, FRAME_SEC, CFG)).toBeCloseTo(30 / 60, 10);
    expect(rateLimitPull(14, 0.5, FRAME_SEC, CFG)).toBeCloseTo(1, 10);
  });

  it('does NOT cap the release — a solved 0 is applied immediately', () => {
    // The visible smoothness of the release is the rig's own position lerp; a second rate limit
    // here would be two springs fighting (Phase 33's preset D died of exactly that).
    expect(rateLimitPull(0, 12, FRAME_SEC, CFG)).toBe(0);
  });

  it('never exceeds maxPullM however long the ramp runs', () => {
    let pull = 0;
    for (let i = 0; i < 600; i++) pull = rateLimitPull(1e6, pull, FRAME_SEC, CFG);
    expect(pull).toBe(CFG.maxPullM);
  });

  it('converges to the solved pull and then holds it (no oscillation)', () => {
    let pull = 0;
    for (let i = 0; i < 120; i++) pull = rateLimitPull(3, pull, FRAME_SEC, CFG);
    expect(pull).toBeCloseTo(3, 10);
    expect(rateLimitPull(3, pull, FRAME_SEC, CFG)).toBeCloseTo(3, 10);
  });
});

describe('applyAntiClip — the frame step', () => {
  it('moves nothing and reports 0 when the eye is clear', () => {
    const eye = { x: 20, y: 22, z: 20 };
    const state = createAntiClipState();
    const pull = applyAntiClip(eye, { x: 0, y: 0, z: 0 }, NOTHING, state, 1000, CFG);
    expect(pull).toBe(0);
    expect(eye).toEqual({ x: 20, y: 22, z: 20 });
  });

  it('snaps on the COLD START (no previous frame to be smooth against)', () => {
    const eye = { x: 10, y: 0, z: 0 };
    const state = createAntiClipState(); // lastMs 0 = cold start
    const pull = applyAntiClip(eye, { x: 0, y: 0, z: 0 }, slab(8, 12), state, 1000, CFG);
    expect(pull).toBeCloseTo(2.5, 10);
    expect(eye.x).toBeCloseTo(7.5, 10);
  });

  it('is IDEMPOTENT on the rig’s cold-start double call', () => {
    // fx/cameraRig.ts calls the seam twice on the frame it snaps (once on the snap, once after the
    // damping step). A delta-shaped guard would move the eye twice; this one solves 0 the second
    // time because the first call already left it clear.
    const eye = { x: 10, y: 0, z: 0 };
    const state = createAntiClipState();
    applyAntiClip(eye, { x: 0, y: 0, z: 0 }, slab(8, 12), state, 1000, CFG);
    const afterFirst = { ...eye };
    const second = applyAntiClip(eye, { x: 0, y: 0, z: 0 }, slab(8, 12), state, 1000, CFG);
    expect(second).toBe(0);
    expect(eye).toEqual(afterFirst);
  });

  it('ramps in over subsequent frames at the slew cap, then holds', () => {
    const state = createAntiClipState();
    const inside = slab(0.5, 12); // a deep wall: the raw solve (11.5 m) is far past one frame's slew
    let nowMs = 1000;
    // Warm the clock without a cold-start snap: first call happens while the eye is clear.
    applyAntiClip({ x: 20, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, NOTHING, state, nowMs, CFG);
    const pulls: number[] = [];
    for (let i = 0; i < 4; i++) {
      nowMs += 1000 / 60;
      const eye = { x: 11.9, y: 0, z: 0 };
      pulls.push(applyAntiClip(eye, { x: 0, y: 0, z: 0 }, inside, state, nowMs, CFG));
    }
    expect(pulls[0]).toBeCloseTo(30 / 60, 6);
    expect(pulls[1]).toBeCloseTo(2 * (30 / 60), 6);
    expect(pulls[3]).toBeGreaterThan(pulls[0]!);
    expect(pulls[3]).toBeLessThanOrEqual(CFG.maxPullM);
  });

  it('pulls along the boresight, so the car stays exactly on the view axis', () => {
    // A diagonal eye: the pulled position must remain colinear with (car → eye).
    const car = { x: 0, y: 0, z: 0 };
    const eye = { x: 6, y: 8, z: 0 }; // 10 m out
    const state = createAntiClipState();
    applyAntiClip(eye, car, slab(4, 12), state, 1000, CFG);
    expect(eye.x / eye.y).toBeCloseTo(6 / 8, 10);
    expect(eye.z).toBe(0);
    expect(Math.hypot(eye.x, eye.y)).toBeLessThan(10);
  });

  it('never NaNs when the eye coincides with the car', () => {
    const eye = { x: 5, y: 1, z: -2 };
    const state = createAntiClipState();
    const pull = applyAntiClip(eye, { x: 5, y: 1, z: -2 }, EVERYTHING, state, 1000, CFG);
    expect(pull).toBe(0);
    expect(Number.isFinite(eye.x) && Number.isFinite(eye.y) && Number.isFinite(eye.z)).toBe(true);
  });
});

describe('the shipped config leaves', () => {
  it('cap the pull well inside the follow distance (the car never ends up under the lens)', () => {
    expect(CAMERA.antiClip.maxPullM).toBeGreaterThan(0);
    expect(CAMERA.antiClip.maxPullM).toBeLessThan(CAMERA.baseDist);
  });

  it('sample finer than any indexed building, so the search cannot step over a whole volume', () => {
    expect(CAMERA.antiClip.probeStepM).toBeGreaterThan(0);
    expect(CAMERA.antiClip.probeStepM).toBeLessThanOrEqual(1);
  });

  it('trip slightly EARLY (a lens flush with a facade already looks broken)', () => {
    expect(CAMERA.antiClip.marginWu).toBeGreaterThan(0);
  });
});
