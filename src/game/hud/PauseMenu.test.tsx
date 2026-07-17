import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { getGameState, useGameStore } from '../state/store';
import { __resetRunLoopForTest } from '../combat/runLoop';
import { PauseMenu } from './PauseMenu';

const initialState = useGameStore.getState();

// Deliberately NOT clearing gameEvents listeners here — state/store.ts registers its
// `carUnlocked` subscription once at module-import time (see that file), and clearing
// listeners would permanently silence it for the rest of this file. Same reasoning as
// hud/GameOver.test.tsx. None of the tests below register their own event listeners, so
// there's nothing here that needs a per-test teardown.
beforeEach(() => {
  useGameStore.setState(initialState, true);
  __resetRunLoopForTest();
});

function enterPaused(): void {
  const s = getGameState();
  s.transition('LOADING');
  s.transition('GARAGE');
  s.transition('PLAYING');
  s.transition('PAUSED');
}

describe('PauseMenu', () => {
  it('renders Resume/Garage/Restart controls and the key hint', () => {
    render(<PauseMenu />);
    expect(screen.getByTestId('pause-resume')).toHaveTextContent('Resume');
    expect(screen.getByTestId('pause-garage')).toHaveTextContent('Garage');
    expect(screen.getByTestId('pause-restart')).toHaveTextContent('Restart');
    expect(screen.getByTestId('pause-menu')).toHaveTextContent('Esc / P resume · G garage');
  });

  it('is a modal dialog with an accessible name', () => {
    render(<PauseMenu />);
    expect(screen.getByRole('dialog', { name: 'Paused' })).toBeInTheDocument();
  });

  it('Resume click transitions PAUSED -> PLAYING', () => {
    enterPaused();
    render(<PauseMenu />);
    fireEvent.click(screen.getByTestId('pause-resume'));
    expect(getGameState().machine).toBe('PLAYING');
  });

  it('Garage click transitions PAUSED -> GARAGE', () => {
    enterPaused();
    render(<PauseMenu />);
    fireEvent.click(screen.getByTestId('pause-garage'));
    expect(getGameState().machine).toBe('GARAGE');
  });

  it('Restart click lands back on PLAYING', () => {
    enterPaused();
    render(<PauseMenu />);
    fireEvent.click(screen.getByTestId('pause-restart'));
    expect(getGameState().machine).toBe('PLAYING');
  });

  it('the backdrop accepts pointer events (unlike the rest of the HUD)', () => {
    render(<PauseMenu />);
    expect(screen.getByTestId('pause-menu')).toHaveStyle({ pointerEvents: 'auto' });
  });

  it('renders a Quality selector with the current tier highlighted (Phase 18)', () => {
    render(<PauseMenu />); // default settings → 'high'
    expect(screen.getByTestId('pause-quality-high')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('pause-quality-med')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('pause-quality-low')).toHaveAttribute('aria-pressed', 'false');
  });

  it('choosing a quality tier updates the store and marks it a user pick', () => {
    render(<PauseMenu />);
    fireEvent.click(screen.getByTestId('pause-quality-low'));
    expect(getGameState().settings.quality).toBe('low');
    expect(getGameState().settings.qualitySource).toBe('user');
    // The highlight follows the new selection.
    expect(screen.getByTestId('pause-quality-low')).toHaveAttribute('aria-pressed', 'true');
  });

  it('reflects and toggles the reduced-camera-shake preference', () => {
    render(<PauseMenu />);
    const box = screen.getByTestId('pause-reduced-shake');
    expect(box).not.toBeChecked();
    fireEvent.click(box);
    expect(getGameState().settings.reducedShake).toBe(true);
    expect(screen.getByTestId('pause-reduced-shake')).toBeChecked();
  });
});
