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
  /** Phase 13 Task 4 debug tool: pooled dynamic-light position viz. Rendered as small dots
   * on hud/Minimap.tsx rather than an in-scene marker set — chosen over a 3D marker set as
   * the cheaper/clearer option (no extra scene objects/materials, reuses the minimap's
   * already-cheap 10 Hz 2D canvas redraw; see core/debugBridge.ts's getLightPoolPositions
   * doc comment for the data source, a stub returning [] until powergrid/lightPool.ts
   * (Task 3, concurrent this wave) lands). Default off. */
  lightPoolViz: boolean;
  /** Phase 22 dev tool: swap the 64×64 legacy world for the drivable Toronto "thermometer"
   * dev slice (world/toronto/TorontoScene.tsx). game/index.tsx reads this, joins it to the
   * world remount key, and renders TorontoScene instead of the legacy world subtree when set.
   * Default off — the legacy world is byte-identical when off (additive conditional only). A
   * dev-only seam; the real WORLD_SOURCE switch replaces it at the Phase 23 parity flip. */
  torontoMap: boolean;
  /** Phase 25.5 dev tool: mount the city-pack proof-of-render cluster
   * (world/toronto/cityPack/CityPackPreview.tsx) near the Toronto spawn. TorontoScene reads this
   * and conditionally mounts the cluster. Default off — TorontoScene is byte-identical when off
   * (additive conditional only). Meaningful only with `torontoMap` on. */
  cityPackPreview: boolean;
  /** Phase 25.5 (D8) A/B material arm for the city-pack: true → unlit-literal (MeshBasicMaterial
   * + baked palette map, toneMapped=false); false → the GLBs' real lit materials under
   * BlueHourRig. Default ON (the P23/25.5 unlit verdict). Drives BOTH the 25.5 preview AND (25.6)
   * the whole re-dressed city (frontage/furniture/parked). */
  cityPackUnlit: boolean;
  /** Phase 25.6 layer toggles (default ON within the Toronto branch) for perf triage + A/B
   * screenshots. Each gates one re-dress layer live without a world remount: frontage pack
   * buildings + backdrop towers, street furniture rows, parked vehicles, and the traffic-light
   * lamp cycling overlay. Meaningful only with `torontoMap` on. */
  packBuildings: boolean;
  packFurniture: boolean;
  packParked: boolean;
  packLightCycling: boolean;
  /** Phase 25.7 layer toggle (default ON within the Toronto branch): the business-personalization
   * dressing (fascia bands + awnings + kit props + queues + Alo plaque) on the claimed venue
   * facades (world/toronto/cityPack/VenueDressLayer.tsx). Toggle off ≈ the 25.6 city minus the
   * venue boxes (the venue facades themselves are just claimed frontage slots and stay). Meaningful
   * only with `torontoMap` on. */
  venueDress: boolean;
  /** Phase 28 layer toggle (default ON within the Toronto branch): the whole "Infill" pass —
   * corner fill (frontage.ts), back-lot second row, laneway clutter, parking lots, construction
   * sites, and lane closures (world/toronto/infill.ts). Toggle off ≈ the Phase 25.6-27 city minus
   * every Phase 28 addition (frontage/furniture/venue layers untouched). Meaningful only with
   * `torontoMap` on. */
  packInfill: boolean;
}

const toggles: DevToggles = {
  minimap: true,
  graphViz: false,
  squadViz: false,
  invincible: false,
  aimViz: false,
  lightPoolViz: false,
  torontoMap: false,
  cityPackPreview: false,
  cityPackUnlit: true,
  packBuildings: true,
  packFurniture: true,
  packParked: true,
  packLightCycling: true,
  venueDress: true,
  packInfill: true,
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
