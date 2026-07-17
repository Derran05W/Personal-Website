// Positional (spatialized) audio (Phase 15 Task 3). Two LOOPING atmosphere systems —
// district transformer HUMS and helicopter ROTOR chop — plus the shared distance-gain +
// stereo-pan helper every positional voice in the game uses (sirens included: audio/sirens.ts
// imports `spatialParams`/`bearingPan`/`distanceGain` from here). No HRTF (locked plan
// decision): spatialization is a cheap per-voice GainNode (distance falloff) + StereoPannerNode
// (bearing), nothing more.
//
// --- panning model: bearing in view space -------------------------------------------------
// The listener POSITION is the player (distance/gain is measured from the car), but the stereo
// PAN is the source's bearing in the CAMERA's view space. The follow camera never rotates —
// it holds a FIXED yaw (CAMERA.yawDeg) and pitch (fx/cameraRig.ts) — so the view-space "right"
// axis is a world-space constant we can precompute once.
//
// three.js builds the camera basis from localZ = normalize(camera - target) (the camera looks
// down its local -Z), right = normalize(cross(worldUp, localZ)). With the camera sitting at the
// fixed spherical offset (yaw ψ, pitch θ) from the player and looking at it, localZ ∝
// (cosθ·sinψ, sinθ, cosθ·cosψ); crossing worldUp=(0,1,0) with it and dropping the common
// positive cosθ factor gives the horizontal screen-right axis  right_h = (cosψ, −sinψ).
// A source at horizontal displacement d=(dx,dz) from the listener therefore pans by
//   pan = clamp(dot(unit(d), right_h), −1, 1) = clamp((dx·cosψ − dz·sinψ)/|d|, −1, 1),
// i.e. the sine of the bearing angle measured off the view-forward direction — +1 hard right,
// −1 hard left, 0 dead ahead/behind. This is `bearingPan` below; `cameraYawRad` defaults to the
// fixed CAMERA.yawDeg but is a parameter so the rotation is explicit and unit-testable.
//
// --- update cadence -----------------------------------------------------------------------
// SELECTION (which transformer/heli owns a voice) runs at AUDIO_POSITIONAL.updateHz (~8 Hz) —
// a cheap distance sort/cull, never per physics step. Between updates, gains/pans are RAMPED
// (AudioParam linear ramps) so a moving heli or a blacking-out district never clicks/pops.
//
// --- manager integration + fallback -------------------------------------------------------
// Consumes audio/manager.ts's shared-context seams (Task 1, landed): `getAudioContext` /
// `unlockAudioContext` for the ONE shared AudioContext, `getBusNode('ambient')` to route this
// module's own submaster into the ambient bus (hums + rotor are atmosphere). Like the migrated
// sirens.ts, each system keeps its OWN mute/PLAYING master gate (`resolvePositionalMasterTarget`)
// rather than trusting the bus alone: the ambient bus stays quietly audible in GARAGE and its
// pause/mute gating only tracks machine state once audio/manager.ts's own mount runs its store
// subscription — neither of which we want to depend on for "no hums in the garage / silence on
// pause." Belt-and-suspenders, exactly as sirens does it. This module NEVER closes the shared
// context (manager owns that).
//
// --- verification note --------------------------------------------------------------------
// jsdom has no Web Audio API, so — as in sirens.ts/manager.ts — the impure oscillator/graph
// plumbing is NOT exercised in Vitest. Every DECISION function (distance gain, bearing pan,
// nearest-N lit-only cull with hysteresis, master gating) is a pure export unit-tested in
// positional.test.ts. Audible output is a human-on-hardware check (accepted slippage).

import { AUDIO_POSITIONAL } from '../config/audio';
import { CAMERA } from '../config/camera';
import { getGameState, useGameStore } from '../state/store';
import type { GameState } from '../state/machine';
import { playerVehicle } from '../vehicles/playerRef';
import { heliRef, type HeliLivery } from '../ai/heliTypes';
import { gridRef } from '../powergrid/grid';
import { worldRef } from '../world/worldRef';
import { derivePlacements } from '../world/propPlacements';
import type { WorldData } from '../world/types';
import { getAudioContext, getAudioContextState, getBusNode, unlockAudioContext } from './manager';

// --- pure core (fully unit-tested, no browser APIs) -----------------------------------------

const DEG2RAD = Math.PI / 180;

/** The follow camera's FIXED yaw (rad) — see the file header's panning-model derivation. The
 * view-space right axis is constant because the camera never rotates (CAMERA.yawDeg). */
export const CAMERA_YAW_RAD = CAMERA.yawDeg * DEG2RAD;

/** Below this horizontal distance (m) a source is treated as on top of the listener → pan 0
 * (dead center) rather than dividing by a ~0 magnitude. */
const PAN_EPSILON = 1e-4;

export interface ListenerPose {
  readonly x: number;
  readonly z: number;
}

export interface SpatialParams {
  /** 0..1 distance-falloff volume. */
  readonly gain: number;
  /** -1 (hard left) .. +1 (hard right) stereo pan. */
  readonly pan: number;
}

/**
 * Linear distance falloff → gain in [0, 1]: 1 at dist=0, 0 at dist>=radiusM. Defensive against
 * a non-finite/negative `dist` and a non-positive radius (a voice popping to a nonsensical gain
 * off a stray bad read is worse than a clamp). Shared with audio/sirens.ts's `distanceFalloff`.
 */
export function distanceGain(dist: number, radiusM: number): number {
  if (!Number.isFinite(dist) || radiusM <= 0) return 0;
  return Math.min(1, Math.max(0, 1 - dist / radiusM));
}

/**
 * Stereo pan (-1 left .. +1 right) for a source at horizontal displacement (dx, dz) from the
 * listener, in the view space of a camera whose azimuth is `cameraYawRad` (default: the fixed
 * CAMERA.yawDeg). See the file header for the full derivation — pan is the sine of the bearing
 * measured off the camera's view-forward direction. Returns 0 when the source sits on top of
 * the listener (|d| ~ 0).
 */
export function bearingPan(dx: number, dz: number, cameraYawRad: number = CAMERA_YAW_RAD): number {
  const dist = Math.hypot(dx, dz);
  if (!Number.isFinite(dist) || dist < PAN_EPSILON) return 0;
  const pan = (dx * Math.cos(cameraYawRad) - dz * Math.sin(cameraYawRad)) / dist;
  return Math.min(1, Math.max(-1, pan));
}

/**
 * Distance-gain (from the listener) + bearing-pan (view space) for a source at world (srcX,
 * srcZ). The shared positional helper: gain uses straight-line XZ distance to the listener,
 * pan uses the same displacement rotated into the fixed camera's view space.
 */
export function spatialParams(
  srcX: number,
  srcZ: number,
  listener: ListenerPose,
  radiusM: number,
  cameraYawRad: number = CAMERA_YAW_RAD,
): SpatialParams {
  const dx = srcX - listener.x;
  const dz = srcZ - listener.z;
  return {
    gain: distanceGain(Math.hypot(dx, dz), radiusM),
    pan: bearingPan(dx, dz, cameraYawRad),
  };
}

/** A hum-emitting transformer (position + which district it powers). */
export interface HumCandidate {
  readonly districtId: number;
  readonly x: number;
  readonly z: number;
}

/** A transformer selected to own a live hum voice this update. */
export interface SelectedHum {
  readonly districtId: number;
  readonly x: number;
  readonly z: number;
  readonly dist: number;
}

export interface HumCullOptions {
  /** Audible radius (m) — a candidate must be within this to ACQUIRE a voice. */
  readonly radiusM: number;
  /** Max voices to hand out (nearest-N). */
  readonly maxVoices: number;
  /** Extra radius (m) an already-voiced candidate keeps before it's culled (hysteresis).
   * Defaults to 0 (no hysteresis). */
  readonly hysteresisM?: number;
  /** District ids that already own a voice — they get the wider release radius. */
  readonly prevSelected?: ReadonlySet<number>;
}

/**
 * Nearest-N cull for transformer hums: keep only LIT districts (a destroyed transformer blacks
 * out its district and must go silent), within the audible radius (a currently-voiced one keeps
 * a wider RELEASE radius = radiusM + hysteresisM so it doesn't chatter at the boundary), then
 * the nearest `maxVoices` by distance. Pure — takes plain candidate data + an `isLit` predicate,
 * so it's fully testable without the powergrid/world modules.
 */
export function selectHumVoices(
  listener: ListenerPose,
  candidates: readonly HumCandidate[],
  isLit: (districtId: number) => boolean,
  opts: HumCullOptions,
): SelectedHum[] {
  const hysteresis = opts.hysteresisM ?? 0;
  const prev = opts.prevSelected;
  const scored: SelectedHum[] = [];
  for (const c of candidates) {
    if (!isLit(c.districtId)) continue; // dark / destroyed transformer → silent
    const dist = Math.hypot(c.x - listener.x, c.z - listener.z);
    const limit = prev?.has(c.districtId) ? opts.radiusM + hysteresis : opts.radiusM;
    if (dist > limit) continue;
    scored.push({ districtId: c.districtId, x: c.x, z: c.z, dist });
  }
  scored.sort((a, b) => a.dist - b.dist);
  return scored.slice(0, Math.max(0, opts.maxVoices));
}

/**
 * This module's OWN submaster gate (mirrors sirens.ts's resolveMasterGainTarget, but a plain
 * 0/1 switch since per-voice gains already carry loudness): 0 when muted or not actively PLAYING
 * (no garage/paused/gameover atmosphere), else 1. See the file header for why we gate ourselves
 * rather than trust the ambient bus.
 */
export function resolvePositionalMasterTarget(muted: boolean, machine: GameState): number {
  if (muted) return 0;
  return machine === 'PLAYING' ? 1 : 0;
}

// --- impure: WebAudio graphs ------------------------------------------------------------------

/** One district-hum voice: two low sines (fundamental + octave) → lowpass → gain → panner. */
interface HumVoice {
  readonly fund: OscillatorNode;
  readonly harm: OscillatorNode;
  readonly gain: GainNode;
  readonly panner: StereoPannerNode;
  /** District currently sounded, or null when this voice is idle (gain ramping to 0). */
  boundDistrict: number | null;
}

/** One heli-rotor voice: blade-rate-gated noise wash + a low thump → gain → panner. */
interface RotorVoice {
  readonly noise: AudioBufferSourceNode;
  readonly bladeLfo: OscillatorNode;
  readonly thump: OscillatorNode;
  readonly gain: GainNode;
  readonly panner: StereoPannerNode;
  /** True while this voice is sounding a live heli slot (for fade-edge detection + snapshot). */
  active: boolean;
  livery: HeliLivery | null;
}

let positionalMaster: GainNode | null = null;
let humVoices: HumVoice[] = [];
let rotorVoices: RotorVoice[] = [];
let graphInitialized = false;

// Transformer candidates are derived once per world (regenerate/retry) and cached — pure
// derivePlacements is ~1-2 ms and its transformerBox entries never move within a run.
let cachedWorld: WorldData | null = null;
let cachedTransformers: HumCandidate[] = [];

function getTransformerCandidates(): HumCandidate[] {
  const world = worldRef.current;
  if (!world) return [];
  if (world !== cachedWorld) {
    cachedWorld = world;
    cachedTransformers = derivePlacements(world)
      .filter((p) => p.archetype === 'transformerBox')
      .map((p) => ({ districtId: p.districtId, x: p.x, z: p.z }));
  }
  return cachedTransformers;
}

function isDistrictLit(districtId: number): boolean {
  return gridRef.current.lit[districtId] === true;
}

function rampParam(param: AudioParam, target: number, seconds: number, now: number): void {
  param.cancelScheduledValues(now);
  param.linearRampToValueAtTime(target, now + seconds);
}

function makeNoiseBuffer(context: AudioContext): AudioBuffer {
  const seconds = 2;
  const buffer = context.createBuffer(1, Math.max(1, Math.floor(context.sampleRate * seconds)), context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

function createHumVoice(context: AudioContext, destination: AudioNode): HumVoice {
  const cfg = AUDIO_POSITIONAL.hum;
  const fund = context.createOscillator();
  fund.type = 'sine';
  fund.frequency.value = cfg.fundHz;

  const harm = context.createOscillator();
  harm.type = 'sine';
  harm.frequency.value = cfg.octaveHz;
  const harmGain = context.createGain();
  harmGain.gain.value = cfg.octaveMix;

  const lowpass = context.createBiquadFilter();
  lowpass.type = 'lowpass';
  lowpass.frequency.value = cfg.lowpassHz;

  const gain = context.createGain();
  gain.gain.value = 0;
  const panner = context.createStereoPanner();
  panner.pan.value = 0;

  fund.connect(lowpass);
  harm.connect(harmGain);
  harmGain.connect(lowpass);
  lowpass.connect(gain);
  gain.connect(panner);
  panner.connect(destination);

  fund.start();
  harm.start();
  return { fund, harm, gain, panner, boundDistrict: null };
}

function createRotorVoice(context: AudioContext, destination: AudioNode, noiseBuffer: AudioBuffer): RotorVoice {
  const cfg = AUDIO_POSITIONAL.rotor;
  const noise = context.createBufferSource();
  noise.buffer = noiseBuffer;
  noise.loop = true;

  const bandpass = context.createBiquadFilter();
  bandpass.type = 'bandpass';
  bandpass.frequency.value = cfg.noiseBandHz;
  bandpass.Q.value = cfg.noiseQ;

  // Blade-rate amplitude gate on the noise: chopGain.gain oscillates between (1 - chopDepth)
  // and 1 at bladeRateHz — the "chop" of a rotor. bladeLfo (±1) × (chopDepth/2) sums onto a
  // base of (1 - chopDepth/2).
  const chopGain = context.createGain();
  chopGain.gain.value = 1 - cfg.chopDepth / 2;
  const bladeLfo = context.createOscillator();
  bladeLfo.type = 'sine';
  bladeLfo.frequency.value = cfg.bladeRateHz;
  const bladeDepth = context.createGain();
  bladeDepth.gain.value = cfg.chopDepth / 2;
  bladeLfo.connect(bladeDepth);
  bladeDepth.connect(chopGain.gain);

  // Low square "thwop" under the wash.
  const thump = context.createOscillator();
  thump.type = 'square';
  thump.frequency.value = cfg.thumpHz;
  const thumpGain = context.createGain();
  thumpGain.gain.value = cfg.thumpMix;

  const gain = context.createGain();
  gain.gain.value = 0;
  const panner = context.createStereoPanner();
  panner.pan.value = 0;

  noise.connect(bandpass);
  bandpass.connect(chopGain);
  chopGain.connect(gain);
  thump.connect(thumpGain);
  thumpGain.connect(gain);
  gain.connect(panner);
  panner.connect(destination);

  noise.start();
  bladeLfo.start();
  thump.start();
  return { noise, bladeLfo, thump, gain, panner, active: false, livery: null };
}

function ensureGraph(): void {
  if (graphInitialized) return;
  const context = unlockAudioContext(); // shared context (manager.ts) — idempotent.
  if (!context) return; // Web Audio unsupported — silently no-op, never a crash.
  const ambientBus = getBusNode('ambient');
  if (!ambientBus) return; // defensive: a successful unlock always creates the buses too.

  positionalMaster = context.createGain();
  positionalMaster.gain.value = 0; // ramped up by applyMasterGate() — never a hard pop-in.
  positionalMaster.connect(ambientBus);

  for (let i = 0; i < AUDIO_POSITIONAL.hum.maxVoices; i++) {
    humVoices.push(createHumVoice(context, positionalMaster));
  }
  const noiseBuffer = makeNoiseBuffer(context);
  for (let i = 0; i < AUDIO_POSITIONAL.rotor.maxVoices; i++) {
    rotorVoices.push(createRotorVoice(context, positionalMaster, noiseBuffer));
  }
  graphInitialized = true;
}

function applyMasterGate(): void {
  const context = getAudioContext();
  if (!context || !positionalMaster) return;
  const state = getGameState();
  const target = resolvePositionalMasterTarget(state.settings.muted, state.machine);
  const now = context.currentTime;
  positionalMaster.gain.cancelScheduledValues(now);
  positionalMaster.gain.linearRampToValueAtTime(target, now + AUDIO_POSITIONAL.rampSec);
}

function updateHums(listener: ListenerPose, now: number): void {
  const cfg = AUDIO_POSITIONAL.hum;
  const prevSelected = new Set<number>();
  for (const v of humVoices) if (v.boundDistrict !== null) prevSelected.add(v.boundDistrict);

  const selected = selectHumVoices(listener, getTransformerCandidates(), isDistrictLit, {
    radiusM: cfg.audibleRadiusM,
    maxVoices: cfg.maxVoices,
    hysteresisM: cfg.hysteresisM,
    prevSelected,
  });
  const selectedIds = new Set(selected.map((s) => s.districtId));

  // Release voices whose district left the selection (dark, out of range, or bumped by a nearer
  // one): drop the binding and fade the voice out.
  for (const v of humVoices) {
    if (v.boundDistrict !== null && !selectedIds.has(v.boundDistrict)) {
      v.boundDistrict = null;
      rampParam(v.gain.gain, 0, cfg.fadeSec, now);
    }
  }

  // Assign / update selected districts. A voice already on a district just tracks gain/pan; a
  // freshly-assigned one fades in and SNAPS its pan (no whoosh across the field from whatever
  // bearing it last held).
  for (const s of selected) {
    let voice = humVoices.find((v) => v.boundDistrict === s.districtId);
    const isNew = voice === undefined;
    if (voice === undefined) {
      voice = humVoices.find((v) => v.boundDistrict === null);
      if (voice === undefined) continue; // pool == maxVoices == |selected| max, so unreachable
      voice.boundDistrict = s.districtId;
    }
    const g = distanceGain(s.dist, cfg.audibleRadiusM) * cfg.gain;
    const pan = bearingPan(s.x - listener.x, s.z - listener.z);
    rampParam(voice.gain.gain, g, isNew ? cfg.fadeSec : AUDIO_POSITIONAL.rampSec, now);
    if (isNew) {
      voice.panner.pan.cancelScheduledValues(now);
      voice.panner.pan.setValueAtTime(pan, now);
    } else {
      rampParam(voice.panner.pan, pan, AUDIO_POSITIONAL.rampSec, now);
    }
  }
}

function updateRotors(listener: ListenerPose, listenerY: number, now: number): void {
  const cfg = AUDIO_POSITIONAL.rotor;
  const slots = heliRef.current?.slots ?? [];
  for (let i = 0; i < rotorVoices.length; i++) {
    const voice = rotorVoices[i];
    const slot = slots[i];
    let targetGain = 0;
    let pan = voice.panner.pan.value;
    let live = false;
    let livery: HeliLivery | null = null;
    if (slot && slot.livery !== null && slot.presence > 0.001) {
      const dx = slot.x - listener.x;
      const dz = slot.z - listener.z;
      const dy = slot.y - listenerY;
      const dist = Math.hypot(dx, dz, dy);
      targetGain = distanceGain(dist, cfg.audibleRadiusM) * slot.presence * cfg.gain;
      pan = bearingPan(dx, dz);
      live = true;
      livery = slot.livery;
    }
    const edge = live !== voice.active; // appear/disappear → use the longer fade
    voice.active = live;
    voice.livery = livery;
    rampParam(voice.gain.gain, targetGain, edge ? cfg.fadeSec : AUDIO_POSITIONAL.rampSec, now);
    rampParam(voice.panner.pan, pan, AUDIO_POSITIONAL.rampSec, now);
  }
}

function updatePositional(): void {
  const context = getAudioContext();
  if (!context || !positionalMaster) return;
  const now = context.currentTime;
  const pose = playerVehicle.current?.readState().pose;
  if (!pose) {
    // No player (between runs / menus): fade everything down and drop hum bindings.
    for (const v of humVoices) {
      v.boundDistrict = null;
      rampParam(v.gain.gain, 0, AUDIO_POSITIONAL.rampSec, now);
    }
    for (const v of rotorVoices) {
      v.active = false;
      v.livery = null;
      rampParam(v.gain.gain, 0, AUDIO_POSITIONAL.rampSec, now);
    }
    return;
  }
  const listener: ListenerPose = { x: pose.position.x, z: pose.position.z };
  updateHums(listener, now);
  updateRotors(listener, pose.position.y, now);
}

function disposeVoiceOscillators(oscillators: readonly OscillatorNode[], sources: readonly AudioBufferSourceNode[]): void {
  for (const osc of oscillators) {
    try {
      osc.stop();
    } catch {
      // stop() throws on an already-stopped node — harmless.
    }
    osc.disconnect();
  }
  for (const src of sources) {
    try {
      src.stop();
    } catch {
      // Same as above.
    }
    src.disconnect();
  }
}

/** Teardown of this module's OWN graph. Stops/disconnects every voice and the submaster.
 * Deliberately does NOT close the shared AudioContext (manager.ts owns that). Safe to call
 * even if a graph was never created. */
function disposeGraph(): void {
  for (const v of humVoices) {
    disposeVoiceOscillators([v.fund, v.harm], []);
    v.gain.disconnect();
    v.panner.disconnect();
  }
  for (const v of rotorVoices) {
    disposeVoiceOscillators([v.bladeLfo, v.thump], [v.noise]);
    v.gain.disconnect();
    v.panner.disconnect();
  }
  humVoices = [];
  rotorVoices = [];
  positionalMaster?.disconnect();
  positionalMaster = null;
  graphInitialized = false;
  cachedWorld = null;
  cachedTransformers = [];
}

/**
 * Mounts the positional-audio systems (audio/PositionalAudioSystem.tsx): builds its voice graph
 * on the first PLAYING entry (lazy shared-context unlock, same autoplay-gesture reasoning as
 * sirens.ts), re-selects/ramps hum + rotor voices at AUDIO_POSITIONAL.updateHz, and reacts
 * immediately to mute/pause/gameover via a store subscription. Returns a teardown that stops the
 * interval, unsubscribes, and disposes this module's graph (never the shared context).
 */
export function initPositionalAudio(): () => void {
  const maybeInitGraph = () => {
    if (graphInitialized) return;
    if (getGameState().machine !== 'PLAYING') return;
    ensureGraph();
    applyMasterGate();
  };

  maybeInitGraph(); // covers mounting while already PLAYING (hot-reload / retry).

  const unsubscribe = useGameStore.subscribe((state, prev) => {
    if (state.machine !== prev.machine) maybeInitGraph();
    if (state.machine !== prev.machine || state.settings.muted !== prev.settings.muted) {
      applyMasterGate();
    }
  });

  const intervalId = window.setInterval(updatePositional, 1000 / AUDIO_POSITIONAL.updateHz);
  updatePositional();

  return () => {
    window.clearInterval(intervalId);
    unsubscribe();
    disposeGraph();
  };
}

// --- debug / verification surface -------------------------------------------------------------

export interface HumVoiceSnapshot {
  readonly districtId: number | null;
  readonly gain: number;
  readonly pan: number;
}

export interface RotorVoiceSnapshot {
  readonly index: number;
  readonly livery: HeliLivery | null;
  readonly active: boolean;
  readonly gain: number;
  readonly pan: number;
}

/** DEV/scripted-verification snapshot: per-hum-voice district binding + current gain/pan, the
 * count of voices currently bound to a (lit) transformer, and the shared context state. Lets a
 * headless check confirm a district blackout drops a live hum voice (core/debugBridge.ts). */
export function getHumDebugSnapshot(): {
  readonly contextState: AudioContextState | null;
  readonly liveCount: number;
  readonly voices: readonly HumVoiceSnapshot[];
} {
  return {
    contextState: getAudioContextState(),
    liveCount: humVoices.filter((v) => v.boundDistrict !== null).length,
    voices: humVoices.map((v) => ({ districtId: v.boundDistrict, gain: v.gain.gain.value, pan: v.panner.pan.value })),
  };
}

/** DEV/verification: the cached hum-candidate transformer positions (the nearest-N cull input)
 * for the current world — empty until a world has been generated. Lets a headless check teleport
 * the player onto a transformer to exercise the hum acquire + district-blackout fade path. */
export function getHumCandidatesDebug(): readonly HumCandidate[] {
  return getTransformerCandidates();
}

/** DEV/scripted-verification snapshot: per-rotor-voice liveness/livery/gain/pan + the count of
 * sounding rotor voices. Lets a headless check confirm forcing a heli tier brings a rotor voice
 * live and that presence-fade drops it (core/debugBridge.ts). */
export function getRotorDebugSnapshot(): {
  readonly contextState: AudioContextState | null;
  readonly liveCount: number;
  readonly voices: readonly RotorVoiceSnapshot[];
} {
  return {
    contextState: getAudioContextState(),
    liveCount: rotorVoices.filter((v) => v.active).length,
    voices: rotorVoices.map((v, index) => ({
      index,
      livery: v.livery,
      active: v.active,
      gain: v.gain.gain.value,
      pan: v.panner.pan.value,
    })),
  };
}
