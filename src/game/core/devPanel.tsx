// Dev-only leva tuning + debug panel. Code-split: game/index.tsx references this module
// only behind `import.meta.env.DEV ? lazy(() => import('./core/devPanel')) : null`, so the
// constant-false branch in production strips the dynamic import and leva never lands in a
// prod chunk. Rendered in the DOM tree (outside <Canvas>) — <Leva> is an HTML overlay.
//
// This panel is the shared debug surface that EVERY later gameplay phase extends (force
// tier, grant heat, spawn unit X, blackout district, teleport, invincible, chaos bench…),
// so it is structured around a top-level "Debug" folder plus auto-generated config folders.

import { Quaternion, Euler, Color } from 'three';
import { useControls, folder, button, monitor, Leva } from 'leva';
import { getGameState, useGameStore } from '../state/store';
import { canTransition, TRANSITIONS } from '../state/machine';
import { CONFIG, QUALITY_TIERS, type QualityTier } from '../config';
import { playerVehicle } from '../vehicles/playerRef';
import { spawnPoseRef } from '../world/spawn';
import type { VehiclePose } from '../vehicles/IVehicleModel';
import { getDevToggles, setDevToggle } from './devToggles';
import { ARCHETYPES, EMISSIVE_ARCHETYPES } from '../world/archetypes';
import { DISTRICT_COUNT, setDistrictColor, setDistrictEmissive } from '../world/instancing';

// Task 5 debug-tint colour: the ONE end-to-end proof that an archetype's district-grouped
// [start,count] ranges (world/instancing.ts) are correct — a single button recolours every
// instance in exactly one district, nothing else. Module-scope: one Color, reused per click.
const TINT_COLOR = new Color('#ff2222');

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

/**
 * Strips pitch/roll from a pose's rotation, keeping only yaw (rotation about world Y).
 * Backs the "flip recover" debug button: a car resting on its roof/side should come back
 * down right-side up, not just get nudged upward in whatever orientation it flipped to.
 */
function yawOnlyRotation(rotation: VehiclePose['rotation']): VehiclePose['rotation'] {
  const euler = new Euler().setFromQuaternion(
    new Quaternion(rotation.x, rotation.y, rotation.z, rotation.w),
    'YXZ',
  );
  const yaw = new Quaternion().setFromEuler(new Euler(0, euler.y, 0, 'YXZ'));
  return { x: yaw.x, y: yaw.y, z: yaw.z, w: yaw.w };
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

      // Live speed readout: a Function-form monitor() polls playerVehicle on its own
      // interval, so this stays accurate without a store subscription (per-frame vehicle
      // state deliberately never lives in zustand — see state/store.ts). Reads 0 until a
      // later task mounts the player vehicle; null-safe either way.
      schema['speed (m/s)'] = monitor(() => playerVehicle.current?.readState().speed ?? 0, {
        interval: 100,
      });

      // Flip recover: keep the vehicle's current XZ + yaw, lift it 1 m and drop the
      // pitch/roll so a car stuck on its roof (or wedged on a test-scene box) rights
      // itself. No-op if no run is live.
      schema['flip recover'] = button(() => {
        const vehicle = playerVehicle.current;
        if (!vehicle) return;
        const { position, rotation } = vehicle.readState().pose;
        vehicle.reset({
          position: { x: position.x, y: position.y + 1, z: position.z },
          rotation: yawOnlyRotation(rotation),
        });
      });

      // Teleport reset: back to spawn, identity yaw. No-op if no run is live.
      schema['teleport reset'] = button(() => {
        playerVehicle.current?.reset(spawnPoseRef.current);
      });

      return schema as unknown as LevaSchema;
    },
    [machine],
  );

  // --- World folder: seed control + regenerate/randomize, dev-tool visibility toggles ---
  // Split into two useControls calls (both `deps: []`, so leva builds each schema exactly
  // once and never rebuilds it): leva's `useControls` re-fires every onChange with
  // `{initial: true}` whenever its schema is rebuilt (i.e. whenever `deps` changes) — so a
  // single call with `seed`'s onChange writing into a piece of React state that's ALSO in
  // that same call's `deps` is a feedback loop (typing/"randomize" → state changes → deps
  // change → schema rebuilds → onChange re-fires with whatever leva's store held at that
  // instant → can clobber the just-written value straight back to stale). Keeping `deps: []`
  // sidesteps that entirely: leva owns the field's live value itself once mounted, and
  // `getSeed`/`setSeed` (leva's own store accessors, returned because the schema arg is a
  // function — see leva's useControls.d.ts) read/write it directly, imperatively, without
  // ever needing this component to re-render or its schema to rebuild.
  //
  // `getSeed`/`setSeed` must come from an EARLIER, separate call: referencing a
  // useControls call's own return value inside a button defined by that SAME call trips
  // eslint-plugin-react-hooks' `immutability` rule (flagged as "used before declared" even
  // though the closure only runs on click, well after the const exists) — splitting into a
  // fields-only call followed by a buttons/toggles call keeps every reference strictly
  // textually-after its declaration.
  // `getWorldField` is the folder's generic (path-keyed) getter — used below for both
  // `seed` (regenerate/randomize) and `tintDistrict` (the Task 5 tint/blackout buttons),
  // per the doc comment above on why fields and buttons must live in separate calls.
  const [, setSeed, getWorldField] = useControls(
    'World',
    () => ({
      seed: { value: getGameState().seed, step: 1 },
      // Task 5 debug proof target district (0..DISTRICT_COUNT-1, 4x4 grid): which
      // district the tint/blackout/relight buttons below act on.
      tintDistrict: { value: 0, min: 0, max: DISTRICT_COUNT - 1, step: 1 },
    }),
    [],
  );
  useControls(
    'World',
    () => ({
      // Changing the store's seed IS the regeneration trigger — the city subtree remounts
      // keyed on it (Task 3). This button (not the field's onChange) is what actually
      // fires it, so typing a seed never regenerates until asked to.
      regenerate: button(() => getGameState().setSeed(getWorldField('seed'))),
      // Math.random is fine here: a dev-only button, not part of generation itself.
      randomize: button(() => {
        const next = Math.floor(Math.random() * 0xffffffff);
        setSeed({ seed: next });
        getGameState().setSeed(next);
      }),
      minimap: {
        value: getDevToggles().minimap,
        onChange: (value: boolean) => setDevToggle('minimap', value),
      },
      graphViz: {
        value: getDevToggles().graphViz,
        onChange: (value: boolean) => setDevToggle('graphViz', value),
      },
      // Task 5 district-range proof: each button fans over every archetype (or every
      // EMISSIVE archetype) and writes exactly one district's [start,count] slice. Eyeball
      // adjacent districts in the result — only `tintDistrict`'s district should change.
      'tint district (red)': button(() => {
        const d = getWorldField('tintDistrict');
        for (const name of ARCHETYPES) setDistrictColor(name, d, TINT_COLOR);
      }),
      'blackout district': button(() => {
        const d = getWorldField('tintDistrict');
        for (const name of EMISSIVE_ARCHETYPES) setDistrictEmissive(name, d, 0);
      }),
      'relight district': button(() => {
        const d = getWorldField('tintDistrict');
        for (const name of EMISSIVE_ARCHETYPES) setDistrictEmissive(name, d, 1);
      }),
    }),
    [],
  );

  // --- Config folders: auto-built from the CONFIG registry, live-tunable ---
  useControls('Config', () => buildConfigSchema() as unknown as LevaSchema);

  // Default top-right position sits directly under the fixed 64 px site header (z-index
  // 50) and is unclickable there; offsetting the title bar down clears it. `y: 70` is a
  // few px of breathing room below the header, `x: 0` keeps the default horizontal spot.
  return <Leva collapsed titleBar={{ position: { x: 0, y: 70 } }} />;
}
