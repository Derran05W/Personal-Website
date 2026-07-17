// Synthesized sound library (Phase 15 Task 2). EVERY sound in this game is a small,
// parameterized WebAudio graph built from oscillators, noise buffers and filters — there are
// NO audio files anywhere in the repo (a LOCKED decision: CC0 audio packs are firewalled the
// same as every other network fetch in this sandbox, and a file-player without files buys
// nothing). Precedent for the whole approach is audio/sirens.ts's two-oscillator wail; this
// module is that idea, generalised into a builder-per-sound-family library.
//
// QUALITY BAR (phase plan): placeholder-tier — "readable, not annoying". Arcade-y is GOOD.
// These are meant to be swapped for real CC0 samples later, behind the same manager seam, so
// they only have to communicate ("that was an impact", "the engine is revving") without
// grating. Nobody is mixing an album here.
//
// --- the manager seam (audio/manager.ts, Task 1 — PARALLEL) --------------------------------
// A "sound builder" is a pure-ish factory: `(ctx, destination, params?) => VoiceHandle`. It
// wires up (but does NOT start) a sub-graph feeding `destination` — a bus GainNode the manager
// owns (master/sfx/engine/ambient) or, later, a per-voice StereoPanner from the positional
// system (Task 3). The returned VoiceHandle is the manager's control surface: `start()`,
// `stop()`, an `onEnded` hook (fired EXACTLY ONCE when the graph has fully released, so the
// manager can decrement its liveVoiceCount / free a pool slot), and — on the few sounds that
// have live parameters — setters (`engine.setSpeed`).
//
// Task 1's manager was NOT on disk when this landed, so this file imports NOTHING from it (a
// static import of a missing module would break the build) and instead OFFERS the seam:
//   • every builder is exported directly (usable against a raw AudioContext or the manager),
//   • `SOUND_BUILDERS` is a name->builder record under the stable registration names,
//   • `registerAllSounds(registerSound)` registers the whole library in one call.
// When the manager lands, its init does `registerAllSounds(registerSound)` (or reads
// SOUND_BUILDERS directly) — no changes needed here. See phase-15 notes.
//
// --- verification scope --------------------------------------------------------------------
// jsdom (this repo's unit-test DOM) has no Web Audio API, exactly as sirens.ts documents, so
// the impure graph code below is NOT unit-tested. Every DECISION that shapes a sound —
// speed->frequency curves, per-variant impact seeding, tier->motif derivation, cricket chirp
// scheduling — is factored into the pure, dependency-free functions in the "pure core" section
// and fully covered by synth.test.ts. Audible quality is a human-ears check on real hardware
// (the standing item for this phase); structural liveness (voices start/stop, no orphans, 0
// console errors) is verified by firing each builder through the manager / a raw ctx in a live
// dev page-eval.

// ============================================================================================
// SYNTH_PARAMS — every frequency, duration and gain, in one config-adjacent const.
// ============================================================================================
// CLAUDE.md wants tunables in game/config/; the phase plan explicitly sanctions a local
// SYNTH_PARAMS module const for this task (config/audio.ts is being extended in PARALLEL by
// Tasks 1 & 4 — the runtime MIX/ducking lives there — so keeping the synth's own shape here
// avoids stepping on those edits). Gains are pre-mix, unit-ish levels; the manager's bus gains
// and Task 4's AUDIO_MIX scale them. Durations are seconds unless the name says `Ms`.
export const SYNTH_PARAMS = {
  engine: {
    /** Nominal fundamental (Hz) at the middle of the rev range; speed scales it by mul. */
    nominalHz: 90,
    /** Frequency multiplier at speed 0 / speed 1 — 0.6x..1.8x of nominalHz => ~54..162 Hz. */
    minMul: 0.6,
    maxMul: 1.8,
    /** Sub-octave triangle body layer, as a ratio of the fundamental (0.5 = one octave down). */
    subRatio: 0.5,
    /** Lowpass cutoff (Hz) at idle / full — kept well under a hissy range so it reads as a
     *  low-poly engine rumble, never a vacuum-cleaner whine. */
    minCutoffHz: 340,
    maxCutoffHz: 1400,
    /** Filter resonance (Q) — a little bump gives the rev some vowel without ringing. */
    filterQ: 3,
    /** Broadband grit mixed under the tone. Base is always-on air; grit adds with throttle. */
    noiseBaseGain: 0.02,
    noiseGritGain: 0.05,
    /** Amplitude "lope" tremolo — idle chug that speeds up under revs. Depth is a fraction of
     *  the engine gain (subtle: enough to feel alive, not a helicopter). */
    tremoloMinHz: 7,
    tremoloMaxHz: 22,
    tremoloDepth: 0.16,
    /** Glide time-constant (s) for setTargetAtTime on every live param change — smooth, no
     *  zipper, but still snappy enough to feel connected to the throttle. */
    glideTau: 0.06,
    /** Overall engine voice level (pre bus/mix). */
    gain: 0.18,
    /** Oscillator layer mix. */
    sawGain: 0.6,
    triGain: 0.5,
  },
  impact: {
    /** Number of seeded variants the 'impact' builder rotates through (velocity picks gain/
     *  pitch; `variant` picks timbre). */
    variantCount: 4,
    /** Duration window (ms) — a fast knock, 80..200 ms. Seeded per variant. */
    durMinMs: 80,
    durMaxMs: 200,
    /** Low sine "knock" fundamental window (Hz) — the body of the thud. */
    knockMinHz: 70,
    knockMaxHz: 190,
    /** Lowpass over the noise burst (Hz) — variant timbre (dull crate vs sharp metal). */
    filterMinHz: 900,
    filterMaxHz: 3200,
    /** Velocity (0..1) -> gain and pitch scaling. */
    gainMin: 0.12,
    gainMax: 0.85,
    pitchMin: 0.8,
    pitchMax: 1.35,
    /** Split of noise-crack vs sine-knock energy. */
    noiseGain: 0.7,
    knockGain: 0.9,
  },
  gunshot: {
    durMs: 120,
    /** Noise crack lowpass (Hz) — sharp, bright. */
    crackCutoffHz: 5200,
    /** Square "blip" pitch-down (Hz) — the little body of the report. */
    blipStartHz: 320,
    blipEndHz: 90,
    gain: 0.55,
  },
  shellLaunch: {
    /** Deeper, longer than a gunshot: a whoomp then a crack. */
    durMs: 260,
    whoompStartHz: 150,
    whoompEndHz: 44,
    crackCutoffHz: 3000,
    gain: 0.75,
  },
  explosion: {
    // Near = big and present; far = the same event heard through air: pre-lowpassed at the
    // source (duller), quieter, and with a longer, lazier tail.
    near: {
      durationSec: 1.2,
      /** 40 Hz sine drop — the gut-punch. */
      dropStartHz: 130,
      dropEndHz: 40,
      /** Lowpass "closes" from bright to dark over the tail. */
      cutoffStartHz: 3200,
      cutoffEndHz: 260,
      gain: 0.9,
    },
    far: {
      durationSec: 1.9,
      dropStartHz: 90,
      dropEndHz: 34,
      cutoffStartHz: 900,
      cutoffEndHz: 160,
      gain: 0.35,
    },
  },
  transformer: {
    hum: {
      /** Mains-ish fundamental + harmonics; quiet, continuous, dark. */
      fundamentalHz: 60,
      harmonics: [1, 2, 3] as const,
      harmonicGains: [1, 0.4, 0.18] as const,
      /** Slight detune (Hz) between the two stereo-ish stacks for a live buzz. */
      detuneHz: 0.7,
      cutoffHz: 520,
      gain: 0.05,
    },
    zap: {
      /** Bandpassed noise crackle: a burst of short spikes over ~0.4 s. */
      durationSec: 0.4,
      bandHz: 2600,
      bandQ: 6,
      crackleCount: 7,
      gain: 0.5,
    },
    whoomp: {
      /** Power-down: a pitch-diving sine plus a noise wash, ~0.8 s. */
      durationSec: 0.8,
      diveStartHz: 210,
      diveEndHz: 32,
      washCutoffHz: 700,
      gain: 0.55,
    },
  },
  ambience: {
    city: {
      /** Very quiet filtered brown-noise bed (distant traffic wash). */
      bedCutoffHz: 420,
      bedGain: 0.035,
      /** Occasional distant-horn blip: sparse, randomized gaps (s). */
      hornMinGapSec: 6,
      hornMaxGapSec: 16,
      hornHz: 300,
      hornDurSec: 0.5,
      hornGain: 0.06,
    },
    crickets: {
      /** Pulsed 4–5 kHz chirp trains with randomized gaps — the DARK CITY bed. */
      chirpHz: 4600,
      /** Pulses per chirp train, and pulse timing. */
      pulsesPerChirp: 3,
      pulseDurSec: 0.02,
      pulseGapSec: 0.035,
      /** Randomized silence between chirp trains (s). */
      minGapSec: 0.25,
      maxGapSec: 0.9,
      gain: 0.08,
    },
  },
  stinger: {
    /** ★1 root (Hz); each tier transposes up by tierSemitoneStep for a rising register. */
    baseRootHz: 165,
    tierSemitoneStep: 3,
    /** Menace intervals (semitones from root). 2 notes at low tiers, 3 at ★3+. Minor 2nd and
     *  the tritone carry the tension. */
    twoNoteSemis: [0, 6] as const,
    threeNoteSemis: [0, 1, 6] as const,
    /** Note spacing tightens with tier (rising urgency); total motif stays ≈ 0.8 s. */
    gapMaxSec: 0.3,
    gapMinSec: 0.17,
    noteDurRatio: 0.9,
    /** Detuned-saw stab through a lowpass = a brassy menace. */
    cutoffHz: 1600,
    gain: 0.3,
  },
  wrecked: {
    /** Descending "crunch" — three notes falling, plus a noise crunch layer. */
    rootHz: 240,
    fallSemis: [0, -5, -11] as const,
    noteDurSec: 0.22,
    gapSec: 0.12,
    crunchCutoffHz: 1200,
    crunchGain: 0.5,
    gain: 0.45,
  },
  busted: {
    /** Two-tone brass-ish stab, alternating hi/lo over ~1 s to sync with the red/blue wash. */
    hiHz: 466,
    loHz: 311,
    hits: 4,
    totalSec: 1.0,
    cutoffHz: 1500,
    gain: 0.4,
  },
  ui: {
    /** Short, dry click/blip. */
    freqHz: 1700,
    durMs: 30,
    gain: 0.18,
  },
  // Phase 19 Task 2: raccoon-hit squeak (audio/eventMap.ts's propDestroyed archetype filter).
  squeak: {
    /** A quick upward pitch sweep — the opposite direction of gunshot's pitch-down blip,
     *  which is exactly what reads as a small critter's "eek!" rather than a mechanical hit. */
    durMs: 130,
    startHz: 900,
    endHz: 2100,
    gain: 0.32,
  },
} as const;

// ============================================================================================
// Seam types — the manager (Task 1) codes to these.
// ============================================================================================

/** A live sound. `onEnded` is set by the manager AFTER build; the voice invokes it exactly
 *  once when its graph is fully released — a one-shot at its natural end, a loop after stop()'s
 *  release tail — so the manager can free the pool slot / decrement liveVoiceCount. */
export interface VoiceHandle {
  /** Begin playback. `when` is an AudioContext time (default: now). Call once. */
  start(when?: number): void;
  /** Release the voice. `when` optional (default: now). Idempotent and safe after a natural
   *  end (already-stopped nodes are swallowed). Triggers `onEnded` after any release tail. */
  stop(when?: number): void;
  /** Set by the manager; see interface doc. */
  onEnded?: () => void;
}

/** The engine loop's live control surface (registered as 'engine'). */
export interface EngineVoice extends VoiceHandle {
  /** 0..1 normalized speed -> fundamental (~54..162 Hz) + filter tracking. Smooth-glided. */
  setSpeed(speed01: number): void;
  /** 0..1 throttle -> broadband grit under the tone. */
  setThrottle(throttle01: number): void;
}

/** Loose, all-optional parameter bag shared by every builder — each reads only the fields it
 *  cares about. Keeps the manager's registration record uniform (`Record<name, SoundBuilder>`)
 *  while individual builders (buildEngine) still expose precise return types when used direct. */
export interface SoundParams {
  /** Impact/gunshot/explosion strength, 0..1. */
  readonly velocity?: number;
  /** Explosion/generic intensity, 0..1. */
  readonly intensity?: number;
  /** Engine speed, 0..1. */
  readonly speed?: number;
  /** Engine throttle, 0..1. */
  readonly throttle?: number;
  /** Impact timbre variant index (0..variantCount-1); wraps if out of range. */
  readonly variant?: number;
  /** Deterministic seed for per-instance variation (crickets, impact jitter). */
  readonly seed?: number;
  /** Wanted tier 1..5 (stinger). */
  readonly tier?: number;
  /** Per-call gain trim, 0..1 (UI ticks, manual balancing). */
  readonly gain?: number;
  /** Phase 17: per-car base pitch multiplier for the engine loop (buildEngine only). 1 = the
   *  Rusty Sedan; <1 deeper (bus/streetcar), >1 brighter (racer). Multiplies the speed-tracked
   *  fundamental so the whole rev range transposes with the car. Defaults to 1 when absent. */
  readonly enginePitch?: number;
}

/** A sound factory. Wires the graph feeding `destination`; does NOT start it. */
export type SoundBuilder = (
  ctx: AudioContext,
  destination: AudioNode,
  params?: SoundParams,
) => VoiceHandle;

/** The stable registration names (TDD §11 channels + the escalation/UI additions). */
export type SoundName =
  | 'engine'
  | 'impact'
  | 'gunshot'
  | 'shellLaunch'
  | 'explosionNear'
  | 'explosionFar'
  | 'transformerHum'
  | 'transformerZap'
  | 'powerDownWhoomp'
  | 'ambienceCity'
  | 'ambienceCrickets'
  | 'stingerTier1'
  | 'stingerTier2'
  | 'stingerTier3'
  | 'stingerTier4'
  | 'stingerTier5'
  | 'stingerWrecked'
  | 'stingerBusted'
  | 'uiTick'
  | 'squeak';

/** Shape of the manager's registration function (Task 1). */
export type RegisterSound = (name: SoundName, builder: SoundBuilder) => void;

// ============================================================================================
// Pure core — no Web Audio, fully unit-tested (synth.test.ts).
// ============================================================================================

/** Ratio of one equal-tempered semitone. */
export const SEMITONE = Math.pow(2, 1 / 12);

/** Clamp to [0, 1], treating non-finite input as 0 (defensive against stray NaN reads, same
 *  spirit as sirens.distanceFalloff). */
export function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

/** Linear interpolation. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Transpose a frequency by a signed number of equal-tempered semitones. */
export function transpose(baseHz: number, semitones: number): number {
  return baseHz * Math.pow(SEMITONE, semitones);
}

/** Small deterministic PRNG (mulberry32). Given the same 32-bit seed it always yields the same
 *  0..1 sequence — the basis of reproducible per-variant / per-instance jitter. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- engine speed/throttle curves ------------------------------------------------------------

/** Speed (0..1) -> fundamental-frequency multiplier (minMul..maxMul). */
export function engineFreqMultiplier(
  speed01: number,
  cfg: { readonly minMul: number; readonly maxMul: number } = SYNTH_PARAMS.engine,
): number {
  return lerp(cfg.minMul, cfg.maxMul, clamp01(speed01));
}

/** Speed (0..1) -> fundamental frequency (Hz), i.e. nominalHz * multiplier. Lands in ~54..162
 *  Hz for the default config — the low, driveable range that keeps this a rumble not a whine. */
export function engineBaseFreq(
  speed01: number,
  cfg: {
    readonly nominalHz: number;
    readonly minMul: number;
    readonly maxMul: number;
  } = SYNTH_PARAMS.engine,
): number {
  return cfg.nominalHz * engineFreqMultiplier(speed01, cfg);
}

/** Speed (0..1) -> lowpass cutoff (Hz). Brighter with speed, capped short of hiss. */
export function engineFilterCutoff(
  speed01: number,
  cfg: { readonly minCutoffHz: number; readonly maxCutoffHz: number } = SYNTH_PARAMS.engine,
): number {
  return lerp(cfg.minCutoffHz, cfg.maxCutoffHz, clamp01(speed01));
}

/** Speed (0..1) -> tremolo/"lope" rate (Hz). The idle chug that quickens under revs. */
export function engineTremoloRate(
  speed01: number,
  cfg: { readonly tremoloMinHz: number; readonly tremoloMaxHz: number } = SYNTH_PARAMS.engine,
): number {
  return lerp(cfg.tremoloMinHz, cfg.tremoloMaxHz, clamp01(speed01));
}

/** Throttle (0..1) -> broadband grit gain (base air + throttle grit). */
export function engineGritGain(
  throttle01: number,
  cfg: { readonly noiseBaseGain: number; readonly noiseGritGain: number } = SYNTH_PARAMS.engine,
): number {
  return cfg.noiseBaseGain + cfg.noiseGritGain * clamp01(throttle01);
}

// --- impact variants -------------------------------------------------------------------------

export interface ImpactVariantParams {
  readonly durationSec: number;
  readonly knockHz: number;
  readonly filterHz: number;
  /** Which noise colour the crack uses — brighter variants read as metal, duller as crate. */
  readonly bright: number;
}

/** Deterministic per-variant timbre. Same `variant` always yields the same params; different
 *  variants differ (at least in knockHz). Wraps out-of-range indices so a bad caller can't
 *  crash — it just reuses a variant. */
export function impactVariantParams(
  variant: number,
  cfg = SYNTH_PARAMS.impact,
): ImpactVariantParams {
  const idx = ((Math.trunc(variant) % cfg.variantCount) + cfg.variantCount) % cfg.variantCount;
  // Seed off the index so variants are stable across sessions (a run's 3rd crate always sounds
  // like variant 3), but spread across the timbre ranges rather than evenly stepped (evenly
  // stepped variants sound like a scale; jittered ones sound like different objects).
  const rng = mulberry32(0x1a2b + idx * 0x9e37);
  return {
    durationSec: lerp(cfg.durMinMs, cfg.durMaxMs, rng()) / 1000,
    knockHz: lerp(cfg.knockMinHz, cfg.knockMaxHz, rng()),
    filterHz: lerp(cfg.filterMinHz, cfg.filterMaxHz, rng()),
    bright: rng(),
  };
}

/** Velocity (0..1) -> impact gain (harder hit, louder). */
export function impactVelocityGain(velocity01: number, cfg = SYNTH_PARAMS.impact): number {
  return lerp(cfg.gainMin, cfg.gainMax, clamp01(velocity01));
}

/** Velocity (0..1) -> impact pitch multiplier (harder hit, tighter/higher knock). */
export function impactVelocityPitch(velocity01: number, cfg = SYNTH_PARAMS.impact): number {
  return lerp(cfg.pitchMin, cfg.pitchMax, clamp01(velocity01));
}

// --- explosion near/far ----------------------------------------------------------------------

export interface ExplosionParams {
  readonly durationSec: number;
  readonly dropStartHz: number;
  readonly dropEndHz: number;
  readonly cutoffStartHz: number;
  readonly cutoffEndHz: number;
  readonly gain: number;
}

/** Near vs far explosion shaping. Far is the same event through air: quieter, duller
 *  (pre-lowpassed), and longer-tailed. */
export function explosionVariantParams(variant: 'near' | 'far'): ExplosionParams {
  return { ...SYNTH_PARAMS.explosion[variant] };
}

// --- stinger / wrecked / busted motifs -------------------------------------------------------

export interface MotifNote {
  /** Frequency (Hz). */
  readonly freqHz: number;
  /** Start time offset from the motif's start (s). */
  readonly atSec: number;
  /** Sounding duration (s). */
  readonly durSec: number;
}

export interface Motif {
  readonly rootHz: number;
  readonly notes: readonly MotifNote[];
  readonly gain: number;
}

/** ★-tier menace motif. Higher tier = higher register (rising root) and tighter spacing
 *  (rising urgency); ★3+ get a third note. Total span stays ≈ 0.8 s. Tier is clamped to 1..5. */
export function stingerMotif(tier: number, cfg = SYNTH_PARAMS.stinger): Motif {
  const t = Math.min(5, Math.max(1, Math.trunc(tier)));
  const rootHz = transpose(cfg.baseRootHz, (t - 1) * cfg.tierSemitoneStep);
  const semis = t >= 3 ? cfg.threeNoteSemis : cfg.twoNoteSemis;
  // Urgency: spacing shrinks from gapMax (★1) to gapMin (★5).
  const gap = lerp(cfg.gapMaxSec, cfg.gapMinSec, (t - 1) / 4);
  const durSec = gap * cfg.noteDurRatio;
  const notes: MotifNote[] = semis.map((s, i) => ({
    freqHz: transpose(rootHz, s),
    atSec: i * gap,
    durSec,
  }));
  return { rootHz, notes, gain: cfg.gain };
}

/** WRECKED: a falling three-note crunch. Frequencies strictly descend. */
export function wreckedMotif(cfg = SYNTH_PARAMS.wrecked): Motif {
  const notes: MotifNote[] = cfg.fallSemis.map((s, i) => ({
    freqHz: transpose(cfg.rootHz, s),
    atSec: i * cfg.gapSec,
    durSec: cfg.noteDurSec,
  }));
  return { rootHz: cfg.rootHz, notes, gain: cfg.gain };
}

/** BUSTED: a two-tone brass stab alternating hi/lo over ~1 s (syncs to the red/blue wash). */
export function bustedMotif(cfg = SYNTH_PARAMS.busted): Motif {
  const step = cfg.totalSec / cfg.hits;
  const notes: MotifNote[] = [];
  for (let i = 0; i < cfg.hits; i++) {
    notes.push({
      freqHz: i % 2 === 0 ? cfg.hiHz : cfg.loHz,
      atSec: i * step,
      durSec: step * 0.92,
    });
  }
  return { rootHz: cfg.hiHz, notes, gain: cfg.gain };
}

// --- cricket chirp schedule ------------------------------------------------------------------

export interface CricketGap {
  /** Silence (s) BEFORE this chirp train. */
  readonly gapSec: number;
}

/** Deterministic sequence of randomized inter-chirp gaps for the DARK CITY cricket bed. Same
 *  seed -> same rhythm; gaps stay within [minGapSec, maxGapSec]. Pure so the pattern is
 *  testable without a real AudioContext; the builder just walks it, scheduling one chirp train
 *  per entry. */
export function cricketChirpSchedule(
  seed: number,
  count: number,
  cfg = SYNTH_PARAMS.ambience.crickets,
): CricketGap[] {
  const rng = mulberry32(seed >>> 0);
  const out: CricketGap[] = [];
  for (let i = 0; i < Math.max(0, Math.trunc(count)); i++) {
    out.push({ gapSec: lerp(cfg.minGapSec, cfg.maxGapSec, rng()) });
  }
  return out;
}

// ============================================================================================
// Impure graph helpers.
// ============================================================================================

/** A gain floor for exponential ramps (can't target exactly 0). */
const EPS = 0.0001;

type NoiseColor = 'white' | 'brown';

/** Fill a buffer with white or brown noise. Brown = leaky-integrated white (a soft, low
 *  rumble); white = flat (bright cracks/hiss). Not seeded — noise wants to be noise. */
function fillNoise(data: Float32Array, color: NoiseColor): void {
  if (color === 'white') {
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return;
  }
  let last = 0;
  for (let i = 0; i < data.length; i++) {
    const w = Math.random() * 2 - 1;
    last = (last + 0.02 * w) / 1.02;
    data[i] = last * 3.5;
  }
}

/** A ready-to-start noise source of `seconds` length. `loop` for continuous beds. */
function makeNoise(
  ctx: AudioContext,
  seconds: number,
  color: NoiseColor,
  loop = false,
): AudioBufferSourceNode {
  const frames = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
  fillNoise(buffer.getChannelData(0), color);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = loop;
  return src;
}

/** Percussive gain envelope on `param`: fast attack to `peak`, hold, exponential release to
 *  silence. Returns the absolute time the release completes (for scheduling node stops). */
function percEnvelope(
  param: AudioParam,
  when: number,
  peak: number,
  attack: number,
  hold: number,
  release: number,
): number {
  const p = Math.max(EPS, peak);
  param.cancelScheduledValues(when);
  param.setValueAtTime(EPS, when);
  param.exponentialRampToValueAtTime(p, when + attack);
  const relStart = when + attack + hold;
  param.setValueAtTime(p, relStart);
  const end = relStart + release;
  param.exponentialRampToValueAtTime(EPS, end);
  param.setValueAtTime(0, end);
  return end;
}

/** Guards `onEnded` to fire at most once. Every builder routes its natural end and its stop()
 *  through the returned function so the manager's slot is freed exactly one time. */
function endGuard(handle: VoiceHandle): () => void {
  let fired = false;
  return () => {
    if (fired) return;
    fired = true;
    handle.onEnded?.();
  };
}

/** Safe oscillator/source stop — swallows the throw from stopping an already-stopped node. */
function safeStop(node: AudioScheduledSourceNode, when?: number): void {
  try {
    node.stop(when);
  } catch {
    // Already stopped (natural end, or a double stop() from eviction) — harmless.
  }
}

// ============================================================================================
// Builders. Each returns a VoiceHandle wired to `destination` but NOT started.
// ============================================================================================

// --- 1. Engine loop --------------------------------------------------------------------------
// Design: a sawtooth fundamental + a sub-octave triangle (weight, not whine) summed through a
// speed-tracked lowpass, with a subtle broadband grit layer and an amplitude "lope" tremolo.
// setSpeed glides the fundamental (~54..162 Hz), the sub, the cutoff and the lope rate together;
// setThrottle rides the grit. Single-layer — see the engine verdict in the phase notes.
export function buildEngine(
  ctx: AudioContext,
  destination: AudioNode,
  params?: SoundParams,
): EngineVoice {
  const p = SYNTH_PARAMS.engine;
  // Phase 17: per-car base pitch multiplier — transposes the whole speed-tracked rev range so a
  // bus rumbles low (0.7) and a street racer sings high (1.35). Read once at build; the engine
  // loop is rebuilt per run (runStarted), and a car can't change mid-run. Clamped positive.
  const basePitch = params?.enginePitch !== undefined && params.enginePitch > 0 ? params.enginePitch : 1;

  const out = ctx.createGain();
  out.gain.value = 0; // faded in on start(), so binding the engine never pops.
  out.connect(destination);

  // Amplitude "lope": lfo -> tremGain -> out.gain (sums on top of the base gain).
  const trem = ctx.createOscillator();
  trem.type = 'sine';
  const tremDepth = ctx.createGain();
  tremDepth.gain.value = p.gain * p.tremoloDepth;
  trem.connect(tremDepth);
  tremDepth.connect(out.gain);

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.Q.value = p.filterQ;
  filter.connect(out);

  const saw = ctx.createOscillator();
  saw.type = 'sawtooth';
  const sawGain = ctx.createGain();
  sawGain.gain.value = p.sawGain;
  saw.connect(sawGain);
  sawGain.connect(filter);

  const tri = ctx.createOscillator();
  tri.type = 'triangle';
  const triGain = ctx.createGain();
  triGain.gain.value = p.triGain;
  tri.connect(triGain);
  triGain.connect(filter);

  // Grit: a looping white-noise bed through its own gain, into the same filter.
  const noise = makeNoise(ctx, 1.5, 'white', true);
  const noiseGain = ctx.createGain();
  noiseGain.gain.value = p.noiseBaseGain;
  noise.connect(noiseGain);
  noiseGain.connect(filter);

  const handle = { onEnded: undefined } as EngineVoice;
  const fireEnded = endGuard(handle);
  let started = false;

  const applySpeed = (speed01: number, when: number, immediate = false): void => {
    // Per-car pitch transposes the fundamental (and, via subRatio, the sub) together.
    const f = engineBaseFreq(speed01) * basePitch;
    const tau = immediate ? EPS : p.glideTau;
    saw.frequency.setTargetAtTime(f, when, tau);
    tri.frequency.setTargetAtTime(f * p.subRatio, when, tau);
    filter.frequency.setTargetAtTime(engineFilterCutoff(speed01), when, tau);
    trem.frequency.setTargetAtTime(engineTremoloRate(speed01), when, tau);
  };
  const applyThrottle = (throttle01: number, when: number, immediate = false): void => {
    noiseGain.gain.setTargetAtTime(engineGritGain(throttle01), when, immediate ? EPS : p.glideTau);
  };

  handle.start = (when = ctx.currentTime) => {
    if (started) return;
    started = true;
    applySpeed(params?.speed ?? 0, when, true);
    applyThrottle(params?.throttle ?? 0, when, true);
    saw.start(when);
    tri.start(when);
    trem.start(when);
    noise.start(when);
    out.gain.setValueAtTime(EPS, when);
    out.gain.linearRampToValueAtTime(p.gain, when + 0.12);
  };
  handle.setSpeed = (speed01: number) => applySpeed(speed01, ctx.currentTime);
  handle.setThrottle = (throttle01: number) => applyThrottle(throttle01, ctx.currentTime);
  handle.stop = (when = ctx.currentTime) => {
    out.gain.cancelScheduledValues(when);
    out.gain.setTargetAtTime(0, when, 0.05);
    const end = when + 0.3;
    safeStop(saw, end);
    safeStop(tri, end);
    safeStop(trem, end);
    safeStop(noise, end);
    saw.onended = fireEnded;
  };
  return handle;
}

// --- 2. Impact thumps (3–4 seeded variants) --------------------------------------------------
// A filtered white-noise crack + a low sine "knock", 80–200 ms. `variant` picks the timbre,
// `velocity` scales gain and pitch.
export function buildImpact(
  ctx: AudioContext,
  destination: AudioNode,
  params?: SoundParams,
): VoiceHandle {
  const cfg = SYNTH_PARAMS.impact;
  const v = impactVariantParams(params?.variant ?? 0);
  const vel = clamp01(params?.velocity ?? 0.6);
  const gain = impactVelocityGain(vel);
  const pitch = impactVelocityPitch(vel);

  const out = ctx.createGain();
  out.gain.value = EPS;
  out.connect(destination);

  // Noise crack.
  const noise = makeNoise(ctx, v.durationSec, 'white');
  const noiseFilter = ctx.createBiquadFilter();
  noiseFilter.type = 'lowpass';
  noiseFilter.frequency.value = v.filterHz * pitch;
  const noiseGain = ctx.createGain();
  noiseGain.gain.value = cfg.noiseGain;
  noise.connect(noiseFilter);
  noiseFilter.connect(noiseGain);
  noiseGain.connect(out);

  // Low sine knock.
  const knock = ctx.createOscillator();
  knock.type = 'sine';
  const knockGain = ctx.createGain();
  knockGain.gain.value = EPS;
  knock.connect(knockGain);
  knockGain.connect(out);

  const handle = { onEnded: undefined } as VoiceHandle;
  const fireEnded = endGuard(handle);

  handle.start = (when = ctx.currentTime) => {
    const dur = v.durationSec;
    // Master shape.
    out.gain.setValueAtTime(gain, when);
    // Knock: pitch drops as it thumps.
    const kHz = v.knockHz * pitch;
    knock.frequency.setValueAtTime(kHz, when);
    knock.frequency.exponentialRampToValueAtTime(Math.max(20, kHz * 0.6), when + dur);
    const knockEnd = percEnvelope(knockGain.gain, when, cfg.knockGain, 0.004, dur * 0.15, dur * 0.7);
    // Noise: sharp attack, quick decay.
    const noiseEnd = percEnvelope(noiseGain.gain, when, cfg.noiseGain, 0.002, 0, dur * 0.6);
    const end = Math.max(knockEnd, noiseEnd);
    noise.start(when);
    safeStop(noise, end);
    knock.start(when);
    safeStop(knock, end);
    knock.onended = fireEnded;
  };
  handle.stop = (when = ctx.currentTime) => {
    safeStop(noise, when);
    safeStop(knock, when);
    fireEnded();
  };
  return handle;
}

// --- 3. Gunshot + shell launch ---------------------------------------------------------------
// Gunshot: a sharp white-noise crack + a fast pitch-down square blip, ~120 ms.
export function buildGunshot(
  ctx: AudioContext,
  destination: AudioNode,
): VoiceHandle {
  const cfg = SYNTH_PARAMS.gunshot;
  const dur = cfg.durMs / 1000;

  const out = ctx.createGain();
  out.gain.value = cfg.gain;
  out.connect(destination);

  const noise = makeNoise(ctx, dur, 'white');
  const crackFilter = ctx.createBiquadFilter();
  crackFilter.type = 'lowpass';
  crackFilter.frequency.value = cfg.crackCutoffHz;
  const crackGain = ctx.createGain();
  crackGain.gain.value = EPS;
  noise.connect(crackFilter);
  crackFilter.connect(crackGain);
  crackGain.connect(out);

  const blip = ctx.createOscillator();
  blip.type = 'square';
  const blipGain = ctx.createGain();
  blipGain.gain.value = EPS;
  blip.connect(blipGain);
  blipGain.connect(out);

  const handle = { onEnded: undefined } as VoiceHandle;
  const fireEnded = endGuard(handle);

  handle.start = (when = ctx.currentTime) => {
    const crackEnd = percEnvelope(crackGain.gain, when, 0.9, 0.001, 0, dur * 0.7);
    blip.frequency.setValueAtTime(cfg.blipStartHz, when);
    blip.frequency.exponentialRampToValueAtTime(cfg.blipEndHz, when + dur * 0.6);
    const blipEnd = percEnvelope(blipGain.gain, when, 0.5, 0.001, 0, dur * 0.5);
    const end = Math.max(crackEnd, blipEnd);
    noise.start(when);
    safeStop(noise, end);
    blip.start(when);
    safeStop(blip, end);
    noise.onended = fireEnded;
  };
  handle.stop = (when = ctx.currentTime) => {
    safeStop(noise, when);
    safeStop(blip, when);
    fireEnded();
  };
  return handle;
}

// Shell launch: a deeper whoomp (pitch-diving sine) then a crack — heavier than a gunshot.
export function buildShellLaunch(
  ctx: AudioContext,
  destination: AudioNode,
): VoiceHandle {
  const cfg = SYNTH_PARAMS.shellLaunch;
  const dur = cfg.durMs / 1000;

  const out = ctx.createGain();
  out.gain.value = cfg.gain;
  out.connect(destination);

  const whoomp = ctx.createOscillator();
  whoomp.type = 'sine';
  const whoompGain = ctx.createGain();
  whoompGain.gain.value = EPS;
  whoomp.connect(whoompGain);
  whoompGain.connect(out);

  const noise = makeNoise(ctx, dur, 'white');
  const crackFilter = ctx.createBiquadFilter();
  crackFilter.type = 'lowpass';
  crackFilter.frequency.value = cfg.crackCutoffHz;
  const crackGain = ctx.createGain();
  crackGain.gain.value = EPS;
  noise.connect(crackFilter);
  crackFilter.connect(crackGain);
  crackGain.connect(out);

  const handle = { onEnded: undefined } as VoiceHandle;
  const fireEnded = endGuard(handle);

  handle.start = (when = ctx.currentTime) => {
    whoomp.frequency.setValueAtTime(cfg.whoompStartHz, when);
    whoomp.frequency.exponentialRampToValueAtTime(cfg.whoompEndHz, when + dur * 0.8);
    const whoompEnd = percEnvelope(whoompGain.gain, when, 1, 0.006, dur * 0.2, dur * 0.7);
    // The crack rides just after the launch.
    const crackEnd = percEnvelope(crackGain.gain, when + dur * 0.05, 0.6, 0.002, 0, dur * 0.4);
    const end = Math.max(whoompEnd, crackEnd);
    whoomp.start(when);
    safeStop(whoomp, end);
    noise.start(when);
    safeStop(noise, end);
    whoomp.onended = fireEnded;
  };
  handle.stop = (when = ctx.currentTime) => {
    safeStop(whoomp, when);
    safeStop(noise, when);
    fireEnded();
  };
  return handle;
}

// --- 4. Explosions (near / far) --------------------------------------------------------------
// Near: a brown-noise burst + a 40 Hz sine drop + a lowpass that slowly closes, ~1.2 s.
// Far: the same event pre-lowpassed (duller), quieter, longer tail. One builder, two param sets.
function buildExplosion(
  ctx: AudioContext,
  destination: AudioNode,
  variant: 'near' | 'far',
): VoiceHandle {
  const cfg = explosionVariantParams(variant);
  const dur = cfg.durationSec;

  const out = ctx.createGain();
  out.gain.value = EPS;
  out.connect(destination);

  const lowpass = ctx.createBiquadFilter();
  lowpass.type = 'lowpass';
  lowpass.frequency.value = cfg.cutoffStartHz;
  lowpass.connect(out);

  const noise = makeNoise(ctx, dur, 'brown');
  const noiseGain = ctx.createGain();
  noiseGain.gain.value = EPS;
  noise.connect(noiseGain);
  noiseGain.connect(lowpass);

  const drop = ctx.createOscillator();
  drop.type = 'sine';
  const dropGain = ctx.createGain();
  dropGain.gain.value = EPS;
  drop.connect(dropGain);
  dropGain.connect(lowpass);

  const handle = { onEnded: undefined } as VoiceHandle;
  const fireEnded = endGuard(handle);

  handle.start = (when = ctx.currentTime) => {
    out.gain.setValueAtTime(cfg.gain, when);
    // Lowpass slowly closes — bright punch settling into a dark rumble.
    lowpass.frequency.setValueAtTime(cfg.cutoffStartHz, when);
    lowpass.frequency.exponentialRampToValueAtTime(cfg.cutoffEndHz, when + dur);
    // Sine drop to ~40 Hz.
    drop.frequency.setValueAtTime(cfg.dropStartHz, when);
    drop.frequency.exponentialRampToValueAtTime(cfg.dropEndHz, when + dur * 0.5);
    const dropEnd = percEnvelope(dropGain.gain, when, 0.9, 0.006, dur * 0.1, dur * 0.75);
    const noiseEnd = percEnvelope(noiseGain.gain, when, 1, 0.004, dur * 0.05, dur * 0.9);
    const end = Math.max(dropEnd, noiseEnd);
    noise.start(when);
    safeStop(noise, end);
    drop.start(when);
    safeStop(drop, end);
    noise.onended = fireEnded;
  };
  handle.stop = (when = ctx.currentTime) => {
    safeStop(noise, when);
    safeStop(drop, when);
    fireEnded();
  };
  return handle;
}

export function buildExplosionNear(
  ctx: AudioContext,
  destination: AudioNode,
): VoiceHandle {
  return buildExplosion(ctx, destination, 'near');
}

export function buildExplosionFar(
  ctx: AudioContext,
  destination: AudioNode,
): VoiceHandle {
  return buildExplosion(ctx, destination, 'far');
}

// --- 5. Transformer: hum loop / zap / power-down whoomp --------------------------------------
// Hum: a quiet, dark stack of the mains fundamental + harmonics, two slightly-detuned copies
// for a live buzz. A continuous loop (nearest-N culled by the positional system, Task 3).
export function buildTransformerHum(
  ctx: AudioContext,
  destination: AudioNode,
): VoiceHandle {
  const cfg = SYNTH_PARAMS.transformer.hum;

  const out = ctx.createGain();
  out.gain.value = 0;
  out.connect(destination);

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = cfg.cutoffHz;
  filter.connect(out);

  const oscs: OscillatorNode[] = [];
  // Two detuned stacks -> beating buzz.
  for (const detune of [-cfg.detuneHz, cfg.detuneHz]) {
    cfg.harmonics.forEach((mult, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = cfg.fundamentalHz * mult;
      osc.detune.value = detune;
      const g = ctx.createGain();
      g.gain.value = cfg.harmonicGains[i] * 0.5;
      osc.connect(g);
      g.connect(filter);
      oscs.push(osc);
    });
  }

  const handle = { onEnded: undefined } as VoiceHandle;
  const fireEnded = endGuard(handle);

  handle.start = (when = ctx.currentTime) => {
    for (const osc of oscs) osc.start(when);
    out.gain.setValueAtTime(EPS, when);
    out.gain.linearRampToValueAtTime(cfg.gain, when + 0.3);
  };
  handle.stop = (when = ctx.currentTime) => {
    out.gain.cancelScheduledValues(when);
    out.gain.setTargetAtTime(0, when, 0.08);
    const end = when + 0.4;
    oscs.forEach((osc) => safeStop(osc, end));
    if (oscs.length > 0) oscs[0].onended = fireEnded;
    else fireEnded();
  };
  return handle;
}

// Zap: bandpassed white-noise crackle — a burst of short spikes over ~0.4 s.
export function buildTransformerZap(
  ctx: AudioContext,
  destination: AudioNode,
): VoiceHandle {
  const cfg = SYNTH_PARAMS.transformer.zap;
  const dur = cfg.durationSec;

  const out = ctx.createGain();
  out.gain.value = cfg.gain;
  out.connect(destination);

  const band = ctx.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.value = cfg.bandHz;
  band.Q.value = cfg.bandQ;
  band.connect(out);

  const noise = makeNoise(ctx, dur, 'white');
  const crackleGain = ctx.createGain();
  crackleGain.gain.value = EPS;
  noise.connect(band);
  band.connect(crackleGain);
  crackleGain.connect(out);

  const handle = { onEnded: undefined } as VoiceHandle;
  const fireEnded = endGuard(handle);

  handle.start = (when = ctx.currentTime) => {
    // Deterministic-ish crackle: evenly-ish spaced spikes with decaying peaks.
    crackleGain.gain.cancelScheduledValues(when);
    crackleGain.gain.setValueAtTime(EPS, when);
    const rng = mulberry32(0x2c ^ Math.floor(when * 1000));
    for (let i = 0; i < cfg.crackleCount; i++) {
      const t = when + (i / cfg.crackleCount) * dur + rng() * 0.01;
      const peak = 0.4 + rng() * 0.6;
      crackleGain.gain.setValueAtTime(EPS, t);
      crackleGain.gain.exponentialRampToValueAtTime(peak, t + 0.004);
      crackleGain.gain.exponentialRampToValueAtTime(EPS, t + 0.03);
    }
    crackleGain.gain.setValueAtTime(0, when + dur);
    noise.start(when);
    safeStop(noise, when + dur);
    noise.onended = fireEnded;
  };
  handle.stop = (when = ctx.currentTime) => {
    safeStop(noise, when);
    fireEnded();
  };
  return handle;
}

// Power-down whoomp: a pitch-diving sine + a noise wash, ~0.8 s (a district going dark).
export function buildPowerDownWhoomp(
  ctx: AudioContext,
  destination: AudioNode,
): VoiceHandle {
  const cfg = SYNTH_PARAMS.transformer.whoomp;
  const dur = cfg.durationSec;

  const out = ctx.createGain();
  out.gain.value = cfg.gain;
  out.connect(destination);

  const dive = ctx.createOscillator();
  dive.type = 'sine';
  const diveGain = ctx.createGain();
  diveGain.gain.value = EPS;
  dive.connect(diveGain);
  diveGain.connect(out);

  const noise = makeNoise(ctx, dur, 'brown');
  const washFilter = ctx.createBiquadFilter();
  washFilter.type = 'lowpass';
  washFilter.frequency.value = cfg.washCutoffHz;
  const washGain = ctx.createGain();
  washGain.gain.value = EPS;
  noise.connect(washFilter);
  washFilter.connect(washGain);
  washGain.connect(out);

  const handle = { onEnded: undefined } as VoiceHandle;
  const fireEnded = endGuard(handle);

  handle.start = (when = ctx.currentTime) => {
    dive.frequency.setValueAtTime(cfg.diveStartHz, when);
    dive.frequency.exponentialRampToValueAtTime(cfg.diveEndHz, when + dur * 0.85);
    const diveEnd = percEnvelope(diveGain.gain, when, 0.9, 0.02, dur * 0.15, dur * 0.7);
    const washEnd = percEnvelope(washGain.gain, when, 0.5, 0.02, 0, dur * 0.85);
    const end = Math.max(diveEnd, washEnd);
    dive.start(when);
    safeStop(dive, end);
    noise.start(when);
    safeStop(noise, end);
    dive.onended = fireEnded;
  };
  handle.stop = (when = ctx.currentTime) => {
    safeStop(dive, when);
    safeStop(noise, when);
    fireEnded();
  };
  return handle;
}

// --- 6. Ambience beds ------------------------------------------------------------------------
// City evening: a very quiet filtered brown-noise wash + occasional distant-horn blips on
// randomized gaps. Continuous loop; horn blips are self-scheduled via a recursive timer that
// stop() clears (no orphaned timer, mirroring sirens' setInterval-with-teardown pattern).
export function buildAmbienceCity(
  ctx: AudioContext,
  destination: AudioNode,
  params?: SoundParams,
): VoiceHandle {
  const cfg = SYNTH_PARAMS.ambience.city;

  const out = ctx.createGain();
  out.gain.value = 0;
  out.connect(destination);

  const bedFilter = ctx.createBiquadFilter();
  bedFilter.type = 'lowpass';
  bedFilter.frequency.value = cfg.bedCutoffHz;
  bedFilter.connect(out);
  const bed = makeNoise(ctx, 2, 'brown', true);
  const bedGain = ctx.createGain();
  bedGain.gain.value = cfg.bedGain;
  bed.connect(bedFilter);
  bedFilter.connect(bedGain);
  bedGain.connect(out);

  const handle = { onEnded: undefined } as VoiceHandle;
  const fireEnded = endGuard(handle);
  const rng = mulberry32((params?.seed ?? 1) >>> 0);
  let hornTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const scheduleHorn = (): void => {
    if (stopped) return;
    const gapMs = lerp(cfg.hornMinGapSec, cfg.hornMaxGapSec, rng()) * 1000;
    hornTimer = setTimeout(() => {
      if (stopped) return;
      const now = ctx.currentTime;
      const horn = ctx.createOscillator();
      horn.type = 'sawtooth';
      horn.frequency.value = cfg.hornHz * (0.9 + rng() * 0.2);
      const hg = ctx.createGain();
      hg.gain.value = EPS;
      const hf = ctx.createBiquadFilter();
      hf.type = 'lowpass';
      hf.frequency.value = 900;
      horn.connect(hf);
      hf.connect(hg);
      hg.connect(out);
      const end = percEnvelope(hg.gain, now, cfg.hornGain, 0.05, cfg.hornDurSec * 0.4, cfg.hornDurSec * 0.6);
      horn.start(now);
      safeStop(horn, end + 0.02);
      scheduleHorn();
    }, gapMs);
  };

  handle.start = (when = ctx.currentTime) => {
    bed.start(when);
    out.gain.setValueAtTime(EPS, when);
    out.gain.linearRampToValueAtTime(1, when + 0.8);
    scheduleHorn();
  };
  handle.stop = (when = ctx.currentTime) => {
    stopped = true;
    if (hornTimer !== null) clearTimeout(hornTimer);
    hornTimer = null;
    out.gain.cancelScheduledValues(when);
    out.gain.setTargetAtTime(0, when, 0.2);
    const end = when + 1.0;
    safeStop(bed, end);
    bed.onended = fireEnded;
  };
  return handle;
}

// Crickets (DARK CITY): pulsed 4–5 kHz sine chirp trains with randomized gaps. Same recursive-
// timer + cleanup discipline as the city bed.
export function buildAmbienceCrickets(
  ctx: AudioContext,
  destination: AudioNode,
  params?: SoundParams,
): VoiceHandle {
  const cfg = SYNTH_PARAMS.ambience.crickets;

  const out = ctx.createGain();
  out.gain.value = 0;
  out.connect(destination);

  const handle = { onEnded: undefined } as VoiceHandle;
  const fireEnded = endGuard(handle);
  const schedule = cricketChirpSchedule(params?.seed ?? 7, 4096);
  let idx = 0;
  let chirpTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const emitChirp = (): void => {
    const now = ctx.currentTime;
    // One chirp = a short pulse train of the sine.
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = cfg.chirpHz;
    const g = ctx.createGain();
    g.gain.value = EPS;
    osc.connect(g);
    g.connect(out);
    g.gain.cancelScheduledValues(now);
    g.gain.setValueAtTime(EPS, now);
    let t = now;
    for (let i = 0; i < cfg.pulsesPerChirp; i++) {
      g.gain.setValueAtTime(EPS, t);
      g.gain.linearRampToValueAtTime(cfg.gain, t + cfg.pulseDurSec * 0.3);
      g.gain.exponentialRampToValueAtTime(EPS, t + cfg.pulseDurSec);
      t += cfg.pulseDurSec + cfg.pulseGapSec;
    }
    g.gain.setValueAtTime(0, t);
    osc.start(now);
    safeStop(osc, t + 0.02);
  };

  const scheduleNext = (): void => {
    if (stopped) return;
    const gap = schedule[idx % schedule.length].gapSec;
    idx += 1;
    chirpTimer = setTimeout(() => {
      if (stopped) return;
      emitChirp();
      scheduleNext();
    }, gap * 1000);
  };

  handle.start = (when = ctx.currentTime) => {
    out.gain.setValueAtTime(EPS, when);
    out.gain.linearRampToValueAtTime(1, when + 0.5);
    scheduleNext();
  };
  handle.stop = (when = ctx.currentTime) => {
    stopped = true;
    if (chirpTimer !== null) clearTimeout(chirpTimer);
    chirpTimer = null;
    out.gain.cancelScheduledValues(when);
    out.gain.setTargetAtTime(0, when, 0.15);
    // No continuous source to stop; release after the fade.
    setTimeout(fireEnded, 400);
  };
  return handle;
}

// --- 7. Stingers, WRECKED, BUSTED, UI tick ---------------------------------------------------
// Play a motif of detuned-saw stabs through a lowpass — the shared voice for tier stingers,
// WRECKED and BUSTED. Each note is two detuned saws (brassy) with a percussive envelope.
function playMotif(
  ctx: AudioContext,
  destination: AudioNode,
  motif: Motif,
  cutoffHz: number,
): VoiceHandle {
  const out = ctx.createGain();
  out.gain.value = motif.gain;
  out.connect(destination);

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = cutoffHz;
  filter.connect(out);

  const oscs: OscillatorNode[] = [];
  const handle = { onEnded: undefined } as VoiceHandle;
  const fireEnded = endGuard(handle);

  handle.start = (when = ctx.currentTime) => {
    let lastEnd = when;
    for (const note of motif.notes) {
      const at = when + note.atSec;
      const g = ctx.createGain();
      g.gain.value = EPS;
      g.connect(filter);
      const end = percEnvelope(g.gain, at, 0.9, 0.008, note.durSec * 0.3, note.durSec * 0.7);
      lastEnd = Math.max(lastEnd, end);
      for (const detune of [-6, 6]) {
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = note.freqHz;
        osc.detune.value = detune;
        osc.connect(g);
        osc.start(at);
        safeStop(osc, end + 0.02);
        oscs.push(osc);
      }
    }
    if (oscs.length > 0) oscs[oscs.length - 1].onended = fireEnded;
    else fireEnded();
  };
  handle.stop = (when = ctx.currentTime) => {
    oscs.forEach((osc) => safeStop(osc, when));
    fireEnded();
  };
  return handle;
}

export function buildStinger(
  ctx: AudioContext,
  destination: AudioNode,
  params?: SoundParams,
): VoiceHandle {
  return playMotif(ctx, destination, stingerMotif(params?.tier ?? 1), SYNTH_PARAMS.stinger.cutoffHz);
}

// WRECKED: the descending motif + a filtered brown-noise crunch underneath.
export function buildStingerWrecked(
  ctx: AudioContext,
  destination: AudioNode,
): VoiceHandle {
  const cfg = SYNTH_PARAMS.wrecked;
  const motif = wreckedMotif();
  const motifVoice = playMotif(ctx, destination, motif, cfg.crunchCutoffHz);

  // Crunch layer.
  const dur = 0.35;
  const crunchOut = ctx.createGain();
  crunchOut.gain.value = cfg.crunchGain;
  crunchOut.connect(destination);
  const crunchFilter = ctx.createBiquadFilter();
  crunchFilter.type = 'lowpass';
  crunchFilter.frequency.value = cfg.crunchCutoffHz;
  crunchFilter.connect(crunchOut);
  const noise = makeNoise(ctx, dur, 'brown');
  const noiseGain = ctx.createGain();
  noiseGain.gain.value = EPS;
  noise.connect(crunchFilter);
  crunchFilter.connect(noiseGain);
  noiseGain.connect(crunchOut);

  const handle = { onEnded: undefined } as VoiceHandle;
  const fireEnded = endGuard(handle);
  // The motif voice's end is the definitive one; let it drive onEnded.
  motifVoice.onEnded = fireEnded;

  handle.start = (when = ctx.currentTime) => {
    motifVoice.start(when);
    const end = percEnvelope(noiseGain.gain, when, 0.9, 0.004, dur * 0.1, dur * 0.85);
    noise.start(when);
    safeStop(noise, end);
  };
  handle.stop = (when = ctx.currentTime) => {
    motifVoice.stop(when);
    safeStop(noise, when);
  };
  return handle;
}

export function buildStingerBusted(
  ctx: AudioContext,
  destination: AudioNode,
): VoiceHandle {
  return playMotif(ctx, destination, bustedMotif(), SYNTH_PARAMS.busted.cutoffHz);
}

// UI tick: a very short triangle blip.
export function buildUiTick(
  ctx: AudioContext,
  destination: AudioNode,
  params?: SoundParams,
): VoiceHandle {
  const cfg = SYNTH_PARAMS.ui;
  const dur = cfg.durMs / 1000;
  const level = cfg.gain * clamp01(params?.gain ?? 1);

  const out = ctx.createGain();
  out.gain.value = EPS;
  out.connect(destination);
  const osc = ctx.createOscillator();
  osc.type = 'triangle';
  osc.frequency.value = cfg.freqHz;
  osc.connect(out);

  const handle = { onEnded: undefined } as VoiceHandle;
  const fireEnded = endGuard(handle);

  handle.start = (when = ctx.currentTime) => {
    const end = percEnvelope(out.gain, when, level, 0.001, 0, dur);
    osc.start(when);
    safeStop(osc, end);
    osc.onended = fireEnded;
  };
  handle.stop = (when = ctx.currentTime) => {
    safeStop(osc, when);
    fireEnded();
  };
  return handle;
}

// --- 12. Squeak (Phase 19 Task 2: raccoon hit) -----------------------------------------------
// A quick upward-sweeping triangle blip — a tiny "eek!" for a knocked raccoon prop, mapped
// from audio/eventMap.ts's propDestroyed archetype filter (NOT a new gameplay event).
export function buildSqueak(ctx: AudioContext, destination: AudioNode): VoiceHandle {
  const cfg = SYNTH_PARAMS.squeak;
  const dur = cfg.durMs / 1000;

  const out = ctx.createGain();
  out.gain.value = EPS;
  out.connect(destination);

  const osc = ctx.createOscillator();
  osc.type = 'triangle';
  osc.connect(out);

  const handle = { onEnded: undefined } as VoiceHandle;
  const fireEnded = endGuard(handle);

  handle.start = (when = ctx.currentTime) => {
    osc.frequency.setValueAtTime(cfg.startHz, when);
    osc.frequency.exponentialRampToValueAtTime(cfg.endHz, when + dur * 0.7);
    const end = percEnvelope(out.gain, when, cfg.gain, 0.006, 0, dur * 0.8);
    osc.start(when);
    safeStop(osc, end);
    osc.onended = fireEnded;
  };
  handle.stop = (when = ctx.currentTime) => {
    safeStop(osc, when);
    fireEnded();
  };
  return handle;
}

// ============================================================================================
// Registration — the manager seam.
// ============================================================================================

/** name -> builder, under the stable registration names. The manager (Task 1) either reads
 *  this directly or, more simply, calls `registerAllSounds(registerSound)`. */
export const SOUND_BUILDERS: Record<SoundName, SoundBuilder> = {
  engine: buildEngine,
  impact: buildImpact,
  gunshot: buildGunshot,
  shellLaunch: buildShellLaunch,
  explosionNear: buildExplosionNear,
  explosionFar: buildExplosionFar,
  transformerHum: buildTransformerHum,
  transformerZap: buildTransformerZap,
  powerDownWhoomp: buildPowerDownWhoomp,
  ambienceCity: buildAmbienceCity,
  ambienceCrickets: buildAmbienceCrickets,
  stingerTier1: (ctx, dest, params) => buildStinger(ctx, dest, { ...params, tier: 1 }),
  stingerTier2: (ctx, dest, params) => buildStinger(ctx, dest, { ...params, tier: 2 }),
  stingerTier3: (ctx, dest, params) => buildStinger(ctx, dest, { ...params, tier: 3 }),
  stingerTier4: (ctx, dest, params) => buildStinger(ctx, dest, { ...params, tier: 4 }),
  stingerTier5: (ctx, dest, params) => buildStinger(ctx, dest, { ...params, tier: 5 }),
  stingerWrecked: buildStingerWrecked,
  stingerBusted: buildStingerBusted,
  uiTick: buildUiTick,
  squeak: buildSqueak,
};

/** Every stable registration name, in registration order. */
export const SOUND_NAMES = Object.keys(SOUND_BUILDERS) as SoundName[];

/** Register the whole synth library through the manager's `registerSound` seam in one call.
 *  This is the intended integration point for audio/manager.ts (Task 1) / eventMap (Task 4). */
export function registerAllSounds(register: RegisterSound): void {
  for (const name of SOUND_NAMES) register(name, SOUND_BUILDERS[name]);
}
