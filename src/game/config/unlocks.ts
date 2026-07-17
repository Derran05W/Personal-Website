// Phase 17 unlock thresholds (lifetime-score milestones, CLAUDE.md locked decision:
// "Unlocks: Lifetime-score milestones, generous thresholds, localStorage"). Keyed by
// PlayerCarId (config/vehicles.ts) — `satisfies Record<PlayerCarId, number>` keeps this
// table exhaustive against the six-car roster at compile time; adding a car to
// PLAYER_CARS without a matching threshold here is a type error, not a silent gap.
//
// rustySedan's threshold is 0 — the starter car is always unlocked (a fresh save's
// lifetimeScore of 0 already satisfies `>= 0`), so nothing needs to special-case it.
//
// Thresholds are the part file's starting proposal (phase-17-plan.md), tuned so a decent
// sitting lands 2-3 unlocks (P16 battery runs: ~350-400 lifetime score per ~2 min of
// tier 1-3 play) — orchestrator validates against real battery-run scores before phase
// exit; any retune from these values is recorded in the phase handoff notes.
import type { PlayerCarId } from './vehicles';

export const UNLOCKS = {
  rustySedan: 0,
  streetRacer: 500,
  pickup: 1500,
  schoolBus: 3500,
  monsterTruck: 7000,
  redRocket: 12000,
} as const satisfies Record<PlayerCarId, number>;

/**
 * Every PlayerCarId whose UNLOCKS threshold is met by `lifetimeScore`, in PLAYER_CARS'
 * declared table order (Object.keys preserves string-key insertion order, and UNLOCKS is
 * declared in the same order as PLAYER_CARS). Pure — the single implementation of the
 * threshold-crossing rule, shared by state/store.ts (hydrate + the `carUnlocked` module
 * subscription) and state/persistence.ts (recordRunEnd's before/after diff that drives
 * the `carUnlocked` event and the persisted `unlockedCarIds` field).
 */
export function unlockedCarIdsForScore(lifetimeScore: number): PlayerCarId[] {
  return (Object.keys(UNLOCKS) as PlayerCarId[]).filter((id) => lifetimeScore >= UNLOCKS[id]);
}
