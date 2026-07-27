// Phase 39 — the ground-stack ladder LITERAL GUARD. Written test-first alongside
// layering.test.ts (CLAUDE.md's map-phase workflow contract: write the tests, watch them fail,
// implement to green). This is a source-scan test (same `node:fs` idiom as
// world/toronto/data.test.ts / assets/cityPackManifest.test.ts): it reads the real files off
// disk and greps for the hand-picked ground-Y / wall-offset epsilons `.planning/part-10-
// placement-integrity.md`'s audit catalogued — SKID.yOffset 0.030 tying the rainbow-crosswalk
// stripe Y in placesLayer.ts, SEARCHLIGHT.ground.yOffset 0.050 tying WATER_Y in
// TorontoScene.tsx, the duplicate `const off = 0.05` in TorontoScene.tsx's decalTransform (a
// second hand-copy of torontoMaterials.ts's CROWN_DECAL.offsetWu), and the three independent
// wall-offset copies in world.ts/torontoMaterials.ts/placesLayer.ts/venueDress.ts. Every one of
// those literals must migrate to `layering.ts`'s GROUND_STACK/WALL_STACK; this test fails today
// (module doesn't exist to migrate to, and the literals are all still in place) and must pass,
// unchanged, once the migration lands.
//
// DELIBERATELY NOT SCANNED: the legacy 64×64 world (src/game/world/CityScape.tsx,
// src/game/world/geometry/**) — de-imported from the shipped game chunk since the Phase 32
// flip (CLAUDE.md's "Map" locked decision) but still in-repo pending a user-approved
// `chore: legacy excision` pass. CityScape.tsx's own `ROAD_Y = 0.01` is a KNOWN legacy literal
// that stays exactly as-is until that excision — migrating it now would touch dead code for no
// behavioral benefit and risk the "never touch legacy behavior" rule elsewhere in CLAUDE.md.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** The eight producers the Phase 39 plan names as migration targets. Paths are relative to the
 * repo root (`process.cwd()` under vitest — same convention as data.test.ts's `readJson`). */
const SCANNED_FILES: readonly string[] = [
  'src/game/world/toronto/TorontoScene.tsx',
  'src/game/world/toronto/roadPaint.ts',
  'src/game/world/toronto/placesLayer.ts',
  'src/game/world/toronto/venueDress.ts',
  'src/game/world/toronto/worldEdgeGeometry.ts',
  'src/game/config/fx.ts',
  'src/game/config/torontoMaterials.ts',
  'src/game/config/world.ts',
];

interface ForbiddenPattern {
  /** Human-readable label for the failure message. */
  readonly label: string;
  readonly regex: RegExp;
  /** A line is exempt from this ONE pattern (not from the whole scan) if it contains any of
   * these substrings — the migrated code reading FROM the ladder legitimately mentions the
   * ladder by name on the same line (e.g. `const ROAD_Y = GROUND_STACK.roadSurface;`). */
  readonly exemptSubstrings: readonly string[];
}

// Verbatim from the Phase 39 plan's literal-guard spec. Each targets one of the hand-picked
// epsilon shapes the audit found; the exemptions are narrow (substring, not pattern-wide) so a
// migrated call site that legitimately assigns FROM the ladder doesn't re-trip its own guard.
const FORBIDDEN_PATTERNS: readonly ForbiddenPattern[] = [
  {
    label: 'bare "_Y = <literal>" ground-offset constant',
    regex: /_Y\s*=\s*0?\.\d/,
    // SIDEWALK.curbHeightWu-derived constants (e.g. CURB_TOP_Y) legitimately derive from the
    // sidewalk-height config, not the ladder, so a line deriving from either is exempt.
    exemptSubstrings: ['GROUND_STACK', 'SIDEWALK.curbHeightWu'],
  },
  {
    label: 'bare "yOffset: <literal>" property',
    regex: /yOffset:\s*0?\.\d/,
    exemptSubstrings: ['GROUND_STACK'],
  },
  {
    label: 'bare "FACE_OFFSET = <literal>" constant',
    regex: /FACE_OFFSET\s*=\s*0?\.\d/,
    exemptSubstrings: ['WALL_STACK'],
  },
  {
    label: 'bare "offsetWu: <literal>" property',
    regex: /offsetWu:\s*0?\.\d/,
    exemptSubstrings: ['WALL_STACK'],
  },
  {
    label: 'bare "const off = <literal>" (the decalTransform duplicate)',
    regex: /const off\s*=\s*0?\.\d/,
    exemptSubstrings: [], // no exceptions — this exact shape must die outright, per the plan.
  },
  {
    label: 'bare "windowInsetM/lightInsetM: <literal>" property',
    regex: /(windowInsetM|lightInsetM):\s*0?\.\d/,
    exemptSubstrings: ['WALL_STACK'],
  },
  {
    label: 'bare "BOX_BASE_LIFT_WU = <literal>" constant',
    regex: /BOX_BASE_LIFT_WU\s*=\s*0?\.\d/,
    exemptSubstrings: ['GROUND_STACK'],
  },
];

/** True for a pure comment line — a single-line `//` comment or a `/** ... *\/`-block
 * continuation line starting with `*` — so prose that happens to mention a literal (e.g. a
 * doc comment citing "y=0.01" for context) never counts as a code offense. */
function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*');
}

interface Offense {
  readonly file: string;
  readonly lineNo: number;
  readonly label: string;
  readonly text: string;
}

function scanFile(relPath: string): Offense[] {
  const abs = resolve(process.cwd(), relPath);
  const lines = readFileSync(abs, 'utf-8').split('\n');
  const offenses: Offense[] = [];
  lines.forEach((rawLine, index) => {
    if (isCommentLine(rawLine)) return;
    for (const pattern of FORBIDDEN_PATTERNS) {
      if (!pattern.regex.test(rawLine)) continue;
      if (pattern.exemptSubstrings.some((needle) => rawLine.includes(needle))) continue;
      offenses.push({ file: relPath, lineNo: index + 1, label: pattern.label, text: rawLine.trim() });
    }
  });
  return offenses;
}

describe('layering ladder guard — no ground-Y / wall-offset literal survives outside layering.ts', () => {
  it('none of the scanned producers contain a forbidden hand-picked literal', () => {
    const offenses = SCANNED_FILES.flatMap(scanFile);
    const rendered = offenses.map((o) => `${o.file}:${o.lineNo}: [${o.label}] ${o.text}`);
    expect(
      rendered,
      offenses.length === 0
        ? undefined
        : `Found ${offenses.length} literal(s) that must migrate to layering.ts's GROUND_STACK/WALL_STACK:\n${rendered.join('\n')}`,
    ).toEqual([]);
  });
});
