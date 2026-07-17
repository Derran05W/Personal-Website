import { describe, expect, it } from 'vitest';
import { PROJECTS, SITE } from './site';

describe('SITE content shape', () => {
  it('has the confirmed, real GitHub link (CLAUDE.md: "GitHub is Derran05W (real, usable)")', () => {
    expect(SITE.links.github).toBe('https://github.com/Derran05W');
    expect(SITE.links.github).toMatch(/^https:\/\//);
  });

  it('keeps LinkedIn and email as unset placeholders, not invented links', () => {
    expect(SITE.links.linkedin).toBeNull();
    expect(SITE.links.email).toBeNull();
  });

  it('keeps resumePdfPath unset until a real PDF is supplied', () => {
    expect(SITE.resumePdfPath).toBeNull();
  });

  it('carries the confirmed game title exactly', () => {
    expect(SITE.gameTitle).toBe('Smashy the 6ix');
  });

  it('marks the placeholder name/tagline as non-empty strings (renderable, not silently blank)', () => {
    expect(typeof SITE.name).toBe('string');
    expect(SITE.name.length).toBeGreaterThan(0);
    expect(typeof SITE.tagline).toBe('string');
    expect(SITE.tagline.length).toBeGreaterThan(0);
  });
});

describe('PROJECTS content shape', () => {
  it('is non-empty (seeded with placeholder candidates)', () => {
    expect(PROJECTS.length).toBeGreaterThan(0);
  });

  it('has unique ids', () => {
    const ids = PROJECTS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every entry has the required fields with correct shapes', () => {
    for (const project of PROJECTS) {
      expect(typeof project.id).toBe('string');
      expect(project.id.length).toBeGreaterThan(0);
      expect(typeof project.title).toBe('string');
      expect(project.title.length).toBeGreaterThan(0);
      expect(typeof project.blurb).toBe('string');
      expect(Array.isArray(project.tags)).toBe(true);
      expect(typeof project.links).toBe('object');
      expect(typeof project.unverified).toBe('boolean');
      expect(typeof project.tagsPlaceholder).toBe('boolean');
    }
  });

  it('every seeded entry is marked unverified and tagsPlaceholder (none are user-confirmed yet)', () => {
    for (const project of PROJECTS) {
      expect(project.unverified).toBe(true);
      expect(project.tagsPlaceholder).toBe(true);
    }
  });

  it('every unverified entry\'s blurb is loudly marked PLACEHOLDER — never presented as confirmed', () => {
    for (const project of PROJECTS) {
      if (project.unverified) {
        expect(project.blurb.startsWith('PLACEHOLDER')).toBe(true);
      }
    }
  });

  it('repo links, when present, point at the real Derran05W namespace only', () => {
    for (const project of PROJECTS) {
      if (project.links.repo) {
        expect(project.links.repo).toMatch(/^https:\/\/github\.com\/Derran05W\//);
      }
    }
  });

  it('includes the four seeded candidate repos by id', () => {
    const ids = PROJECTS.map((p) => p.id);
    expect(ids).toEqual(
      expect.arrayContaining(['reel-rank', 'vector-db', 'concurrent-roaring-bitset', 'petsupplies-api']),
    );
  });
});
