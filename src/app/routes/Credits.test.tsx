import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import Credits from './Credits';
import { CREDITS } from '../content/credits';

function renderCredits() {
  render(
    <MemoryRouter initialEntries={['/credits']}>
      <Credits />
    </MemoryRouter>,
  );
}

describe('Credits route', () => {
  it('renders a heading', () => {
    renderCredits();
    expect(screen.getByRole('heading', { level: 1, name: 'Credits' })).toBeInTheDocument();
  });

  it('lists every tech credit with a working link to its real URL', () => {
    renderCredits();
    for (const entry of CREDITS.tech) {
      const link = screen.getByRole('link', { name: `${entry.name} (opens in a new tab)` });
      expect(link).toHaveAttribute('href', entry.url);
    }
  });

  it('states every model is procedural', () => {
    renderCredits();
    expect(screen.getByTestId('credits-models-statement')).toHaveTextContent(/procedural/i);
  });

  it('states every sound is synthesized', () => {
    renderCredits();
    expect(screen.getByTestId('credits-audio-statement')).toHaveTextContent(/synthesized/i);
  });

  it('credits the self-hosted font', () => {
    renderCredits();
    expect(screen.getByTestId('credits-fonts-statement')).toHaveTextContent('Fredoka');
  });

  it('shows the Phase 25.5 asset-pack entry with a visible "licence pending" status', () => {
    renderCredits();
    const items = screen.getAllByTestId('credits-pack-item');
    expect(items.length).toBe(CREDITS.assetPacks.length);
    for (const pack of CREDITS.assetPacks) {
      expect(screen.getByText(pack.name)).toBeInTheDocument();
      expect(screen.getByText(pack.note)).toBeInTheDocument();
    }
    const statuses = screen.getAllByTestId('credits-pack-status');
    expect(statuses.length).toBeGreaterThan(0);
    for (const status of statuses) {
      expect(status).toHaveTextContent('licence pending');
    }
  });

  it('lists every brand-trademark entry with its full note', () => {
    renderCredits();
    for (const entry of CREDITS.brandTrademarks) {
      expect(screen.getByText(entry.name)).toBeInTheDocument();
      expect(screen.getByText(entry.note)).toBeInTheDocument();
    }
  });

  it('shows the unaffiliated/stylized-homage disclaimer', () => {
    renderCredits();
    expect(screen.getByTestId('credits-disclaimer')).toHaveTextContent(/not.*affiliat/i);
    expect(screen.getByTestId('credits-disclaimer')).toHaveTextContent(/fictionalized/i);
  });

  it('shows the game-title note', () => {
    renderCredits();
    expect(screen.getByTestId('credits-title-note')).toBeInTheDocument();
  });

  it('has a working back-to-home link', () => {
    renderCredits();
    expect(screen.getByRole('link', { name: 'Back to home' })).toHaveAttribute('href', '/');
  });
});
