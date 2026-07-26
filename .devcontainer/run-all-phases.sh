#!/usr/bin/env bash
#
# Drives the Smashy the 6ix build to completion: runs `/next-phase` in a brand-new
# `claude -p` process, waits for it to finish, checks CLAUDE.md's Phase checklist,
# and repeats. Each iteration is a fresh process with zero prior context — that
# process boundary IS the "clear," so there's no in-session /clear step needed.
#
# Stops (does not loop further) when:
#   - every phase in the checklist is [x]                          -> exit 0, done
#   - a run ADDS a [!] (its phase hit a USER GATE / got blocked)    -> exit 2
#   - only [!] phases remain (everything runnable is user-blocked)  -> exit 2
#   - `claude` exits non-zero (a real error)                        -> exit 1
#   - the checklist is unchanged after a run (stuck / silent fail)  -> exit 3
#   - MAX_ITERATIONS is hit (backstop against a runaway loop)       -> exit 4
#
# PRE-EXISTING [!] phases do NOT stop the loop: the checklist carries standing
# awaiting-user items (phone test, content, launch approval) that gate nothing
# downstream — the /next-phase skill's gating test decides per session whether a
# [!] actually blocks the next runnable phase. What stops the loop is a phase
# COMING BACK [!] from a run (a fresh gate that needs a human), detected as a
# blocked-count increase.
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
#   PERMISSION_ARGS="--permission-mode acceptEdits" ./run-all-phases.sh
#                                           # local-machine run with guarded permissions
#                                           # (default: --dangerously-skip-permissions,
#                                           # sized for the sandboxed devcontainer)
#
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

CLAUDE_MD="CLAUDE.md"
LOG_DIR=".planning/run-logs"
mkdir -p "$LOG_DIR"

MAX_ITERATIONS="${MAX_ITERATIONS:-25}"   # 20 phases + headroom for reruns after a fix
MAX_BUDGET_USD="${MAX_BUDGET_USD:-}"     # unset = no per-run cap
PERMISSION_ARGS="${PERMISSION_ARGS:---dangerously-skip-permissions}"
# Word-split PERMISSION_ARGS into an array so multi-flag overrides work.
read -r -a permission_args <<< "$PERMISSION_ARGS"

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

blocked_count() {
  # grep -c exits 1 on zero matches (it still prints "0"); don't let pipefail kill us.
  checklist_section | grep -cE '^- \[!\]' || true
}

fingerprint() {
  checklist_section | grep -oE '^- \[.\]' | tr -d '\n'
}

iteration=0
while (( iteration < MAX_ITERATIONS )); do
  iteration=$((iteration + 1))

  if ! any_incomplete; then
    if any_blocked; then
      echo "[run-all-phases] No runnable phases left — every remaining phase is [!] (awaiting user)."
      echo "[run-all-phases] Check .planning/phases/phase-NN-notes.md for the open asks, answer them, then re-run."
      exit 2
    fi
    echo "[run-all-phases] All phases are [x]. Done."
    exit 0
  fi

  before="$(fingerprint)"
  before_blocked="$(blocked_count)"
  ts="$(date +%Y%m%d-%H%M%S)"
  log="$LOG_DIR/phase-run-$ts.log"
  echo "[run-all-phases] Iteration $iteration/$MAX_ITERATIONS — fresh session, logging to $log"

  budget_flag=()
  if [[ -n "$MAX_BUDGET_USD" ]]; then
    budget_flag=(--max-budget-usd "$MAX_BUDGET_USD")
  fi

  claude "${permission_args[@]}" -p "/next-phase then commit" \
    --name "phase-run-$ts" \
    "${budget_flag[@]}" \
    2>&1 | tee "$log"
  status="${PIPESTATUS[0]}"

  if [[ "$status" -ne 0 ]]; then
    echo "[run-all-phases] claude exited $status — stopping. See $log."
    exit 1
  fi

  after="$(fingerprint)"
  after_blocked="$(blocked_count)"

  if (( after_blocked > before_blocked )); then
    echo "[run-all-phases] This run's phase came back [!] (USER GATE / blocked — needs a human)."
    echo "[run-all-phases] Check the newest .planning/phases/phase-NN-notes.md for what's being asked, respond, then re-run."
    exit 2
  fi

  if [[ "$before" == "$after" ]]; then
    echo "[run-all-phases] Checklist didn't change this run — stopping to avoid looping silently. See $log."
    exit 3
  fi

  echo "[run-all-phases] Progress: $before -> $after"
done

echo "[run-all-phases] Hit MAX_ITERATIONS ($MAX_ITERATIONS) without finishing. See logs in $LOG_DIR."
exit 4
