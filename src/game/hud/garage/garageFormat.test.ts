import { describe, expect, it } from 'vitest';
import { GARAGE_GRID_COLUMNS, gradeBarPercent, nextGridIndex, unlockProgressPct } from './garageFormat';

describe('gradeBarPercent', () => {
  it.each([
    ['D', 25],
    ['C', 50],
    ['B', 75],
    ['A', 100],
  ] as const)('%s -> %d%%', (grade, expected) => {
    expect(gradeBarPercent(grade)).toBe(expected);
  });
});

describe('unlockProgressPct', () => {
  it('0 progress at score 0', () => {
    expect(unlockProgressPct(0, 500)).toBe(0);
  });

  it('halfway progress', () => {
    expect(unlockProgressPct(250, 500)).toBe(50);
  });

  it('clamps at 100 once the score meets/exceeds the threshold', () => {
    expect(unlockProgressPct(500, 500)).toBe(100);
    expect(unlockProgressPct(999, 500)).toBe(100);
  });

  it('never negative for a negative score', () => {
    expect(unlockProgressPct(-10, 500)).toBe(0);
  });

  it('a threshold of 0 always reads complete (avoids divide-by-zero)', () => {
    expect(unlockProgressPct(0, 0)).toBe(100);
  });
});

describe('nextGridIndex', () => {
  // 2 rows x 3 columns, 6 total (the real garage roster shape).
  const TOTAL = 6;
  const COLS = GARAGE_GRID_COLUMNS;

  it('ArrowRight moves right by one index (row-major — crosses into the next row at a row end)', () => {
    expect(nextGridIndex(0, 'ArrowRight', TOTAL, COLS)).toBe(1);
    expect(nextGridIndex(2, 'ArrowRight', TOTAL, COLS)).toBe(3); // row 0's last card -> row 1's first
  });

  it('ArrowLeft moves left, clamped at index 0', () => {
    expect(nextGridIndex(1, 'ArrowLeft', TOTAL, COLS)).toBe(0);
    expect(nextGridIndex(0, 'ArrowLeft', TOTAL, COLS)).toBe(0);
  });

  it('ArrowDown moves down a full row', () => {
    expect(nextGridIndex(0, 'ArrowDown', TOTAL, COLS)).toBe(3);
    expect(nextGridIndex(3, 'ArrowDown', TOTAL, COLS)).toBe(3); // no row below — clamped
  });

  it('ArrowUp moves up a full row', () => {
    expect(nextGridIndex(4, 'ArrowUp', TOTAL, COLS)).toBe(1);
    expect(nextGridIndex(1, 'ArrowUp', TOTAL, COLS)).toBe(1); // no row above — clamped
  });

  it('ArrowRight at the very last card clamps in place', () => {
    expect(nextGridIndex(5, 'ArrowRight', TOTAL, COLS)).toBe(5);
  });

  it('an unrecognized key leaves the index unchanged', () => {
    expect(nextGridIndex(2, 'Enter', TOTAL, COLS)).toBe(2);
    expect(nextGridIndex(2, 'KeyG', TOTAL, COLS)).toBe(2);
  });
});
