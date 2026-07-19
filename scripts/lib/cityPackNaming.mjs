// Phase 25.5 — pure naming/category logic shared between scripts/city-pack.mjs (the
// pipeline CLI, `pnpm assets:pack`) and src/game/assets/cityPackManifest.test.ts (the
// rename-map mirror test). Split into its own module specifically so the test can import
// these functions WITHOUT importing city-pack.mjs itself — that file runs the full
// normalize+optimize pipeline as top-level `main()` side effect on import (it's a CLI
// entrypoint, like scripts/prerender.mjs), which would be both slow and wrong to trigger
// from a vitest run. No side effects, no filesystem/network access, no top-level await here.

// The 8 non-mechanical renames (plan table, verbatim) — everything else is plain
// kebab-case of the filename.
export const RENAME_MAP = {
  'Car.glb': 'car-a',
  'Car-unqqkULtRU.glb': 'car-b',
  'Sports Car.glb': 'sports-car-a',
  'Sports Car-Gzj704DXdr.glb': 'sports-car-b',
  'Flower Pot.glb': 'flower-pot-a',
  'Flower Pot-Kgt363WkKd.glb': 'flower-pot-b',
  'trah bag grey.glb': 'trash-bag-grey',
  'Planter & Bushes.glb': 'planter-bushes',
};

export function kebabCase(basenameNoExt) {
  return basenameNoExt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function idForFile(basename) {
  if (RENAME_MAP[basename]) return RENAME_MAP[basename];
  const noExt = basename.replace(/\.glb$/i, '');
  return kebabCase(noExt);
}

// Category assignment (manifest field, D11). Buildings + blanks + vegetation + vehicles are
// enumerated explicitly (small, closed sets pulled from the plan's measured table); every
// other id defaults to 'prop' (the majority class — street furniture/debris/signage).
const BUILDING_IDS = new Set([
  'big-building',
  'building-red',
  'building-red-corner',
  'building-green',
  'brown-building',
  'pizza-corner',
  'greenhouse',
]);
const BUILDING_BLANK_IDS = new Set(['rb-blank', 'gb-blank']);
const VEGETATION_IDS = new Set(['tree']);
const VEHICLE_IDS = new Set([
  'car-a',
  'car-b',
  'suv',
  'van',
  'bus',
  'pickup-truck',
  'sports-car-a',
  'sports-car-b',
  'motorcycle',
  'bicycle',
  'police-car',
]);

export function categoryFor(id) {
  // Phase 29 T2 (D5): a `<id>-neutral` civilian-vehicle body variant categorizes as its base id
  // (car-a-neutral → 'vehicle'), so the manifest-mirror test still matches categoryFor per entry.
  // Phase 31 T2 (D6): a `<id>-player` garage-swap variant does the same (car-a-player →
  // 'vehicle').
  id = id.replace(/-neutral$/, '').replace(/-player$/, '');
  if (BUILDING_IDS.has(id)) return 'building';
  if (BUILDING_BLANK_IDS.has(id)) return 'building-blank';
  if (VEGETATION_IDS.has(id)) return 'vegetation';
  if (VEHICLE_IDS.has(id)) return 'vehicle';
  return 'prop';
}

// D2: skinned/animated character models — locked "Pedestrians: none" (CLAUDE.md). The zip
// (City Pack.undefined-glb.zip) lives at the repo root, outside the source folder, so it's
// simply never read by the pipeline; .gitignore keeps it and the source folder local-only.
export const EXCLUDE_BASENAMES = new Set([
  'Adventurer.glb',
  'Man.glb',
  'Animated Woman.glb',
  'Animated Woman-nIItLV9nxS.glb',
  'Animated Woman-qJ2gsTUBHL.glb',
]);
