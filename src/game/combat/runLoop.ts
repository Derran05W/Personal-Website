// Run-loop death states + full run lifecycle (Phase 9 Task 3; TDD §5.10). Owns the three
// things that end or (re)start a run:
//
//   - runStarted{seed}: emitted exactly once per run, the instant `machine` enters PLAYING
//     from GARAGE or GAMEOVER (a fresh run OR a retry — see "run start" note below). NOT
//     emitted on PAUSED->PLAYING (that's a resume, not a new run).
//   - WRECKED: playerHp<=0 (via the damage resolver's `playerDamaged`, AND a store poll —
//     see "dual detection" note below) or `enteredWater` (world/CityScape.tsx's water
//     sensor, already live since Phase 4) -> emit playerWrecked{} once, then after a lock
//     window -> PLAYING->GAMEOVER + runEnded{score, reason:'wrecked'}.
//   - BUSTED: a fixed-step rolling window (player speed < BUSTED.maxSpeed for
//     BUSTED.holdSec seconds CONTINUOUSLY, AND >= BUSTED.minPursuers pursuit units within
//     BUSTED.pursuerRadius m at every sampled step) — armed only after the run's first
//     tierChanged (i.e. tier >= 1). Trigger -> emit busted{} once, same lock-window
//     pattern -> GAMEOVER + runEnded{reason:'busted'}.
//
// --- "run start" note: GARAGE|GAMEOVER -> PLAYING, not just GARAGE -> PLAYING ---------------
// The phase-09-plan.md Task 3 brief names "GARAGE->PLAYING" specifically, but machine.ts's
// TRANSITIONS table has always allowed GAMEOVER->PLAYING too (the retry edge: score
// screen's `R` key, wired by Task 4). Both edges are genuinely "a new run beginning" —
// PAUSED->PLAYING is the only PLAYING-entering edge that ISN'T (it's a resume mid-run).
// Firing runStarted (and, critically, resetting this module's own wreckedLatched/
// pendingGameOver/bustedTracker state) on ONLY the GARAGE edge would leave a retried run's
// WRECKED latch permanently tripped from the previous run — a real bug, not a cosmetic
// gap. So `beginRun` fires on both edges; this is a deliberate generalization of the brief,
// not a literal reading of it.
//
// --- input-lock design note (see phase-09-plan.md Task 3 brief for the alternatives weighed) -
// input/keyboard.ts already zeroes AND detaches the player's driving input the instant
// `machine` leaves PLAYING (its own `useGameStore.subscribe` — see that file's
// handleStoreChange). That is the ONLY input-zeroing mechanism in the codebase, and
// input/keyboard.ts is out of this file's scope (not in the Task 3 file list). So the lock
// window implemented here does NOT actively suppress driving input while still PLAYING:
// it (a) latches the WRECKED/BUSTED trigger so it can only fire once, (b) starts a
// `lockSec` timer while `machine` stays PLAYING — physics keeps stepping and the camera
// pull-back (fx/cameraRig.ts's setDeathPullback) plays out, and (c) transitions to
// GAMEOVER once the timer elapses, which is the moment input actually zeroes (via
// input/keyboard.ts's existing subscription). In practice the drift this leaves is small:
// WRECKED means hp is already 0 (no further damage matters, and steering a dead car for
// ~1s is a minor cosmetic gap, not a gameplay exploit), and BUSTED's own trigger condition
// requires the player to already be stationary. This is a real, documented deviation from
// "true" mid-PLAYING suppression — fixing it for real would mean adding a lock-aware guard
// to input/keyboard.ts (or the vehicle controller), which is explicitly another task's
// file.
//
// --- dual WRECKED detection: event AND poll ------------------------------------------------
// combat/damage.ts's applyPlayerDamage emits `playerDamaged` on every hit, which is the
// low-latency real-gameplay path. But core/debugBridge.ts's `setPlayerHp` (the Task 3
// verification "kill path") mirrors store.setPlayerHp directly and does NOT go through the
// damage resolver, so it never emits playerDamaged. Rather than special-case the debug
// bridge, tickRunLoop() also polls `playerHp` every fixed step — a store mutation from ANY
// source (a future explosion resolver, a debug tool, whatever) can never be missed.
import { useEffect } from 'react';
import { useAfterPhysicsStep } from '@react-three/rapier';
import { gameEvents } from '../state/events';
import { getGameState, useGameStore, type GameStoreState } from '../state/store';
import { DAMAGE, BUSTED } from '../config/damage';
import { playerVehicle } from '../vehicles/playerRef';
import { unitsRef, type UnitSlot } from '../ai/pursuitTypes';
import { setDeathPullback } from '../fx/cameraRig';

// Matches <Physics timeStep={1/60}> (game/index.tsx) — same convention as
// state/heatScoreSystem.tsx's FIXED_STEP_SEC.
const FIXED_STEP_SEC = 1 / 60;

// --- pure core: BUSTED rolling window --------------------------------------------------------

export interface BustedWindowConfig {
  readonly maxSpeed: number;
  readonly holdSec: number;
  readonly minPursuers: number;
}

export interface BustedTracker {
  /** Arms the tracker (the run's first tierChanged>=1). Idempotent. */
  arm(): void;
  isArmed(): boolean;
  /**
   * Advances the rolling window by `dt` seconds given this step's sampled player speed
   * (m/s) and pursuer count within radius. The hold window is CONTINUOUS: any sampled step
   * that fails the condition resets it to 0, it does not average out. Returns `true`
   * exactly once — the step the hold completes — and `false` forever after (including
   * every step before arming) until `reset()`.
   */
  tick(speedMps: number, pursuersNear: number, dt: number): boolean;
  /** Full re-arm for a new run (also un-arms). */
  reset(): void;
}

/** Directly unit-testable rolling-window core, independent of the store/events/refs below —
 * feed it (speed, pursuersNear, dt) samples and read back the trigger edge. */
export function createBustedTracker(cfg: BustedWindowConfig): BustedTracker {
  let armed = false;
  let triggered = false;
  let underSec = 0;
  return {
    arm() {
      armed = true;
    },
    isArmed() {
      return armed;
    },
    tick(speedMps, pursuersNear, dt) {
      if (!armed || triggered) return false;
      const conditionMet = speedMps < cfg.maxSpeed && pursuersNear >= cfg.minPursuers;
      underSec = conditionMet ? underSec + dt : 0;
      if (underSec < cfg.holdSec) return false;
      triggered = true;
      return true;
    },
    reset() {
      armed = false;
      triggered = false;
      underSec = 0;
    },
  };
}

/**
 * Counts `slots` entries that are a live pursuing unit (kind non-null, state 'pursuing')
 * within `radiusM` (inclusive) of `playerPos`. Pure and directly testable with fake
 * UnitSlot[] fixtures — no live unitsRef.current required (see this file's test for the
 * "fake unitsRef slots" verification path the Task 3 brief calls for).
 */
export function countPursuersNear(
  slots: readonly UnitSlot[],
  playerPos: Readonly<{ x: number; y: number; z: number }>,
  radiusM: number,
): number {
  const radiusSq = radiusM * radiusM;
  let count = 0;
  for (const slot of slots) {
    if (slot.kind === null || slot.state !== 'pursuing') continue;
    const dx = slot.x - playerPos.x;
    const dy = slot.y - playerPos.y;
    const dz = slot.z - playerPos.z;
    if (dx * dx + dy * dy + dz * dz <= radiusSq) count++;
  }
  return count;
}

/** Pure WRECKED trigger predicate: true exactly when hp has reached 0 and this run hasn't
 * already latched a WRECKED. The caller (handleWrecked) is responsible for setting
 * `alreadyTriggered` after acting on a `true` result — this function has no side effects. */
export function shouldTriggerWrecked(alreadyTriggered: boolean, playerHp: number): boolean {
  return !alreadyTriggered && playerHp <= 0;
}

// --- run-scoped mutable state (module scope — mirrors input/keyboard.ts's pattern of a
// single live instance rather than a class; this system is a singleton like every other
// system in game/core/frameOrder.tsx) -------------------------------------------------------

let wreckedLatched = false;
interface PendingGameOver {
  reason: 'wrecked' | 'busted';
  timer: number;
}
let pendingGameOver: PendingGameOver | null = null;
let bustedTracker = createBustedTracker(BUSTED);

function beginRun(seed: number): void {
  wreckedLatched = false;
  pendingGameOver = null;
  bustedTracker.reset();
  setDeathPullback(false);
  gameEvents.emit('runStarted', { seed });
  if (import.meta.env.DEV) console.info(`[runLoop] runStarted seed=${seed}`);
}

/** Latches a WRECKED/BUSTED trigger into a pending game-over lock window. A no-op if a
 * lock is already in flight (whichever reason got there first wins — see this file's
 * header for why a stray WRECKED poll during an in-flight BUSTED lock must not hijack it). */
function startLock(reason: PendingGameOver['reason']): void {
  if (pendingGameOver) return;
  pendingGameOver = { reason, timer: 0 };
  setDeathPullback(true);
  if (reason === 'wrecked') gameEvents.emit('playerWrecked', {});
  else gameEvents.emit('busted', {});
  if (import.meta.env.DEV) console.info(`[runLoop] ${reason} triggered — lock window started`);
}

function handleWrecked(): void {
  if (wreckedLatched) return;
  wreckedLatched = true;
  startLock('wrecked');
}

function handleBusted(): void {
  startLock('busted');
}

/** Advances an in-flight lock window by one fixed step; transitions PLAYING->GAMEOVER and
 * emits runEnded once the lock elapses. `lockSec` is read from config per-reason (both
 * currently 1.2s — see config/damage.ts's DAMAGE.wreckedLockSec / BUSTED.lockSec — but are
 * independently tunable). */
function advanceLock(): void {
  if (!pendingGameOver) return;
  pendingGameOver.timer += FIXED_STEP_SEC;
  const lockSec = pendingGameOver.reason === 'wrecked' ? DAMAGE.wreckedLockSec : BUSTED.lockSec;
  if (pendingGameOver.timer < lockSec) return;

  const reason = pendingGameOver.reason;
  pendingGameOver = null;
  const state = getGameState();
  state.transition('GAMEOVER');
  gameEvents.emit('runEnded', { score: state.score, reason });
  if (import.meta.env.DEV) console.info(`[runLoop] runEnded reason=${reason} score=${state.score}`);
}

/**
 * The fixed-step tick body — exported directly (like combat/damage.ts's applyImpact) so
 * tests can drive it without a live React/Rapier tree. Order: (1) hp poll fallback for
 * WRECKED, (2) advance an in-flight lock, OR (3) sample the BUSTED window. A tick with an
 * in-flight lock never also samples BUSTED that same step (see startLock's header note).
 */
export function tickRunLoop(): void {
  const state = getGameState();
  if (state.machine !== 'PLAYING') return;

  if (shouldTriggerWrecked(wreckedLatched, state.playerHp)) handleWrecked();

  if (pendingGameOver) {
    advanceLock();
    return;
  }

  const vs = playerVehicle.current?.readState();
  const speed = vs?.speed ?? 0;
  const pursuersNear = vs
    ? countPursuersNear(unitsRef.current?.slots ?? [], vs.pose.position, BUSTED.pursuerRadius)
    : 0;
  if (bustedTracker.tick(speed, pursuersNear, FIXED_STEP_SEC)) {
    handleBusted();
  }
}

function handleMachineChange(state: GameStoreState, prevState: GameStoreState): void {
  const enteringPlaying =
    state.machine === 'PLAYING' && (prevState.machine === 'GARAGE' || prevState.machine === 'GAMEOVER');
  if (!enteringPlaying) return;
  // Retry edge: zero the run numbers + bump runId BEFORE runStarted, so the keyed world
  // remount (game/index.tsx `${seed}-${runId}` keys) and the fresh-run event agree.
  // GARAGE->PLAYING first runs skip it — the world is already pristine and a remount
  // would visibly hiccup the run start for nothing.
  if (prevState.machine === 'GAMEOVER') getGameState().runReset();
  beginRun(state.seed);
}

/**
 * Subscribes every run-loop event source. Returns a single teardown — call once at mount
 * (RunLoopSystem below) and call the returned function on unmount. Directly testable
 * (like state/heat.ts's initHeatSystem) without mounting any component.
 */
export function initRunLoopSystem(): () => void {
  const offStore = useGameStore.subscribe(handleMachineChange);

  const offPlayerDamaged = gameEvents.on('playerDamaged', ({ hp }) => {
    if (hp <= 0) handleWrecked();
  });

  const offWater = gameEvents.on('enteredWater', () => {
    handleWrecked();
  });

  const offTier = gameEvents.on('tierChanged', () => {
    bustedTracker.arm();
  });

  return () => {
    offStore();
    offPlayerDamaged();
    offWater();
    offTier();
  };
}

/** Null-rendering system component (matches core/frameOrder.tsx / combat/damage.ts's
 * DamageSystem style): mounts the event subscriptions for its lifetime and drives
 * tickRunLoop() every fixed physics step. MUST live inside <Physics> (useAfterPhysicsStep
 * reads the Rapier context) — the orchestrator mounts it alongside DamageSystem/
 * HeatScoreSystem in game/index.tsx. */
export function RunLoopSystem(): null {
  useEffect(() => initRunLoopSystem(), []);
  useAfterPhysicsStep(() => tickRunLoop());
  return null;
}

/** Test-only teardown: resets every module-scope run-loop flag (mirrors combat/contacts.ts's
 * `__resetContactsForTest` / state/heat.ts's `__resetPassiveAccumulatorForTest`). Does NOT
 * touch the store or gameEvents — callers combine this with their own store reset. */
export function __resetRunLoopForTest(): void {
  wreckedLatched = false;
  pendingGameOver = null;
  bustedTracker = createBustedTracker(BUSTED);
  setDeathPullback(false);
}
