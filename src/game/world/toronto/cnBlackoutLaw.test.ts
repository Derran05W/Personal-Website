// Phase 44 — THE BLACKOUT LAW. "The CN Tower stays lit through DARK CITY" is the point of the
// money shot (part-11-civic-heart-landmarks.md, Phase 44's Decisions table): the tower's night
// program must be STRUCTURALLY INCAPABLE of joining a district blackout, not merely "currently"
// independent of it. This is a source-scan test — same node:fs idiom as
// config/layeringGuard.test.ts (read the real files off disk, regex the pattern, fail loud) —
// so wiring the program into the power grid later becomes an immediate, unmissable test failure
// instead of a screenshot someone forgets to take.
//
// The regex matches only real IMPORT SPECIFIERS (`import ... from '<path>'`, `export ... from
// '<path>'`, or a dynamic `import('<path>')`), never prose: cnTower.ts's and cnNightProgram.ts's
// own header comments explain this very law using the words "powergrid"/"grid" in plain English,
// so a naive substring scan would trip on its own documentation. A positive-control test below
// proves the scanner isn't vacuously green — it's pointed at TorontoScene.tsx, which legitimately
// DOES import from `powergrid/` for the real blackout chain, and must still be flagged.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** The night-program's own files — none of these may ever import from `powergrid/`. */
const NIGHT_PROGRAM_FILES: readonly string[] = [
  'src/game/world/toronto/cnNightProgram.ts',
  'src/game/world/toronto/cnNightMaterial.ts',
  'src/game/config/cnTower.ts',
  'src/game/world/toronto/heroes.ts',
];

/** Matches a real import/export specifier or a dynamic import call; captures the module path.
 * Deliberately does NOT match a bare mention of the word inside a `//` or `/* ... *\/` comment —
 * `isCommentLine` below strips those lines before this ever runs against them. */
const IMPORT_SPECIFIER_RE = /(?:\bfrom\s*['"]([^'"]+)['"])|(?:\bimport\(\s*['"]([^'"]+)['"]\s*\))/g;

function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

interface Offense {
  readonly file: string;
  readonly lineNo: number;
  readonly specifier: string;
}

function scanFileForPowergridImports(relPath: string): Offense[] {
  const abs = resolve(process.cwd(), relPath);
  const lines = readFileSync(abs, 'utf-8').split('\n');
  const offenses: Offense[] = [];
  lines.forEach((rawLine, index) => {
    if (isCommentLine(rawLine)) return;
    IMPORT_SPECIFIER_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = IMPORT_SPECIFIER_RE.exec(rawLine)) !== null) {
      const specifier = m[1] ?? m[2] ?? '';
      if (specifier.includes('powergrid')) {
        offenses.push({ file: relPath, lineNo: index + 1, specifier });
      }
    }
  });
  return offenses;
}

describe('CN Tower blackout law (Phase 44) — the night program cannot import powergrid/', () => {
  it('none of the night-program files import from powergrid/', () => {
    const offenses = NIGHT_PROGRAM_FILES.flatMap(scanFileForPowergridImports);
    const rendered = offenses.map((o) => `${o.file}:${o.lineNo}: imports "${o.specifier}"`);
    expect(
      rendered,
      offenses.length === 0
        ? undefined
        : `Found ${offenses.length} import(s) from powergrid/ in night-program files — this breaks ` +
          `the blackout law ("CN stays lit through DARK CITY"):\n${rendered.join('\n')}`,
    ).toEqual([]);
  });

  it('positive control: the scanner really does flag a real powergrid import elsewhere', () => {
    // TorontoScene.tsx legitimately imports LightPool/torontoStreetlightEmitters from powergrid/
    // for the actual blackout chain — proving this regex isn't vacuously passing because it never
    // matches anything real.
    const offenses = scanFileForPowergridImports('src/game/world/toronto/TorontoScene.tsx');
    expect(offenses.length).toBeGreaterThan(0);
  });

  it('positive control #2 (Phase 45): the ROGERS night material may — and does — import powergrid', () => {
    // The law is CN-ONLY, and this is the file that proves the distinction is deliberate rather
    // than an oversight. The Rogers Centre DIMS with its district (a lit stadium beside a dark
    // skyline would dilute the very money shot CN's law exists to protect), so
    // rogersNightMaterial.ts reads the grid's dark state and drives its own `uDark` uniform.
    // If someone ever "fixes" this by cutting that import, this control fails and asks why.
    const offenses = scanFileForPowergridImports('src/game/world/toronto/rogersNightMaterial.ts');
    expect(offenses.length).toBeGreaterThan(0);
  });

  it('the Rogers program BRAIN stays pure even though its material may read the grid', () => {
    // The split that keeps every timing function unit-testable: rogersProgram.ts takes the dark
    // state as an argument and imports nothing from powergrid/ (rogersProgram.test.ts scans the
    // same file for `three` and clock reads too — this assertion is the grid half, kept here next
    // to its CN sibling so the two hero policies read as one story).
    expect(scanFileForPowergridImports('src/game/world/toronto/rogersProgram.ts')).toEqual([]);
    expect(scanFileForPowergridImports('src/game/config/rogersCentre.ts')).toEqual([]);
  });

  it('positive control: a commented-out mention of the word does NOT trip the scanner', () => {
    // heroes.ts and cnNightProgram.ts both explain this law in prose using the words
    // "powergrid"/"grid" — confirm those files are readable and the comment-stripping actually
    // exempts prose (the file-level test above already proves this in aggregate; this asserts it
    // directly against a synthetic line so the guard logic itself is unit-tested).
    const synthetic = [
      "// this module deliberately knows nothing about powergrid/grid.ts's districts",
      "import { CN_TOWER } from '../../config/cnTower';",
    ].join('\n');
    const offenses: Offense[] = [];
    synthetic.split('\n').forEach((rawLine, index) => {
      if (isCommentLine(rawLine)) return;
      IMPORT_SPECIFIER_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = IMPORT_SPECIFIER_RE.exec(rawLine)) !== null) {
        const specifier = m[1] ?? m[2] ?? '';
        if (specifier.includes('powergrid')) offenses.push({ file: 'synthetic', lineNo: index + 1, specifier });
      }
    });
    expect(offenses).toEqual([]);
  });
});
