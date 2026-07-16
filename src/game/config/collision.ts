// Rapier collision groups. TDD §7: nine groups (PLAYER, PURSUIT, CIVILIAN,
// PROP_STATIC, PROP_DYNAMIC, BUILDING, PROJECTILE, GROUND, WATER[sensor]).
//
// Rapier packs a collider's `InteractionGroups` as a u32: (membership << 16) | filter.
// Two colliders A, B interact only if (A.membership & B.filter) !== 0 AND
// (B.membership & A.filter) !== 0 — that AND-both-ways rule is why COLLIDES_WITH below
// must be symmetric (verified in config.test.ts).

export const CollisionGroup = {
  PLAYER: 1 << 0,
  PURSUIT: 1 << 1,
  CIVILIAN: 1 << 2,
  PROP_STATIC: 1 << 3,
  PROP_DYNAMIC: 1 << 4,
  BUILDING: 1 << 5,
  PROJECTILE: 1 << 6,
  GROUND: 1 << 7,
  WATER: 1 << 8,
} as const;

export type CollisionGroupName = keyof typeof CollisionGroup;

const {
  PLAYER,
  PURSUIT,
  CIVILIAN,
  PROP_STATIC,
  PROP_DYNAMIC,
  BUILDING,
  PROJECTILE,
  GROUND,
  WATER,
} = CollisionGroup;

const VEHICLES = PLAYER | PURSUIT | CIVILIAN;
const PROPS = PROP_STATIC | PROP_DYNAMIC;

// What each group's colliders interact with. TDD §7 rules:
export const COLLIDES_WITH: Record<CollisionGroupName, number> = {
  // Vehicles collide with each other, both prop kinds, buildings, projectiles,
  // ground, and water (water is a sensor that only senses vehicles).
  PLAYER: VEHICLES | PROPS | BUILDING | PROJECTILE | GROUND | WATER,
  PURSUIT: VEHICLES | PROPS | BUILDING | PROJECTILE | GROUND | WATER,
  CIVILIAN: VEHICLES | PROPS | BUILDING | PROJECTILE | GROUND | WATER,
  // Props collide with vehicles, each other, buildings, projectiles, ground. Not water.
  PROP_STATIC: VEHICLES | PROPS | BUILDING | PROJECTILE | GROUND,
  PROP_DYNAMIC: VEHICLES | PROPS | BUILDING | PROJECTILE | GROUND,
  // Buildings are fixed: vehicles, props, and projectiles only. building<->ground and
  // building<->building are both static-static and irrelevant, so excluded.
  BUILDING: VEHICLES | PROPS | PROJECTILE,
  // Projectiles hit everything except other projectiles and water.
  PROJECTILE: VEHICLES | PROPS | BUILDING | GROUND,
  // Ground supports vehicles and both prop kinds, and stops projectiles. Not buildings
  // (both static, irrelevant) and not water.
  GROUND: VEHICLES | PROPS | PROJECTILE,
  // Water is a sensor that senses vehicles only — instant WRECKED on entry (TDD §5.4).
  WATER: VEHICLES,
};

/**
 * Packs a group's membership + filter into Rapier's InteractionGroups u32:
 * high 16 bits = membership (what this collider identifies as), low 16 bits = filter
 * (what it's allowed to interact with).
 */
export function interactionGroups(group: CollisionGroupName): number {
  const membership = CollisionGroup[group];
  const filter = COLLIDES_WITH[group];
  return (membership << 16) | filter;
}
