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
  blast: {
    // Explosion sphere-query radius (m). TDD §5.6.
    radius: 8,
    // Radial impulse at center (N), linear falloff to edge. TDD §5.6.
    impulse: 20_000,
    // Damage at center, linear falloff to edge. TDD §5.6.
    dmgCenter: 35,
    dmgEdge: 5,
  },
} as const;
