"""Per-(model, entry) response + score cache (gitignored).

BOUNDARY: reference-benchmark cache. No sampler imports.

A re-run with the same seed/roster hits the cache and does NO new inference for
already-scored cells. The cache key is ``(served_model_id, entry_id)`` plus a scorer
version tag — bump ``SCORER_VERSION`` to invalidate cached SCORES (not responses) when the
matching rules change. Stored as one JSON file per model under ``cache_dir/responses/``.
"""

from __future__ import annotations

import json
import os
from typing import Any, Optional

# Bump when scoring.py's matching rules change in a way that should re-score cached
# responses. (Responses themselves are model output and never go stale.)
SCORER_VERSION = "3"  # bumped: simple/multiple enforce exactly-one-call (BFCL "wrong number of functions")


class ResponseCache:
    """One JSON file per model: ``{ entry_id: { response, score{...}, scorer_version } }``."""

    def __init__(self, cache_dir: str):
        self.dir = os.path.join(cache_dir, "responses")
        os.makedirs(self.dir, exist_ok=True)
        self._loaded: dict[str, dict[str, Any]] = {}

    def _path(self, model_id: str) -> str:
        safe = "".join(c if c.isalnum() or c in "-_." else "_" for c in model_id)
        return os.path.join(self.dir, f"{safe}.json")

    def _store(self, model_id: str) -> dict[str, Any]:
        if model_id not in self._loaded:
            path = self._path(model_id)
            if os.path.exists(path):
                with open(path, encoding="utf-8") as fh:
                    self._loaded[model_id] = json.load(fh)
            else:
                self._loaded[model_id] = {}
        return self._loaded[model_id]

    def get(self, model_id: str, entry_id: str) -> Optional[dict[str, Any]]:
        """A cached cell iff present AND scored under the current SCORER_VERSION."""
        cell = self._store(model_id).get(entry_id)
        if cell is None:
            return None
        if cell.get("scorer_version") != SCORER_VERSION:
            return None
        return cell

    def get_response_only(self, model_id: str, entry_id: str) -> Optional[str]:
        """A cached RAW response regardless of scorer version (lets a re-score reuse inference)."""
        cell = self._store(model_id).get(entry_id)
        return cell.get("response") if cell else None

    def put(self, model_id: str, entry_id: str, response: str, score: dict[str, Any]) -> None:
        store = self._store(model_id)
        store[entry_id] = {
            "response": response,
            "score": score,
            "scorer_version": SCORER_VERSION,
        }

    def flush(self, model_id: str) -> None:
        with open(self._path(model_id), "w", encoding="utf-8") as fh:
            json.dump(self._store(model_id), fh)
