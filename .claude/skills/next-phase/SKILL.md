---
name: next-phase
description: Starts the next unit of work on the Smashy the 6ix portfolio-game build. Finds the first unchecked phase in CLAUDE.md's Phase checklist and immediately runs the full session protocol for it — load context, plan, implement via subagents, verify, exit. Use whenever the user wants to start, resume, or continue building the project, asks what's next, or types /next-phase. This invocation IS the confirmation to proceed — don't ask the user which phase to work on or whether to begin; the checklist and repo state already answer that.
model: fable
---

# next-phase

Entry point for a build session. Its only job is to identify the next open phase and
launch straight into CLAUDE.md's session protocol for it — skip the "which phase should
I do?" back-and-forth entirely.

## 1. Identify the phase

Read the **Phase checklist** in `CLAUDE.md`. Scan top to bottom for the first entry not
marked `[x]`:

| Status | Meaning | What to do |
|---|---|---|
| `[ ]` todo | Not started | Start it fresh — full protocol below. |
| `[~]` in progress | A prior session didn't finish | Read `.planning/phases/phase-NN-plan.md` and any partial `phase-NN-notes.md` before touching code. Resume the work, don't restart it. |
| `[!]` blocked / awaiting user | Waiting on a decision or USER GATE | Check `.planning/phases/phase-NN-notes.md` for what was asked. If it's been answered somewhere in this conversation, proceed. If it's still open, stop and ask for exactly that — do not skip ahead to the next `[ ]` phase instead. |

If the repo state contradicts the checklist (code already exists for a phase still
marked `[ ]`, or a phase marked done doesn't actually build), trust the repo + `git log`,
fix the checklist, then proceed — this matches CLAUDE.md's own orientation step.

## 2. Build it

Once the phase is identified, run CLAUDE.md's "How to work (session protocol)" steps 2–7
against it: load context → verify preconditions → write the phase plan → implement via
subagents → verify every acceptance criterion → exit protocol (checklist update, handoff
notes, commit + push, USER GATE handling if applicable).

CLAUDE.md is the authoritative version of those steps — follow it there rather than a
copy here, since it's what gets updated as the project's conventions evolve across
phases.

Go straight into step 2 without a confirmation message. Only stop mid-session for the
reasons CLAUDE.md already calls out: a failed precondition, a locked decision that needs
the user, or a USER GATE.

One phase per session, per CLAUDE.md — if this phase finishes early, put the remaining
budget into verification and polish, not a second phase.
