// Phase 25.8 (D3/D4) — cohesion levers for the unlit Toronto slice. The city is rendered
// UNLIT-literal everywhere (four A/B verdicts, binding); cohesion is achieved by tuning the
// SHARED levers all unlit layers pass through (fog, palette hexes, per-vertex bakes), never by
// re-lighting. This module owns the ONE lever that needs a config number rather than a palette
// hex: the D4 vertex-gradient bake strength. The fog numbers live in config/lighting.ts, the
// road/sidewalk/ground palette ladder lives in config/torontoMap.ts + TorontoScene's GROUND_COLOR,
// and the ground-noise + park colours live in config/torontoMap.ts — this file is deliberately
// small so a real-GPU retune touches one obvious place per lever.
//
// LEVA-LIVE: `strength` is a number leaf, so the leva auto-schema surfaces it in the "Config"
// panel and cityPackBaked re-reads it at bake time (a live drag re-bakes on the next model mount /
// HMR). The luminance endpoints are code+HMR (they change the ramp shape, not just its amount).

/**
 * D4 vertex-gradient bake — an optional per-vertex luminance ramp baked ONCE into every
 * building-family model's geometry (cityPackBaked.ts, in the existing de-quantize pass; zero
 * per-frame cost, zero draw calls). Luminance-only (no hue) so it MULTIPLIES cleanly under the
 * near-white instance tints + palette texture and can never fight the authored colours. The ramp
 * runs over the model's own bbox Y: `startLuminance` at the street floor → `endLuminance` at the
 * roof. Default is a subtle roof top-darken so a flat unlit box reads as having vertical form —
 * the cheapest possible "shape" for an unlit facade. `strength` blends the whole ramp toward 1.0
 * (no-op): strength 0 = NO color attribute written at all → byte-identical shading (kill-switch).
 */
export const VERTEX_GRADIENT_BAKE = {
  /** Blend of the ramp toward flat 1.0. 0 = off (no attribute, byte-identical). 1 = full ramp. */
  strength: 1.0,
  /** Per-vertex luminance at the model bbox-Y bottom (street floor). >1 subtly brightens the
   * street level; 1.0 = neutral. Kept at 1.0 (luminance-only top-darken, no street lift) so the
   * base facade colour is unchanged and only the roof reads shaded. */
  startLuminance: 1.0,
  /** Per-vertex luminance at the model bbox-Y top (roof). <1 = top-darken (the shaded-roof read
   * that gives an unlit box its form). 0.86 ≈ a 14% roof shade at full strength. */
  endLuminance: 0.86,
} as const;

/** Does the bake write a color attribute at all? (strength 0 ⇒ byte-identical, no attribute.) */
export function vertexGradientActive(): boolean {
  return VERTEX_GRADIENT_BAKE.strength > 0;
}

/** Pure ramp math (explicit params → unit-testable in isolation): luminance at normalized height
 * `t` (0 = floor, 1 = roof), a start→end ramp blended toward 1.0 by `strength`. strength 0 ⇒ 1.0
 * everywhere (identity); t clamps to [0,1]. */
export function computeGradientLuminance(t: number, start: number, end: number, strength: number): number {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  const ramp = start + (end - start) * clamped;
  return 1 + (ramp - 1) * strength;
}

/** Resolve the per-vertex luminance at normalized height `t`, reading the live config. */
export function gradientLuminanceAt(t: number): number {
  const { startLuminance, endLuminance, strength } = VERTEX_GRADIENT_BAKE;
  return computeGradientLuminance(t, startLuminance, endLuminance, strength);
}
