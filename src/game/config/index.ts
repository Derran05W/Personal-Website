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
export * from './lighting';
export * from './rendering';
export * from './audio';

import { HEAT } from './heat';
import { SPAWN, HELI } from './spawn';
import { TANK } from './tank';
import { CAMERA } from './camera';
import { WORLD, WORLD_GEN, TRAFFIC, TRAFFIC_CIV, POWER_GRID, LIGHT_POOL, PROPS, BOUNDARY, PROP_DIMS, PROP_PLACEMENT } from './world';
import { PLAYER_CARS, ENEMY_UNITS, SWAT, SQUAD, GUN_TRUCK, TANK_UNIT, VEHICLE_TUNING, AI_STEERING } from './vehicles';
import { QUALITY_TIERS } from './quality';
import { DAMAGE, BUSTED } from './damage';
import { SKID, TRACER, EXPLOSION, TANK_TELEGRAPH, SEARCHLIGHT } from './fx';
import { LIGHTING } from './lighting';
import { RENDERING } from './rendering';
import { SIRENS } from './audio';

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
  WORLD_GEN,
  TRAFFIC,
  POWER_GRID,
  LIGHT_POOL,
  PROPS,
  TRAFFIC_CIV,
  BOUNDARY,
  PROP_DIMS,
  PROP_PLACEMENT,
  PLAYER_CARS,
  VEHICLE_TUNING,
  ENEMY_UNITS,
  SWAT,
  SQUAD,
  GUN_TRUCK,
  TANK_UNIT,
  AI_STEERING,
  QUALITY_TIERS,
  DAMAGE,
  BUSTED,
  SKID,
  TRACER,
  EXPLOSION,
  TANK_TELEGRAPH,
  SEARCHLIGHT,
  LIGHTING,
  RENDERING,
  SIRENS,
} as const;
