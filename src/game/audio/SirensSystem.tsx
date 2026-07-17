// Null-rendering system component that mounts/unmounts the WebAudio siren system's
// lifecycle (audio/sirens.ts) — same "null-rendering system" pattern as combat/damage.ts's
// DamageSystem and core/frameOrder.tsx's AiSystem/EventDrainSystem/CameraFxSystem.
// Orchestrator-mounted for the game's whole lifetime (alongside <Hud/> / <GameOver/>) — it
// needs no r3f/Rapier context (just a plain interval + a zustand subscription), so it can
// live outside <Canvas> just as easily as inside it.
import { useEffect } from 'react';
import { initSirens } from './sirens';

export function SirensSystem(): null {
  useEffect(() => initSirens(), []);
  return null;
}
