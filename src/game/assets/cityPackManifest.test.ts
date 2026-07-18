// Phase 25.5 Task 2 — schema/exclusion/rename-map/drift-guard tests for the generated
// city-pack manifest (scripts/city-pack.mjs -> src/game/assets/cityPackManifest.json).
// Deliberately reads only COMMITTED paths (assets/city-pack/, public/assets/city-pack/, the
// manifest JSON) — never "City Pack.undefined-glb/" (the raw source download), which is
// gitignored/local-only per D1/D12 and will not exist in CI or a fresh clone.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CITY_PACK_MANIFEST,
  getCityPackModel,
  hasCityPackModel,
  listCityPackModels,
  type CityPackCategory,
} from './cityPackManifest';
// scripts/lib/cityPackNaming.mjs holds the PURE naming/category logic scripts/city-pack.mjs
// (the pipeline CLI) uses — split out specifically so this test can import it directly without
// pulling in city-pack.mjs's top-level `main()` (which would try to run the full asset
// pipeline as an import side effect). This is how the rename-map/kebab logic is "mirrored" (D1
// task table): rather than re-implementing the rule in the test, the test imports the SAME
// functions the generator script uses and proves they produce exactly the shipped manifest.
import { idForFile, kebabCase, categoryFor, RENAME_MAP } from '../../../scripts/lib/cityPackNaming.mjs';

const VALID_CATEGORIES: readonly CityPackCategory[] = [
  'building',
  'building-blank',
  'prop',
  'vegetation',
  'vehicle',
];

// The 52 raw source basenames the generator script normalizes (D1/D2) — hardcoded here
// (rather than read live off the gitignored source folder) so this test is self-contained in
// CI/a fresh clone. Mirrors the exact directory listing verified against the plan's measured
// pack table.
const SOURCE_BASENAMES: readonly string[] = [
  'ATM.glb',
  'Air conditioner.glb',
  'Bench.glb',
  'Bicycle.glb',
  'Big Building.glb',
  'Billboard.glb',
  'Box.glb',
  'Brown Building.glb',
  'Building Green.glb',
  'Building Red Corner.glb',
  'Building Red.glb',
  'Bus Stop.glb',
  'Bus stop sign.glb',
  'Bus.glb',
  'Car-unqqkULtRU.glb',
  'Car.glb',
  'Cone.glb',
  'Debris Papers.glb',
  'Dumpster.glb',
  'Fence End.glb',
  'Fence Piece.glb',
  'Fence.glb',
  'Fire Exit.glb',
  'Fire hydrant.glb',
  'Floor Hole.glb',
  'Flower Pot-Kgt363WkKd.glb',
  'Flower Pot.glb',
  'Gb Blank.glb',
  'Greenhouse.glb',
  'Mailbox.glb',
  'Manhole Cover.glb',
  'Motorcycle.glb',
  'Pickup Truck.glb',
  'Pizza Corner.glb',
  'Planter & Bushes.glb',
  'Police Car.glb',
  'Power Box.glb',
  'RB Blank.glb',
  'Road Bits.glb',
  'Rock band poster.glb',
  'Roof Exit.glb',
  'SUV.glb',
  'Sports Car-Gzj704DXdr.glb',
  'Sports Car.glb',
  'Stop sign.glb',
  'Traffic Light.glb',
  'Trash Can.glb',
  'Tree.glb',
  'Van.glb',
  'Washing Line.glb',
  'Yellow Post-it.glb',
  'trah bag grey.glb',
];

// The 5 excluded skinned/animated character basenames (D2, locked "Pedestrians: none") — NOT
// in SOURCE_BASENAMES above; listed here only so the exclusion test can assert idForFile still
// resolves them (proving they were dropped by the SCRIPT's filter, not because the rename
// logic itself can't handle them).
const EXCLUDED_BASENAMES: readonly string[] = [
  'Adventurer.glb',
  'Man.glb',
  'Animated Woman.glb',
  'Animated Woman-nIItLV9nxS.glb',
  'Animated Woman-qJ2gsTUBHL.glb',
];

describe('CITY_PACK_MANIFEST — schema', () => {
  it('has exactly 52 entries', () => {
    expect(CITY_PACK_MANIFEST.length).toBe(52);
  });

  it('every id is lower-kebab-case and unique', () => {
    const ids = CITY_PACK_MANIFEST.map((e) => e.id);
    for (const id of ids) {
      expect(id, id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every entry has a valid category', () => {
    for (const entry of CITY_PACK_MANIFEST) {
      expect(VALID_CATEGORIES, entry.id).toContain(entry.category);
    }
  });

  it('every entry has positive native dims, tris, and prims', () => {
    for (const entry of CITY_PACK_MANIFEST) {
      expect(entry.nativeDims.w, entry.id).toBeGreaterThan(0);
      expect(entry.nativeDims.h, entry.id).toBeGreaterThan(0);
      expect(entry.nativeDims.d, entry.id).toBeGreaterThan(0);
      expect(entry.tris, entry.id).toBeGreaterThan(0);
      expect(entry.prims, entry.id).toBeGreaterThan(0);
      expect(entry.bytes.raw, entry.id).toBeGreaterThan(0);
      expect(entry.bytes.optimized, entry.id).toBeGreaterThan(0);
      expect(entry.contentHash, entry.id).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('every url resolves to a file that exists under public/', () => {
    for (const entry of CITY_PACK_MANIFEST) {
      const filePath = resolve(process.cwd(), 'public', entry.url.replace(/^\//, ''));
      expect(existsSync(filePath), entry.url).toBe(true);
    }
  });

  it('every building / building-blank entry is exactly 1 primitive (the instancing precondition, D7)', () => {
    for (const entry of CITY_PACK_MANIFEST) {
      if (entry.category === 'building' || entry.category === 'building-blank') {
        expect(entry.prims, entry.id).toBe(1);
      }
    }
  });
});

describe('CITY_PACK_MANIFEST — exclusions (D2, locked "Pedestrians: none")', () => {
  it('contains none of the 5 excluded character ids', () => {
    const ids = new Set(CITY_PACK_MANIFEST.map((e) => e.id));
    for (const basename of EXCLUDED_BASENAMES) {
      expect(ids.has(idForFile(basename)), basename).toBe(false);
    }
  });

  it('has no id containing "man", "woman", or "adventurer"', () => {
    for (const entry of CITY_PACK_MANIFEST) {
      expect(entry.id, entry.id).not.toMatch(/\b(man|woman|adventurer)\b/);
    }
  });
});

describe('rename-map / kebab-case logic mirrors the shipped manifest', () => {
  it('idForFile(basename) for every non-excluded source file produces exactly one manifest id, with no leftovers', () => {
    const derivedIds = SOURCE_BASENAMES.map((basename) => idForFile(basename)).sort();
    const manifestIds = CITY_PACK_MANIFEST.map((e) => e.id)
      .slice()
      .sort();
    expect(derivedIds).toEqual(manifestIds);
  });

  it('the 8 explicit non-mechanical renames match the plan table exactly', () => {
    expect(RENAME_MAP).toEqual({
      'Car.glb': 'car-a',
      'Car-unqqkULtRU.glb': 'car-b',
      'Sports Car.glb': 'sports-car-a',
      'Sports Car-Gzj704DXdr.glb': 'sports-car-b',
      'Flower Pot.glb': 'flower-pot-a',
      'Flower Pot-Kgt363WkKd.glb': 'flower-pot-b',
      'trah bag grey.glb': 'trash-bag-grey',
      'Planter & Bushes.glb': 'planter-bushes',
    });
  });

  it('every other source basename kebab-cases plainly (no RENAME_MAP entry)', () => {
    for (const basename of SOURCE_BASENAMES) {
      if (basename in RENAME_MAP) continue;
      expect(idForFile(basename)).toBe(kebabCase(basename.replace(/\.glb$/i, '')));
    }
  });

  it('categoryFor assigns every manifest id the category actually shipped', () => {
    for (const entry of CITY_PACK_MANIFEST) {
      expect(categoryFor(entry.id), entry.id).toBe(entry.category);
    }
  });
});

describe('CITY_PACK_MANIFEST — drift guard', () => {
  it('every optimized file on disk hashes to exactly its manifest contentHash', () => {
    for (const entry of CITY_PACK_MANIFEST) {
      const filePath = resolve(process.cwd(), 'public', entry.url.replace(/^\//, ''));
      const bytes = readFileSync(filePath);
      const hash = createHash('sha256').update(bytes).digest('hex');
      expect(hash, `${entry.id}: manifest is stale vs disk — run \`pnpm assets:pack\``).toBe(
        entry.contentHash,
      );
    }
  });
});

describe('accessors', () => {
  it('getCityPackModel returns the right entry and throws on an unknown id', () => {
    const entry = getCityPackModel('bench');
    expect(entry.category).toBe('prop');
    expect(() => getCityPackModel('not-a-real-id')).toThrow(/unknown id/);
  });

  it('hasCityPackModel is true for real ids and false otherwise', () => {
    expect(hasCityPackModel('bench')).toBe(true);
    expect(hasCityPackModel('not-a-real-id')).toBe(false);
  });

  it('listCityPackModels filters by category and covers every entry when unfiltered', () => {
    expect(listCityPackModels().length).toBe(CITY_PACK_MANIFEST.length);
    const buildings = listCityPackModels('building');
    expect(buildings.length).toBeGreaterThan(0);
    for (const entry of buildings) {
      expect(entry.category).toBe('building');
    }
  });
});
