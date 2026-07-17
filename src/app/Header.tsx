import { Link, NavLink } from 'react-router';
import { IconGitHub, IconLinkedIn, IconPortfolio, IconResume } from './icons';
import { SITE } from './content/site';
import './Header.css';

// LinkedIn: rendered while SITE.links.linkedin is null (real profile URL pending — see
// content/site.ts and CLAUDE.md's "Open (user input needed)" list). Intentionally NOT a
// real linkedin.com URL so it can't be mistaken for a working link.
const LINKEDIN_PLACEHOLDER_HREF = '#linkedin-placeholder';

function navLinkClassName({ isActive }: { isActive: boolean }): string {
  return isActive ? 'site-header__link is-active' : 'site-header__link';
}

export default function Header() {
  return (
    <header className="site-header">
      <Link to="/" className="site-header__wordmark">
        {SITE.name}
      </Link>

      <nav className="site-header__nav" aria-label="Primary">
        <NavLink to="/resume" className={navLinkClassName}>
          <IconResume />
          <span>Resume</span>
        </NavLink>

        <NavLink to="/portfolio" className={navLinkClassName}>
          <IconPortfolio />
          <span>Portfolio</span>
        </NavLink>

        {SITE.links.linkedin ? (
          <a className="site-header__link" href={SITE.links.linkedin} target="_blank" rel="noreferrer noopener">
            <IconLinkedIn />
            <span>
              LinkedIn <span className="visually-hidden">(opens in a new tab)</span>
            </span>
          </a>
        ) : (
          <a
            className="site-header__link site-header__link--placeholder"
            href={LINKEDIN_PLACEHOLDER_HREF}
            title="Placeholder — real LinkedIn URL pending"
          >
            <IconLinkedIn />
            <span>
              LinkedIn <em className="site-header__soon">soon</em>{' '}
              <span className="visually-hidden">— placeholder link, not connected yet</span>
            </span>
          </a>
        )}

        <a className="site-header__link" href={SITE.links.github} target="_blank" rel="noreferrer noopener">
          <IconGitHub />
          <span>
            GitHub <span className="visually-hidden">(opens in a new tab)</span>
          </span>
        </a>
      </nav>
    </header>
  );
}
