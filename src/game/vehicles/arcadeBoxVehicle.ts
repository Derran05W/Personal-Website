// Fallback vehicle model (TDD §7 physics-bet decision gate). This is a deliberately
// unbuilt stub: it exists so the IVehicleModel seam always has a second implementation to
// swap to, but it is only fleshed out IF the M1 fun-gate session decides Rapier's raycast
// vehicle controller can't be made to feel good. The fallback plan is a plain dynamic
// cuboid steered with direct force/torque (no suspension raycasts) — simpler, floatier,
// but a known-good arcade feel. Until that gate fails, `raycastVehicle.ts` is the model
// PlayerVehicle instantiates, and calling create() here is a wiring mistake, so it throws.
//
// The methods intentionally omit their interface parameters (TS allows a narrower
// implementation signature); there is nothing to do with them until this is built.

import type { IVehicleModel, VehicleState } from './IVehicleModel';

const NOT_BUILT =
  'arcadeBoxVehicle: built only if the M1 fun gate fails (TDD §7)';

export class ArcadeBoxVehicle implements IVehicleModel {
  create(): void {
    throw new Error(NOT_BUILT);
  }

  applyInputs(): void {
    throw new Error(NOT_BUILT);
  }

  readState(): Readonly<VehicleState> {
    throw new Error(NOT_BUILT);
  }

  reset(): void {
    throw new Error(NOT_BUILT);
  }

  // Safe to call twice (IVehicleModel contract) even though nothing was ever created.
  destroy(): void {}
}

export function createArcadeBoxVehicle(): IVehicleModel {
  return new ArcadeBoxVehicle();
}
