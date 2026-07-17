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
// projectiles (Phase 11), streetcar traffic (Phase 19, ai/streetcarTraffic.ts — a sibling of
// civilian traffic, see EntityEntry.isStreetcar below). Readers: contact spine + damage
// resolver (Phase 6), heat/score (Phase 8), powergrid (Phase 13).

import type { ArchetypeName } from './archetypes';
// Type-only import of the ai-owned pursuit-unit-kind seam (erased at compile time — no
// runtime world→ai coupling; mirrors config/spawn.ts's own type-only import of the same
// type). See EntityEntry.unitKind below for why the registry needs it.
import type { UnitKind } from '../ai/pursuitTypes';

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
  /** Phase 10 seam extension: which pursuit-unit kind this entry is, set by unit factories
   * (ai/units/*) at registerEntity time for every `kind: 'pursuit'` entry. Lets
   * combat/damage.ts's massFactorOf() and ram-damage-multiplier path key off ENEMY_UNITS
   * directly instead of falling back to the generic archetype-mass table (pursuit units
   * aren't instanced archetypes, so they had no mass signal before this field existed).
   * undefined for every non-pursuit entry, and always undefined for entities that predate
   * this field. */
  readonly unitKind?: UnitKind;
  /** Phase 19 seam: true for a civilian entry that is specifically a STREETCAR (heavy avenue
   * traffic, ai/streetcarTraffic.ts) rather than a regular car (ai/traffic.ts) — both register
   * `kind: 'civilian'` with no `archetype` (see traffic.ts's header for why civilians carry
   * none), so this is the marker that lets block-ray/registry/debug consumers tell them apart
   * without a new EntityKind. Mirrors the unitKind seam above (a sub-kind flag alongside a
   * shared coarse `kind`). Always undefined for a regular civilian entry or any entity that
   * predates this field. NOT read by combat/damage.ts's massFactorOf() — a streetcar entry
   * still falls through to the same factor-1 "civilian units — not modeled yet" default every
   * other civilian gets (see that file's own doc comment); this field is deliberately NOT
   * wired into the damage formula, only into identification. */
  readonly isStreetcar?: boolean;
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
