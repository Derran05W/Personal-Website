import { Fragment } from 'react';
import { Link } from 'react-router';
import { CREDITS } from '../content/credits';
import './Credits.css';

export default function Credits() {
  return (
    <section className="credits">
      <h1>Credits</h1>
      <p className="credits__intro">
        Everything this site and game are built from: the open-source tech powering it,
        and an honest account of every visual and audio asset.
      </p>

      <h2 className="credits__section-title">Made with</h2>
      <ul className="credits__tech-list">
        {CREDITS.tech.map((entry) => (
          <li key={entry.name} className="credits__tech-item">
            <div className="credits__tech-heading">
              <a href={entry.url} target="_blank" rel="noreferrer noopener" className="credits__tech-name">
                {entry.name} <span className="visually-hidden">(opens in a new tab)</span>
              </a>
              <span className="credits__tech-license">{entry.license}</span>
            </div>
            <p className="credits__tech-role">{entry.role}</p>
          </li>
        ))}
      </ul>

      <h2 className="credits__section-title">Assets</h2>
      <div className="credits__assets">
        <p data-testid="credits-models-statement">{CREDITS.assets.models}</p>
        <p data-testid="credits-audio-statement">{CREDITS.assets.audio}</p>
        <p data-testid="credits-fonts-statement">
          Font:{' '}
          {CREDITS.assets.fonts.map((font, index) => (
            <Fragment key={font.name}>
              {index > 0 ? ', ' : ''}
              <a href={font.url} target="_blank" rel="noreferrer noopener">
                {font.name} <span className="visually-hidden">(opens in a new tab)</span>
              </a>{' '}
              ({font.license})
            </Fragment>
          ))}
          . Self-hosted — no external font requests.
        </p>
      </div>

      <h2 className="credits__section-title">A note on all this</h2>
      <p className="credits__disclaimer" data-testid="credits-disclaimer">
        {CREDITS.disclaimer}
      </p>
      <p className="credits__title-note" data-testid="credits-title-note">
        {CREDITS.gameTitleNote}
      </p>

      <Link to="/" className="button credits__back">
        Back to home
      </Link>
    </section>
  );
}
