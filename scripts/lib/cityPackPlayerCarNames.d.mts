// Hand-written declaration for cityPackPlayerCarNames.mjs (plain executable JS, zero
// dependencies — safe for browser-bundled src/ code to import). TypeScript's bundler module
// resolution pairs a `.mjs` import with a sibling `.d.mts`; this is that pairing.

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
