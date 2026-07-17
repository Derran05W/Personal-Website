import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// Proves the wiring is correct the moment a real resumePdfPath lands, without touching
// the real (still-null) content module. vi.mock is hoisted above imports by Vitest, so
// this file's Resume import below always sees the mocked SITE — keep this mock isolated
// to its own test file (see Resume.test.tsx for the real, current null-path behavior).
vi.mock('../content/site', () => ({
  SITE: { resumePdfPath: '/resume.pdf' },
}));

describe('Resume — resumePdfPath present (mocked content module)', () => {
  it('renders a prominent download link pointing at the real path', async () => {
    const { default: Resume } = await import('./Resume');
    render(<Resume />);

    const link = screen.getByRole('link', { name: 'Download résumé (PDF)' });
    expect(link).toHaveAttribute('href', '/resume.pdf');
    expect(link).toHaveAttribute('download');
  });

  it('renders the PDF embed and drops the pending state', async () => {
    const { default: Resume } = await import('./Resume');
    render(<Resume />);

    expect(screen.getByLabelText('Résumé PDF preview')).toBeInTheDocument();
    expect(screen.queryByTestId('resume-pending')).not.toBeInTheDocument();
  });

  it('keeps an always-visible mobile-Safari fallback note next to the embed', async () => {
    const { default: Resume } = await import('./Resume');
    render(<Resume />);

    expect(screen.getByText(/iPhone or iPad/i)).toBeInTheDocument();
  });
});
