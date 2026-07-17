// Rendering tunables for the instanced city + the blue-hour renderer state (TDD §8.2).
// Distinct from world/CityScape's placeholder look constants: these are the LIVE knobs of
// the shared palette material (world/palette.ts), the instancing emissive layer
// (world/instancing.ts), the final tone-mapping/exposure pass, and the lake shimmer.
//
// Only genuinely tunable look values live here. Structural constants that are pure
// functions of the palette contract (canvas cell pixel size, atlas dimensions) stay local
// to world/palette.ts — they are derived from archetypes.ts's PALETTE_COLS/ROWS and are
// never something you'd tune live, so surfacing them in leva would be noise.

/** Tone-mapping modes we know how to map to a three constant (world/BlueHourRig.tsx owns
 * the string→constant record). The blue-hour look ships on ACESFilmic; the rest exist so a
 * look pass can A/B them live without a code change. */
export const TONE_MAPPING_MODES = [
  'ACESFilmic',
  'AgX',
  'Neutral',
  'Reinhard',
  'Cineon',
  'Linear',
  'None',
] as const;
export type ToneMappingMode = (typeof TONE_MAPPING_MODES)[number];

// Exposure is clamped to this band by resolveToneMapping() — a mis-typed leva drag or a
// stale persisted value can never black the scene out or blow it to pure white.
const EXPOSURE_MIN = 0.1;
const EXPOSURE_MAX = 3.0;

export const RENDERING = {
  // Multiplier on the emissive term the palette material adds for lit windows /
  // streetlights / signals (world/palette.ts's onBeforeCompile patch samples the atlas at
  // the emissive cell and scales it by this). The blue-hour scene is dark, so emissives
  // must read NOTICEABLY bright — hence >1. Leva-live: the material's uEmissiveIntensity
  // uniform reads this value back each frame (see world/palette.ts), so the auto-built
  // Config → RENDERING → emissiveIntensity knob tunes the glow with zero extra wiring, and
  // setEmissiveIntensity() is the imperative equivalent for code. TDD §8.2 (no post FX).
  emissiveIntensity: 2.4,

  // Kensington market-block emissive boost (Phase 19, TDD §13). The Kensington district's
  // lit windows + string lights ride a per-instance aEmissiveOn value of THIS instead of 1
  // (powergrid/emitters.ts's applyDistrictEmissiveScale writes it), so the market-block glow
  // reads denser/warmer than the rest of the city — the "money clip" a Kensington blackout
  // then snuffs out. >1 brightens; the blackout write path (0) overrides it wholesale.
  kensingtonEmissiveScale: 1.4,

  // --- Final tone-mapping / exposure pass (Phase 19, TDD §8.2) --------------------------
  // The single strongest overall-mood knob. `mode` picks the tone-mapping curve; `exposure`
  // is toneMappingExposure. Both resolved (validated + clamped) through resolveToneMapping()
  // below and applied by world/BlueHourRig.tsx, which re-reads exposure each frame so the
  // leva Config → RENDERING → toneMapping → exposure slider moves the picture with no reload.
  // ACESFilmic @ 1.35: keeps the deep blue-hour blacks from crushing in blacked-out
  // districts while letting window/lightbar/beacon emissives + the heli searchlight roll off
  // instead of clipping to flat white near the HUD. (Was a flat exposure 1.5 in LIGHTING
  // through Phase 18; the landmark/lighting pass lowered it a touch for highlight headroom.)
  toneMapping: {
    mode: 'ACESFilmic' as ToneMappingMode,
    exposure: 1.35,
  },

  // --- Lake shimmer (Phase 19, TDD §8/§13) ---------------------------------------------
  // The south lakefront water plane (world/CityScape.tsx) gets a cheap onBeforeCompile pass:
  // a slow sinusoidal shimmer plus a warm specular streak running toward the horizon glow —
  // no reflections, no render targets, no extra draw call. All numbers leva-live.
  water: {
    // Shimmer scroll speed (radians/sec fed to the sin() phase) and its brightness swing.
    shimmerSpeed: 0.35,
    shimmerAmplitude: 0.08,
    // Spatial frequency (cycles per metre) of the shimmer ripple across the lake surface.
    shimmerScale: 0.08,
    // Warm specular streak toward the south horizon glow: how bright at its peak, and how
    // tightly it concentrates toward the far (south, +Z) edge (higher = tighter streak).
    streakIntensity: 0.65,
    streakFalloff: 2.0,
    // Streak tint — echoes LIGHTING.sky.horizon (the warm sunset band) so the reflection on
    // the water and the sky it "reflects" read as the same light. String leaf → leva skips it.
    streakColor: '#e29457',
  },
} as const;

/**
 * Resolve the final tone-mapping settings from config: validate the mode against the known
 * set (unknown → ACESFilmic, the shipped look) and clamp exposure into a safe band so no
 * live drag / stale value can crush or blow the scene. Pure — three-free — so it unit-tests
 * cleanly; world/BlueHourRig.tsx maps the returned `mode` to the three constant.
 */
export function resolveToneMapping(
  cfg: { mode: string; exposure: number } = RENDERING.toneMapping,
): { mode: ToneMappingMode; exposure: number } {
  const mode = (TONE_MAPPING_MODES as readonly string[]).includes(cfg.mode)
    ? (cfg.mode as ToneMappingMode)
    : 'ACESFilmic';
  const exposure = Math.min(EXPOSURE_MAX, Math.max(EXPOSURE_MIN, cfg.exposure));
  return { mode, exposure };
}
