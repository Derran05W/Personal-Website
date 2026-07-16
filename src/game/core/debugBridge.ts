// Dev-only window bridge: scripted (Playwright) verification of driving feel needs an
// objective speed/pose readout and a way to force state transitions without simulating
// real gameplay input. Loaded exclusively via the `import.meta.env.DEV` dynamic-import
// branch in game/index.tsx — never a static import — so, like devPanel.tsx and
// PerfOverlay.tsx, this module is dead-code-eliminated out of production chunks.
import { getGameState } from '../state/store';
import { canTransition, type GameState } from '../state/machine';
import { playerVehicle } from '../vehicles/playerRef';
import { spawnPoseRef } from '../world/spawn';
import type { VehiclePose, VehicleState } from '../vehicles/IVehicleModel';

declare global {
  interface Window {
    __smashy?: {
      /** Current game state machine value. */
      getMachine: () => GameState;
      /** Guarded transition — a no-op if `to` isn't a valid edge from the current state. */
      transition: (to: GameState) => void;
      /** Player vehicle's current readState(), or null if no run is live. */
      readState: () => Readonly<VehicleState> | null;
      /** Teleports the player vehicle to `pose` (default: spawn, identity yaw). No-op
       * if no run is live. */
      reset: (pose?: VehiclePose) => void;
    };
  }
}

window.__smashy = {
  getMachine: () => getGameState().machine,
  transition: (to) => {
    const state = getGameState();
    if (canTransition(state.machine, to)) state.transition(to);
  },
  readState: () => playerVehicle.current?.readState() ?? null,
  reset: (pose) => playerVehicle.current?.reset(pose ?? spawnPoseRef.current),
};
