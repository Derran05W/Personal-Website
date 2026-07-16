// Dev-only leva tuning + debug panel. Code-split: game/index.tsx references this module
// only behind `import.meta.env.DEV ? lazy(() => import('./core/devPanel')) : null`, so the
// constant-false branch in production strips the dynamic import and leva never lands in a
// prod chunk. Rendered in the DOM tree (outside <Canvas>) — <Leva> is an HTML overlay.
//
// This panel is the shared debug surface that EVERY later gameplay phase extends (force
// tier, grant heat, spawn unit X, blackout district, teleport, invincible, chaos bench…),
// so it is structured around a top-level "Debug" folder plus auto-generated config folders.

import { useControls, folder, button, Leva } from 'leva';
import { getGameState, useGameStore } from '../state/store';
import { canTransition, TRANSITIONS } from '../state/machine';
import { CONFIG, QUALITY_TIERS, type QualityTier } from '../config';
import { cubeTarget } from './PlaceholderScene';

// leva's `Schema` type isn't part of its public export surface; recover it structurally
// from `folder`'s first parameter (whose constraint IS Schema) so we never import an
// internal path. Dynamically-assembled schemas are built as Record<string, unknown> and
// handed over through a single `as unknown as LevaSchema` cast at each useControls call.
type LevaSchema = Parameters<typeof folder>[0];

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * The ONE write path for live config tuning. Config blocks are typed `as const` (deeply
 * readonly) yet are plain, mutable objects at runtime; this strips the readonly modifier
 * via a `Mutable<>` mapped-type cast so every consumer sees the tuned value immediately —
 * no `any`, lint-clean.
 */
function writeConfigLeaf(block: object, key: string, value: number | boolean): void {
  (block as Mutable<Record<string, number | boolean>>)[key] = value;
}

/**
 * Recursively turn a plain config block into a leva schema: number/boolean leaves become
 * live controls (onChange writes straight back into the block), nested plain objects
 * become collapsed sub-folders. Arrays of numbers (e.g. HEAT.tierThresholds, SPAWN.caps)
 * and string leaves (e.g. car names) are skipped — dev tooling favors readability over
 * completeness; tune those in code for now.
 */
function buildBlockSchema(block: Record<string, unknown>): Record<string, unknown> {
  const schema: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(block)) {
    if (typeof value === 'number' || typeof value === 'boolean') {
      schema[key] = {
        value,
        onChange: (next: number | boolean) => writeConfigLeaf(block, key, next),
      };
    } else if (Array.isArray(value)) {
      // Skipped by design (see doc comment above).
    } else if (value !== null && typeof value === 'object') {
      const nested = buildBlockSchema(value as Record<string, unknown>);
      if (Object.keys(nested).length > 0) {
        schema[key] = folder(nested as unknown as LevaSchema, { collapsed: true });
      }
    }
    // strings / functions: skipped.
  }
  return schema;
}

function buildConfigSchema(): Record<string, unknown> {
  const schema: Record<string, unknown> = {};
  for (const [blockName, block] of Object.entries(CONFIG)) {
    const inner = buildBlockSchema(block as Record<string, unknown>);
    if (Object.keys(inner).length > 0) {
      schema[blockName] = folder(inner as unknown as LevaSchema, { collapsed: true });
    }
  }
  return schema;
}

export default function DevPanel() {
  // Subscribe to machine only: it drives which transition buttons are valid and the
  // read-only state display. Rebuilds the Debug folder via the [machine] dep below.
  const machine = useGameStore((s) => s.machine);

  // --- Debug folder: state machine control + quality override ---
  useControls(
    'Debug',
    () => {
      const schema: Record<string, unknown> = {
        'machine state': { value: machine, disabled: true },
        quality: {
          value: getGameState().settings.quality,
          options: Object.keys(QUALITY_TIERS),
          onChange: (q: string) => {
            const state = getGameState();
            if (state.settings.quality !== q) state.setQuality(q as QualityTier);
          },
        },
      };
      // One button per *valid* transition out of the current state — every edge in the
      // TRANSITIONS table is reachable from the panel as the machine walks around.
      for (const to of TRANSITIONS[machine] ?? []) {
        schema[`→ ${to}`] = button(() => {
          const state = getGameState();
          // Guard: the machine may have moved between render and click (StrictMode / other
          // systems), so re-check before transitioning to avoid the store's dev-mode throw.
          if (canTransition(state.machine, to)) state.transition(to);
        });
      }
      return schema as unknown as LevaSchema;
    },
    [machine],
  );

  // --- Config folders: auto-built from the CONFIG registry, live-tunable ---
  useControls('Config', () => buildConfigSchema() as unknown as LevaSchema);

  // --- Placeholder-scene folder: proves leva → module-bus → scene wiring end to end ---
  useControls(
    'Placeholder Scene',
    () =>
      ({
        'cube X': {
          value: cubeTarget.x,
          min: -140,
          max: 140,
          step: 1,
          onChange: (v: number) => {
            cubeTarget.x = v;
            cubeTarget.dirty = true;
          },
        },
        'cube Z': {
          value: cubeTarget.z,
          min: -140,
          max: 140,
          step: 1,
          onChange: (v: number) => {
            cubeTarget.z = v;
            cubeTarget.dirty = true;
          },
        },
      }) as unknown as LevaSchema,
  );

  return <Leva collapsed />;
}
