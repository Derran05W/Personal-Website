// Phase 32 — the flip. Single source of truth for which world the game boots into.
//
// Through Phases 22-31 this was the dev-only `torontoMap` leva toggle (core/devToggles.ts),
// default false, so every player shipped on the legacy 64x64 procedural world while the Toronto
// "thermometer" map was built out behind it. That toggle (and its devPanel control + the
// debugBridge `setTorontoMap` mirror) is REMOVED as of this phase — game/index.tsx now mounts
// the Toronto subtree unconditionally, gated only by this permanent config constant.
//
// `'legacy'` remains a type member as a documented breadcrumb: the 64x64 generator/scene/traffic/
// streetcar/landmark modules still exist in source (world/generate.ts, world/CityScape.tsx,
// ai/TrafficMount.tsx, ai/StreetcarMount.tsx, world/landmarks.ts, world/spawn.ts, …) — hundreds of
// tests intentionally pin their internals (NavProvider parity, world-gen goldens) and keep passing
// straight against that source. But nothing in the RUNTIME graph reads `'legacy'` anymore: no
// component branches on it, and de-importing it from game/index.tsx's render tree is what lets
// tree-shaking drop it from the built game chunk (bundle-verified in phase-32-notes.md).
export type WorldSource = 'toronto' | 'legacy';

/** The one flip. Changing this back to `'legacy'` would NOT restore the old game — the runtime
 * graph no longer has a legacy branch to fall back to (Phase 32 de-import). This constant exists
 * so every consumer (game/index.tsx's boot assertion, ai/chaosBench.ts's world-graph seam) has one
 * place to read "which world is this build" from, instead of re-deriving it. */
export const WORLD_SOURCE: WorldSource = 'toronto' as const;
