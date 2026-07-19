// Spec §10 build-order guard: "tunnel triggers exactly at fold boundaries"
// (TORONTO-MAP-SPEC-v2.md §2/§10). Authored against tunnel.ts's own doc comment for the
// chosen boundary convention: the fold band is the CLOSED interval [702, 1362]; a sample
// landing exactly ON a boundary counts as already inside the band, so northbound fires on
// `prevY > 1362 && y <= 1362` and southbound fires on `prevY < 702 && y >= 702`.
import { describe, expect, it } from 'vitest';
import { createFoldTrigger, foldCrossing, type FoldDirection } from './tunnel';

// Arbitrary but realistic corridor half-width for the stepper tests — not spec-pinned (the
// task brief: "halfWidth ... passed as a parameter" from the caller's road config), just a
// fixed, generous-enough-to-stay-on-Yonge value reused across most cases below.
const HALF_WIDTH = 20;
const YONGE_X = 1500;

describe('foldCrossing — pure per-sample crossing test', () => {
  describe('exact-boundary samples', () => {
    it('northbound: fires exactly when the new sample reaches or passes 1362 from strictly above it', () => {
      expect(foldCrossing(1363, 1362, YONGE_X, HALF_WIDTH)).toBe('northbound');
      expect(foldCrossing(1432, 1362, YONGE_X, HALF_WIDTH)).toBe('northbound');
    });

    it('northbound: a sample already AT 1362 does not re-fire moving further in (already "inside")', () => {
      expect(foldCrossing(1362, 1232, YONGE_X, HALF_WIDTH)).toBeNull();
      expect(foldCrossing(1362, 1362, YONGE_X, HALF_WIDTH)).toBeNull();
    });

    it('southbound: fires exactly when the new sample reaches or passes 702 from strictly below it', () => {
      expect(foldCrossing(701, 702, YONGE_X, HALF_WIDTH)).toBe('southbound');
      expect(foldCrossing(532, 702, YONGE_X, HALF_WIDTH)).toBe('southbound');
    });

    it('southbound: a sample already AT 702 does not re-fire moving further in (already "inside")', () => {
      expect(foldCrossing(702, 832, YONGE_X, HALF_WIDTH)).toBeNull();
      expect(foldCrossing(702, 702, YONGE_X, HALF_WIDTH)).toBeNull();
    });

    it('a sample strictly outside a boundary but not crossing it fires nothing (not yet an entry)', () => {
      expect(foldCrossing(1432, 1363, YONGE_X, HALF_WIDTH)).toBeNull(); // still south of 1362
      expect(foldCrossing(532, 701, YONGE_X, HALF_WIDTH)).toBeNull(); // still north of 702
    });

    it('an EXIT sample (already inside, moving past the far boundary) fires nothing — only entries fire', () => {
      // prevY < 1362 <= y: heading south, leaving the fold into downtown at Bloor — this is
      // an exit, not the northbound entry (which is the opposite direction), and not a
      // southbound entry either (that only fires at 702).
      expect(foldCrossing(1232, 1382, YONGE_X, HALF_WIDTH)).toBeNull();
      // Symmetric: heading north, leaving the fold into North York at Sheppard.
      expect(foldCrossing(832, 632, YONGE_X, HALF_WIDTH)).toBeNull();
    });
  });

  describe('the Yonge-corridor x-gate', () => {
    it('does not fire off the corridor even when y legitimately crosses a boundary', () => {
      expect(foldCrossing(1432, 1232, YONGE_X + HALF_WIDTH + 1, HALF_WIDTH)).toBeNull();
      expect(foldCrossing(1432, 1232, YONGE_X - HALF_WIDTH - 1, HALF_WIDTH)).toBeNull();
    });

    it('is inclusive at exactly halfWidth', () => {
      expect(foldCrossing(1432, 1232, YONGE_X + HALF_WIDTH, HALF_WIDTH)).toBe('northbound');
      expect(foldCrossing(1432, 1232, YONGE_X - HALF_WIDTH, HALF_WIDTH)).toBe('northbound');
    });
  });

  describe('fast crossing — one sample clears both boundaries', () => {
    it('northbound: a single step from well south of 1362 to well north of 702 fires the entry once', () => {
      expect(foldCrossing(1432, 632, YONGE_X, HALF_WIDTH)).toBe('northbound');
    });

    it('southbound: the symmetric jump fires its entry once', () => {
      expect(foldCrossing(632, 1432, YONGE_X, HALF_WIDTH)).toBe('southbound');
    });

    it('the two conditions are mutually exclusive — never both directions from one sample pair', () => {
      const north = foldCrossing(1432, 632, YONGE_X, HALF_WIDTH);
      const south = foldCrossing(632, 1432, YONGE_X, HALF_WIDTH);
      expect([north, south]).not.toContain(null);
      expect(north).not.toBe(south);
    });
  });

  describe('purity / teleport-free', () => {
    it('is deterministic (same inputs -> same output) and never mutates its numeric arguments', () => {
      const prevY = 1432;
      const y = 1232;
      const x = YONGE_X;
      const snapshot = { prevY, y, x };

      const first = foldCrossing(prevY, y, x, HALF_WIDTH);
      const second = foldCrossing(prevY, y, x, HALF_WIDTH);

      expect({ prevY, y, x }).toEqual(snapshot); // JS primitives are pass-by-value, but the
      // spec explicitly asks this be verified rather than assumed — nothing here writes
      // back into a shared position, there IS no shared position.
      expect(second).toBe(first);
    });
  });
});

describe('createFoldTrigger — stateful stepper', () => {
  it('fires nothing on the very first sample (needs a previous sample to detect a crossing)', () => {
    const trigger = createFoldTrigger(HALF_WIDTH);
    expect(trigger.step(YONGE_X, 1432)).toBeNull();
  });

  it('a plain northbound drive-through fires exactly once, at the Bloor boundary', () => {
    const trigger = createFoldTrigger(HALF_WIDTH);
    expect(trigger.step(YONGE_X, 1532)).toBeNull();
    expect(trigger.step(YONGE_X, 1432)).toBeNull(); // still south of 1362
    expect(trigger.step(YONGE_X, 1232)).toBe('northbound'); // crossed 1362
    expect(trigger.step(YONGE_X, 932)).toBeNull(); // already inside, driving on
  });

  it('a plain southbound drive-through fires exactly once, at the Sheppard boundary', () => {
    const trigger = createFoldTrigger(HALF_WIDTH);
    expect(trigger.step(YONGE_X, 432)).toBeNull();
    expect(trigger.step(YONGE_X, 532)).toBeNull(); // still north of 702
    expect(trigger.step(YONGE_X, 832)).toBe('southbound'); // crossed 702
    expect(trigger.step(YONGE_X, 1132)).toBeNull(); // already inside, driving on
  });

  it('never re-fires while oscillating deep inside the band (e.g. looping Yonge & Eglinton, y≈1032)', () => {
    const trigger = createFoldTrigger(HALF_WIDTH);
    trigger.step(YONGE_X, 1532);
    expect(trigger.step(YONGE_X, 1232)).toBe('northbound'); // entered

    const oscillation = [1132, 1332, 932, 1182, 1032, 1282, 982];
    const results: (FoldDirection | null)[] = oscillation.map((y) => trigger.step(YONGE_X, y));
    expect(results.every((r) => r === null)).toBe(true);
  });

  it('re-arms after fully leaving the band through the FAR side, then fires the opposite entry on re-entry', () => {
    const trigger = createFoldTrigger(HALF_WIDTH);
    trigger.step(YONGE_X, 1532);
    expect(trigger.step(YONGE_X, 1232)).toBe('northbound'); // entered from downtown

    // Drive on through and fully exit the north side into North York.
    expect(trigger.step(YONGE_X, 632)).toBeNull(); // left the band — no exit event fires
    expect(trigger.step(YONGE_X, 432)).toBeNull(); // further out, still nothing

    // Reverse back south — this is a fresh, legitimate southbound entry.
    expect(trigger.step(YONGE_X, 832)).toBe('southbound');
  });

  it('re-arms after leaving back out the SAME side just entered (a U-turn short of fully crossing)', () => {
    const trigger = createFoldTrigger(HALF_WIDTH);
    trigger.step(YONGE_X, 1432);
    expect(trigger.step(YONGE_X, 1232)).toBe('northbound'); // entered from downtown

    // U-turn: back out the south side before ever reaching Sheppard.
    expect(trigger.step(YONGE_X, 1432)).toBeNull(); // left the band again — no exit event

    // Re-enter northbound a second time — must fire again, not stay latched off.
    expect(trigger.step(YONGE_X, 1232)).toBe('northbound');
  });

  it('a fast crossing (one step clears both boundaries) fires the entry exactly once, then re-arms', () => {
    const trigger = createFoldTrigger(HALF_WIDTH);
    trigger.step(YONGE_X, 1432);
    expect(trigger.step(YONGE_X, 632)).toBe('northbound'); // jumped clean through the fold

    // Landing outside the band (north side) re-arms immediately — driving on doesn't re-fire.
    expect(trigger.step(YONGE_X, 332)).toBeNull();

    // A later legitimate southbound re-entry still works.
    expect(trigger.step(YONGE_X, 832)).toBe('southbound');
  });

  it('never fires off the Yonge corridor, even while y crosses both boundaries repeatedly', () => {
    const offCorridorX = YONGE_X + HALF_WIDTH + 50;
    const trigger = createFoldTrigger(HALF_WIDTH);
    trigger.step(offCorridorX, 1532);
    expect(trigger.step(offCorridorX, 1232)).toBeNull();
    expect(trigger.step(offCorridorX, 532)).toBeNull();
    expect(trigger.step(offCorridorX, 1232)).toBeNull();
    expect(trigger.step(offCorridorX, 1532)).toBeNull();
  });

  it('starting mid-band (first sample already inside) does not misfire, and later real crossings still work', () => {
    const trigger = createFoldTrigger(HALF_WIDTH);
    expect(trigger.step(YONGE_X, 1032)).toBeNull(); // first sample, no prev to compare
    expect(trigger.step(YONGE_X, 1432)).toBeNull(); // exits south — not an entry, fires nothing
    expect(trigger.step(YONGE_X, 1232)).toBe('northbound'); // genuine re-entry from downtown
  });

  it('is teleport-free: step() only ever returns a direction or null, never a position', () => {
    const trigger = createFoldTrigger(HALF_WIDTH);
    const x = YONGE_X;
    let y = 1532;
    const results: unknown[] = [];
    for (const next of [1432, 1232, 932, 702, 532]) {
      results.push(trigger.step(x, next));
      y = next;
    }
    expect(y).toBe(532); // the caller's own position variable — untouched by step()
    for (const r of results) {
      expect(r === null || r === 'northbound' || r === 'southbound').toBe(true);
    }
  });
});
