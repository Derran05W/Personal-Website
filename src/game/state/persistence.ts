// Versioned localStorage envelope for cross-run meta-progression (best/lifetime score).
// TDD §12 (persistence table: bestScore, lifetimeScore) + CLAUDE.md locked decision
// ("Backend: None — static site, localStorage only"). Mirrors state/store.ts's settings
// persistence idiom exactly: both localStorage calls are try/catch-wrapped (private/
// incognito browsing and storage-quota exhaustion can make localStorage throw on read
// *or* write), and every failure degrades silently to in-memory defaults rather than
// ever becoming a hard failure — losing a high score must never crash a run.
//
// `lifetimeScore` is the Phase 17 unlock currency (CLAUDE.md: "Unlocks: Lifetime-score
// milestones, generous thresholds, localStorage") — every run's final score is folded in
// here permanently on `runEnded`, regardless of how the run ended (wrecked/busted/quit).
// `bestScore` is a single best-run high score (max, not sum). Phase 17 reads both via
// `loadProgress()`; nothing else in this module should be treated as its API surface.

import { gameEvents } from './events';

// Same `smashy6ix:` prefix as store.ts's SETTINGS_STORAGE_KEY — one namespace, one key
// per concern.
export const PROGRESS_STORAGE_KEY = 'smashy6ix:progress';

/** Current envelope schema version. A stored envelope whose `v` doesn't match this is
 * treated identically to "missing/corrupt" (see `isValidProgress`) — bump this and add an
 * explicit migration branch in `loadProgress` if the shape ever needs to change instead. */
const PROGRESS_VERSION = 1;

export interface Progress {
  v: typeof PROGRESS_VERSION;
  bestScore: number;
  lifetimeScore: number;
  /**
   * Phase 13 addition: true once the player has ever triggered DARK CITY (powergrid/
   * grid.ts — all 16 districts dark in a single run). Phase 17's garage reads this as an
   * unlock badge.
   *
   * OPTIONAL and added WITHOUT bumping PROGRESS_VERSION (still 1) — this is the
   * version-safe extension path: `isValidProgress` below only ever REQUIRED the three
   * original fields, so a stored envelope written before this field existed (or one
   * where DARK CITY simply hasn't happened yet) is missing the key entirely, which reads
   * back as `undefined`. Every reader treats `undefined` identically to `false` ("not
   * unlocked") — there is no separate migration branch, and DEFAULT_PROGRESS deliberately
   * does NOT set this key (see below), so `loadProgress()` on a fresh envelope still
   * round-trips to exactly `{ v, bestScore, lifetimeScore }` with no extra key, keeping
   * every pre-Phase-13 equality-based test unchanged. A real schema-incompatible change
   * (removing/retyping an existing field) still requires bumping PROGRESS_VERSION and an
   * explicit migration branch here — this is only safe because the new field is
   * additive and optional.
   */
  darkCityUnlocked?: boolean;
}

const DEFAULT_PROGRESS: Progress = { v: PROGRESS_VERSION, bestScore: 0, lifetimeScore: 0 };

function isValidProgress(value: unknown): value is Progress {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.v === PROGRESS_VERSION &&
    typeof candidate.bestScore === 'number' &&
    Number.isFinite(candidate.bestScore) &&
    typeof candidate.lifetimeScore === 'number' &&
    Number.isFinite(candidate.lifetimeScore) &&
    // Absent is valid (older/pre-Phase-13 envelopes, or one that's never unlocked it) —
    // only a PRESENT-but-wrong-typed value is rejected.
    (candidate.darkCityUnlocked === undefined || typeof candidate.darkCityUnlocked === 'boolean')
  );
}

/**
 * Reads the persisted envelope. Missing key, unparseable JSON, wrong/older shape, or a
 * localStorage read throw (private-mode browsers) all degrade to `DEFAULT_PROGRESS` —
 * this never throws.
 */
export function loadProgress(): Progress {
  try {
    const raw = localStorage.getItem(PROGRESS_STORAGE_KEY);
    if (!raw) return DEFAULT_PROGRESS;
    const parsed: unknown = JSON.parse(raw);
    return isValidProgress(parsed) ? parsed : DEFAULT_PROGRESS;
  } catch {
    return DEFAULT_PROGRESS;
  }
}

function saveProgress(progress: Progress): void {
  try {
    localStorage.setItem(PROGRESS_STORAGE_KEY, JSON.stringify(progress));
  } catch {
    // Swallow: quota exhaustion / private-mode write throw — progress simply won't
    // persist this session (same idiom as store.ts's saveSettings).
  }
}

/**
 * Folds one run's final score into the persisted envelope — `bestScore` becomes
 * `max(current, score)`, `lifetimeScore` accumulates (`+= score`) — and writes the result
 * through to localStorage. Read-modify-write in one call; returns the resulting envelope
 * so callers (and tests) can observe it even if the write itself silently failed.
 */
export function recordRunEnd(score: number): Progress {
  const current = loadProgress();
  const next: Progress = {
    v: PROGRESS_VERSION,
    bestScore: Math.max(current.bestScore, score),
    lifetimeScore: current.lifetimeScore + score,
    // Carry the badge forward explicitly. Without this, a run that triggers DARK CITY
    // mid-run (powergrid/grid.ts calls setDarkCityUnlocked() the instant the 16th
    // district goes dark, independent of runEnded) would have its badge silently erased
    // the moment THIS run's own runEnded fires and rebuilds the envelope from scratch —
    // only include the key at all when it was already set, so an envelope that never
    // unlocked it keeps round-tripping with no extra key (see the Progress interface's
    // doc comment on DEFAULT_PROGRESS).
    ...(current.darkCityUnlocked !== undefined ? { darkCityUnlocked: current.darkCityUnlocked } : {}),
  };
  saveProgress(next);
  return next;
}

/**
 * Marks the DARK CITY badge unlocked (powergrid/grid.ts calls this the instant all 16
 * districts go dark in a run — see that module's `handleTransformerDestroyed`) and
 * writes it through immediately, independent of `recordRunEnd`/`runEnded` — so the badge
 * survives even if the tab closes mid-run before a runEnded ever fires. Read-modify-write
 * over the current envelope (same idiom as `recordRunEnd`): `bestScore`/`lifetimeScore`
 * pass through untouched. Idempotent — a repeat call, or DARK CITY happening again in a
 * later run, does not re-write once already `true` (and returns the unmodified envelope
 * rather than a needless localStorage write). Degrade-silent on a write failure, same as
 * every other write in this module.
 */
export function setDarkCityUnlocked(): Progress {
  const current = loadProgress();
  if (current.darkCityUnlocked === true) return current;
  const next: Progress = { ...current, darkCityUnlocked: true };
  saveProgress(next);
  return next;
}

/**
 * Dev-only: clears the persisted envelope (devPanel "reset progress" button). A
 * subsequent `loadProgress()` returns `DEFAULT_PROGRESS`. Degrade-silent, same as
 * load/save.
 */
export function resetProgress(): void {
  try {
    localStorage.removeItem(PROGRESS_STORAGE_KEY);
  } catch {
    // Swallow — same degrade-silent idiom as load/save.
  }
}

/**
 * Subscribes `recordRunEnd` to the `runEnded` event (state/events.ts) — the single write
 * trigger for score persistence, per the project's typed-emitter convention ("systems
 * stay decoupled", CLAUDE.md). Call once, at game mount (the orchestrator wires this —
 * e.g. from game/index.tsx or a system's mount effect); returns an unsubscribe function
 * for teardown symmetry with every other subscription in this codebase.
 */
export function initProgressPersistence(): () => void {
  return gameEvents.on('runEnded', ({ score }) => {
    recordRunEnd(score);
  });
}
