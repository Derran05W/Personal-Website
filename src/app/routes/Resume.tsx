import { SITE } from '../content/site';
import './Resume.css';

export default function Resume() {
  const path = SITE.resumePdfPath;

  if (!path) {
    // PLACEHOLDER state: no résumé file exists yet (Phase 20, per CLAUDE.md). The
    // download control stays visible but disabled — proving the layout/copy is ready —
    // rather than hiding it, so there's nothing to silently wire up later.
    return (
      <section className="resume">
        <h1>Résumé</h1>
        <div className="resume__pending" data-testid="resume-pending">
          <p className="resume__intro">
            The résumé PDF hasn't been uploaded yet — this page is wired up and ready
            for it.
          </p>
          <button
            type="button"
            className="button resume__download resume__download--disabled"
            disabled
            title="No résumé file is available yet"
          >
            Download résumé (PDF) — coming soon
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="resume">
      <h1>Résumé</h1>
      <p className="resume__intro">Download or preview the résumé below.</p>

      <a className="button resume__download" href={path} download>
        Download résumé (PDF)
      </a>

      {/* Mobile Safari frequently fails to render embedded PDFs (both <object> and
          <iframe> can end up blank there) — an always-visible second download link sits
          right next to the embed so there's never a dead end on iOS. */}
      <p className="resume__mobile-note">
        Viewing on an iPhone or iPad and the preview below looks blank? Use the download
        link above, or{' '}
        <a href={path} download>
          this one
        </a>
        , instead.
      </p>

      <object className="resume__embed" data={path} type="application/pdf" aria-label="Résumé PDF preview">
        <iframe src={path} title="Résumé PDF preview" className="resume__embed-frame">
          <p className="resume__fallback">
            Your browser can&rsquo;t preview PDFs inline.{' '}
            <a href={path} download>
              Download the résumé (PDF)
            </a>{' '}
            instead.
          </p>
        </iframe>
      </object>
    </section>
  );
}
