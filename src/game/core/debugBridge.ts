// Dev-only window bridge: scripted (Playwright) verification of driving feel needs an
// objective speed/pose readout and a way to force state transitions without simulating
// real gameplay input. Loaded exclusively via the `import.meta.env.DEV` dynamic-import
// branch in game/index.tsx — never a static import — so, like devPanel.tsx and
// PerfOverlay.tsx, this module is dead-code-eliminated out of production chunks.
import { Color } from 'three';
import { getPerf as getR3fPerfState } from 'r3f-perf';
import { getGameState } from '../state/store';
import { canTransition, type GameState } from '../state/machine';
import { playerVehicle } from '../vehicles/playerRef';
import { spawnPoseRef } from '../world/spawn';
import type { VehiclePose, VehicleState } from '../vehicles/IVehicleModel';
import { ARCHETYPES, EMISSIVE_ARCHETYPES } from '../world/archetypes';
import { setDistrictColor, setDistrictEmissive as setDistrictEmissiveRange } from '../world/instancing';
import { getImpactCount, onImpact } from '../combat/contacts';

// Phase 6 contact-spine verification: a small ring buffer of the most recent dispatched
// ImpactRecords, resolved to the registry identities the spine attached. The contact-force
// drain writes nothing to the DOM/canvas a screenshot could scrape, so — like readState/
// readPerf — a scripted check reads impacts through this bridge instead of watching pixels.
// DEV-only (this whole module is dynamically imported only under import.meta.env.DEV).
interface ImpactSample {
  readonly aKind: string | undefined;
  readonly aArchetype: string | undefined;
  readonly bKind: string | undefined;
  readonly bArchetype: string | undefined;
  readonly forceMag: number;
}
const RECENT_IMPACTS_CAP = 16;
const recentImpacts: ImpactSample[] = [];
onImpact((impact) => {
  recentImpacts.push({
    aKind: impact.a?.kind,
    aArchetype: impact.a?.archetype,
    bKind: impact.b?.kind,
    bArchetype: impact.b?.archetype,
    forceMag: impact.forceMag,
  });
  if (recentImpacts.length > RECENT_IMPACTS_CAP) recentImpacts.shift();
});

// Task 5 debug-tint colour — same value the devPanel "tint district (red)" button uses, so
// a screenshot script driving this bridge headlessly reproduces exactly what the leva
// button does.
const TINT_COLOR = new Color('#ff2222');

/** Task 5 perf snapshot for the screenshot suite. The PerfOverlay draws these numbers to a
 * canvas (not DOM text), so a screenshot script can't scrape them from the page — this
 * reads the SAME r3f-perf zustand store PerfOverlay renders from instead. `gl.info.render`
 * is last-frame draw calls/triangles (reset every frame, autoReset disabled by r3f-perf's
 * PerfHeadless — see its source); `log.fps` is r3f-perf's own smoothed reading. All fields
 * are null until PerfOverlay has mounted and rendered at least one frame. */
export interface PerfSnapshot {
  readonly calls: number | null;
  readonly triangles: number | null;
  readonly fps: number | null;
}

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
      /** Task 5 district-range proof, headless mirror of the devPanel "tint district
       * (red)" button: recolours district `n`'s [start,count] slice red across every
       * archetype in ARCHETYPES. No-op for archetypes not built this run. */
      tintDistrict: (n: number) => void;
      /** Task 5 district-range proof, headless mirror of the devPanel "blackout
       * district"/"relight district" buttons: flips district `n`'s aEmissiveOn slice
       * across every EMISSIVE_ARCHETYPES archetype (0 = dark, 1 = lit). */
      setDistrictEmissive: (n: number, on: 0 | 1) => void;
      /** Task 5 perf snapshot (draw calls / triangles / fps) for the screenshot suite —
       * see PerfSnapshot's doc comment for why this reads the r3f-perf store directly. */
      readPerf: () => PerfSnapshot;
      /** Phase 6 contact-spine proof: total ImpactRecords dispatched since load. */
      impactCount: () => number;
      /** Phase 6 contact-spine proof: the last few dispatched impacts, resolved to registry
       * identities (kind/archetype of each side + force magnitude). */
      recentImpacts: () => readonly ImpactSample[];
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
  tintDistrict: (n) => {
    for (const name of ARCHETYPES) setDistrictColor(name, n, TINT_COLOR);
  },
  setDistrictEmissive: (n, on) => {
    for (const name of EMISSIVE_ARCHETYPES) setDistrictEmissiveRange(name, n, on);
  },
  readPerf: () => {
    const state = getR3fPerfState();
    return {
      calls: state.gl?.info.render.calls ?? null,
      triangles: state.gl?.info.render.triangles ?? null,
      fps: state.log?.fps ?? null,
    };
  },
  impactCount: () => getImpactCount(),
  recentImpacts: () => recentImpacts.slice(),
};
