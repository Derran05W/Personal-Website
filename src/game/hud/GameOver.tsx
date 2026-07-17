// GAMEOVER screen (Phase 9 Task 4). Rendered unconditionally by game/index.tsx — same
// "owns its own visibility" contract as hud/Hud.tsx (null outside machine === 'GAMEOVER')
// and GarageOverlay.tsx (null outside 'GARAGE'). NOT wired into game/index.tsx by this
// task (see task brief's "do NOT touch game/index.tsx" ground rule) — the orchestrator
// mounts <GameOver /> as a sibling of <Hud />, same layer, same lifetime.
//
// Reason tracking (WRECKED vs BUSTED banner): reads the last `runEnded` payload through
// ./gameOverRunEnd.ts's module-scope subscription (split into its own file so this
// component file stays component-exports-only — see that module's doc comment for the full
// "why module-scope, not a component effect" reasoning around event/transition ordering).
//
// Retry / garage keys: input/keyboard.ts already binds R -> PLAYING and G -> GARAGE (plus
// M -> mute) while machine === 'GAMEOVER' (verified against that file — Phase 2's keymap).
// This component adds NO key listeners of its own — a second listener would double-handle
// the same physical keypress. It is deliberately keyboard-first / click-free (unlike
// GarageOverlay.tsx's full-bleed start button): every control this screen needs already
// works the instant it renders, and — unlike the garage's "first interaction of the whole
// session" button, which also exists to satisfy autoplay-gesture requirements — nothing
// here needs a click to unlock anything. `pointerEvents: 'none'` throughout, matching
// hud/Hud.tsx's belt-and-suspenders reasoning: the site header must never be occludable by
// this overlay regardless of stacking context.
import { useSyncExternalStore, type CSSProperties } from 'react';
import { loadProgress } from '../state/persistence';
import { useHudSnapshot } from './useHudSnapshot';
import { formatScore, filledStarCount } from './hudFormat';
import { bannerForReason, nextUnlockInfo } from './gameOverFormat';
import { subscribeRunEnd, getLastRunEnd } from './gameOverRunEnd';
import { subscribeRunUnlocks, getRunUnlockNames } from './gameOverUnlocks';
import './GameOver.css';

const backdropBaseStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  pointerEvents: 'none',
  // Above Hud (z-index 20 — moot, Hud self-hides once machine leaves PLAYING/PAUSED) and
  // GarageOverlay (z-index auto/0 — moot, GARAGE and GAMEOVER are mutually exclusive
  // states). Below the dev-only overlays that must always win legibility (Minimap z-40,
  // Leva's own high default), same ordering rationale as Hud.tsx's rootStyle.
  zIndex: 25,
};

const chipStyle: CSSProperties = {
  background: 'rgba(10, 14, 22, 0.55)',
  borderRadius: 8,
  padding: '0.35rem 0.9rem',
};

const panelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: '0.65rem',
  textAlign: 'center',
  color: '#f5f5f5',
  padding: '2rem',
};

const bannerStyle: CSSProperties = {
  display: 'block',
  margin: 0,
  fontFamily: 'var(--font-display)',
  fontWeight: 700,
  fontSize: 'clamp(2.5rem, 8vw, 5rem)',
  letterSpacing: '0.04em',
  textShadow: '0 4px 24px rgba(0, 0, 0, 0.65)',
};

const scoreStyle: CSSProperties = {
  display: 'block',
  fontFamily: 'var(--font-display)',
  fontWeight: 700,
  fontSize: 'clamp(1.75rem, 4vw, 2.75rem)',
  letterSpacing: '0.02em',
};

const lineStyle: CSSProperties = {
  display: 'block',
  fontSize: '0.9rem',
  color: 'rgba(245, 245, 245, 0.85)',
};

const hintStyle: CSSProperties = {
  display: 'block',
  fontSize: '0.85rem',
  color: 'rgba(245, 245, 245, 0.75)',
  marginTop: '0.35rem',
};

// Phase 17: "UNLOCKED: <name>" toast — amber-tinted (the site's --color-accent language)
// so it reads as a distinct, celebratory event rather than another plain info chip.
const unlockToastStyle: CSSProperties = {
  display: 'block',
  background: 'rgba(245, 158, 11, 0.18)',
  border: '1px solid rgba(245, 158, 11, 0.5)',
  borderRadius: 8,
  padding: '0.4rem 0.9rem',
  fontWeight: 700,
  fontSize: '0.95rem',
  color: '#fbbf24',
  textShadow: '0 1px 8px rgba(0, 0, 0, 0.5)',
};

export default function GameOver() {
  const runEnd = useSyncExternalStore(subscribeRunEnd, getLastRunEnd);
  // Phase 17: cars unlocked THIS run (hud/gameOverUnlocks.ts's module-scope queue, reset
  // on runStarted / appended on carUnlocked — see that file for why it can't simply key
  // off runEnded directly).
  const unlockNames = useSyncExternalStore(subscribeRunUnlocks, getRunUnlockNames);
  // Reuses the HUD's own throttled (<=10 Hz) store poll rather than a fresh subscription —
  // one polling contract for every DOM overlay that reads machine/tier/score/seed, per
  // hud/useHudSnapshot.ts's doc comment on why raw zustand selectors are the wrong tool
  // here. Net effect: this screen can lag up to ~100ms behind the real PLAYING -> GAMEOVER
  // transition, which is negligible against Task 3's 1.2s control-lock/pull-back that
  // precedes it.
  const { machine, tier, seed, score: liveScore } = useHudSnapshot();

  if (machine !== 'GAMEOVER') return null;

  // Debug-transition fallback (window.__smashy.transition('GAMEOVER') with no accompanying
  // runEnded — this task's verification path): score falls back to the live (frozen, since
  // heat/score accrual pauses the instant machine leaves PLAYING) store value, and
  // bannerForReason(undefined) already degrades to WRECKED.
  const score = runEnd?.score ?? liveScore;
  const { label, variant } = bannerForReason(runEnd?.reason);
  // Read AFTER runEnded: this module's own listener above is registered at import time
  // (before any run can end), and state/persistence.ts's initProgressPersistence() listener
  // (game/index.tsx mount effect) is registered before the game can ever reach PLAYING —
  // both are guaranteed to have already run by the time a real runEnded fires and this
  // screen subsequently mounts, so `progress` below already reflects the run that just
  // ended (including any newly-crossed unlock thresholds — the same timing guarantee
  // covers `nextUnlock`, not just `best`).
  const progress = loadProgress();
  const best = progress.bestScore;
  const nextUnlock = nextUnlockInfo(progress.lifetimeScore);

  return (
    <div
      className={`gameover-backdrop gameover-backdrop--${variant}`}
      style={backdropBaseStyle}
      data-testid="gameover-root"
    >
      <div style={panelStyle}>
        <span style={bannerStyle} data-testid="gameover-banner">
          {label}
        </span>
        {unlockNames.length > 0 ? (
          <span style={unlockToastStyle} data-testid="gameover-unlock-toast">
            {unlockNames.map((name) => `UNLOCKED: ${name}`).join(' · ')}
          </span>
        ) : null}
        <span style={{ ...chipStyle, ...scoreStyle }} data-testid="gameover-score">
          {formatScore(score)}
        </span>
        <span style={{ ...chipStyle, ...lineStyle }} data-testid="gameover-best">
          Best {formatScore(best)}
        </span>
        <span style={{ ...chipStyle, ...lineStyle }} data-testid="gameover-tier">
          {filledStarCount(tier) > 0 ? '★'.repeat(filledStarCount(tier)) : '—'} tier reached
        </span>
        <span style={{ ...chipStyle, ...lineStyle }} data-testid="gameover-seed">
          Seed {seed}
        </span>
        <span style={{ ...chipStyle, ...lineStyle, opacity: 0.75 }} data-testid="gameover-unlocks">
          {nextUnlock
            ? `${formatScore(nextUnlock.remaining)} pts to unlock ${nextUnlock.carName}`
            : 'All cars unlocked'}
        </span>
        <span style={{ ...chipStyle, ...hintStyle }} data-testid="gameover-controls">
          R — retry same city · G — garage
        </span>
      </div>
    </div>
  );
}
