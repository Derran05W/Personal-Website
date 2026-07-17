import { Link } from 'react-router';
import SkylineHero from '../SkylineHero';
import './NotFound.css';

export default function NotFound() {
  return (
    <SkylineHero heading="Wrong turn" className="not-found">
      <p className="not-found__code" aria-hidden="true">
        404
      </p>
      <p className="not-found__message">
        This road doesn&rsquo;t go anywhere &mdash; the page you&rsquo;re looking for
        doesn&rsquo;t exist.
      </p>
      <div className="not-found__actions">
        <Link to="/" className="button">
          Back to home
        </Link>
        <Link to="/portfolio" className="not-found__secondary-link">
          View the portfolio
        </Link>
      </div>
    </SkylineHero>
  );
}
