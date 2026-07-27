// Phase 42 (flicker hunt) — THE FREEZE SEAM: one switch that stops every painted animation in
// the world, and the one clock the animations that don't go through R3F's delta must read.
//
// WHY IT EXISTS. The two-frame flicker detector nudges the camera by a sub-wu offset and counts
// the pixels that TOGGLE between the two captures. That measurement only means "rasterization
// strobe / z-fight" if literally nothing else moved between the frames: a cycling traffic-light
// lamp, a spinning Sam's disc, an occlusion fade mid-drift or a decaying explosion each toggle
// pixels too, and at sweep scale they would drown the defects the sweep is hunting. Masking those
// regions out was rejected on principle — a mask hides real defects behind it. Legit animation is
// FROZEN, not masked.
//
// HOW IT IS ONE SEAM AND NOT THIRTY. @react-three/fiber's loop computes each frame's delta exactly
// once — `let delta = state.clock.getDelta()` (verified in node_modules/@react-three/fiber/dist)
// — and hands that same number to every `useFrame` subscriber; every `state.clock.elapsedTime`
// reader shares that same THREE.Clock, and THREE's own `getElapsedTime()` is implemented as
// `this.getDelta(); return this.elapsedTime`. So wrapping ONE method on ONE object freezes every
// delta- and elapsed-driven animation in the scene at a stroke:
//
//   • while frozen the wrapper returns 0 and never calls the original, so `elapsedTime` cannot
//     advance (it is the original that accumulates it) — that is the freeze, by construction;
//   • it resyncs `clock.oldTime` to now on every frozen call, so RELEASING the freeze yields an
//     ordinary ~16 ms delta instead of a multi-second catch-up that would teleport every
//     animation (and every dt-scaled camera lerp) forward on the first live frame.
//
// Rendering keeps running while frozen — the game already paints with Rapier paused (see the PAUSE
// MODEL comment at the top of game/index.tsx) — which is exactly what a screenshot-based detector
// needs. game/index.tsx additionally composes the freeze into `<Physics paused>` (belt and
// suspenders: a zero delta already starves Rapier's accumulator, but "no stepping at all" is the
// property the harness wants to be able to state without reasoning about an accumulator).
//
// WHAT THE GOVERNOR CANNOT COVER: code that paints straight from `performance.now()`. Those
// readers — the pursuit lightbar strobe, the explosion/tracer age fades AND the feeds that stamp
// those records, the camera anti-clip ramp — call `simNowMs()` instead. Wall-clock uses that are
// NOT painted (damage cooldowns, chaos-bench/lab-drive timeouts, the quality probe, perf-cost
// measurement, the audio scheduler) deliberately stay on `performance.now()`: they measure real
// time and must keep telling the truth while a developer has the world frozen.
//
// PROD-INERT. The only writers of the freeze flag are core/debugBridge.ts and core/devPanel.tsx,
// both DEV-only modules, so in a production build `frozen` is permanently false, `simNowMs()` is
// `performance.now()` minus zero, and the governor is never installed (publishing is itself behind
// an `import.meta.env.DEV` branch in core/frameOrder.tsx). Kept React-free and dependency-free so
// the painted leaves that read it (combat/, fx/, ai/units/) can import it from anywhere; the one
// React subscription that exists — game/index.tsx's `<Physics paused>` composition — is built on
// `subscribeWorldFrozen` with `useSyncExternalStore` at the call site, exactly like
// core/devToggles.ts's `useDevToggle` but without pulling React in here.

/**
 * The surface the governor needs from R3F's clock — THREE.Clock structurally satisfies it.
 * Deliberately minimal (not `import type { Clock } from 'three'`): it keeps this module free of a
 * three import, and it lets the unit tests drive the governor with a plain object that models
 * THREE.Clock's `getDelta` arithmetic exactly.
 */
export interface GovernableClock {
  getDelta(): number;
  oldTime: number;
}

/** Clocks whose `getDelta` this module has already shadowed. A WeakSet rather than a marker
 * property: no visible mutation of a three object, and a torn-down canvas's clock is collectable.
 * The double-install guard matters because publishing happens per frame (and React StrictMode
 * double-mounts every system). */
const governed = new WeakSet<GovernableClock>();

let liveClock: GovernableClock | null = null;

let frozen = false;
/** `performance.now()` at the instant the current freeze began (meaningless while unfrozen). */
let freezeStartMs = 0;
/** Total wall-clock ms spent frozen so far this session — subtracted out of `simNowMs()`. */
let frozenTotalMs = 0;

const listeners = new Set<() => void>();

/**
 * Install the freeze governor on `clock` (idempotent). Exported for the unit tests and for the
 * publish path below; live code should call `publishSimClock` instead, which owns the ordering.
 *
 * The wrapper is assigned as an OWN property, shadowing THREE.Clock's prototype method — which is
 * also why it covers `getElapsedTime()` for free: that method calls `this.getDelta()`, and `this`
 * resolves to the instance, hence to this wrapper.
 */
export function installClockGovernor(clock: GovernableClock): void {
  if (governed.has(clock)) return;
  governed.add(clock);
  const original = clock.getDelta.bind(clock);
  clock.getDelta = function governedGetDelta(): number {
    if (!frozen) return original();
    // Frozen: hand out a zero delta and keep the clock's own "last sampled at" marker glued to
    // now. The original is never called, so elapsedTime is untouched; oldTime staying current is
    // what makes the first UNFROZEN call return one frame's worth of time rather than the whole
    // freeze duration.
    clock.oldTime = performance.now();
    return 0;
  };
}

/**
 * Publish the live R3F clock (core/frameOrder.tsx's always-mounted CameraFxSystem pass, DEV-only).
 * Called every frame — the same "cheapest possible module-ref publish" idiom as fx/cameraRef.ts's
 * `liveCamera` — and deliberately mounted on the game-lifetime system rather than on TorontoScene,
 * which is keyed per run: the handle must survive a retry/regenerate remount.
 *
 * It also closes the one ordering hole a bare ref would leave: if the world is ALREADY frozen when
 * a clock first arrives (freeze requested before the canvas existed, or a canvas rebuilt after a
 * context loss while frozen), the governor is installed immediately instead of never.
 */
export function publishSimClock(clock: GovernableClock): void {
  liveClock = clock;
  if (frozen) installClockGovernor(clock);
}

/**
 * Sim-time "now" in ms: `performance.now()` with every frozen span subtracted out. Monotonic,
 * constant while frozen, and resumes at wall-clock RATE (not wall-clock VALUE) on release.
 *
 * The subtraction is the reason ages survive a freeze: an explosion stamped 200 ms before a 30 s
 * freeze is still 200 ms old on the first frame after it, instead of instantly expired. Writers
 * and readers of a given timestamp must therefore agree on this clock — see the migration list in
 * this file's header (combat/explosion.ts ↔ fx/Explosions.tsx, ai/units/gunTruck.ts ↔
 * fx/Tracers.tsx, and the self-contained lightbar/anti-clip uses).
 */
export function simNowMs(): number {
  return (frozen ? freezeStartMs : performance.now()) - frozenTotalMs;
}

/** Whether the world is frozen right now. Read by the painted passes that must HOLD rather than
 * recompute while frozen (the occlusion retarget pass, the camera anti-clip guard). */
export function isWorldFrozen(): boolean {
  return frozen;
}

/**
 * The one write path (core/debugBridge.ts's `setFreezeWorld`, core/devPanel.tsx's Flicker folder).
 * Idempotent; notifies subscribers only on a real change.
 */
export function setWorldFrozen(value: boolean): void {
  if (value === frozen) return;
  if (value) {
    freezeStartMs = performance.now();
    frozen = true;
    if (liveClock !== null) installClockGovernor(liveClock);
  } else {
    frozenTotalMs += performance.now() - freezeStartMs;
    frozen = false;
  }
  for (const listener of Array.from(listeners)) listener();
}

/** Subscribe to freeze-flag changes. Shaped for `useSyncExternalStore` (returns the unsubscribe),
 * which is how game/index.tsx re-renders its `<Physics paused>` composition on a flip. */
export function subscribeWorldFrozen(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Drop all freeze state (flag, accumulated frozen span, published clock). Test isolation only —
 * the governor already installed on a clock stays installed, which is exactly right: it is inert
 * whenever `frozen` is false. */
export function resetSimClock(): void {
  frozen = false;
  freezeStartMs = 0;
  frozenTotalMs = 0;
  liveClock = null;
  listeners.clear();
}
