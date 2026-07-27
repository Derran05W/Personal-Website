// Phase 41 — SURFACE POLICY: how a surface is allowed to behave at distance. The companion leaf to
// config/layering.ts — where the ladder answers "which of two coplanar surfaces wins the depth
// test", this module answers "does this surface hold still when the camera moves away from it".
//
// It exists because the rig is FIXED (config/camera.ts, rig E: yaw 45 / pitch 58 / baseDist 26 /
// FOV 38) and the P38 visible-band law bounds how far any ground surface can ever be from the eye
// in play. Both together turn "will this shimmer?" from a taste question into arithmetic, so the
// answers below are DERIVED and law-tested (`config/surfaces.test.ts`) rather than tuned by eye.
//
// MEASURED TRUTH this module is built on (Phase 41 T1 capture matrix,
// `.planning/screenshots/phase-41/` + `p41-matrix-results-before.json`, all three quality tiers):
//   - antialias = true, gl.SAMPLES = 4, DPR = 1 on high/med/low alike (headless; a real display
//     engages the QUALITY_TIERS dprCap clamp instead — see config/quality.ts's MSAA/DPR block).
//   - Per-frame jitter (camera nudged 0.05 wu along the street) changed 0.117 % of pixels in the
//     far-band dash crop at high tier / 0.111 % at low, and 0 % on the grazing ground band. The
//     shipped painted stripes do not sparkle; nothing needed a distance fade or a screen-width
//     clamp this phase.
//
// This module is a LEAF over the two other leaves it reads (config/camera.ts, config/quality.ts —
// neither imports anything), so any config or world module can read it without a cycle.

import { CAMERA } from './camera';
import { QUALITY_TIERS, type QualityTier } from './quality';

const DEG2RAD = Math.PI / 180;

/**
 * The measurement frame every bound below is worst-cased in. These are OBSERVATIONS (rig geometry +
 * the T1 matrix), not tunables: changing one changes what the game is, not how it is configured.
 */
export const SURFACE_MEASUREMENT = {
  /** Logical viewport height (CSS px) the pixel-density math assumes. 720p logical is the smallest
   * desktop frame the game is designed to read at; a taller frame only ever ADDS pixels per world
   * unit, so bounding at 720 bounds every larger window too. */
  viewportHeightPx: 720,
  /** Device pixel ratio the bound assumes. DPR 1 is the worst case (fewest device pixels per world
   * unit); the tier dprCap (2 / 1.5 / 1.5) only ever multiplies this up on a real display. */
  dpr: 1,
  /** MSAA sample count, MEASURED live on all three tiers (gl.getParameter(gl.SAMPLES)). */
  msaaSamples: 4,
  /** Worst-case eye→ground distance in play (wu). The eye rests 22.05 wu up and 13.78 wu back
   * (CAMERA_EYE_MIN_WU / the corridor radius), and the P38 visible-band law puts the furthest
   * ground the player ever sees ~29 wu beyond the car — so ~45 wu typical, 60 wu at the ★5 +
   * top-speed corner of the framing ramp. 60 is the bound; anything nearer is denser on screen. */
  farGroundDistanceWu: 60,
  /** Screen-space width (px) below which a hard-edged painted stripe starts to strobe as the
   * camera moves, at 4× MSAA. Four device pixels leaves ≥ 4 fully-covered sample columns across
   * the stripe at every sub-pixel phase — the point where coverage stops flickering between
   * frames. Empirically consistent with the T1 jitter numbers: the 0.4 wu dash resolves to ~7 px
   * at the far band and changed 0.117 % of crop pixels (i.e. edge-only, no body strobe). */
  stabilityFloorPx: 4,
} as const;

/**
 * Screen pixels per world unit for a surface `distanceWu` from the eye, facing the camera, at the
 * measurement frame above. Pure perspective: px = viewportHeightPx / (2·d·tan(fov/2)) — with rig
 * E's 38° FOV at 720p this is ≈ 1046/d.
 */
export function pxPerWu(distanceWu: number): number {
  return SURFACE_MEASUREMENT.viewportHeightPx / (2 * distanceWu * Math.tan((CAMERA.fov / 2) * DEG2RAD));
}

/**
 * How much a GROUND surface's along-view axis compresses on screen under the fixed rig: a plane
 * viewed at pitch p from horizontal shows sin(p) of its true extent along the view direction
 * (sin 58° = 0.848). The across-view axis is unforeshortened, so this is the worst of the two and
 * the factor the stripe bound must survive.
 */
export const GROUND_FORESHORTEN = Math.sin(CAMERA.pitchDeg * DEG2RAD);

/**
 * The raw derived bound, before rounding: the world-unit width a ground stripe needs so that at the
 * worst-case distance AND worst-case foreshortening it still covers `stabilityFloorPx`.
 * = 4 px ÷ (1046/60 px per wu) ÷ 0.848 ≈ 0.271 wu.
 */
export const DERIVED_MIN_STRIPE_WIDTH_WU =
  SURFACE_MEASUREMENT.stabilityFloorPx / pxPerWu(SURFACE_MEASUREMENT.farGroundDistanceWu) / GROUND_FORESHORTEN;

/**
 * THE THIN-GEOMETRY LAW. A formula, not a mechanism: under a FIXED camera every surface has a
 * bounded worst-case screen size, so "will it sparkle" is answerable before anything is built, and
 * no distance-fade / screen-width machinery is needed for geometry that clears the bound.
 *
 * SHIPPED STRIPES ALL CLEAR IT (config/torontoMap.ts, asserted in surfaces.test.ts — the policy is
 * enforced, not documented): centre-line dashes 0.4 wu (2 × halfWidthWu), crosswalk zebra stripes
 * 0.5 wu, curb strips 0.8 wu. T1 measured the dashes directly (0.117 % / 0.111 % jitter, high /
 * low tier) and the grazing ground band at 0 % — no shipped painted geometry is a shimmer source.
 *
 * P60 CONSUMER NOTE (Part 14, "streetcar overhead wires + poles + track inlays"): overhead catenary
 * wire is authored at 0.05–0.1 wu of real diameter, i.e. 3–6× BELOW this bound — a wire built as
 * raw thin geometry would resolve to well under one pixel at play distance and strobe on every
 * camera move, which is exactly the class of defect Part 10 exists to kill. Wires must therefore
 * ship as SCREEN-WIDTH-CLAMPED ribbons (a quad whose world width is expanded per-frame/per-vertex
 * so its projected width never drops below `minStripeWidthWu`'s pixel equivalent) or as
 * camera-facing quads — never as raw sub-bound geometry. The same rule binds any future hairline:
 * track inlay seams, wire droppers, fence wire, antenna masts.
 */
export const THIN_GEOMETRY = {
  /** Minimum width (wu) for a hard-edged painted stripe or thin solid on the ground plane.
   * DERIVED_MIN_STRIPE_WIDTH_WU (≈ 0.271) rounded UP to a defensible round number for margin. */
  minStripeWidthWu: 0.3,
} as const;

/**
 * Per-atlas minification policy — the Phase 41 verdicts AS CODE, so a future atlas author reads a
 * typed table instead of hunting through phase notes.
 *
 * `magnificationOnly` = under the fixed rig this texture is never minified at any legal vantage
 * (its texels are always larger than a pixel), so Nearest with no mipmaps is not merely acceptable
 * but correct — it is what makes the pixel-art homage read crisp, and a mip chain would only ever
 * blur it. `mipped` = the texture IS minified in play, so it needs a mip chain (mag filter still
 * stays Nearest — the near look is untouched by construction).
 */
export type AtlasMipPolicy = 'magnificationOnly' | 'mipped';

export const ATLAS_POLICY = {
  /** 32-px brand cells on ≥ 2 wu decals, only ever read from across a street: ~10–32 px per 32-texel
   * cell → magnification regime at every legal vantage (T1 `before-atlas-*` crops: crisp). */
  logoAtlas: 'magnificationOnly',
  /** Venue FASCIA bands — 40-px rows on 1.1+ wu-tall bands read from the same street distance as the
   * logos they carry; measured crisp in the McDonald's/Spadina crop. */
  venueBands: 'magnificationOnly',
  /** Named-tower window CanvasTextures are baked AT pxPerWu 5 with an 8..384 clamp — the texture is
   * sized from the wall it covers, so its texel density tracks the wall and never minifies. */
  facadeWindows: 'magnificationOnly',
  /** Dundas Square's Sankofa screens: 64×48 on a multi-wu board, always read up close. */
  sankofaScreen: 'magnificationOnly',
  /** Graffiti decals: 96×24 on wall-sized quads, near-vantage only. */
  graffiti: 'magnificationOnly',
  /** The city-pack's baked palette maps (512² webp, NEAREST/no-mips on disk): every UV samples a
   * CELL CENTRE of a flat palette swatch, so a minified fetch lands on the same colour whatever the
   * footprint — minification-stable by construction, mips would only bleed neighbouring swatches. */
  packPalette: 'magnificationOnly',
  /** THE ONE OFFENDER (T1, `before-routeboard-crop2.png`): a 256×64 route-board row on a
   * 2.2 × 0.9 wu rooftop quad renders ~5× MINIFIED at play distance, on a MOVING vehicle — the
   * text strobed sample-to-sample every frame. Mipped (NearestMipmapLinear: nearest within a level
   * keeps the pixel-text look, linear between levels kills the strobe; mag stays Nearest). */
  routeBoards: 'mipped',
} as const satisfies Record<string, AtlasMipPolicy>;

/**
 * Effective anisotropic-filter level for a tier, capped by what the renderer actually supports
 * (`gl.capabilities.getMaxAnisotropy()`). The per-tier values live in QUALITY_TIERS alongside
 * dprCap/shadowMapSize (the tier table is the one home for per-tier renderer knobs); this is the
 * only sanctioned way to READ one, so the capability cap can never be forgotten at a call site.
 *
 * Applies to mipped, non-cell-centre textures viewed at grazing angles — the ground-noise map above
 * all (world-planar UVs, trilinear, ~11.6 texels/wu, and the 58° rig lays it out to the frame's top
 * band) and any pack GLB map that carries a mip chain. It is a documented NO-OP on the Nearest /
 * no-mipmap homage textures (anisotropy only ever selects between mip levels) — those are listed in
 * ATLAS_POLICY above and are deliberately not touched.
 */
export function resolveAnisotropy(tier: QualityTier, rendererMax: number): number {
  return Math.max(1, Math.min(QUALITY_TIERS[tier].anisotropy, Math.floor(rendererMax)));
}
