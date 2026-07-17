import { afterEach, describe, expect, it, vi } from 'vitest';
import { __resetWebGL2CacheForTests, detectWebGL2 } from './webgl';

// HTMLCanvasElement.prototype.getContext's real signature is a big overloaded union keyed
// off the first argument's literal string type, which makes vi.spyOn(...).mockReturnValue
// fight the type checker for no real benefit in a test file — routing every stub through
// this one cast keeps that noise contained to a single line.
function stubGetContext(impl: () => unknown) {
  return vi
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockImplementation(impl as unknown as typeof HTMLCanvasElement.prototype.getContext);
}

afterEach(() => {
  __resetWebGL2CacheForTests();
  vi.restoreAllMocks();
});

describe('detectWebGL2', () => {
  it('returns false when getContext("webgl2") returns null (jsdom default / unsupported browser)', () => {
    stubGetContext(() => null);
    expect(detectWebGL2()).toBe(false);
  });

  it('returns true when getContext("webgl2") returns a real context', () => {
    stubGetContext(() => ({}));
    expect(detectWebGL2()).toBe(true);
  });

  it('returns false (not throw) when getContext throws — e.g. a GPU-blocklisted driver', () => {
    stubGetContext(() => {
      throw new Error('blocked');
    });
    expect(() => detectWebGL2()).not.toThrow();
    expect(detectWebGL2()).toBe(false);
  });

  it('caches the result — getContext is probed at most once across repeated calls', () => {
    const spy = stubGetContext(() => ({}));
    expect(detectWebGL2()).toBe(true);
    expect(detectWebGL2()).toBe(true);
    expect(detectWebGL2()).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('with no mock at all, resolves false in the plain jsdom test environment', () => {
    // No canvas/WebGL backend is installed for these tests, so the real (unmocked)
    // getContext call returns null — this pins that the unsupported-by-default test
    // environment is itself proof the "no crash, just false" contract holds end to end.
    expect(detectWebGL2()).toBe(false);
  });
});
