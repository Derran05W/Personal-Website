// Null-rendering system component that mounts/unmounts the positional-audio lifecycle
// (audio/positional.ts: district transformer hums + helicopter rotor chop) — same
// "null-rendering system" pattern as audio/SirensSystem.tsx. Orchestrator-mounted for the
// game's whole lifetime alongside <SirensSystem/>: it needs no r3f/Rapier context (just a
// plain interval + a zustand subscription), reads the shared AudioContext + ambient bus from
// audio/manager.ts (unlocked by whichever audio system reaches PLAYING first), and reads live
// world/heli/grid/player state through their module-scope refs.
import { useEffect } from 'react';
import { initPositionalAudio } from './positional';

export function PositionalAudioSystem(): null {
  useEffect(() => initPositionalAudio(), []);
  return null;
}
