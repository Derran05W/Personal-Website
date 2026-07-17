// Visual damage states (Phase 16 Task 3; TDD §5.10 "visual damage states"). Two halves live
// here:
//
//   1. PURE MATH (hpLostFraction / damageTintMix / tintDamageColor) — how far a vehicle's
//      body colour should blend toward the shared charred tone, given how much HP it has
//      lost. Every fleet mesh (ai/TrafficMesh.tsx, ai/units/*Mesh.tsx) and the player mesh
//      (vehicles/RustySedanMesh.tsx) calls tintDamageColor() at the exact spot each already
//      computed its per-instance/per-material colour — this file owns the MATH, not the
//      rendering. Recomputed fresh from current hp every call (no accumulated state), so a
//      recycled InstancedMesh instance (a wrecked civilian's pool slot reused by a fresh,
//      undamaged car) or a respawned player automatically reads as pristine — nothing to
//      reset.
//
//   2. THE EMITTER-LIFECYCLE SYSTEM (DamageStatesMount, below) — smoke/fire ARE NOT free to
//      recompute every call like colour is: fx/particleFeed.ts's attachFxEmitter/release is
//      a persistent handle, so something has to own WHEN one exists per vehicle, walking the
//      player + every civilian + every pursuit slot and diffing against what it attached
//      last poll. That bookkeeping is centralized here (polled at DAMAGE_VISUALS.pollHz)
//      rather than duplicated inside six mesh components.
//
// Ownership boundary: this file NEVER writes an InstancedMesh's colour/matrix/attribute
// itself (that stays each mesh's own job, per CLAUDE.md's per-system-owns-its-rendering
// convention — see ai/TrafficMesh.tsx's header) and never imports fx/particles.ts directly
// (the particleFeed.ts seam is the only coupling, per that module's own producer/consumer
// contract).

import { useEffect, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Color } from 'three';
import { DAMAGE_VISUALS } from '../config/damageVisuals';
import { ENEMY_UNITS } from '../config/vehicles';
import { TRAFFIC_CIV } from '../config/world';
import { gameEvents } from '../state/events';
import { getGameState } from '../state/store';
import { playerVehicle } from '../vehicles/playerRef';
import { getSelectedCarDef } from '../vehicles/definitions';
import { trafficRef } from '../ai/trafficTypes';
import { unitsRef, type UnitKind } from '../ai/pursuitTypes';
import { attachFxEmitter, type FxEmitter } from './particleFeed';

// ============================================================================================
// Pure math — hp fraction, bracket lookup, colour tint. Unit-tested directly (no React/three
// mount required beyond the Color import, which is a plain math object here, not a renderer).
// ============================================================================================

export interface TintBracket {
  readonly atLost: number;
  readonly mix: number;
}

export interface DamageVisualsConfig {
  readonly tintBrackets: readonly TintBracket[];
  readonly charredColor: string;
}

/**
 * Fraction of `maxHp` already lost, clamped to [0, 1]. `maxHp <= 0` (misconfigured/unknown
 * archetype) reads as 0 (never tint something with no known max) rather than throwing or
 * producing NaN/Infinity — a defensive default, not an expected runtime path. Negative/NaN
 * `hp` (should never happen — registry hp is clamped at 0 by combat/damage.ts) reads as
 * fully lost rather than propagating garbage into the tint math.
 */
export function hpLostFraction(hp: number, maxHp: number): number {
  if (!(maxHp > 0)) return 0;
  if (!(hp >= 0)) return 1;
  const frac = 1 - hp / maxHp;
  return frac < 0 ? 0 : frac > 1 ? 1 : frac;
}

/**
 * Highest tint-bracket `mix` whose `atLost` threshold `hpLostFrac` has reached, or 0 below
 * every bracket (pristine). `cfg.tintBrackets` is assumed ascending by `atLost` (true of the
 * live DAMAGE_VISUALS table; a scrambled custom cfg in a test would just pick whichever
 * threshold happens to be crossed last in iteration order — not a runtime concern here).
 */
export function damageTintMix(hpLostFrac: number, cfg: DamageVisualsConfig = DAMAGE_VISUALS): number {
  let mix = 0;
  for (const bracket of cfg.tintBrackets) {
    if (hpLostFrac >= bracket.atLost) mix = bracket.mix;
  }
  return mix;
}

// Module-scope scratch (mirrors combat/damage.ts's TRANSFORMER_DEAD_COLOR convention — one
// Color instance, reused, never allocated per call in the live/default-cfg path). CHARRED is
// the bracket-math's blend target AND (at wrecked = true) the exact colour every fleet mesh's
// old hardcoded WRECK_CHAR/WRECK_CHAR_TINT multiply already produced — same value, now
// single-sourced. `_customCharred` backs the (test-only in practice) path where a caller
// passes a `cfg` with a DIFFERENT charredColor than the live default — see charredColorFor().
const CHARRED = new Color(DAMAGE_VISUALS.charredColor);
const WHITE_IDENTITY = new Color(1, 1, 1);
const _mixColor = new Color();
const _customCharred = new Color();

/** Resolves `cfg.charredColor` to a Color, reusing the cached module-scope CHARRED for the
 * (hot, every-real-caller) default-cfg case via reference equality — only a custom-cfg call
 * (unit tests exercising a non-default DamageVisualsConfig) pays for a fresh Color.set(). */
function charredColorFor(cfg: DamageVisualsConfig): Color {
  if (cfg === DAMAGE_VISUALS) return CHARRED;
  return _customCharred.set(cfg.charredColor);
}

/**
 * Darkens `color` IN PLACE toward the shared charred tone and returns it (chainable, mirrors
 * three.Color's own fluent API) — the one call every fleet mesh makes right where it used to
 * do a hardcoded `if (wrecked) _color.multiply(WRECK_CHAR)`:
 *   - `wrecked` true: full charred multiply (byte-for-byte the old wrecked-state visual).
 *   - else: `damageTintMix(hpLostFrac)` blended white→charred, then multiplied in — 0 mix is
 *     a true no-op (multiplying by pure white), so an undamaged instance's base tint/colour
 *     passes through completely unchanged.
 * Callers must `color.copy(baseTint)` (or set it fresh) before calling this — it multiplies
 * onto whatever is already in `color`, exactly like the code it replaces.
 */
export function tintDamageColor(
  color: Color,
  hpLostFrac: number,
  wrecked: boolean,
  cfg: DamageVisualsConfig = DAMAGE_VISUALS,
): Color {
  const charred = charredColorFor(cfg);
  if (wrecked) return color.multiply(charred);
  const mix = damageTintMix(hpLostFrac, cfg);
  if (mix <= 0) return color;
  _mixColor.copy(WHITE_IDENTITY).lerp(charred, mix);
  return color.multiply(_mixColor);
}

// ============================================================================================
// Emitter lifecycle system — DamageStatesMount polls at DAMAGE_VISUALS.pollHz and drives
// damageSmoke/fire attach/detach + the wrecked lingering smoke column for the player, every
// civilian slot, and every pursuit slot.
// ============================================================================================

interface TrackedEmitters {
  smoke: FxEmitter | null;
  fire: FxEmitter | null;
  wreckSmoke: FxEmitter | null;
  wreckReleaseAt: number | null;
  wasWrecked: boolean;
}

function newTracked(): TrackedEmitters {
  return { smoke: null, fire: null, wreckSmoke: null, wreckReleaseAt: null, wasWrecked: false };
}

function releaseAll(rec: TrackedEmitters): void {
  rec.smoke?.release();
  rec.fire?.release();
  rec.wreckSmoke?.release();
  rec.smoke = null;
  rec.fire = null;
  rec.wreckSmoke = null;
  rec.wreckReleaseAt = null;
}

function setEmitterPos(e: FxEmitter, x: number, y: number, z: number): void {
  e.position.x = x;
  e.position.y = y;
  e.position.z = z;
}

/**
 * Advances one tracked entity's emitter state for this poll. Shared by the player/civilian/
 * pursuit walkers below — everything entity-specific (id, position, hp fraction, wrecked
 * flag) is already resolved by the caller; this function only owns attach/detach/reposition/
 * lifetime bookkeeping, so it never needs to know the difference between a civilian sedan and
 * the player's car.
 */
function stepTrackedEntity(
  rec: TrackedEmitters,
  x: number,
  y: number,
  z: number,
  hpLostFrac: number,
  wrecked: boolean,
  nowSec: number,
): void {
  const ex = x;
  const ey = y + DAMAGE_VISUALS.emitterHeightOffset;
  const ez = z;

  if (wrecked) {
    if (!rec.wasWrecked) {
      // Fresh wreck this poll: drop the graduated smoke/fire in favour of one dedicated
      // lingering column at full presence.
      rec.smoke?.release();
      rec.smoke = null;
      rec.fire?.release();
      rec.fire = null;
      rec.wreckSmoke = attachFxEmitter('damageSmoke', ex, ey, ez);
      rec.wreckReleaseAt = nowSec + DAMAGE_VISUALS.wreckSmokeLifetimeSec;
      rec.wasWrecked = true;
      return;
    }
    // Still wrecked: track the wreck's settling pose, release once the lifetime elapses
    // (despawn/recycle releases it immediately via the "no longer seen" sweep instead).
    if (rec.wreckSmoke) {
      setEmitterPos(rec.wreckSmoke, ex, ey, ez);
      if (rec.wreckReleaseAt !== null && nowSec >= rec.wreckReleaseAt) {
        rec.wreckSmoke.release();
        rec.wreckSmoke = null;
        rec.wreckReleaseAt = null;
      }
    }
    return;
  }

  if (rec.wasWrecked) {
    // Revived (respawn/heal/recycle back to a live, non-wrecked entity at this identity) —
    // drop any still-lingering wreck column immediately rather than waiting out its timer.
    rec.wreckSmoke?.release();
    rec.wreckSmoke = null;
    rec.wreckReleaseAt = null;
    rec.wasWrecked = false;
  }

  if (hpLostFrac >= DAMAGE_VISUALS.fireAtLost) {
    if (!rec.fire) rec.fire = attachFxEmitter('fire', ex, ey, ez);
    else setEmitterPos(rec.fire, ex, ey, ez);
  } else if (rec.fire) {
    rec.fire.release();
    rec.fire = null;
  }

  if (hpLostFrac >= DAMAGE_VISUALS.smokeAtLost) {
    if (!rec.smoke) rec.smoke = attachFxEmitter('damageSmoke', ex, ey, ez);
    else setEmitterPos(rec.smoke, ex, ey, ez);
  } else if (rec.smoke) {
    rec.smoke.release();
    rec.smoke = null;
  }
}

const civTracked = new Map<number, TrackedEmitters>();
const unitTracked = new Map<number, TrackedEmitters>();
const playerTracked = newTracked();

function pollPlayer(nowSec: number): void {
  const pose = playerVehicle.current?.readState().pose;
  if (!pose) {
    // No live vehicle (GARAGE/menus) — nothing to track; drop anything still attached
    // (e.g. mid-teardown) so it can never leak.
    releaseAll(playerTracked);
    playerTracked.wasWrecked = false;
    return;
  }
  const state = getGameState();
  const maxHp = getSelectedCarDef().hp; // Phase 17: the selected car's full HP is the damage/
  // visual max-HP source of truth (smoke/fire thresholds scale to whatever car is equipped).
  const lostFrac = hpLostFraction(state.playerHp, maxHp);
  const wrecked = state.playerHp <= 0;
  stepTrackedEntity(
    playerTracked,
    pose.position.x,
    pose.position.y,
    pose.position.z,
    lostFrac,
    wrecked,
    nowSec,
  );
}

function pollCivilians(nowSec: number): void {
  const slots = trafficRef.current?.slots;
  const seen = new Set<number>();
  if (slots) {
    for (const slot of slots) {
      if (slot.state === null) continue;
      seen.add(slot.id);
      let rec = civTracked.get(slot.id);
      if (!rec) {
        rec = newTracked();
        civTracked.set(slot.id, rec);
      }
      const lostFrac = hpLostFraction(slot.hp, TRAFFIC_CIV.hp);
      stepTrackedEntity(rec, slot.x, slot.y, slot.z, lostFrac, slot.state === 'wrecked', nowSec);
    }
  }
  for (const [id, rec] of civTracked) {
    if (seen.has(id)) continue;
    releaseAll(rec);
    civTracked.delete(id);
  }
}

const UNIT_MAX_HP: Record<UnitKind, number> = {
  police: ENEMY_UNITS.police.hp,
  armored: ENEMY_UNITS.armored.hp,
  swat: ENEMY_UNITS.swat.hp,
  gunTruck: ENEMY_UNITS.gunTruck.hp,
  tank: ENEMY_UNITS.tank.hp,
};

function pollPursuit(nowSec: number): void {
  const slots = unitsRef.current?.slots;
  const seen = new Set<number>();
  if (slots) {
    for (const slot of slots) {
      if (slot.kind === null) continue;
      seen.add(slot.id);
      let rec = unitTracked.get(slot.id);
      if (!rec) {
        rec = newTracked();
        unitTracked.set(slot.id, rec);
      }
      const lostFrac = hpLostFraction(slot.hp, UNIT_MAX_HP[slot.kind]);
      stepTrackedEntity(rec, slot.x, slot.y, slot.z, lostFrac, slot.state === 'wrecked', nowSec);
    }
  }
  for (const [id, rec] of unitTracked) {
    if (seen.has(id)) continue;
    releaseAll(rec);
    unitTracked.delete(id);
  }
}

/** Drops every live emitter this system has ever attached and clears all bookkeeping — a
 * fresh/retried run (gameEvents 'runStarted') or a hard route-away unmount must never leave
 * an orphaned smoke/fire emitter pointing at a torn-down world. Exported for tests. */
export function resetDamageStates(): void {
  releaseAll(playerTracked);
  playerTracked.wasWrecked = false;
  for (const rec of civTracked.values()) releaseAll(rec);
  civTracked.clear();
  for (const rec of unitTracked.values()) releaseAll(rec);
  unitTracked.clear();
}

const POLL_INTERVAL_SEC = 1 / DAMAGE_VISUALS.pollHz;

/**
 * The Phase 16 damage-visual-state MOUNT: a null-rendering system (matches combat/damage.ts's
 * DamageSystem / core/frameOrder.tsx's system components) that polls the player + every
 * civilian + every pursuit slot at DAMAGE_VISUALS.pollHz and drives the damageSmoke/fire
 * emitter lifecycle (tint itself is applied inline by each fleet mesh via tintDamageColor()
 * above — this component owns ONLY emitters, which need persistent cross-poll bookkeeping
 * that colour recomputation doesn't).
 *
 * Reads module-scope refs (playerVehicle/trafficRef/unitsRef) exactly like every other
 * roster-reading system in this codebase (ai/TrafficMesh.tsx, ai/units/*Mesh.tsx) — no props,
 * mount once anywhere inside the Canvas (does not require the Rapier context, so it does not
 * need to live inside <Physics>, though co-locating it with the other gameplay systems in
 * game/index.tsx is the natural spot — the orchestrator wires the tree).
 */
export function DamageStatesMount(): null {
  const accumRef = useRef(0);

  // Run-reset hygiene (see initDamageStatesSystem's doc comment): subscribed/unsubscribed
  // through this component's own lifetime, matching combat/damage.ts's DamageSystem /
  // state/heat.ts's init*System pairing — never a bare module-scope side-effect subscription
  // (which would survive past this component's lifetime and complicate test isolation).
  useEffect(() => initDamageStatesSystem(), []);

  useFrame((frameState, delta) => {
    accumRef.current += delta;
    if (accumRef.current < POLL_INTERVAL_SEC) return;
    accumRef.current -= POLL_INTERVAL_SEC;
    // Sim-time-ish clock for the wreck-column lifetime countdown — R3F's frame delta sum is
    // fine here (this is a cosmetic linger timer, not physics-critical); using it instead of
    // Date.now()/performance.now() keeps this system trivially fake-clock-testable.
    const nowSec = frameState.clock.elapsedTime;
    pollPlayer(nowSec);
    pollCivilians(nowSec);
    pollPursuit(nowSec);
  });

  return null;
}

/**
 * Run-reset hygiene: a fresh/retried run (combat/runLoop.ts's beginRun) tears down and
 * rebuilds the civilian/pursuit rosters under a NEW worldKey — this module's tracking maps
 * are keyed by slot/unit id, which stay module-scope across that remount (this file itself
 * never remounts), so without an explicit reset a stale id's emitter would linger pointed at
 * nothing. The natural "no longer seen this poll" sweep in pollCivilians/pollPursuit would
 * eventually catch this on its own (the old refs briefly go empty during the remount), but
 * subscribing directly is immediate and matches the task's explicit "release on ... run-
 * reset" requirement rather than relying on that as an implementation detail. Exported
 * directly (like combat/damage.ts's initDamageSystem) so DamageStatesMount's useEffect
 * subscribes/unsubscribes it through its own lifetime instead of a bare module-scope
 * side-effect — keeps this file's listener registration test-isolation-friendly.
 */
export function initDamageStatesSystem(): () => void {
  return gameEvents.on('runStarted', () => resetDamageStates());
}
