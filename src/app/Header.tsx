import { Link, NavLink } from 'react-router';
import { IconGitHub, IconLinkedIn, IconPortfolio, IconResume } from './icons';
import './Header.css';

const GITHUB_URL = 'https://github.com/Derran05W';

// LinkedIn: no real profile URL exists yet — this is an explicit, flagged placeholder
// (open item for the user, see CLAUDE.md "Open Questions" / Phase 20). Intentionally
// NOT a real linkedin.com URL so it can't be mistaken for a working link.
const LINKEDIN_PLACEHOLDER_HREF = '#linkedin-placeholder';

function navLinkClassName({ isActive }: { isActive: boolean }): string {
  return isActive ? 'site-header__link is-active' : 'site-header__link';
}

export default function Header() {
  return (
    <header className="site-header">
      <Link to="/" className="site-header__wordmark">
        Derran
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

        <a className="site-header__link" href={GITHUB_URL} target="_blank" rel="noreferrer noopener">
          <IconGitHub />
          <span>
            GitHub <span className="visually-hidden">(opens in a new tab)</span>
          </span>
        </a>
      </nav>
    </header>
  );
}
