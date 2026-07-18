// Phase 25.5 (D11) — typed accessor over the script-generated manifest at
// ./cityPackManifest.json (scripts/city-pack.mjs, run via `pnpm assets:pack`). The JSON is
// the single source of truth for what's actually on disk in public/assets/city-pack/ — this
// module adds types + convenience lookups on top, nothing more; it never invents data the
// script didn't measure. See cityPackManifest.test.ts for the drift guard (re-hashes
// public/assets/city-pack/* against each entry's contentHash and fails loudly with "run
// `pnpm assets:pack`" if the two have gone out of sync).

import cityPackManifestJson from './cityPackManifest.json';

/** Coarse render/placement category (D11). 'building-blank' is a sign-free facade variant of
 * the 'building' family, kept distinct because business-personalization systems (25.7) target
 * blanks specifically. */
export type CityPackCategory = 'building' | 'building-blank' | 'prop' | 'vegetation' | 'vehicle';

/** Native (pre-scale) bounding-box size, in the model's own authored units — NOT world units.
 * The pack's ~4 authorship clusters disagree wildly on what one unit means (near-metric cars,
 * toy-scale buildings, centimetre-ish props); config/cityPackScale.ts's per-model scale
 * factors are what convert this into world units (1 wu = 1 m). Measured on the pristine
 * pre-transform read, by scripts/city-pack.mjs's optimizeOne(). */
export interface CityPackNativeDims {
  readonly w: number;
  readonly h: number;
  readonly d: number;
}

export interface CityPackModelEntry {
  readonly id: string;
  /** public/-served URL (D5) — pass straight to drei's useGLTF, never bundled. */
  readonly url: string;
  readonly category: CityPackCategory;
  readonly nativeDims: CityPackNativeDims;
  /** Triangle count AFTER the D3 optimize pipeline (what actually renders). */
  readonly tris: number;
  /** Primitive count AFTER the D3 optimize pipeline. Every 'building'/'building-blank' entry
   * is exactly 1 (script-asserted at generation time) — the precondition for
   * one-draw-call-per-type instancing (D7). */
  readonly prims: number;
  readonly bytes: {
    readonly raw: number;
    readonly optimized: number;
  };
  readonly hasTexture: boolean;
  /** sha256 of the optimized public/assets/city-pack/<id>.glb file, hex-encoded. */
  readonly contentHash: string;
}

// The JSON import is an array of plain objects matching the shape above exactly (the
// generator script and this interface are hand-kept in sync — cityPackManifest.test.ts's
// schema test is the tripwire if they ever drift).
export const CITY_PACK_MANIFEST: readonly CityPackModelEntry[] = cityPackManifestJson as CityPackModelEntry[];

const BY_ID: ReadonlyMap<string, CityPackModelEntry> = new Map(
  CITY_PACK_MANIFEST.map((entry) => [entry.id, entry]),
);

/** Looks up one model by id. Throws (in every environment — this is a build-time content
 * lookup, not a runtime user-facing path) if the id doesn't exist, so a typo'd id fails loudly
 * at the call site instead of silently rendering nothing. */
export function getCityPackModel(id: string): CityPackModelEntry {
  const entry = BY_ID.get(id);
  if (!entry) {
    throw new Error(`cityPackManifest: unknown id "${id}" — run \`pnpm assets:pack\`?`);
  }
  return entry;
}

/** True if `id` is a real manifest entry, without throwing — for call sites that want to
 * branch rather than fail (e.g. a debug tool iterating over a hand-written id list). */
export function hasCityPackModel(id: string): boolean {
  return BY_ID.has(id);
}

/** All models, optionally filtered to one category. */
export function listCityPackModels(category?: CityPackCategory): readonly CityPackModelEntry[] {
  if (!category) return CITY_PACK_MANIFEST;
  return CITY_PACK_MANIFEST.filter((entry) => entry.category === category);
}
