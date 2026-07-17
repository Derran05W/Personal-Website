// Phase 16 particle-system tunables — the single source of truth for the ONE instanced
// CPU particle system (fx/particles.ts + fx/ParticlesMount.tsx). Every number the sim and
// the renderer read lives here (CLAUDE.md: no magic numbers in fx/particles.ts), typed
// `as const satisfies …` so a typo (missing preset, wrong field) is a compile error and so
// the deeply-nested numeric leaves stay live-tunable through the dev panel's auto-schema
// (core/devPanel.tsx's buildBlockSchema surfaces number/boolean leaves; it skips the
// `colors` string arrays and the `material`/`kind` string tags — tune those in code).
//
// DESIGN (fx/particles.ts's file header has the full rationale):
//  - ONE fixed pool of `poolSize` slots, shared by BOTH render materials. A particle is
//    routed to the additive InstancedMesh or the alpha InstancedMesh purely by its part's
//    `material` tag — never two draw calls per effect, always exactly two for the whole
//    system (TDD §5.6/§5.8/§5.10 juice on a 2-draw-call budget).
//  - Each preset (the 8 names in fx/particleFeed.ts's ParticlePreset union) is EITHER a
//    one-shot `burst` (impacts, debris, explosions, transformer arcs) OR a persistent
//    `emitter` (drift smoke, damage smoke, fire, shell trails). A preset owns one or more
//    `parts`; each part is a homogeneous cloud with its own material/life/motion/colour.
//    Only the `explosion` preset has >1 part (a bright additive ember burst PLUS a slow
//    alpha smoke ring) — every emitter preset is single-part (see the single-accumulator
//    assumption in fx/particles.ts's processEmitters).
//  - `count` is dual-purpose, interpreted by the preset's `kind`:
//      • burst   → particles spawned per unit intensity (a burst of intensity 2 doubles it)
//      • emitter → particles PER SECOND per unit intensity (a spawn RATE, fractionally
//                  accumulated across frames so a 26/s emitter at 60 fps averages ~0.43/frame)
//  - `perSourceCap` bounds how many particles ONE source may spawn in a SINGLE frame — a
//    safety valve against a frame-time spike (huge dt) or a runaway intensity dumping the
//    whole pool from one emitter/burst. Global fairness across many sources is handled
//    separately by the sink's farthest-first starvation, not here.
//
// MOTION MODEL (per part, read live by fx/particles.ts at spawn/integrate time so leva
// edits apply immediately — only the `colors` are pre-parsed to RGB once at module load):
//   spawn velocity = inheritedVelocity
//                    + (cos θ, 0, sin θ)·radialSpeed   (θ random, horizontal outward spray)
//                    + (0, upSpeed, 0)                 (vertical kick)
//   each frame:      v.y += gravity·dt ; v *= (1 − drag·dt) ; p += v·dt ; p.y clamped ≥ groundY
//   so `gravity` NEGATIVE = falls (sparks/debris/embers), POSITIVE = buoyant rise (smoke/fire).
//
// FADE MODEL (fx/ParticlesMount.tsx, per part):
//   t = age/life ∈ [0,1] ; sizeNow = lerp(size.start, size.end, t)·perParticleJitter
//   scalar = fadeIn(t)·(1 − t)^fade.outPow        where fadeIn ramps 0→1 over the first
//                                                  fade.inFrac of life (0 = pop in at full)
//   additive part → instanceColor = colour·scalar  (a black instance is invisible under
//                                                    additive blending — Tracers.tsx's trick)
//   alpha part    → instanceColor = colour ; per-instance opacity = scalar·fade.peakOpacity
//                                                    (real transparency so smoke OCCLUDES,
//                                                     unlike Explosions.tsx's additive haze)

import type { ParticlePreset } from '../fx/particleFeed';

/** One homogeneous cloud within a preset. See file header for how each field is read. */
export interface ParticlePartConfig {
  /** Render material → which of the two InstancedMeshes this part's particles land on.
   * 'additive' = glowing sparks/embers/fire/arcs (fade to black = invisible);
   * 'alpha' = occluding smoke/matte debris (fade via real per-instance opacity). */
  readonly material: 'additive' | 'alpha';
  /** burst: particles per unit intensity · emitter: particles/second per unit intensity. */
  readonly count: number;
  /** Per-particle lifetime window (s); each spawn picks uniformly in [min, max]. */
  readonly life: { readonly min: number; readonly max: number };
  /** Billboard size (m): lerps start→end over life; jitter 0..1 randomises each ±fraction. */
  readonly size: { readonly start: number; readonly end: number; readonly jitter: number };
  /** Spawn velocity spread: horizontal outward speed [radialMin,radialMax] at a random
   * heading, plus a vertical kick [upMin,upMax]. All m/s, added to inherited velocity. */
  readonly speed: {
    readonly radialMin: number;
    readonly radialMax: number;
    readonly upMin: number;
    readonly upMax: number;
  };
  /** Vertical acceleration (m/s²): negative falls, positive gives smoke/fire buoyancy. */
  readonly gravity: number;
  /** Linear velocity damping per second (0 = none; higher = the puff parks quickly). */
  readonly drag: number;
  /** Fade shaping (see file header): inFrac ramps opacity in over the first fraction of
   * life, outPow curves the fade-out (≥1; higher = lingers bright then drops), peakOpacity
   * is the alpha material's peak (additive parts ignore it — brightness rides the colour). */
  readonly fade: { readonly inFrac: number; readonly outPow: number; readonly peakOpacity: number };
  /** Electrical/flame shimmer: the renderer jitters brightness per particle when true. */
  readonly flicker: boolean;
  /** Palette — one is picked at random per particle. Hex strings (leva-skipped: tune here).
   * Pre-parsed to RGB once at module load by fx/particles.ts (never per spawn). */
  readonly colors: readonly string[];
}

/** A named effect: a burst or a persistent emitter, owning one or more parts. */
export interface ParticlePresetConfig {
  readonly kind: 'burst' | 'emitter';
  /** Max particles ONE source spawns in a single frame (per part) — the anti-spike clamp. */
  readonly perSourceCap: number;
  readonly parts: Readonly<Record<string, ParticlePartConfig>>;
}

export const PARTICLES = {
  // Total pool slots across BOTH materials (additive + alpha). Fixed at mount; the effective
  // budget is min(poolSize, QUALITY_TIERS[tier].particleCap) so low tier runs a smaller pool
  // (config/quality.ts). Sized so the "many burning wrecks" worst case (part-file) saturates
  // via farthest-first starvation rather than blowing the frame budget.
  poolSize: 500,
  // Particles never sink below this world-Y (street level ≈ 0) — a spark/chip that lands
  // rests on the ground for the rest of its life instead of tunnelling under the slab.
  groundY: 0.02,
  // Upper bound on emitters considered in one frame's farthest-first ration (reused scratch
  // sizing — see fx/particles.ts). Far above any realistic live-emitter count (a full ★5
  // roster of burning wrecks + shell trails is well under this); extras are simply skipped
  // that frame (FX are droppable, per fx/particleFeed.ts).
  maxTrackedEmitters: 64,

  presets: {
    // -- BURSTS ------------------------------------------------------------------------------

    // Hard contact: a brief warm spark spray at the impact point. Small, fast, gravity-bit.
    impactSparks: {
      kind: 'burst',
      perSourceCap: 30,
      parts: {
        main: {
          material: 'additive',
          count: 10,
          life: { min: 0.18, max: 0.42 },
          size: { start: 0.13, end: 0.02, jitter: 0.35 },
          speed: { radialMin: 2.5, radialMax: 6.5, upMin: 1.5, upMax: 4.5 },
          gravity: -14,
          drag: 1.6,
          fade: { inFrac: 0, outPow: 1.3, peakOpacity: 1 },
          flicker: false,
          colors: ['#fff2b0', '#ffd070', '#ffa838'],
        },
      },
    },

    // Prop destruction: chunky MATTE chips tumbling under strong gravity. Alpha (opaque
    // little cubes of debris, not glowing) so they read as solid at low-poly scale.
    debrisChips: {
      kind: 'burst',
      perSourceCap: 24,
      parts: {
        main: {
          material: 'alpha',
          count: 9,
          life: { min: 0.5, max: 1.1 },
          size: { start: 0.16, end: 0.11, jitter: 0.4 },
          speed: { radialMin: 1.5, radialMax: 4.2, upMin: 2.4, upMax: 5.4 },
          gravity: -20,
          drag: 0.25,
          fade: { inFrac: 0.04, outPow: 2.2, peakOpacity: 1 },
          flicker: false,
          colors: ['#6b5a44', '#7d7168', '#8a8a8a', '#544636'],
        },
      },
    },

    // Blast augment: a bright additive EMBER burst + a slow alpha SMOKE RING. The flash,
    // point-light and scorch decal stay in fx/Explosions.tsx (this only ADDS the embers +
    // ring, per the task brief). The ring's high radial speed makes it read as an expanding
    // shockwave of smoke; the embers arc out and fall.
    explosion: {
      kind: 'burst',
      perSourceCap: 48,
      parts: {
        embers: {
          material: 'additive',
          count: 22,
          life: { min: 0.4, max: 0.95 },
          size: { start: 0.2, end: 0.03, jitter: 0.4 },
          speed: { radialMin: 5, radialMax: 12, upMin: 3, upMax: 9 },
          gravity: -16,
          drag: 0.8,
          fade: { inFrac: 0, outPow: 1.3, peakOpacity: 1 },
          flicker: false,
          colors: ['#fff0b0', '#ffb454', '#ff7020', '#ffd070'],
        },
        ring: {
          material: 'alpha',
          count: 10,
          life: { min: 1, max: 1.9 },
          size: { start: 1, end: 3.6, jitter: 0.3 },
          speed: { radialMin: 3, radialMax: 6, upMin: 0.3, upMax: 1.2 },
          gravity: 0.4,
          drag: 1.3,
          fade: { inFrac: 0.1, outPow: 1.8, peakOpacity: 0.5 },
          flicker: false,
          colors: ['#7a7570', '#928d86', '#63605c'],
        },
      },
    },

    // Transformer death (TDD §5.8 "spark particle burst"): a dense electrical ARC shower —
    // electric blue-white, flickering, fast and short-lived. Pairs with the zap SFX + the
    // district blackout write. The P6 scope-cut spark burst, now delivered.
    transformerSparks: {
      kind: 'burst',
      perSourceCap: 40,
      parts: {
        main: {
          material: 'additive',
          count: 26,
          life: { min: 0.22, max: 0.6 },
          size: { start: 0.1, end: 0.02, jitter: 0.4 },
          speed: { radialMin: 3, radialMax: 8, upMin: 2, upMax: 7 },
          gravity: -18,
          drag: 1.3,
          fade: { inFrac: 0, outPow: 1.2, peakOpacity: 1 },
          flicker: true,
          colors: ['#bfe8ff', '#8fd0ff', '#ffffff', '#d8f0ff'],
        },
      },
    },

    // -- EMITTERS (single-part; owner mutates position/velocity/intensity in place) ----------

    // Drift smoke behind the rear wheels while sliding (fx/SkidMarks pairs the rubber, this
    // pairs the smoke). Light grey, low + short so it hugs the tarmac and clears quickly.
    tireSmoke: {
      kind: 'emitter',
      perSourceCap: 4,
      parts: {
        main: {
          material: 'alpha',
          count: 26,
          life: { min: 0.55, max: 1 },
          size: { start: 0.3, end: 1.1, jitter: 0.3 },
          speed: { radialMin: 0.3, radialMax: 0.9, upMin: 0.4, upMax: 1 },
          gravity: 0.5,
          drag: 1.2,
          fade: { inFrac: 0.15, outPow: 1.6, peakOpacity: 0.34 },
          flicker: false,
          colors: ['#9aa0a6', '#b8bcc0', '#8a9096'],
        },
      },
    },

    // Grey column off a ≥50%-HP-lost vehicle (TDD §5.10 "smoke at < 50% HP"). Darker,
    // bigger, longer-lived than tire smoke — a persistent damage tell that rises and spreads.
    damageSmoke: {
      kind: 'emitter',
      perSourceCap: 4,
      parts: {
        main: {
          material: 'alpha',
          count: 16,
          life: { min: 1, max: 1.8 },
          size: { start: 0.5, end: 2.2, jitter: 0.3 },
          speed: { radialMin: 0.2, radialMax: 0.7, upMin: 1.2, upMax: 2.2 },
          gravity: 0.6,
          drag: 0.6,
          fade: { inFrac: 0.15, outPow: 1.8, peakOpacity: 0.5 },
          flicker: false,
          colors: ['#4a4d52', '#5c5f64', '#6a6d72'],
        },
      },
    },

    // Flame lick off a ≥75%-HP-lost vehicle (TDD §5.10 "fire at < 25%"). Additive, flickering,
    // rising fast (positive gravity = buoyancy) and dying quick so it churns like real fire.
    fire: {
      kind: 'emitter',
      perSourceCap: 5,
      parts: {
        main: {
          material: 'additive',
          count: 22,
          life: { min: 0.35, max: 0.7 },
          size: { start: 0.36, end: 0.05, jitter: 0.3 },
          speed: { radialMin: 0.25, radialMax: 0.7, upMin: 1.8, upMax: 3.2 },
          gravity: 3,
          drag: 1,
          fade: { inFrac: 0.05, outPow: 1.4, peakOpacity: 1 },
          flicker: true,
          colors: ['#ffef90', '#ffd050', '#ff9020', '#ff5a10'],
        },
      },
    },

    // Smoke trail behind a live tank shell (fx follows the shell's world position each frame).
    // Dense (high rate — the shell is fast) but tiny + short so the trail is a thin ribbon.
    shellTrail: {
      kind: 'emitter',
      perSourceCap: 3,
      parts: {
        main: {
          material: 'alpha',
          count: 40,
          life: { min: 0.3, max: 0.7 },
          size: { start: 0.15, end: 0.7, jitter: 0.3 },
          speed: { radialMin: 0.1, radialMax: 0.4, upMin: 0, upMax: 0.4 },
          gravity: 0.2,
          drag: 1,
          fade: { inFrac: 0.1, outPow: 1.6, peakOpacity: 0.4 },
          flicker: false,
          colors: ['#9a9690', '#b0aca6'],
        },
      },
    },
  },
} as const satisfies {
  poolSize: number;
  groundY: number;
  maxTrackedEmitters: number;
  presets: Record<ParticlePreset, ParticlePresetConfig>;
};
