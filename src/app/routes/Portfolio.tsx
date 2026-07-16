import './Portfolio.css';

// Placeholder slot count only — NOT real project data. Real project write-ups land at
// Phase 20 (CLAUDE.md: "Open, user input needed"). This route exists to prove out the
// grid layout, not to stand in for actual content.
const PLACEHOLDER_PROJECT_SLOTS = [1, 2, 3, 4, 5, 6];

export default function Portfolio() {
  return (
    <section className="portfolio">
      <h1>Portfolio</h1>
      <p className="portfolio__intro">
        Real project write-ups aren't here yet — this is the grid they'll land in.
      </p>
      <ul className="portfolio__grid">
        {PLACEHOLDER_PROJECT_SLOTS.map((slot) => (
          <li key={slot} className="portfolio__card">
            <div className="portfolio__card-thumb" aria-hidden="true" />
            <h2 className="portfolio__card-title">Project slot {slot}</h2>
            <p className="portfolio__card-body">Project details coming soon.</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
