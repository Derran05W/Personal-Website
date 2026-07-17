import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import Footer from './Footer';

describe('Footer', () => {
  it('renders a Credits link pointing at /credits', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <Footer />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: 'Credits' })).toHaveAttribute('href', '/credits');
  });
});
