// Phase 44 — the CN Tower's NIGHT PROGRAM (spec §5 + Part 11 phase 44). Every number the light
// show runs on lives here; world/toronto/cnNightProgram.ts turns them into phases/intensities and
// world/toronto/cnNightMaterial.ts hands those to the shader. Nothing else in the codebase may
// re-type one of these values (the P27 literal-drift class), and the GEOMETRY-derived numbers the
// program also needs — how many LED cells the channel has, how tall a fin crest is — are
// deliberately NOT here: they come off `CnTowerMeta` (ringCells / finTopY) so the mesh can never
// drift from the program that lights it.
//
// GROUNDING (map-researcher round 2026-07-27, plus the standing blue-hour lock):
//   • The tower's exterior LEDs are the nightly show: the canonical scheme is RED/WHITE (Canada),
//     with a full-colour "show" on the half hour, and occasion palettes on special dates. Entry 0
//     below is therefore the canon red/white, and it carries the heaviest weight.
//   • The fin lights are not decorative stripes bolted to the outside — the light bars run inside
//     the three ELEVATOR SHAFTS (which run up the fins/ribs), plus base uplighting. So CREST (the
//     rib crest faces) and FLOOD (the skirt/soffit/trunk) are the physically right receivers, and
//     both are deliberately SUBTLE next to the ring: the ring is the hero feature.
//   • The aircraft-warning beacon: CAR 621's envelope for a red obstruction beacon is 20–40
//     flashes per minute. The CN Tower's OWN cadence was NOT verifiable in that round — stated
//     plainly rather than invented — so the double-flash group below is picked to LOOK right and
//     to land inside the regulatory envelope: 2 flashes every 3.2 s = 37.5 flashes/min.
//   • BLUE-HOUR LEGIBILITY (locked time of day): every palette leans warm/saturated and none of
//     them is a deep blue, because a deep blue ring on a deep blue sky is an invisible ring.
//
// Blackout law: NOTHING here (or in cnNightProgram.ts) knows the power grid exists. The tower
// stays lit through DARK CITY by construction, and a source-scan test polices the import graph.

/** One night palette. `ringA`/`ringB` alternate per LED cell; crest/flood tint the fin + base wash. */
export interface CnPalette {
  readonly name: string;
  readonly ringA: string;
  readonly ringB: string;
  readonly crest: string;
  readonly flood: string;
}

export const CN_TOWER = {
  /**
   * The seeded nightly palette set. Index 0 IS the canon red/white and is weighted to come up
   * about a third of the time; the rest are the researcher-named occasion schemes, adapted for
   * blue hour (warm-leaning, nothing deep-blue).
   */
  palettes: [
    { name: 'canada', ringA: '#ff3b30', ringB: '#fff3f0', crest: '#ff6a5c', flood: '#ffd9c4' },
    // The half-hour "show": a festive two-hue pair rather than a literal spectrum — the ring
    // alternates cells, so two rotating hues read as a colour show while staying legible.
    { name: 'spectrum', ringA: '#ff5ea8', ringB: '#ffd23f', crest: '#ff9ad1', flood: '#ffd7a8' },
    { name: 'lunar-new-year', ringA: '#ff2d2d', ringB: '#ffcf4d', crest: '#ff8a3d', flood: '#ffcf8f' },
    { name: 'pride', ringA: '#ff3fa4', ringB: '#3ff0ff', crest: '#ff7ad1', flood: '#ffc2e6' },
    { name: 'christmas', ringA: '#ff3b30', ringB: '#3ddc6b', crest: '#ff6a5c', flood: '#ffd0c0' },
    { name: 'harbour-teal', ringA: '#2fd6c8', ringB: '#eafcff', crest: '#5ee8dc', flood: '#bfeee9' },
    { name: 'sunset', ringA: '#ff8a3d', ringB: '#ffd9a0', crest: '#ffb06a', flood: '#ffdcb0' },
  ] as readonly CnPalette[],
  /** Weight per palette index (same order/length as `palettes`; normalized at pick time). */
  paletteWeights: [0.34, 0.12, 0.1, 0.1, 0.1, 0.12, 0.12],
  /** Weight per program mode. Solid dominates — the real tower holds a scheme far more than it moves. */
  modeWeights: { solid: 0.5, pulse: 0.28, chase: 0.22 },

  ring: {
    /** Steady-state brightness (additive, on an unlit/toneMapped=false slice: 1 ≈ "as bright as
     *  full white paint", so >1 is genuine glow). Peaks stay ≤ 2.2 so the ring never clips to a
     *  featureless white blob — the red/white cell alternation has to survive the brightness. */
    solidIntensity: 1.7,
    /** `pulse`: smooth sinusoidal breathing between these two. */
    pulseMinIntensity: 0.9,
    pulseMaxIntensity: 2.2,
    pulsePeriodMs: 3600,
    /** `chase`: a lit window travelling around the ring; unlit cells hold at `chaseIdle` × peak. */
    chaseIntensity: 2.0,
    chasePeriodMs: 3000,
    /** Half-width of the travelling window as a fraction of the ring (0.25 ≈ a quarter turn lit). */
    chaseWidth: 0.25,
    chaseIdle: 0.22,
  },

  crest: {
    /** Subtle by mandate — the fins are lit columns, not a second hero. */
    intensity: 0.55,
    /** Constant floor of the crest wash (the rest is the travelling band). */
    base: 0.35,
    /** Half-height of the upward-travelling band, as a fraction of the fin's height. */
    bandWidth: 0.22,
    /** One full ground→pod sweep. Slow: the real shows wash, they don't strobe. */
    sweepPeriodMs: 7000,
  },

  flood: {
    /** Base uplighting. Moderate — it must read as wash on concrete, not as a second light source. */
    intensity: 0.7,
  },

  beacon: {
    /** Double-flash group: two `flashMs` flashes `gapMs` apart, then dark until `periodMs`. */
    flashMs: 90,
    gapMs: 380,
    periodMs: 3200,
    /** Short linear tail after each flash so the strobe reads as a lamp, not a square wave. */
    decayMs: 70,
    /** Peak additive brightness — brighter than the ring, because a strobe is meant to punch. */
    peakIntensity: 2.4,
    /** Warm red-white: the housing is already dark aircraft red, this is the lamp firing. */
    color: '#ff6a55',
  },
} as const;
