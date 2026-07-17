import { Component, type ErrorInfo, type ReactNode } from 'react';
import GameBootFallback from './GameBootFallback';

interface GameErrorBoundaryProps {
  children: ReactNode;
}

interface GameErrorBoundaryState {
  hasError: boolean;
}

/**
 * Wraps the lazy game mount (GameCanvas.tsx) so a boot failure never takes the whole
 * site down with it (TDD §9/§15: "the site must never white-page"). React error
 * boundaries only catch errors thrown during rendering/lifecycle/commit — which, for
 * this specific seam, covers both failure classes the task calls out:
 *
 *  1. **The lazy `import()` rejecting** (e.g. the game chunk fails to fetch — network
 *     blip, stale deploy, ad blocker). `React.lazy` converts a rejected promise into a
 *     thrown error on the next render of the component it wraps; that throw happens
 *     during render, so it IS caught here even though the original rejection was async.
 *  2. **A synchronous boot throw inside the game chunk itself** (WebGL context
 *     creation failing, etc.) — also a render-phase throw, also caught. This also
 *     covers @react-three/rapier's WASM init in practice: it uses `suspend-react`
 *     (Suspense-integrated caching), which re-throws a rejected init promise's reason
 *     synchronously on the next render — so a real Rapier/WASM boot failure surfaces
 *     as case 2, not as an unhandled promise rejection.
 *
 * What this can NOT catch (a fundamental React limitation, not something fixable from
 * the shell side without editing game code): an error thrown from inside an
 * asynchronous callback that never re-throws during a render pass (e.g. a rejected
 * promise nobody awaits, or a `setTimeout` callback). Those escape every React error
 * boundary by construction. If that ever needs covering, it has to happen inside
 * src/game/ itself (out of scope here — src/app/ never imports game internals beyond
 * the lazy seam).
 */
export default class GameErrorBoundary extends Component<GameErrorBoundaryProps, GameErrorBoundaryState> {
  state: GameErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): GameErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    // No telemetry backend exists (TDD: backend = none, static site only) — this is
    // strictly a developer-console breadcrumb. React's own dev overlay/console logging
    // already surfaces the original error in dev; this line is what survives in prod.
    console.error('[GameErrorBoundary] the game failed to boot:', error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return <GameBootFallback />;
    }
    return this.props.children;
  }
}
