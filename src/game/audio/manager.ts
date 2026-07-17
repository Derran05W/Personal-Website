// Shared WebAudio bus/pool manager (Phase 15 Task 1). FULLY SYNTHESIZED audio project-wide
// (locked plan decision — no audio assets exist, CC0 packs are network-firewalled the same
// as every other fetch in this sandbox, howler is deliberately unused) — this module owns
// nothing acoustic itself. It is purely the plumbing every later synth (Task 2's
// audio/synth.ts), positional system (Task 3's audio/positional.ts), and event map (Task 4's
// audio/eventMap.ts) plugs into instead of each hand-rolling its own AudioContext/GainNode
// graph the way audio/sirens.ts originally did (now migrated onto this module — see its
// file header for the specifics of that migration).
//
// --- lifecycle -------------------------------------------------------------------------------
// ONE lazy shared AudioContext, created on the first PLAYING entry — never at module load —
// because unprompted AudioContext creation is silently suspended by autoplay policy outside
// a user-gesture call stack. `initAudioManager()` below sets up that trigger the same way
// audio/sirens.ts's `initSirens()` originally did (store subscription on `machine`), so
// whichever of the two mounts first "wins" the actual context creation — `unlockAudioContext`
// is idempotent, so both existing (sirens, already wired into the game tree) and this
// module's own future dedicated mount (Task "me"'s integration pass) can call it safely.
//
// --- bus graph -------------------------------------------------------------------------------
//   master -> sfx      -> destination   (one-shots: impact/gun/ui/stinger; sirens too)
//          -> engine    -> destination   (the player engine loop, once Task 2 lands it)
//          -> ambient   -> destination   (evening bed / crickets / district hums)
// `master` gain is the mute switch (0/1, ramped 50 ms — AUDIO_BUSES.muteRampSec). Each of the
// three sub-buses independently tracks machine state via `resolveBusTargets`: sfx + engine go
// silent outside PLAYING; ambient additionally gets a quiet allowance in GARAGE (documented
// call, see that function). Loop-owning systems (engine, ambient beds, sirens) are
// responsible for not double-starting their own oscillators on resume — this module only
// controls the gain they're heard through, never their start/stop lifecycle.
//
// --- voice pool ------------------------------------------------------------------------------
// `acquireVoice(group, priority)` hands out a lightweight accounting handle per pool group
// (VoiceGroup, derived from config/audio.ts's VOICE_POOL_CAPS keys) with a per-group
// concurrency cap. When a group is full, the LOWEST-priority, OLDEST (by acquisition order)
// existing voice is evicted IF the incoming priority is strictly higher — guaranteeing a
// higher-priority voice never fails to acquire. An incoming voice whose priority does not
// exceed the pool's current minimum is refused (`null`) rather than starving something more
// important. A `null`-cap group (`loop`) never evicts — it's uncapped but still tracked
// (`liveVoiceCount`), per the project's phase-15-plan.md decision (engine/ambient loops are
// few, long-lived, and each owned by exactly one system).
//
// --- registration/dispatch seam ---------------------------------------------------------------
// `registerSound(name, builder)` / `playEvent(name, params)` are the seam Task 2 (registers
// every synth builder) and Task 4 (maps the gameEvents catalog to playEvent calls) build on.
// A builder receives a `PlayCtx` (the live AudioContext + `acquireVoice`) and is fully
// responsible for constructing its own graph, acquiring whatever voice(s) it needs, wiring
// `VoiceHandle.connect()` to the right bus, and starting/stopping its own nodes — this module
// never constructs oscillators itself. Calling `playEvent` for an unregistered name is a
// no-op (dev-only console.warn) rather than a throw: Task 2/3/4 land after this module, so
// every registration is legitimately absent until then.
//
// --- testability -----------------------------------------------------------------------------
// jsdom (this repo's unit-test DOM) has no Web Audio implementation at all (same constraint
// noted in sirens.ts), so the real AudioContext/GainNode graph can't be exercised directly in
// Vitest. `setAudioContextFactory` injects a fake `() => AudioContext`-shaped factory instead
// (manager.test.ts supplies a minimal fake implementing exactly the surface this module
// touches: createGain, currentTime, destination, close, and a `state` string) — every pool/
// eviction/registration/mute/bus-gain code path is exercised for real through that seam, not
// just the pure helpers. `__resetAudioManagerForTest` clears all module-scope state between
// tests (mirrors combat/runLoop.ts's `__resetRunLoopForTest` convention).
import { AUDIO_BUSES, VOICE_POOL_CAPS } from '../config/audio';
import { getGameState, useGameStore } from '../state/store';
import type { GameState } from '../state/machine';

/** Pool groups `acquireVoice` accepts, derived from VOICE_POOL_CAPS's keys so the config
 * object stays the single source of truth for both the cap values and the valid group set. */
export type VoiceGroup = keyof typeof VOICE_POOL_CAPS;

/** The three sub-buses voices/systems can route into. `connect()`'s bus argument, not a
 * VoiceGroup — pool group (concurrency/eviction) and bus (mix/mute/pause routing) are
 * orthogonal: e.g. an engine-loop voice and an ambient-bed voice are both `group: 'loop'`
 * but connect to different buses. */
export type AudioBusName = 'sfx' | 'engine' | 'ambient';

/** Injectable AudioContext constructor — production uses `defaultContextFactory` (guards for
 * an unsupported browser by returning null, same as sirens.ts's original check); tests inject
 * a fake. Returning `null` means Web Audio is unavailable — every caller must treat that as a
 * silent no-op, never a crash. */
export type AudioContextFactory = () => AudioContext | null;

export interface VoiceHandle {
  readonly id: number;
  readonly group: VoiceGroup;
  readonly priority: number;
  /**
   * Routes `node` into this voice's assigned bus (default `'sfx'`) instead of straight to
   * `ctx.destination`, so mute/pause/machine-state gain control applies uniformly. Safe to
   * call again (e.g. to move to a different bus) — disconnects the previously-routed node
   * from its old bus first. No-ops silently if the voice has already been released/evicted,
   * or if the shared context/bus graph doesn't exist yet.
   */
  connect(node: AudioNode, bus?: AudioBusName): void;
  /** False once `release()` has been called, or once a higher-priority acquire evicted this
   * voice out of its pool. Loop-owning systems should poll this each tick they'd otherwise
   * touch the voice, rather than assuming a handle stays valid forever. */
  readonly isLive: boolean;
  /** Returns the voice to its pool slot (frees a concurrency-cap count) and disconnects
   * whatever node was last routed through it. Idempotent — safe to call more than once, and
   * safe to call on an already-evicted handle. Does NOT stop the caller's own
   * oscillators/nodes; the synth builder that acquired the voice owns that lifecycle (see the
   * `onEvicted` callback below for the one case — eviction — where the pool needs to tell the
   * builder to stop early). */
  release(): void;
}

export type SoundParams = Record<string, unknown>;

export interface PlayCtx {
  readonly ctx: AudioContext;
  /** `ctx.currentTime`, sampled once per `playEvent` call for convenience. */
  readonly now: number;
  /** Same function as the module-level `acquireVoice` export — bundled into the ctx object
   * so a builder never needs a second import. */
  acquireVoice(group: VoiceGroup, priority: number, onEvicted?: () => void): VoiceHandle | null;
}

/**
 * A registered sound. Fully responsible for its own graph: acquire whatever voice(s) it
 * needs via `playCtx.acquireVoice`, build oscillators/gains, `handle.connect()` them to the
 * right bus, and start them. `params` is intentionally loose (`SoundParams`) — this is a
 * cross-task seam (Task 2 registers builders, Task 4 supplies params from live game events)
 * that predates either side's concrete shapes; tighten per-sound if useful once both land.
 */
export type SoundBuilder = (playCtx: PlayCtx, params?: SoundParams) => void;

// --- pure helpers (fully unit-tested, no browser APIs) ----------------------------------------

/** Mute -> master gain target. 0 when muted, else `cfg.masterGain` (defaults to exactly 1,
 * so this reads as a literal 0/1 switch in practice while staying config-driven). */
export function resolveMuteTarget(muted: boolean, cfg: { masterGain: number } = AUDIO_BUSES): number {
  return muted ? 0 : cfg.masterGain;
}

export interface BusTargets {
  readonly sfx: number;
  readonly engine: number;
  readonly ambient: number;
}

/**
 * Per-bus gain targets for the current machine state (independent of mute — mute is the
 * master gain above, multiplicatively on top of these). PLAYING is the only state where
 * sfx/engine are audible. GARAGE is the one documented exception for ambient (Task 1's own
 * call, see config/audio.ts's `garageAmbientGain` doc comment): the evening-ambience bed may
 * continue quietly on the pre-run screen. Every other non-PLAYING state (PAUSED, GAMEOVER,
 * BOOT, LOADING) silences all three — in particular PAUSED silences ambient too, on the
 * theory that a paused scene should read as fully suspended, not "the world keeps breathing
 * under the menu"; flip this if a future juice pass wants otherwise.
 */
export function resolveBusTargets(
  machine: GameState,
  cfg: { readonly sfxGain: number; readonly engineGain: number; readonly ambientGain: number; readonly garageAmbientGain: number } = AUDIO_BUSES,
): BusTargets {
  if (machine === 'PLAYING') {
    return { sfx: cfg.sfxGain, engine: cfg.engineGain, ambient: cfg.ambientGain };
  }
  if (machine === 'GARAGE') {
    return { sfx: 0, engine: 0, ambient: cfg.ambientGain * cfg.garageAmbientGain };
  }
  // PAUSED | GAMEOVER | BOOT | LOADING
  return { sfx: 0, engine: 0, ambient: 0 };
}

// --- voice pool (impure but browser-API-free: plain accounting, no AudioNodes) ----------------

interface InternalVoice {
  readonly id: number;
  readonly group: VoiceGroup;
  readonly priority: number;
  readonly seq: number;
  live: boolean;
  connectedNode: AudioNode | null;
  connectedBus: AudioBusName | null;
  onEvicted: (() => void) | null;
}

function emptyPools(): Record<VoiceGroup, InternalVoice[]> {
  const groups = Object.keys(VOICE_POOL_CAPS) as VoiceGroup[];
  const pools = {} as Record<VoiceGroup, InternalVoice[]>;
  for (const g of groups) pools[g] = [];
  return pools;
}

let pools: Record<VoiceGroup, InternalVoice[]> = emptyPools();
let nextVoiceId = 1;
let nextSeq = 0;

/** Disconnects whatever this voice last routed, if anything — shared by release() and
 * eviction so a killed voice stops reaching its bus immediately, even before (or absent) any
 * builder-side oscillator teardown. */
function disconnectVoice(v: InternalVoice): void {
  if (!v.connectedNode) return;
  try {
    v.connectedNode.disconnect();
  } catch {
    // Already disconnected / node in a torn-down state — harmless, matches sirens.ts's
    // defensive try/catch around stop()/disconnect() calls.
  }
  v.connectedNode = null;
  v.connectedBus = null;
}

function removeFromPool(v: InternalVoice): void {
  const pool = pools[v.group];
  const idx = pool.indexOf(v);
  if (idx !== -1) pool.splice(idx, 1);
}

function releaseInternalVoice(v: InternalVoice): void {
  if (!v.live) return; // idempotent — double release()/already-evicted is a no-op.
  v.live = false;
  removeFromPool(v);
  disconnectVoice(v);
}

function evictInternalVoice(v: InternalVoice): void {
  if (!v.live) return;
  v.live = false;
  removeFromPool(v);
  disconnectVoice(v);
  if (v.onEvicted) {
    try {
      v.onEvicted();
    } catch (error) {
      // One builder's teardown throwing must not break the pool for every other sound —
      // same "one handler's bug can't take down its siblings" rule as gameEvents.emit.
      console.error('[audio] onEvicted callback threw:', error);
    }
  }
}

function makeHandle(v: InternalVoice): VoiceHandle {
  return {
    id: v.id,
    group: v.group,
    priority: v.priority,
    connect(node, bus = 'sfx') {
      if (!v.live) return;
      const busNode = getBusNode(bus);
      if (!busNode) return; // context/buses not created yet — no-op, never a throw.
      if (v.connectedNode && v.connectedNode !== node) disconnectVoice(v);
      node.connect(busNode);
      v.connectedNode = node;
      v.connectedBus = bus;
    },
    get isLive() {
      return v.live;
    },
    release() {
      releaseInternalVoice(v);
    },
  };
}

/**
 * Acquires a pool slot in `group` for a voice of the given `priority`. Returns `null` only
 * when the group is at its cap AND `priority` does not exceed every currently-live voice's
 * priority in that group — a strictly-higher-priority acquire on a full pool always succeeds
 * by evicting the lowest-priority, oldest (by acquisition order) existing voice in the group
 * first, calling its `onEvicted` callback (if it registered one) so the builder that owns it
 * can stop its oscillators early. `null`-cap groups (currently just `loop`) never evict —
 * every acquire on them succeeds, tracked but uncapped.
 */
export function acquireVoice(
  group: VoiceGroup,
  priority: number,
  onEvicted?: () => void,
): VoiceHandle | null {
  const pool = pools[group];
  const cap = VOICE_POOL_CAPS[group];

  if (cap !== null && pool.length >= cap) {
    let victim: InternalVoice | null = null;
    for (const candidate of pool) {
      if (
        victim === null ||
        candidate.priority < victim.priority ||
        (candidate.priority === victim.priority && candidate.seq < victim.seq)
      ) {
        victim = candidate;
      }
    }
    // victim is non-null here (pool.length >= cap > 0 guarantees at least one entry).
    if (victim && priority > victim.priority) {
      evictInternalVoice(victim);
    } else {
      return null; // Not higher priority than the pool's current minimum — refused, not evicted.
    }
  }

  const voice: InternalVoice = {
    id: nextVoiceId++,
    group,
    priority,
    seq: nextSeq++,
    live: true,
    connectedNode: null,
    connectedBus: null,
    onEvicted: onEvicted ?? null,
  };
  pool.push(voice);
  return makeHandle(voice);
}

/** Live voice count, optionally scoped to one group (total across all groups otherwise). Feeds
 * the soak/battery's orphan-leak check (repeated play bursts must return to baseline) and the
 * dev debug bridge's `audioSnapshot()`. */
export function liveVoiceCount(group?: VoiceGroup): number {
  if (group) return pools[group].length;
  let total = 0;
  for (const g of Object.keys(pools) as VoiceGroup[]) total += pools[g].length;
  return total;
}

// --- context / bus graph (impure: real AudioContext/GainNode) ---------------------------------

function defaultContextFactory(): AudioContext | null {
  const AudioCtxCtor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  return AudioCtxCtor ? new AudioCtxCtor() : null; // unsupported browser — silent no-op, never a crash.
}

let contextFactory: AudioContextFactory = defaultContextFactory;

/** Test-only seam: injects a fake `AudioContextFactory` so manager.test.ts can exercise the
 * real (non-pure) context/bus/voice-connect code paths without a browser Web Audio impl. Never
 * called from production code. */
export function setAudioContextFactory(factory: AudioContextFactory): void {
  contextFactory = factory;
}

let ctx: AudioContext | null = null;
let masterGainNode: GainNode | null = null;
let sfxGainNode: GainNode | null = null;
let engineGainNode: GainNode | null = null;
let ambientGainNode: GainNode | null = null;

/** Current shared AudioContext, or `null` if it hasn't been unlocked yet this session. */
export function getAudioContext(): AudioContext | null {
  return ctx;
}

/** `AudioContextState` of the shared context, or `null` before it exists — the dev debug
 * bridge's `audioSnapshot()` surfaces this directly. */
export function getAudioContextState(): AudioContextState | null {
  return ctx?.state ?? null;
}

/** One of the three sub-bus GainNodes, or `null` before the context/graph exists. Exposed for
 * systems (like the migrated audio/sirens.ts) that manage their own bespoke voice graph
 * outside the `acquireVoice` pool model and just need a bus to connect their own master gain
 * into. */
export function getBusNode(bus: AudioBusName): GainNode | null {
  if (bus === 'sfx') return sfxGainNode;
  if (bus === 'engine') return engineGainNode;
  return ambientGainNode;
}

/** Current gain values read directly off the live nodes (0 for any bus before the context
 * exists) — introspection for the soak/battery and `audioSnapshot()`. Deliberately reads
 * `.gain.value` (the AudioParam's current computed value) rather than tracking a shadow
 * copy, so this can never drift from what's actually audible. */
export function busGains(): { master: number; sfx: number; engine: number; ambient: number } {
  return {
    master: masterGainNode?.gain.value ?? 0,
    sfx: sfxGainNode?.gain.value ?? 0,
    engine: engineGainNode?.gain.value ?? 0,
    ambient: ambientGainNode?.gain.value ?? 0,
  };
}

function applyMuteGain(instant: boolean): void {
  if (!ctx || !masterGainNode) return;
  const target = resolveMuteTarget(getGameState().settings.muted);
  if (instant) {
    masterGainNode.gain.value = target;
    return;
  }
  const now = ctx.currentTime;
  masterGainNode.gain.cancelScheduledValues(now);
  masterGainNode.gain.linearRampToValueAtTime(target, now + AUDIO_BUSES.muteRampSec);
}

function applyBusGains(instant: boolean): void {
  if (!ctx || !sfxGainNode || !engineGainNode || !ambientGainNode) return;
  const targets = resolveBusTargets(getGameState().machine);
  const nodes: readonly [GainNode, number][] = [
    [sfxGainNode, targets.sfx],
    [engineGainNode, targets.engine],
    [ambientGainNode, targets.ambient],
  ];
  if (instant) {
    for (const [node, target] of nodes) node.gain.value = target;
    return;
  }
  const now = ctx.currentTime;
  for (const [node, target] of nodes) {
    node.gain.cancelScheduledValues(now);
    node.gain.linearRampToValueAtTime(target, now + AUDIO_BUSES.busRampSec);
  }
}

/**
 * Idempotent: creates the shared AudioContext + bus graph on first call, returns the existing
 * one on every call after. Must run inside a user-gesture call stack the first time (see file
 * header) — callers don't need to check that themselves, this only ever no-ops (never throws)
 * if Web Audio is unsupported. Sets initial bus gains directly (no ramp — nothing has played
 * yet, so there's nothing for a ramp to protect against popping).
 */
export function unlockAudioContext(): AudioContext | null {
  if (ctx) return ctx;
  const created = contextFactory();
  if (!created) return null;

  ctx = created;
  masterGainNode = ctx.createGain();
  sfxGainNode = ctx.createGain();
  engineGainNode = ctx.createGain();
  ambientGainNode = ctx.createGain();

  sfxGainNode.connect(masterGainNode);
  engineGainNode.connect(masterGainNode);
  ambientGainNode.connect(masterGainNode);
  masterGainNode.connect(ctx.destination);

  applyMuteGain(true);
  applyBusGains(true);
  return ctx;
}

/** Full teardown of the shared context + bus graph. NOT called by individual systems'
 * teardowns (e.g. audio/sirens.ts must NOT close a context it doesn't own outright) — only
 * appropriate for whatever eventually owns the manager's own root mount
 * (`initAudioManager`'s returned teardown, below) tearing down the entire game. Safe to call
 * even if a context was never created. */
export function closeAudioContext(): void {
  masterGainNode?.disconnect();
  sfxGainNode?.disconnect();
  engineGainNode?.disconnect();
  ambientGainNode?.disconnect();
  masterGainNode = null;
  sfxGainNode = null;
  engineGainNode = null;
  ambientGainNode = null;
  if (ctx) {
    void ctx.close().catch(() => {
      // Already closed / unsupported in this environment — nothing more to do.
    });
    ctx = null;
  }
}

/**
 * Mounts the manager's lifecycle: unlocks the shared context on the first PLAYING entry, and
 * reacts to mute/machine-state changes by re-applying the bus/master gain targets. Mirrors
 * audio/sirens.ts's `initSirens` shape exactly (same store-subscription pattern) so a future
 * `<AudioManagerSystem/>` mount (Task "me"'s integration pass) can adopt it the same way
 * `<SirensSystem/>` already adopts `initSirens`. Idempotent with sirens' own unlock trigger —
 * `unlockAudioContext` no-ops once a context exists, so it doesn't matter which of the two
 * mounts (this one, or sirens' still-in-place trigger) fires first in any given session.
 * Returns a teardown function; unlike sirens' teardown, THIS is the one owner allowed to
 * `closeAudioContext()` (see that function's doc comment) — call it only from whatever mounts
 * the manager for the whole game's lifetime, not from a component that might unmount while
 * other audio systems are still alive.
 */
export function initAudioManager(): () => void {
  const maybeUnlock = () => {
    if (ctx) return;
    if (getGameState().machine !== 'PLAYING') return;
    unlockAudioContext();
  };

  maybeUnlock(); // covers mounting while already PLAYING (hot-reload / retry).
  applyBusGains(true); // in case the context already existed (e.g. sirens unlocked it first).

  const unsubscribe = useGameStore.subscribe((state, prev) => {
    if (state.machine !== prev.machine) {
      maybeUnlock();
      applyBusGains(false);
    }
    if (state.settings.muted !== prev.settings.muted) {
      applyMuteGain(false);
    }
  });

  return () => {
    unsubscribe();
    closeAudioContext();
  };
}

// --- registration / dispatch seam --------------------------------------------------------------

const soundRegistry = new Map<string, SoundBuilder>();

/**
 * Registers a synth builder under `name` (Task 2's job — audio/synth.ts calls this once per
 * sound at module load). Re-registering an existing name overwrites it (dev-only warning) —
 * useful for hot-reload, never expected in normal operation.
 */
export function registerSound(name: string, builder: SoundBuilder): void {
  if (import.meta.env.DEV && soundRegistry.has(name)) {
    console.warn(`[audio] registerSound("${name}") overwrote an existing registration`);
  }
  soundRegistry.set(name, builder);
}

/** True if `name` currently has a registered builder — lets Task 4's event map / debug sound
 * board check coverage without triggering playback. */
export function hasSound(name: string): boolean {
  return soundRegistry.has(name);
}

function playCtxFor(context: AudioContext): PlayCtx {
  return { ctx: context, now: context.currentTime, acquireVoice };
}

/**
 * Dispatches a registered sound by name (Task 4's job — audio/eventMap.ts calls this from its
 * gameEvents subscriptions). No-ops (dev-only console.warn) if `name` has no registered
 * builder — expected and harmless until Task 2/4 land, or for any name that's simply never
 * been given a synth. Also no-ops if the shared context is unavailable (Web Audio unsupported,
 * or no PLAYING entry has unlocked it yet) — attempts a lazy `unlockAudioContext()` first as a
 * fallback for callers reached outside sirens'/the manager's own PLAYING-entry trigger; if that
 * still yields nothing, this is a silent no-op rather than a throw, same as every other
 * defensive branch in this module.
 */
export function playEvent(name: string, params?: SoundParams): void {
  const builder = soundRegistry.get(name);
  if (!builder) {
    if (import.meta.env.DEV) console.warn(`[audio] playEvent("${name}") — no sound registered`);
    return;
  }
  const context = ctx ?? unlockAudioContext();
  if (!context) return;
  builder(playCtxFor(context), params);
}

// --- test-only reset -----------------------------------------------------------------------

/** Clears every module-scope voice pool + the shared context/bus graph (closing it for real,
 * same as `closeAudioContext`) between tests. Does NOT clear the sound registry or the
 * injected context factory — tests set those explicitly in their own setup. Mirrors
 * combat/runLoop.ts's `__resetRunLoopForTest` naming convention; never imported by app code. */
export function __resetAudioManagerForTest(): void {
  closeAudioContext();
  pools = emptyPools();
  nextVoiceId = 1;
  nextSeq = 0;
}
