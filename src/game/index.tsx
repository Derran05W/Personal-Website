// Lazy game entry point. This is a placeholder for Phase 1: the scaffold task only
// needs this to exist as a valid, importable default export so the lazy-loading seam
// (`React.lazy(() => import('../game'))`) can be wired into src/app/ in the next task.
// Phase 2 replaces this with the real <Canvas>, providers, and game bootstrap.
export default function Game() {
  return null;
}
