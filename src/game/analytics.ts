// Game-side custom-event -> analytics wiring (Phase 20 Task 1). Mirrors fx/eventFx.ts's
// and audio/eventMap.ts's init/dispose shape: a plain function subscribed through
// state/events.ts's typed gameEvents (CLAUDE.md: "extend the catalog, don't bypass
// it"), returning a teardown. The orchestrator mounts this the same way it mounts
// initEventFx/initEventMap — see game/index.tsx's other `useEffect(() => initX(), [])`
// lines for the pattern; add `useEffect(() => initGameAnalytics(), [])` alongside them.
//
// Boundary choice (per this task's brief: "the game module may import @vercel/analytics'
// track directly ... or dispatch DOM CustomEvents the shell relays — pick the cleaner
// and document"): imports `track` directly from '@vercel/analytics'. That package's
// `track()` is a tiny, dependency-free function that just pushes onto a queue
// (`window.vaq`) the shell's <Analytics/> mount (src/app/AppAnalytics.tsx) later flushes
// — safe to call whether or not <Analytics/> has mounted yet, and in either order, so no
// game -> shell coordination is needed. This is also the same shape every other
// game-side "self-init module reaching an external sink" already uses (initEventFx ->
// particleFeed, initEventMap -> the audio manager) — a DOM CustomEvent relay would be a
// strictly worse extra hop for no benefit, and would be the ONLY event-catalog consumer
// not using gameEvents directly.
//
// Fire-and-forget, no PII: only event names, no payload data (heat/score/seed/position
// etc. never leave the client via these calls).
import { gameEvents } from './state/events';
import { track } from '@vercel/analytics';

export function initGameAnalytics(): () => void {
  const offs: Array<() => void> = [];

  offs.push(gameEvents.on('runStarted', () => track('game_start')));

  offs.push(
    gameEvents.on('runEnded', ({ reason }) => {
      // 'quit' (route-away / dev-bridge reset) isn't one of the named custom events in
      // the Phase 20 plan (game_start / wrecked / busted / dark_city) — only the two
      // real game-over outcomes are tracked.
      if (reason === 'wrecked') track('wrecked');
      else if (reason === 'busted') track('busted');
    }),
  );

  offs.push(gameEvents.on('darkCity', () => track('dark_city')));

  return () => {
    for (const off of offs) off();
  };
}
