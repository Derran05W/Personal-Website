// Phase 42 — the freeze seam's contract (core/simClock.ts's header has the full mechanism).
//
// The three properties the flicker detector's totality gate rests on:
//   1. frozen sim time does not advance (so every age-driven FX holds mid-fade);
//   2. a frozen clock hands R3F a ZERO delta (so every delta/elapsed-driven animation holds) and
//      NEVER a multi-second catch-up on release (which would teleport all of them forward at once);
//   3. installing the governor twice — publishing runs per frame, and React StrictMode double-
//      mounts every system — is a no-op.
//
// The governor is exercised against BOTH a hand-rolled clock (which lets a test place `oldTime`
// wherever it likes, so "5 seconds of frozen wall time" is expressible without waiting 5 seconds)
// and the REAL three Clock class R3F actually constructs, so the shadowing trick is proven against
// the object it ships against, not only against a stand-in. (three 0.185 prints a deprecation
// warning when a Clock is constructed — expected noise, not a failure; R3F 9.6.1 still uses it.)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Clock } from 'three';
import {
  installClockGovernor,
  isWorldFrozen,
  publishSimClock,
  resetSimClock,
  setWorldFrozen,
  simNowMs,
  subscribeWorldFrozen,
  type GovernableClock,
} from './simClock';

/** A THREE.Clock stand-in with the same `getDelta` arithmetic (diff = now − oldTime, in seconds,
 * accumulated into elapsedTime), plus a call counter so a test can prove the original ran (or
 * didn't) and that a double install didn't chain two wrappers. */
function makeFakeClock(): GovernableClock & { elapsedTime: number; calls: number } {
  return {
    oldTime: performance.now(),
    elapsedTime: 0,
    calls: 0,
    getDelta(): number {
      this.calls += 1;
      const now = performance.now();
      const diff = (now - this.oldTime) / 1000;
      this.oldTime = now;
      this.elapsedTime += diff;
      return diff;
    },
  };
}

/** Busy-wait a real millisecond span. The governor and simNowMs both read `performance.now()`
 * directly (deliberately — they measure real time), so fake timers would not move them; the spans
 * used here are single-digit ms. */
function busyWait(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    /* spin */
  }
}

beforeEach(() => {
  resetSimClock();
});

afterEach(() => {
  resetSimClock();
});

describe('simNowMs — wall clock minus frozen spans', () => {
  it('tracks performance.now() while unfrozen', () => {
    expect(simNowMs()).toBeCloseTo(performance.now(), 0);
  });

  it('does not advance while frozen, however long the freeze lasts', () => {
    setWorldFrozen(true);
    const first = simNowMs();
    busyWait(5);
    expect(simNowMs()).toBe(first);
    busyWait(5);
    expect(simNowMs()).toBe(first);
  });

  it('resumes at wall-clock RATE after release, without replaying the frozen span', () => {
    const beforeFreeze = simNowMs();
    setWorldFrozen(true);
    busyWait(20);
    setWorldFrozen(false);

    // The whole point: the freeze is subtracted out, so an FX record stamped just before the
    // freeze is still ~0 ms old just after it (rather than 20 ms+ older and possibly expired).
    const afterRelease = simNowMs();
    expect(afterRelease - beforeFreeze).toBeLessThan(10);

    // ...and time moves again, at real speed.
    busyWait(6);
    expect(simNowMs() - afterRelease).toBeGreaterThanOrEqual(5);
  });

  it('is monotonic across a freeze/unfreeze cycle', () => {
    const a = simNowMs();
    setWorldFrozen(true);
    const b = simNowMs();
    busyWait(3);
    setWorldFrozen(false);
    const c = simNowMs();
    expect(b).toBeGreaterThanOrEqual(a);
    expect(c).toBeGreaterThanOrEqual(b);
  });
});

describe('isWorldFrozen / setWorldFrozen / subscribeWorldFrozen', () => {
  it('defaults to unfrozen (the production state — nothing there can write it)', () => {
    expect(isWorldFrozen()).toBe(false);
  });

  it('notifies subscribers on real changes only, and stops after unsubscribe', () => {
    const listener = vi.fn();
    const off = subscribeWorldFrozen(listener);

    setWorldFrozen(true);
    expect(listener).toHaveBeenCalledTimes(1);
    setWorldFrozen(true); // idempotent — no change, no notification
    expect(listener).toHaveBeenCalledTimes(1);
    setWorldFrozen(false);
    expect(listener).toHaveBeenCalledTimes(2);

    off();
    setWorldFrozen(true);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('clock governor', () => {
  it('passes the real delta through while unfrozen', () => {
    const clock = makeFakeClock();
    installClockGovernor(clock);
    busyWait(3);
    const delta = clock.getDelta();
    expect(clock.calls).toBe(1); // the original ran
    expect(delta).toBeGreaterThan(0);
  });

  it('returns 0 without running the original while frozen (elapsedTime cannot advance)', () => {
    const clock = makeFakeClock();
    installClockGovernor(clock);
    clock.getDelta(); // one live frame
    const elapsedAtFreeze = clock.elapsedTime;
    const callsAtFreeze = clock.calls;

    setWorldFrozen(true);
    busyWait(4);
    expect(clock.getDelta()).toBe(0);
    busyWait(4);
    expect(clock.getDelta()).toBe(0);
    expect(clock.elapsedTime).toBe(elapsedAtFreeze);
    expect(clock.calls).toBe(callsAtFreeze); // the original never ran while frozen
  });

  it('hands out a SMALL delta on the first unfrozen call — no multi-second catch-up', () => {
    const clock = makeFakeClock();
    installClockGovernor(clock);
    setWorldFrozen(true);

    // Stand in for a long freeze: rewind oldTime by 5 s, exactly as a 5-second frozen capture
    // sequence would leave it if nothing resynced. The frozen call must resync it anyway.
    clock.oldTime = performance.now() - 5000;
    expect(clock.getDelta()).toBe(0);

    setWorldFrozen(false);
    const firstLive = clock.getDelta();
    expect(firstLive).toBeLessThan(0.1); // one frame's worth, not five seconds
  });

  it('CONTROL: without the governor the same rewind DOES produce the giant delta', () => {
    const clock = makeFakeClock();
    clock.oldTime = performance.now() - 5000;
    expect(clock.getDelta()).toBeGreaterThan(4.9);
  });

  it('is idempotent — a second install does not chain a second wrapper (StrictMode/per-frame publish)', () => {
    const clock = makeFakeClock();
    installClockGovernor(clock);
    const wrapper = clock.getDelta;
    installClockGovernor(clock);
    expect(clock.getDelta).toBe(wrapper);

    busyWait(2);
    clock.getDelta();
    expect(clock.calls).toBe(1); // exactly one original call per getDelta(), not two
  });

  it('wraps the REAL three Clock, covering getElapsedTime() through the same instance property', () => {
    const clock = new Clock();
    clock.getDelta(); // autoStart kick
    installClockGovernor(clock);
    busyWait(3);
    clock.getDelta();
    const elapsedAtFreeze = clock.elapsedTime;

    setWorldFrozen(true);
    busyWait(4);
    expect(clock.getDelta()).toBe(0);
    // getElapsedTime() is `this.getDelta(); return this.elapsedTime` — the own-property wrapper
    // shadows the prototype method, so it is covered for free.
    expect(clock.getElapsedTime()).toBe(elapsedAtFreeze);

    setWorldFrozen(false);
    expect(clock.getDelta()).toBeLessThan(0.1);
  });
});

describe('publishSimClock', () => {
  it('installs the governor immediately when the world is ALREADY frozen (ordering hole)', () => {
    // Freeze first, publish second: the canvas can arrive after the freeze (freeze requested from
    // a script before the world mounted, or a canvas rebuilt after a context loss while frozen).
    setWorldFrozen(true);
    const clock = makeFakeClock();
    publishSimClock(clock);
    expect(clock.getDelta()).toBe(0);
  });

  it('installs on the next freeze when published while unfrozen (the normal path)', () => {
    const clock = makeFakeClock();
    publishSimClock(clock);
    expect(clock.getDelta()).toBeGreaterThanOrEqual(0); // live: passes through

    setWorldFrozen(true);
    expect(clock.getDelta()).toBe(0);
  });
});
