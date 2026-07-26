// Phase 33 camera lab — clip-counter accumulation rules. Tiny module, but the counters ARE the
// evidence the camera decision is made on, so their arithmetic is pinned rather than eyeballed in
// a console dump.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  readCameraClipStats,
  recordClampFired,
  recordOcclusionHits,
  resetCameraClipStats,
  sampleCameraClip,
} from './cameraClipStats';

beforeEach(() => {
  resetCameraClipStats();
});

describe('cameraClipStats', () => {
  it('starts (and resets) at all zeroes', () => {
    expect(readCameraClipStats()).toEqual({
      frames: 0,
      eyeInsideFrames: 0,
      nearPlaneFrames: 0,
      occludedFrames: 0,
      occlusionHitSum: 0,
      occlusionHitMax: 0,
      clampedFrames: 0,
      boresightBlockedFrames: 0,
      boresightHitSum: 0,
    });
  });

  it('sampleCameraClip advances the frame denominator on every call', () => {
    sampleCameraClip(false, false);
    sampleCameraClip(false, false);
    sampleCameraClip(false, false);
    const s = readCameraClipStats();
    expect(s.frames).toBe(3);
    expect(s.eyeInsideFrames).toBe(0);
    expect(s.nearPlaneFrames).toBe(0);
  });

  it('counts eye-inside and near-plane frames independently', () => {
    sampleCameraClip(true, false);
    sampleCameraClip(false, true);
    sampleCameraClip(true, true);
    const s = readCameraClipStats();
    expect(s.frames).toBe(3);
    expect(s.eyeInsideFrames).toBe(2);
    expect(s.nearPlaneFrames).toBe(2);
  });

  it('counts boresight cover only when a hit count is supplied and positive', () => {
    sampleCameraClip(false, false, null); // no car this frame — no boresight sample
    sampleCameraClip(false, false, 0); // car visible, boresight clear
    sampleCameraClip(false, false, 2);
    sampleCameraClip(false, false, 3);
    const s = readCameraClipStats();
    expect(s.frames).toBe(4);
    expect(s.boresightBlockedFrames).toBe(2);
    expect(s.boresightHitSum).toBe(5);
  });

  it('recordOcclusionHits sums, tracks the max, and ignores clear frames', () => {
    recordOcclusionHits(0); // clear — not an occluded frame
    recordOcclusionHits(2);
    recordOcclusionHits(5);
    recordOcclusionHits(1);
    const s = readCameraClipStats();
    expect(s.occludedFrames).toBe(3);
    expect(s.occlusionHitSum).toBe(8);
    expect(s.occlusionHitMax).toBe(5);
  });

  it('recordClampFired counts only the frames the clamp acted on', () => {
    recordClampFired();
    recordClampFired();
    expect(readCameraClipStats().clampedFrames).toBe(2);
  });

  it('reset zeroes every counter after a mixed run', () => {
    sampleCameraClip(true, true, 3);
    recordOcclusionHits(4);
    recordClampFired();
    expect(readCameraClipStats().frames).toBe(1);
    resetCameraClipStats();
    const s = readCameraClipStats();
    expect(s.frames + s.eyeInsideFrames + s.nearPlaneFrames).toBe(0);
    expect(s.occludedFrames + s.occlusionHitSum + s.occlusionHitMax + s.clampedFrames).toBe(0);
    expect(s.boresightBlockedFrames + s.boresightHitSum).toBe(0);
  });

  it('read() returns a plain snapshot, not a live view', () => {
    sampleCameraClip(true, false);
    const snap = readCameraClipStats();
    sampleCameraClip(true, false);
    expect(snap.frames).toBe(1);
    expect(readCameraClipStats().frames).toBe(2);
  });
});
