// FX tunables. Currently just the handbrake skid-mark system (fx/SkidMarks.tsx); the
// Phase 16 juice pass (particles, decals, tire smoke) hangs its numbers off this module
// too. Skid marks are a pooled, fully-recycled InstancedMesh of flat ground quads — no
// per-frame allocation, no alpha blending (they fade by lerping toward the ground colour,
// see below), so the block is small and every value is a feel/perf knob.
export const SKID = {
  // Ring-buffer capacity: total skid quads alive at once across BOTH rear wheels. At
  // maxSegmentLength each slot covers ~0.9 m, so 512 ÷ 2 wheels ≈ 230 m of stripe per
  // wheel before the oldest segment recycles — plenty for a fadeSeconds-long tail even
  // at top speed. Also the InstancedMesh instance count, so it is fixed at mount.
  poolSize: 512,
  // Don't lay rubber below this speed (m/s): a near-stationary handbrake pivot shouldn't
  // paint, and slow crawl marks read as noise. TDD's arcade slide only matters at pace.
  minSpeed: 4,
  // Full width of a mark quad (m) — roughly a fat tyre contact patch, a touch under the
  // 2·halfTrack track so the two rear stripes stay visibly separate.
  markWidth: 0.28,
  // Emit a new segment once a rear wheel has travelled this far (m) since the last one.
  // Bigger = fewer, longer quads (pool lasts longer, coarser curve); smaller = smoother
  // arcs but the ring buffer churns faster. Segment length is clamped to this on emit.
  maxSegmentLength: 0.9,
  // Lifetime of a mark (s): it lerps from `colors.rubber` to `colors.ground` over this
  // span, then hides (scale 0) until its slot is recycled. Longer = more persistent skid
  // history on screen at once (watch the pool budget above).
  fadeSeconds: 6,
  // Quad height above the ground plane (m). The ground slab top is y=0 and
  // world/CityScape.tsx's road surface sits at y=0.01; 0.03 clears both so marks never
  // z-fight either.
  yOffset: 0.03,
  // Flat-ground guard: only emit when the transformed wheel point's world y is within
  // this of the wheel radius (i.e. the chassis is sitting level on the y=0 slab). This
  // cheaply skips marks on the test ramp / mid-jump — sloped-surface decals are a Phase
  // 16 problem, not this pass's. Sized to tolerate suspension travel + a modest slide
  // roll/pitch while still excluding the ramp everywhere but its ground-flush base.
  flatGroundYTolerance: 0.25,
  // A frame-to-frame jump larger than this (m) is treated as a teleport (dev reset /
  // respawn), NOT a slide: break the stripe instead of stretching one quad across the
  // map. Well above any real single-frame travel (top speed ≈ 0.42 m at 60 fps).
  teleportBreakDistance: 5,
  // The fade endpoints. Both are plain hex strings, so the leva auto-schema builder skips
  // them (it only surfaces number/boolean leaves) — tune them here, in code.
  colors: {
    // Near-black fresh rubber, the colour of a just-laid mark (t=0).
    rubber: '#1c1f24',
    // City ground colour — the fade target (t=1). Kept in sync with
    // world/CityScape.tsx's ground slab so a fully-faded mark dissolves into the ground
    // with no alpha blend; if the world ground colour changes, change this too.
    ground: '#454b54',
  },
} as const;
