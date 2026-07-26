// Module-scope handle to the live scene camera, in the exact shape of vehicles/playerRef.ts and
// world/spawn.ts's spawnPoseRef: dev tooling that lives OUTSIDE the R3F tree (core/debugBridge.ts,
// core/devPanel.tsx) has no other way to reach the one PerspectiveCamera R3F owns, and a camera
// preset has to write `fov` + updateProjectionMatrix() on the real instance to take effect.
//
// WRITER: world/toronto/TorontoScene.tsx's clip-instrumentation pass, and ONLY under
// `import.meta.env.DEV` — a production frame never touches this ref (the shipped camera needs no
// external handle; its FOV is set once at Canvas creation from CAMERA.fov). Consumers must handle
// `current === null` (no canvas mounted yet, or a production build).

import type { PerspectiveCamera } from 'three';

export const liveCamera: { current: PerspectiveCamera | null } = { current: null };
