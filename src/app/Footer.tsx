import { Link } from 'react-router';
import './Footer.css';

// Phase 20 Task 2: the header (site-header, 64px, 4 nav items + wordmark) already ships
// a dedicated mobile breakpoint (Header.css, <480px) that strips link labels down to
// icon-only specifically to avoid overflow — it's engineered right up to its capacity
// for exactly four links. Rather than risk a fifth icon tipping that over on small
// phones, Credits gets a small, low-emphasis footer-style link instead (per the task
// brief's explicit "footer-style placement if the header is tight" escape hatch).
export default function Footer() {
  return (
    <footer className="site-footer">
      <Link to="/credits" className="site-footer__link">
        Credits
      </Link>
    </footer>
  );
}
