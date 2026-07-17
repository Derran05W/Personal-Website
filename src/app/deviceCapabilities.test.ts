import { afterEach, describe, expect, it } from 'vitest';
import { readDeviceCapabilities } from './deviceCapabilities';

// deviceCapabilities.ts only ever reads `.matches` off whatever matchMedia() returns, so
// the stub only needs to implement that much of MediaQueryList.
function stubMatchMedia(matches: (query: string) => boolean): void {
  window.matchMedia = ((query: string) => ({ matches: matches(query) })) as unknown as typeof window.matchMedia;
}

afterEach(() => {
  // jsdom doesn't implement matchMedia at all out of the box (verified: calling it throws
  // "window.matchMedia is not a function") — deleting after each test restores that
  // baseline for the next test/file instead of leaking a stub.
  // @ts-expect-error reverting to the unimplemented jsdom baseline
  delete window.matchMedia;
});

describe('readDeviceCapabilities', () => {
  it('falls back to {false, false} when matchMedia is unavailable (jsdom default)', () => {
    expect(typeof window.matchMedia).toBe('undefined');
    expect(readDeviceCapabilities()).toEqual({ coarsePointer: false, reducedMotion: false });
  });

  it('reads coarsePointer from (pointer: coarse) and reducedMotion from (prefers-reduced-motion: reduce)', () => {
    stubMatchMedia(
      (query) => query === '(pointer: coarse)' || query === '(prefers-reduced-motion: reduce)',
    );
    expect(readDeviceCapabilities()).toEqual({ coarsePointer: true, reducedMotion: true });
  });

  it('reports coarse pointer without reduced motion independently (typical phone)', () => {
    stubMatchMedia((query) => query === '(pointer: coarse)');
    expect(readDeviceCapabilities()).toEqual({ coarsePointer: true, reducedMotion: false });
  });

  it('reports reduced motion without coarse pointer independently (desktop, OS motion pref set)', () => {
    stubMatchMedia((query) => query === '(prefers-reduced-motion: reduce)');
    expect(readDeviceCapabilities()).toEqual({ coarsePointer: false, reducedMotion: true });
  });

  it('resolves both false on a plain desktop (fine pointer, motion ok)', () => {
    stubMatchMedia(() => false);
    expect(readDeviceCapabilities()).toEqual({ coarsePointer: false, reducedMotion: false });
  });

  it('treats a throwing matchMedia as "cannot tell" -> false, not a crash', () => {
    window.matchMedia = (() => {
      throw new Error('unsupported query');
    }) as unknown as typeof window.matchMedia;
    expect(() => readDeviceCapabilities()).not.toThrow();
    expect(readDeviceCapabilities()).toEqual({ coarsePointer: false, reducedMotion: false });
  });
});
