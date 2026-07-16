// Small inline SVG icons for the header links. Hand-authored (not copied brand marks) to
// avoid both a new icon-library dependency and any trademark-reproduction ambiguity — the
// adjacent link text is what identifies the destination; these are just glyphs.
// All icons: 20x20 viewBox, single-color via `currentColor`, decorative (visible label
// text next to each carries the accessible name, so the SVGs themselves are aria-hidden).

export function IconResume() {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" focusable="false">
      <path
        d="M5 2.5h7l3 3v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-14a1 1 0 0 1 1-1Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path d="M12 2.5v3h3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M6.5 11h7M6.5 13.5h7M6.5 16h4.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

export function IconPortfolio() {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" focusable="false">
      <rect x="2.5" y="3" width="6.5" height="6.5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <rect x="11" y="3" width="6.5" height="6.5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <rect x="2.5" y="10.5" width="6.5" height="6.5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <rect x="11" y="10.5" width="6.5" height="6.5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

export function IconLinkedIn() {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" focusable="false">
      <rect x="2" y="2" width="16" height="16" rx="3" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="6.3" cy="6.3" r="1.1" fill="currentColor" />
      <path d="M6.3 9v6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path
        d="M9.5 15V9m0 0c0-1.4 1-2.2 2.3-2.2S14 7.6 14 9v6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconGitHub() {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" focusable="false">
      <path
        d="M10 2a8 8 0 0 0-2.53 15.59c.4.07.55-.17.55-.38v-1.49c-2.23.48-2.7-1.06-2.7-1.06-.36-.93-.89-1.17-.89-1.17-.72-.5.06-.49.06-.49.8.06 1.23.83 1.23.83.71 1.23 1.87.87 2.33.67.07-.52.28-.87.5-1.07-1.78-.2-3.65-.9-3.65-3.98 0-.88.31-1.6.83-2.16-.08-.2-.36-1.02.08-2.13 0 0 .67-.22 2.2.83a7.5 7.5 0 0 1 4 0c1.53-1.05 2.2-.83 2.2-.83.44 1.11.16 1.93.08 2.13.52.56.83 1.28.83 2.16 0 3.09-1.87 3.77-3.66 3.97.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8 8 0 0 0 10 2Z"
        fill="currentColor"
      />
    </svg>
  );
}
