// Tests for the Phase 25 occlusion-fade controller (TORONTO-MAP-SPEC-v2.md Addendum A.5:
// "car is never fully hidden: meshes on the camera→car ray fade to ≤0.4 alpha within 150 ms").
// The pure fade state machine is tested here at a 60-fps step; the actual camera→car raycast +
// material application is a live-only concern (verified in TorontoScene by screenshot).
import { describe, expect, it } from 'vitest';
import {
  FADE_MIN,
  FADE_MAX,
  needsTransparent,
  OcclusionFader,
  stepFadeOpacity,
} from './occlusionFade';

const FRAME_MS = 1000 / 60; // ~16.67 ms

describe('stepFadeOpacity — pure lerp toward the occluded/clear target', () => {
  it('an occluded surface reaches ≤ 0.4 alpha within 150 ms at 60 fps', () => {
    let op: number = FADE_MAX;
    let elapsed = 0;
    while (elapsed < 150) {
      op = stepFadeOpacity(op, true, FRAME_MS);
      elapsed += FRAME_MS;
    }
    expect(op).toBeLessThanOrEqual(0.4);
  });

  it('never fades below FADE_MIN and never rises above FADE_MAX', () => {
    let op: number = FADE_MAX;
    for (let i = 0; i < 60; i++) op = stepFadeOpacity(op, true, FRAME_MS);
    expect(op).toBeGreaterThanOrEqual(FADE_MIN);
    for (let i = 0; i < 60; i++) op = stepFadeOpacity(op, false, FRAME_MS);
    expect(op).toBeLessThanOrEqual(FADE_MAX);
  });

  it('restores to full opacity once the ray clears (within ~150 ms)', () => {
    let op: number = FADE_MIN;
    let elapsed = 0;
    while (elapsed < 150) {
      op = stepFadeOpacity(op, false, FRAME_MS);
      elapsed += FRAME_MS;
    }
    expect(op).toBeGreaterThanOrEqual(0.99);
  });

  it('re-triggering mid-restore heads back down to a faded alpha', () => {
    // Fade fully, restore only a couple of frames (opacity climbs), then re-occlude.
    let op: number = FADE_MIN;
    for (let i = 0; i < 3; i++) op = stepFadeOpacity(op, false, FRAME_MS);
    const midRestore = op;
    expect(midRestore).toBeGreaterThan(FADE_MIN); // it did climb
    let elapsed = 0;
    while (elapsed < 150) {
      op = stepFadeOpacity(op, true, FRAME_MS);
      elapsed += FRAME_MS;
    }
    expect(op).toBeLessThanOrEqual(0.4);
  });
});

describe('needsTransparent — transparent flag only while actually fading', () => {
  it('is false at full opacity (opaque pass, no sort cost) and true while faded', () => {
    expect(needsTransparent(FADE_MAX)).toBe(false);
    expect(needsTransparent(0.6)).toBe(true);
    expect(needsTransparent(FADE_MIN)).toBe(true);
  });
});

describe('OcclusionFader — keyed multi-mesh state machine', () => {
  it('fades only the occluded keys and leaves the rest opaque', () => {
    const fader = new OcclusionFader<string>();
    const keys = ['a', 'b', 'c'];
    const occluded = new Set(['b']);
    let elapsed = 0;
    while (elapsed < 150) {
      fader.step(keys, occluded, FRAME_MS);
      elapsed += FRAME_MS;
    }
    expect(fader.opacity('b')).toBeLessThanOrEqual(0.4);
    expect(fader.opacity('a')).toBe(FADE_MAX);
    expect(fader.opacity('c')).toBe(FADE_MAX);
  });

  it('an unknown key defaults to fully opaque', () => {
    const fader = new OcclusionFader<string>();
    expect(fader.opacity('never-seen')).toBe(FADE_MAX);
  });

  it('forget drops a key back to the default', () => {
    const fader = new OcclusionFader<string>();
    fader.step(['x'], new Set(['x']), FRAME_MS * 4);
    expect(fader.opacity('x')).toBeLessThan(FADE_MAX);
    fader.forget('x');
    expect(fader.opacity('x')).toBe(FADE_MAX);
  });

  it('a key that clears from the occluded set climbs back to opaque', () => {
    const fader = new OcclusionFader<string>();
    const keys = ['x'];
    let elapsed = 0;
    while (elapsed < 150) {
      fader.step(keys, new Set(['x']), FRAME_MS);
      elapsed += FRAME_MS;
    }
    expect(fader.opacity('x')).toBeLessThanOrEqual(0.4);
    elapsed = 0;
    while (elapsed < 150) {
      fader.step(keys, new Set<string>(), FRAME_MS);
      elapsed += FRAME_MS;
    }
    expect(fader.opacity('x')).toBeGreaterThanOrEqual(0.99);
  });
});

// Phase 36 — the recorded debt: restore used to mean "multiply toward 1.0", so the first time the
// camera passed behind a material authored below full opacity, that authored value was gone for
// good. The fader now remembers a captured base and restores TO it.
describe('OcclusionFader — captured base opacity (Phase 36 debt fix)', () => {
  const settle = (fader: OcclusionFader<string>, keys: string[], occluded: Set<string>): void => {
    let elapsed = 0;
    while (elapsed < 200) {
      fader.step(keys, occluded, FRAME_MS);
      elapsed += FRAME_MS;
    }
  };

  it('a key with no captured base behaves EXACTLY as before (base = 1)', () => {
    const fader = new OcclusionFader<string>();
    expect(fader.baseOpacity('x')).toBe(FADE_MAX);
    expect(fader.appliedOpacity('x')).toBe(fader.opacity('x'));
    settle(fader, ['x'], new Set(['x']));
    expect(fader.appliedOpacity('x')).toBe(fader.opacity('x'));
  });

  it('restores to the CAPTURED base, not to 1', () => {
    const fader = new OcclusionFader<string>();
    fader.captureBaseOpacity('glass', 0.6);
    settle(fader, ['glass'], new Set(['glass']));
    expect(fader.appliedOpacity('glass')).toBeCloseTo(0.6 * FADE_MIN, 5);
    settle(fader, ['glass'], new Set<string>());
    expect(fader.appliedOpacity('glass')).toBeCloseTo(0.6, 5);
  });

  it('capture is once-only: a later call cannot latch a mid-fade value as the base', () => {
    const fader = new OcclusionFader<string>();
    fader.captureBaseOpacity('glass', 0.6);
    fader.step(['glass'], new Set(['glass']), FRAME_MS * 3);
    fader.captureBaseOpacity('glass', fader.appliedOpacity('glass')); // the naive every-frame call
    expect(fader.baseOpacity('glass')).toBe(0.6);
  });

  it('a faded base-carrying surface still clears A.5s ≤0.4 bar (base only ever lowers alpha)', () => {
    const fader = new OcclusionFader<string>();
    fader.captureBaseOpacity('glass', 0.9);
    settle(fader, ['glass'], new Set(['glass']));
    expect(fader.appliedOpacity('glass')).toBeLessThanOrEqual(0.4);
  });

  it('forget drops the base too (a remounted mesh has a fresh material to re-capture from)', () => {
    const fader = new OcclusionFader<string>();
    fader.captureBaseOpacity('glass', 0.6);
    fader.forget('glass');
    expect(fader.baseOpacity('glass')).toBe(FADE_MAX);
    fader.captureBaseOpacity('glass', 0.8);
    expect(fader.baseOpacity('glass')).toBe(0.8);
  });

  it('minOpacity keeps reporting the raw FADE factor (the occlusionMinOpacity probe contract)', () => {
    const fader = new OcclusionFader<string>();
    fader.captureBaseOpacity('glass', 0.5);
    settle(fader, ['glass'], new Set(['glass']));
    expect(fader.minOpacity()).toBeCloseTo(FADE_MIN, 5);
  });
});
