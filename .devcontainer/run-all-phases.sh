#!/usr/bin/env bash
#
# Drives the Smashy the 6ix build to completion: runs `/next-phase` in a brand-new
# `claude -p` process, waits for it to finish, checks CLAUDE.md's Phase checklist,
# and repeats. Each iteration is a fresh process with zero prior context — that
# process boundary IS the "clear," so there's no in-session /clear step needed.
#
# Stops (does not loop further) when:
#   - every phase in the checklist is [x]                          -> exit 0, done
#   - a phase comes back [!] (USER GATE / blocked, needs a human)   -> exit 2
#   - `claude` exits non-zero (a real error)                        -> exit 1
#   - the checklist is unchanged after a run (stuck / silent fail)  -> exit 3
#   - MAX_ITERATIONS is hit (backstop against a runaway loop)       -> exit 4
#
# Intended to run inside the project's sandboxed devcontainer (this is exactly
# what its firewall + --cap-add NET_ADMIN/NET_RAW setup is for), but nothing here
# is container-specific — it'll run anywhere `claude` is on PATH.
#
# Usage:
#   ./run-all-phases.sh                     # run until done or a stop condition
#   MAX_ITERATIONS=1 ./run-all-phases.sh    # test a single phase run first
#   MAX_BUDGET_USD=5 ./run-all-phases.sh    # cap spend PER PHASE RUN (not a lifetime total —
#                                            # real exposure is roughly this * phases remaining)
#
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

CLAUDE_MD="CLAUDE.md"
LOG_DIR=".planning/run-logs"
mkdir -p "$LOG_DIR"

MAX_ITERATIONS="${MAX_ITERATIONS:-25}"   # 20 phases + headroom for reruns after a fix
MAX_BUDGET_USD="${MAX_BUDGET_USD:-}"     # unset = no per-run cap

# Scope every check to the "## Phase checklist" section only — CLAUDE.md's exit
# protocol also has its own `- [ ]` checkboxes earlier in the file, which must NOT
# be counted here.
checklist_section() {
  sed -n '/^## Phase checklist$/,/^## Locked decisions/p' "$CLAUDE_MD"
}

any_incomplete() {
  checklist_section | grep -qE '^- \[[ ~]\]'
}

any_blocked() {
  checklist_section | grep -qE '^- \[!\]'
}

fingerprint() {
  checklist_section | grep -oE '^- \[.\]' | tr -d '\n'
}

iteration=0
while (( iteration < MAX_ITERATIONS )); do
  iteration=$((iteration + 1))

  if ! any_incomplete; then
    echo "[run-all-phases] All phases are [x]. Done."
    exit 0
  fi

  if any_blocked; then
    echo "[run-all-phases] A phase is [!] (blocked / awaiting user)."
    echo "[run-all-phases] Check .planning/phases/phase-NN-notes.md for what's being asked, respond to it, then re-run this script."
    exit 2
  fi

  before="$(fingerprint)"
  ts="$(date +%Y%m%d-%H%M%S)"
  log="$LOG_DIR/phase-run-$ts.log"
  echo "[run-all-phases] Iteration $iteration/$MAX_ITERATIONS — fresh session, logging to $log"

  budget_flag=()
  if [[ -n "$MAX_BUDGET_USD" ]]; then
    budget_flag=(--max-budget-usd "$MAX_BUDGET_USD")
  fi

  claude --dangerously-skip-permissions -p "/next-phase then commit" \
    --name "phase-run-$ts" \
    "${budget_flag[@]}" \
    2>&1 | tee "$log"
  status="${PIPESTATUS[0]}"

  if [[ "$status" -ne 0 ]]; then
    echo "[run-all-phases] claude exited $status — stopping. See $log."
    exit 1
  fi

  after="$(fingerprint)"
  if [[ "$before" == "$after" ]]; then
    echo "[run-all-phases] Checklist didn't change this run — stopping to avoid looping silently. See $log."
    exit 3
  fi

  echo "[run-all-phases] Progress: $before -> $after"
done

echo "[run-all-phases] Hit MAX_ITERATIONS ($MAX_ITERATIONS) without finishing. See logs in $LOG_DIR."
exit 4
