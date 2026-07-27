// Phase 42 dev-only instrument: the flicker detector's sub-wu camera nudge, in the exact shape of
// fx/decalPolygonOffsetRef.ts (a plain, dependency-free "prod-shipped container, DEV-only writer"
// ref — see that file's doc comment for why an own leaf file beats a core/devToggles.ts key).
//
// The detector captures two frames of a FROZEN world (core/simClock.ts) that differ only in where
// the camera's rasterization grid falls, then counts the pixels that toggle. This ref is that
// offset, in world units, on the ground plane. fx/cameraRig.ts applies it as a PURE TRANSLATION —
// the same offset is added to the eye AND to the look target, so the view DIRECTION is bit-identical
// across the pair and nothing but sub-pixel sampling changes. Any rotation would re-project the
// whole frame and every edge in it would "toggle", which measures nothing.
//
// Written by core/debugBridge.ts's `setCameraJitter` (and the devPanel "Flicker (P42)" folder);
// {0, 0} is the shipped/at-rest value, so a production build — where nothing can write it, and the
// rig's read is inside an `import.meta.env.DEV` branch — is unaffected. This is an instrument, not
// a shipping feature.
export const cameraJitter: { x: number; z: number } = { x: 0, z: 0 };
