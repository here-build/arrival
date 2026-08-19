#!/usr/bin/env bash
# Sequential BFCL grid driver. Runs gen+eval per (model,category) cell, prints accuracy.
# Prompt-mode cells for arch may run away; cap each gen with a timeout and partial-eval.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"
export BFCL_PROJECT_ROOT="$HERE"
PY="$HERE/.venv/bin/python"
LOG="$HERE/grid_run.log"
: > "$LOG"

cell () {
  local model="$1" cat="$2" cap="$3"
  echo "=== CELL $model / $cat (gen cap ${cap}s) ===" | tee -a "$LOG"
  local t0=$(date +%s)
  timeout "$cap" "$PY" bfcl_lmstudio.py generate --model "$model" --test-category "$cat" --skip-server-setup >>"$LOG" 2>&1
  local grc=$?
  local t1=$(date +%s)
  echo "  gen rc=$grc elapsed=$((t1-t0))s" | tee -a "$LOG"
  "$PY" bfcl_lmstudio.py evaluate --model "$model" --test-category "$cat" --partial-eval >>"$LOG" 2>&1 || true
  # find score file
  local sf
  sf=$(find "$HERE/score/$model" -name "*_${cat}_score.json" 2>/dev/null | head -1)
  if [ -n "$sf" ]; then
    local line; line=$(head -1 "$sf")
    echo "  SCORE $model $cat -> $line   ($sf)" | tee -a "$LOG"
  else
    echo "  SCORE $model $cat -> NO SCORE FILE" | tee -a "$LOG"
  fi
}

# PRIORITY: prompt-mode apples-to-apples (hammer fast; arch may run away -> capped)
cell hammer2.1-3b            parallel  1800
cell hammer2.1-3b            multiple  1800
# native-FC clean (multiple) + flagged (parallel, LM Studio 1-call cap)
cell hammer2.1-3b-FC         multiple  1800
cell hammer2.1-3b-FC         parallel  1800
# arch prompt (runaway risk -> capped at 40min, partial-eval scores whatever completed)
cell arch-agent-1.5b         multiple  2400
cell arch-agent-1.5b         parallel  2400
# arch native-FC clean + flagged
cell arch-agent-1.5b-FC      multiple  1800
cell arch-agent-1.5b-FC      parallel  1800

echo "=== GRID COMPLETE ===" | tee -a "$LOG"
