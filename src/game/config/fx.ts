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

// Gun-truck hitscan tracer/muzzle/hit-spark FX (Phase 11 Task 3; TDD §5.6 row 4).
// combat/hitscan.ts (Task 2) pushes one TracerShot per fired round into
// combat/tracerFeed.ts's ring buffer; fx/Tracers.tsx polls it and renders three additive
// elements per live shot: a muzzle→hit beam, a muzzle-flash quad, and (only on a hit) a
// hit-spark quad. All three fade independently by AGE, not a shared lifetime — the flash
// is a short strobe, the beam a touch longer, the spark lingers a little past the beam so
// an impact still reads after the tracer itself has faded. Every quad/line is additive +
// depth-write-off (fx/Tracers.tsx's header explains the "fade toward black" trick this
// implies), so these are colour VALUES multiplied by an intensity in [0,1], not alpha.
export const TRACER = {
  // Lifetimes (ms) — independent per element, see file-header ordering above.
  beamMaxAgeMs: 120,
  muzzleFlashMaxAgeMs: 60,
  hitSparkMaxAgeMs: 150,
  // Camera-facing quad sizes (m) for the muzzle flash / hit spark billboards.
  muzzleFlashSize: 0.45,
  hitSparkSize: 0.5,
  // Warm yellow-white tracer language (TDD §5.6's "telegraphed hitscan"); the hit spark
  // skews a touch more orange (impact heat) than the beam/flash. Hex strings, so the leva
  // auto-schema builder (core/devPanel.tsx's buildBlockSchema) skips them — tune in code.
  colors: {
    beam: '#fff4c8',
    muzzleFlash: '#fffbe6',
    hitSpark: '#ffb454',
  },
} as const;

// Tank-shell explosion FX (Phase 12 Task 3; TDD §5.6 tank row). combat/explosion.ts
// (Task 1) pushes one ExplosionRecord per detonation into combat/explosionFeed.ts's ring
// buffer; fx/Explosions.tsx polls it and renders four independently age-faded elements —
// an expanding flash billboard, a brief pooled point-light punch (max 2 concurrent, real
// lights are budgeted), a handful of rising smoke-puff billboards, and a long-lived
// ground scorch decal — plus one big camera-shake hit per blast. Flash/smoke share
// Tracers.tsx's additive "fade toward black" trick (colour × intensity, additive +
// depth-write-off — a black quad contributes nothing under additive blending); scorch
// reuses fx/SkidMarks.tsx's opaque "fade toward the ground colour" trick instead (no
// transparency, so overlapping decals cost nothing extra) — see fx/Explosions.tsx's file
// header for the exact pooling/draw-call layout.
export const EXPLOSION = {
  // Expanding flash billboard: additive, fades to black over this span (ms).
  flash: {
    maxAgeMs: 250,
    sizeStart: 1.5, // m, at spawn
    sizeEnd: 7, // m, at maxAgeMs — roughly TANK.blast.radius, so the flash silhouette
    // reads as "this is why everything nearby just flew".
  },
  // Pooled point light: a brief warm punch, hard-capped at 2 concurrent (perf budget —
  // real dynamic lights, not billboards). Unused pool slots park at y=parkY, intensity 0.
  light: {
    maxConcurrent: 2,
    maxAgeMs: 300,
    intensity: 30,
    distance: 20,
    color: '#ffb454',
    parkY: -100,
  },
  // Smoke puffs: a few additive billboards per blast, drifting upward and fading out well
  // after the flash (stylized "hot dust" puff, not physically-shaded smoke — same additive
  // fade-to-black trick as the flash/Tracers, so it stays a single draw call with the
  // flash pool; see file-header rationale in fx/Explosions.tsx).
  smoke: {
    puffsPerBlast: 3,
    maxAgeMs: 1200,
    riseSpeed: 1.4, // m/s upward drift
    sizeStart: 1.5,
    sizeEnd: 4.5,
    spreadM: 1.8, // max horizontal drift radius by maxAgeMs
    color: '#cfcac2',
  },
  // Scorch decal: pooled opaque ground quads, cap 24, oldest-recycled ring buffer (same
  // write-cursor model as fx/SkidMarks.tsx's SKID.poolSize). yOffset sits just above
  // SkidMarks' own marks (SKID.yOffset = 0.03) so the two decal layers never z-fight where
  // a blast lands on a skid trail.
  scorch: {
    poolSize: 24,
    yOffset: 0.035,
    sizeScale: 0.9, // decal size = clamp(radiusM * sizeScale, sizeMin, sizeMax)
    sizeMin: 3,
    sizeMax: 7,
    fadeSeconds: 25,
    color: '#141210',
  },
  // Camera shake per blast (fx/cameraRig.addShake strength, m of peak jitter). Deliberately
  // at/above CAMERA.shake.maxAmplitude (0.5) so a single blast saturates the trauma cap
  // immediately — "BIG shake", not a graded response to blast size.
  shakeStrength: 0.6,
  colors: {
    flash: '#fff2c2',
  },
} as const;

// Tank turret telegraph FX (Phase 12 Task 3; TDD §5.6 tank row "barrel glow + laser dot").
// ai/units/tank.ts (Task 2) owns the real telegraph state (progress01, barrel tip, aim
// point) behind an exported getTankTelegraph(slotId) — mirrors ai/units/gunTruck.ts's
// getGunTruckTurretYaw(slotId) publication pattern. This block only holds the ground-laser
// presentation numbers (fx/TankTelegraph.tsx) — the barrel GLOW itself lives on
// ai/units/TankMesh.tsx's own per-instance emissive attribute (that module's real hook, not
// a billboard fallback here — see fx/TankTelegraph.tsx's file header), and gameplay timing
// (TANK.telegraphSec) stays in config/tank.ts.
export const TANK_TELEGRAPH = {
  // Laser line + aim dot fade in over the telegraph so the "about to fire" read ramps
  // with progress01 rather than popping at full brightness immediately.
  lineColor: '#ff2f2f',
  dotColor: '#ff6a4a',
  dotSize: 0.6,
  maxLines: 2, // safety margin above SPAWN.maxTanks (2) — mirrors GunTruckAimViz's MAX_LINES pattern
} as const;
