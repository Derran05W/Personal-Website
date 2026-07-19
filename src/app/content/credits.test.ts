// Cross-checks CREDITS (the /credits route's data source) against package.json so the
// colophon can't silently drift from what's actually installed: add a new runtime
// dependency and forget to credit it, and DEPENDENCY_COVERAGE below will be missing a
// key and this test fails loudly. Reads package.json directly off disk (not a static
// `import … from '../../../package.json'`) so this file needs no `resolveJsonModule`
// change to the shared tsconfig. `process.cwd()` is the repo root — vitest (via
// vite.config.ts, itself at the repo root) always runs from there.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CREDITS } from './credits';

interface PackageJsonShape {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}

const packageJsonPath = resolve(process.cwd(), 'package.json');
const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as PackageJsonShape;

// Every `dependencies` entry in package.json must be accounted for here. Value = the
// exact CREDITS.tech `name` that covers it, or `null` for a dependency that is
// deliberately unused at runtime and therefore intentionally absent from the tech
// colophon (documented instead in `assets.audio` — see phase-15-notes.md).
const DEPENDENCY_COVERAGE: Record<string, string | null> = {
  '@react-three/drei': '@react-three/drei',
  '@react-three/fiber': '@react-three/fiber',
  '@react-three/rapier': '@react-three/rapier',
  '@vercel/analytics': '@vercel/analytics',
  howler: null,
  leva: 'Leva',
  react: 'React',
  'react-dom': 'React', // same project/license/repo as `react` — one colophon entry covers both
  'react-router': 'React Router',
  three: 'three.js',
  zustand: 'Zustand',
};

// Build-tooling devDependencies worth crediting even though they never ship to the
// browser (per the task brief: "vite ... react").
const DEV_TOOLING_COVERAGE: Record<string, string> = {
  typescript: 'TypeScript',
  vite: 'Vite',
};

function techNames(): string[] {
  return CREDITS.tech.map((entry) => entry.name);
}

describe('CREDITS.tech — shape', () => {
  it('every entry has a non-empty name, role, license, and a real https URL', () => {
    expect(CREDITS.tech.length).toBeGreaterThan(0);
    for (const entry of CREDITS.tech) {
      expect(entry.name.length).toBeGreaterThan(0);
      expect(entry.role.length).toBeGreaterThan(0);
      expect(entry.license.length).toBeGreaterThan(0);
      expect(entry.url).toMatch(/^https:\/\//);
    }
  });

  it('has unique names (no accidental duplicate entries)', () => {
    const names = techNames();
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('CREDITS.tech — coverage vs package.json dependencies', () => {
  it('accounts for every runtime dependency in package.json', () => {
    for (const dep of Object.keys(pkg.dependencies)) {
      expect(Object.keys(DEPENDENCY_COVERAGE)).toContain(dep);
    }
  });

  it('credits every dependency that IS used, by exact name', () => {
    for (const [dep, creditName] of Object.entries(DEPENDENCY_COVERAGE)) {
      expect(pkg.dependencies).toHaveProperty(dep);
      if (creditName !== null) {
        expect(techNames()).toContain(creditName);
      }
    }
  });

  it('deliberately does NOT credit howler in the tech colophon (unused at runtime)', () => {
    expect(techNames()).not.toContain('howler');
    expect(techNames().join(' ').toLowerCase()).not.toContain('howler');
  });

  it('credits the build-tooling devDependencies named in the task brief', () => {
    for (const [dep, creditName] of Object.entries(DEV_TOOLING_COVERAGE)) {
      expect(pkg.devDependencies).toHaveProperty(dep);
      expect(techNames()).toContain(creditName);
    }
  });

  it('credits the Rapier physics engine itself, not just the React bindings', () => {
    const rapierCore = CREDITS.tech.find((entry) => entry.name === 'Rapier');
    expect(rapierCore).toBeDefined();
    expect(rapierCore?.license).toBe('Apache-2.0');
  });
});

describe('CREDITS.assets — honesty statement', () => {
  it('states player-shipped models are procedural (still true post-25.5: the pack is dev-only)', () => {
    expect(CREDITS.assets.models.toLowerCase()).toContain('procedural');
  });

  it('acknowledges the Phase 25.5 asset pack rather than still claiming EVERY model is procedural', () => {
    // Phase 25.5 (D13): a third-party GLB collection entered the pipeline behind a
    // dev-only, default-off toggle — the old "every model is procedural" claim would now
    // be false, so the statement must point the reader at the pack's own credit instead.
    expect(CREDITS.assets.models.toLowerCase()).toMatch(/asset pack/);
  });

  it('states every sound is synthesized via Web Audio, and discloses howler is unused', () => {
    expect(CREDITS.assets.audio.toLowerCase()).toContain('synthesized');
    expect(CREDITS.assets.audio.toLowerCase()).toContain('web audio');
    expect(CREDITS.assets.audio.toLowerCase()).toContain('howler');
  });

  it('credits the self-hosted Fredoka font with its real OFL license', () => {
    expect(CREDITS.assets.fonts.length).toBeGreaterThan(0);
    const fredoka = CREDITS.assets.fonts.find((f) => f.name.includes('Fredoka'));
    expect(fredoka).toBeDefined();
    expect(fredoka?.license).toMatch(/Open Font License/);
    expect(fredoka?.url).toMatch(/^https:\/\//);
  });
});

describe('CREDITS.assetPacks — Phase 32 city-pack licence confirmation (Part-8 licence gate)', () => {
  it('has at least one entry (never silently empty — a pack in the pipeline always shows up here)', () => {
    expect(CREDITS.assetPacks.length).toBeGreaterThan(0);
  });

  it('the city asset pack entry exists with a confirmed status (Phase 32 — pending badge dropped)', () => {
    const pack = CREDITS.assetPacks.find((p) => p.name.includes('City asset pack'));
    expect(pack).toBeDefined();
    expect(pack?.licenseStatus).toBe('confirmed');
  });

  it('no pack entry is still pending-user-confirmation', () => {
    expect(CREDITS.assetPacks.some((p) => p.licenseStatus === 'pending-user-confirmation')).toBe(false);
  });

  it('the confirmed entry states it is open-source, used with permission, and dated', () => {
    const pack = CREDITS.assetPacks.find((p) => p.name.includes('City asset pack'));
    expect(pack).toBeDefined();
    const note = pack!.note.toLowerCase();
    expect(note).toContain('open-source');
    expect(note).toContain('used with permission');
    expect(note).toContain('2026-07-18');
  });

  it('every assetPacks entry has a non-empty name and note', () => {
    for (const pack of CREDITS.assetPacks) {
      expect(pack.name.length).toBeGreaterThan(0);
      expect(pack.note.length).toBeGreaterThan(0);
    }
  });
});

describe('CREDITS.brandTrademarks — Phase 24 bank + Phase 26 retail/nostalgia atlas trademark notes', () => {
  const EXPECTED_BANK_BRANDS = [
    'TD Bank Group',
    'RBC (Royal Bank of Canada)',
    'BMO (Bank of Montreal)',
    'CIBC',
    'Scotiabank',
  ];

  const EXPECTED_RETAIL_BRANDS = [
    "McDonald's",
    'Tim Hortons (Restaurant Brands)',
    'H Mart',
    'Loblaws (Loblaw Companies)',
    'Yonge Street Warehouse',
    'The Alley',
    'Uncle Tetsu',
    'Konjiki Ramen',
    'Real Sports (MLSE)',
    'MEC',
    'The Rec Room (Cineplex)',
    'Apple',
    'Sam the Record Man (historic sign homage)',
    'Alo Restaurant',
    'Buk Chang Dong Soon Tofu',
  ];

  // Phase 31 (Part-8 D1/D3): the TTC transit-route homage entry, appended after the Phase 26 set.
  const EXPECTED_TRANSIT_BRANDS = ['TTC (Toronto Transit Commission)'];

  const EXPECTED_BRANDS = [...EXPECTED_BANK_BRANDS, ...EXPECTED_RETAIL_BRANDS, ...EXPECTED_TRANSIT_BRANDS];

  it('covers exactly the five Phase-24 bank brands, the fifteen Phase-26 retail/nostalgia brands, and the Phase-31 TTC entry', () => {
    expect(CREDITS.brandTrademarks.map((entry) => entry.name)).toEqual(EXPECTED_BRANDS);
  });

  it('has exactly 21 entries', () => {
    expect(CREDITS.brandTrademarks.length).toBe(21);
  });

  it('has unique brand names', () => {
    const names = CREDITS.brandTrademarks.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every entry states it is a homage, not an official asset, with no affiliation implied', () => {
    for (const entry of CREDITS.brandTrademarks) {
      const note = entry.note.toLowerCase();
      expect(note, entry.name).toContain('pixel-art');
      expect(note, entry.name).toContain('homage');
      expect(note, entry.name).toMatch(/no affiliation|no.*affiliation/);
      expect(note, entry.name).toContain('trademark');
      expect(note, entry.name).toMatch(/no official .* assets? (were )?used/);
    }
  });
});

describe('CREDITS — disclaimer and title note', () => {
  it('states the unaffiliated/stylized-homage disclaimer', () => {
    expect(CREDITS.disclaimer.toLowerCase()).toContain('not');
    expect(CREDITS.disclaimer.toLowerCase()).toMatch(/affiliat|homage/);
    expect(CREDITS.disclaimer.toLowerCase()).toContain('fictionalized');
  });

  it('has a non-empty game-title note', () => {
    expect(CREDITS.gameTitleNote.length).toBeGreaterThan(0);
  });
});
