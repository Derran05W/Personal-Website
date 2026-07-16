// Barrel: single import point for every game config module. `game/config/` is the
// project's sole source of truth for tunable numbers (CLAUDE.md, TDD §6).
export * from './heat';
export * from './spawn';
export * from './tank';
export * from './camera';
export * from './world';
export * from './vehicles';
export * from './collision';
export * from './quality';
export * from './damage';
export * from './fx';

import { HEAT } from './heat';
import { SPAWN, HELI } from './spawn';
import { TANK } from './tank';
import { CAMERA } from './camera';
import { WORLD, POWER_GRID, PROPS } from './world';
import { PLAYER_CARS, ENEMY_UNITS, SWAT, GUN_TRUCK, VEHICLE_TUNING } from './vehicles';
import { QUALITY_TIERS } from './quality';
import { DAMAGE, BUSTED } from './damage';
import { SKID } from './fx';

/**
 * Registry of every tunable config block, keyed by name. The dev tuning panel (leva)
 * auto-builds one folder per key from this object — add new config modules to both
 * the re-exports above and this registry.
 */
export const CONFIG = {
  HEAT,
  SPAWN,
  HELI,
  TANK,
  CAMERA,
  WORLD,
  POWER_GRID,
  PROPS,
  PLAYER_CARS,
  VEHICLE_TUNING,
  ENEMY_UNITS,
  SWAT,
  GUN_TRUCK,
  QUALITY_TIERS,
  DAMAGE,
  BUSTED,
  SKID,
} as const;
