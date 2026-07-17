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
// store subscription below that triggers `ensureContext()` still executes within the
// original click's call stack — no async boundary in between — satisfying every major
// browser's autoplay-gesture requirement.
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
import { SIRENS } from '../config/audio';
import { getGameState, useGameStore } from '../state/store';
import type { GameState } from '../state/machine';
import { unitsRef } from '../ai/pursuitTypes';
import { playerVehicle } from '../vehicles/playerRef';

// --- pure core (fully unit-tested, no browser APIs) -----------------------------------------

export interface PursuerPosition {
  readonly id: number;
  readonly x: number;
  readonly z: number;
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
  if (!Number.isFinite(dist) || radiusM <= 0) return 0;
  return Math.min(1, Math.max(0, 1 - dist / radiusM));
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
  boundUnitId: number | null;
}

let ctx: AudioContext | null = null;
let masterGain: GainNode | null = null;
let voices: Voice[] = [];
let contextRequested = false;

function createVoice(context: AudioContext, destination: AudioNode): Voice {
  const carrier = context.createOscillator();
  carrier.type = 'sawtooth';
  carrier.frequency.value = SIRENS.sweepCenterHz;

  const lfo = context.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = SIRENS.sweepRateHz;

  const lfoDepth = context.createGain();
  lfoDepth.gain.value = SIRENS.sweepDepthHz;
  lfo.connect(lfoDepth);
  lfoDepth.connect(carrier.frequency);

  const gain = context.createGain();
  gain.gain.value = 0;
  carrier.connect(gain);
  gain.connect(destination);

  carrier.start();
  lfo.start();

  return { carrier, lfo, lfoDepth, gain, boundUnitId: null };
}

function ensureContext(): void {
  if (ctx) return;
  const AudioCtxCtor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtxCtor) return; // Web Audio unsupported — sirens silently no-op, never a crash.

  ctx = new AudioCtxCtor();
  masterGain = ctx.createGain();
  masterGain.gain.value = 0; // ramped up by applyMasterGain() below — never a hard pop-in.
  masterGain.connect(ctx.destination);
}

function applyMasterGain(): void {
  if (!ctx || !masterGain) return;
  const state = getGameState();
  const target = resolveMasterGainTarget(state.settings.muted, state.machine);
  const now = ctx.currentTime;
  masterGain.gain.cancelScheduledValues(now);
  masterGain.gain.linearRampToValueAtTime(target, now + SIRENS.gainRampSec);
}

function readPursuerPositions(): PursuerPosition[] {
  const api = unitsRef.current;
  if (!api) return []; // spawn director not mounted (e.g. Task 1/2 not landed, or pre-PLAYING).
  const out: PursuerPosition[] = [];
  for (const slot of api.slots) {
    if (slot.kind === null || slot.state !== 'pursuing') continue;
    out.push({ id: slot.id, x: slot.x, z: slot.z });
  }
  return out;
}

function updateVoices(): void {
  if (!ctx || !masterGain) return;
  const pose = playerVehicle.current?.readState().pose;
  const nearest = pose
    ? nearestPursuers(pose.position.x, pose.position.z, readPursuerPositions())
    : [];

  // Voice nodes are lazily grown and never torn down/recreated while the graph is alive —
  // reusing the same oscillators across rebinds is exactly what keeps rebinds pop-free
  // (only the gain ramps; the carrier/LFO just keep running).
  while (voices.length < SIRENS.maxVoices) voices.push(createVoice(ctx, masterGain));

  const now = ctx.currentTime;
  for (let i = 0; i < voices.length; i++) {
    const voice = voices[i];
    const candidate = nearest[i];
    const targetGain = candidate ? distanceFalloff(candidate.dist) : 0;
    const boundId = candidate?.id ?? null;

    if (import.meta.env.DEV && voice.boundUnitId !== boundId) {
      console.debug(`[sirens] voice ${i} bound -> unit ${String(boundId)}`);
    }
    voice.boundUnitId = boundId;

    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.linearRampToValueAtTime(targetGain, now + SIRENS.gainRampSec);
  }
}

/** Full teardown: stops/disconnects every oscillator and gain node and closes the
 * AudioContext. Safe to call even if a context was never created. */
function disposeAudioGraph(): void {
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
  }
  voices = [];
  masterGain?.disconnect();
  masterGain = null;
  if (ctx) {
    void ctx.close().catch(() => {
      // Already closed / unsupported in this environment — nothing more to do.
    });
    ctx = null;
  }
  contextRequested = false;
}

/**
 * Mounts the siren system: watches the store for the first PLAYING entry (lazy
 * AudioContext creation, see file header), re-evaluates the nearest pursuers at
 * `SIRENS.evalHz`, and reacts immediately to mute/pause/gameover via a store subscription
 * (rather than waiting for the next eval tick). Returns a teardown function that stops the
 * interval, unsubscribes, and fully disposes the WebAudio graph — call on unmount
 * (audio/SirensSystem.tsx).
 */
export function initSirens(): () => void {
  const maybeCreateContext = () => {
    if (contextRequested) return;
    if (getGameState().machine !== 'PLAYING') return;
    contextRequested = true;
    ensureContext();
    applyMasterGain();
  };

  maybeCreateContext(); // covers mounting while already PLAYING (e.g. a hot-reload / retry).

  const unsubscribe = useGameStore.subscribe((state, prev) => {
    if (state.machine !== prev.machine) maybeCreateContext();
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
    disposeAudioGraph();
  };
}

// --- debug / verification surface -------------------------------------------------------------

export interface SirenDebugVoice {
  readonly boundUnitId: number | null;
  readonly gain: number;
}

/** DEV/scripted-verification snapshot (core/debugBridge.ts): per-voice binding + current
 * gain, and the AudioContext's state (null if one was never created — e.g. no run has
 * reached PLAYING yet this session). */
export function getSirenDebugSnapshot(): {
  readonly contextState: AudioContextState | null;
  readonly voices: readonly SirenDebugVoice[];
} {
  return {
    contextState: ctx?.state ?? null,
    voices: voices.map((v) => ({ boundUnitId: v.boundUnitId, gain: v.gain.gain.value })),
  };
}
