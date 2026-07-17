// Heat event wiring (Phase 8 Task 1; TDD §5.5). Subscribes the typed event catalog
// (state/events.ts) to store.addHeat, translating each gameplay event into the heat delta
// TDD §5.5's table assigns it. Pure config lives in config/heat.ts (HEAT.events);
// this module ONLY maps events → that config and calls the store action — no new
// tunables, no new events.
//
// --- propDestroyed archetype → heat mapping ------------------------------------------------
// TDD §5.5 groups "Light post / hydrant / mailbox / bench destroyed" into a single +1 row.
// world/archetypes.ts's street-prop set adds two archetypes the TDD prose doesn't name
// individually but that plainly belong in the same row: `fenceSegment` (transformer-lot
// fencing — cosmetic, no special value called out) and `tree` (same). `trafficLight` gets
// its own dedicated +2 row per the table.
//
// `parkedCar` is deliberately billed at HEAT.events.civHit (+5), NOT a dedicated row —
// config/heat.ts has no `parkedCar` key by design. This is phase-08-plan.md's locked
// decision ("parked cars are civilian property"): a parked car is hp-bearing and reaches
// this map via propDestroyed (see combat/damage.ts's applyEntityDamage — non-transformer
// hp-death emits propDestroyed{archetype}), but conceptually it's civilian property, not
// street furniture, so it's priced like hitting a civilian, not like a mailbox.
//
// `transformerBox` is deliberately ABSENT from this map. Verified against both emitters:
//   - combat/damage.ts's handleTransformerDeath() emits ONLY `transformerDestroyed`
//     (never `propDestroyed`) when a transformer's hp reaches 0 — see that file's
//     "propDestroyed emission contract" header comment, which calls this out explicitly
//     ("Transformers get their own dedicated transformerDestroyed event instead of
//     propDestroyed, per TDD §5.8").
//   - world/propDynamics.ts's swap-on-launch path only emits `propDestroyed` for hp-LESS
//     archetypes (`if (target.hp === undefined)`); transformerBox is hp-bearing (it has to
//     survive being knocked around before it dies), so that branch never fires for it
//     either.
// So `transformerBox` never reaches PROP_HEAT_DELTA at runtime; transformer heat is applied
// exclusively via the dedicated `transformerDestroyed` subscription below (HEAT.events.transformer,
// +12). If it ever DID show up in a propDestroyed payload, that would indicate a bug
// upstream (a new emission path added without updating this comment) — this module logs a
// DEV warning and drops it rather than silently double- or mis-billing it.
//
// `unitWrecked` (police/armored/SWAT/gun-truck/tank wrecks — HEAT.events.policeWreck etc.):
// Phase 9 wires the first real kind ('police' -> policeWreck, +25). The map below is keyed
// by `UnitKind | string` (not narrowed to ai/pursuitTypes.ts's `UnitKind` union) precisely
// because events.ts's `unitWrecked` payload types `unitKind` as a plain `string` — same
// dependency-light stub shape as `propDestroyed`'s `archetype` field (see that event's
// handling below) — so this module doesn't need to import the AI layer's types just to
// read an event payload. Part 4 (armored/SWAT/gun-truck/tank) appends its kinds to both
// ai/pursuitTypes.ts's UnitKind union and this map; an unmapped kind falls through to the
// same DEV-warn-and-drop path propDestroyed's unmapped archetypes use.
import { gameEvents } from './events';
import { getGameState } from './store';
import { HEAT } from '../config/heat';
import type { ArchetypeName } from '../world/archetypes';

const PROP_HEAT_DELTA: Partial<Record<ArchetypeName, number>> = {
  streetlight: HEAT.events.lightPost,
  hydrant: HEAT.events.lightPost,
  mailbox: HEAT.events.lightPost,
  bench: HEAT.events.lightPost,
  fenceSegment: HEAT.events.lightPost,
  tree: HEAT.events.lightPost,
  trafficLight: HEAT.events.trafficLight,
  parkedCar: HEAT.events.civHit,
  // Phase 19 Task 2: market props (awning/crate/produceStand) are plain street furniture,
  // same row as the existing lightPost group (mailbox/bench/tree/etc.) — no dedicated
  // config value for them, same pattern as fenceSegment/tree above. raccoon/garbageCanTipped
  // DO get dedicated config values (HEAT.events.raccoon/garbageCanTipped) per the phase-19
  // plan's explicit ask, wired straight through below.
  awning: HEAT.events.lightPost,
  crate: HEAT.events.lightPost,
  produceStand: HEAT.events.lightPost,
  raccoon: HEAT.events.raccoon,
  garbageCanTipped: HEAT.events.garbageCanTipped,
};

// Shape ready for Part 4's armored/swat/gunTruck/tank kinds (M5a/M5b/M5c) — only 'police'
// has a live emitter today (Phase 9's ai/units/policeSedan.ts, via unitWrecked).
const UNIT_HEAT_DELTA: Partial<Record<string, number>> = {
  police: HEAT.events.policeWreck,
  armored: HEAT.events.armoredWreck,
  swat: HEAT.events.swatWreck,
  gunTruck: HEAT.events.gunTruckWreck,
  tank: HEAT.events.tankWreck,
};

/**
 * Subscribes every heat-relevant gameplay event to `store.addHeat`, per the mapping above
 * and config/heat.ts's other direct event values (civHit, civWreck, transformer). Returns a
 * single teardown that unsubscribes all of them — call once at mount (e.g. from
 * `<HeatScoreSystem />`'s mount effect) and call the returned function on unmount.
 */
export function initHeatSystem(): () => void {
  const offProp = gameEvents.on('propDestroyed', ({ archetype }) => {
    // events.ts's `propDestroyed` payload types `archetype` as a plain `string` (Phase 2
    // stub — it doesn't import world/archetypes.ts to stay dependency-light). At runtime
    // it is always a real ArchetypeName (both emitters — combat/damage.ts and
    // world/propDynamics.ts — read it straight off an EntityEntry.archetype, which IS
    // ArchetypeName-typed); the cast below just recovers that fact for the lookup below.
    // An archetype absent from the map (see this file's header — expected only for
    // transformerBox) falls through as `undefined`, same as any other unmapped key would.
    const delta = PROP_HEAT_DELTA[archetype as ArchetypeName];
    if (delta === undefined) {
      if (import.meta.env.DEV) {
        console.warn(
          `[heat] propDestroyed for archetype "${archetype}" has no heat mapping — see state/heat.ts's header comment (transformerBox is expected to never appear here).`,
        );
      }
      return;
    }
    getGameState().addHeat(delta);
  });

  const offCivHit = gameEvents.on('civHit', () => {
    getGameState().addHeat(HEAT.events.civHit);
  });

  const offCivWrecked = gameEvents.on('civWrecked', () => {
    getGameState().addHeat(HEAT.events.civWreck);
  });

  const offTransformer = gameEvents.on('transformerDestroyed', () => {
    getGameState().addHeat(HEAT.events.transformer);
  });

  const offUnitWrecked = gameEvents.on('unitWrecked', ({ unitKind }) => {
    const delta = UNIT_HEAT_DELTA[unitKind];
    if (delta === undefined) {
      if (import.meta.env.DEV) {
        console.warn(`[heat] unitWrecked for kind "${unitKind}" has no heat mapping — see state/heat.ts's UNIT_HEAT_DELTA.`);
      }
      return;
    }
    getGameState().addHeat(delta);
  });

  return () => {
    offProp();
    offCivHit();
    offCivWrecked();
    offTransformer();
    offUnitWrecked();
  };
}

// --- passive accrual (TDD §5.5: "+1/sec while wanted >= ★1") --------------------------------
//
// Driven from a fixed-step system (`<HeatScoreSystem />`'s useAfterPhysicsStep, PLAYING
// only) so it advances in lockstep with simulation time and stops for free while PAUSED
// (Rapier's step loop simply doesn't run — see phase-07-notes.md's note reused in the
// phase-08 plan).
//
// Heat must stay a whole number (store.addHeat is called with discrete event values
// everywhere else, and downstream consumers — HUD, persistence — read it as an integer
// "heat" readout), but HEAT.passivePerSec × dt at 60 Hz is a sub-1 fraction (1 × 1/60 ≈
// 0.0167), so calling addHeat every step would either round to 0 forever or require
// addHeat itself to accept fractional heat. Instead this module keeps its own
// module-scope float accumulator: every call adds the exact (unrounded) elapsed passive
// heat, and only the accumulator's whole part is ever flushed into `addHeat` — the
// fractional remainder carries over to the next call, so accrual is exact over time (no
// systematic under-count from repeated floor()s) while every store mutation stays an
// integer, keeping heat's monotonic-integer contract intact.
let passiveAccumulator = 0;

// Guards Math.floor against IEEE-754 accumulation error at exact-integer boundaries: e.g.
// summing HEAT.passivePerSec(1) x (1/60) sixty times (one full second at the fixed physics
// step) lands at 1.0000000000000013 (fine), but the equivalent risk-bonus sum in score.ts
// (5 x 1/60, sixty times) lands at 4.999999999999999 — a hair BELOW the true integer
// crossing, which would make Math.floor under-flush by one whole point for an entire extra
// step. Nudging by an epsilon far smaller than any real per-step delta (~0.017 at 60 Hz)
// fixes the boundary without ever flushing early in any way a player could perceive.
const FLUSH_EPSILON = 1e-9;

/**
 * Advances passive heat accrual by `dtSec` simulated seconds. No-op while tier is 0 (heat
 * hasn't reached ★1 yet) — the accumulator is reset in that case too, so a fractional
 * remainder left over from a previous run (post hardReset, tier back to 0) can't get
 * silently "banked" and dumped in as a sudden jump the next time tier reaches ★1 again.
 */
export function accruePassive(dtSec: number): void {
  const { tier } = getGameState();
  if (tier < 1) {
    passiveAccumulator = 0;
    return;
  }

  passiveAccumulator += HEAT.passivePerSec * dtSec;
  const whole = Math.floor(passiveAccumulator + FLUSH_EPSILON);
  if (whole > 0) {
    passiveAccumulator -= whole;
    getGameState().addHeat(whole);
  }
}

/** Test-only reset for the module-scope passive accumulator (mirrors combat/contacts.ts's
 * `__resetContactsForTest` pattern for isolating tests from each other's residue). */
export function __resetPassiveAccumulatorForTest(): void {
  passiveAccumulator = 0;
}
