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
import { trafficRef } from '../ai/trafficTypes';
import { gameEvents } from '../state/events';
import { unitsRef, type UnitKind } from '../ai/pursuitTypes';
import { setDevToggle } from './devToggles';
import { getSirenDebugSnapshot, type SirenDebugVoice } from '../audio/sirens';

// Phase 7 traffic verification: exactly-once event proof. The civHit/civWrecked emitter
// payloads are empty, so scripted checks can't scrape them from the DOM — count them here
// (DEV-only, like recentImpacts) and read the totals through window.__smashy.
let civHitTotal = 0;
let civWreckTotal = 0;
gameEvents.on('civHit', () => {
  civHitTotal++;
});
gameEvents.on('civWrecked', () => {
  civWreckTotal++;
});

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

// Phase 10 Task 3: forceSpawnUnit's runtime kind guard. UnitKind (ai/pursuitTypes.ts) is a
// string-literal union with no runtime representation, so a plain string argument off
// window (Playwright's page.evaluate can't pass a typed literal) needs a real value to
// validate against rather than an unsafe cast. Kept in lockstep with UnitKind by hand — the
// same discipline Part 4's own unit modules already follow when they extend that union.
const KNOWN_UNIT_KINDS: readonly UnitKind[] = ['police', 'armored', 'swat', 'gunTruck'];

function isUnitKind(kind: string): kind is UnitKind {
  return (KNOWN_UNIT_KINDS as readonly string[]).includes(kind);
}

// Phase 9 Task 4: force a GAMEOVER with reason 'busted' without needing the real detector
// live (combat/runLoop.ts, a concurrent sibling task — speed<1 for 3s AND >=3 pursuers
// within 8m — which in turn needs Task 1/2's pursuit units actually chasing the player to
// construct naturally). This is a screen/flow verification shortcut, not a stand-in for
// runLoop's real BUSTED detector: it drives the exact same public seams (gameEvents,
// store.transition) runLoop itself will drive once it lands, so once it exists this
// function and the real path can never disagree about what a BUSTED game-over looks like —
// there's nothing here for runLoop to conflict with. Exported (not just attached to
// window) so core/devPanel.tsx's "force BUSTED (debug)" button can call the identical
// logic instead of duplicating it.
export function forceBustedGameOver(): void {
  const state = getGameState();
  gameEvents.emit('runEnded', { score: state.score, reason: 'busted' });
  if (canTransition(state.machine, 'GAMEOVER')) state.transition('GAMEOVER');
}

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
      /** Phase 8 audit: HUD-visible store numbers in one read. */
      readHud: () => { heat: number; tier: number; score: number; playerHp: number };
      /** Phase 8 audit: monotonic heat grant — the scripted mirror of the devPanel
       * "+N heat" buttons (leva DOM automation is canvas-occluded in headless). */
      addHeat: (delta: number) => void;
      /** Phase 9 audit: direct store.setPlayerHp mirror — the scripted kill path for
       * WRECKED verification (combat/runLoop.ts). Deliberately bypasses the damage
       * resolver (combat/damage.ts) entirely, same as the devPanel's own hp slider would
       * — runLoop's WRECKED detection polls store.playerHp every fixed step specifically
       * so this path (and any other non-event hp mutation) can never be missed. */
      setPlayerHp: (hp: number) => void;
      /** Phase 6 contact-spine proof: total ImpactRecords dispatched since load. */
      impactCount: () => number;
      /** Phase 6 contact-spine proof: the last few dispatched impacts, resolved to registry
       * identities (kind/archetype of each side + force magnitude). */
      recentImpacts: () => readonly ImpactSample[];
      /** Phase 7 traffic proof: live civilian count (non-free slots); 0 when unmounted. */
      trafficCount: () => number;
      /** Phase 7 traffic proof: state histogram { driving, converted, wrecked, free }. */
      trafficStates: () => Record<string, number>;
      /** Phase 7 traffic proof: plain per-slot pose snapshot (no functions/bodies — safe to
       * serialize across page.evaluate for position-advance / conversion / flip checks). */
      trafficSlots: () => {
        id: number;
        state: string | null;
        x: number;
        y: number;
        z: number;
        yaw: number;
        dynamic: boolean;
        qw: number;
        hp: number;
      }[];
      /** Phase 7 traffic proof: force-spawn a civilian near a world position (nearest node). */
      trafficSpawnAt: (x: number, z: number) => boolean;
      /** Phase 7 traffic proof: total civHit / civWrecked events emitted since load. */
      civHitCount: () => number;
      civWreckCount: () => number;
      /** Phase 9 Task 4 proof: live pursuit-unit count (non-free slots); 0 when the spawn
       * director (ai/spawnDirector.ts) hasn't mounted yet. */
      pursuitCount: () => number;
      /** Phase 9 Task 4 proof: plain per-slot snapshot (no functions — safe to serialize
       * across page.evaluate), mirroring trafficSlots' shape for the pursuit roster. */
      pursuitSlots: () => {
        id: number;
        kind: string | null;
        state: string;
        x: number;
        y: number;
        z: number;
        hp: number;
        behaviorLabel: string;
      }[];
      /** Phase 9 Task 4 debug: force-spawn one police unit near the player, ignoring spawn
       * caps (ai/pursuitTypes.ts's PursuitApi.forceSpawn). False if the director hasn't
       * mounted yet or declined to spawn. Kept as a thin sugar alias over forceSpawnUnit
       * ('police') below — existing scripts calling this by name keep working unchanged. */
      forceSpawnPolice: () => boolean;
      /** Phase 10 Task 3 debug: force-spawn one unit of `kind` near the player, ignoring
       * spawn caps — generalizes forceSpawnPolice to every registered UnitKind ('police' |
       * 'armored' | 'swat' | 'gunTruck'). False if `kind` isn't a known UnitKind, the director hasn't
       * mounted yet, `kind` has no registered factory yet (Part 4 units register on their
       * own schedule — see ai/spawnDirector.ts's unknown-factory fallback), or the director
       * otherwise declined to spawn. Never throws. */
      forceSpawnUnit: (kind: string) => boolean;
      /** Phase 9 Task 4 debug: flips core/devToggles.ts's `invincible` flag. See that
       * module's doc comment for the handoff — this flag alone changes no behavior until
       * combat/damage.ts's applyPlayerDamage() is wired to read it. */
      setInvincible: (value: boolean) => void;
      /** Phase 9 Task 4 debug: forces a GAMEOVER with reason 'busted' — see
       * forceBustedGameOver's doc comment above for exactly what this does and doesn't
       * stand in for. */
      forceBustedGameOver: () => void;
      /** Phase 9 Task 4 proof: per-voice siren binding + gain, and the shared
       * AudioContext's state (audio/sirens.ts). Real audible output can't be verified in
       * this headless container — see that module's file header. */
      sirenSnapshot: () => {
        readonly contextState: AudioContextState | null;
        readonly voices: readonly SirenDebugVoice[];
      };
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
  readHud: () => {
    const s = getGameState();
    return { heat: s.heat, tier: s.tier, score: s.score, playerHp: s.playerHp };
  },
  addHeat: (delta) => getGameState().addHeat(delta),
  setPlayerHp: (hp) => getGameState().setPlayerHp(hp),
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
  trafficCount: () => trafficRef.current?.activeCount() ?? 0,
  trafficStates: () => {
    const h: Record<string, number> = { driving: 0, converted: 0, wrecked: 0, free: 0 };
    for (const s of trafficRef.current?.slots ?? []) h[s.state ?? 'free']++;
    return h;
  },
  trafficSlots: () =>
    (trafficRef.current?.slots ?? []).map((s) => ({
      id: s.id,
      state: s.state,
      x: s.x,
      y: s.y,
      z: s.z,
      yaw: s.yaw,
      dynamic: s.dynamic,
      qw: s.qw,
      hp: s.hp,
    })),
  trafficSpawnAt: (x, z) => trafficRef.current?.spawnAt(x, z) ?? false,
  civHitCount: () => civHitTotal,
  civWreckCount: () => civWreckTotal,
  pursuitCount: () => unitsRef.current?.activeCount() ?? 0,
  pursuitSlots: () =>
    (unitsRef.current?.slots ?? [])
      .filter((s) => s.kind !== null)
      .map((s) => ({
        id: s.id,
        kind: s.kind,
        state: s.state,
        x: s.x,
        y: s.y,
        z: s.z,
        hp: s.hp,
        behaviorLabel: s.behaviorLabel,
      })),
  forceSpawnPolice: () => unitsRef.current?.forceSpawn('police' satisfies UnitKind) ?? false,
  forceSpawnUnit: (kind) => (isUnitKind(kind) ? (unitsRef.current?.forceSpawn(kind) ?? false) : false),
  setInvincible: (value) => setDevToggle('invincible', value),
  forceBustedGameOver,
  sirenSnapshot: () => getSirenDebugSnapshot(),
};
