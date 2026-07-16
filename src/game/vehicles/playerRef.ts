// Module-scope handle to the live player vehicle model. Per-frame hot data never lives
// in the zustand store (state/store.ts rule); consumers that need the player's pose or
// speed every frame — camera rig, dev debug bridge, future pursuit AI — read through
// this ref instead. PlayerVehicle.tsx owns the lifecycle (sets on mount, nulls on
// unmount); consumers must handle `current === null` (game not in a run).

import type { IVehicleModel } from './IVehicleModel';

export const playerVehicle: { current: IVehicleModel | null } = { current: null };
