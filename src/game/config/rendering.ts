// Rendering tunables for the instanced city (TDD §8.2). Distinct from world/CityScape's
// placeholder look constants: these are the LIVE knobs of the shared palette material
// (world/palette.ts) and the instancing layer (world/instancing.ts).
//
// Only genuinely tunable look values live here. Structural constants that are pure
// functions of the palette contract (canvas cell pixel size, atlas dimensions) stay local
// to world/palette.ts — they are derived from archetypes.ts's PALETTE_COLS/ROWS and are
// never something you'd tune live, so surfacing them in leva would be noise.
export const RENDERING = {
  // Multiplier on the emissive term the palette material adds for lit windows /
  // streetlights / signals (world/palette.ts's onBeforeCompile patch samples the atlas at
  // the emissive cell and scales it by this). The blue-hour scene is dark, so emissives
  // must read NOTICEABLY bright — hence >1. Leva-live: the material's uEmissiveIntensity
  // uniform reads this value back each frame (see world/palette.ts), so the auto-built
  // Config → RENDERING → emissiveIntensity knob tunes the glow with zero extra wiring, and
  // setEmissiveIntensity() is the imperative equivalent for code. TDD §8.2 (no post FX).
  emissiveIntensity: 2.4,
} as const;
