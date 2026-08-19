"""BFCL v4 python-track dataset: fetch from gorilla, cache, seeded stratified sample.

BOUNDARY: reference-benchmark data layer. No sampler imports.

Data provenance (the SAME source + commit the TS side vendored from — see the local
``.meta.json`` files under inhuman/examples/intent-eval/src/bfcl/data/):
  repo:   github.com/ShishirPatil/gorilla
  commit: 6ea57973c7a6097fd7c5915698c54c17c5b1b6c8
  path:   berkeley-function-call-leaderboard/bfcl_eval/data/
            BFCL_v4_<track>.json                 → { id, question, function }
            possible_answer/BFCL_v4_<track>.json → { id, ground_truth }
  tracks (python AST family, no execution): simple_python, multiple, parallel, parallel_multiple
  (the AST categories multiple/parallel/parallel_multiple are language-agnostic; only
   ``simple`` carries the ``_python`` suffix upstream.)

The model picks a function and emits a call; we AST-match it against ``possible_answer``.
``control`` excluded: every id in the curated tuning slice (bfcl_simple_subset.json) — the
overfitting guard, so the baseline is never measured on the set the mechanisms were tuned on.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any

SOURCE_REPO = "github.com/ShishirPatil/gorilla"
SOURCE_COMMIT = "6ea57973c7a6097fd7c5915698c54c17c5b1b6c8"
_RAW_BASE = (
    f"https://raw.githubusercontent.com/ShishirPatil/gorilla/{SOURCE_COMMIT}/"
    "berkeley-function-call-leaderboard/bfcl_eval/data"
)

# The four python AST tracks. Key = our category label; value = the upstream filename stem.
TRACKS: dict[str, str] = {
    "simple": "BFCL_v4_simple_python",
    "multiple": "BFCL_v4_multiple",
    "parallel": "BFCL_v4_parallel",
    "parallel_multiple": "BFCL_v4_parallel_multiple",
}

# The two irrelevance tracks (calibration mode only). These have NO ``possible_answer`` file —
# the correct behaviour is to emit NO function call at all, so there is no ground truth to join.
# The published ``Irrelevance`` leaderboard column is the unweighted mean of these two.
IRRELEVANCE_TRACKS: dict[str, str] = {
    "irrelevance": "BFCL_v4_irrelevance",  # non-live, ~240
    "live_irrelevance": "BFCL_v4_live_irrelevance",  # live, ~875 (884 at the pinned commit)
}


@dataclass(frozen=True)
class BfclEntry:
    """One joined BFCL entry (question + offered functions + ground-truth calls)."""

    id: str
    category: str
    question: list[Any]
    function: list[dict[str, Any]]
    ground_truth: list[dict[str, Any]]

    def user_query(self) -> str:
        turns = self.question[0] if self.question else []
        user = next((t for t in turns if t.get("role") == "user"), None)
        if user is None and turns:
            user = turns[0]
        return user.get("content", "") if user else ""


# Sampling note: the TS draws use mulberry32 + Fisher–Yates; we don't need bit-identical
# parity with them (this stratified cross-track draw is a DIFFERENT sample than the committed
# per-track 180-entry files). We only need a deterministic, well-distributed, seedable PRNG so
# a given ``--seed`` reproduces THIS runner's draw — so the sampler below uses python's own
# ``random.Random`` (Mersenne Twister), seeded per track.


def fetch_track(category: str, cache_dir: str, *, refresh: bool = False) -> list[BfclEntry]:
    """Fetch (or load from cache) one track, joined question+answer on id.

    Caches the joined track JSON under ``cache_dir``. A network failure with no cache is a
    hard error (we can't sample what we don't have); a network failure WITH a cache logs a
    note and uses the cache.
    """
    stem = TRACKS[category]
    cache_path = os.path.join(cache_dir, f"{category}.joined.json")
    if os.path.exists(cache_path) and not refresh:
        with open(cache_path, encoding="utf-8") as fh:
            raw = json.load(fh)
        return [_entry_from_dict(e) for e in raw]

    os.makedirs(cache_dir, exist_ok=True)
    try:
        questions = _fetch_jsonl(f"{_RAW_BASE}/{stem}.json")
        answers = _fetch_jsonl(f"{_RAW_BASE}/possible_answer/{stem}.json")
    except urllib.error.URLError as exc:
        if os.path.exists(cache_path):
            print(f"  [warn] {category}: network fetch failed ({exc}); using cache")
            with open(cache_path, encoding="utf-8") as fh:
                return [_entry_from_dict(e) for e in json.load(fh)]
        raise RuntimeError(
            f"cannot fetch BFCL track '{category}' from {_RAW_BASE} and no cache at "
            f"{cache_path}: {exc}"
        ) from exc

    joined = _join_upstream(questions, answers, category)
    with open(cache_path, "w", encoding="utf-8") as fh:
        json.dump([_entry_to_dict(e) for e in joined], fh)
    return joined


def _fetch_jsonl(url: str) -> list[dict[str, Any]]:
    req = urllib.request.Request(url, headers={"User-Agent": "bfcl-reference-runner"})
    with urllib.request.urlopen(req, timeout=60) as resp:  # noqa: S310 (trusted raw host)
        text = resp.read().decode("utf-8")
    out: list[dict[str, Any]] = []
    for line in text.splitlines():
        line = line.strip()
        if line:
            out.append(json.loads(line))
    return out


def _join_upstream(
    questions: list[dict[str, Any]], answers: list[dict[str, Any]], category: str
) -> list[BfclEntry]:
    """JOIN question + answer files on id (port of joinUpstream's contract). Fails loud on a
    missing/orphan answer or an unoffered ground-truth function (corrupt upstream)."""
    answer_by_id = {a["id"]: a for a in answers}
    if len(answer_by_id) != len(answers):
        raise ValueError(f"{category}: duplicate id in upstream answers")
    out: list[BfclEntry] = []
    seen: set[str] = set()
    for q in questions:
        qid = q["id"]
        if qid in seen:
            raise ValueError(f"{category}: duplicate id in upstream questions: {qid}")
        seen.add(qid)
        a = answer_by_id.get(qid)
        if a is None:
            raise ValueError(f"{category}: no ground_truth for question id: {qid}")
        fns = q["function"]
        gts = a["ground_truth"]
        if not fns:
            raise ValueError(f"{category}: question {qid} has no functions")
        if not gts:
            raise ValueError(f"{category}: answer {qid} has no ground_truth calls")
        offered = {fn["name"] for fn in fns}
        for call_map in gts:
            for fn_name in call_map:
                if fn_name not in offered:
                    raise ValueError(
                        f"{category}: ground_truth fn '{fn_name}' not offered in {qid}"
                    )
        out.append(
            BfclEntry(
                id=qid,
                category=category,
                question=q["question"],
                function=fns,
                ground_truth=gts,
            )
        )
    return out


def _entry_to_dict(e: BfclEntry) -> dict[str, Any]:
    return {
        "id": e.id,
        "category": e.category,
        "question": e.question,
        "function": e.function,
        "ground_truth": e.ground_truth,
    }


def _entry_from_dict(d: dict[str, Any]) -> BfclEntry:
    return BfclEntry(
        id=d["id"],
        category=d.get("category", "simple"),
        question=d["question"],
        function=d["function"],
        ground_truth=d["ground_truth"],
    )


# ── curated control slice (the overfitting guard) ──────────────────────────────────

# The 40 hand-picked enum-heavy ids the TS mechanisms were tuned on
# (inhuman/examples/intent-eval/src/bfcl/data/bfcl_simple_subset.json). All are in the
# ``simple`` track. Every one is EXCLUDED from the reference sample — we must not measure
# the baseline on the tuning set. (Hard-coded so the runner has no dependency on the TS
# repo's data dir; it is a stable, committed artifact.)
CONTROL_IDS: frozenset[str] = frozenset(
    {
        "simple_python_0", "simple_python_1", "simple_python_2", "simple_python_3",
        "simple_python_4", "simple_python_5", "simple_python_6", "simple_python_7",
        "simple_python_10", "simple_python_12", "simple_python_33", "simple_python_34",
        "simple_python_35", "simple_python_61", "simple_python_62", "simple_python_64",
        "simple_python_65", "simple_python_66", "simple_python_67", "simple_python_68",
        "simple_python_69", "simple_python_73", "simple_python_77", "simple_python_78",
        "simple_python_80", "simple_python_87", "simple_python_91", "simple_python_93",
        "simple_python_110", "simple_python_125", "simple_python_136", "simple_python_145",
        "simple_python_151", "simple_python_157", "simple_python_158", "simple_python_161",
        "simple_python_168", "simple_python_177", "simple_python_192", "simple_python_205",
    }
)


# ── irrelevance tracks (no possible_answer; calibration only) ──────────────────────

def fetch_irrelevance_track(category: str, cache_dir: str, *, refresh: bool = False) -> list[BfclEntry]:
    """Fetch (or load from cache) one irrelevance track. No ``possible_answer`` join — the
    expected behaviour is to make NO call, so ``ground_truth`` is empty for every entry."""
    stem = IRRELEVANCE_TRACKS[category]
    cache_path = os.path.join(cache_dir, f"{category}.joined.json")
    if os.path.exists(cache_path) and not refresh:
        with open(cache_path, encoding="utf-8") as fh:
            raw = json.load(fh)
        return [_entry_from_dict(e) for e in raw]

    os.makedirs(cache_dir, exist_ok=True)
    try:
        questions = _fetch_jsonl(f"{_RAW_BASE}/{stem}.json")
    except urllib.error.URLError as exc:
        if os.path.exists(cache_path):
            print(f"  [warn] {category}: network fetch failed ({exc}); using cache")
            with open(cache_path, encoding="utf-8") as fh:
                return [_entry_from_dict(e) for e in json.load(fh)]
        raise RuntimeError(
            f"cannot fetch BFCL irrelevance track '{category}' from {_RAW_BASE} and no cache "
            f"at {cache_path}: {exc}"
        ) from exc

    out: list[BfclEntry] = []
    seen: set[str] = set()
    for q in questions:
        qid = q["id"]
        if qid in seen:
            raise ValueError(f"{category}: duplicate id in upstream questions: {qid}")
        seen.add(qid)
        # Unlike the AST tracks, an irrelevance entry MAY offer zero functions (the model is
        # handed an empty toolset and should answer in prose). That is not corrupt data — with no
        # offered function there is no possible false-positive call, so it scores correct trivially.
        fns = q.get("function", []) or []
        out.append(
            BfclEntry(
                id=qid,
                category=category,
                question=q["question"],
                function=fns,
                ground_truth=[],  # no ground truth: the correct answer is "no call".
            )
        )
    with open(cache_path, "w", encoding="utf-8") as fh:
        json.dump([_entry_to_dict(e) for e in out], fh)
    return out


@dataclass(frozen=True)
class SampleStats:
    per_track: dict[str, int]
    control_excluded: int
    total: int


def build_sample(
    cache_dir: str, *, seed: int, n: int, refresh: bool = False
) -> tuple[list[BfclEntry], SampleStats]:
    """Seeded, stratified random sample across all four python tracks, control excluded.

    Stratification: ``n`` is split proportionally to each track's available (post-control)
    size, so the cross-track mix reflects the corpus. Reproducible given ``seed``. Returns
    the entries plus per-track counts and the control-exclusion count (no silent truncation).
    """
    import random as _random

    pools: dict[str, list[BfclEntry]] = {}
    control_excluded = 0
    for category in TRACKS:
        entries = fetch_track(category, cache_dir, refresh=refresh)
        kept = [e for e in entries if e.id not in CONTROL_IDS]
        control_excluded += len(entries) - len(kept)
        pools[category] = kept

    total_available = sum(len(p) for p in pools.values())
    requested = min(n, total_available)

    # Proportional allocation per track, then a remainder pass to hit ``requested`` exactly.
    raw_alloc = {cat: requested * len(p) / total_available for cat, p in pools.items()}
    alloc = {cat: int(v) for cat, v in raw_alloc.items()}
    remainder = requested - sum(alloc.values())
    # Distribute the remainder to the tracks with the largest fractional parts (stable).
    by_frac = sorted(
        pools.keys(), key=lambda c: (raw_alloc[c] - alloc[c], c), reverse=True
    )
    for cat in by_frac[:remainder]:
        alloc[cat] += 1

    sample: list[BfclEntry] = []
    per_track: dict[str, int] = {}
    for category in TRACKS:  # stable track order for deterministic output
        pool = pools[category]
        k = min(alloc[category], len(pool))
        rng = _random.Random(f"{seed}:{category}")  # per-track stream → seed-stable draws
        idxs = sorted(rng.sample(range(len(pool)), k)) if k > 0 else []
        drawn = [pool[i] for i in idxs]
        sample.extend(drawn)
        per_track[category] = len(drawn)

    stats = SampleStats(
        per_track=per_track, control_excluded=control_excluded, total=len(sample)
    )
    return sample, stats


# ── calibration set (FULL category denominators, no sampling, no control exclusion) ─

# The categories run in calibration mode and the order they appear in the comparison table.
# The four AST tracks PLUS the two irrelevance tracks — every entry, matching the published
# denominator. (Control exclusion is the OTHER experiment's overfit guard; it must NOT apply
# here or our denominator drifts from the leaderboard's.)
CALIBRATION_CATEGORIES: tuple[str, ...] = (
    "simple", "multiple", "parallel", "parallel_multiple", "irrelevance", "live_irrelevance",
)


def build_calibration_set(
    cache_dir: str, *, refresh: bool = False, limit: int | None = None
) -> tuple[list[BfclEntry], dict[str, int]]:
    """The FULL BFCL category sets used for leaderboard calibration.

    NO random sampling and NO control-id exclusion — calibration must measure on the same
    denominator the published numbers do. Returns the entries (AST tracks first, then the two
    irrelevance tracks) plus a per-category count.

    ``limit`` (smoke only): keep at most ``limit`` entries PER category, taken in upstream order
    (deterministic, no PRNG) so a quick smoke run touches every category without burning the
    full corpus.
    """
    sample: list[BfclEntry] = []
    per_track: dict[str, int] = {}
    for category in CALIBRATION_CATEGORIES:
        if category in TRACKS:
            entries = fetch_track(category, cache_dir, refresh=refresh)
        else:
            entries = fetch_irrelevance_track(category, cache_dir, refresh=refresh)
        if limit is not None:
            entries = entries[:limit]
        sample.extend(entries)
        per_track[category] = len(entries)
    return sample, per_track
