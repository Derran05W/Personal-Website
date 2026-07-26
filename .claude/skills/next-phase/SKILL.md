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
| `[!]` blocked / awaiting user | Waiting on a decision or USER GATE | Check `.planning/phases/phase-NN-notes.md` for what was asked. If it's been answered somewhere in this conversation, proceed. If still open, apply the gating test below. |

**Gating test for `[!]` phases:** a `[!]` entry stops the session ONLY if the first
runnable (`[ ]` or `[~]`) phase *consumes* the blocked item — its part file or
preconditions need the answer (e.g. Phase 34 consumed Phase 33's camera pick; it could
not start without it). Standing user-side items that gate nothing downstream (phone
test, real content, Vercel connect, launch approval, attribution details — CLAUDE.md's
"standing ledger") do NOT stop the scan: carry them in the final message per the
ledger convention and continue to the first runnable phase. If every incomplete phase
is `[!]`, stop and surface all open asks — nothing is runnable.

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

## 3. Loops & context budget

**Never start a phase in a session that has already run one.** If this skill fires in
a conversation that already completed (or substantially progressed) a phase — e.g. via
`/loop`, a scheduled wakeup, or the user re-typing `/next-phase` — do NOT begin the
next phase on top of the old context. One phase per session is CLAUDE.md law, and a
session's leftover context degrades the next phase's quality. Instead: say the session
is spent, name the next open phase, and point at the runner below. (You cannot fix
this yourself: no skill, hook, or tool can trigger `/clear` or `/compact` — context
only resets at a process boundary.)

**The sanctioned loop** is `.devcontainer/run-all-phases.sh`: it runs `/next-phase` in
a brand-new `claude -p` process per phase, so every phase starts at zero context —
"loop → clear → next-phase" semantics with no in-session clearing needed. It stops on
a USER GATE, a stuck checklist, or an error, and supports `MAX_ITERATIONS`,
`MAX_BUDGET_USD`, and `PERMISSION_ARGS` (default `--dangerously-skip-permissions`,
sized for the sandboxed devcontainer; set
`PERMISSION_ARGS="--permission-mode acceptEdits"` for a more guarded local run).
Do not use in-session `/loop` to chain phases — it accumulates context by design.
