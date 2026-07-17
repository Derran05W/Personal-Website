import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { gameEvents } from '../../state/events';
import { getGameState, useGameStore } from '../../state/store';
import { PROGRESS_STORAGE_KEY } from '../../state/persistence';
import { UNLOCKS } from '../../config/unlocks';
import { __resetNewBadgesForTests } from './newBadge';
import { Garage } from './Garage';

const initialState = useGameStore.getState();

beforeEach(() => {
  localStorage.clear();
  useGameStore.setState(initialState, true);
  __resetNewBadgesForTests();
});

describe('Garage', () => {
  it('renders all six cars, with rustySedan selected by default', () => {
    render(<Garage />);
    for (const id of Object.keys(UNLOCKS)) {
      expect(screen.getByTestId(`garage-card-${id}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId('garage-card-rustySedan')).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows locked cards dimmed with a threshold + progress readout', () => {
    render(<Garage />);
    const streetRacer = screen.getByTestId('garage-card-streetRacer');
    expect(streetRacer).toHaveClass('garage-card--locked');
    expect(streetRacer).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('garage-lock-streetRacer')).toHaveTextContent(
      `Locked — ${UNLOCKS.streetRacer.toLocaleString('en-US')} pts`,
    );
  });

  it('clicking an unlocked card selects it', () => {
    render(<Garage />);
    fireEvent.click(screen.getByTestId('garage-card-rustySedan'));
    expect(getGameState().selectedCarId).toBe('rustySedan');
  });

  it('clicking a locked card is a no-op (selection stays on the current car)', () => {
    render(<Garage />);
    fireEvent.click(screen.getByTestId('garage-card-streetRacer'));
    expect(getGameState().selectedCarId).toBe('rustySedan');
  });

  it('an unlocked car becomes clickable and selectable once carUnlocked fires', () => {
    render(<Garage />);
    act(() => {
      gameEvents.emit('carUnlocked', { carId: 'streetRacer' });
    });
    fireEvent.click(screen.getByTestId('garage-card-streetRacer'));
    expect(getGameState().selectedCarId).toBe('streetRacer');
  });

  it('shows the selected highlight via aria-pressed', () => {
    gameEvents.emit('carUnlocked', { carId: 'pickup' });
    getGameState().selectCar('pickup');
    render(<Garage />);
    expect(screen.getByTestId('garage-card-pickup')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('garage-card-rustySedan')).toHaveAttribute('aria-pressed', 'false');
  });

  it('ArrowRight moves focus to the next card', () => {
    render(<Garage />);
    const first = screen.getByTestId('garage-card-rustySedan');
    const second = screen.getByTestId('garage-card-streetRacer');
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    expect(second).toHaveFocus();
  });

  it('ArrowDown moves focus down a row', () => {
    render(<Garage />);
    const first = screen.getByTestId('garage-card-rustySedan'); // index 0
    const belowFirst = screen.getByTestId('garage-card-schoolBus'); // index 3 (row 2, col 0)
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(belowFirst).toHaveFocus();
  });

  it('"New city" rerolls the seed and persists it immediately as lastSeed', () => {
    render(<Garage />);
    fireEvent.click(screen.getByTestId('garage-new-city'));
    const seedAfter = getGameState().seed;
    const stored = JSON.parse(localStorage.getItem(PROGRESS_STORAGE_KEY) ?? 'null');
    expect(stored.lastSeed).toBe(seedAfter);
  });

  it('"Start driving" transitions GARAGE -> PLAYING', () => {
    getGameState().transition('LOADING');
    getGameState().transition('GARAGE');
    render(<Garage />);
    fireEvent.click(screen.getByTestId('garage-start'));
    expect(getGameState().machine).toBe('PLAYING');
  });

  it('shows a NEW badge on a car unlocked this session, cleared on first selection', () => {
    // carUnlocked fires (module state records "pickup is new") strictly BEFORE the garage
    // is ever mounted in production (see hud/garage/newBadge.ts) — mirrored here by
    // emitting before render, so CarCard's initial useState read picks it up.
    gameEvents.emit('carUnlocked', { carId: 'pickup' });
    render(<Garage />);

    expect(screen.getByTestId('garage-new-pickup')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('garage-card-pickup'));

    expect(screen.queryByTestId('garage-new-pickup')).not.toBeInTheDocument();
  });

  it('never shows a NEW badge on a still-locked car', () => {
    render(<Garage />);
    expect(screen.queryByTestId('garage-new-streetRacer')).not.toBeInTheDocument();
  });
});
