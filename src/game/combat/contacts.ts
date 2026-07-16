// Contact spine (Phase 6 Task 1; CLAUDE.md frame order + entity-registry pattern, TDD §7).
// THE load-bearing collision plumbing: every gameplay reaction to a physical impact — the
// fixed→dynamic prop swap (world/propDynamics.ts), the damage resolver (combat/damage.ts),
// and everything Phases 8–12 layer on (heat, score, unit HP, explosions) — subscribes here
// via onImpact() and receives typed ImpactRecords. Nothing else may read a raw Rapier
// contact event or attach gameplay meaning to a bare collider handle; this module is the one
// place Rapier's event shape is translated into the registry-resolved ImpactRecord the rest
// of the game speaks.
//
// --- Event mechanism (source-verified against @react-three/rapier 2.2.0) -------------------
// The obvious design — "drain the contact-force queue ourselves in useAfterPhysicsStep" —
// is NOT possible in this library version, and attempting it would be a bug:
//
//   • <Physics> owns a single private `EventQueue` (useConst(() => new EventQueue(false)))
//     and steps the world with IT: `world.step(eventQueue, hooks)` inside its fixed-timestep
//     loop. That queue is NOT exposed on the rapier context (useRapier() surfaces world,
//     rapier, before/afterStepCallbacks, … but never the eventQueue), so we cannot drain it.
//   • Creating our OWN EventQueue and calling `world.step(ourQueue)` a second time would
//     double-integrate the world — a hard correctness bug, not an option.
//   • The library already drains its queue every frame, itself: after the step loop it calls
//     `eventQueue.drainContactForceEvents(...)` ONCE per frame (EventQueue(false) accumulates
//     events across every fixed sub-step of a hitch and drains them all together, so nothing
//     is silently dropped — the part-file "drain every step or events vanish" hazard is
//     handled inside the library). It routes each drained event to the per-RigidBody /
//     per-Collider `onContactForce` callbacks registered through <RigidBody>/<Collider> props.
//
// So the sanctioned path in this version is a per-body callback. Phase 6 only needs
// PLAYER-involved impacts (props go dynamic when the player hits them; damage lands when the
// player hits a transformer/car), so we attach exactly ONE onContactForce — to the player's
// RigidBody (PlayerVehicle.tsx) — and funnel it into dispatchContactForce() below. Rapier
// emits a contact-force event for a pair when EITHER collider has CONTACT_FORCE_EVENTS set
// (the library sets that flag automatically on the player's collider because its RigidBody
// carries onContactForce — verified in useColliderEvents), so this single callback captures
// every player↔{building,prop,vehicle,…} impact without touching the other ~3,750 colliders.
//
// Later phases that need non-player impacts (projectile↔unit in Phase 11, unit↔unit) attach
// their OWN onContactForce to those bodies and call the SAME dispatchContactForce() — the
// mechanism stays entirely behind this module; onImpact() is the only consumer surface, and
// no subscriber ever learns which body's callback produced a record.
//
// Policy-free by contract: no force threshold, no kind filtering, no dedup happens here — the
// spine reports every resolved contact-force event faithfully and lets each subscriber decide
// (propDynamics thresholds per archetype, damage scales by relative speed, etc.).

import type { ContactForcePayload } from '@react-three/rapier';
import { getEntity } from '../world/registry';
import type { ImpactHandler, ImpactRecord } from './types';

// Module-scope subscriber set (mirrors state/events.ts's single-channel style). Handlers run
// synchronously during the library's per-frame contact-force drain, i.e. immediately after
// the fixed physics step and before the late-useFrame camera/FX/render pass — exactly the
// "drain → resolvers → FX → render" ordering the canonical frame order (TDD §6) prescribes.
const handlers = new Set<ImpactHandler>();

/** Subscribe to every resolved impact. Returns an unsubscribe fn (call on teardown). The
 * damage resolver and prop-dynamics swap are the Phase-6 subscribers; HUD/heat/score join in
 * later phases. Registration order is not significant — the spine is policy-free, so no
 * subscriber may depend on running before/after another. */
export function onImpact(handler: ImpactHandler): () => void {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

// DEV-only cumulative impact counter — a zero-cost diagnostic for scripted verification
// (surfaced via core/debugBridge.ts's window.__smashy). The increment is guarded by
// import.meta.env.DEV so esbuild folds it away entirely in production builds.
let impactCount = 0;

/** DEV diagnostic: total ImpactRecords dispatched since load (0 in production). */
export function getImpactCount(): number {
  return impactCount;
}

/**
 * Core dispatch (mechanism-agnostic, hence directly unit-testable without any Rapier types):
 * resolve both collider handles to their registry identities, assemble the ImpactRecord, and
 * notify every subscriber. `a`/`b` are left undefined when a handle has no registry entry
 * (e.g. the ground, or a not-yet-registered collider) — per ImpactRecord's contract the
 * record is STILL dispatched so consumers can decide; the spine never filters.
 *
 * A throwing subscriber is isolated (logged, not rethrown) so one buggy resolver can't stop
 * the others — the same guarantee state/events.ts gives its independent observers.
 */
export function dispatchImpact(
  aHandle: number,
  bHandle: number,
  forceMag: number,
  point?: { x: number; y: number; z: number },
): void {
  const record: ImpactRecord = {
    aHandle,
    bHandle,
    a: getEntity(aHandle),
    b: getEntity(bHandle),
    forceMag,
    ...(point ? { point } : {}),
  };
  if (import.meta.env.DEV) impactCount++;
  // Copy before iterating: a subscriber unsubscribing itself (or another) mid-dispatch must
  // not mutate the Set out from under this loop.
  for (const handler of Array.from(handlers)) {
    try {
      handler(record);
    } catch (error) {
      console.error('[contacts] impact handler threw:', error);
    }
  }
}

/**
 * Adapter from @react-three/rapier's onContactForce payload → the core dispatch. The player's
 * RigidBody wires `onContactForce={dispatchContactForce}` (PlayerVehicle.tsx) — that is the
 * whole mechanism, kept here rather than in the component so no gameplay logic lives in the
 * view layer. `payload.target` is always the body whose callback fired (the player, since
 * only it carries onContactForce); `payload.other` is the struck collider. Rapier's
 * ContactForceEvent exposes no contact point, so `point` is intentionally omitted (the
 * ImpactRecord field is optional precisely for this "when Rapier provides one" case).
 */
export function dispatchContactForce(payload: ContactForcePayload): void {
  dispatchImpact(
    payload.target.collider.handle,
    payload.other.collider.handle,
    payload.totalForceMagnitude,
  );
}

/** Test-only teardown: drop all subscribers and reset the DEV counter so each test starts
 * from a clean spine (module state is a singleton, like state/events.ts). */
export function __resetContactsForTest(): void {
  handlers.clear();
  impactCount = 0;
}
