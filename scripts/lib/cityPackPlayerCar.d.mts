// Hand-written declaration for cityPackPlayerCar.mjs (plain executable JS — scripts/city-pack.mjs
// runs it directly via `node`, so it can't be a .ts file). TypeScript's bundler module resolution
// pairs a `.mjs` import with a sibling `.d.mts`; this is that pairing, so src/ imports (config/
// playerCarPack.ts, assets/cityPackManifest.test.ts, assets/cityPackPlayerCar.test.ts) type-check
// cleanly. `document`/`node` are kept `unknown`/generic here so this declaration (imported by a
// browser/test bundle) never pulls @gltf-transform/core's node-only types in.

export declare const PLAYER_SUFFIX: string;
export declare const PLAYER_CAR_IDS: readonly string[];

export declare function playerVariantId(id: string): string;
export declare function basePlayerId(id: string): string;

export interface PlayerNodeNames {
  readonly body: string;
  readonly wheelFrontLeft: string;
  readonly wheelFrontRight: string;
  readonly wheelRear: string;
}
export declare const PLAYER_NODE_NAMES: PlayerNodeNames;

export declare function applyPlayerWheelPivots(
  document: unknown,
  baseId: string,
): {
  baseId: string;
  hasWheels: boolean;
  hasRear: boolean;
  left: string | null;
  right: string | null;
};

export declare function applyPlayerVariant(
  document: unknown,
  baseId: string,
): Promise<{ class: string; touched: string; fallback: boolean; wheels: ReturnType<typeof applyPlayerWheelPivots> }>;
