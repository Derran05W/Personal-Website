// Phase 36 — tests for occlusion v2's pure middle: the fade-target registry (who can be written to)
// and the hysteresis hold clock (when a key counts as occluded). Both are stepped here at exact
// 60-fps frame boundaries, the same discipline as occlusionFade.test.ts, because the failure modes
// they exist to prevent — a strobing wall, a StrictMode-orphaned writer, a map that grows all
// session — are all timing/lifecycle bugs no screenshot would catch.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HOLD_MS,
  HysteresisGate,
  applyAllFades,
  clearFadeTargets,
  fadeTargetCount,
  fadeTargetKeys,
  hasFadeTarget,
  registerFadeTarget,
  unregisterFadeTarget,
} from './occlusionTargets';

const FRAME_MS = 1000 / 60; // ~16.67 ms

afterEach(() => {
  clearFadeTargets();
});

describe('HOLD_MS — the constant this module is about', () => {
  it('is the part file’s ~150 ms grazing hold', () => {
    expect(HOLD_MS).toBe(150);
  });
});

describe('fade-target registry', () => {
  it('registers, reports and applies', () => {
    const seen: number[] = [];
    registerFadeTarget('a', (f) => seen.push(f));
    expect(hasFadeTarget('a')).toBe(true);
    expect(fadeTargetCount()).toBe(1);
    applyAllFades(() => 0.35);
    expect(seen).toEqual([0.35]);
  });

  it('applies the per-key fade, not one shared value', () => {
    const writes = new Map<string, number>();
    registerFadeTarget('a', (f) => writes.set('a', f));
    registerFadeTarget('b', (f) => writes.set('b', f));
    applyAllFades((key) => (key === 'a' ? 0.4 : 1));
    expect(writes.get('a')).toBe(0.4);
    expect(writes.get('b')).toBe(1);
  });

  it('exposes its keys for the fader’s full-key step', () => {
    registerFadeTarget('a', () => {});
    registerFadeTarget('b', () => {});
    expect([...fadeTargetKeys()].sort()).toEqual(['a', 'b']);
  });

  it('re-registering a key REPLACES the writer (last write wins)', () => {
    const first = vi.fn();
    const second = vi.fn();
    registerFadeTarget('a', first);
    registerFadeTarget('a', second);
    expect(fadeTargetCount()).toBe(1);
    applyAllFades(() => 1);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('STRICTMODE: mount → mount → (late) first cleanup leaves the LIVE writer registered', () => {
    // React 18 StrictMode runs mount, cleanup, mount — and a cleanup closing over the first
    // registration must not delete the second one. This is Phase 30's registration bug in reverse.
    const first = vi.fn();
    const second = vi.fn();
    registerFadeTarget('a', first); // mount 1
    registerFadeTarget('a', second); // mount 2 (StrictMode remount, before cleanup lands)
    expect(unregisterFadeTarget('a', first)).toBe(false); // cleanup 1 — identity-checked no-op
    expect(hasFadeTarget('a')).toBe(true);
    applyAllFades(() => 1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it('the matching cleanup DOES remove, and an unmatched key is a no-op', () => {
    const apply = vi.fn();
    registerFadeTarget('a', apply);
    expect(unregisterFadeTarget('a', apply)).toBe(true);
    expect(hasFadeTarget('a')).toBe(false);
    expect(unregisterFadeTarget('a', apply)).toBe(false);
    expect(unregisterFadeTarget('never-registered')).toBe(false);
  });

  it('unregister without an identity removes unconditionally (world teardown)', () => {
    registerFadeTarget('a', () => {});
    expect(unregisterFadeTarget('a')).toBe(true);
    expect(fadeTargetCount()).toBe(0);
  });

  it('clearFadeTargets empties the registry', () => {
    registerFadeTarget('a', () => {});
    registerFadeTarget('b', () => {});
    clearFadeTargets();
    expect(fadeTargetCount()).toBe(0);
    let calls = 0;
    applyAllFades(() => {
      calls++;
      return 1;
    });
    expect(calls).toBe(0);
  });
});

describe('HysteresisGate — the grazing-strobe killer', () => {
  it('a hit key is occluded immediately', () => {
    const gate = new HysteresisGate();
    gate.markHit('a', 1000);
    expect(gate.isOccluded('a', 1000)).toBe(true);
  });

  it('an unknown key is never occluded', () => {
    const gate = new HysteresisGate();
    expect(gate.isOccluded('ghost', 1000)).toBe(false);
    expect(gate.msSinceHit('ghost', 1000)).toBe(Infinity);
  });

  it('HOLDS through the full HOLD_MS of clear frames, then releases', () => {
    const gate = new HysteresisGate();
    gate.markHit('a', 0);
    expect(gate.isOccluded('a', HOLD_MS)).toBe(true); // boundary-inclusive: still held
    expect(gate.isOccluded('a', HOLD_MS + 1)).toBe(false);
  });

  it('a key grazed every few frames NEVER releases (the strobe case, stepped at 60 fps)', () => {
    const gate = new HysteresisGate();
    let now = 0;
    let released = 0;
    for (let frame = 0; frame < 600; frame++) {
      // Hit on one frame in five — 83 ms apart, well inside the hold.
      if (frame % 5 === 0) gate.markHit('a', now);
      if (!gate.isOccluded('a', now)) released++;
      now += FRAME_MS;
    }
    expect(released).toBe(0);
  });

  it('the same intermittent pattern WITHOUT the hold would strobe (control)', () => {
    // The property the hold buys, stated as a comparison: raw per-frame hit membership flips
    // constantly at the exact cadence the test above keeps steady.
    let flips = 0;
    let prev = false;
    for (let frame = 0; frame < 600; frame++) {
      const raw = frame % 5 === 0;
      if (raw !== prev) flips++;
      prev = raw;
    }
    expect(flips).toBeGreaterThan(200);
  });

  it('RE-TRIGGER: a hit inside the hold window extends it from the new hit', () => {
    const gate = new HysteresisGate();
    gate.markHit('a', 0);
    gate.markHit('a', 100);
    expect(gate.isOccluded('a', 200)).toBe(true); // 100 ms since the last hit
    expect(gate.isOccluded('a', 260)).toBe(false); // 160 ms — released
  });

  it('collectOccluded fills the caller’s set, clearing it first', () => {
    const gate = new HysteresisGate();
    gate.markHits(['a', 'b'], 0);
    const out = new Set<string>(['stale']);
    gate.collectOccluded(out, 0);
    expect([...out].sort()).toEqual(['a', 'b']);
    gate.markHit('a', 200);
    gate.collectOccluded(out, 200);
    expect([...out]).toEqual(['a']); // b aged out
  });

  it('MEMORY: aged-out keys are pruned, so a long session cannot grow the map', () => {
    const gate = new HysteresisGate();
    let now = 0;
    const out = new Set<string>();
    // 2,000 distinct short-lived occluders (a drive across the map), one new key per frame.
    for (let frame = 0; frame < 2000; frame++) {
      gate.markHit(`slot-${frame}`, now);
      gate.collectOccluded(out, now);
      now += FRAME_MS;
    }
    // Only the keys hit within the last HOLD_MS may survive: ~9 frames at 60 fps, never thousands.
    expect(gate.size).toBeLessThanOrEqual(Math.ceil(HOLD_MS / FRAME_MS) + 1);
    expect(out.size).toBe(gate.size);
  });

  it('prune() alone does the same for isOccluded-only callers', () => {
    const gate = new HysteresisGate();
    gate.markHits(['a', 'b'], 0);
    gate.markHit('b', 500);
    gate.prune(500);
    expect(gate.size).toBe(1);
    expect(gate.isOccluded('b', 500)).toBe(true);
    expect(gate.isOccluded('a', 500)).toBe(false);
  });

  it('clear() forgets everything', () => {
    const gate = new HysteresisGate();
    gate.markHits(['a', 'b'], 0);
    gate.clear();
    expect(gate.size).toBe(0);
  });
});

describe('the pass, end to end (gate + registry, the shape TorontoScene runs)', () => {
  it('a key hit once fades and stays faded through the hold, then is released to restore', () => {
    const gate = new HysteresisGate();
    const writes: number[] = [];
    registerFadeTarget('wall', (f) => writes.push(f));
    const occluded = new Set<string>();
    let now = 0;
    const frames: boolean[] = [];
    for (let frame = 0; frame < 30; frame++) {
      if (frame === 0) gate.markHit('wall', now); // grazed for exactly one frame
      gate.collectOccluded(occluded, now);
      frames.push(occluded.has('wall'));
      applyAllFades((key) => (occluded.has(key) ? 0.35 : 1));
      now += FRAME_MS;
    }
    // Held for the first ~9 frames (HOLD_MS), then clear for the rest — one transition, not a strobe.
    const transitions = frames.filter((v, i) => i > 0 && v !== frames[i - 1]).length;
    expect(transitions).toBe(1);
    expect(frames[0]).toBe(true);
    expect(frames[frames.length - 1]).toBe(false);
    expect(writes).toHaveLength(30);
  });
});
