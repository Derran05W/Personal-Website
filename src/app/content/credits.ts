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

/** One real-world brand referenced by the logo pixel atlas (game/world/toronto/logoAtlas.ts):
 * the Phase 24 bank brands on the King×Bay financial-cluster towers, plus the Phase 26
 * retail/nostalgia brands from places.json on storefront FASCIA signage (and the Sam the
 * Record Man rooftop-sign prop). CLAUDE.md's locked "Brand logos (map layer)" decision (user
 * override 2026-07-17) requires every referenced brand to carry a trademark note here —
 * pixel-art homage, not an official asset. */
export interface BrandTrademarkEntry {
  /** The real corporate/brand name being referenced. */
  name: string;
  /** Plain-language note: how it's depicted in the game, plus the trademark disclaimer. */
  note: string;
}

export interface CreditsContent {
  /** "Made with" colophon — the open-source tech powering the site + game. */
  tech: CreditEntry[];
  assets: AssetCredits;
  /** Unaffiliated/stylized-homage disclaimer (TDD §14 non-goals; landmarks are fictionalized). */
  disclaimer: string;
  /** Short note on the game's title/branding. */
  gameTitleNote: string;
  /** Real brands stylized as 32×32 pixel-art logos in the Toronto map layer: the five Phase 24
   * bank brands plus the fifteen Phase 26 retail/nostalgia brands (places.json). */
  brandTrademarks: BrandTrademarkEntry[];
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
    'Smashy the 6ix is a stylized homage, not an affiliate, partner, or representation of ' +
    'any real city, business, government agency, or person. Every landmark in the game ' +
    '(the tower, the stadium, the market district, and so on) is a fictionalized, ' +
    'low-poly silhouette built from public knowledge of Toronto’s skyline — not a ' +
    'scan, model, or trademarked likeness of a real structure. Police and military units ' +
    'use generic markings ("POLICE" in a plain typeface, flat colors) rather than any real ' +
    "department's insignia.",
  gameTitleNote:
    '"Smashy the 6ix" is this project’s own working title, not a licensed or third-party name.',
  brandTrademarks: [
    {
      name: 'TD Bank Group',
      note: [
        "Referenced as an original 32×32 pixel-art homage on the map's financial-district",
        'towers, for Toronto-cityscape flavour — a simplified, hand-drawn wordmark, never a',
        "traced or exact reproduction of the real mark. TD's trademarks belong to TD Bank",
        'Group; no affiliation, sponsorship, or endorsement is implied, and no official TD',
        'assets were used.',
      ].join(' '),
    },
    {
      name: 'RBC (Royal Bank of Canada)',
      note: [
        "Referenced as an original 32×32 pixel-art homage on the map's financial-district",
        'towers, for Toronto-cityscape flavour — a simplified, hand-drawn wordmark, never a',
        "traced or exact reproduction of the real mark. RBC's trademarks belong to Royal Bank",
        'of Canada; no affiliation, sponsorship, or endorsement is implied, and no official',
        'RBC assets were used.',
      ].join(' '),
    },
    {
      name: 'BMO (Bank of Montreal)',
      note: [
        "Referenced as an original 32×32 pixel-art homage on the map's financial-district",
        'towers, for Toronto-cityscape flavour — a simplified, hand-drawn wordmark, never a',
        "traced or exact reproduction of the real mark. BMO's trademarks belong to the Bank of",
        'Montreal; no affiliation, sponsorship, or endorsement is implied, and no official BMO',
        'assets were used.',
      ].join(' '),
    },
    {
      name: 'CIBC',
      note: [
        "Referenced as an original 32×32 pixel-art homage on the map's financial-district",
        'towers, for Toronto-cityscape flavour — a simplified, hand-drawn wordmark, never a',
        "traced or exact reproduction of the real mark. CIBC's trademarks belong to the",
        'Canadian Imperial Bank of Commerce; no affiliation, sponsorship, or endorsement is',
        'implied, and no official CIBC assets were used.',
      ].join(' '),
    },
    {
      name: 'Scotiabank',
      note: [
        "Referenced as an original 32×32 pixel-art homage on the map's financial-district",
        'towers, for Toronto-cityscape flavour — a simplified, hand-drawn wordmark/glyph,',
        "never a traced or exact reproduction of the real mark. Scotiabank's trademarks",
        'belong to The Bank of Nova Scotia; no affiliation, sponsorship, or endorsement is',
        'implied, and no official Scotiabank assets were used.',
      ].join(' '),
    },
    {
      name: "McDonald's",
      note: [
        'Referenced as an original 32×32 pixel-art homage (a gold "M" — the golden arches) on',
        "the map's storefront FASCIA signage, for Toronto-cityscape flavour — a simplified,",
        "hand-drawn glyph, never a traced or exact reproduction of the real mark. McDonald's",
        "trademarks belong to McDonald's Corporation; no affiliation, sponsorship, or",
        "endorsement is implied, and no official McDonald's assets were used.",
      ].join(' '),
    },
    {
      name: 'Tim Hortons (Restaurant Brands)',
      note: [
        'Referenced as an original 32×32 pixel-art homage (a red oval band + a simplified',
        "\"T\") on the map's storefront FASCIA signage, for Toronto-cityscape flavour — never",
        "a traced or exact reproduction of the real mark. Tim Hortons' trademarks belong to",
        'Restaurant Brands International; no affiliation, sponsorship, or endorsement is',
        'implied, and no official Tim Hortons assets were used.',
      ].join(' '),
    },
    {
      name: 'H Mart',
      note: [
        'Referenced as an original 32×32 pixel-art homage (a white "H MART" wordmark on red)',
        "on the map's storefront FASCIA signage, for Toronto-cityscape flavour — a simplified,",
        "hand-drawn wordmark, never a traced or exact reproduction of the real mark. H Mart's",
        'trademarks belong to its owner; no affiliation, sponsorship, or endorsement is',
        'implied, and no official H Mart assets were used.',
      ].join(' '),
    },
    {
      name: 'Loblaws (Loblaw Companies)',
      note: [
        'Referenced as an original 32×32 pixel-art homage (an orange stylized "L") on the',
        "map's storefront FASCIA signage, for Toronto-cityscape flavour — a simplified,",
        "hand-drawn glyph, never a traced or exact reproduction of the real mark. Loblaws'",
        'trademarks belong to Loblaw Companies Limited; no affiliation, sponsorship, or',
        'endorsement is implied, and no official Loblaws assets were used.',
      ].join(' '),
    },
    {
      name: 'Yonge Street Warehouse',
      note: [
        'Referenced as an original 32×32 pixel-art homage (a white "WAREHOUSE" wordmark on',
        "black) on the map's storefront FASCIA signage, for Toronto-cityscape flavour — a",
        'simplified, hand-drawn wordmark, never a traced or exact reproduction of the real',
        "sign. Yonge Street Warehouse's (and Queen St. Warehouse's) trademarks belong to their",
        'owner; no affiliation, sponsorship, or endorsement is implied, and no official',
        'Warehouse assets were used.',
      ].join(' '),
    },
    {
      name: 'The Alley',
      note: [
        'Referenced as an original 32×32 pixel-art homage (a white stag-head silhouette on',
        "dark) on the map's storefront FASCIA signage, for Toronto-cityscape flavour — a",
        'simplified, hand-drawn glyph, never a traced or exact reproduction of the real mark.',
        "The Alley's trademarks belong to its owner; no affiliation, sponsorship, or",
        'endorsement is implied, and no official The Alley assets were used.',
      ].join(' '),
    },
    {
      name: 'Uncle Tetsu',
      note: [
        'Referenced as an original 32×32 pixel-art homage (a round yellow smiling face) plus a',
        "decorative queue prop outside its storefront — the lineup IS the landmark — for",
        'Toronto-cityscape flavour, never a traced or exact reproduction of the real mark.',
        "Uncle Tetsu's trademarks belong to its owner; no affiliation, sponsorship, or",
        'endorsement is implied, and no official Uncle Tetsu assets were used.',
      ].join(' '),
    },
    {
      name: 'Konjiki Ramen',
      note: [
        'Referenced as an original 32×32 pixel-art homage (a gold circle + wavy "noodle"',
        "strokes) plus a decorative queue prop outside its storefront, for Toronto-cityscape",
        'flavour, never a traced or exact reproduction of the real mark. Konjiki Ramen\'s',
        'trademarks belong to its owner; no affiliation, sponsorship, or endorsement is',
        'implied, and no official Konjiki Ramen assets were used.',
      ].join(' '),
    },
    {
      name: 'Real Sports (MLSE)',
      note: [
        'Referenced as an original 32×32 pixel-art homage (a white "REAL"/"SPORTS" wordmark on',
        "blue) on the map's storefront FASCIA signage, for Toronto-cityscape flavour — a",
        'simplified, hand-drawn wordmark, never a traced or exact reproduction of the real',
        "mark. Real Sports Bar & Grill's trademarks belong to Maple Leaf Sports & Entertainment",
        '(MLSE); no affiliation, sponsorship, or endorsement is implied, and no official Real',
        'Sports assets were used.',
      ].join(' '),
    },
    {
      name: 'MEC',
      note: [
        'Referenced as an original 32×32 pixel-art homage (a green mountain triangle) on the',
        "map's storefront FASCIA signage, for Toronto-cityscape flavour — a simplified,",
        "hand-drawn glyph, never a traced or exact reproduction of the real mark. MEC's",
        '(Mountain Equipment Company) trademarks belong to its owner; no affiliation,',
        'sponsorship, or endorsement is implied, and no official MEC assets were used.',
      ].join(' '),
    },
    {
      name: 'The Rec Room (Cineplex)',
      note: [
        'Referenced as an original 32×32 pixel-art homage (a red "REC"/"ROOM" block-letter',
        "wordmark) on the map's storefront FASCIA signage, for Toronto-cityscape flavour — a",
        'simplified, hand-drawn wordmark, never a traced or exact reproduction of the real',
        "mark. The Rec Room's trademarks belong to Cineplex Entertainment; no affiliation,",
        'sponsorship, or endorsement is implied, and no official Rec Room assets were used.',
      ].join(' '),
    },
    {
      name: 'Apple',
      note: [
        'Referenced as an original 32×32 pixel-art homage (a white apple silhouette with a',
        "leaf) on the map's storefront FASCIA signage, for Toronto-cityscape flavour — a",
        'simplified, hand-drawn glyph, never a traced or exact reproduction of the real mark.',
        "Apple's trademarks belong to Apple Inc.; no affiliation, sponsorship, or endorsement",
        'is implied, and no official Apple assets were used.',
      ].join(' '),
    },
    {
      name: 'Sam the Record Man (historic sign homage)',
      note: [
        'Referenced as an original pixel-art homage: two animated 32×32 neon-disc atlas frames',
        '(discA/discB, alternated to read as a spin) on a rooftop prop near Yonge & Dundas —',
        "not a building, a decorative sign prop — for Toronto-cityscape flavour and nostalgia,",
        'never a traced or exact reproduction of the real historic sign. The Sam the Record Man',
        "sign's trademarks (where still asserted) belong to their owner; no affiliation,",
        'sponsorship, or endorsement is implied, and no official Sam the Record Man assets',
        'were used.',
      ].join(' '),
    },
    {
      name: 'Alo Restaurant',
      note: [
        'Referenced as an original 32×32 pixel-art homage (a small, deliberately understated',
        '"ALO" plaque) on the map\'s storefront FASCIA signage, for Toronto-cityscape flavour',
        '— a simplified, hand-drawn wordmark, never a traced or exact reproduction of the real',
        "mark. Alo Restaurant's trademarks belong to its owner; no affiliation, sponsorship,",
        'or endorsement is implied, and no official Alo assets were used.',
      ].join(' '),
    },
    {
      name: 'Buk Chang Dong Soon Tofu',
      note: [
        'Referenced as an original 32×32 pixel-art homage: a generic, geometric hangul-STYLE',
        "glyph block (deliberately NOT a real word or character) on the map's storefront",
        'FASCIA signage, for Toronto-cityscape flavour, never a traced or exact reproduction',
        "of the real sign. Buk Chang Dong Soon Tofu's trademarks belong to its owner; no",
        'affiliation, sponsorship, or endorsement is implied, and no official Buk Chang Dong',
        'Soon Tofu assets were used.',
      ].join(' '),
    },
  ],
};
