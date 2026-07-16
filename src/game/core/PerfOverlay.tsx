// Dev-only r3f-perf overlay. Rendered INSIDE <Canvas> (it uses R3F hooks). Code-split the
// same way as the leva dev panel: game/index.tsx only references this module behind an
// `import.meta.env.DEV ? lazy(() => import('./core/PerfOverlay')) : null` guard, so the
// constant-false condition in production strips the dynamic import and r3f-perf never
// lands in any prod chunk.
//
// Note (see frameOrder.ts FRAME_PRIORITY): <Perf> registers a useFrame at priority
// Infinity and performs the scene's `gl.render()` itself to measure GPU time, which means
// that in dev the placeholder scene is rendered by r3f-perf rather than by R3F's
// automatic render. Production (no <Perf>) relies on R3F auto-render instead.

import { Perf } from 'r3f-perf';

export default function PerfOverlay() {
  return <Perf position="top-left" />;
}
