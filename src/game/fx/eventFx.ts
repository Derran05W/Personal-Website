// Typed-event -> particle-burst wiring (Phase 16 Task 2). Mirrors audio/eventMap.ts's
// init/dispose shape (a plain function returning a teardown, subscribed through
// state/events.ts's gameEvents — CLAUDE.md: "extend the catalog, don't bypass it"). This
// module never reaches into combat/world internals directly; it only reacts to the typed
// payloads those systems already emit.
//
// Two catalog events get a burst here:
//   - transformerDestroyed -> 'transformerSparks' (electrical arc shower at the dead
//     transformer's world position). combat/damage.ts's handleTransformerDeath always sets
//     x/y/z when the transformer's InstancedMesh instance is live this run (transformers
//     are fixed archetype instances, never swapped into the dynamic pool, so the instance
//     matrix is authoritative) — see state/events.ts's doc comment for the one case it
//     can't (the dev "blackout district" debug shortcut, which has no single transformer
//     instance to point at).
//   - propDestroyed -> 'debrisChips' (chunky tumbling debris at the prop's position).
//     world/propDynamics.ts's swap-on-launch path (hp-less props) always has a position.
//     combat/damage.ts's hp-death path (parked cars) forwards the killing blow's contact
//     point, which is OPTIONAL — combat/types.ts's ImpactRecord.point is itself optional
//     (Rapier doesn't always report one). Both handlers below skip the burst rather than
//     spawning debris at a fabricated (0,0,0) fallback when a position is missing.
//
// Every OTHER catalog event is deliberately NOT wired to a burst here: impactSparks
// (combat/hitscan.ts) and the 'explosion' preset (combat/explosion.ts) are pushed directly
// at their producer sites, which already have exact, always-defined coordinates — routing
// those through an event round-trip would be a strictly worse extra hop. propDestroyed and
// transformerDestroyed are the only two catalog events without a paired direct producer
// call, which is exactly why they're the two this module exists for.
import { gameEvents } from '../state/events';
import { pushFxBurst } from './particleFeed';

/** Registers the event -> burst wiring; returns a teardown that unsubscribes both. Call once
 * at run/mount time (the orchestrator wires this into game/index.tsx, mirroring
 * audio/eventMap.ts's initEventMap mount); safe to call again after a teardown — fresh
 * subscriptions each time, no leftover state to reset (this module holds none). */
export function initEventFx(): () => void {
  const offs: Array<() => void> = [];

  offs.push(
    gameEvents.on('transformerDestroyed', ({ x, y, z }) => {
      if (x === undefined || y === undefined || z === undefined) return;
      pushFxBurst('transformerSparks', x, y, z);
    }),
  );
  offs.push(
    gameEvents.on('propDestroyed', ({ x, y, z }) => {
      if (x === undefined || y === undefined || z === undefined) return;
      pushFxBurst('debrisChips', x, y, z);
    }),
  );

  return () => {
    for (const off of offs) off();
  };
}
