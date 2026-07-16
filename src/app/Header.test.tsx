import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import Header from './Header';

const GITHUB_HREF = 'https://github.com/Derran05W';
const LINKEDIN_PLACEHOLDER_HREF = '#linkedin-placeholder';

// Accessible names as computed from Header.tsx's actual markup (all content-derived —
// no aria-label overrides, so visible text always matches the accessible name):
//  - Resume / Portfolio: icon is aria-hidden, so the name comes from the visible
//    "Resume" / "Portfolio" label text alone.
//  - LinkedIn: visible "LinkedIn soon" plus an adjacent visually-hidden explanation
//    span (still present in the accessibility tree, just visually clipped).
//  - GitHub: icon is aria-hidden; the name is built from the visible "GitHub" text
//    plus the adjacent visually-hidden "(opens in a new tab)" span.
const LINKEDIN_NAME = 'LinkedIn soon — placeholder link, not connected yet';
const GITHUB_NAME = 'GitHub (opens in a new tab)';

// Header renders react-router's <Link>/<NavLink>, which need router context to render
// at all. MemoryRouter is react-router's standard lightweight wrapper for exactly this
// case (a component that only needs Link/NavLink context, not real route matching).
function renderHeader() {
  render(
    <MemoryRouter initialEntries={['/']}>
      <Header />
    </MemoryRouter>,
  );
}

describe('Header', () => {
  it('renders the wordmark', () => {
    renderHeader();
    expect(screen.getByText('Derran')).toBeInTheDocument();
  });

  it('renders all four link items with the correct accessible names', () => {
    renderHeader();
    expect(screen.getByRole('link', { name: 'Resume' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Portfolio' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: LINKEDIN_NAME })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: GITHUB_NAME })).toBeInTheDocument();
  });

  it('points the Resume and Portfolio links at the right internal paths', () => {
    renderHeader();
    expect(screen.getByRole('link', { name: 'Resume' })).toHaveAttribute('href', '/resume');
    expect(screen.getByRole('link', { name: 'Portfolio' })).toHaveAttribute('href', '/portfolio');
  });

  it("has GitHub's real href, exactly", () => {
    renderHeader();
    expect(screen.getByRole('link', { name: GITHUB_NAME })).toHaveAttribute('href', GITHUB_HREF);
  });

  it("has LinkedIn's placeholder href, not a real URL", () => {
    renderHeader();
    const linkedin = screen.getByRole('link', { name: LINKEDIN_NAME });
    expect(linkedin).toHaveAttribute('href', LINKEDIN_PLACEHOLDER_HREF);
    expect(linkedin.getAttribute('href')).not.toMatch(/^https?:\/\//);
  });
});
