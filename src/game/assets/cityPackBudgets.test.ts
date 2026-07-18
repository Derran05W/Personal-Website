// Phase 25.6 Task 2 (D15) — asserts the shipped city-pack manifest never drifts back over its
// scripts/city-pack-budgets.json cap. The budgets file is consumed by BOTH scripts/city-pack.mjs
// (enforces the cap while running `pnpm assets:pack`) and this test (enforces it stays true of
// whatever's actually committed) — one json, no drift between producer and consumer. Reads the
// json directly off disk (not import assertions) so this stays consistent with how the script
// itself loads it and needs no bundler JSON-import wiring for a file outside src/.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CITY_PACK_MANIFEST, getCityPackModel, hasCityPackModel } from './cityPackManifest';

interface CityPackBudgets {
  readonly caps: Readonly<Record<string, number>>;
  readonly optOut: readonly string[];
}

const budgetsPath = resolve(process.cwd(), 'scripts/city-pack-budgets.json');
const BUDGETS = JSON.parse(readFileSync(budgetsPath, 'utf-8')) as CityPackBudgets;
const OPT_OUT = new Set(BUDGETS.optOut);

describe('city-pack-budgets.json — schema sanity', () => {
  it('every capped id is a real manifest id (typo guard)', () => {
    for (const id of Object.keys(BUDGETS.caps)) {
      expect(hasCityPackModel(id), `budgets.json names unknown id "${id}"`).toBe(true);
    }
  });

  it('every cap is a positive integer', () => {
    for (const [id, cap] of Object.entries(BUDGETS.caps)) {
      expect(Number.isInteger(cap), id).toBe(true);
      expect(cap, id).toBeGreaterThan(0);
    }
  });

  it('every opt-out id is a real manifest id and also has a cap entry', () => {
    for (const id of BUDGETS.optOut) {
      expect(hasCityPackModel(id), `optOut names unknown id "${id}"`).toBe(true);
      expect(id in BUDGETS.caps, `optOut id "${id}" has no cap entry to opt out of`).toBe(true);
    }
  });
});

describe('city-pack-budgets.json — the shipped manifest respects every cap (D15 drift guard)', () => {
  it('every capped, non-opted-out id is at or under its cap in the current manifest', () => {
    for (const [id, cap] of Object.entries(BUDGETS.caps)) {
      if (OPT_OUT.has(id)) continue;
      const entry = getCityPackModel(id);
      expect(entry.tris, `${id}: run \`pnpm assets:pack\` — manifest is stale vs city-pack-budgets.json`).toBeLessThanOrEqual(cap);
    }
  });
});

describe('city-pack-budgets.json — coverage', () => {
  // NOTE (honest adaptation of D15's "everything already <=600 passes through untouched"):
  // that's true for the ids this phase actually PLACES (furniture/parked — all already small or
  // capped below), but a handful of uncapped manifest ids the plan's D15 table simply never
  // named (bicycle/bus/police-car/fence/fire-exit/billboard/air-conditioner/bus-stop-sign/
  // planter-bushes) sit well over 600 tris and are NOT used by any 25.6 placement (bicycle/
  // motorcycle/bus/police-car are explicit D12/D18 exclusions; the rest are decorative props no
  // 25.6 module places). Asserting a blanket <=600 here would pin a claim the real manifest
  // doesn't support — instead this just documents that every manifest id resolves (no drift
  // between the naming pipeline and the budgets file's assumed universe).
  it('every manifest id resolves through getCityPackModel (sanity, not a size claim)', () => {
    for (const entry of CITY_PACK_MANIFEST) {
      expect(getCityPackModel(entry.id).id).toBe(entry.id);
    }
  });
});
