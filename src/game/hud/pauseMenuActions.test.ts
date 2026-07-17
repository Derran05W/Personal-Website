import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gameEvents } from '../state/events';
import { getGameState, useGameStore } from '../state/store';
import { initProgressPersistence, loadProgress } from '../state/persistence';
import { __resetRunLoopForTest, initRunLoopSystem } from '../combat/runLoop';
import { openGarage, resumeRun, restartRun } from './pauseMenuActions';

const initialState = useGameStore.getState();

beforeEach(() => {
  localStorage.clear();
  useGameStore.setState(initialState, true);
  __resetRunLoopForTest();
});

afterEach(() => {
  gameEvents.clearAllListeners();
  __resetRunLoopForTest();
});

function enterPaused(): void {
  const s = getGameState();
  s.transition('LOADING');
  s.transition('GARAGE');
  s.transition('PLAYING');
  s.transition('PAUSED');
}

describe('resumeRun', () => {
  it('PAUSED -> PLAYING', () => {
    enterPaused();
    resumeRun();
    expect(getGameState().machine).toBe('PLAYING');
  });

  it('no-ops outside PAUSED', () => {
    resumeRun(); // still BOOT
    expect(getGameState().machine).toBe('BOOT');
  });
});

describe('openGarage', () => {
  it('PAUSED -> GARAGE', () => {
    enterPaused();
    openGarage();
    expect(getGameState().machine).toBe('GARAGE');
  });

  it('no-ops outside PAUSED', () => {
    openGarage(); // still BOOT
    expect(getGameState().machine).toBe('BOOT');
  });
});

describe('restartRun', () => {
  it('no-ops outside PAUSED', () => {
    expect(() => restartRun()).not.toThrow();
    expect(getGameState().machine).toBe('BOOT');
  });

  it('lands on PLAYING with heat/score reset, after emitting exactly one quit runEnded', () => {
    const offRunLoop = initRunLoopSystem();
    const runEndedHandler = vi.fn();
    gameEvents.on('runEnded', runEndedHandler);

    enterPaused();
    getGameState().addHeat(50);
    getGameState().addScore(120);

    restartRun();

    expect(runEndedHandler).toHaveBeenCalledTimes(1);
    expect(runEndedHandler).toHaveBeenCalledWith({ score: 120, reason: 'quit' });
    expect(getGameState().machine).toBe('PLAYING');
    expect(getGameState().heat).toBe(0);
    expect(getGameState().score).toBe(0);

    offRunLoop();
  });

  it('folds the aborted run score into lifetimeScore via the normal persistence path', () => {
    const offPersist = initProgressPersistence();
    const offRunLoop = initRunLoopSystem();

    enterPaused();
    getGameState().addScore(75);
    restartRun();

    expect(loadProgress().lifetimeScore).toBe(75);

    offRunLoop();
    offPersist();
  });

  it('the same seed carries over (retry, not a new city)', () => {
    const offRunLoop = initRunLoopSystem();
    getGameState().setSeed(4242);
    enterPaused();

    restartRun();

    expect(getGameState().seed).toBe(4242);
    offRunLoop();
  });
});
