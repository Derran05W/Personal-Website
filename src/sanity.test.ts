import { describe, expect, it } from 'vitest';

// Tooling sanity check for Phase 1 (scaffold + tooling). Confirms the vitest + jsdom
// pipeline runs end to end. Real coverage (header, routes, game systems) is added by
// later tasks/phases.
describe('vitest tooling', () => {
  it('runs', () => {
    expect(true).toBe(true);
  });
});
