// Phase 16 damage-visual-state tunables (fx/damageStates.ts): tint brackets, smoke/fire
// attach thresholds, wrecked treatment. TDD §5.10 "visual damage states" — replaces the
// Phase-16-seam stub (tint brackets + wrecked-column config landed with the real system,
// Phase 16 Task 3).
export const DAMAGE_VISUALS = {
  // --- Tint brackets --------------------------------------------------------------------
  // Progressively darken a vehicle's body colour as HP is lost (TDD §5.10: "25/50/75% HP
  // lost"). STEPPED, not a continuous lerp — damage reads as three discrete stages (light/
  // heavy/critical) rather than a smooth gradient, matching the TDD's named percentages.
  // Sorted ascending by `atLost`; a lost-fraction below the first bracket stays untinted.
  // Each `mix` is how far fx/damageStates.ts's tintDamageColor() blends the base colour
  // toward `charredColor` (0 = untouched, 1 = fully charred) — pure math, unit-tested.
  tintBrackets: [
    { atLost: 0.25, mix: 0.28 },
    { atLost: 0.5, mix: 0.55 },
    { atLost: 0.75, mix: 0.82 },
  ],
  // The charred tone every fleet mesh's wrecked-state tint already multiplies toward
  // (formerly a duplicated local `WRECK_CHAR`/`WRECK_CHAR_TINT` hex literal in
  // TrafficMesh/PoliceMesh/ArmoredMesh/SwatMesh/GunTruckMesh/TankMesh — centralized here,
  // CLAUDE.md's "single source of truth" rule, once every one of those files started
  // consuming fx/damageStates.ts anyway). A fully-wrecked vehicle (bracket mix effectively
  // 1) and the dedicated wrecked-state tint land on the exact same colour — no visible pop
  // between "critical" and "wrecked". Hex string, so the leva auto-schema builder
  // (core/devPanel.tsx's buildBlockSchema, which only surfaces number/boolean leaves) skips
  // it — tune in code.
  charredColor: '#2a2622',

  // --- Emitter attach thresholds (fx/particleFeed.ts's 'damageSmoke' / 'fire' presets) ---
  // HP-lost fraction at which a persistent damage-smoke emitter attaches.
  smokeAtLost: 0.5,
  // HP-lost fraction at which a fire emitter attaches (the smoke emitter keeps running too).
  fireAtLost: 0.75,
  // Vertical offset (m) above a vehicle's pose origin the smoke/fire/wreck-column emitters
  // attach at — a single flat "roughly hood/engine height" constant shared across the whole
  // fleet (sedan through tank) rather than a per-archetype table: this is a cosmetic FX
  // anchor, not a hitbox, and the fleet's height range is small enough that one offset reads
  // fine everywhere.
  emitterHeightOffset: 0.5,

  // --- Wrecked lingering smoke column -----------------------------------------------------
  // The instant a tracked vehicle wrecks (fx/damageStates.ts), its graduated smoke/fire
  // emitters are released in favour of ONE dedicated 'damageSmoke' column, kept alive this
  // long (or until the wreck itself despawns/recycles, whichever comes first — see
  // DamageStatesMount's per-entity tracking). Comfortably shorter than a civilian wreck's
  // own despawn window (TRAFFIC_CIV.wreckLingerSec = 12s) so the column never outlives the
  // wreck it's attached to.
  wreckSmokeLifetimeSec: 8,

  // Poll cadence (Hz) for fx/DamageStatesMount.tsx: cheap enough to run every frame, but hp-
  // driven tint/emitter state reads fine at this granularity (bracket crossings and smoke/
  // fire attach/detach are not a frame-critical signal), and it keeps the whole-roster walk
  // (player + every civilian + every pursuit slot) off the hot per-frame path.
  pollHz: 5,
} as const;
