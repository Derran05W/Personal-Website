// Phase 10 Task 2: pure-logic coverage for armoredPolice.ts. Everything else in that module
// (the unit class, the mass override, the live onImpact shove subscription) needs a live
// Rapier world and is verified via the dev-server driving battery instead (see phase notes) —
// this file covers ONLY the pair-matcher, which is deliberately pure/Rapier-free so it's
// unit-testable (mirrors combat/damage.test.ts's split between pure-core and live-integration
// coverage).

import { describe, expect, it } from 'vitest';
import { pickArmoredPlayerPair } from './armoredPolice';
import type { EntityEntry } from '../../world/registry';

const PLAYER: EntityEntry = { kind: 'player', districtId: -1 };
const ARMORED: EntityEntry = { kind: 'pursuit', districtId: -1, hp: 90, unitKind: 'armored' };
const POLICE: EntityEntry = { kind: 'pursuit', districtId: -1, hp: 40, unitKind: 'police' };
const SWAT: EntityEntry = { kind: 'pursuit', districtId: -1, hp: 120, unitKind: 'swat' };
const BUILDING: EntityEntry = { kind: 'building', districtId: 0 };

describe('pickArmoredPlayerPair', () => {
  it('matches armored-as-a, player-as-b', () => {
    expect(pickArmoredPlayerPair({ a: ARMORED, b: PLAYER, aHandle: 1, bHandle: 2 })).toEqual({
      armoredHandle: 1,
      playerHandle: 2,
    });
  });

  it('matches armored-as-b, player-as-a (order-independent)', () => {
    expect(pickArmoredPlayerPair({ a: PLAYER, b: ARMORED, aHandle: 5, bHandle: 9 })).toEqual({
      armoredHandle: 9,
      playerHandle: 5,
    });
  });

  it('does not match a police↔player pair (only armored triggers the shove)', () => {
    expect(pickArmoredPlayerPair({ a: POLICE, b: PLAYER, aHandle: 1, bHandle: 2 })).toBeNull();
  });

  it('does not match a swat↔player pair', () => {
    expect(pickArmoredPlayerPair({ a: SWAT, b: PLAYER, aHandle: 1, bHandle: 2 })).toBeNull();
  });

  it('does not match armored↔prop (no player side)', () => {
    expect(pickArmoredPlayerPair({ a: ARMORED, b: BUILDING, aHandle: 1, bHandle: 2 })).toBeNull();
  });

  it('does not match armored↔armored', () => {
    expect(pickArmoredPlayerPair({ a: ARMORED, b: ARMORED, aHandle: 1, bHandle: 2 })).toBeNull();
  });

  it('does not match undefined sides', () => {
    expect(pickArmoredPlayerPair({ a: undefined, b: PLAYER, aHandle: 1, bHandle: 2 })).toBeNull();
    expect(pickArmoredPlayerPair({ a: ARMORED, b: undefined, aHandle: 1, bHandle: 2 })).toBeNull();
    expect(pickArmoredPlayerPair({ a: undefined, b: undefined, aHandle: 1, bHandle: 2 })).toBeNull();
  });
});
