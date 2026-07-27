// Phase 43 dev-only instrument: an off-rig camera pose override for landmark-evidence shots
// (silhouette/marketing screenshots) that the fixed §5.3 rig cannot frame by construction — the
// Phase 38 camera-debt sweep's verdict that wayfinding/skyline/crown vantages are geometrically
// impossible under rig E. Same "prod-shipped container, DEV-only writer" leaf shape as
// fx/cameraJitterRef.ts (see that file's doc comment for why an own leaf beats a core/
// devToggles.ts key), but the payload is a FULL pose rather than a sub-wu nudge.
//
// Written by core/debugBridge.ts's `setDevCamPose`; read by fx/cameraRig.ts's updateCameraRig,
// which — unlike the jitter ref — must gate the read itself behind `import.meta.env.DEV` rather
// than relying on an at-rest value being a no-op: `null` IS the at-rest value, but applying a
// non-null pose is fully behavioral (it replaces the frame's camera write outright), so a stray
// write reaching this ref in a production build would be visible. The rig's own lerp/spring state
// keeps computing normally every frame regardless of this ref; only the FINAL camera.position/
// camera.lookAt (and, optionally, camera.fov) write is replaced while a pose is set, so clearing
// the ref back to `null` snaps cleanly back to whatever the live rig is doing that frame.
export interface DevCamPose {
  /** Eye position, world units. */
  readonly ex: number;
  readonly ey: number;
  readonly ez: number;
  /** Look-at target, world units. */
  readonly tx: number;
  readonly ty: number;
  readonly tz: number;
  /** Optional FOV override (degrees). Omitted = leave camera.fov as the rig left it. */
  readonly fov?: number;
}

/** `null` = no override (shipped rig framing, unaffected). Set by the DEV-only debug bridge. */
export const devCamPoseRef: { pose: DevCamPose | null } = { pose: null };
