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
