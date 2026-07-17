// Siren synth tunables (Phase 9 Task 4; audio/sirens.ts). WebAudio-SYNTHESIZED — no audio
// assets exist in this repo (Kenney/CC0 audio packs are firewalled the same as every other
// network fetch in this sandbox) — so every number below feeds an oscillator/GainNode
// directly rather than picking a sample. Live-tunable via the auto-built leva "Config"
// folder (core/devPanel.tsx's buildConfigSchema), same as every other block in game/config/.
// Phase 15 Task 3: the single global wail below became PER-UNIT-KIND character (SIREN_KINDS,
// after this block) — police keeps the original wail, SWAT growls lower/slower, armored is a
// slight detune of police, gun trucks and tanks switch to a two-tone square KLAXON. The shared
// numbers (voice count, cadence, falloff radius, ramp, ceiling) stay on SIRENS; the per-kind
// timbre lives in SIREN_KINDS. Type-only import (erased at compile time — no runtime config→ai
// edge), same discipline config/spawn.ts uses for UnitKind/HeliLivery.
import type { UnitKind } from '../ai/pursuitTypes';

export const SIRENS = {
  /** Up to this many simultaneous voices, bound to the N nearest 'pursuing' units. */
  maxVoices: 3,
  /** Nearest-pursuer re-evaluation rate (Hz) — a cheap distance sort, not a physics-rate op. */
  evalHz: 8,
  /** Distance (m) at which a bound voice's gain falls to 0 (linear falloff to 0 at this radius). */
  falloffRadiusM: 90,
  /** Gain ramp duration (s) applied to every volume change (voice rebind, mute, pause) — long
   * enough to be inaudible as a click/pop, short enough to still feel responsive. */
  gainRampSec: 0.25,
  /** Audible sawtooth carrier's center frequency (Hz); the LFO sweeps ± sweepDepthHz around it. */
  sweepCenterHz: 950,
  /** Sweep half-range (Hz): center ± this spans the ~700–1200 Hz wail band. */
  sweepDepthHz: 250,
  /** LFO sweep rate (Hz) — one full wail cycle roughly every 1.67 s. */
  sweepRateHz: 0.6,
  /** Per-voice gain ceiling before per-kind trim (SIREN_KINDS[kind].gain), distance falloff,
   * and master mute/pause/not-PLAYING gating. */
  voiceGain: 0.35,
} as const;

/**
 * Per-voice siren timbre. Both the smooth WAIL (police/armored/swat) and the two-tone KLAXON
 * (gunTruck/tank) reduce to the SAME frequency-modulation graph: a `wave` carrier whose
 * frequency = `baseHz` + an `lfoType` LFO of rate `lfoRateHz` scaled to +/- `lfoDepthHz`.
 *   - wail   -> sine LFO: the carrier glides continuously baseHz +/- depth (a swept siren).
 *   - klaxon -> square LFO: the carrier hard-alternates between baseHz-depth and baseHz+depth
 *     (a two-tone air-horn); a square `wave` carrier gives it the harsh brass edge.
 * So one reusable voice graph covers every kind — audio/sirens.ts just re-points these six
 * fields when a voice rebinds to a different-kind pursuer (no node rebuild = pop-free).
 */
export interface SirenVoiceCharacter {
  /** Audible carrier waveform. */
  readonly wave: OscillatorType;
  /** Carrier base frequency (Hz): the wail center, or the klaxon's two-tone midpoint. */
  readonly baseHz: number;
  /** Modulator waveform: 'sine' = a smooth wail sweep, 'square' = a two-tone klaxon alternation. */
  readonly lfoType: OscillatorType;
  /** Modulator rate (Hz): wail sweep rate, or klaxon alternation rate. */
  readonly lfoRateHz: number;
  /** +/- frequency-modulation depth (Hz) the LFO applies to the carrier. */
  readonly lfoDepthHz: number;
  /** Per-kind loudness trim (x), on top of SIRENS.voiceGain — square klaxons read louder than a
   * saw wail at equal gain, so they're trimmed down. */
  readonly gain: number;
}

/**
 * Siren character per pursuit-unit kind (phase-15-plan.md Task 3). Type-checked against
 * ai/pursuitTypes.ts's UnitKind union (the seam) so a new unit kind can't ship without a siren
 * voice. `police` reuses the SIRENS.sweep* numbers so the original wail stays the single source
 * of truth (and stays live-tunable through the leva Config folder).
 */
export const SIREN_KINDS = {
  /** The classic wail — the pre-Task-3 single global siren (SIRENS.sweep* = ~700-1200 Hz saw). */
  police: {
    wave: 'sawtooth',
    baseHz: SIRENS.sweepCenterHz,
    lfoType: 'sine',
    lfoRateHz: SIRENS.sweepRateHz,
    lfoDepthHz: SIRENS.sweepDepthHz,
    gain: 1.0,
  },
  /** Shares the police wail, pitched down a touch (a "slight detune") so a mixed police+armored
   * pack doesn't phase into one perfectly-unison tone. */
  armored: { wave: 'sawtooth', baseHz: 900, lfoType: 'sine', lfoRateHz: 0.5, lfoDepthHz: 250, gain: 1.0 },
  /** A lower, slower growl — heavier and more menacing than the police sedan. */
  swat: { wave: 'sawtooth', baseHz: 600, lfoType: 'sine', lfoRateHz: 0.36, lfoDepthHz: 170, gain: 1.05 },
  /** Military klaxon: a harsh two-tone square air-horn alternating ~470<->650 Hz a couple times a second. */
  gunTruck: { wave: 'square', baseHz: 560, lfoType: 'square', lfoRateHz: 2.2, lfoDepthHz: 90, gain: 0.7 },
  /** Deep rumble-klaxon: the gun-truck horn dropped an octave and slowed (~240<->360 Hz) — the
   * tank announces itself from further down. */
  tank: { wave: 'square', baseHz: 300, lfoType: 'square', lfoRateHz: 1.3, lfoDepthHz: 60, gain: 0.8 },
} as const satisfies Record<UnitKind, SirenVoiceCharacter>;

// Phase 15 Task 1: shared WebAudio bus/pool manager (audio/manager.ts). Still fully
// synthesized — no assets, same firewalled-CC0-packs constraint as SIRENS above — this is
// just the generic bus-graph/voice-pool layer every later synth (Task 2), positional system
// (Task 3), and event map (Task 4) plugs into instead of each hand-rolling its own
// AudioContext/GainNode plumbing the way sirens.ts originally did pre-migration.
export const AUDIO_BUSES = {
  /** Baseline master gain (pre-mute). Kept config-driven rather than a hardcoded 0/1
   * literal per project convention, but defaults to exactly 1 so "mute -> master gain 0/1"
   * holds in practice out of the box. */
  masterGain: 1,
  /** One-shot bus (impact/gun/explosion/ui/stinger voices route here by default). */
  sfxGain: 0.9,
  /** Engine loop bus — split out from sfx so pause can zero engine independent of, say, a
   * UI confirmation tick that might still want to play over a paused scene. */
  engineGain: 0.85,
  /** Ambience bed bus (evening bed / crickets / district hums) — the only bus allowed to
   * stay partially audible outside PLAYING (see manager.ts's resolveBusTargets: GARAGE). */
  ambientGain: 0.5,
  /** GARAGE-only ambient attenuation multiplier — manager.ts's documented call ("ambient may
   * continue quietly in GARAGE") for TDD §11's evening-ambience bed to set a mood on the
   * pre-run screen without competing with menu SFX. Applied on TOP of ambientGain. */
  garageAmbientGain: 0.4,
  /** Ramp duration (s) for the master (mute) gain — short enough to read as an instant
   * toggle, long enough to never click/pop. */
  muteRampSec: 0.05,
  /** Ramp duration (s) for per-bus gain transitions driven by machine-state changes
   * (PLAYING/PAUSED/GAMEOVER/GARAGE) — slightly longer than the mute ramp since these can
   * coincide with a pause-menu fade rather than a discrete keypress. */
  busRampSec: 0.15,
} as const;

/**
 * Per-`acquireVoice`-group concurrency caps (manager.ts). `null` = uncapped but still
 * tracked by the pool (liveVoiceCount still counts it) — currently only `loop` (engine +
 * ambient loops are few, long-lived, and each owned by exactly one system; a cap would only
 * ever misbehave for them). `impact`/`gun`/`explosion` values are the exact TDD §11 /
 * phase-15-plan.md numbers. `ui` and `stinger` aren't specified there — Task 1's own
 * documented call: `ui` (heat ticks, confirm blips) gets a generous cap since several can
 * legitimately overlap in a fast heat-gain burst; `stinger` (tier escalation / WRECKED /
 * BUSTED) gets a tight cap since at most one tier stinger plus one end-of-run sting should
 * ever be live together — see manager.ts's VoiceGroup union, derived from this object's keys.
 */
export const VOICE_POOL_CAPS = {
  impact: 6,
  gun: 4,
  explosion: 3,
  loop: null,
  ui: 8,
  stinger: 2,
} as const;

// Phase 15 Task 4: event->sound mixing (audio/eventMap.ts). AUDIO_BUSES (Task 1, above) owns
// bus-level gain and SYNTH_PARAMS (audio/synth.ts, Task 2) owns each sound's own internal
// levels — this block is deliberately the REMAINING layer: the knobs specific to mapping the
// gameEvents catalog onto playEvent calls (duck envelope, distance/rate thresholds for the
// feed-polled sounds, and per-SoundName acquireVoice priority — the "per-family" weighting
// that decides who wins a pool slot when a shared group, e.g. 'impact', is at cap). Registered
// in config/index.ts's CONFIG for the same auto-built leva "Config" folder every other block
// gets (buildConfigSchema, core/devPanel.tsx) — nested objects (duck, priority) become
// collapsed sub-folders there.
export const AUDIO_MIX = {
  /** sfx-bus gain envelope applied whenever a tier stinger fires (TDD §11: "everything ducks
   * under stingers slightly"). `amount` is a multiplier on the bus's currently-resolved target
   * (manager.ts's resolveBusTargets — so ducking still respects pause/mute/GARAGE correctly
   * instead of ramping back to a raw config constant), `rampDownSec` is how fast the dip lands
   * (fast enough to read as "ducking under the sting", slow enough not to click), `sec` is the
   * total dip+recovery envelope length before the bus is back at its normal target. */
  duck: {
    amount: 0.6,
    rampDownSec: 0.08,
    sec: 1.0,
  },
  /** Explosion near/far selection radius (m) — an explosionFeed blast within this distance of
   * the player plays the brighter 'explosionNear' variant; beyond it, the duller
   * 'explosionFar' (audio/synth.ts's SYNTH_PARAMS.explosion already shapes the two timbres —
   * this is only the distance THRESHOLD that picks between them). */
  explosionNearRadiusM: 30,
  /** Gunfire is rate-limited to roughly one audible shot per this many ms even when
   * combat/tracerFeed.ts reports several rounds in the same polled frame (a full-auto burst
   * would otherwise turn into a buzz and/or blow through the 'gun' voice cap instantly). */
  gunshotMinIntervalMs: 80,
  /** Delay (ms) between the transformer 'transformerZap' one-shot and the district
   * 'powerDownWhoomp' that follows it — TDD §11's "transformer hum -> zap -> district
   * power-down whoomp" sequence. */
  transformerWhoompDelayMs: 250,
  /** Per-SoundName `acquireVoice` priority (manager.ts): within a shared VOICE_POOL_CAPS group
   * at cap, a strictly-higher number here wins the slot and evicts the group's current
   * lowest/oldest voice; equal priority is refused, not evicted (manager.ts's own rule) — so
   * a burst of same-tier sounds gracefully drops the newest rather than fighting each other.
   * Loop sounds (engine/ambience) are in the uncapped 'loop' group, so their number here is
   * inert busywork-avoidance (still required — every SoundName needs an entry) rather than a
   * real eviction lever. */
  priority: {
    engine: 1,
    impact: 1,
    gunshot: 1,
    shellLaunch: 2,
    explosionNear: 2,
    explosionFar: 1,
    transformerHum: 1,
    transformerZap: 3,
    powerDownWhoomp: 3,
    ambienceCity: 1,
    ambienceCrickets: 1,
    stingerTier1: 1,
    stingerTier2: 2,
    stingerTier3: 3,
    stingerTier4: 4,
    stingerTier5: 5,
    stingerWrecked: 10,
    stingerBusted: 10,
    uiTick: 1,
  },
} as const;

// Phase 15 Task 3: positional (spatialized) audio — the shared distance-gain + stereo-pan
// model, plus the tunables for the two LOOPING positional systems built on it (transformer
// district hums + helicopter rotor). Sirens are positional too but keep their own SIRENS block
// above (they predate this pass). Panning is a cheap StereoPanner by bearing relative to the
// game's FIXED camera azimuth (CAMERA.yawDeg) — no HRTF (locked plan decision). Radii/gains
// live here so the whole spatial mix is leva-tunable like every other config block.
export const AUDIO_POSITIONAL = {
  /** Selection + ramp cadence (Hz) for hum/rotor positional voices: which source owns a voice
   * is re-evaluated at this rate (cheap distance sorts, NOT per-frame); gains/pans are ramped
   * between updates so motion (a departing heli, a district blacking out) stays smooth. */
  updateHz: 8,
  /** Ramp (s) for a voice's continuous gain/pan tracking between updates — click-free, still
   * responsive. (Cull-boundary acquire/release fades use the per-system fadeSec below instead.) */
  rampSec: 0.12,

  /** District transformer mains-hums (audio/positional.ts). LIT districts only — a destroyed
   * transformer blacks out its district (powergrid/grid.ts) and its hum goes silent with it —
   * and only the nearest few to the player are ever voiced. */
  hum: {
    /** Max simultaneous live hum voices (nearest-N cull). */
    maxVoices: 3,
    /** Distance (m) at which a hum's gain reaches 0 (linear falloff). Small — a transformer is
     * only heard from close up, so the nearest-N set turns over as you drive. */
    audibleRadiusM: 26,
    /** Extra radius (m) a currently-voiced transformer keeps before it's culled — hysteresis so
     * one hovering at the boundary doesn't chatter in and out of the voice set. */
    hysteresisM: 5,
    /** Fade in/out (s) when a hum voice is (de)assigned on the cull boundary. */
    fadeSec: 0.3,
    /** Per-voice gain ceiling before distance falloff + master gate. */
    gain: 0.18,
    /** A mains fundamental + its octave through a lowpass = a dull electrical hum. */
    fundHz: 60,
    octaveHz: 120,
    /** Octave partial mix (relative to the fundamental). */
    octaveMix: 0.4,
    /** Lowpass cutoff (Hz) — keeps it a dull hum, not a buzz. */
    lowpassHz: 300,
  },

  /** Helicopter rotor chop (audio/positional.ts): one voice per LIVE heliRef slot (<=2). Each
   * voice is a blade-rate-gated noise wash + a low thump, distance-attenuated by 3-D range
   * (altitude included) and scaled by the slot's fly-in/out `presence`. */
  rotor: {
    /** Max simultaneous rotor voices — one per heli slot (heliRef has 2; only ★5 fields both). */
    maxVoices: 2,
    /** Distance (m, 3-D incl. altitude) at which the rotor falls to 0. Large — a heli carries far. */
    audibleRadiusM: 150,
    /** Fade (s) applied when a rotor voice goes (in)active — belt-and-suspenders on top of the
     * continuous presence scaling, for the appear/disappear edge. */
    fadeSec: 0.25,
    /** Per-voice gain ceiling before distance falloff, presence scaling, + master gate. */
    gain: 0.22,
    /** Blade-pass "chop" rate (Hz): the amplitude gate on the rotor-wash noise, and the low
     * thump tone's octave base. ~13 Hz reads as a helicopter main rotor. */
    bladeRateHz: 13,
    /** Depth (0..1) of the blade-rate amplitude gate on the noise wash. */
    chopDepth: 0.85,
    /** Low square "thwop" tone (Hz) under the wash — an octave of the blade rate. */
    thumpHz: 26,
    /** Thump mix relative to the noise wash. */
    thumpMix: 0.5,
    /** Bandpass center (Hz) + Q shaping the rotor-wash noise. */
    noiseBandHz: 500,
    noiseQ: 0.7,
  },
} as const;
