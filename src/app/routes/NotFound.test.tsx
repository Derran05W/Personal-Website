import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import NotFound from './NotFound';

function renderNotFound() {
  render(
    <MemoryRouter initialEntries={['/this-does-not-exist']}>
      <NotFound />
    </MemoryRouter>,
  );
}

describe('NotFound route', () => {
  it('renders the on-brand "wrong turn" heading', () => {
    renderNotFound();
    expect(screen.getByRole('heading', { level: 1, name: 'Wrong turn' })).toBeInTheDocument();
  });

  it('shows the 404 code', () => {
    renderNotFound();
    expect(screen.getByText('404')).toBeInTheDocument();
  });

  it('links back home', () => {
    renderNotFound();
    expect(screen.getByRole('link', { name: 'Back to home' })).toHaveAttribute('href', '/');
  });

  it('links to the portfolio', () => {
    renderNotFound();
    expect(screen.getByRole('link', { name: 'View the portfolio' })).toHaveAttribute('href', '/portfolio');
  });
});
