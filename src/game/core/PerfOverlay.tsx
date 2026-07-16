// Dev-only r3f-perf overlay. Rendered INSIDE <Canvas> (it uses R3F hooks). Code-split the
// same way as the leva dev panel: game/index.tsx only references this module behind an
// `import.meta.env.DEV ? lazy(() => import('./core/PerfOverlay')) : null` guard, so the
// constant-false condition in production strips the dynamic import and r3f-perf never
// lands in any prod chunk.
//
// Render ownership (verified against r3f-perf 7.2.3 source, see frameOrder.ts
// FRAME_PRIORITY): <Perf> does NOT render THIS scene, so it deliberately does not touch
// core/renderOwner.ts. Mounted here it is PerfHeadless, which only uses
// addEffect/addAfterEffect (global pre/post-raf hooks that never bump this canvas's
// `internal.priority`) plus Scene.onBeforeRender/onAfterRender monkeypatches to time the
// GPU. Its priority-Infinity `gl.render()` is confined to a SEPARATE nested graph <Canvas>
// (HtmlMinimal → react-dom createRoot into a sibling DOM node), which renders only the
// FPS-graph scene. So CameraFxSystem is always this scene's sole renderer, dev and prod
// alike — if PerfOverlay set the external-render-owner flag, CameraFxSystem would stand
// down and dev would render nothing. That's why it must not.

import { Perf } from 'r3f-perf';

export default function PerfOverlay() {
  // Offset below the fixed 64px site header (same reason the leva panel is offset —
  // top-left would otherwise sit underneath it, unreadable).
  return <Perf position="top-left" style={{ top: 70 }} />;
}
