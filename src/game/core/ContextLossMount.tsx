// R3F wiring shim for context-loss handling (Phase 18 Task 3). All the actual listener /
// transition logic lives in ./contextLoss.ts as a pure `(canvas) -> cleanup` function —
// this component's only job is handing it the real `<canvas>` DOM element from R3F's own
// context. Mount once anywhere inside <Canvas> (it doesn't need the Rapier/<Physics> tree,
// just R3F's `gl`), same "Mount" naming/shape as the other system-mount components
// (PropDynamicsMount, LightPoolMount, ...) game/index.tsx already wires up.
import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import { attachContextLossListeners } from './contextLoss';

export function ContextLossSystem() {
  // Read through the R3F store getter (matches world/BlueHourRig.tsx's convention) rather
  // than a tracked `s.gl` selector — `gl.domElement` is a genuinely stable, mutable three/
  // DOM object R3F expects consumers to reach into directly, not something the React
  // Compiler should treat as reactive state.
  const get = useThree((state) => state.get);

  useEffect(() => {
    const { gl } = get();
    return attachContextLossListeners(gl.domElement);
  }, [get]);

  return null;
}
