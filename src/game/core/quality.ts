// Quality-tier detection stub (TDD §10). This is the lightweight first-load heuristic;
// the full 2-second FPS probe that can *downgrade* a struggling device is Phase 18.
//
// What actually gets applied this phase: only the DPR cap (via the <Canvas dpr> prop in
// game/index.tsx, read from QUALITY_TIERS[quality].dprCap). The other tier budgets —
// shadowMapSize, maxDynamicBodies, maxDrawCalls/Triangles, pursuitCapModifier — are
// consumed by later phases (shadows: Phase 5 lighting; body/pursuit caps: Phase 7+/12;
// draw/triangle budgets: perf gates from Phase 5 on) as those systems come online.

import { SETTINGS_STORAGE_KEY, getGameState } from '../state/store';
import type { QualityTier } from '../config';

// Coarse mobile heuristic — matches phones and small tablets so they start on the 'low'
// tier (DPR 1.5, shadows off). Kept deliberately broad; Phase 18's FPS probe is the real
// arbiter and can promote/demote from here.
const MOBILE_UA =
  /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|Tablet|Silk|Kindle/i;

/**
 * First-load quality guess from cheap, synchronous signals:
 *   1. mobile user-agent            → 'low'
 *   2. hardwareConcurrency ≤ 4      → 'med'
 *   3. otherwise                    → 'high'
 *
 * Written to survive a `navigator` that is missing (SSR-less but jsdom/test) or that
 * lacks `userAgent` / `hardwareConcurrency` — any missing signal falls through to 'high'.
 */
export function detectQualityTier(): QualityTier {
  const nav: Navigator | undefined = typeof navigator !== 'undefined' ? navigator : undefined;

  const ua = nav?.userAgent ?? '';
  if (MOBILE_UA.test(ua)) return 'low';

  const cores = nav?.hardwareConcurrency;
  if (typeof cores === 'number' && cores <= 4) return 'med';

  return 'high';
}

function hasPersistedSettings(): boolean {
  try {
    return localStorage.getItem(SETTINGS_STORAGE_KEY) !== null;
  } catch {
    // Private mode / disabled storage: treat as "no persisted choice" and detect.
    return false;
  }
}

/**
 * Applied once at game mount. A user's *persisted* quality choice always wins, so this
 * only auto-detects when the settings key is absent from localStorage. `setQuality`
 * persists the detected tier, so this runs at most once per browser (idempotent + safe
 * under React StrictMode's double-invoked mount effects).
 */
export function applyDetectedQuality(): void {
  if (hasPersistedSettings()) return;
  getGameState().setQuality(detectQualityTier());
}
