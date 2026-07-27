// Phase 39 dev-only instrument: an A/B toggle for `polygonOffset` as an alternative/
// supplement to the ground-stack Y-ladder (config/layering.ts) for the two RUNTIME decal
// pools — skid marks (fx/SkidMarks.tsx) and explosion scorch (fx/Explosions.tsx). The ladder
// stays primary; this exists purely so core/devPanel.tsx's dev-only leva toggle can flip the
// GL polygon-offset state live and let a human judge whether it helps/hurts alongside the
// ladder, per the part-10 z-fight audit. It is NOT a shipping feature.
//
// This module itself is a plain, dependency-free ref (same "prod-shipped container, DEV-only
// writer" seam as ai/helicopter.ts's heliDebugRef) — SkidMarks.tsx/Explosions.tsx read
// `.current` only inside `if (import.meta.env.DEV)` blocks, so in a production build the
// whole read (and this import) is dead-code-eliminated and the toggle costs nothing. Kept as
// its own leaf file — deliberately NOT a new core/devToggles.ts key — so its identifier never
// has to sit inside that module's unconditionally-shipped object literal.
export const decalPolygonOffset: { current: boolean } = { current: false };
