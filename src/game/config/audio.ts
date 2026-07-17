// Siren synth tunables (Phase 9 Task 4; audio/sirens.ts). WebAudio-SYNTHESIZED — no audio
// assets exist in this repo (Kenney/CC0 audio packs are firewalled the same as every other
// network fetch in this sandbox) — so every number below feeds an oscillator/GainNode
// directly rather than picking a sample. Live-tunable via the auto-built leva "Config"
// folder (core/devPanel.tsx's buildConfigSchema), same as every other block in game/config/.
export const SIRENS = {
  /** Up to this many simultaneous voices, bound to the N nearest 'pursuing' units. */
  maxVoices: 3,
  /** Nearest-pursuer re-evaluation rate (Hz) — a cheap distance sort, not a physics-rate op. */
  evalHz: 2,
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
  /** Per-voice gain ceiling before distance falloff and master mute/pause/not-PLAYING gating. */
  voiceGain: 0.35,
} as const;
