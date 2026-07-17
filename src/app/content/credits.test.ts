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
  it('states every model is procedural', () => {
    expect(CREDITS.assets.models.toLowerCase()).toContain('procedural');
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
