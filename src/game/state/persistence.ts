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
    Number.isFinite(candidate.lifetimeScore)
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
  };
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
