#!/usr/bin/env bash
# Minimal wrapper to run official BFCL against our OpenAI-compatible server (or LM Studio).
# Set OPENAI_BASE_URL in .env (to http://localhost:1234/v1 for our server).
#
# Core usage (rely on official bfcl):
#   ./run.sh bfcl models
#   ./run.sh bfcl generate --model <id> --test-category simple_python --skip-server-setup
#   ./run.sh bfcl evaluate --model <id> --test-category simple_python --partial-eval
#
# Helpers for convenience (still delegate to official):
#   ./run.sh verify   # our offline check
#   ./run.sh mini ... # one entry
#   ./run.sh gen ...
#   ./run.sh eval ...
#
# For full reference numbers, use official bfcl directly after register (or our bfcl_lmstudio.py).
# We minimize custom code; all scoring/harness is official.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"
export BFCL_PROJECT_ROOT="$HERE"
VPY="$HERE/.venv/bin/python"
[ -x "$VPY" ] || { echo "ERROR: venv missing — run ./setup.sh first." >&2; exit 1; }

cmd="${1:-}"; shift || true

case "$cmd" in
  verify)
    exec "$VPY" "$HERE/verify_pipeline.py" "$@"
    ;;
  mini|subset|gen|eval)
    # delegate to our thin wrapper which calls official
    exec "$VPY" "$HERE/bfcl_lmstudio.py" "$cmd" "$@"
    ;;
  bfcl)
    exec "$VPY" "$HERE/bfcl_lmstudio.py" "$@"
    ;;
  *)
    echo "usage: ./run.sh {verify|mini|subset|gen|eval|bfcl} ..." >&2
    echo "  bfcl ...  # passthrough to official with our models registered"
    exit 2
    ;;
esac
