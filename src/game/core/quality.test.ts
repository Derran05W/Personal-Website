import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectQualityTier } from './quality';

// jsdom ships a real `navigator`; stub it per-case so the heuristic is tested against
// known signals, and restore afterwards so nothing leaks between tests.
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('detectQualityTier', () => {
  it("returns 'low' for a mobile user agent (regardless of core count)", () => {
    vi.stubGlobal('navigator', {
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
      hardwareConcurrency: 8,
    });
    expect(detectQualityTier()).toBe('low');
  });

  it("returns 'low' for an Android phone user agent", () => {
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Mobile Safari/537.36',
      hardwareConcurrency: 8,
    });
    expect(detectQualityTier()).toBe('low');
  });

  it("returns 'med' for a desktop UA with <= 4 logical cores", () => {
    vi.stubGlobal('navigator', {
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      hardwareConcurrency: 4,
    });
    expect(detectQualityTier()).toBe('med');
  });

  it("returns 'high' for a desktop UA with many cores", () => {
    vi.stubGlobal('navigator', {
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      hardwareConcurrency: 16,
    });
    expect(detectQualityTier()).toBe('high');
  });

  it("falls back to 'high' when navigator lacks userAgent and hardwareConcurrency", () => {
    vi.stubGlobal('navigator', {});
    expect(detectQualityTier()).toBe('high');
  });

  it("falls back to 'high' when navigator is undefined", () => {
    vi.stubGlobal('navigator', undefined);
    expect(detectQualityTier()).toBe('high');
  });
});
