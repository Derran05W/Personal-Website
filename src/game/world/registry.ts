// Entity registry (CLAUDE.md core pattern; TDD §6). Every physics collider that gameplay
// can interact with maps its Rapier collider HANDLE to one EntityEntry here, and ALL
// contact resolution goes through this lookup — Phase 6's contact spine drains Rapier
// events, resolves both handles via get(), and dispatches typed impact records; nothing
// else may attach gameplay meaning to a raw handle.
//
// Not an ECS: entries are plain records registered by whichever component/module owns the
// collider's lifecycle (register on create, unregister on remove — leaks here become
// misattributed contacts after handle reuse, so the pair is mandatory).
//
// Writers (current + planned): world colliders (buildings/props/ground/water/barriers,
// Phase 5), prop dynamics pool (Phase 6), civilian traffic (Phase 7), player + pursuit
// vehicles (Phases 3/9 — PlayerVehicle registers in Phase 6 when the contact spine lands),
// projectiles (Phase 11). Readers: contact spine + damage resolver (Phase 6), heat/score
// (Phase 8), powergrid (Phase 13).

import type { ArchetypeName } from './archetypes';

export type EntityKind =
  | 'player'
  | 'pursuit'
  | 'civilian'
  | 'propStatic'
  | 'propDynamic'
  | 'building'
  | 'projectile'
  | 'ground'
  | 'water'
  | 'barrier'
  | 'transformer';

export interface EntityEntry {
  readonly kind: EntityKind;
  /** Render/geometry archetype, when the entity is an instanced world object. */
  readonly archetype?: ArchetypeName;
  /** Index into the archetype's InstancedMesh (and its district-range bookkeeping). */
  readonly instanceId?: number;
  /** District the entity sits in (blackouts, heat attribution). -1 = not districted. */
  readonly districtId: number;
  /** Mutable hit points for damageable entities (transformers, cars…); undefined = indestructible. */
  hp?: number;
}

const entries = new Map<number, EntityEntry>();

/** Attach gameplay identity to a collider handle. Overwriting an existing live handle is
 * a lifecycle bug — fail loud in dev, last-write-wins in prod. */
export function registerEntity(colliderHandle: number, entry: EntityEntry): void {
  if (import.meta.env.DEV && entries.has(colliderHandle)) {
    throw new Error(`registry: handle ${colliderHandle} registered twice (missing unregister?)`);
  }
  entries.set(colliderHandle, entry);
}

export function unregisterEntity(colliderHandle: number): void {
  entries.delete(colliderHandle);
}

export function getEntity(colliderHandle: number): EntityEntry | undefined {
  return entries.get(colliderHandle);
}

/** Test/debug: current registry size (leak checks between regenerations). */
export function entityCount(): number {
  return entries.size;
}

/** Full teardown — city remount on seed change unregisters per-collider, but a hard reset
 * (route away) may tear the Physics tree down wholesale; the next city mount calls this
 * first so stale handles from a dead world can never alias new ones. */
export function clearRegistry(): void {
  entries.clear();
}
