// Phase 17 Task 2: shared per-frame damage-tint READ for player car meshes. Phase 16's
// RustySedanMesh hardcoded PLAYER_CARS.rustySedan.hp as the tint denominator — the only
// car that existed then (see that file's useFrame, now fixed to call this instead). Six
// cars now share ONE player HP number (state/store.ts's playerHp) against SIX different
// max-hp values (PLAYER_CARS[carId].hp), so every mesh needs to know which car it is to
// compute the right fraction. This is the one piece of real duplication factored out; the
// "reset base colour, then tintDamageColor()" per material stays inline in each mesh
// (RustySedanMesh's existing pattern) since the set of tinted materials differs per car.
//
// Deliberately NOT named with a `use` prefix even though it reads like a hook: it calls no
// React hooks itself (getGameState() is a plain zustand getter, safe to call from
// anywhere), and every call site invokes it from inside a useFrame callback — a `use*`
// name there would trip eslint-plugin-react-hooks' naming-based rules-of-hooks check for a
// function that isn't actually a hook.

import { PLAYER_CARS, type PlayerCarId } from '../../config';
import { hpLostFraction } from '../../fx/damageStates';
import { getGameState } from '../../state/store';

export interface CarDamageTint {
  readonly lostFrac: number;
  readonly wrecked: boolean;
}

/**
 * Current player HP read against `carId`'s own PLAYER_CARS max HP. Call once per useFrame,
 * then for every damage-tinted material:
 *   material.color.set(BASE_HEX);
 *   tintDamageColor(material.color, lostFrac, wrecked);
 * — reset-then-tint, every frame, never compounded (fx/damageStates.ts's tintDamageColor
 * doc comment: "recompute fresh from current hp every call"). `wrecked` mirrors every
 * other system's convention (hp <= 0 — combat/damage.ts clamps hp at 0).
 */
export function readCarDamageTint(carId: PlayerCarId): CarDamageTint {
  const playerHp = getGameState().playerHp;
  const maxHp = PLAYER_CARS[carId].hp;
  return {
    lostFrac: hpLostFraction(playerHp, maxHp),
    wrecked: playerHp <= 0,
  };
}
