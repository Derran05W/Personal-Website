// Hand-written declaration for cityPackNeutralBody.mjs (plain executable JS — scripts/
// city-pack.mjs runs it directly via `node`, so it can't be a .ts file). TypeScript's bundler
// module resolution pairs a `.mjs` import with a sibling `.d.mts`; this is that pairing, so the
// vitest suites (cityPackManifest.test.ts / cityPackNeutralBody.test.ts) type-check cleanly.
// applyNeutralBody's `document` is a @gltf-transform/core Document, kept `unknown` here so this
// declaration (imported by a browser/test bundle) never pulls that node-only type in.

export declare const NEUTRAL_SUFFIX: string;
export declare const CIVILIAN_VEHICLE_IDS: readonly string[];
export declare function neutralBodyId(id: string): string;
export declare function baseBodyId(id: string): string;
export declare function applyNeutralBody(
  document: unknown,
  id?: string,
): Promise<{ class: string; touched: string; fallback: boolean }>;
