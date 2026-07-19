// Phase 31 (Part-8 D1-D5, T1) — the thin Toronto transit adapter, mirroring TorontoTraffic.tsx's
// own shape exactly: mount-captured tier roster (config/torontoTransit.ts), a resolved seeded
// roster ASSIGNMENT (world/toronto/transitRoster.ts), TWO ai/streetcarTraffic.ts controllers
// (bus/streetcar — UNFORKED, only config/chassis differ — ai/TorontoTransitMount.tsx), pack/
// in-house body rendering, and the shared route-board overlay. Mounted once by game/index.tsx's
// Toronto branch (`<TorontoTransit key={...} seed={seed} />`), inside <Physics>.

import { useEffect, useMemo, useState } from 'react';
import { onImpact } from '../../combat/contacts';
import { TorontoTransitMount } from '../../ai/TorontoTransitMount';
import {
  torontoBusRef,
  torontoBusRouteIdsRef,
  torontoStreetcarRef,
  torontoStreetcarRouteIdsRef,
} from '../../ai/torontoTransitRefs';
import { StreetcarMesh } from '../../ai/StreetcarMesh';
import type { AvenuePath } from '../../ai/streetcarTraffic';
import {
  ROUTE_BOARD,
  TTC_BUS_TUNING,
  TTC_STREETCAR_TUNING,
  busChassisHalfExtents,
} from '../../config/torontoTransit';
import { useGameStore } from '../../state/store';
import { useDevToggle } from '../../core/devToggles';
import { torontoBusTransitRoster, torontoStreetcarTransitRoster } from './transitRoster';
import { TorontoBusMesh } from './cityPack/TorontoBusMesh';
import { TransitRouteBoards } from './cityPack/TransitRouteBoards';

export function TorontoTransit() {
  const seed = useGameStore((s) => s.seed);
  const unlit = useDevToggle('cityPackUnlit');

  // Mount-captured tier roster (the "next run, at mount" precedent every other Toronto tier
  // param follows — TorontoTraffic.tsx's own roster capture, config/torontoDress.ts's tierParams
  // doc comment). A mid-run quality change applies on the next keyed remount only.
  const [busRoster] = useState(() => torontoBusTransitRoster(seed, useGameStore.getState().settings.quality));
  const [streetcarRoster] = useState(() => torontoStreetcarTransitRoster(seed, useGameStore.getState().settings.quality));

  const busAvenues = useMemo((): readonly AvenuePath[] => busRoster.map((a) => a.avenue), [busRoster]);
  const streetcarAvenues = useMemo((): readonly AvenuePath[] => streetcarRoster.map((a) => a.avenue), [streetcarRoster]);
  const busEntries = useMemo(() => busRoster.map((a) => ({ id: a.route.id, label: a.label })), [busRoster]);
  const streetcarEntries = useMemo(() => streetcarRoster.map((a) => ({ id: a.route.id, label: a.label })), [streetcarRoster]);
  const busChassis = useMemo(() => busChassisHalfExtents(), []);

  // Publish per-slot route ids alongside the pose refs (ai/torontoTransitRefs.ts) — a debug-only
  // seam (core/debugBridge.ts's torontoTransitSlots()) so a scripted live check can identify
  // WHICH slot is driving a given route (e.g. "97") without threading route identity through the
  // physics controller itself.
  useEffect(() => {
    torontoBusRouteIdsRef.current = busRoster.map((a) => a.route.id);
    return () => {
      torontoBusRouteIdsRef.current = [];
    };
  }, [busRoster]);
  useEffect(() => {
    torontoStreetcarRouteIdsRef.current = streetcarRoster.map((a) => a.route.id);
    return () => {
      torontoStreetcarRouteIdsRef.current = [];
    };
  }, [streetcarRoster]);

  return (
    <>
      <TorontoTransitMount
        avenues={busAvenues}
        seed={seed}
        source={onImpact}
        apiRef={torontoBusRef}
        options={{
          config: TTC_BUS_TUNING,
          chassis: busChassis,
          exactRosterSize: true,
          isStreetcarEntry: false,
          pathMode: 'loop',
          startFracs: busRoster.map((a) => a.startFrac),
        }}
      />
      <TorontoTransitMount
        avenues={streetcarAvenues}
        seed={seed}
        source={onImpact}
        apiRef={torontoStreetcarRef}
        options={{
          config: TTC_STREETCAR_TUNING,
          exactRosterSize: true,
          isStreetcarEntry: true,
          startFracs: streetcarRoster.map((a) => a.startFrac),
        }}
      />

      <TorontoBusMesh capacity={busAvenues.length} maxHp={TTC_BUS_TUNING.hp} unlit={unlit} />
      <StreetcarMesh apiRef={torontoStreetcarRef} capacity={streetcarAvenues.length} maxHp={TTC_STREETCAR_TUNING.hp} />

      <TransitRouteBoards apiRef={torontoBusRef} capacity={busAvenues.length} entries={busEntries} heightWu={ROUTE_BOARD.busHeightWu} />
      <TransitRouteBoards
        apiRef={torontoStreetcarRef}
        capacity={streetcarAvenues.length}
        entries={streetcarEntries}
        heightWu={ROUTE_BOARD.streetcarHeightWu}
      />
    </>
  );
}
