import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import Portfolio from './Portfolio';
import { PROJECTS } from '../content/site';

describe('Portfolio', () => {
  it('renders one card per PROJECTS entry, from the content module', () => {
    render(<Portfolio />);
    for (const project of PROJECTS) {
      expect(screen.getByTestId(`portfolio-card-${project.id}`)).toBeInTheDocument();
    }
  });

  it('renders the title and blurb for each card', () => {
    render(<Portfolio />);
    for (const project of PROJECTS) {
      const card = screen.getByTestId(`portfolio-card-${project.id}`);
      expect(within(card).getByText(project.title)).toBeInTheDocument();
      expect(within(card).getByText(project.blurb)).toBeInTheDocument();
    }
  });

  it('shows a "draft — pending confirmation" badge on every unverified card (all seeded entries are unverified)', () => {
    render(<Portfolio />);
    const unverified = PROJECTS.filter((p) => p.unverified);
    expect(unverified.length).toBeGreaterThan(0);
    for (const project of unverified) {
      const card = screen.getByTestId(`portfolio-card-${project.id}`);
      expect(within(card).getByTestId('portfolio-draft-badge')).toHaveTextContent(
        'Draft — pending confirmation',
      );
    }
  });

  it('renders a working repo link, opening in a new tab, when links.repo is present', () => {
    render(<Portfolio />);
    for (const project of PROJECTS) {
      if (!project.links.repo) continue;
      const card = screen.getByTestId(`portfolio-card-${project.id}`);
      const link = within(card).getByRole('link', { name: new RegExp(`View repo.*${project.title}`, 'i') });
      expect(link).toHaveAttribute('href', project.links.repo);
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
    }
  });

  it('renders tag chips for each card that has tags', () => {
    render(<Portfolio />);
    for (const project of PROJECTS) {
      if (project.tags.length === 0) continue;
      const card = screen.getByTestId(`portfolio-card-${project.id}`);
      for (const tag of project.tags) {
        expect(within(card).getByText(tag)).toBeInTheDocument();
      }
    }
  });

  it('never claims an unverified entry is confirmed (no card is missing the draft badge)', () => {
    render(<Portfolio />);
    // Every seeded PROJECTS entry is currently unverified — assert the grid doesn't
    // silently render any of them without the badge.
    const badges = screen.getAllByTestId('portfolio-draft-badge');
    expect(badges).toHaveLength(PROJECTS.filter((p) => p.unverified).length);
  });
});
