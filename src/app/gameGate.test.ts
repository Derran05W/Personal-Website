import { describe, expect, it } from 'vitest';
import { resolveGameGate } from './gameGate';

// The full gating matrix (Phase 18 Task 3 / TDD §9): WebGL2 availability, coarse pointer
// (touch), and prefers-reduced-motion — three independent booleans, eight combinations.
describe('resolveGameGate', () => {
  it('no WebGL2 always resolves "unsupported", regardless of pointer/motion', () => {
    for (const coarsePointer of [false, true]) {
      for (const reducedMotion of [false, true]) {
        expect(
          resolveGameGate({ webgl2Available: false, coarsePointer, reducedMotion }),
        ).toBe('unsupported');
      }
    }
  });

  it('WebGL2 + fine pointer + motion ok -> "auto-start" (today\'s desktop behavior)', () => {
    expect(
      resolveGameGate({ webgl2Available: true, coarsePointer: false, reducedMotion: false }),
    ).toBe('auto-start');
  });

  it('WebGL2 + coarse pointer (mobile) -> "play-card", even with motion ok', () => {
    expect(
      resolveGameGate({ webgl2Available: true, coarsePointer: true, reducedMotion: false }),
    ).toBe('play-card');
  });

  it('WebGL2 + prefers-reduced-motion (desktop) -> "play-card", even with a fine pointer', () => {
    expect(
      resolveGameGate({ webgl2Available: true, coarsePointer: false, reducedMotion: true }),
    ).toBe('play-card');
  });

  it('WebGL2 + coarse pointer + reduced motion -> "play-card" (both reasons, one outcome)', () => {
    expect(
      resolveGameGate({ webgl2Available: true, coarsePointer: true, reducedMotion: true }),
    ).toBe('play-card');
  });
});
