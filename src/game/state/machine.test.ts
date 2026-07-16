import { describe, expect, it } from 'vitest';
import { type GameState, TRANSITIONS, assertTransition, canTransition } from './machine';

const ALL_STATES: readonly GameState[] = [
  'BOOT',
  'LOADING',
  'GARAGE',
  'PLAYING',
  'PAUSED',
  'GAMEOVER',
];

describe('TRANSITIONS table', () => {
  it('covers all 6 states as keys', () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...ALL_STATES].sort());
  });

  it.each([
    ['BOOT', 'LOADING'],
    ['LOADING', 'GARAGE'],
    ['GARAGE', 'PLAYING'],
    ['PLAYING', 'PAUSED'],
    ['PLAYING', 'GAMEOVER'],
    ['PAUSED', 'PLAYING'],
    ['PAUSED', 'GARAGE'],
    ['PAUSED', 'GAMEOVER'],
    ['GAMEOVER', 'GARAGE'],
    ['GAMEOVER', 'PLAYING'],
  ] as const)('allows %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    expect(() => assertTransition(from, to)).not.toThrow();
  });
});

describe('canTransition / assertTransition — invalid transitions', () => {
  it.each([
    ['BOOT', 'PLAYING'],
    ['GARAGE', 'PAUSED'],
    ['GAMEOVER', 'PAUSED'],
    ['LOADING', 'PLAYING'],
  ] as const)('rejects %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
  });

  it.each([
    ['BOOT', 'PLAYING'],
    ['GARAGE', 'PAUSED'],
    ['GAMEOVER', 'PAUSED'],
    ['LOADING', 'PLAYING'],
  ] as const)('assertTransition throws in dev for %s -> %s', (from, to) => {
    // import.meta.env.DEV is true under vitest (mode defaults to 'test', DEV is truthy
    // for any non-'production' mode), so this exercises the dev throw path.
    expect(() => assertTransition(from, to)).toThrow(/Invalid game state transition/);
  });
});
