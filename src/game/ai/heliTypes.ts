// Helicopter contracts (Phase 14 seam, orchestrator-authored). ai/helicopter.ts (flight
// model) writes slots; HeliMesh + the searchlight package read them. Ambient-only — no
// colliders, no registry entries, zero physics cost (TDD §5.7 v1).

export type HeliLivery = 'police' | 'swat' | 'military';

export interface HeliSlot {
  /** null = no heli in this slot. Slot 0 is the LEAD heli (owns the searchlight). */
  livery: HeliLivery | null;
  x: number;
  y: number;
  z: number;
  /** Heading yaw (rad) — faces along the orbit tangent. */
  yaw: number;
  /** Bank roll into the turn (rad). */
  bank: number;
  /** Rotor spin angle (rad, accumulates). */
  rotor: number;
  /** 0..1 fade for fly-in/fly-out (mesh scales/announces with it). */
  presence: number;
}

export interface HeliApi {
  readonly slots: readonly HeliSlot[]; // length 2 (slot 1 used only at ★5)
}

export const heliRef: { current: HeliApi | null } = { current: null };
