// Combat-layer contracts (Phase 6 seam, orchestrator-authored). The contact spine
// (combat/contacts.ts) produces ImpactRecords; the damage resolver (combat/damage.ts) and
// the fixed→dynamic prop swap (world/propDynamics.ts) consume them. Everything gameplay
// learns about a collision flows through this shape — nothing else may interpret raw
// Rapier events.

import type { EntityEntry } from '../world/registry';

/** One resolved contact-force event between two colliders, registry identities attached.
 * `a`/`b` are undefined when a handle has no registry entry (e.g. a stray sensor) — the
 * spine still dispatches so consumers can decide; most filter those out. */
export interface ImpactRecord {
  readonly aHandle: number;
  readonly bHandle: number;
  readonly a: EntityEntry | undefined;
  readonly b: EntityEntry | undefined;
  /** Rapier's total contact force magnitude for this pair this step (N). */
  readonly forceMag: number;
  /** World-space largest-force contact point, when Rapier provides one. */
  readonly point?: { x: number; y: number; z: number };
}

export type ImpactHandler = (impact: ImpactRecord) => void;
