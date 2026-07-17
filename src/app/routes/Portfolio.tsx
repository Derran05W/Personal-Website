import type { ProjectEntry } from '../content/site';
import { PROJECTS } from '../content/site';
import './Portfolio.css';

function ProjectCard({ project }: { project: ProjectEntry }) {
  return (
    <li className="portfolio__card" data-testid={`portfolio-card-${project.id}`}>
      <div className="portfolio__card-thumb">
        {project.image ? (
          <img src={project.image} alt="" className="portfolio__card-image" />
        ) : (
          // No screenshot supplied yet — shared "skyline" motif (see Home.css
          // .home__skyline) stands in, zero image bytes.
          <div className="portfolio__card-skyline" aria-hidden="true" />
        )}
      </div>

      <div className="portfolio__card-heading">
        <h2 className="portfolio__card-title">{project.title}</h2>
        {project.unverified ? (
          <span
            className="portfolio__badge"
            data-testid="portfolio-draft-badge"
            title="Drafted from the repo name only — not yet confirmed by the site owner"
          >
            Draft — pending confirmation
          </span>
        ) : null}
      </div>

      <p className="portfolio__card-body">{project.blurb}</p>

      {project.tags.length > 0 ? (
        <ul
          className="portfolio__tags"
          aria-label={project.tagsPlaceholder ? 'Tags (unconfirmed guesses)' : 'Tags'}
        >
          {project.tags.map((tag) => (
            <li
              key={tag}
              className={
                project.tagsPlaceholder ? 'portfolio__tag portfolio__tag--placeholder' : 'portfolio__tag'
              }
            >
              {tag}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="portfolio__card-links">
        {project.links.repo ? (
          <a
            className="button portfolio__card-link"
            href={project.links.repo}
            target="_blank"
            rel="noreferrer noopener"
          >
            View repo <span className="visually-hidden">for {project.title} (opens in a new tab)</span>
          </a>
        ) : null}

        {project.links.live ? (
          <a
            className="button portfolio__card-link"
            href={project.links.live}
            target="_blank"
            rel="noreferrer noopener"
          >
            Live demo <span className="visually-hidden">for {project.title} (opens in a new tab)</span>
          </a>
        ) : null}
      </div>
    </li>
  );
}

export default function Portfolio() {
  return (
    <section className="portfolio">
      <h1>Portfolio</h1>
      <p className="portfolio__intro">
        Real project write-ups are still pending owner confirmation — the entries below
        are drafted from repo names only and are clearly marked as drafts.
      </p>

      {PROJECTS.length === 0 ? (
        <p className="portfolio__empty" data-testid="portfolio-empty">
          No projects listed yet — check back soon.
        </p>
      ) : (
        <ul className="portfolio__grid">
          {PROJECTS.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
        </ul>
      )}
    </section>
  );
}
