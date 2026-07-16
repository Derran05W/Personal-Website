import { Link } from 'react-router';
import './NotFound.css';

export default function NotFound() {
  return (
    <section className="not-found">
      <h1>404</h1>
      <p>This page doesn't exist.</p>
      <Link to="/" className="button">
        Back to home
      </Link>
    </section>
  );
}
