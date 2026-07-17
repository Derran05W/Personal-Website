// R3F mount for the power-grid flicker sequencer (Phase 13 Task 1). A render-null system that
// does one job: drive tickFlickers() once per fixed physics step from useAfterPhysicsStep, the
// same fixed-step cadence world/propDynamics.ts uses (PHYSICS_STEP_SEC accumulates simulation
// time exactly, and stops while paused — a paused game freezes any in-progress flicker for free).
//
// MUST live inside <Physics> (uses the Rapier after-step hook). Integration mounts it alongside
// CityScape, KEYED ON THE WORLD KEY (`grid-${seed}-${runId}`) like the other seed-scoped systems
// so its unmount cleanup drops all flicker/dark state on a regenerate or retry.
//
// It owns no blackout triggers of its own — Task 2's powergrid/grid.ts subscribes
// `transformerDestroyed` and calls blackoutDistrict(). In DEV it also installs a small
// `window.__smashyGrid` bridge so a blackout can be driven from a Playwright/console harness
// before Task 4's debug-panel buttons land; the bridge is DEV-only (stripped from prod) and is
// the clean surface Task 4's tooling can call into or supersede.

import { useEffect } from 'react';
import { useAfterPhysicsStep } from '@react-three/rapier';
import { PHYSICS_STEP_SEC } from '../world/propDynamics';
import {
  activeFlickerCount,
  blackoutDistrict,
  clearFlickers,
  isDistrictDark,
  isDistrictFlickering,
  relightDistrict,
  setDistrictDark,
  tickFlickers,
} from './emitters';

export function PowerGridSystem() {
  useAfterPhysicsStep(() => {
    tickFlickers(PHYSICS_STEP_SEC);
  });

  useEffect(() => {
    if (import.meta.env.DEV) installGridDebugBridge();
    // On unmount (city remount / route-away) forget every district's flicker/dark state so the
    // next run starts with a fully lit grid.
    return () => {
      clearFlickers();
      if (import.meta.env.DEV) delete window.__smashyGrid;
    };
  }, []);

  return null;
}

// ===========================================================================================
// DEV bridge (dead-code-eliminated from prod builds by the import.meta.env.DEV guards).
// ===========================================================================================

declare global {
  interface Window {
    /** DEV-only power-grid debug surface. Drives the flicker sequencer for scripted/console
     * verification until Task 4's debug-panel buttons wire the same calls. */
    __smashyGrid?: {
      /** Start district `n`'s flicker → permanent blackout (the real gameplay path). */
      blackout: (n: number) => void;
      /** Instantly force district `n` fully dark (no flicker). */
      dark: (n: number) => void;
      /** Debug: re-light district `n`. */
      relight: (n: number) => void;
      /** True while district `n` is mid-flicker. */
      flickering: (n: number) => boolean;
      /** True once district `n` has settled permanently dark. */
      isDark: (n: number) => boolean;
      /** Count of districts currently mid-flicker. */
      activeCount: () => number;
    };
  }
}

function installGridDebugBridge(): void {
  window.__smashyGrid = {
    blackout: (n) => blackoutDistrict(n),
    dark: (n) => setDistrictDark(n),
    relight: (n) => relightDistrict(n),
    flickering: (n) => isDistrictFlickering(n),
    isDark: (n) => isDistrictDark(n),
    activeCount: () => activeFlickerCount(),
  };
}
