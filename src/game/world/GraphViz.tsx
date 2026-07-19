// Dev-only in-scene traffic-graph visualizer (Phase 4 Task 4). Renders every TrafficGraph
// edge as a single `<lineSegments>` draw call, 0.5 m above the ground so it reads clearly
// over roads without z-fighting. Lazy-imported by game/index.tsx behind
// `import.meta.env.DEV`, the same code-split pattern as core/PerfOverlay.tsx /
// core/devPanel.tsx, so this module — and the geometry-building work it does — never ships
// in a production chunk. Node markers are intentionally omitted to keep this a single draw
// call; edges alone are enough to sanity-check the traffic graph visually.
//
// Takes a `graph` prop rather than reading a world ref directly: this component lives inside
// the r3f scene tree, and a prop keeps it pure and easy to test/reason about. Phase 32 (the
// flip): narrowed from a full legacy `WorldData` prop to just the `TrafficGraph` shape it ever
// read — game/index.tsx now builds the Toronto road graph (world/toronto/roadGraph.ts) directly
// for this, since there is no more legacy `world` object to pull one off of.

import { useEffect, useMemo } from 'react';
import { BufferGeometry, Float32BufferAttribute } from 'three';
import type { TrafficGraph } from './types';

const GRAPH_VIZ_HEIGHT_M = 0.5;
const GRAPH_VIZ_COLOR = '#ff5fd1';

interface GraphVizProps {
  graph: TrafficGraph;
}

export default function GraphViz({ graph }: GraphVizProps) {
  // Rebuilds only when the `graph` object identity changes — game/index.tsx memoizes it once
  // (the Toronto road graph is seed-independent), so this effectively never rebuilds.
  const geometry = useMemo(() => {
    const { nodes, edges } = graph;
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
  }, [graph]);

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
