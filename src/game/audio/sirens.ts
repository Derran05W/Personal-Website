// Police siren audio (Phase 9 Task 4; TDD note: WebAudio-SYNTHESIZED — no siren audio
// assets exist in this repo, and CC0 audio packs are network-firewalled the same as
// everything else in this sandbox, so this whole module is built from oscillators, not a
// sample). Bound to the up-to-`SIRENS.maxVoices` NEAREST 'pursuing' units (ai/pursuitTypes
// .ts's `unitsRef` seam) relative to the player, re-evaluated at `SIRENS.evalHz` — not
// every physics step; this is a cheap distance sort, not a hot-path system.
//
// --- synth design -----------------------------------------------------------------------
// Per voice: ONE audible sawtooth oscillator ("carrier", classic siren timbre) whose pitch
// is swept by a SECOND, inaudible sine oscillator ("LFO") connected through a GainNode that
// scales the LFO's ±1 output into ±SIRENS.sweepDepthHz — the standard WebAudio
// frequency-modulation idiom (lfo -> lfoDepthGain -> carrier.frequency; an AudioParam sums
// an incoming a-rate signal on top of its own base value, so the carrier's
// `.frequency.value` stays exactly SIRENS.sweepCenterHz and the LFO alone does the
// sweeping). The carrier then feeds its own per-voice GainNode (distance-falloff volume,
// always RAMPED — never stepped, so binding a voice to a different unit, or gaining/losing
// a pursuer, never pops) into a shared masterGain (mute / pause / GAMEOVER / not-yet-PLAYING
// gate) into destination.
//
// --- lifecycle -----------------------------------------------------------------------------
// The AudioContext is created LAZILY, the first time `machine` becomes 'PLAYING' — never at
// module load / game boot — because unprompted AudioContext creation is silently suspended
// by autoplay policies outside a user-gesture call stack. The GARAGE screen's "Ready to
// drive" click (GarageOverlay.tsx) IS the transition to PLAYING
// (`getGameState().transition('PLAYING')` runs synchronously inside that onClick), so the
// store subscription below that triggers `ensureSirenGraph()` still executes within the
// original click's call stack — no async boundary in between — satisfying every major
// browser's autoplay-gesture requirement.
//
// --- Phase 15 Task 1 migration ------------------------------------------------------------
// This module no longer owns the AudioContext itself — it was the first (and, until Phase
// 15, only) WebAudio system in the game, so it originally created/closed its own context.
// audio/manager.ts now owns ONE shared context + a master/{sfx,engine,ambient} bus graph for
// every system; sirens migrated onto it with minimal edit: `unlockAudioContext()` replaces
// the old private `ensureContext()`, this module's own per-voice sum node (`sirenMasterGain`,
// renamed from `masterGain` to avoid confusion with the manager's master bus) now connects
// into the shared `sfx` bus instead of `ctx.destination` directly, and its OWN gain gating
// (`resolveMasterGainTarget` — mute / PLAYING-only) is kept exactly as-is: it's now
// deliberately redundant with the manager's sfx-bus gating (both zero in the same states),
// which is harmless belt-and-suspenders, not a bug. Crucially, `disposeSirenGraph` (sirens'
// OWN node teardown) must NEVER close the shared context directly — other systems (engine
// loop, ambient bed, future positional systems) may still be using it after sirens unmounts.
// `initSirens()` DOES also mount `initAudioManager()` (see that function's doc comment for
// why) and its returned teardown DOES close the shared context — that's the manager's own
// owner-level close, delegated to by whichever system holds the game's whole lifetime.
//
// --- verification note ----------------------------------------------------------------------
// jsdom (this repo's unit-test DOM) does not implement the Web Audio API at all, so the
// impure oscillator/AudioContext plumbing below is NOT exercised by sirens.test.ts —
// instead every piece of actual DECISION logic (distance falloff, nearest-N selection,
// mute/pause/not-PLAYING gain gating) is factored into the plain, dependency-free functions
// below and fully unit-tested there. Real audio output can only be confirmed by a human
// with speakers/headphones in a live browser session — an accepted verification slippage
// per the phase plan ("If Web Audio in this headless container can't be validated by
// script, verify structurally ... acceptable slippage").
// --- Phase 15 Task 3 upgrade (per-kind character + stereo pan) ----------------------------
// The single global wail became PER-UNIT-KIND: each voice reads SIREN_KINDS[kind] (config/
// audio.ts) and re-points its carrier/LFO on a kind change — police wail, SWAT growl, armored
// slight-detune, gunTruck/tank two-tone klaxon — and gained a StereoPannerNode driven by the
// pursuer's bearing (audio/positional.ts's shared spatialParams). Still <=3 voices on the
// nearest pursuers, still ramped (pop-free), still routed through the sfx bus.
import { SIRENS, SIREN_KINDS, type SirenVoiceCharacter } from '../config/audio';
import { getGameState, useGameStore } from '../state/store';
import type { GameState } from '../state/machine';
import { unitsRef, type UnitKind } from '../ai/pursuitTypes';
import { playerVehicle } from '../vehicles/playerRef';
import { distanceGain, spatialParams } from './positional';
import {
  getAudioContext,
  getAudioContextState,
  getBusNode,
  initAudioManager,
  unlockAudioContext,
} from './manager';

// --- pure core (fully unit-tested, no browser APIs) -----------------------------------------

export interface PursuerPosition {
  readonly id: number;
  readonly x: number;
  readonly z: number;
  /** Unit kind — selects the siren character (SIREN_KINDS). Optional so the pure nearest-N
   * tests can pass plain {id,x,z} positions; readPursuerPositions always supplies it. */
  readonly kind?: UnitKind;
}

export interface NearestPursuer {
  readonly id: number;
  readonly dist: number;
}

/** Nearest `maxCount` candidates to (playerX, playerZ), ascending by distance. Pure — takes
 * plain position data rather than reading `unitsRef` itself, so it's testable without any
 * AI/physics module involved. */
export function nearestPursuers(
  playerX: number,
  playerZ: number,
  candidates: readonly PursuerPosition[],
  maxCount: number = SIRENS.maxVoices,
): NearestPursuer[] {
  return candidates
    .map((c) => ({ id: c.id, dist: Math.hypot(c.x - playerX, c.z - playerZ) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, Math.max(0, maxCount));
}

/** Linear distance falloff, clamped to [0, 1]: 1 at dist=0, 0 at dist>=radiusM. Defensive
 * against a non-finite/negative `dist` (should never happen — Math.hypot is always >= 0 —
 * but a siren voice popping to a nonsensical gain off a stray bad read is worse than a
 * clamp). */
export function distanceFalloff(dist: number, radiusM: number = SIRENS.falloffRadiusM): number {
  // Thin alias over audio/positional.ts's shared distance-gain helper (same math) — kept as a
  // named export because sirens.test.ts asserts it directly, and the SIRENS.falloffRadiusM
  // default belongs to sirens rather than the generic helper.
  return distanceGain(dist, radiusM);
}

/** The master gain target: 0 whenever muted OR the machine isn't actively 'PLAYING' (covers
 * PAUSED and GAMEOVER per this task's brief, plus GARAGE/BOOT/LOADING — pursuit sirens have
 * no business playing before a run has started either), else `cfg.voiceGain`. */
export function resolveMasterGainTarget(
  muted: boolean,
  machine: GameState,
  cfg: { readonly voiceGain: number } = SIRENS,
): number {
  if (muted) return 0;
  return machine === 'PLAYING' ? cfg.voiceGain : 0;
}

// --- impure: WebAudio graph -------------------------------------------------------------------

interface Voice {
  readonly carrier: OscillatorNode;
  readonly lfo: OscillatorNode;
  readonly lfoDepth: GainNode;
  readonly gain: GainNode;
  readonly panner: StereoPannerNode;
  boundUnitId: number | null;
  boundKind: UnitKind | null;
}

function rampAudioParam(param: AudioParam, target: number, now: number, seconds: number): void {
  param.cancelScheduledValues(now);
  param.linearRampToValueAtTime(target, now + seconds);
}

/** Point a voice's carrier/LFO at a kind's character. `rampSec <= 0` sets values instantly
 * (initial pre-start config); a positive ramp glides the timbre on a live kind swap. Carrier
 * and LFO WAVEFORMS switch instantly (a wavetable swap is click-free); only the frequencies and
 * depth ramp. The LFO->carrier.frequency a-rate connection is untouched by the base-frequency
 * ramp (an AudioParam sums its scheduled value with the incoming a-rate signal). */
function applyVoiceCharacter(voice: Voice, character: SirenVoiceCharacter, now: number, rampSec: number): void {
  voice.carrier.type = character.wave;
  voice.lfo.type = character.lfoType;
  if (rampSec <= 0) {
    voice.carrier.frequency.value = character.baseHz;
    voice.lfo.frequency.value = character.lfoRateHz;
    voice.lfoDepth.gain.value = character.lfoDepthHz;
    return;
  }
  rampAudioParam(voice.carrier.frequency, character.baseHz, now, rampSec);
  rampAudioParam(voice.lfo.frequency, character.lfoRateHz, now, rampSec);
  rampAudioParam(voice.lfoDepth.gain, character.lfoDepthHz, now, rampSec);
}

let sirenMasterGain: GainNode | null = null;
let voices: Voice[] = [];
let graphInitialized = false;

function createVoice(context: AudioContext, destination: AudioNode): Voice {
  const carrier = context.createOscillator();
  const lfo = context.createOscillator();
  const lfoDepth = context.createGain();
  lfo.connect(lfoDepth);
  lfoDepth.connect(carrier.frequency);

  const gain = context.createGain();
  gain.gain.value = 0;
  const panner = context.createStereoPanner();
  panner.pan.value = 0;
  carrier.connect(gain);
  gain.connect(panner);
  panner.connect(destination);

  const voice: Voice = { carrier, lfo, lfoDepth, gain, panner, boundUnitId: null, boundKind: null };
  // Initial timbre: police character, set instantly (the voice is silent until first bound).
  applyVoiceCharacter(voice, SIREN_KINDS.police, 0, 0);

  carrier.start();
  lfo.start();
  return voice;
}

function ensureSirenGraph(): void {
  if (graphInitialized) return;
  const context = unlockAudioContext(); // shared context — idempotent, see manager.ts.
  if (!context) return; // Web Audio unsupported — sirens silently no-op, never a crash.
  const sfxBus = getBusNode('sfx');
  if (!sfxBus) return; // defensive: unlockAudioContext succeeding always creates the buses too.

  sirenMasterGain = context.createGain();
  sirenMasterGain.gain.value = 0; // ramped up by applyMasterGain() below — never a hard pop-in.
  sirenMasterGain.connect(sfxBus);
  graphInitialized = true;
}

function applyMasterGain(): void {
  const context = getAudioContext();
  if (!context || !sirenMasterGain) return;
  const state = getGameState();
  const target = resolveMasterGainTarget(state.settings.muted, state.machine);
  const now = context.currentTime;
  sirenMasterGain.gain.cancelScheduledValues(now);
  sirenMasterGain.gain.linearRampToValueAtTime(target, now + SIRENS.gainRampSec);
}

function readPursuerPositions(): PursuerPosition[] {
  const api = unitsRef.current;
  if (!api) return []; // spawn director not mounted (e.g. Task 1/2 not landed, or pre-PLAYING).
  const out: PursuerPosition[] = [];
  for (const slot of api.slots) {
    if (slot.kind === null || slot.state !== 'pursuing') continue;
    out.push({ id: slot.id, x: slot.x, z: slot.z, kind: slot.kind });
  }
  return out;
}

function updateVoices(): void {
  const context = getAudioContext();
  if (!context || !sirenMasterGain) return;
  const pose = playerVehicle.current?.readState().pose;
  const pursuers = pose ? readPursuerPositions() : [];
  const nearest = pose ? nearestPursuers(pose.position.x, pose.position.z, pursuers) : [];
  // nearestPursuers returns only {id,dist}; recover each pick's full record (x/z/kind) for the
  // spatial params + timbre by id.
  const byId = new Map<number, PursuerPosition>();
  for (const p of pursuers) byId.set(p.id, p);

  // Voice nodes are lazily grown and never torn down/recreated while the graph is alive —
  // reusing the same oscillators across rebinds is exactly what keeps rebinds pop-free
  // (only gain/pan/timbre ramp; the carrier/LFO just keep running).
  while (voices.length < SIRENS.maxVoices) voices.push(createVoice(context, sirenMasterGain));

  const listener = pose ? { x: pose.position.x, z: pose.position.z } : { x: 0, z: 0 };
  const now = context.currentTime;
  for (let i = 0; i < voices.length; i++) {
    const voice = voices[i];
    const candidate = nearest[i];
    const record = candidate ? byId.get(candidate.id) : undefined;
    const kind: UnitKind = record?.kind ?? 'police';
    const character = SIREN_KINDS[kind];

    let targetGain = 0;
    let pan = voice.panner.pan.value; // hold last pan when unbound (nothing to point at)
    if (candidate && record) {
      const spatial = spatialParams(record.x, record.z, listener, SIRENS.falloffRadiusM);
      targetGain = spatial.gain * character.gain;
      pan = spatial.pan;
    }
    const boundId = candidate?.id ?? null;

    if (import.meta.env.DEV && voice.boundUnitId !== boundId) {
      console.debug(`[sirens] voice ${i} bound -> unit ${String(boundId)} (${candidate ? kind : 'none'})`);
    }

    // Re-point the timbre only on a KIND change (waveform/LFO swap), ramped so a police wail ->
    // tank klaxon glides rather than clicks.
    if (candidate) {
      if (voice.boundKind !== kind) applyVoiceCharacter(voice, character, now, SIRENS.gainRampSec);
      voice.boundKind = kind;
    } else {
      voice.boundKind = null;
    }
    voice.boundUnitId = boundId;

    rampAudioParam(voice.gain.gain, targetGain, now, SIRENS.gainRampSec);
    rampAudioParam(voice.panner.pan, pan, now, SIRENS.gainRampSec);
  }
}

/** Teardown of sirens' OWN graph: stops/disconnects every oscillator and gain node. Safe to
 * call even if a graph was never created. Deliberately does NOT close the shared
 * AudioContext (unlike the pre-migration version of this function) — sirens no longer owns
 * it; audio/manager.ts's `closeAudioContext()` is the only thing allowed to close the shared
 * context, from whatever eventually mounts the manager for the whole game's lifetime. */
function disposeSirenGraph(): void {
  for (const voice of voices) {
    try {
      voice.carrier.stop();
    } catch {
      // stop() throws if called on an already-stopped oscillator — harmless here.
    }
    try {
      voice.lfo.stop();
    } catch {
      // Same as above.
    }
    voice.carrier.disconnect();
    voice.lfo.disconnect();
    voice.lfoDepth.disconnect();
    voice.gain.disconnect();
    voice.panner.disconnect();
  }
  voices = [];
  sirenMasterGain?.disconnect();
  sirenMasterGain = null;
  graphInitialized = false;
}

/**
 * Mounts the siren system: watches the store for the first PLAYING entry (lazy
 * AudioContext creation, see file header), re-evaluates the nearest pursuers at
 * `SIRENS.evalHz`, and reacts immediately to mute/pause/gameover via a store subscription
 * (rather than waiting for the next eval tick). Returns a teardown function that stops the
 * interval, unsubscribes, and fully disposes the WebAudio graph — call on unmount
 * (audio/SirensSystem.tsx).
 *
 * Also mounts `audio/manager.ts`'s `initAudioManager()` — until a dedicated
 * `<AudioManagerSystem/>` lands in the game tree (Phase 15's later integration task),
 * `<SirensSystem/>` is the one component already orchestrator-mounted "for the game's whole
 * lifetime" (see SirensSystem.tsx's file header), the exact lifetime guarantee the shared
 * manager's own mute/machine-state bus reactions need. Composing the two here — rather than
 * leaving the manager's reactivity unmounted until that later task — is what makes mute (`M`)
 * and pause actually silence the shared sfx/engine buses live today, not just in
 * manager.test.ts's mocked-context tests. Both mounts' PLAYING-entry unlock triggers are
 * idempotent against each other (see `unlockAudioContext`'s doc comment), so composing them
 * is safe regardless of which fires first.
 */
export function initSirens(): () => void {
  const teardownManager = initAudioManager();

  const maybeInitGraph = () => {
    if (graphInitialized) return;
    if (getGameState().machine !== 'PLAYING') return;
    ensureSirenGraph();
    applyMasterGain();
  };

  maybeInitGraph(); // covers mounting while already PLAYING (e.g. a hot-reload / retry).

  const unsubscribe = useGameStore.subscribe((state, prev) => {
    if (state.machine !== prev.machine) maybeInitGraph();
    if (state.machine !== prev.machine || state.settings.muted !== prev.settings.muted) {
      applyMasterGain();
    }
  });

  const intervalMs = 1000 / SIRENS.evalHz;
  const intervalId = window.setInterval(updateVoices, intervalMs);
  updateVoices();

  return () => {
    window.clearInterval(intervalId);
    unsubscribe();
    disposeSirenGraph();
    teardownManager(); // the shared context's real owner-level close — see its own doc comment.
  };
}

// --- debug / verification surface -------------------------------------------------------------

export interface SirenDebugVoice {
  readonly boundUnitId: number | null;
  /** Siren character currently voiced (null when the voice is unbound). */
  readonly kind: UnitKind | null;
  readonly gain: number;
  /** Current stereo pan (-1 left .. +1 right). */
  readonly pan: number;
}

/** DEV/scripted-verification snapshot (core/debugBridge.ts): per-voice binding + current
 * gain, and the AudioContext's state (null if one was never created — e.g. no run has
 * reached PLAYING yet this session). */
export function getSirenDebugSnapshot(): {
  readonly contextState: AudioContextState | null;
  readonly voices: readonly SirenDebugVoice[];
} {
  return {
    contextState: getAudioContextState(),
    voices: voices.map((v) => ({
      boundUnitId: v.boundUnitId,
      kind: v.boundKind,
      gain: v.gain.gain.value,
      pan: v.panner.pan.value,
    })),
  };
}
