import './Resume.css';

// Placeholder path — no real resume file exists yet (Phase 20, per CLAUDE.md). The
// embed and download button both point here on purpose so the wiring is provably
// correct the moment a real /public/resume.pdf lands; today it 404s, which the
// <object> fallback content below explains.
const RESUME_PATH = '/resume.pdf';

export default function Resume() {
  return (
    <section className="resume">
      <h1>Résumé</h1>
      <p className="resume__intro">
        The PDF isn't uploaded yet — this page is wired up and ready for it.
      </p>

      <a className="button" href={RESUME_PATH} download>
        Download résumé (PDF)
      </a>

      <object className="resume__embed" data={RESUME_PATH} type="application/pdf" aria-label="Résumé PDF preview">
        <p className="resume__fallback">
          No résumé is uploaded yet, so there's nothing to preview here. Check back
          later, or use the download button above once it's available.
        </p>
      </object>
    </section>
  );
}
