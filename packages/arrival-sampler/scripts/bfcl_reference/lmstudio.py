"""LM Studio OpenAI-compatible client (stdlib urllib only).

BOUNDARY: reference-benchmark inference transport. No sampler imports.

V watches progress + logs LIVE in the LM Studio UI, so every model call goes through LM
Studio's HTTP ``/v1`` API (never a local gguf load). The base URL comes from
``LMSTUDIO_BASE_URL`` (default ``http://localhost:1234/v1``); the API key is any non-empty
string (LM Studio ignores it).

Roster-key → served-model-id resolution MIRRORS ``resolveGguf`` in
foundations/arrival/arrival-sampler/src/runners/gguf/lmstudio.ts: normalize (lowercase, strip
non-alphanumerics, drop a trailing "gguf", collapse a version dot-zero), then match the roster
key's repo-name against the served ``/v1/models`` ids — exact, then startswith, then contains,
shortest wins.
A roster model not currently served → resolves to None ⇒ the runner LOUD-SKIPS it.
"""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Optional


def _norm(name: str) -> str:
    """Tolerant key: lowercase, drop a trailing 'gguf', collapse a version dot-zero (4.0 ≡ 4),
    strip non-alphanumerics. Mirrors ``norm`` in lmstudio.ts so ``glm-4.7-flash`` and
    ``GLM-4.7-Flash-GGUF`` both collapse to ``glm47flash``, AND the roster key
    ``granite-4.0-h-tiny`` matches LM Studio's served id ``granite-4-h-tiny`` (the API drops the
    ``.0`` — without the collapse ``granite40htiny`` ≠ ``granite4htiny``). Only dot-zero
    collapses; ``4.6``/``4.7`` are untouched."""
    s = re.sub(r"gguf$", "", name.lower())
    s = re.sub(r"\.0(?=\D|$)", "", s)  # version dot-zero: 4.0 ≡ 4 (LM Studio's served id drops it)
    return re.sub(r"[^a-z0-9]", "", s)


def _repo_of(key: str) -> str:
    """The repo-name half of an ``owner/repo`` roster key (the part ``resolveGguf`` matches on)."""
    return key.split("/")[-1] if "/" in key else key


@dataclass(frozen=True)
class LmStudioError(Exception):
    message: str

    def __str__(self) -> str:  # pragma: no cover - trivial
        return self.message


class LmStudioClient:
    """Thin OpenAI-compatible client over LM Studio's ``/v1`` API."""

    def __init__(self, base_url: str, api_key: str = "lm-studio", timeout: int = 600):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key or "lm-studio"
        self.timeout = timeout

    def _post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            f"{self.base_url}{path}",
            data=data,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.api_key}",
            },
        )
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:  # noqa: S310
            return json.loads(resp.read().decode("utf-8"))

    def _get(self, path: str) -> dict[str, Any]:
        req = urllib.request.Request(
            f"{self.base_url}{path}",
            headers={"Authorization": f"Bearer {self.api_key}"},
        )
        with urllib.request.urlopen(req, timeout=30) as resp:  # noqa: S310
            return json.loads(resp.read().decode("utf-8"))

    def list_models(self) -> list[str]:
        """The served model ids from ``GET /v1/models``. Raises ``LmStudioError`` if unreachable."""
        try:
            body = self._get("/models")
        except (urllib.error.URLError, OSError) as exc:
            raise LmStudioError(
                f"LM Studio not reachable at {self.base_url} ({exc}). "
                "Start the LM Studio local server (Developer → Start Server)."
            ) from exc
        return [m["id"] for m in body.get("data", []) if "id" in m]

    def resolve(self, roster_key: str, served_ids: list[str]) -> Optional[str]:
        """Resolve a roster ``owner/repo`` key to a served model id, or None if not loaded.
        Mirrors ``resolveGguf``'s exact → startswith → contains (shortest-wins) cascade,
        matching against the NORMALIZED served ids."""
        want = _norm(_repo_of(roster_key))
        # The served id is usually ``publisher/repo`` or just ``repo``; normalize each id's
        # repo-name half (LM Studio's served id often equals the model's repo dir).
        candidates = [(sid, _norm(_repo_of(sid))) for sid in served_ids]
        exact = [sid for sid, n in candidates if n == want]
        if exact:
            return exact[0]
        starts = sorted(
            (sid for sid, n in candidates if n.startswith(want)),
            key=lambda s: len(_norm(_repo_of(s))),
        )
        if starts:
            return starts[0]
        contains = sorted(
            (sid for sid, n in candidates if want in n),
            key=lambda s: len(_norm(_repo_of(s))),
        )
        return contains[0] if contains else None

    def complete(self, model_id: str, system: str, user: str, *, max_tokens: int = 512) -> str:
        """One chat completion. Returns the assistant message text (possibly empty).
        Raises ``LmStudioError`` on a transport/HTTP failure so the caller can log+skip the cell."""
        payload = {
            "model": model_id,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": 0.0,
            "max_tokens": max_tokens,
            "stream": False,
        }
        try:
            body = self._post("/chat/completions", payload)
        except urllib.error.HTTPError as exc:
            detail = ""
            try:
                detail = exc.read().decode("utf-8")[:300]
            except Exception:  # noqa: BLE001
                pass
            raise LmStudioError(
                f"chat/completions HTTP {exc.code} for '{model_id}': {detail}"
            ) from exc
        except (urllib.error.URLError, OSError) as exc:
            raise LmStudioError(f"chat/completions transport error for '{model_id}': {exc}") from exc
        choices = body.get("choices", [])
        if not choices:
            return ""
        message = choices[0].get("message", {}) or {}
        content = message.get("content")
        if isinstance(content, str):
            return content
        # Some models return tool_calls instead of text content — flatten to a python call
        # string the scorer can parse (it expects ``fn(args)`` text).
        tool_calls = message.get("tool_calls") or []
        rendered = _render_tool_calls(tool_calls)
        return rendered if rendered else (content or "")


def _render_tool_calls(tool_calls: list[dict[str, Any]]) -> str:
    """Render OpenAI-style ``tool_calls`` into python-call text ``fn(a=1, b="x")`` so the
    AST scorer (which parses ``fn(args)``) can read structured tool output uniformly."""
    parts: list[str] = []
    for tc in tool_calls:
        fn = tc.get("function", {}) or {}
        name = fn.get("name")
        if not name:
            continue
        raw_args = fn.get("arguments", "{}")
        try:
            args = json.loads(raw_args) if isinstance(raw_args, str) else (raw_args or {})
        except json.JSONDecodeError:
            args = {}
        kw = ", ".join(f"{k}={_py_literal(v)}" for k, v in args.items())
        parts.append(f"{name}({kw})")
    return "\n".join(parts)


def _py_literal(v: Any) -> str:
    """Render a JSON value as the python literal text the scorer parses."""
    if isinstance(v, str):
        return json.dumps(v)  # double-quoted, escapes handled
    if isinstance(v, bool):
        return "True" if v else "False"
    if v is None:
        return "None"
    return json.dumps(v)
