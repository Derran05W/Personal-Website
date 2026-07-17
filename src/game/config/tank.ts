// Tank shell + explosion tunables. TDD §5.6 (tank row + shell/explosion physics).
export const TANK = {
  // Flat-trajectory kinematic projectile speed (m/s). TDD §5.6.
  shellSpeed: 45,
  // Seconds between shots.
  fireCooldown: 5,
  // Telegraph before firing: barrel glow + laser dot. TDD §5.6.
  telegraphSec: 0.8,
  // Turret tracks the player at up to this yaw rate. TDD §5.6.
  turretYawDegPerSec: 60,

  // --- Shell flight (Phase 12 Task 1; combat/projectiles.ts) ---------------------------------
  // The shell is a PURE-POINT projectile (no Rapier body): a simulated point advanced by
  // shellSpeed each physics step, with a per-step sweep raycast (length = shellSpeed/60 ≈
  // 0.75 m/step) from the previous position to the new one. Detonates at the first hit along
  // that segment (incl. ground/building) — so it CANNOT tunnel through a thin obstacle however
  // fast it flies (the sweep covers the whole inter-frame span). No CCD, no kinematic body.
  shell: {
    // Concurrent shell pool cap (≤4). Two ★5 tanks on a 5 s cadence never approach this — the
    // pool is generous headroom, not a real constraint; a spawn when full recycles the oldest.
    poolSize: 4,
    // Safety lifetime (s): a shell that somehow never contacts anything (fired across the lake,
    // dead-flat over open ground) recycles silently after this. In practice a flat shot hits the
    // ground/a building/the target long before. 45 m/s × 4 s = 180 m > map, so this only ever
    // reclaims a stray — it never truncates a real shot.
    lifetimeSec: 4,
  },

  blast: {
    // Explosion sphere-query radius (m). TDD §5.6.
    radius: 8,
    // Radial impulse magnitude at center (kg·m/s ≈ "20 kN"), LINEAR falloff to 0 at the edge.
    // TDD §5.6. Applied at each dynamic body's CENTER OF MASS (no torque from this term) so the
    // player is launched but never helicopters; a small separate tumble torque (below) is
    // applied to NON-player debris/units only.
    impulse: 20_000,
    // Damage at center, linear falloff to the edge value. TDD §5.6.
    dmgCenter: 35,
    dmgEdge: 5,

    // --- launch clamps + feel (Phase 12 Task 1; NOT TDD numbers — feel-tunable) --------------
    // Per-body impulse is clamped to min(maxImpulse, maxLaunchSpeedMps × bodyMass) so a LIGHT
    // body near the center can't be flung to absurd speeds (a 30 kg dynamic prop would otherwise
    // see 20000/30 ≈ 666 m/s) and the player launch stays recoverable. The mass term caps the
    // resulting Δv; the absolute term is a hard ceiling for very heavy bodies.
    maxImpulse: 24_000,
    maxLaunchSpeedMps: 16,
    // Upward bias added to the (normalized) radial launch direction before scaling — makes
    // bodies POP and arc rather than only skid horizontally. Small so the player lands upright
    // and drives away.
    upKick: 0.35,
    // Tumble: a small capped angular impulse (N·m·s) applied to NON-player dynamic bodies only
    // (falloff-scaled, clamped to this), for debris/unit spin. The PLAYER gets zero angular from
    // the blast — the strongest form of "never helicopters".
    maxAngularImpulse: 400,
    // Force proxy (N) fed to world/propDynamics.ts's swapFromExternalHit for FIXED props inside
    // the blast (scaled by proximity falloff). Well above every PROPS.forceThresholds value so a
    // near static prop reliably swaps into the dynamic pool and launches; the swap's own
    // synthesized impulse (radial from the blast point) does the tossing. NOTE: the shared swap
    // path caps launch impulse at PROPS.launchForceCap × launchImpulseScale, so a HEAVY static
    // prop (parked car, 1200 kg) launches tumble-dominant rather than in a big linear arc —
    // an already-dynamic prop instead gets the full radial impulse via the dynamic-body path.
    propForceProxyN: 12_000,
  },
} as const;
