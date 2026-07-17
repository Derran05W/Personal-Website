import { describe, expect, it } from 'vitest';
import { filledStarCount, formatScore, hpColor, hpFillPercent } from './hudFormat';

describe('formatScore', () => {
  it('thousands-separates and rounds to an integer', () => {
    expect(formatScore(1234.7)).toBe('1,235');
    expect(formatScore(1000000)).toBe('1,000,000');
    expect(formatScore(0)).toBe('0');
  });

  it('clamps negative/non-finite input to 0', () => {
    expect(formatScore(-42)).toBe('0');
    expect(formatScore(NaN)).toBe('0');
    expect(formatScore(Infinity)).toBe('0');
  });
});

describe('hpFillPercent', () => {
  it('clamps into 0-100', () => {
    expect(hpFillPercent(50)).toBe(50);
    expect(hpFillPercent(150)).toBe(100);
    expect(hpFillPercent(-10)).toBe(0);
    expect(hpFillPercent(NaN)).toBe(0);
  });
});

describe('hpColor', () => {
  it('is green at/above 60%, amber in the mid band, red under 30%', () => {
    expect(hpColor(100)).toBe('#4ade80');
    expect(hpColor(60)).toBe('#4ade80');
    expect(hpColor(59)).toBe('#f59e0b');
    expect(hpColor(30)).toBe('#f59e0b');
    expect(hpColor(29)).toBe('#ef4444');
    expect(hpColor(0)).toBe('#ef4444');
  });
});

describe('filledStarCount', () => {
  it('passes through 0-5 tiers unchanged', () => {
    for (let tier = 0; tier <= 5; tier++) expect(filledStarCount(tier)).toBe(tier);
  });

  it('clamps out-of-range or non-integer tiers defensively', () => {
    expect(filledStarCount(6)).toBe(5);
    expect(filledStarCount(-1)).toBe(0);
    expect(filledStarCount(3.9)).toBe(3);
    expect(filledStarCount(NaN)).toBe(0);
  });
});
