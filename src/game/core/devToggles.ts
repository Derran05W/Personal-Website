// Dev-tool visibility flags (minimap, in-scene graph-viz overlay). Dependency-free ON
// PURPOSE, mirroring core/renderOwner.ts: devPanel.tsx (which pulls in leva) writes these
// through `setDevToggle`, but the *readers* — hud/Minimap.tsx, world/GraphViz.tsx, and
// game/index.tsx (deciding whether to mount those lazy chunks at all) — must be safe to
// import from files that ship in every build. If those readers imported straight from
// devPanel.tsx instead, a static `import` of that module's exports would pull leva into
// the analysis graph of prod-shipped files too, defeating the `import.meta.env.DEV ?
// lazy(...) : null` chunking pattern those files already use. This module is that shared,
// leva-free seam.
//
// `useDevToggle` is a `useSyncExternalStore` hook so components re-render when the leva
// panel flips a toggle; `getDevToggles`/`setDevToggle` are the plain (non-React) read/write
// pair devPanel.tsx uses to seed its controls and push changes back.

import { useSyncExternalStore } from 'react';

export interface DevToggles {
  /** Dev minimap overlay (hud/Minimap.tsx). Default on — cheap, generally useful while
   * iterating on world generation. */
  minimap: boolean;
  /** In-scene traffic-graph line visualizer (world/GraphViz.tsx). Default off — only
   * wanted when specifically debugging the traffic graph. */
  graphViz: boolean;
  /** In-scene SWAT-squad flank visualizer (ai/SquadViz.tsx): posts at the two flank slots +
   * lines to their claimants. Default off — only wanted when debugging/tuning the coordinated
   * flank (Phase 10). */
  squadViz: boolean;
  /** Phase 9 Task 4 debug tool: the devPanel "Debug" folder's invincible toggle writes this
   * flag; it does NOT itself change any gameplay behavior — combat/damage.ts's
   * applyPlayerDamage() (Task 3/orchestrator-owned, not touched by this task) is the
   * consumer that must check `getDevToggles().invincible` and no-op player damage when
   * true. Handoff recorded in phase-09-notes.md. Default off. */
  invincible: boolean;
  /** Phase 11 Task 3 debug tool: in-scene LOS/aim visualizer for ★4 gun trucks
   * (ai/GunTruckAimViz.tsx) — one slot→player line per live gun truck, green when the
   * (debug-owned) LOS raycast is clear, red when a building blocks it. Same lazy +
   * toggle-gated mount pattern as `squadViz`/`graphViz`. Default off. */
  aimViz: boolean;
}

const toggles: DevToggles = {
  minimap: true,
  graphViz: false,
  squadViz: false,
  invincible: false,
  aimViz: false,
};
const listeners = new Set<() => void>();

/** The one write path — devPanel.tsx's "World" folder controls call this on change. */
export function setDevToggle<K extends keyof DevToggles>(key: K, value: DevToggles[K]): void {
  if (toggles[key] === value) return;
  toggles[key] = value;
  for (const listener of Array.from(listeners)) listener();
}

/** One-shot, non-reactive read for non-React callers (e.g. seeding a leva control's
 * initial `value`). */
export function getDevToggles(): DevToggles {
  return toggles;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reactive read: re-renders the calling component whenever `key`'s value changes. */
export function useDevToggle<K extends keyof DevToggles>(key: K): DevToggles[K] {
  return useSyncExternalStore(subscribe, () => toggles[key]);
}
