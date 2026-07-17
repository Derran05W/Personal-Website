// Tank-shell system mount (Phase 12 Task 1). The R3F seam that gives the pure-logic shell pool
// (combat/projectiles.ts) a live Rapier world and pins its stepping into the frame order:
//   • useBeforePhysicsStep → advance every in-flight shell one step (sweep + detonate), so a
//     detonation's impulses are applied BEFORE Rapier integrates and take effect the same step.
//   • useAfterPhysicsStep → drain the DEV finite-pose checks queued by any blast this step, now
//     that the integrated poses exist (a bad impulse surfaces as a logged NaN, not silently).
// It also publishes projectilesRef (combat/projectiles.ts) for the tank unit (Task 2, fires via
// spawn), the FX layer (Task 3, reads getShellPositions), and the dev bridge (blastAt). Mounted
// inside <Physics> (needs useRapier + the step hooks), keyed on the world like the other systems.
//
// Null-rendering — this is a system, not a visual. Shell + explosion visuals are Task 3.

import { useEffect, useMemo } from 'react';
import { useAfterPhysicsStep, useBeforePhysicsStep, useRapier } from '@react-three/rapier';
import { detonate, drainExplosionFiniteChecks } from './explosion';
import { ShellPool, makeWorldSweep, projectilesRef, type ProjectilesApi } from './projectiles';

const PHYSICS_DT = 1 / 60;

export function ProjectilesMount(): null {
  const { world, rapier } = useRapier();

  const pool = useMemo(
    () =>
      new ShellPool({
        sweep: makeWorldSweep(world, rapier),
        detonate: (x, y, z) => detonate({ world, rapier }, { x, y, z }),
      }),
    [world, rapier],
  );

  useEffect(() => {
    const api: ProjectilesApi = {
      spawn: (firer, origin, dir) => pool.spawn(firer, origin, dir),
      activeCount: () => pool.activeCount(),
      getShellPositions: () => pool.getShellPositions(),
      blastAt: (x, y, z) => detonate({ world, rapier }, { x, y, z }),
    };
    projectilesRef.current = api;
    return () => {
      if (projectilesRef.current === api) projectilesRef.current = null;
      pool.clear();
    };
  }, [pool, world, rapier]);

  useBeforePhysicsStep(() => pool.step(PHYSICS_DT));
  useAfterPhysicsStep(() => drainExplosionFiniteChecks());

  return null;
}
