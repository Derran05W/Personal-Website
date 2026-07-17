import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import Resume from './Resume';

// SITE.resumePdfPath is null in the real content module today (no PDF uploaded yet —
// see content/site.ts). This file exercises exactly that, real, current default.
// See Resume.pathPresent.test.tsx for the "path is set" branch (mocked content module).
describe('Resume — resumePdfPath null (current, real default)', () => {
  it('renders the "coming soon" pending state, not a broken embed', () => {
    render(<Resume />);
    expect(screen.getByTestId('resume-pending')).toBeInTheDocument();
    expect(screen.getByText(/hasn't been uploaded yet/i)).toBeInTheDocument();
  });

  it('renders the download control disabled, with an explanatory title, and no href to 404 against', () => {
    render(<Resume />);
    const button = screen.getByRole('button', { name: /download résumé \(pdf\) — coming soon/i });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', expect.stringContaining('No résumé file'));
  });

  it('renders no PDF embed and no live download link when no path is set', () => {
    render(<Resume />);
    expect(screen.queryByLabelText('Résumé PDF preview')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /download résumé/i })).not.toBeInTheDocument();
  });
});
