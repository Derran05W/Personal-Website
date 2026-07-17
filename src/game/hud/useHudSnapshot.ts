// Throttled, render-cheap read of the zustand store's HUD-relevant fields, for hud/Hud.tsx.
//
// Why polling instead of a plain `useGameStore(selector)` subscription: heat/score change
// every physics step during chaos (CLAUDE.md: "HUD reads store selectors; ≤10 Hz updates"),
// and a zustand selector hook re-renders React on every `set()` call that changes the
// selected value — up to 60 times/sec here. Instead, this hook samples `getGameState()` on
// a fixed 100 ms interval (same REDRAW_INTERVAL_MS precedent as hud/Minimap.tsx's canvas
// redraw) and only calls `setState` — and therefore only triggers a React re-render — when
// a sampled field actually differs from the last committed snapshot. The 100 ms tick is a
// hard architectural ceiling: this hook can drive AT MOST 10 renders/sec, and fewer
// whenever nothing HUD-relevant changed between two ticks (e.g. while paused, or driving
// with heat already at tier 0).
import { useEffect, useRef, useState } from 'react';
import { getGameState } from '../state/store';
import type { GameState } from '../state/machine';
import type { PlayerCarId } from '../config';

const SAMPLE_MS = 100; // <=10 Hz ceiling -- see file doc comment.

export interface HudSnapshot {
  readonly machine: GameState;
  readonly heat: number;
  readonly tier: number;
  readonly score: number;
  readonly playerHp: number;
  /** Phase 17: the HP silhouette needs the SELECTED car's max hp as its denominator
   * (racer 60 … streetcar 260) — hp alone can't tell "full racer" from "wounded sedan". */
  readonly selectedCarId: PlayerCarId;
  readonly seed: number;
}

function readSnapshot(): HudSnapshot {
  const s = getGameState();
  return {
    machine: s.machine,
    heat: s.heat,
    tier: s.tier,
    score: s.score,
    playerHp: s.playerHp,
    selectedCarId: s.selectedCarId,
    seed: s.seed,
  };
}

function snapshotsEqual(a: HudSnapshot, b: HudSnapshot): boolean {
  return (
    a.machine === b.machine &&
    a.heat === b.heat &&
    a.tier === b.tier &&
    a.score === b.score &&
    a.playerHp === b.playerHp &&
    a.selectedCarId === b.selectedCarId &&
    a.seed === b.seed
  );
}

// DEV-only render-rate proof (task verification requirement, not a player-facing feature):
// a running total of how many times this hook has actually driven a React re-render (i.e.
// how many of the 10/s samples found a real change). A scripted (Playwright) check reads
// this twice a known number of ms apart and asserts the delta implies <=10 renders/sec.
// Deliberately its own small DEV global rather than routed through core/debugBridge.ts —
// that module is out of scope for this task (hud/* files only).
declare global {
  interface Window {
    __smashyHudRenderCount?: number;
  }
}
if (import.meta.env.DEV) {
  window.__smashyHudRenderCount = 0;
}

export function useHudSnapshot(): HudSnapshot {
  const [snapshot, setSnapshot] = useState<HudSnapshot>(readSnapshot);
  const lastRef = useRef(snapshot);

  useEffect(() => {
    const id = window.setInterval(() => {
      const next = readSnapshot();
      if (!snapshotsEqual(lastRef.current, next)) {
        lastRef.current = next;
        setSnapshot(next);
        if (import.meta.env.DEV) {
          window.__smashyHudRenderCount = (window.__smashyHudRenderCount ?? 0) + 1;
        }
      }
    }, SAMPLE_MS);
    return () => window.clearInterval(id);
  }, []);

  return snapshot;
}
