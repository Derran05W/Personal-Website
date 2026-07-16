// Dev-only in-scene traffic-graph visualizer (Phase 4 Task 4). Renders every TrafficGraph
// edge as a single `<lineSegments>` draw call, 0.5 m above the ground so it reads clearly
// over roads without z-fighting. Lazy-imported by game/index.tsx behind
// `import.meta.env.DEV`, the same code-split pattern as core/PerfOverlay.tsx /
// core/devPanel.tsx, so this module — and the geometry-building work it does — never ships
// in a production chunk. Node markers are intentionally omitted to keep this a single draw
// call; edges alone are enough to sanity-check the traffic graph visually.
//
// Takes `world` as a prop rather than reading world/worldRef.ts directly: this component
// lives inside the r3f scene tree, where the city root (world/CityScape.tsx) already has
// the current WorldData as a real, reactive value — a prop keeps this component pure and
// easy to test/reason about, and avoids a second, ref-based source of truth inside the
// scene (worldRef.ts stays reserved for DOM-layer tooling like hud/Minimap.tsx that has no
// other way to reach into the scene).

import { useEffect, useMemo } from 'react';
import { BufferGeometry, Float32BufferAttribute } from 'three';
import type { WorldData } from './types';

const GRAPH_VIZ_HEIGHT_M = 0.5;
const GRAPH_VIZ_COLOR = '#ff5fd1';

interface GraphVizProps {
  world: WorldData;
}

export default function GraphViz({ world }: GraphVizProps) {
  // Rebuilds only when the `world` object identity changes — the city root remounts its
  // whole subtree on regenerate (`key={seed}`, Task 3), so a fresh `world` reference always
  // means a fresh graph; no need to track a narrower dependency than the object itself.
  const geometry = useMemo(() => {
    const { nodes, edges } = world.graph;
    // Looked up by id (not array index) — TrafficNode ids aren't type-guaranteed to equal
    // their array position.
    const nodeById = new Map(nodes.map((node) => [node.id, node]));

    const positions: number[] = [];
    for (const edge of edges) {
      const from = nodeById.get(edge.from);
      const to = nodeById.get(edge.to);
      // Defensive: the generator is expected to always emit valid ids (test-proven
      // upstream in world/trafficGraph.test.ts), but a debug visualizer must not crash the
      // scene on a malformed edge — skip it instead of pushing a degenerate segment.
      if (!from || !to) continue;
      positions.push(from.x, GRAPH_VIZ_HEIGHT_M, from.z, to.x, GRAPH_VIZ_HEIGHT_M, to.z);
    }

    const geom = new BufferGeometry();
    geom.setAttribute('position', new Float32BufferAttribute(positions, 3));
    return geom;
  }, [world]);

  // BufferGeometry built imperatively (not via JSX) isn't guaranteed to be disposed by
  // R3F's own prop-teardown path — dispose explicitly on unmount and whenever `geometry`
  // is rebuilt (the cleanup below runs before the *next* effect too, not just on unmount).
  useEffect(() => {
    return () => geometry.dispose();
  }, [geometry]);

  return (
    <lineSegments geometry={geometry}>
      <lineBasicMaterial color={GRAPH_VIZ_COLOR} />
    </lineSegments>
  );
}
