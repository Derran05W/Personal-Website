// GARAGE screen. Rendered by index.tsx only while machine === 'GARAGE' — this file stays
// the thin, stable import site game/index.tsx already has wired up
// (`{machine === 'GARAGE' ? <GarageOverlay /> : null}`); the real six-car garage UI
// (Phase 17 Task 4: car cards, unlock gating, keyboard nav, "New city") lives in
// hud/garage/Garage.tsx — see that file for the full contract.
export { Garage as GarageOverlay } from './hud/garage/Garage';
