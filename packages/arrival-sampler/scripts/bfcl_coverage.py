"""BFCL coverage matrix — liveness, NOT accuracy.

Post-processes the reference runner's response cache (scripts/.bfcl-cache/responses/*.json) into a
model × category table answering ONE question: did each model produce at least one PARSED call in each
BFCL category? No inference, no scoring changes — it reads the cache the calibrate run already wrote and
reuses the runner's own dataset loader to map entry_id → category (no divergence).

Three signals per (model, category) cell:
  • responded — the model returned a non-empty completion (the true liveness floor; an empty cell = the
    model gave nothing at all).
  • parsed    — at least one well-formed function call was extracted. For the 4 CALL categories
    (simple/multiple/parallel/parallel_multiple) this is "is it doing calls". For the IRRELEVANCE
    categories a call is the WRONG behaviour (correct = abstain), so there `parsed` is informational, not
    a pass/fail — `responded` is the liveness signal.

Run:  python3 bfcl_coverage.py     (from the scripts/ dir, after a calibrate run has populated the cache)
"""

from __future__ import annotations

import glob
import json
import os
from collections import defaultdict

from bfcl_reference.dataset import CALIBRATION_CATEGORIES, build_calibration_set
from bfcl_reference.runner import _CACHE_ROOT

CALL_CATEGORIES = {"simple", "multiple", "parallel", "parallel_multiple"}


def main() -> int:
    dataset_cache = os.path.join(_CACHE_ROOT, "dataset")
    # Restrict to the EXACT smoke slice (first N per category, deterministic upstream order) so the matrix
    # has consistent n across models — the response cache also holds full-run cells from prior overnight
    # calibrations, which would otherwise show n=400 for some models and n=2 for others.
    limit = int(os.environ.get("SMOKE_LIMIT", "2"))
    entries, _ = build_calibration_set(dataset_cache, limit=limit)
    cat_of = {e.id: e.category for e in entries}
    smoke_ids = set(cat_of)

    resp_dir = os.path.join(_CACHE_ROOT, "responses")
    # Calibrate mode caches under a `__calibrate` suffix (distinct prompt namespace from native mode). The
    # BFCL-faithful smoke is calibrate mode, so read only those; strip the suffix for display.
    paths = sorted(glob.glob(os.path.join(resp_dir, "*__calibrate.json")))
    if not paths:
        print(f"no calibrate-mode cached responses under {resp_dir} — run a calibrate smoke first")
        return 1

    # per model: cat -> {responded, parsed, matched, total}
    rows: list[tuple[str, dict[str, dict[str, int]]]] = []
    for path in paths:
        model = os.path.basename(path)[: -len("__calibrate.json")]
        with open(path, encoding="utf-8") as fh:
            cells = json.load(fh)
        agg: dict[str, dict[str, int]] = defaultdict(lambda: {"responded": 0, "parsed": 0, "matched": 0, "total": 0})
        for eid, cell in cells.items():
            if eid not in smoke_ids:
                continue  # ignore full-run cells that aren't part of this mini slice
            cat = cat_of.get(eid)
            if cat is None:
                continue
            score = cell.get("score", {})
            a = agg[cat]
            a["total"] += 1
            a["responded"] += 1 if (cell.get("response") or "").strip() else 0
            a["parsed"] += 1 if score.get("parsed") else 0
            a["matched"] += 1 if score.get("matched") else 0
        rows.append((model, agg))

    cats = list(CALIBRATION_CATEGORIES)
    label_w = max((len(m) for m, _ in rows), default=10)
    col_w = 13

    def cell_str(a: dict[str, int]) -> str:
        if a["total"] == 0:
            return "—"
        return f"{a['parsed']}/{a['total']}"

    print("\nBFCL coverage — PARSED calls per cell (liveness, not accuracy)")
    print("=" * 80)
    header = "model".ljust(label_w) + " │ " + " │ ".join(c[:11].center(col_w) for c in cats)
    print(header)
    print("─" * len(header))
    for model, agg in rows:
        line = model.ljust(label_w) + " │ " + " │ ".join(cell_str(agg[c]).center(col_w) for c in cats)
        print(line)

    # The genuine liveness failures: a cell where the model returned NOTHING at all.
    print("\n— liveness gaps (responded < total — model returned an empty completion) —")
    gaps = [
        f"  {m} · {c}: responded {agg[c]['responded']}/{agg[c]['total']}"
        for m, agg in rows
        for c in cats
        if agg[c]["total"] and agg[c]["responded"] < agg[c]["total"]
    ]
    print("\n".join(gaps) if gaps else "  none — every cell returned a non-empty completion")

    # CALL categories where the model produced zero parsed calls across the slice (can't-do-calls signal).
    print("\n— no-call cells (CALL categories with 0 parsed across the slice) —")
    nocall = [
        f"  {m} · {c}: 0/{agg[c]['total']} parsed"
        for m, agg in rows
        for c in cats
        if c in CALL_CATEGORIES and agg[c]["total"] and agg[c]["parsed"] == 0
    ]
    print("\n".join(nocall) if nocall else "  none — every model produced ≥1 call in every CALL category")

    print("\n(irrelevance / live_irrelevance: a parsed call is the WRONG behaviour — correct = abstain —")
    print(" so low parsed there is good; `responded` is the liveness signal for those two.)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
