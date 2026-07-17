// Barrel: single import point for the Phase 19 Toronto landmark mounts. The orchestrator
// wires these three as standalone siblings inside the same <Physics> tree world/CityScape.tsx
// already mounts (see each component's own file header for the "why standalone" rationale) —
// e.g. `<CnTower world={world} /><Stadium world={world} /><Flatiron world={world} />`, fed the
// SAME `world: WorldData` CityScape receives. Each renders null until
// world.landmarks is populated (Task 1's generator seam), so mounting them unconditionally is
// always safe.
export { CnTower, type CnTowerProps } from './CnTower';
export { Stadium, type StadiumProps } from './Stadium';
export { Flatiron, type FlatironProps } from './Flatiron';
