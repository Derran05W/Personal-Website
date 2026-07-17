// Phase 13 Task 2: focused component tests for the DARK CITY banner + persistent
// indicator (Hud.tsx's DarkCityBanner/DarkCityIndicator, driven by useDarkCityState).
// Hud.tsx had no dedicated test file before this task — everything else in it was
// previously verified only via Playwright screenshots (see phase-08/09/11 notes) — so
// this file is scoped narrowly to the new behavior rather than attempting full HUD
// coverage.
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useGameStore } from '../state/store';
import { gameEvents } from '../state/events';
import Hud from './Hud';

const initialState = useGameStore.getState();

beforeEach(() => {
  useGameStore.setState(initialState, true);
  useGameStore.setState({ machine: 'PLAYING' });
});

afterEach(() => {
  gameEvents.clearAllListeners();
  vi.useRealTimers();
});

describe('Hud — DARK CITY banner + persistent indicator', () => {
  it('renders the banner element inert (not the --visible class) and no indicator before darkCity fires', () => {
    render(<Hud />);
    expect(screen.getByTestId('hud-darkcity-banner')).not.toHaveClass('hud-darkcity-banner--visible');
    expect(screen.queryByTestId('hud-darkcity-indicator')).not.toBeInTheDocument();
  });

  it('darkCity shows both the banner (--visible) and the persistent indicator', () => {
    render(<Hud />);

    act(() => {
      gameEvents.emit('darkCity', {});
    });

    expect(screen.getByTestId('hud-darkcity-banner')).toHaveClass('hud-darkcity-banner--visible');
    expect(screen.getByTestId('hud-darkcity-banner')).toHaveTextContent('DARK CITY');
    expect(screen.getByTestId('hud-darkcity-indicator')).toBeInTheDocument();
  });

  it('the banner hides itself again after ~5s, but the persistent indicator stays up', () => {
    vi.useFakeTimers();
    render(<Hud />);

    act(() => {
      gameEvents.emit('darkCity', {});
    });
    expect(screen.getByTestId('hud-darkcity-banner')).toHaveClass('hud-darkcity-banner--visible');

    act(() => {
      vi.advanceTimersByTime(4999);
    });
    expect(screen.getByTestId('hud-darkcity-banner')).toHaveClass('hud-darkcity-banner--visible');

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByTestId('hud-darkcity-banner')).not.toHaveClass('hud-darkcity-banner--visible');
    // Persistent indicator (task brief: "small text near stars") outlives the banner.
    expect(screen.getByTestId('hud-darkcity-indicator')).toBeInTheDocument();
  });

  it('runStarted resets both the banner and the persistent indicator for a new run', () => {
    vi.useFakeTimers();
    render(<Hud />);

    act(() => {
      gameEvents.emit('darkCity', {});
    });
    expect(screen.getByTestId('hud-darkcity-indicator')).toBeInTheDocument();
    expect(screen.getByTestId('hud-darkcity-banner')).toHaveClass('hud-darkcity-banner--visible');

    act(() => {
      gameEvents.emit('runStarted', { seed: 1 });
    });

    expect(screen.queryByTestId('hud-darkcity-indicator')).not.toBeInTheDocument();
    expect(screen.getByTestId('hud-darkcity-banner')).not.toHaveClass('hud-darkcity-banner--visible');
  });

  it('a fresh darkCity after a runStarted reset shows the banner again (fires once per run, not once ever)', () => {
    vi.useFakeTimers();
    render(<Hud />);

    act(() => {
      gameEvents.emit('darkCity', {});
      vi.advanceTimersByTime(5000); // let the first run's banner fully fade
    });
    act(() => {
      gameEvents.emit('runStarted', { seed: 2 });
    });
    act(() => {
      gameEvents.emit('darkCity', {});
    });

    expect(screen.getByTestId('hud-darkcity-banner')).toHaveClass('hud-darkcity-banner--visible');
    expect(screen.getByTestId('hud-darkcity-indicator')).toBeInTheDocument();
  });

  it('the banner element is aria-hidden while inactive and not aria-hidden while visible', () => {
    render(<Hud />);
    expect(screen.getByTestId('hud-darkcity-banner')).toHaveAttribute('aria-hidden', 'true');

    act(() => {
      gameEvents.emit('darkCity', {});
    });
    expect(screen.getByTestId('hud-darkcity-banner')).toHaveAttribute('aria-hidden', 'false');
  });
});

describe('Hud — pause menu (Phase 17)', () => {
  it('is not rendered while PLAYING', () => {
    useGameStore.setState({ machine: 'PLAYING' });
    render(<Hud />);
    expect(screen.queryByTestId('pause-menu')).not.toBeInTheDocument();
  });

  it('renders the pause menu while PAUSED (Hud itself stays visible/mounted too)', () => {
    useGameStore.setState({ machine: 'PAUSED' });
    render(<Hud />);
    expect(screen.getByTestId('pause-menu')).toBeInTheDocument();
    expect(screen.getByTestId('hud-root')).toBeInTheDocument();
  });
});
