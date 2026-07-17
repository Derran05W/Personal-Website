// Phase 20 content layer (Task 2) — typed, single source of truth for the /credits
// route. CLAUDE.md's asset-credits convention ("Every non-CC0 asset gets an entry in
// assets/credits.json") was written before we knew how the asset pipeline would land;
// see phase-05-notes.md and phase-15-notes.md for the actual outcome: kenney.nl/
// freesound were unreachable from this sandbox for the whole build, so EVERY visual and
// audio asset in the shipped game is procedural/synthesized, authored directly in code.
// There is nothing fetched, downloaded, or third-party to credit for models/audio — this
// module documents that honestly instead of inventing a fetch pipeline that never ran.
//
// What *is* real and owed credit: the open-source libraries the game and site are built
// on, and the one self-hosted font. Every URL below was verified against the installed
// package's own `package.json`/npm registry metadata or its repository's LICENSE file
// during this session — nothing here is guessed.

export interface CreditEntry {
  /** Library/asset name as commonly known. */
  name: string;
  /** What it's used for in this project, in plain language. */
  role: string;
  /** SPDX license identifier (or a short human-readable license name for non-SPDX cases). */
  license: string;
  /** Real, verified homepage or source-repository URL. Never invented. */
  url: string;
}

export interface AssetCredits {
  /** Honest statement covering every 3D model in the game. */
  models: string;
  /** Honest statement covering every sound in the game. */
  audio: string;
  /** Fonts actually shipped (self-hosted, not a CDN request). */
  fonts: CreditEntry[];
}

export interface CreditsContent {
  /** "Made with" colophon — the open-source tech powering the site + game. */
  tech: CreditEntry[];
  assets: AssetCredits;
  /** Unaffiliated/stylized-homage disclaimer (TDD §14 non-goals; landmarks are fictionalized). */
  disclaimer: string;
  /** Short note on the game's title/branding. */
  gameTitleNote: string;
}

export const CREDITS: CreditsContent = {
  tech: [
    {
      name: 'React',
      role: 'UI library for the portfolio shell and HUD',
      license: 'MIT',
      url: 'https://github.com/facebook/react',
    },
    {
      name: 'React Router',
      role: 'Client-side routing between the home/portfolio/résumé/credits pages',
      license: 'MIT',
      url: 'https://github.com/remix-run/react-router',
    },
    {
      name: 'TypeScript',
      role: 'Strict static typing across the whole codebase',
      license: 'Apache-2.0',
      url: 'https://github.com/microsoft/TypeScript',
    },
    {
      name: 'Vite',
      role: 'Dev server and production build/bundler',
      license: 'MIT',
      url: 'https://github.com/vitejs/vite',
    },
    {
      name: 'three.js',
      role: 'WebGL 3D renderer underneath the driving game',
      license: 'MIT',
      url: 'https://github.com/mrdoob/three.js',
    },
    {
      name: '@react-three/fiber',
      role: 'React renderer for three.js — the game scene graph',
      license: 'MIT',
      url: 'https://github.com/pmndrs/react-three-fiber',
    },
    {
      name: '@react-three/drei',
      role: 'Helper components/hooks for react-three-fiber (loaders, camera helpers, etc.)',
      license: 'MIT',
      url: 'https://github.com/pmndrs/drei',
    },
    {
      name: '@react-three/rapier',
      role: 'React bindings for the Rapier physics engine',
      license: 'MIT',
      url: 'https://github.com/pmndrs/react-three-rapier',
    },
    {
      name: 'Rapier',
      role: 'The physics engine itself (raycast vehicle controller, collisions, ragdoll props)',
      license: 'Apache-2.0',
      url: 'https://rapier.rs',
    },
    {
      name: 'Zustand',
      role: 'Game state store (state machine, heat/score, settings)',
      license: 'MIT',
      url: 'https://github.com/pmndrs/zustand',
    },
    {
      name: 'Leva',
      role: 'Developer debug/tuning panel — development builds only, stripped from production',
      license: 'MIT',
      url: 'https://github.com/pmndrs/leva',
    },
    {
      name: '@vercel/analytics',
      role: 'Privacy-respecting page/event analytics (loaded only in production, off during tests)',
      license: 'MIT',
      url: 'https://github.com/vercel/analytics',
    },
  ],
  assets: {
    models: [
      'Every 3D model in the game — every car, building, prop, pedestrian-free street',
      'fixture, police/military unit, and landmark — is procedural: built from primitive',
      'geometry authored directly in code, not downloaded or imported from any asset',
      'library. The original plan was to source CC0 kits from Kenney.nl/Quaternius/Poly',
      'Pizza (see the project README), but those hosts were unreachable from the build',
      'environment for the entire project, so the fallback (100% procedural geometry)',
      'became the shipped path for every asset rather than a partial one.',
    ].join(' '),
    audio: [
      'Every sound in the game — engine notes, sirens, impacts, gunfire, explosions,',
      'transformer hums/zaps, ambience, and UI stingers — is synthesized in real time',
      'with the Web Audio API, not played back from recorded audio files. howler.js is',
      'listed in package.json as the originally-planned playback layer for CC0 sound',
      'assets, but with no fetchable sound library it ended up unused; the shipped',
      'audio manager talks to the Web Audio API directly instead.',
    ].join(' '),
    fonts: [
      {
        name: 'Fredoka (Variable)',
        role: 'Display font for headings, the header wordmark, and the game HUD',
        license: 'SIL Open Font License 1.1',
        url: 'https://github.com/hafontia/Fredoka-One',
      },
    ],
  },
  disclaimer:
    "Smashy the 6ix is a stylized homage, not an affiliate, partner, or representation of " +
    'any real city, business, government agency, or person. Every landmark in the game ' +
    '(the tower, the stadium, the market district, and so on) is a fictionalized, ' +
    'low-poly silhouette built from public knowledge of Toronto’s skyline — not a ' +
    'scan, model, or trademarked likeness of a real structure. Police and military units ' +
    'use generic markings ("POLICE" in a plain typeface, flat colors) rather than any real ' +
    "department's insignia.",
  gameTitleNote:
    '"Smashy the 6ix" is this project’s own working title, not a licensed or third-party name.',
};
