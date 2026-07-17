// Pure formatting/derivation helpers for hud/garage/Garage.tsx. Split out for the same
// reason as hud/gameOverFormat.ts: plain-vitest unit-testable (no React/DOM), and keeps
// the component file exports-only for react-refresh's only-export-components rule.
import type { StatGrade } from '../../config/vehicles';

// Grid layout the garage's six cards render in (2 rows x 3 columns on desktop —
// Garage.css). Arrow-key navigation below assumes this column count; a narrower CSS
// breakpoint that visually re-flows to fewer columns is a minor, accepted mismatch (no
// keyboard-grid remap) — mobile-proper controls are Phase 18 scope, not this phase's.
export const GARAGE_GRID_COLUMNS = 3;

const GRADE_ORDER: readonly StatGrade[] = ['D', 'C', 'B', 'A'];

/** A/B/C/D -> a 25/50/75/100% stat-bar fill. Pure table lookup, no magic numbers inline
 * at the call site. */
export function gradeBarPercent(grade: StatGrade): number {
  const index = GRADE_ORDER.indexOf(grade);
  return ((index + 1) / GRADE_ORDER.length) * 100;
}

/** Progress toward a locked car's unlock threshold, clamped to [0, 100]. `threshold <= 0`
 * (shouldn't happen post-Phase-17 — every real threshold is positive except rustySedan,
 * which is never locked) reads as already-complete rather than dividing by zero. */
export function unlockProgressPct(lifetimeScore: number, threshold: number): number {
  if (threshold <= 0) return 100;
  return Math.max(0, Math.min(100, (lifetimeScore / threshold) * 100));
}

/**
 * Computes the next focus index for an arrow-key press over a `total`-card grid laid out
 * row-major with `columns` per row. Clamps at grid edges (no wraparound — a plain reading-
 * order grid, not a carousel). Returns `current` unchanged for any other key, or a move
 * that would leave the grid.
 */
export function nextGridIndex(current: number, key: string, total: number, columns: number): number {
  switch (key) {
    case 'ArrowRight':
      return current + 1 < total ? current + 1 : current;
    case 'ArrowLeft':
      return current - 1 >= 0 ? current - 1 : current;
    case 'ArrowDown':
      return current + columns < total ? current + columns : current;
    case 'ArrowUp':
      return current - columns >= 0 ? current - columns : current;
    default:
      return current;
  }
}
