"""What did each model PRODUCE on the irrelevance flow — the abstention/failure distribution.

For the irrelevance + live_irrelevance categories the CORRECT behaviour is to NOT call a function. This
reads the reference runner's response cache and, per model, buckets every irrelevance response into how it
expressed (or failed to express) "nothing needed":

  called   — emitted a parseable function call  → WRONG (over-called on an irrelevant prompt)
  abstain  — natural-language response, no call  → RIGHT (the good abstention)
  empty    — empty / whitespace only
  garbage  — only special tokens (e.g. <|im_start|>) — a broken template, not a real answer

Uses the runner's own dataset loader for the id→category map (full set, every cached irrelevance entry —
so models with overnight full-run cache get a real distribution, not just the 2-entry smoke slice).

Run:  python3 bfcl_irrelevance_behavior.py   (from scripts/, after a calibrate run)
"""

from __future__ import annotations

import glob
import json
import os
import re
from collections import defaultdict

from bfcl_reference.dataset import build_calibration_set
from bfcl_reference.runner import _CACHE_ROOT

IRRELEVANCE_CATS = {"irrelevance", "live_irrelevance"}
_SPECIAL_ONLY = re.compile(r"^(?:\s*<\|[^|]*\|>\s*)+$")  # only ChatML-style special tokens
_REFUSAL = re.compile(r"\b(cannot|can't|unable|sorry|no (?:available|matching|suitable) function|not (?:possible|able))\b", re.I)


def bucket(response: str, parsed: bool) -> str:
    if parsed:
        return "called"
    text = (response or "").strip()
    if not text:
        return "empty"
    if _SPECIAL_ONLY.match(text):
        return "garbage"
    return "abstain"


def main() -> int:
    entries, _ = build_calibration_set(os.path.join(_CACHE_ROOT, "dataset"))
    cat_of = {e.id: e.category for e in entries}

    paths = sorted(glob.glob(os.path.join(_CACHE_ROOT, "responses", "*__calibrate.json")))
    if not paths:
        print("no calibrate-mode cache — run a calibrate smoke first")
        return 1

    print("\nIrrelevance-flow behaviour — how each model expresses 'nothing needed'")
    print("=" * 92)
    for path in paths:
        model = os.path.basename(path)[: -len("__calibrate.json")]
        with open(path, encoding="utf-8") as fh:
            cells = json.load(fh)
        per_cat: dict[str, dict[str, int]] = {c: defaultdict(int) for c in ("irrelevance", "live_irrelevance")}
        samples: dict[str, list[str]] = defaultdict(list)
        for eid, cell in cells.items():
            cat = cat_of.get(eid)
            if cat not in IRRELEVANCE_CATS:
                continue
            parsed = bool(cell.get("score", {}).get("parsed"))
            b = bucket(cell.get("response", ""), parsed)
            per_cat[cat][b] += 1
            per_cat[cat]["_n"] += 1
            if len(samples[b]) < 2:
                samples[b].append(repr((cell.get("response", "") or "").strip())[:140])
        total_n = sum(per_cat[c]["_n"] for c in per_cat)
        if total_n == 0:
            continue
        print(f"\n{model}")
        for cat in ("irrelevance", "live_irrelevance"):
            d = per_cat[cat]
            n = d["_n"]
            if not n:
                continue
            parts = "  ".join(f"{k}={d[k]}" for k in ("called", "abstain", "empty", "garbage") if d[k])
            print(f"  {cat:<17} n={n:<4} {parts}   (abstain-rate {(d['abstain']/n):.0%})")
        for b in ("abstain", "called", "garbage", "empty"):
            for s in samples[b]:
                print(f"      [{b}] {s}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
