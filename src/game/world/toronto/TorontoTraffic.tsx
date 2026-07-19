// Phase 29 (D3) — the thin Toronto civilian-traffic adapter. Mounts the EXISTING civilian traffic
// system (ai/TrafficMount.tsx's `Traffic`) on the Toronto road graph without dragging the legacy
// tile world in: `Traffic` consumes only a TrafficGraph (nodes/edges/outEdges) + a seed + the
// contact source, so we hand it world/toronto/roadGraph.ts's TrafficGraph (drop-in shape-compatible,
// verified — ai/traffic never reads tileIndex) and the same combat/contacts onImpact spine the
// legacy branch uses. Roster is the tier-scaled Toronto count (config/torontoTraffic.ts, 32/24/16),
// captured ONCE at mount and passed as the controller's activeTarget override.
//
// Rendering is the pack-model batched mesh (cityPack/TorontoTrafficMesh.tsx) instead of the legacy
// single-sedan InstancedMesh; both read the same trafficRef slots. Mounted keyed on worldKey by
// game/index.tsx so a regenerate/retry/toggle fully rebuilds the pool + the graph.

import { useMemo, useState } from 'react';
import { Traffic } from '../../ai/TrafficMount';
import { onImpact } from '../../combat/contacts';
import { torontoTrafficRoster } from '../../config/torontoTraffic';
import { useGameStore } from '../../state/store';
import { useDevToggle } from '../../core/devToggles';
import { buildStreets } from './streets';
import { buildTorontoRoadGraph } from './roadGraph';
import { TorontoTrafficMesh } from './cityPack/TorontoTrafficMesh';

export function TorontoTraffic() {
  const seed = useGameStore((s) => s.seed);
  const unlit = useDevToggle('cityPackUnlit');

  // The Toronto road graph is seed-independent (pure function of the street table), built once per
  // mount. Shape-compatible with the legacy TrafficGraph the civilian system already consumes.
  const graph = useMemo(() => buildTorontoRoadGraph(buildStreets().streets), []);

  // Tier-scaled roster, mount-captured (the "next run, at mount" precedent every other Toronto
  // tier param follows — a mid-run quality change applies on the next keyed remount, not live).
  const [roster] = useState(() => torontoTrafficRoster(useGameStore.getState().settings.quality));

  return (
    <>
      <Traffic graph={graph} seed={seed} source={onImpact} activeTarget={roster} />
      <TorontoTrafficMesh capacity={roster} seed={seed} unlit={unlit} />
    </>
  );
}
