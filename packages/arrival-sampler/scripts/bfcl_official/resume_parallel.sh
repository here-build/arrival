#!/usr/bin/env bash
# Resume-fill the parallel cells that stop early (BFCL skips existing ids, so repeated
# generate runs accumulate toward the full 200). Retry each up to N passes until count==200,
# then evaluate on the full set.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"; export BFCL_PROJECT_ROOT="$HERE"
PY="$HERE/.venv/bin/python"
LOG="$HERE/resume_run.log"; : > "$LOG"

count_for () {  # model -> line count of its parallel result file
  local m="$1"; local f
  f=$(find "$HERE/result/$m" -name "*_parallel_result.json" 2>/dev/null | head -1)
  [ -n "$f" ] && wc -l < "$f" | tr -d ' ' || echo 0
}

fill () {
  local model="$1" cap="$2" passes="$3"
  for i in $(seq 1 "$passes"); do
    local c; c=$(count_for "$model")
    echo "=== $model parallel: pass $i, have $c/200 ===" | tee -a "$LOG"
    [ "$c" -ge 200 ] && { echo "  complete"; break; }
    timeout "$cap" "$PY" bfcl_lmstudio.py generate --model "$model" --test-category parallel --skip-server-setup >>"$LOG" 2>&1
    echo "  after pass $i: $(count_for "$model")/200" | tee -a "$LOG"
  done
  "$PY" bfcl_lmstudio.py evaluate --model "$model" --test-category parallel --partial-eval >>"$LOG" 2>&1 || true
  local sf; sf=$(find "$HERE/score/$model" -name "*_parallel_score.json" 2>/dev/null | head -1)
  [ -n "$sf" ] && echo "  FINAL SCORE $model parallel -> $(head -1 "$sf")" | tee -a "$LOG"
}

# hammer-FC dropped: LM Studio does not emit native tool_calls for hammer (returns text in
# content) -> every FC entry scores 0.0 regardless of count. Platform limitation, not the model.
fill hammer2.1-3b       600  8
fill arch-agent-1.5b    2400 8
fill arch-agent-1.5b-FC 900  6
echo "=== RESUME COMPLETE ===" | tee -a "$LOG"
