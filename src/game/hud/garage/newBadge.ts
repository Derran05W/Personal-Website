// Session-scoped "NEW" badge tracking for hud/garage/Garage.tsx's car cards (Phase 17
// task brief: "garage card gets a NEW badge pulse until first selected — persist nothing
// extra for the badge — unlockedCarIds newly-crossed this session is enough, module state
// ok"). Deliberately in-memory only, module scope — a page reload naturally clears it (a
// car unlocked last session just reads as a normal unlocked card on the next visit, which
// is the accepted behavior for a session-scoped pulse, per the task brief).
//
// Subscribed at MODULE-EVALUATION time (import time) — same "listen before the first run
// can ever end" reasoning as hud/gameOverRunEnd.ts — so no `carUnlocked` (state/events.ts,
// emitted by state/persistence.ts's recordRunEnd) can ever be missed.
import { gameEvents } from '../../state/events';
import type { PlayerCarId } from '../../config/vehicles';

const newlyUnlocked = new Set<PlayerCarId>();

gameEvents.on('carUnlocked', ({ carId }) => {
  newlyUnlocked.add(carId);
});

/** True until `clearNewBadge(carId)` is called (Garage.tsx's CarCard clears it the first
 * time the player selects that car). */
export function isNewBadge(carId: PlayerCarId): boolean {
  return newlyUnlocked.has(carId);
}

export function clearNewBadge(carId: PlayerCarId): void {
  newlyUnlocked.delete(carId);
}

/** Test-only reset — mirrors hud/gameOverRunEnd.ts's __resetLastRunEndForTests. Not
 * imported by any production code path. */
export function __resetNewBadgesForTests(): void {
  newlyUnlocked.clear();
}
