// A SEPARATE, small MeshLambertMaterial for the Phase 19 Toronto landmark buildings (CN
// Tower/Stadium/Flatiron) — reuses the EXACT SAME palette atlas texture as
// world/palette.ts's getCityMaterial() (same colours, zero extra texture memory), but is NOT
// that shared singleton.
//
// Why not just getCityMaterial()? These three one-off landmarks need `fog: false` — "reads
// at any distance" per the phase-19 brief: a 640 m map's wayfinding landmark can't fade into
// the blue-hour distance fog every OTHER city object deliberately uses (BlueHourRig). Fog is
// a MATERIAL-level flag, and getCityMaterial() is ONE memoized singleton shared by every
// building/street-prop/unit in the game (world/palette.ts's whole point) — disabling fog on
// it would disable it for the entire city, not just these three landmarks. They also don't
// need that material's onBeforeCompile per-instance-emissive shader patch (gated by an
// InstancedMesh's aEmissiveOn attribute): none of the three are blackout participants, and
// the CN Tower's antenna beacon is instead a SEPARATE small dedicated mesh with its own
// pulsing MeshBasicMaterial (world/landmarks/CnTower.tsx) — the same "small dedicated FX
// mesh outside the palette system" idiom fx/Searchlight.tsx and ai/HeliMesh.tsx's ground
// blob already use for effects the shared material can't (or shouldn't) express.

import { MeshLambertMaterial } from 'three';
import { getCityMaterial } from '../palette';

let landmarkMaterial: MeshLambertMaterial | null = null;

/** THE shared material for every landmark body mesh (memoized singleton, mirrors
 * getCityMaterial()'s own shape). Samples the SAME CanvasTexture getCityMaterial() built —
 * never rebuilds the atlas — so landmark colours stay pixel-identical to the rest of the
 * city's palette. */
export function getLandmarkMaterial(): MeshLambertMaterial {
  if (landmarkMaterial !== null) return landmarkMaterial;
  landmarkMaterial = new MeshLambertMaterial({ map: getCityMaterial().map, fog: false });
  return landmarkMaterial;
}

/** Dispose + drop the singleton. Does NOT dispose the shared map texture — getCityMaterial()
 * still owns and disposes that (world/palette.ts's disposeCityMaterial). */
export function disposeLandmarkMaterial(): void {
  if (landmarkMaterial === null) return;
  landmarkMaterial.dispose();
  landmarkMaterial = null;
}
