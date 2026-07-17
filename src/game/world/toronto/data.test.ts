// Map data schema gate (MAP PROJECT: CLAUDE.md) — wired into CI via pnpm test.
//
// Validates the four data/toronto/*.json files against this module's own validators
// (src/game/world/toronto/data.ts), plus a battery of malformed-fixture negative cases per
// validator. Reads the real files directly off disk (not a static import — see data.ts's
// header comment for why the validators stay JSON-import-free); `process.cwd()` is the repo
// root, same idiom as src/app/content/credits.test.ts.
//
// NOTE ON THE REAL FILES: data/toronto/anchors.json is being actively patched by a
// researcher across concurrent rounds (the map-researcher agent / tools/research/
// run_researchers.py), so these tests assert STRUCTURE only — never entry counts,
// ordering, or specific coordinate values, none of which are contractual.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateAnchors, validateBuildingSpecs, validateModelSources, validatePlaces } from './data';

function readJson(relPath: string): unknown {
  const abs = resolve(process.cwd(), relPath);
  return JSON.parse(readFileSync(abs, 'utf-8')) as unknown;
}

describe('the real data/toronto/*.json files pass their validators', () => {
  it('anchors.json validates', () => {
    const parsed = readJson('data/toronto/anchors.json');
    expect(() => validateAnchors(parsed)).not.toThrow();
  });

  it('building-specs.json validates', () => {
    const parsed = readJson('data/toronto/building-specs.json');
    expect(() => validateBuildingSpecs(parsed)).not.toThrow();
  });

  it('places.json validates', () => {
    const parsed = readJson('data/toronto/places.json');
    expect(() => validatePlaces(parsed)).not.toThrow();
  });

  it('model-sources.json validates', () => {
    const parsed = readJson('data/toronto/model-sources.json');
    expect(() => validateModelSources(parsed)).not.toThrow();
  });
});

describe('validateAnchors — negative cases', () => {
  const baseMeta = { purpose: 'test fixture' };

  it('rejects a "verified" anchor with a null lat', () => {
    const bad = {
      _meta: baseMeta,
      anchors: [
        { id: 'a', name: 'A', kind: 'yonge_line', lat: null, lon: -79.4, src: 'test', status: 'verified' },
      ],
    };
    expect(() => validateAnchors(bad)).toThrow(/lat/);
  });

  it('rejects a "verified" anchor with an out-of-range lon', () => {
    const bad = {
      _meta: baseMeta,
      anchors: [
        { id: 'a', name: 'A', kind: 'yonge_line', lat: 43.7, lon: -60, src: 'test', status: 'verified' },
      ],
    };
    expect(() => validateAnchors(bad)).toThrow(/lon/);
  });

  it('rejects an unknown kind', () => {
    const bad = {
      _meta: baseMeta,
      anchors: [{ id: 'a', name: 'A', kind: 'diagonal', lat: null, lon: null, src: '', status: 'needs_agent' }],
    };
    expect(() => validateAnchors(bad)).toThrow(/kind/);
  });
});

describe('validateBuildingSpecs — negative cases', () => {
  const baseMeta = { source: 'test fixture', curve: {}, footprint_rule: 'test' };

  function validBuilding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'b1',
      name: 'Test Building',
      real_h_m: 100,
      floors: 10,
      expected_game_h_wu: 20,
      footprint_wu: 10,
      material: 'glass_black',
      confidence: 'high',
      notes: 'n',
      ...overrides,
    };
  }

  it('rejects an unknown material', () => {
    const bad = { _meta: baseMeta, buildings: [validBuilding({ material: 'glass_pink' })] };
    expect(() => validateBuildingSpecs(bad)).toThrow(/material/);
  });

  it('rejects a duplicate id', () => {
    const bad = { _meta: baseMeta, buildings: [validBuilding(), validBuilding()] };
    expect(() => validateBuildingSpecs(bad)).toThrow(/duplicate/);
  });

  it('rejects a non-positive real_h_m', () => {
    const bad = { _meta: baseMeta, buildings: [validBuilding({ real_h_m: 0 })] };
    expect(() => validateBuildingSpecs(bad)).toThrow(/real_h_m/);
  });
});

describe('validatePlaces — negative cases', () => {
  function validPlace(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      name: 'Test Place',
      address: '1 Test St',
      zone: 'downtown',
      category: 'test_category',
      status: 'knowledge',
      brand_color: '#123abc',
      building_look: 'test look',
      logo_hint: 'test hint',
      recognizability: 2,
      ...overrides,
    };
  }

  it('rejects a malformed hex brand_color', () => {
    const bad = { _meta: {}, places: [validPlace({ brand_color: 'red' })] };
    expect(() => validatePlaces(bad)).toThrow(/brand_color/);
  });

  it('rejects an unknown zone', () => {
    const bad = { _meta: {}, places: [validPlace({ zone: 'etobicoke' })] };
    expect(() => validatePlaces(bad)).toThrow(/zone/);
  });

  it('rejects an out-of-range recognizability', () => {
    const bad = { _meta: {}, places: [validPlace({ recognizability: 5 })] };
    expect(() => validatePlaces(bad)).toThrow(/recognizability/);
  });
});

describe('validateModelSources — negative cases', () => {
  function validSource(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 's1',
      name: 'Test Source',
      url_hint: null,
      formats: ['DXF'],
      license: 'MIT',
      decision: 'do the thing',
      status: 'knowledge',
      src: 'test spec',
      ...overrides,
    };
  }

  it('rejects an empty license', () => {
    const bad = { _meta: {}, sources: [validSource({ license: '' })] };
    expect(() => validateModelSources(bad)).toThrow(/license/);
  });

  it('rejects an empty decision', () => {
    const bad = { _meta: {}, sources: [validSource({ decision: '' })] };
    expect(() => validateModelSources(bad)).toThrow(/decision/);
  });
});
