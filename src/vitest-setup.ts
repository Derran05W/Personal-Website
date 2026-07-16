import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// Global Vitest setup, registered via vite.config.ts's test.setupFiles.
//
// - '@testing-library/jest-dom/vitest' extends Vitest's `expect` with DOM matchers
//   (toBeInTheDocument, toHaveAttribute, ...) for every test file — jest-dom v6's
//   dedicated Vitest entry point; it calls expect.extend itself, no manual wiring.
// - Explicit afterEach(cleanup): this project doesn't set `test.globals` (test files
//   import describe/it/expect from 'vitest' explicitly — see src/sanity.test.ts), so
//   @testing-library/react's own auto-cleanup — which only self-registers when it
//   detects a global `afterEach` function — never fires. Without this, multiple
//   render() calls across it() blocks in the same file would leak DOM nodes into the
//   next test (e.g. duplicate headers), causing "found multiple elements" failures.
afterEach(() => {
  cleanup();
});
