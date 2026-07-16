// Module-scope handle to the live generated world. Mirrors vehicles/playerRef.ts's pattern:
// per-frame/whole-object hot data that debug tooling needs to read outside React's props
// tree doesn't belong in the zustand store (state/store.ts's rule), so it lives here
// instead. Set by the city root (world/CityScape.tsx, Task 3) once `generate(seed)`
// resolves for the current run — expected to be reassigned wholesale on every regenerate
// (new seed ⇒ new WorldData object ⇒ new reference), never mutated in place. Read by the
// dev minimap (hud/Minimap.tsx) and other debug tooling. Consumers must handle
// `current === null` (no world generated yet, or between regenerations).

import type { WorldData } from './types';

export const worldRef: { current: WorldData | null } = { current: null };
