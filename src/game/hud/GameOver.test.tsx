import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useGameStore } from '../state/store';
import { gameEvents } from '../state/events';
import { UNLOCKS } from '../config/unlocks';
import GameOver from './GameOver';
import { __resetLastRunEndForTests } from './gameOverRunEnd';
import { __resetRunUnlocksForTests } from './gameOverUnlocks';

function stubCoarsePointer(matches: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) satisfies MediaQueryList,
  );
}

const initialState = useGameStore.getState();

// Deliberately NOT clearing gameEvents listeners in an afterEach here (unlike
// state/events.test.ts / store.test.ts): hud/gameOverRunEnd.ts and hud/gameOverUnlocks.ts
// both register their listeners exactly ONCE, at module-import time, by design (see those
// modules' doc comments) — `gameEvents.clearAllListeners()` would permanently wipe those
// production listeners after the first test in this file, silently breaking every
// subsequent test's `emit(...)` call. The __reset*ForTests() helpers below are the correct,
// listener-preserving reset.
beforeEach(() => {
  localStorage.clear();
  useGameStore.setState(initialState, true);
  __resetLastRunEndForTests();
  __resetRunUnlocksForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

interface GameOverStateOverrides {
  tier?: number;
  seed?: number;
  score?: number;
}

function setGameOverState(overrides: GameOverStateOverrides = {}) {
  useGameStore.setState({
    machine: 'GAMEOVER',
    tier: 2,
    seed: 4242,
    score: 1500,
    ...overrides,
  });
}

describe('GameOver', () => {
  it('renders nothing outside GAMEOVER', () => {
    useGameStore.setState({ machine: 'PLAYING' });
    render(<GameOver />);
    expect(screen.queryByTestId('gameover-root')).not.toBeInTheDocument();
  });

  it('defaults to the WRECKED banner when no runEnded has fired (debug-transition case)', () => {
    setGameOverState();
    render(<GameOver />);
    expect(screen.getByTestId('gameover-banner')).toHaveTextContent('WRECKED');
    expect(screen.getByTestId('gameover-root')).toHaveClass('gameover-backdrop--wrecked');
  });

  it('shows the BUSTED banner and score when the last runEnded reason was busted', () => {
    gameEvents.emit('runEnded', { score: 777, reason: 'busted' });
    setGameOverState();
    render(<GameOver />);
    expect(screen.getByTestId('gameover-banner')).toHaveTextContent('BUSTED');
    expect(screen.getByTestId('gameover-root')).toHaveClass('gameover-backdrop--busted');
    expect(screen.getByTestId('gameover-score')).toHaveTextContent('777');
  });

  it('shows the WRECKED banner when the last runEnded reason was wrecked', () => {
    gameEvents.emit('runEnded', { score: 300, reason: 'wrecked' });
    setGameOverState();
    render(<GameOver />);
    expect(screen.getByTestId('gameover-banner')).toHaveTextContent('WRECKED');
    expect(screen.getByTestId('gameover-root')).toHaveClass('gameover-backdrop--wrecked');
  });

  it('falls back to the live store score when runEnded never fired', () => {
    setGameOverState({ score: 4321 });
    render(<GameOver />);
    expect(screen.getByTestId('gameover-score')).toHaveTextContent('4,321');
  });

  it('shows the map seed and the retry/garage control hint', () => {
    setGameOverState({ seed: 99 });
    render(<GameOver />);
    expect(screen.getByTestId('gameover-seed')).toHaveTextContent('Seed 99');
    expect(screen.getByTestId('gameover-controls')).toHaveTextContent(
      'R — retry same city · G — garage',
    );
  });

  it('shows progress toward the next unlock, driven by persisted lifetimeScore', () => {
    localStorage.setItem(
      'smashy6ix:progress',
      JSON.stringify({ v: 1, bestScore: 0, lifetimeScore: 0 }),
    );
    setGameOverState();
    render(<GameOver />);
    expect(screen.getByTestId('gameover-unlocks')).toHaveTextContent(
      `${UNLOCKS.streetRacer.toLocaleString('en-US')} pts to unlock Street Racer`,
    );
  });

  it('shows "All cars unlocked" once every threshold is cleared', () => {
    localStorage.setItem(
      'smashy6ix:progress',
      JSON.stringify({ v: 1, bestScore: 0, lifetimeScore: UNLOCKS.redRocket }),
    );
    setGameOverState();
    render(<GameOver />);
    expect(screen.getByTestId('gameover-unlocks')).toHaveTextContent('All cars unlocked');
  });

  it('does not show the unlock toast when no car was unlocked this run', () => {
    setGameOverState();
    render(<GameOver />);
    expect(screen.queryByTestId('gameover-unlock-toast')).not.toBeInTheDocument();
  });

  it('shows an "UNLOCKED: <name>" toast for a car crossed this run', () => {
    gameEvents.emit('runStarted', { seed: 1 });
    gameEvents.emit('carUnlocked', { carId: 'pickup' });
    setGameOverState();
    render(<GameOver />);
    expect(screen.getByTestId('gameover-unlock-toast')).toHaveTextContent('UNLOCKED: Pickup');
  });

  it('queues multiple unlocks crossed in the same run', () => {
    gameEvents.emit('runStarted', { seed: 1 });
    gameEvents.emit('carUnlocked', { carId: 'streetRacer' });
    gameEvents.emit('carUnlocked', { carId: 'pickup' });
    setGameOverState();
    render(<GameOver />);
    expect(screen.getByTestId('gameover-unlock-toast')).toHaveTextContent(
      'UNLOCKED: Street Racer · UNLOCKED: Pickup',
    );
  });

  it('reads best score from persistence AFTER runEnded (includes the run that just ended)', () => {
    gameEvents.emit('runEnded', { score: 900, reason: 'wrecked' });
    // Mirrors what state/persistence.ts's recordRunEnd (subscribed via
    // initProgressPersistence at game mount, wired ahead of this run in the real app)
    // would have already written to localStorage by the time this run's runEnded fires —
    // exercised directly here to keep this a focused component test.
    localStorage.setItem(
      'smashy6ix:progress',
      JSON.stringify({ v: 1, bestScore: 900, lifetimeScore: 900 }),
    );
    setGameOverState();
    render(<GameOver />);
    expect(screen.getByTestId('gameover-best')).toHaveTextContent('900');
  });

  it('the root overlay never intercepts pointer events (never blocks the site header)', () => {
    setGameOverState();
    render(<GameOver />);
    expect(screen.getByTestId('gameover-root')).toHaveStyle({ pointerEvents: 'none' });
  });
});

describe('GameOver — coarse-pointer tap buttons (Phase 18 Task 1)', () => {
  it('does not render Retry/Garage buttons on a fine-pointer (desktop) device', () => {
    stubCoarsePointer(false);
    setGameOverState();
    render(<GameOver />);
    expect(screen.queryByTestId('gameover-retry-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('gameover-garage-btn')).not.toBeInTheDocument();
    // Keyboard hint text stays for desktop either way.
    expect(screen.getByTestId('gameover-controls')).toHaveTextContent(
      'R — retry same city · G — garage',
    );
  });

  it('renders tappable Retry/Garage buttons on a coarse-pointer device', () => {
    stubCoarsePointer(true);
    setGameOverState();
    render(<GameOver />);
    expect(screen.getByTestId('gameover-retry-btn')).toBeInTheDocument();
    expect(screen.getByTestId('gameover-garage-btn')).toBeInTheDocument();
    // The keyboard hint stays too, per the task brief ("keyboard hints stay for desktop").
    expect(screen.getByTestId('gameover-controls')).toBeInTheDocument();
  });

  it('tapping Retry transitions GAMEOVER -> PLAYING', () => {
    stubCoarsePointer(true);
    setGameOverState();
    render(<GameOver />);
    fireEvent.click(screen.getByTestId('gameover-retry-btn'));
    expect(useGameStore.getState().machine).toBe('PLAYING');
  });

  it('tapping Garage transitions GAMEOVER -> GARAGE', () => {
    stubCoarsePointer(true);
    setGameOverState();
    render(<GameOver />);
    fireEvent.click(screen.getByTestId('gameover-garage-btn'));
    expect(useGameStore.getState().machine).toBe('GARAGE');
  });
});
