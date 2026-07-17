// Event->sound mapping, mixer glue, and lifecycle (Phase 15 Task 4). This is the seam
// audio/manager.ts (Task 1) and audio/synth.ts (Task 2) both explicitly left open for: neither
// imports the other (avoids a Task-1-must-land-before-Task-2 build-order dependency), so
// something has to (a) register synth.ts's SOUND_BUILDERS with manager.ts's registerSound, and
// (b) subscribe the gameEvents catalog (state/events.ts) and translate it into playEvent calls.
// That's this file's job, plus the mix knobs (config/audio.ts's AUDIO_MIX) and the dev debug
// board (core/devPanel.tsx's "Audio" folder) that fire sounds directly.
//
// --- registration adapter ------------------------------------------------------------------
// manager.ts's `SoundBuilder` is `(playCtx, params) => void` — fully self-contained, expected
// to call `playCtx.acquireVoice` itself and wire its own graph. synth.ts's `SoundBuilder` is
// `(ctx, destination, params) => VoiceHandle` — it wires a graph feeding a *given* destination
// and hands back a start/stop/onEnded control surface, but never touches the pool itself
// (synth.ts predates manager.ts on disk and deliberately has zero dependency on it). The two
// shapes don't match — `registerAdapter` below is the glue: acquire a pool voice, connect an
// intermediate GainNode into the assigned bus through that voice, build the synth graph into
// that GainNode, start it, and wire the pool release into the synth voice's `onEnded` (natural
// end) and the pool's `onEvicted` into an early `synthVoice.stop()` (a higher-priority sound
// stole the slot). This is the one place in the app where a manager voice and a synth voice
// meet — every other system only ever sees one side of it.
//
// --- loop control ---------------------------------------------------------------------------
// `playEvent`/`registerSound` are fire-and-forget by design (manager.ts's own doc comment) —
// fine for one-shots, not enough for the three LOOPING sounds this file owns end-to-end
// (engine, ambienceCity, ambienceCrickets — transformerHum is a fourth loop name in the
// registry but its lifecycle belongs to audio/positional.ts, Task 3; this file only registers
// its builder and gives the debug board a preview button for it). `activeLoops` is this
// module's own bookkeeping — every `registerAdapter` call for a 'loop'-group sound stashes its
// (SynthVoiceHandle, pool VoiceHandle) pair there on creation and removes it on stop/natural
// end, so `startEngineLoop`/`setEngineSpeed`/`setAmbience`/`stopAllLoops` all have a live
// handle to act on without re-deriving anything from `playEvent`'s fire-and-forget return
// (`void`).
//
// --- orphan-loop discipline (TDD §11 gotcha: "loops must hard-stop on GAMEOVER/reset") -------
// `runEnded` stops the engine and whichever ambience bed is playing; `runStarted` restarts them
// (guarded — starting an already-running loop by name is a no-op, so a stray double
// `runStarted` can't stack two engine voices). `initEventMap`'s returned teardown additionally
// calls `stopAllLoops()` and clears the pending transformer-whoomp timer, so an unmount mid-run
// can't leave anything ticking either. See eventMap.test.ts + the scratchpad soak script for
// the 10-retry orphan verification.
import { gameEvents, type GameEventMap } from '../state/events';
import { getGameState } from '../state/store';
import { playerVehicle } from '../vehicles/playerRef';
import { getSelectedCarDef } from '../vehicles/definitions';
import { readTracers } from '../combat/tracerFeed';
import { readExplosions } from '../combat/explosionFeed';
import { STARTER_TOP_SPEED } from '../config/vehicles';
import { AUDIO_MIX, VOICE_POOL_CAPS } from '../config/audio';
import {
  registerSound,
  playEvent as managerPlayEvent,
  getAudioContext,
  getBusNode,
  busGains,
  liveVoiceCount,
  getAudioContextState,
  resolveBusTargets,
  type PlayCtx,
  type VoiceGroup,
  type AudioBusName,
  type VoiceHandle as ManagerVoiceHandle,
} from './manager';
import {
  SOUND_BUILDERS,
  SOUND_NAMES as SYNTH_SOUND_NAMES,
  type SoundName,
  type SoundBuilder as SynthBuilder,
  type SoundParams as SynthSoundParams,
  type VoiceHandle as SynthVoiceHandle,
  type EngineVoice,
} from './synth';

export type { SoundName };
/** Every registration name, in registration order — the debug board iterates this directly. */
export const SOUND_NAMES: readonly SoundName[] = SYNTH_SOUND_NAMES;

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

// ============================================================================================
// Registration tables — which pool group / mix bus / manager.ts priority each SoundName uses.
// `Record<SoundName, X>` (not a partial map) makes an entry for a new SoundName a COMPILE
// error until it's added here, mirroring state/events.ts's own "typed catalog, nothing
// silently unhandled" discipline.
// ============================================================================================

const GROUP: Record<SoundName, VoiceGroup> = {
  engine: 'loop',
  impact: 'impact',
  gunshot: 'gun',
  shellLaunch: 'gun',
  explosionNear: 'explosion',
  explosionFar: 'explosion',
  transformerHum: 'loop',
  transformerZap: 'impact',
  powerDownWhoomp: 'impact',
  ambienceCity: 'loop',
  ambienceCrickets: 'loop',
  stingerTier1: 'stinger',
  stingerTier2: 'stinger',
  stingerTier3: 'stinger',
  stingerTier4: 'stinger',
  stingerTier5: 'stinger',
  stingerWrecked: 'stinger',
  stingerBusted: 'stinger',
  uiTick: 'ui',
};

// Bus routing mirrors manager.ts's own doc comment: sfx (one-shots + stingers), engine (the
// player engine loop), ambient (evening bed / crickets / district hums).
const BUS: Record<SoundName, AudioBusName> = {
  engine: 'engine',
  impact: 'sfx',
  gunshot: 'sfx',
  shellLaunch: 'sfx',
  explosionNear: 'sfx',
  explosionFar: 'sfx',
  transformerHum: 'ambient',
  transformerZap: 'sfx',
  powerDownWhoomp: 'sfx',
  ambienceCity: 'ambient',
  ambienceCrickets: 'ambient',
  stingerTier1: 'sfx',
  stingerTier2: 'sfx',
  stingerTier3: 'sfx',
  stingerTier4: 'sfx',
  stingerTier5: 'sfx',
  stingerWrecked: 'sfx',
  stingerBusted: 'sfx',
  uiTick: 'sfx',
};

/** Sound names whose lifecycle is a start/stop loop rather than a fire-and-forget one-shot —
 * derived from GROUP so it can never drift out of sync with the group table above. */
const LOOP_NAMES = new Set<SoundName>(
  (Object.keys(GROUP) as SoundName[]).filter((name) => GROUP[name] === 'loop'),
);

// ============================================================================================
// Registration adapter — see file header. Exported for eventMap.test.ts, which drives it with
// small fake SoundBuilder functions (no real oscillators) against manager.ts's REAL pool +
// its injectable AudioContextFactory test seam, so the pool/bus/loop-bookkeeping wiring below
// is exercised for real rather than only asserted by inspection.
// ============================================================================================

interface LoopEntry {
  readonly voice: SynthVoiceHandle;
  readonly poolVoice: ManagerVoiceHandle;
}

/** name -> live (synth voice, pool voice) for every currently-running LOOP_NAMES sound. Never
 * holds a one-shot — those release themselves via `onEnded` and are never looked up again. */
const activeLoops = new Map<SoundName, LoopEntry>();

export function registerAdapter(
  name: SoundName,
  build: SynthBuilder,
  group: VoiceGroup,
  bus: AudioBusName,
  priority: number,
): void {
  registerSound(name, (playCtx: PlayCtx, params?: Record<string, unknown>) => {
    const gateway = playCtx.ctx.createGain();
    let synthVoice: SynthVoiceHandle | null = null;

    const poolVoice = playCtx.acquireVoice(group, priority, () => {
      // Evicted by a higher-priority acquire in the same group — stop our graph right away
      // (manager.ts already disconnected `gateway` from the bus; this just silences the
      // still-running oscillators feeding it) and drop our loop bookkeeping if it's one.
      synthVoice?.stop(playCtx.ctx.currentTime);
      activeLoops.delete(name);
    });
    if (!poolVoice) return; // pool refused (at cap, not higher priority) — silent, by design.

    poolVoice.connect(gateway, bus);
    synthVoice = build(playCtx.ctx, gateway, params as SynthSoundParams | undefined);
    synthVoice.onEnded = () => {
      poolVoice.release();
      activeLoops.delete(name);
    };
    synthVoice.start(playCtx.now);

    if (LOOP_NAMES.has(name)) activeLoops.set(name, { voice: synthVoice, poolVoice });
  });
}

let registered = false;

/** Registers every synth.ts builder through the adapter above. Idempotent — safe to call more
 * than once (e.g. a hot-reload re-running `initEventMap`); manager.ts's own `registerSound`
 * already overwrites-with-a-dev-warning on a duplicate name, so a second call just re-adapts
 * cleanly rather than doing anything harmful. */
export function registerAllEventSounds(): void {
  registered = true;
  for (const name of SOUND_NAMES) {
    registerAdapter(name, SOUND_BUILDERS[name], GROUP[name], BUS[name], AUDIO_MIX.priority[name]);
  }
}

/** True once `registerAllEventSounds` has run at least once this session — devPanel's debug
 * board reads this to know whether the "fire" buttons have anything registered yet. */
export function isRegistered(): boolean {
  return registered;
}

/** Fire a registered sound by name — the same seam the debug board and every gameEvents
 * subscription below use. Thin pass-through to manager.ts's `playEvent` (see that function's
 * doc comment for the no-op cases: unregistered name, Web Audio unavailable). */
export function playEvent(name: SoundName, params?: SynthSoundParams): void {
  managerPlayEvent(name, params as Record<string, unknown> | undefined);
}

// ============================================================================================
// Loop control (engine + ambience). transformerHum is registered (above) but its start/stop
// lifecycle belongs to audio/positional.ts (Task 3, nearest-N cull) — not driven here.
// ============================================================================================

function startLoop(name: SoundName, params?: SynthSoundParams): void {
  if (activeLoops.has(name)) return; // already running — no double-start (TDD §11 gotcha).
  playEvent(name, params);
}

function stopLoop(name: SoundName): void {
  const entry = activeLoops.get(name);
  if (!entry) return;
  entry.voice.stop();
  activeLoops.delete(name);
}

/** Stops every currently-running loop this module knows about (engine, whichever ambience bed
 * is live, and — defensively — a transformerHum preview left running from the debug board),
 * and resets ambience bookkeeping to match. Called by `initEventMap`'s teardown; exported for
 * the debug board's own "panic stop" use. `runEnded` normally uses the narrower
 * `stopEngineLoop`/`stopAmbience` pair instead (same net effect for the two loops it owns). */
export function stopAllLoops(): void {
  for (const name of Array.from(activeLoops.keys())) stopLoop(name);
  ambienceCurrent = null;
}

function getEngineVoice(): EngineVoice | null {
  const entry = activeLoops.get('engine');
  return entry ? (entry.voice as EngineVoice) : null;
}

export function startEngineLoop(): void {
  // Phase 17: transpose the engine voice by the selected car's base pitch (buildEngine reads
  // `enginePitch` once at build). The loop is (re)built here on every runStarted, and a car
  // can't change mid-run, so reading the selection at loop-start is the correct, stable moment.
  startLoop('engine', { speed: 0, throttle: 0, enginePitch: getSelectedCarDef().enginePitch });
}

export function stopEngineLoop(): void {
  stopLoop('engine');
}

/** Per-frame engine tracking — `speedMps` is normalized against STARTER_TOP_SPEED (the
 * project's documented "100%" baseline, config/vehicles.ts) into the 0..1 synth.ts expects.
 * A no-op if the engine loop isn't currently running (pre-run, or mid a runEnded stop). */
export function setEngineSpeed(speedMps: number): void {
  getEngineVoice()?.setSpeed(clamp01(speedMps / STARTER_TOP_SPEED));
}

export function setEngineThrottle(throttle01: number): void {
  getEngineVoice()?.setThrottle(clamp01(throttle01));
}

export type AmbienceName = 'ambienceCity' | 'ambienceCrickets';

let ambienceCurrent: AmbienceName | null = null;

/** Pure reducer: darkCity swaps the bed to crickets; a fresh runStarted always resets it to
 * city (a retry after DARK CITY shouldn't start the new run already dark). Exported + tested
 * directly so the swap policy is verifiable without a live AudioContext. */
export function nextAmbience(event: 'darkCity' | 'runStarted'): AmbienceName {
  return event === 'darkCity' ? 'ambienceCrickets' : 'ambienceCity';
}

/** Swaps the ambience bed to `which`, stopping whichever one (if any) was playing first. A
 * no-op if `which` is already the live bed — cheap and idempotent, so callers never need to
 * check `getAmbience()` themselves first. */
export function setAmbience(which: AmbienceName): void {
  if (ambienceCurrent === which) return;
  if (ambienceCurrent) stopLoop(ambienceCurrent);
  ambienceCurrent = which;
  startLoop(which, { seed: which === 'ambienceCity' ? 1 : 7 });
}

export function stopAmbience(): void {
  if (ambienceCurrent) stopLoop(ambienceCurrent);
  ambienceCurrent = null;
}

export function getAmbience(): AmbienceName | null {
  return ambienceCurrent;
}

// ============================================================================================
// Duck: a brief sfx-bus gain dip under a tier stinger (TDD §11). Manager.ts exposes the raw
// bus GainNode (getBusNode) for exactly this kind of bespoke envelope — see that module's doc
// comment ("systems that manage their own bespoke voice graph ... just need a bus to connect
// their own master gain into"); no manager.ts edit needed, so per this task's brief ("add it
// to manager ONLY if T1 exposed one") this stays entirely local to this file.
// ============================================================================================

export function duckSfxBus(cfg = AUDIO_MIX.duck): void {
  const ctx = getAudioContext();
  const sfxBus = getBusNode('sfx');
  if (!ctx || !sfxBus) return;
  // Duck relative to the CURRENTLY resolved target (not the raw AUDIO_BUSES.sfxGain constant)
  // so this composes correctly with pause/mute/GARAGE — if the bus is already silenced for a
  // reason unrelated to ducking, the recovery ramp lands back on that same silence, not a
  // spurious "unpause" of the bus.
  const target = resolveBusTargets(getGameState().machine).sfx;
  const now = ctx.currentTime;
  const g = sfxBus.gain;
  g.cancelScheduledValues(now);
  g.setValueAtTime(g.value, now);
  g.linearRampToValueAtTime(target * cfg.amount, now + cfg.rampDownSec);
  g.linearRampToValueAtTime(target, now + cfg.sec);
}

// ============================================================================================
// Pure mapping helpers — fully unit-tested (eventMap.test.ts). No Web Audio, no gameEvents.
// ============================================================================================

/** ★-tier -> stinger SoundName, or null outside 1..5 (tier 0 has no stinger; store.ts's own
 * tierChanged emission never actually fires below tier 1 — see state/store.ts's addHeat — but
 * this stays defensive rather than assuming that invariant holds forever). */
export function stingerForTier(tier: number): SoundName | null {
  const t = Math.trunc(tier);
  if (t < 1 || t > 5) return null;
  return `stingerTier${t}` as SoundName;
}

/** Explosion distance (m, 3-D) -> near/far variant selection. */
export function selectExplosionSound(
  distanceM: number,
  nearRadiusM: number = AUDIO_MIX.explosionNearRadiusM,
): 'explosionNear' | 'explosionFar' {
  return distanceM <= nearRadiusM ? 'explosionNear' : 'explosionFar';
}

/** Gunfire rate limit: true once at least `minIntervalMs` has passed since the last PLAYED
 * shot (not the last tracerFeed entry — several rounds can land in one polled frame; this
 * throttles how often the actual sound fires, not how many rounds are logged). */
export function shouldPlayGunshot(
  lastPlayedAtMs: number,
  nowMs: number,
  minIntervalMs: number = AUDIO_MIX.gunshotMinIntervalMs,
): boolean {
  return nowMs - lastPlayedAtMs >= minIntervalMs;
}

/** Deterministic round-robin impact variant (0..3, matching synth.ts's SYNTH_PARAMS.impact.
 * variantCount) — cheap sonic variety across a burst of hits without needing real per-object
 * velocity data (unavailable at the gameEvents layer — payloads are intentionally minimal,
 * state/events.ts). Exported + tested as a pure cycling function; the live counter is
 * module-scope (mirrors combat/contacts.ts's impact-counter style) since "which variant is
 * next" is inherently a running-tally concern, not something worth threading through every
 * call site. */
let impactVariantCounter = 0;
export function nextImpactVariant(): number {
  const v = impactVariantCounter % 4;
  impactVariantCounter += 1;
  return v;
}

/** One place every impact-family gameEvent funnels through — flat-ish gain per the task brief
 * ("velocity unknown"), a light per-source `velocity` trim so a wreck reads a touch heavier
 * than a graze, and the round-robin variant above for texture. */
function playImpact(velocity: number): void {
  playEvent('impact', { velocity, variant: nextImpactVariant() });
}

// ============================================================================================
// Transformer sequence: zap immediately, whoomp after AUDIO_MIX.transformerWhoompDelayMs.
// ============================================================================================

let pendingWhoompTimer: ReturnType<typeof setTimeout> | null = null;

function clearPendingWhoomp(): void {
  if (pendingWhoompTimer !== null) {
    clearTimeout(pendingWhoompTimer);
    pendingWhoompTimer = null;
  }
}

export function playTransformerSequence(): void {
  playEvent('transformerZap');
  clearPendingWhoomp();
  pendingWhoompTimer = setTimeout(() => {
    pendingWhoompTimer = null;
    playEvent('powerDownWhoomp');
  }, AUDIO_MIX.transformerWhoompDelayMs);
}

// ============================================================================================
// Event catalog doc/exhaustiveness — Record<keyof GameEventMap, string> means adding a new
// event to state/events.ts without updating this table is a COMPILE error, not a silent gap.
// Not read at runtime (initEventMap's own gameEvents.on(...) calls below do the real dispatch);
// this is a single reviewable table + the thing eventMap.test.ts asserts against GameEventMap's
// own keys.
// ============================================================================================

export const EVENT_SOUND_DOC: Record<keyof GameEventMap, string> = {
  heatChanged: 'no-op — fires many times/sec under sustained heat gain; would be noise, not signal. tierChanged is the audible threshold-crossing beat.',
  tierChanged: 'stingerTier{1-5} + sfx-bus duck',
  transformerDestroyed: 'transformerZap -> (AUDIO_MIX.transformerWhoompDelayMs) -> powerDownWhoomp',
  unitWrecked: 'impact (a satisfying crunch for taking out a pursuer — not in the task brief\'s explicit list, added since a silent enemy kill reads as a bug, not a choice; cheap reuse of the existing impact mapping)',
  civHit: 'impact (light velocity trim)',
  civWrecked: 'impact (heavier velocity trim)',
  propDestroyed: 'impact (heavier velocity trim)',
  playerDamaged: 'no-op — no distinct per-hit sound in this pass (fires on every hit, including sustained fire; playerWrecked already covers the death beat). Good Phase 16 (FX & juice) follow-up if a hit-taken cue is wanted.',
  playerWrecked: 'stingerWrecked',
  busted: 'stingerBusted',
  runStarted: 'ambienceCity (nextAmbience resets to city even after a prior DARK CITY) + engine loop start',
  runEnded: 'stop engine + ambience loop (graceful — synth.ts\'s own release tails, not a hard cut)',
  darkCity: 'ambience swap city -> crickets (nextAmbience)',
  enteredWater: 'impact, low velocity trim (splash-ish stand-in — no dedicated splash synth exists in this pass; a real watery variant is a reasonable Task 2/16 follow-up)',
  carUnlocked: 'no-op in the audio map — the unlock cue (score-screen toast + garage badge; a uiTick if the garage/HUD layer wants one) is owned there, not here. No dedicated unlock jingle in this pass; adding one is a clean follow-up.',
};

// ============================================================================================
// Gunfire / explosion feed polling + per-frame engine tracking. Mirrors fx/Tracers.tsx's and
// fx/Explosions.tsx's own "poll a ring buffer, act on what's new since last tick" pattern —
// see those files for why tracking the newest-seen TIMESTAMP (not array index/length) is safe
// across a buffer that both grows and, once full, shifts.
// ============================================================================================

let lastShotT = -Infinity;
let lastGunshotPlayedAtMs = -Infinity;
let lastBlastT = -Infinity;
let rafId: number | null = null;

function resetFeedTracking(): void {
  lastShotT = -Infinity;
  lastGunshotPlayedAtMs = -Infinity;
  lastBlastT = -Infinity;
}

function tickFrame(): void {
  rafId = requestAnimationFrame(tickFrame);

  const vs = playerVehicle.current?.readState();
  if (vs) setEngineSpeed(vs.speed);

  // Gunfire: a shot = a sound, rate-limited — several rounds landing in one polled frame only
  // ever trigger (at most) one playEvent this tick, and shouldPlayGunshot throttles further
  // than that across ticks too.
  const { shots } = readTracers();
  if (shots.length > 0) {
    const newestT = shots[shots.length - 1].t; // append-only chronological — see file header.
    if (newestT > lastShotT) {
      lastShotT = newestT;
      const nowMs = performance.now();
      if (shouldPlayGunshot(lastGunshotPlayedAtMs, nowMs)) {
        playEvent('gunshot');
        lastGunshotPlayedAtMs = nowMs;
      }
    }
  }

  // Explosions: near/far by distance to the player, one playEvent per NEW blast since last
  // tick (a multi-blast frame — e.g. a shell landing near a prop that also detonates — plays
  // each one; the 'explosion' pool cap (3) is what actually limits concurrent voices).
  const { blasts } = readExplosions();
  if (blasts.length > 0) {
    const pos = playerVehicle.current?.readState().pose.position;
    let newestT = lastBlastT;
    for (const blast of blasts) {
      if (blast.t <= lastBlastT) continue;
      const distanceM = pos ? Math.hypot(blast.x - pos.x, blast.y - pos.y, blast.z - pos.z) : Infinity;
      playEvent(selectExplosionSound(distanceM));
      if (blast.t > newestT) newestT = blast.t;
    }
    lastBlastT = newestT;
  }
}

// ============================================================================================
// Lifecycle: registers the synth library, subscribes the gameEvents catalog, and starts the
// per-frame feed-polling loop. Mirrors audio/sirens.ts's `initSirens` shape (a plain function
// returning a teardown) — the orchestrator's integration pass mounts this the same way
// audio/SirensSystem.tsx already mounts `initSirens`.
// ============================================================================================

export function initEventMap(): () => void {
  registerAllEventSounds();
  resetFeedTracking();

  const offs: Array<() => void> = [];

  offs.push(
    gameEvents.on('tierChanged', ({ tier }) => {
      const sound = stingerForTier(tier);
      if (!sound) return;
      playEvent(sound, { tier });
      duckSfxBus();
    }),
  );
  offs.push(gameEvents.on('propDestroyed', () => playImpact(0.7)));
  offs.push(gameEvents.on('civHit', () => playImpact(0.4)));
  offs.push(gameEvents.on('civWrecked', () => playImpact(0.7)));
  offs.push(gameEvents.on('unitWrecked', () => playImpact(0.8)));
  offs.push(gameEvents.on('transformerDestroyed', () => playTransformerSequence()));
  offs.push(gameEvents.on('darkCity', () => setAmbience(nextAmbience('darkCity'))));
  offs.push(gameEvents.on('playerWrecked', () => playEvent('stingerWrecked')));
  offs.push(gameEvents.on('busted', () => playEvent('stingerBusted')));
  offs.push(
    gameEvents.on('runStarted', () => {
      resetFeedTracking();
      setAmbience(nextAmbience('runStarted'));
      startEngineLoop();
    }),
  );
  offs.push(
    gameEvents.on('runEnded', () => {
      stopEngineLoop();
      stopAmbience();
      clearPendingWhoomp();
    }),
  );
  offs.push(gameEvents.on('enteredWater', () => playImpact(0.3)));
  // heatChanged, playerDamaged: intentional no-ops — see EVENT_SOUND_DOC above.

  rafId = requestAnimationFrame(tickFrame);

  return () => {
    for (const off of offs) off();
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    clearPendingWhoomp();
    stopAllLoops();
  };
}

// ============================================================================================
// Introspection — devPanel's "Audio" folder monitor + the orphan-loop soak script (via
// core/debugBridge.ts's window.__smashy.audioSnapshot(), Task 1's; this is the same
// liveVoiceCount/busGains/getAudioContextState data, just with the extra loop/ambience detail
// only this module tracks).
// ============================================================================================

export interface EventMapSnapshot {
  readonly contextState: AudioContextState | null;
  readonly liveVoiceTotal: number;
  readonly byGroup: Record<VoiceGroup, number>;
  readonly busGains: { readonly master: number; readonly sfx: number; readonly engine: number; readonly ambient: number };
  readonly activeLoops: readonly SoundName[];
  readonly ambience: AmbienceName | null;
}

export function getEventMapSnapshot(): EventMapSnapshot {
  const groups = Object.keys(VOICE_POOL_CAPS) as VoiceGroup[];
  const byGroup = {} as Record<VoiceGroup, number>;
  for (const g of groups) byGroup[g] = liveVoiceCount(g);
  return {
    contextState: getAudioContextState(),
    liveVoiceTotal: liveVoiceCount(),
    byGroup,
    busGains: busGains(),
    activeLoops: Array.from(activeLoops.keys()),
    ambience: ambienceCurrent,
  };
}

// ============================================================================================
// Test-only reset — mirrors combat/runLoop.ts's `__resetRunLoopForTest` naming convention.
// Clears this module's own bookkeeping only; callers combine with manager.ts's own
// `__resetAudioManagerForTest`.
// ============================================================================================

export function __resetEventMapForTest(): void {
  activeLoops.clear();
  ambienceCurrent = null;
  registered = false;
  clearPendingWhoomp();
  resetFeedTracking();
  impactVariantCounter = 0;
}
