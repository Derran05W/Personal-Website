import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useGameStore } from '../state/store';
import { gameEvents } from '../state/events';
import GameOver from './GameOver';
import { __resetLastRunEndForTests } from './gameOverRunEnd';

const initialState = useGameStore.getState();

// Deliberately NOT clearing gameEvents listeners in an afterEach here (unlike
// state/events.test.ts / store.test.ts): hud/gameOverRunEnd.ts registers its `runEnded`
// listener exactly ONCE, at module-import time, by design (see that module's doc comment) —
// `gameEvents.clearAllListeners()` would permanently wipe that production listener after
// the first test in this file, silently breaking every subsequent test's `emit('runEnded',
// ...)` call. `__resetLastRunEndForTests()` below is the correct, listener-preserving reset.
beforeEach(() => {
  localStorage.clear();
  useGameStore.setState(initialState, true);
  __resetLastRunEndForTests();
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

  it('shows the unlock-progress placeholder line', () => {
    setGameOverState();
    render(<GameOver />);
    expect(screen.getByTestId('gameover-unlocks')).toHaveTextContent(
      'Unlocks in a future update',
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
