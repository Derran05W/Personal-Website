// Shared, globally-unique pursuit-unit slot id allocator (Phase 10 bug fix, found during
// this phase's live verification). Each unit-kind module used to keep its own PRIVATE
// `nextSlotId` counter starting at 0 (policeSedan.ts's Phase 9 original) — harmless with a
// single live kind, but once two or more kinds coexist in the SAME shared roster
// (ai/pursuitTypes.ts's `unitsRef.current.slots`, one flat array mixing every kind), their
// independently-numbered ids collide: the first police unit and the first armored unit both
// mint id 0, the second of each both mint id 1, etc. Any consumer that keys off `slot.id`
// across the WHOLE roster breaks the instant a second kind spawns —
// core/devPanel.tsx's pursuit-unit debug overlay does exactly that (`<div key={row.id}>`
// over every live slot regardless of kind), which produced a live "duplicate key" React
// console error the moment armored/swat joined police on the field. This module is the fix:
// ONE counter, shared by every unit-kind module, so ids stay unique roster-wide regardless
// of how many kinds are live. (ai/squad.ts's claim/candidate ids are unaffected — SWAT
// candidates are filtered to `kind === 'swat'` before any id comparison, so cross-kind
// collisions were never a correctness issue there, only for whole-roster consumers.)
let next = 0;

/** Mint the next globally-unique pursuit-unit slot id. Called once per unit at construction
 * by every unit-kind module (policeSedan.ts, armoredPolice.ts, swatSuv.ts, …). */
export function nextPursuitSlotId(): number {
  return next++;
}
