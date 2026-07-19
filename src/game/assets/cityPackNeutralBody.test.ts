// Phase 29 T2 (D5) — drift guard for the neutral-body civilian-vehicle variants
// (scripts/lib/cityPackNeutralBody.mjs + scripts/city-pack.mjs, run via `pnpm assets:pack`).
// Reads only COMMITTED paths (the manifest JSON + public/assets/city-pack/), never the raw
// source folder — same self-contained-in-CI discipline as cityPackManifest.test.ts.
//
// The load-bearing invariant this file locks: a `<id>-neutral` variant shares its base model's
// GEOMETRY exactly (only body paint recoloured), so config/cityPackScale.ts resolves the SAME
// scale + collider half-extents for both. The runtime (Toronto civilian traffic / parked / lot
// cars) renders the neutral variant but sizes the collider from the base's dims — this asserts
// the two can never silently disagree.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getCityPackModel } from './cityPackManifest';
import { CIVILIAN_VEHICLE_IDS, neutralBodyId } from '../../../scripts/lib/cityPackNeutralBody.mjs';
import budgetsJson from '../../../scripts/city-pack-budgets.json';

const BUDGETS = budgetsJson as { caps: Record<string, number> };

describe.each(CIVILIAN_VEHICLE_IDS)('neutral-body variant: %s', (baseId) => {
  const neutralId = neutralBodyId(baseId);

  it('exists as a vehicle entry alongside its base', () => {
    expect(getCityPackModel(baseId).category).toBe('vehicle');
    expect(getCityPackModel(neutralId).category).toBe('vehicle');
  });

  it('shares the base model native dims exactly (collider/scale parity)', () => {
    // Only body paint (material factor / atlas texels) changes — geometry is byte-for-byte the
    // base model's, so the pristine-read native dims must be identical.
    expect(getCityPackModel(neutralId).nativeDims).toEqual(getCityPackModel(baseId).nativeDims);
  });

  it('is at or under its budgets cap', () => {
    const cap = BUDGETS.caps[neutralId];
    expect(cap, `${neutralId}: no budgets cap`).toBeGreaterThan(0);
    expect(getCityPackModel(neutralId).tris).toBeLessThanOrEqual(cap);
  });

  it('optimized file exists and hashes to its manifest contentHash', () => {
    const entry = getCityPackModel(neutralId);
    const filePath = resolve(process.cwd(), 'public', entry.url.replace(/^\//, ''));
    expect(existsSync(filePath), entry.url).toBe(true);
    const hash = createHash('sha256').update(readFileSync(filePath)).digest('hex');
    expect(hash, `${neutralId}: run \`pnpm assets:pack\``).toBe(entry.contentHash);
  });
});
