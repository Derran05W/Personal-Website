// Main-scene render ownership flag. Dependency-free ON PURPOSE: this module is imported
// by core/frameOrder.tsx, which ships in the production game chunk, so it must never pull
// in leva / r3f-perf / any dev-only dep.
//
// Why it exists: once FRAME_PRIORITY.cameraFx > 0 (Phase 3), R3F stops auto-rendering the
// main canvas and the highest-priority useFrame owns the `gl.render()` call (see
// frameOrder.tsx). If some *other* system later claims a higher priority AND performs its
// own main-scene render (e.g. a post-processing EffectComposer in Phase 16), it must flip
// this flag on mount so CameraFxSystem stands down and exactly ONE render happens per
// frame. Nothing sets it today — see PerfOverlay.tsx for why r3f-perf is NOT such a system
// (it renders its own separate graph canvas, never this scene), so the guard currently
// always reads false and CameraFxSystem always renders (dev and prod alike).

let external = false;

/** A higher-priority system now performs the main-scene `gl.render()`; CameraFxSystem
 * must skip its own render while this is true. Pair every `true` with a `false` on
 * teardown. */
export function setExternalRenderOwner(value: boolean): void {
  external = value;
}

/** True when some other system owns the main-scene render this frame. */
export function hasExternalRenderOwner(): boolean {
  return external;
}
