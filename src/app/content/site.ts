// Phase 20 content layer (Task 3) — typed, single source of truth for the header
// wordmark, portfolio project cards, and résumé link. Every route (`Header.tsx`,
// `routes/Portfolio.tsx`, `routes/Resume.tsx`) reads from this module instead of
// hardcoding copy, so real content drops in here with zero component changes.
//
// THE USER HAS NOT SUPPLIED REAL CONTENT YET. See CLAUDE.md's "Open (user input
// needed)" list: name/branding, résumé PDF, portfolio project write-ups, and LinkedIn
// URL are all still pending. Nothing below — aside from values explicitly marked
// "real"/"confirmed" — is a verified fact about the user or their work. Do not add new
// claims, links, or descriptions to this file without the user's say-so.

export interface SiteLinks {
  /** Real, confirmed (CLAUDE.md: "GitHub is Derran05W (real, usable)"). Safe to link live. */
  github: string;
  /** PLACEHOLDER. Null until the user supplies a real LinkedIn profile URL. */
  linkedin: string | null;
  /** PLACEHOLDER. Null — no public contact email confirmed yet. */
  email: string | null;
}

export interface SiteContent {
  /** Header wordmark / page-title fragment. PLACEHOLDER ("Derran") per CLAUDE.md until the user says otherwise. */
  name: string;
  /** Hero/meta one-liner. PLACEHOLDER — not a confirmed bio claim. */
  tagline: string;
  /** The game's title. Confirmed — see CLAUDE.md's project header. */
  gameTitle: string;
  links: SiteLinks;
  /** Path (under /public) to a résumé PDF. PLACEHOLDER (null) — no file uploaded yet. */
  resumePdfPath: string | null;
}

/* PHASE 20 USER GATE: every field below marked PLACEHOLDER requires user confirmation. */
export const SITE: SiteContent = {
  name: 'Derran',
  tagline: 'PLACEHOLDER — tagline pending user input.',
  gameTitle: 'Smashy the 6ix',
  links: {
    github: 'https://github.com/Derran05W',
    linkedin: null, // TODO(user): real LinkedIn profile URL
    email: null, // TODO(user): contact email, if one should be published
  },
  resumePdfPath: null, // TODO(user): drop resume.pdf into /public and set this path
};

export interface ProjectEntry {
  /** Stable key for lists — the repo slug, lowercased. */
  id: string;
  title: string;
  /** Human-readable prose. Placeholder entries are PLACEHOLDER-prefixed — see `unverified`. */
  blurb: string;
  tags: string[];
  links: {
    repo?: string;
    live?: string;
  };
  /** Optional screenshot/thumbnail path; entries without one render the shared skyline placeholder graphic. */
  image?: string;
  /**
   * True when this entry itself is an unconfirmed guess (repo-name inference only — the
   * user has not verified the project exists, what it does, or that it belongs here).
   * `Portfolio.tsx` renders a visible "draft" badge whenever this is true. Never render
   * an `unverified: true` entry as if it were confirmed.
   */
  unverified: boolean;
  /** True when `tags` are conservative guesses, not user-confirmed skill/stack claims. */
  tagsPlaceholder: boolean;
}

/* PHASE 20 USER GATE: every entry below requires user confirmation.
   Seeded from repo *names only* (the likely-candidate repos noted for this session) —
   nothing about what these repos actually contain, do, or demonstrate has been
   confirmed by the user. Blurbs are neutral one-line guesses derived solely from the
   repo name. Do NOT add descriptions, outcomes, tech-stack claims, screenshots, or
   links beyond the bare repo URL without explicit user confirmation. */
export const PROJECTS: ProjectEntry[] = [
  {
    id: 'reel-rank',
    title: 'reel-rank',
    blurb:
      'PLACEHOLDER — owner to confirm: repo name suggests a tool for ranking or rating video reels/clips.',
    tags: ['ranking', 'media'],
    links: { repo: 'https://github.com/Derran05W/reel-rank' },
    unverified: true,
    tagsPlaceholder: true,
  },
  {
    id: 'vector-db',
    title: 'vector-db',
    blurb:
      'PLACEHOLDER — owner to confirm: repo name suggests a vector database or similarity-search project.',
    tags: ['database', 'search'],
    links: { repo: 'https://github.com/Derran05W/vector-db' },
    unverified: true,
    tagsPlaceholder: true,
  },
  {
    id: 'concurrent-roaring-bitset',
    title: 'Concurrent-Roaring-Bitset',
    blurb:
      'PLACEHOLDER — owner to confirm: repo name suggests a concurrent/thread-safe Roaring Bitset data structure implementation.',
    tags: ['data-structures', 'concurrency'],
    links: { repo: 'https://github.com/Derran05W/Concurrent-Roaring-Bitset' },
    unverified: true,
    tagsPlaceholder: true,
  },
  {
    id: 'petsupplies-api',
    title: 'petsupplies-api',
    blurb:
      'PLACEHOLDER — owner to confirm: repo name suggests a backend API for a pet-supplies application.',
    tags: ['api', 'backend'],
    links: { repo: 'https://github.com/Derran05W/petsupplies-api' },
    unverified: true,
    tagsPlaceholder: true,
  },
];
