// Hand-written declaration file for cityPackNaming.mjs (plain executable JS — scripts/
// city-pack.mjs runs it directly via `node`, so it can't be a .ts file). TypeScript's bundler
// module resolution pairs a `.mjs` import with a sibling `.d.mts` for typing purposes; this is
// that pairing, so src/game/assets/cityPackManifest.test.ts's import type-checks cleanly.

export declare const RENAME_MAP: Readonly<Record<string, string>>;
export declare function kebabCase(basenameNoExt: string): string;
export declare function idForFile(basename: string): string;
export declare function categoryFor(id: string): string;
export declare const EXCLUDE_BASENAMES: ReadonlySet<string>;
