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
  sampleCameraReadability,
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
      readability: {
        frames: 0,
        onScreenPursuerSum: 0,
        onScreenPursuerMax: 0,
        sightings: 0,
        sightingDistanceSumM: 0,
        sightingDistanceMaxM: 0,
        cityCoverageSum: 0,
        cityBoxesInFrameSum: 0,
        cityBoxesTested: 0,
        groundBandFrames: 0,
        groundBandSumWu: 0,
        onScreenPursuerCount: null,
        pursuerWarningDistanceM: null,
        cityInFrameFraction: null,
        groundBandWu: null,
      },
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

// --- Phase 76 readability accumulation ---------------------------------------------------------
// The derived means are the numbers the contact sheet prints, so the division (and, more
// importantly, WHICH denominator each one divides by) is pinned here rather than re-derived in
// scripts/camera-lab.mjs.

const NO_PURSUERS = { onScreen: 0, sightings: 0, sightingDistanceSumM: 0, sightingDistanceMaxM: 0 };
const NO_CITY = { coverage: 0, boxesInFrame: 0, boxesTested: 0 };

describe('cameraClipStats — readability block', () => {
  it('has its own frame denominator, independent of the clip sampler', () => {
    sampleCameraClip(false, false);
    sampleCameraClip(false, false);
    sampleCameraClip(false, false);
    sampleCameraReadability(NO_PURSUERS, NO_CITY, null);
    const s = readCameraClipStats();
    expect(s.frames).toBe(3);
    expect(s.readability.frames).toBe(1);
  });

  it('means the on-screen pursuer count over sampled frames and keeps the worst frame', () => {
    sampleCameraReadability({ ...NO_PURSUERS, onScreen: 3 }, NO_CITY, null);
    sampleCameraReadability({ ...NO_PURSUERS, onScreen: 0 }, NO_CITY, null);
    sampleCameraReadability({ ...NO_PURSUERS, onScreen: 1 }, NO_CITY, null);
    const r = readCameraClipStats().readability;
    expect(r.onScreenPursuerSum).toBe(4);
    expect(r.onScreenPursuerMax).toBe(3);
    expect(r.onScreenPursuerCount).toBeCloseTo(4 / 3, 10);
  });

  it('divides the warning distance by SIGHTINGS, not by frames', () => {
    sampleCameraReadability(
      { onScreen: 2, sightings: 2, sightingDistanceSumM: 90, sightingDistanceMaxM: 60 },
      NO_CITY,
      null,
    );
    sampleCameraReadability({ ...NO_PURSUERS, onScreen: 2 }, NO_CITY, null);
    const r = readCameraClipStats().readability;
    expect(r.sightings).toBe(2);
    expect(r.pursuerWarningDistanceM).toBeCloseTo(45, 10);
    expect(r.sightingDistanceMaxM).toBeCloseTo(60, 10);
  });

  it('means city coverage over frames and keeps the index size as the sanity denominator', () => {
    sampleCameraReadability(
      NO_PURSUERS,
      { coverage: 0.5, boxesInFrame: 4, boxesTested: 2300 },
      null,
    );
    sampleCameraReadability(
      NO_PURSUERS,
      { coverage: 0.1, boxesInFrame: 1, boxesTested: 2300 },
      null,
    );
    const r = readCameraClipStats().readability;
    expect(r.cityInFrameFraction).toBeCloseTo(0.3, 10);
    expect(r.cityBoxesInFrameSum).toBe(5);
    expect(r.cityBoxesTested).toBe(2300);
  });

  it('excludes an unmeasurable ground band from its own denominator instead of counting a zero', () => {
    sampleCameraReadability(NO_PURSUERS, NO_CITY, 28);
    sampleCameraReadability(NO_PURSUERS, NO_CITY, null);
    sampleCameraReadability(NO_PURSUERS, NO_CITY, 22);
    const r = readCameraClipStats().readability;
    expect(r.frames).toBe(3);
    expect(r.groundBandFrames).toBe(2);
    expect(r.groundBandWu).toBeCloseTo(25, 10);
  });

  it('reports null — never a fake 0 — when a denominator is empty', () => {
    sampleCameraReadability(NO_PURSUERS, NO_CITY, null);
    const r = readCameraClipStats().readability;
    expect(r.onScreenPursuerCount).toBe(0); // frames > 0, so a real zero
    expect(r.pursuerWarningDistanceM).toBeNull(); // no sightings — nothing was measured
    expect(r.groundBandWu).toBeNull();
  });

  it('reset zeroes the readability block too', () => {
    sampleCameraReadability(
      { onScreen: 2, sightings: 1, sightingDistanceSumM: 40, sightingDistanceMaxM: 40 },
      { coverage: 0.4, boxesInFrame: 3, boxesTested: 10 },
      25,
    );
    resetCameraClipStats();
    expect(readCameraClipStats().readability).toEqual({
      frames: 0,
      onScreenPursuerSum: 0,
      onScreenPursuerMax: 0,
      sightings: 0,
      sightingDistanceSumM: 0,
      sightingDistanceMaxM: 0,
      cityCoverageSum: 0,
      cityBoxesInFrameSum: 0,
      cityBoxesTested: 0,
      groundBandFrames: 0,
      groundBandSumWu: 0,
      onScreenPursuerCount: null,
      pursuerWarningDistanceM: null,
      cityInFrameFraction: null,
      groundBandWu: null,
    });
  });

  it('leaves NO field un-reset, including one added after this test was written', () => {
    // The literal above is the exact pin; this is the rule behind it, written so that a counter
    // added to CameraReadabilityStats tomorrow is covered without anyone remembering to extend a
    // list. A single missed line in resetCameraClipStats() contaminates every window that follows
    // it in a battery run — the counters carry over, the frame denominator does not, and the
    // resulting rates are quietly wrong rather than obviously broken. So: poison every input the
    // accumulator takes, reset, then require that every field is either 0 (a counter) or null (a
    // derived mean with an empty denominator). Nothing else is a legal post-reset value.
    sampleCameraReadability(
      { onScreen: 7, sightings: 3, sightingDistanceSumM: 120, sightingDistanceMaxM: 55 },
      { coverage: 0.9, boxesInFrame: 41, boxesTested: 2300 },
      31,
    );
    resetCameraClipStats();
    const r = readCameraClipStats().readability;
    const entries = Object.entries(r);
    expect(entries.length).toBeGreaterThanOrEqual(15); // every field the interface declares today
    for (const [key, value] of entries) {
      expect({ key, cleared: value === 0 || value === null }).toEqual({ key, cleared: true });
    }
  });
});

describe('cameraClipStats — snapshot semantics', () => {
  it('read() returns a plain snapshot, not a live view', () => {
    sampleCameraClip(true, false);
    const snap = readCameraClipStats();
    sampleCameraClip(true, false);
    expect(snap.frames).toBe(1);
    expect(readCameraClipStats().frames).toBe(2);
  });
});
