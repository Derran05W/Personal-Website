// Phase 31 T2 (D6) — PURE, ZERO-DEPENDENCY id/naming constants for the player-car pipeline
// variants. Split out of cityPackPlayerCar.mjs SPECIFICALLY so runtime browser code
// (src/game/assets/cityPack.ts, src/game/config/playerCarPack.ts) can import these plain string
// constants WITHOUT pulling in cityPackPlayerCar.mjs's heavy pipeline imports
// (@gltf-transform/functions, and transitively cityPackNeutralBody.mjs's lazy `sharp` import) —
// exactly the same rationale cityPackNaming.mjs's own header documents for its split out of
// city-pack.mjs. A vite client build was measured pulling @gltf-transform/core + sharp (both
// Node-only, one needs a native binary) into the game chunk before this split existed; never
// import cityPackPlayerCar.mjs itself from src/ runtime code — only from here, or from a test
// (Node/vitest, never bundled for the browser).
//
// cityPackPlayerCar.mjs re-exports every one of these (so scripts/city-pack.mjs's existing
// imports keep working unchanged) and additionally defines the pipeline-restructuring functions
// that need the heavy imports.

export const PLAYER_SUFFIX = '-player';

/** The 5 manifest ids the player/garage swap (Phase 31 D6) targets. */
export const PLAYER_CAR_IDS = ['car-a', 'sports-car-a', 'sports-car-b', 'pickup-truck', 'bus'];

export function playerVariantId(id) {
  return `${id}${PLAYER_SUFFIX}`;
}

/** Strips a trailing `-player` (mirrors cityPackNeutralBody.mjs's baseBodyId). Idempotent on
 * base ids. */
export function basePlayerId(id) {
  return id.endsWith(PLAYER_SUFFIX) ? id.slice(0, -PLAYER_SUFFIX.length) : id;
}

/** Canonical node/mesh names the runtime (assets/cityPack.ts's usePlayerCarPackModel) looks up
 * by exact string match — the pipeline (cityPackPlayerCar.mjs's applyPlayerWheelPivots) renames
 * every wheel/body node to exactly one of these. */
export const PLAYER_NODE_NAMES = {
  body: 'body',
  wheelFrontLeft: 'wheel-front-left',
  wheelFrontRight: 'wheel-front-right',
  wheelRear: 'wheel-rear',
};
