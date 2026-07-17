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
  // Lateral-slip trigger (Phase 16 Task 2; fx/skidMath.ts's lateralSpeedAtYaw/smoothSlip/
  // computeLateralSlip): upgrades the mark + tireSmoke trigger from handbrake-only to
  // "reward deliberate drifts, not gentle cornering" (part-file). The handbrake path stays a
  // straight OR — holding it still always paints, exactly as before this task.
  slip: {
    // |smoothed lateral speed| (m/s) above which a rear-wheel slide counts as a deliberate
    // drift even with NO handbrake. Tuned against VEHICLE_TUNING.wheels' grip (frictionSlip
    // 3.2, sideFrictionStiffness 1.4 — fairly grippy) so ordinary cornering at speed stays
    // well under this and only a real counter-steered powerslide crosses it. Starting
    // point, live-tunable via leva; re-tune by feel if the chassis grip ever changes.
    thresholdMps: 3.5,
    // Lateral speed (m/s) at which slip01 (tireSmoke emitter intensity) saturates to 1. A
    // hard, sustained drift comfortably clears this.
    maxMps: 9,
    // One-pole smoothing factor (0..1, skidMath.ts's smoothSlip) applied to the raw
    // per-frame lateral speed before it's thresholded — higher tracks faster / smooths
    // less. Damps single-frame noise (a curb tap, a suspension settle jolt) so a real drift
    // reads as sustained sideways motion, not a spike.
    smoothingAlpha: 0.3,
  },
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
  // Nominal blast radius (m) the 'explosion' particle burst (fx/particles.ts, Phase 16 Task 1;
  // pushed by combat/explosion.ts alongside pushExplosion) is calibrated at intensity 1.
  // combat/explosion.ts computes intensity = radiusM / this — deliberately a fixed baseline
  // rather than radiusM / TANK.blast.radius (which would always reduce to a tautological 1,
  // since every blast today IS TANK.blast.radius), so a future non-tank explosion source with
  // a different radius scales the burst up/down correctly without that call site changing.
  // Set to TANK.blast.radius's current value (8) — config/tank.ts and this file are siblings
  // with no cross-import convention, so it's a documented duplicate, not an import.
  particleNominalRadiusM: 8,
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

// Helicopter searchlight — the ★2+ "drama package" (Phase 14 Task 3; TDD §5.7 "one real
// SpotLight buys enormous drama for one light's cost" / §8.2 "one heli spotlight"). ONE
// real SpotLight (shadows OFF) hangs from the LEAD heli (ai/heliTypes.ts slot 0) and tracks
// the player with lag + slight overshoot (fx/searchlightMath.ts spring). The visible drama
// is carried by a FAKE volumetric cone (an additive translucent mesh from the heli down to
// the beam's ground intersection) plus a soft ground-spot ellipse — the fixed ~50° follow
// camera (TDD §5.3) rarely looks up at the heli, so the cone/ground-spot ARE the feature,
// not the light itself. Nothing here consults the power grid: it's aircraft light, so it
// renders identically over a blacked-out district (that dark-street contrast is the whole
// point). Colour leaves are hex strings, so the leva auto-schema (core/devPanel.tsx surfaces
// only number/boolean leaves) skips them — tune colours in code + HMR; every number is a
// live "SEARCHLIGHT" folder slider.
export const SEARCHLIGHT = {
  // The one real SpotLight. castShadow is FALSE in the component (additive drama, not a
  // shadow-caster — and the pooled-light budget, POWER_GRID.lightPoolSize=6, leaves room
  // for exactly one more real light). three r155+ is physically-based, so `decay` is kept
  // low: a physically-accurate 1/d² over a 35 m throw would swallow the beam, so this is a
  // stylized reach-to-the-ground value, not a photometric one.
  light: {
    color: '#fff2d0', // warm-white
    intensity: 90,
    halfAngleRad: 0.34, // spot cone half-angle (~19.5°); also drives the fake cone's base radius
    penumbra: 0.75, // soft edge (0 = hard, 1 = fully feathered)
    distance: 70, // cutoff >= the longest beam throw (altitude over the orbit lean)
    decay: 0.9, // < 2 → stylized long reach (see note above)
  },

  // Aim-tracking spring (fx/searchlightMath.ts). The beam chases the player's INTERPOLATED
  // pose (playerRef) with lag then a slight overshoot — "sweeping to catch you", never a
  // rigid snap. ζ (dampingRatio) < 1 gives the overshoot; ~0.5–0.8 s settle at freqHz≈1.4.
  aim: {
    freqHz: 1.4, // chase speed
    dampingRatio: 0.6, // < 1 → slight overshoot; 1 = no overshoot, > 1 = sluggish
    height: 0.4, // m above ground the beam points at (≈ player chassis height)
    maxSubDt: 1 / 120, // spring integrator sub-step cap (stability on frame-time spikes)
  },

  // Fake volumetric cone: an additive translucent mesh, apex at the heli, base ring at the
  // beam→ground intersection, base radius from the spot half-angle. Vertex-colour gradient
  // (bright at the apex → dim at the ground) fakes light attenuation down the shaft;
  // additive + depthWrite off (fx/Tracers.tsx's additive discipline) so it glows and never
  // z-fights. Opacity is PER QUALITY TIER — low tier is dim (P18's mobile pass may trim it
  // to 0, which the component treats as "hide the cone").
  cone: {
    color: '#ffe6a8',
    radialSegments: 28,
    apexBrightness: 1, // vertex brightness at the heli end of the shaft
    baseBrightness: 0.2, // vertex brightness at the ground end (the fade-out)
    radiusScale: 1, // cone base radius = coneBaseRadius(dist, halfAngle) · this
    opacity: { high: 0.17, med: 0.13, low: 0.07 } as Record<'high' | 'med' | 'low', number>,
    flickerAmp: 0.05, // subtle ± opacity noise (searchlight shimmer); 0 = steady
    flickerHz: 6.5,
  },

  // Ground spot: a soft-edged ellipse (radial-gradient CanvasTexture) laid flat at the
  // beam→ground intersection, additive, lifted just above the SkidMarks (0.03) / scorch
  // (0.035) decal layers so it never z-fights them (SkidMarks' y-hygiene rule).
  ground: {
    color: '#ffe6a8',
    yOffset: 0.05,
    radiusScale: 1.4, // spot radius = cone base radius · this (spills a touch past the cone)
    opacity: 0.55,
    textureSize: 128, // CanvasTexture resolution for the radial falloff
  },

  // Presence gate/fade: the LEAD heli slot's `presence` (0..1, ai/helicopter.ts's fly-in/out
  // ramp) multiplies every element's brightness. Below this threshold the whole rig is
  // hidden — and it's fully hidden whenever slot 0 is empty / no run is live.
  presenceThreshold: 0.02,
} as const;

// Police/armored lightbar strobe pattern (Phase 16 Task 3 polish; TDD §5.6). Replaces the
// original Phase 9/10 ad-hoc inline `phase = (t*3 + i*0.13) % 1; phase < 0.5 ? 1 : 0` (a
// single-colour 50/50 blink) with a named, config-driven pattern that ALTERNATES two colours
// (red/blue) rather than just gating one on and off. Consumed by fx/lightbarStrobe.ts's pure
// lightbarPhase() — ai/units/PoliceMesh.tsx and ai/units/ArmoredMesh.tsx are the only two
// live lightbar-bearing units (SWAT/gun-truck/tank/heli are all deliberately unmarked/no-
// strobe, see each of those files' own header) and both consume the SAME pattern here so a
// mixed police+armored roster reads as one consistent strobe language.
export const LIGHTBAR = {
  // Full red+blue cycle rate (Hz) — one complete "red flash, blue flash" pair per this many
  // seconds' reciprocal. Matches the old hardcoded STROBE_HZ = 3.
  hz: 3,
  // Fraction of the cycle red owns before handing off to blue (the "alternation" split).
  // 0.5 = symmetric; TDD gives no number, so this is the tuned starting point.
  splitFrac: 0.5,
  // Fraction of ITS half-cycle the active colour is actually lit, vs. dark — < 0.5 gives a
  // snappier double-flash beacon look instead of a slow on/off square wave. STARTING POINT,
  // live-tunable.
  duty: 0.55,
  // Per-instance phase offset (fraction of a cycle, × pool index) so a multi-car roster
  // doesn't blink in lockstep — matches the old hardcoded `i * 0.13`.
  phaseStaggerPerInstance: 0.13,
} as const;
