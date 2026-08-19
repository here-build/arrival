#!/usr/bin/env bash
# Set up the official BFCL v4 reference runner in a local python 3.12 venv.
#
# Idempotent: safe to re-run. Creates ./.venv (gitignored), installs bfcl_eval EDITABLE from the
# vendored gorilla submodule, plus `soundfile` (a qwen_agent transitive dep the wheel misses).
#
# Prereqs: python3.12 on PATH (brew install python@3.12), and the gorilla submodule checked out:
#   git submodule update --init foundations/arrival/arrival-sampler/scripts/bfcl_official/gorilla
#
# Usage:  cd foundations/arrival/arrival-sampler/scripts/bfcl_official && ./setup.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

PY="${PYTHON312:-/opt/homebrew/bin/python3.12}"
if ! command -v "$PY" >/dev/null 2>&1; then
  # fall back to a `python3.12` on PATH
  if command -v python3.12 >/dev/null 2>&1; then PY="python3.12"; else
    echo "ERROR: python3.12 not found. brew install python@3.12 (or set PYTHON312)." >&2
    exit 1
  fi
fi
echo "[setup] using $("$PY" --version) at $PY"

SUBMODULE="$HERE/gorilla/berkeley-function-call-leaderboard"
if [ ! -f "$SUBMODULE/pyproject.toml" ]; then
  echo "[setup] gorilla submodule not checked out — initializing..."
  ( cd "$HERE/../../../.." && git submodule update --init --recursive \
      "foundations/arrival/arrival-sampler/scripts/bfcl_official/gorilla" )
fi

if [ ! -d "$HERE/.venv" ]; then
  echo "[setup] creating venv at .venv"
  "$PY" -m venv "$HERE/.venv"
fi

VPY="$HERE/.venv/bin/python"
echo "[setup] upgrading pip"
"$VPY" -m pip install --quiet --upgrade pip

echo "[setup] installing bfcl_eval (editable) from the gorilla submodule"
"$VPY" -m pip install --quiet -e "$SUBMODULE"

echo "[setup] installing soundfile (missing qwen_agent transitive dep)"
"$VPY" -m pip install --quiet soundfile

echo "[setup] verifying CLI"
BFCL_PROJECT_ROOT="$HERE" "$HERE/.venv/bin/bfcl" test-categories >/dev/null
echo "[setup] OK — run:  ./run.sh verify   (offline) or see README.md"
