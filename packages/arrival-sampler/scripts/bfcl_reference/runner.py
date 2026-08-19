"""The BFCL python reference benchmark runner (CLI).

BOUNDARY: reference benchmark for the sampler; not part of it. See package docstring.

Pipeline: roster (rosters.json) → resolve each model against LM Studio's served ids →
seeded stratified sample across the four python tracks (control excluded) → for each
(model, entry): cached-or-inference → AST score (bfcl-score.ts rules) → per-model table.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass
from typing import Any, Optional

from .cache import ResponseCache
from .dataset import (
    CALIBRATION_CATEGORIES,
    SOURCE_COMMIT,
    SOURCE_REPO,
    TRACKS,
    BfclEntry,
    SampleStats,
    build_calibration_set,
    build_sample,
)
from .lmstudio import LmStudioClient, LmStudioError
from .prompt import (
    USED_FALLBACK,
    bfcl_classic_system_prompt,
    bfcl_user_prompt,
    system_prompt,
    user_prompt,
)
from .scoring import EntryScore, ParamVerdict, score_entry

_HERE = os.path.dirname(os.path.abspath(__file__))
_SCRIPTS_DIR = os.path.dirname(_HERE)
_PKG_ROOT = os.path.dirname(_SCRIPTS_DIR)  # foundations/arrival/arrival-sampler
_ROSTERS_JSON = os.path.join(_PKG_ROOT, "rosters.json")
_CACHE_ROOT = os.path.join(_SCRIPTS_DIR, ".bfcl-cache")
_DATASET_CACHE = os.path.join(_CACHE_ROOT, "dataset")
_RESULTS_DIR = os.path.join(_SCRIPTS_DIR, ".bfcl-results")

_DEFAULT_BASE_URL = os.environ.get("LMSTUDIO_BASE_URL", "http://localhost:1234/v1")


# ── roster loading (reads rosters.json — the ONE shared artifact) ──────────────────


def load_roster(roster_name: str, models_filter: Optional[list[str]]) -> list[dict[str, str]]:
    with open(_ROSTERS_JSON, encoding="utf-8") as fh:
        rosters = json.load(fh)
    if roster_name == "all":
        merged: list[dict[str, str]] = []
        seen: set[str] = set()
        for name in ("fast", "full", "extended"):
            for m in rosters.get(name, []):
                if m["key"] not in seen:
                    seen.add(m["key"])
                    merged.append(m)
        models = merged
    else:
        if roster_name not in rosters:
            raise SystemExit(f"unknown roster '{roster_name}' (have: fast, full, extended, all)")
        models = list(rosters[roster_name])
    if models_filter:
        wanted = set(models_filter)
        models = [m for m in models if m["key"] in wanted]
    return models


# ── aggregation ────────────────────────────────────────────────────────────────────


@dataclass
class TrackAgg:
    n: int = 0
    matched: int = 0
    parsed: int = 0
    matched_calls: int = 0
    expected_calls: int = 0

    def accuracy(self) -> float:
        return self.matched / self.n if self.n else 0.0


@dataclass
class ModelAgg:
    model_label: str
    served_id: str
    overall: TrackAgg
    by_track: dict[str, TrackAgg]
    typed_ok: int = 0
    typed_total: int = 0
    free_ok: int = 0
    free_total: int = 0

    def typed_accuracy(self) -> float:
        return self.typed_ok / self.typed_total if self.typed_total else 0.0

    def free_accuracy(self) -> float:
        return self.free_ok / self.free_total if self.free_total else 0.0


def _new_model_agg(
    label: str, served_id: str, categories: Optional[tuple[str, ...]] = None
) -> ModelAgg:
    cats = categories if categories is not None else tuple(TRACKS.keys())
    return ModelAgg(
        model_label=label,
        served_id=served_id,
        overall=TrackAgg(),
        by_track={cat: TrackAgg() for cat in cats},
    )


def _accumulate(agg: ModelAgg, entry: BfclEntry, score: EntryScore) -> None:
    cat = entry.category
    for bucket in (agg.overall, agg.by_track[cat]):
        bucket.n += 1
        bucket.matched += 1 if score.matched else 0
        bucket.parsed += 1 if score.parsed else 0
        bucket.matched_calls += score.matched_calls
        bucket.expected_calls += score.expected_calls
    for pv in score.params:
        if pv.typed:
            agg.typed_total += 1
            agg.typed_ok += 1 if pv.correct else 0
        else:
            agg.free_total += 1
            agg.free_ok += 1 if pv.correct else 0


def _score_dict(score: EntryScore) -> dict[str, Any]:
    return {
        "matched": score.matched,
        "name_match": score.name_match,
        "parsed": score.parsed,
        "matched_calls": score.matched_calls,
        "expected_calls": score.expected_calls,
        "emitted_calls": score.emitted_calls,
        "params": [
            {"param": p.param, "typed": p.typed, "required": p.required,
             "present": p.present, "correct": p.correct}
            for p in score.params
        ],
    }


def _score_from_dict(d: dict[str, Any]) -> EntryScore:
    return EntryScore(
        matched=d["matched"],
        name_match=d["name_match"],
        parsed=d["parsed"],
        params=tuple(
            ParamVerdict(p["param"], p["typed"], p["required"], p["present"], p["correct"])
            for p in d.get("params", [])
        ),
        matched_calls=d.get("matched_calls", 0),
        expected_calls=d.get("expected_calls", 0),
        emitted_calls=d.get("emitted_calls", 0),
    )


# ── per-model run ──────────────────────────────────────────────────────────────────


def _build_prompts(entry: BfclEntry, mode: str) -> tuple[str, str]:
    """(system, user) prompt pair for an entry in the given mode.

    ``native``    — our terse instruction; functions in the USER turn (constraint-delta exp).
    ``calibrate`` — BFCL prompt-mode default 'classic'; functions in the SYSTEM turn.
    """
    if mode == "calibrate":
        return bfcl_classic_system_prompt(entry.function), bfcl_user_prompt(entry.user_query())
    return system_prompt(), user_prompt(entry.function, entry.user_query())


def _cache_id(served_id: str, mode: str) -> str:
    """Cache namespace for a (model, prompt-mode) pair. The two modes send DIFFERENT prompts, so
    their responses must never collide — calibrate cells live under a ``::calibrate`` suffix."""
    return served_id if mode == "native" else f"{served_id}::{mode}"


def run_model(
    client: LmStudioClient,
    served_id: str,
    label: str,
    sample: list[BfclEntry],
    cache: ResponseCache,
    *,
    max_tokens: int,
    mode: str = "native",
) -> ModelAgg:
    cats = CALIBRATION_CATEGORIES if mode == "calibrate" else tuple(TRACKS.keys())
    agg = _new_model_agg(label, served_id, cats)
    cache_key = _cache_id(served_id, mode)
    inferred = 0
    cached = 0
    errors = 0
    for i, entry in enumerate(sample, 1):
        cell = cache.get(cache_key, entry.id)
        if cell is not None:
            score = _score_from_dict(cell["score"])
            cached += 1
        else:
            response = cache.get_response_only(cache_key, entry.id)  # reuse inference if re-scoring
            if response is None:
                sys_p, user_p = _build_prompts(entry, mode)
                try:
                    response = client.complete(
                        served_id, sys_p, user_p, max_tokens=max_tokens,
                    )
                    inferred += 1
                except LmStudioError as exc:
                    errors += 1
                    print(f"    [warn] {label} {entry.id}: {exc}", file=sys.stderr)
                    response = ""  # score an empty output (counts as a miss, not a crash).
            score = score_entry(entry.category, entry.function, entry.ground_truth, response)
            cache.put(cache_key, entry.id, response, _score_dict(score))
        _accumulate(agg, entry, score)
        if i % 25 == 0 or i == len(sample):
            print(
                f"    {label}: {i}/{len(sample)} "
                f"(inferred={inferred} cached={cached} errors={errors})"
            )
            cache.flush(cache_key)  # persist incrementally — a killed/slept run RESUMES from here
    cache.flush(cache_key)
    return agg


# ── table rendering ────────────────────────────────────────────────────────────────


def render_table(aggs: list[ModelAgg]) -> str:
    lines: list[str] = []
    track_keys = list(TRACKS.keys())
    header = (
        ["model", "n", "ast_acc"]
        + [f"{t[:8]}" for t in track_keys]
        + ["typed", "free", "valid"]
    )
    rows: list[list[str]] = []
    for agg in sorted(aggs, key=lambda a: a.overall.accuracy(), reverse=True):
        row = [
            agg.model_label,
            str(agg.overall.n),
            f"{agg.overall.accuracy():.3f}",
        ]
        for t in track_keys:
            tr = agg.by_track[t]
            row.append(f"{tr.accuracy():.2f}({tr.n})" if tr.n else "-")
        row += [
            f"{agg.typed_accuracy():.2f}" if agg.typed_total else "-",
            f"{agg.free_accuracy():.2f}" if agg.free_total else "-",
            f"{agg.overall.parsed / agg.overall.n:.2f}" if agg.overall.n else "-",
        ]
        rows.append(row)

    widths = [
        max(len(header[c]), *(len(r[c]) for r in rows)) if rows else len(header[c])
        for c in range(len(header))
    ]

    def fmt(cells: list[str]) -> str:
        return "  ".join(cell.ljust(widths[c]) for c, cell in enumerate(cells))

    lines.append(fmt(header))
    lines.append("  ".join("-" * w for w in widths))
    for r in rows:
        lines.append(fmt(r))
    return "\n".join(lines)


# ── calibration: published per-category numbers + comparison table ─────────────────
#
# Published leaderboard values for Arch-Agent-1.5B (rank 60, overall 32.14). The four Non-Live
# AST percentages, Live AST, and the Irrelevance column (the unweighted mean of non-live +
# live irrelevance). Source: the public BFCL v4 leaderboard. We calibrate ONLY the per-category
# columns we actually run; the others are shown as published + an explicit "not run" status.
#
# NOTE: the BFCL v4 overall is 0.10·NonLive + 0.10·Live + 0.10·Irrelevance + 0.30·MultiTurn +
# 0.40·Agentic. A python-AST number is <1% of overall and projects ONLY to its per-category
# column — never to the overall rank. We do NOT compute or imply an overall rank.

# Published BFCL v4 leaderboard numbers, keyed by a substring of the served model id. A PROMPT-mode row
# is directly comparable to our prompt-mode harness; an FC-mode row is a DIFFERENT instrument (native
# tools channel) and our prompt-mode numbers will NOT match it — shown for reference only, never a
# calibration target. Source: the public BFCL v4 leaderboard.
PUBLISHED: dict[str, dict[str, Any]] = {
    "qwen3-8b": {
        "label": "Qwen3-8B (Prompt)", "mode": "prompt", "overall": 40.43, "rank": 44,
        "ast": {"simple": 75.25, "multiple": 95.00, "parallel": 94.50, "parallel_multiple": 89.50},
        "live_ast": 80.09, "irrelevance_mean": 82.27,
    },
    # arch's leaderboard row is FC/instruct (native tool-calling) — a DIFFERENT instrument from our
    # prompt-mode harness, so our prompt-mode arch numbers are NOT expected to match these.
    "arch-agent-1.5b": {
        "label": "Arch-Agent-1.5B", "mode": "FC", "overall": 32.14, "rank": 60,
        "ast": {"simple": 72.17, "multiple": 92.00, "parallel": 85.50, "parallel_multiple": 81.00},
        "live_ast": 67.73, "irrelevance_mean": 74.83,
    },
}


def _published_for(served_id: str) -> Optional[dict[str, Any]]:
    """The published reference for a served model id (normalized substring match), or None."""
    key = "".join(c for c in served_id.lower() if c.isalnum() or c in "-.")
    for k, v in PUBLISHED.items():
        if k in key:
            return v
    return None


# Calibration tolerance: a per-category number landing within ±this of its published value validates the
# harness. A larger gap is a harness gap to localize. ONLY prompt-mode published rows are valid targets.
CALIBRATION_TOL = 3.0

_AST_LABELS = {
    "simple": "Non-Live AST · Simple",
    "multiple": "Non-Live AST · Multiple",
    "parallel": "Non-Live AST · Parallel",
    "parallel_multiple": "Non-Live AST · Parallel-Multiple",
}


def _md_row(cells: list[str]) -> str:
    return "| " + " | ".join(cells) + " |"


def render_calibration_table(
    agg: ModelAgg, per_track: dict[str, int], served_id: str
) -> tuple[str, dict[str, Any]]:
    """Markdown comparison table (ours vs published) for one model, every v4 bucket represented
    (AST + irrelevance run; live/multi-turn/agentic marked 'not run'). The published reference is
    looked up PER-MODEL; an FC-mode row is flagged reference-only (a different instrument, not a
    calibration target). Returns (markdown, machine-readable summary)."""
    pub = _published_for(served_id)
    is_prompt = bool(pub) and pub.get("mode") == "prompt"
    ast_pub: dict[str, float] = (pub or {}).get("ast", {})
    lines: list[str] = []
    if pub is None:
        lines.append(f"_No published BFCL reference for `{served_id}` — our numbers only._\n")
    elif not is_prompt:
        lines.append(
            f"_Published row for **{pub['label']}** is **{pub.get('mode')}-mode** — a DIFFERENT "
            f"instrument from our prompt-mode harness; deltas are reference, NOT a calibration._\n"
        )
    lines.append(_md_row(["Category", "Ours", "Published", "Delta", "Status"]))
    lines.append(_md_row(["---"] * 5))

    summary: dict[str, Any] = {
        "served_id": served_id, "mode": (pub or {}).get("mode"), "ast": {}, "irrelevance": {},
    }

    def status_for(delta: float) -> str:
        if not is_prompt:
            return "ref (not comparable)"
        return "✓ calibrated" if abs(delta) <= CALIBRATION_TOL else "✗ off-target"

    # ── Non-Live AST rows ──
    for cat in ("simple", "multiple", "parallel", "parallel_multiple"):
        tr = agg.by_track.get(cat)
        ours_pct = tr.accuracy() * 100 if tr and tr.n else None
        published = ast_pub.get(cat)
        label = _AST_LABELS[cat] + (f" (n={tr.n})" if tr and tr.n else "")
        if ours_pct is None or published is None:
            lines.append(_md_row([
                label,
                f"{ours_pct:.2f}" if ours_pct is not None else "—",
                f"{published:.2f}" if published is not None else "—",
                "—",
                "not run" if ours_pct is None else "no published ref",
            ]))
            continue
        delta = ours_pct - published
        # SIMPLE is the only AST category BFCL splits across languages: its published column is the
        # unweighted mean(simple_python, simple_java, simple_javascript). We run python-ONLY, so our
        # number is NOT comparable to that mean (a strong-at-python model reads high vs the java/js-
        # dragged mean). multiple/parallel/parallel_multiple are python-only ⇒ directly comparable.
        comparable = cat != "simple"
        status = status_for(delta) if comparable else "⚠ py-only vs py+java+js mean (not comparable)"
        lines.append(_md_row([label, f"{ours_pct:.2f}", f"{published:.2f}", f"{delta:+.2f}", status]))
        summary["ast"][cat] = {
            "ours": ours_pct, "published": published, "delta": delta, "n": tr.n,
            "comparable": comparable,
            "calibrated": comparable and is_prompt and abs(delta) <= CALIBRATION_TOL,
        }

    # ── Irrelevance rows (the published column is the mean of the two) ──
    nl = agg.by_track.get("irrelevance")
    lv = agg.by_track.get("live_irrelevance")
    nl_pct = nl.accuracy() * 100 if nl and nl.n else None
    lv_pct = lv.accuracy() * 100 if lv and lv.n else None
    if nl_pct is not None:
        lines.append(_md_row([f"Irrelevance · Non-Live (n={nl.n})", f"{nl_pct:.2f}", "—", "—", "component of mean"]))
    if lv_pct is not None:
        lines.append(_md_row([f"Irrelevance · Live (n={lv.n})", f"{lv_pct:.2f}", "—", "—", "component of mean"]))
    irr_pub = (pub or {}).get("irrelevance_mean")
    if nl_pct is not None and lv_pct is not None and irr_pub is not None:
        mean_pct = (nl_pct + lv_pct) / 2
        delta = mean_pct - irr_pub
        lines.append(_md_row([
            "Irrelevance · Mean (published col)", f"{mean_pct:.2f}", f"{irr_pub:.2f}",
            f"{delta:+.2f}", status_for(delta),
        ]))
        summary["irrelevance"] = {
            "non_live": nl_pct, "live": lv_pct, "mean": mean_pct,
            "published_mean": irr_pub, "delta": delta,
            "calibrated": is_prompt and abs(delta) <= CALIBRATION_TOL,
        }

    # ── categories we did NOT run — published value + explicit status (never silently dropped) ──
    live_ast = (pub or {}).get("live_ast")
    not_run = [
        ("Live AST", f"{live_ast:.2f}" if live_ast is not None else "—", "not run — needs live AST data"),
        ("Multi-Turn", "—", "not run — needs stateful-exec harness"),
        ("Agentic", "—", "not run — needs live web/memory tools"),
        ("Format-Sensitivity", "—", "not run — N/A to this calibration"),
    ]
    for name, published, status in not_run:
        lines.append(_md_row([name, "—", published, "—", status]))

    return "\n".join(lines), summary


def _calibration_verdict(summary: dict[str, Any]) -> str:
    ast = summary.get("ast", {})
    if summary.get("mode") != "prompt":
        return (
            f"VERDICT: REFERENCE ONLY — the published row is {summary.get('mode')}-mode (native "
            f"tool-calling), a DIFFERENT instrument from our prompt-mode harness; not a calibration."
        )
    # Judge on the PYTHON-comparable categories only. Simple's published column is a py+java+js mean
    # (we run python-only) ⇒ excluded from the verdict; multiple/parallel/parallel_multiple + irrelevance
    # are python-only and directly comparable.
    checks: list[tuple[str, float, bool]] = []
    for c in ("multiple", "parallel", "parallel_multiple"):
        v = ast.get(c)
        if v:
            checks.append((c, v["delta"], v["calibrated"]))
    irr = summary.get("irrelevance")
    if irr:
        checks.append(("irrelevance", irr["delta"], irr.get("calibrated", False)))
    if not checks:
        return "VERDICT: no python-comparable category ran — cannot judge calibration."
    deltas = ", ".join(f"{c} {d:+.1f}" for c, d, _ in checks)
    dead_on = [c for c, _, cal in checks if cal]
    off = [c for c, d, cal in checks if not cal and abs(d) > 6]
    simple = ast.get("simple")
    simple_note = (
        f" (Simple py-only {simple['ours']:.1f} is NOT comparable to its published py+java+js mean "
        f"{simple['published']:.1f}.)"
    ) if simple else ""
    if not off:
        return (
            f"VERDICT: ✓ HARNESS FAITHFUL — every python-comparable category calibrates or is near: "
            f"{deltas} ({len(dead_on)} within ±{CALIBRATION_TOL:.0f}, rest within 6).{simple_note}"
        )
    return f"VERDICT: ⚠ PARTIAL — {deltas}; off-target (>6): {', '.join(off)}.{simple_note}"


def _report_payload(aggs: list[ModelAgg], stats: SampleStats, args: argparse.Namespace) -> dict[str, Any]:
    return {
        "benchmark": "BFCL v4 python (reference baseline — native function-calling, no constraint)",
        "provenance": {"source_repo": SOURCE_REPO, "source_commit": SOURCE_COMMIT},
        "sample": {
            "seed": args.seed,
            "requested_n": args.n,
            "actual_n": stats.total,
            "per_track": stats.per_track,
            "control_excluded": stats.control_excluded,
        },
        "models": [
            {
                "label": a.model_label,
                "served_id": a.served_id,
                "n": a.overall.n,
                "ast_accuracy": a.overall.accuracy(),
                "validity_rate": (a.overall.parsed / a.overall.n) if a.overall.n else 0.0,
                "typed_param_accuracy": a.typed_accuracy(),
                "free_param_accuracy": a.free_accuracy(),
                "by_track": {
                    t: {
                        "n": tr.n,
                        "ast_accuracy": tr.accuracy(),
                        "call_accuracy": (tr.matched_calls / tr.expected_calls)
                        if tr.expected_calls else 0.0,
                    }
                    for t, tr in a.by_track.items()
                    if tr.n
                },
            }
            for a in sorted(aggs, key=lambda a: a.overall.accuracy(), reverse=True)
        ],
    }


# ── dry-run self-test (no LM Studio) ───────────────────────────────────────────────


def dry_run() -> int:
    """Exercise sampling + scoring against hand-written mock responses (no LM Studio).
    Asserts the AST matcher gives the expected verdict on a known-correct and known-wrong call."""
    print("=== DRY RUN: scoring self-test (no LM Studio) ===")
    # A minimal simple-track entry: one function, integer + string args, one enum param.
    entry = BfclEntry(
        id="dryrun_simple_0",
        category="simple",
        question=[[{"role": "user", "content": "Convert 100 celsius to fahrenheit."}]],
        function=[
            {
                "name": "convert_temp",
                "description": "Convert a temperature.",
                "parameters": {
                    "type": "dict",
                    "properties": {
                        "value": {"type": "integer", "description": "the value"},
                        "unit": {"type": "string", "enum": ["celsius", "fahrenheit"]},
                    },
                    "required": ["value", "unit"],
                },
            }
        ],
        ground_truth=[{"convert_temp": {"value": [100], "unit": ["celsius"]}}],
    )
    ok_resp = 'convert_temp(value=100, unit="celsius")'
    wrong_resp = 'convert_temp(value=999, unit="kelvin")'

    ok = score_entry(entry.category, entry.function, entry.ground_truth, ok_resp)
    wrong = score_entry(entry.category, entry.function, entry.ground_truth, wrong_resp)
    print(f"  known-correct  '{ok_resp}'  -> matched={ok.matched} (expect True)")
    print(f"  known-wrong    '{wrong_resp}'  -> matched={wrong.matched} (expect False)")
    assert ok.matched is True, "scorer failed: correct call did not match"
    assert wrong.matched is False, "scorer failed: wrong call matched"
    # typed-param accounting: 'unit' is the enum (typed) param.
    typed = [p for p in ok.params if p.typed]
    assert len(typed) == 1 and typed[0].param == "unit", "typed-param detection broken"
    assert typed[0].correct is True, "typed param should be correct on the OK call"

    # A parallel-track entry: one function, two expected calls (order-independent set match).
    par = BfclEntry(
        id="dryrun_parallel_0",
        category="parallel",
        question=[[{"role": "user", "content": "Get weather for Paris and Tokyo."}]],
        function=[
            {
                "name": "get_weather",
                "description": "Weather by city.",
                "parameters": {
                    "type": "dict",
                    "properties": {"city": {"type": "string"}},
                    "required": ["city"],
                },
            }
        ],
        ground_truth=[
            {"get_weather": {"city": ["Paris"]}},
            {"get_weather": {"city": ["Tokyo"]}},
        ],
    )
    # Emitted in the OPPOSITE order — the set matcher must still pass (order-independent).
    par_ok = 'get_weather(city="Tokyo")\nget_weather(city="Paris")'
    par_partial = 'get_weather(city="Paris")'  # only one of two calls
    pok = score_entry(par.category, par.function, par.ground_truth, par_ok)
    ppartial = score_entry(par.category, par.function, par.ground_truth, par_partial)
    print(f"  parallel set (swapped order) -> matched={pok.matched} (expect True), "
          f"calls={pok.matched_calls}/{pok.expected_calls}")
    print(f"  parallel partial (1 of 2)    -> matched={ppartial.matched} (expect False), "
          f"calls={ppartial.matched_calls}/{ppartial.expected_calls}")
    assert pok.matched is True, "parallel set match failed on swapped order"
    assert ppartial.matched is False, "parallel partial should NOT be a full match"
    assert ppartial.matched_calls == 1, "parallel partial should recover 1 call"

    # A multiple-track entry: pick the RIGHT function among several.
    mult = BfclEntry(
        id="dryrun_multiple_0",
        category="multiple",
        question=[[{"role": "user", "content": "What time is it in UTC?"}]],
        function=[
            {"name": "get_time", "description": "time",
             "parameters": {"type": "dict", "properties": {"tz": {"type": "string"}}, "required": ["tz"]}},
            {"name": "get_date", "description": "date",
             "parameters": {"type": "dict", "properties": {"tz": {"type": "string"}}, "required": ["tz"]}},
        ],
        ground_truth=[{"get_time": {"tz": ["UTC"]}}],
    )
    mult_ok = 'get_time(tz="UTC")'
    mult_wrongfn = 'get_date(tz="UTC")'  # right args, WRONG function
    mok = score_entry(mult.category, mult.function, mult.ground_truth, mult_ok)
    mwrong = score_entry(mult.category, mult.function, mult.ground_truth, mult_wrongfn)
    print(f"  multiple right-fn  -> matched={mok.matched} (expect True)")
    print(f"  multiple wrong-fn  -> matched={mwrong.matched} (expect False, name mismatch)")
    assert mok.matched is True, "multiple right-fn failed"
    assert mwrong.matched is False, "multiple wrong-fn should fail name match"

    print("=== DRY RUN PASSED: all scoring assertions hold ===")
    return 0


# ── calibration run ────────────────────────────────────────────────────────────────


def run_calibration(args: argparse.Namespace) -> int:
    """Leaderboard-calibration run: BFCL-faithful classic prompt over the FULL category sets
    (no sampling, no control exclusion). Produces a per-category ours-vs-published comparison
    and an explicit calibration verdict."""
    os.makedirs(_RESULTS_DIR, exist_ok=True)
    models_filter = [m.strip() for m in args.models.split(",")] if args.models else None
    roster = load_roster(args.roster, models_filter)
    if not roster:
        print("no models selected (empty roster after filter)", file=sys.stderr)
        return 1

    if USED_FALLBACK:
        print("[note] using the FALLBACK classic prompt (could not fetch from source).",
              file=sys.stderr)

    # Build the calibration set first (fails fast on a data problem before touching LM Studio).
    scope = f"smoke-limit={args.smoke_limit}" if args.smoke_limit else "FULL"
    print(f"Building calibration set ({scope}) — BFCL-faithful classic prompt, no sampling, "
          "no control exclusion.")
    sample, per_track = build_calibration_set(
        _DATASET_CACHE, refresh=args.refresh_data, limit=args.smoke_limit
    )
    print(f"  {len(sample)} entries across {len(per_track)} categories:")
    for cat in CALIBRATION_CATEGORIES:
        print(f"    {cat}: {per_track.get(cat, 0)}")

    client = LmStudioClient(args.base_url)
    try:
        served_ids = client.list_models()
    except LmStudioError as exc:
        print(f"\n[skip-live] {exc}", file=sys.stderr)
        print("[skip-live] LM Studio not reachable — cannot calibrate without inference.",
              file=sys.stderr)
        return 1
    print(f"\nLM Studio at {args.base_url} serving {len(served_ids)} model(s).")

    resolved: list[tuple[dict[str, str], str]] = []
    for m in roster:
        served = client.resolve(m["key"], served_ids)
        if served is None:
            print(f"  [loud-skip] {m['label']} ({m['key']}): not loaded in LM Studio.")
        else:
            print(f"  [ok] {m['label']} ({m['key']}) -> served id '{served}'")
            resolved.append((m, served))
    if not resolved:
        print("\nNo roster models are loaded in LM Studio. Load some and re-run.", file=sys.stderr)
        return 1

    cache = ResponseCache(_CACHE_ROOT)
    out_lines: list[str] = []
    reports: list[dict[str, Any]] = []
    for m, served in resolved:
        print(f"\n=== CALIBRATE {m['label']} ({served}) ===")
        agg = run_model(
            client, served, m["label"], sample, cache,
            max_tokens=args.max_tokens, mode="calibrate",
        )
        table_md, summary = render_calibration_table(agg, per_track, served)
        verdict = _calibration_verdict(summary)
        header = (
            f"## BFCL v4 calibration — {m['label']} (prompt-mode default, classic)\n\n"
            f"served id: `{served}`  ·  scope: {scope}  ·  greedy (temp 0.0)\n"
        )
        footer = (
            "\n> **Overall is NOT reproducible here.** BFCL v4 overall "
            "(published 32.14, rank 60) = 0.10·NonLive + 0.10·Live + 0.10·Irrelevance + "
            "0.30·MultiTurn + 0.40·Agentic — 70% of it is Multi-Turn + Agentic, which this "
            "AST-only harness does not run. A python-AST number projects ONLY to its "
            "per-category column above, never to the overall rank.\n"
        )
        block = f"{header}\n{table_md}\n{footer}\n{verdict}\n"
        print("\n" + block)
        out_lines.append(block)
        reports.append({
            "label": m["label"], "served_id": served,
            "per_track": per_track, "summary": summary, "verdict": verdict,
        })

    md_path = os.path.join(_RESULTS_DIR, f"calibration_{scope.replace('=','')}.md")
    with open(md_path, "w", encoding="utf-8") as fh:
        fh.write("\n\n---\n\n".join(out_lines) + "\n")
    json_path = os.path.join(_RESULTS_DIR, f"calibration_{scope.replace('=','')}.json")
    with open(json_path, "w", encoding="utf-8") as fh:
        json.dump({
            "benchmark": "BFCL v4 calibration (prompt-mode default, classic)",
            "provenance": {"source_repo": SOURCE_REPO, "source_commit": SOURCE_COMMIT,
                           "used_fallback_prompt": USED_FALLBACK},
            "scope": scope, "per_track": per_track,
            "published_reference": PUBLISHED, "models": reports,
        }, fh, indent=2)
    print(f"\nwrote {md_path}")
    print(f"wrote {json_path}")
    return 0


# ── CLI ────────────────────────────────────────────────────────────────────────────


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        prog="bfcl_reference",
        description="BFCL python reference benchmark (native function-calling baseline via LM Studio).",
    )
    parser.add_argument("--mode", default="native", choices=["native", "calibrate"],
                        help="native: terse prompt, seeded sample, control excluded "
                             "(constraint-delta experiment, default). "
                             "calibrate: BFCL-faithful classic prompt, FULL category sets, "
                             "no sampling/control-exclusion (leaderboard calibration).")
    parser.add_argument("--calibrate", action="store_true",
                        help="alias for --mode calibrate")
    parser.add_argument("--smoke-limit", type=int, default=None,
                        help="calibrate only: keep at most N entries PER category "
                             "(deterministic, upstream order) for a quick smoke check.")
    parser.add_argument("--roster", default="full",
                        choices=["fast", "full", "extended", "all"],
                        help="which rosters.json roster to run (default: full)")
    parser.add_argument("--models", default=None,
                        help="comma-separated roster keys to restrict to (e.g. 'qwen/qwen3-8b,ibm/granite-4.0-h-tiny')")
    parser.add_argument("--n", type=int, default=200,
                        help="total entries sampled across all four tracks (default: 200)")
    parser.add_argument("--seed", type=int, default=20260621,
                        help="sampling seed (reproducible draw; default: 20260621)")
    parser.add_argument("--base-url", default=_DEFAULT_BASE_URL,
                        help=f"LM Studio OpenAI base URL (default: {_DEFAULT_BASE_URL}, env LMSTUDIO_BASE_URL)")
    parser.add_argument("--max-tokens", type=int, default=512,
                        help="max completion tokens per call (default: 512)")
    parser.add_argument("--refresh-data", action="store_true",
                        help="re-fetch the BFCL tracks from gorilla (ignore the dataset cache)")
    parser.add_argument("--dry-run", action="store_true",
                        help="run the scoring self-test against mock responses (no LM Studio)")
    args = parser.parse_args(argv)
    if args.calibrate:
        args.mode = "calibrate"

    if args.dry_run:
        return dry_run()

    if args.mode == "calibrate":
        return run_calibration(args)

    os.makedirs(_RESULTS_DIR, exist_ok=True)
    models_filter = [m.strip() for m in args.models.split(",")] if args.models else None
    roster = load_roster(args.roster, models_filter)
    if not roster:
        print("no models selected (empty roster after filter)", file=sys.stderr)
        return 1

    # Build the sample first (fails fast on a data problem, before touching LM Studio).
    print(f"Building sample: roster={args.roster} n={args.n} seed={args.seed}")
    sample, stats = build_sample(_DATASET_CACHE, seed=args.seed, n=args.n, refresh=args.refresh_data)
    print(f"  sampled {stats.total} entries:")
    for cat in TRACKS:
        print(f"    {cat}: {stats.per_track.get(cat, 0)}")
    print(f"  control excluded: {stats.control_excluded} (curated tuning slice — overfit guard)")
    if stats.total < args.n:
        print(f"  [note] requested {args.n}, drew {stats.total} (corpus exhausted; no silent truncation)")

    # Resolve roster → served models.
    client = LmStudioClient(args.base_url)
    try:
        served_ids = client.list_models()
    except LmStudioError as exc:
        print(f"\n[skip-live] {exc}", file=sys.stderr)
        print("[skip-live] LM Studio not reachable — running scoring self-test instead.", file=sys.stderr)
        return dry_run()
    print(f"\nLM Studio at {args.base_url} serving {len(served_ids)} model(s).")

    resolved: list[tuple[dict[str, str], str]] = []
    for m in roster:
        served = client.resolve(m["key"], served_ids)
        if served is None:
            print(f"  [loud-skip] {m['label']} ({m['key']}): not loaded in LM Studio — "
                  "load it there to include it.")
        else:
            print(f"  [ok] {m['label']} ({m['key']}) -> served id '{served}'")
            resolved.append((m, served))

    if not resolved:
        print("\nNo roster models are loaded in LM Studio. Load some and re-run.", file=sys.stderr)
        return 1

    cache = ResponseCache(_CACHE_ROOT)
    aggs: list[ModelAgg] = []
    for m, served in resolved:
        print(f"\n=== {m['label']} ({served}) ===")
        agg = run_model(client, served, m["label"], sample, cache, max_tokens=args.max_tokens)
        aggs.append(agg)

    table = render_table(aggs)
    print("\n" + "=" * 72)
    print("BFCL v4 PYTHON REFERENCE BASELINE (native function-calling, no constraint)")
    print(f"sample n={stats.total} seed={args.seed}  control_excluded={stats.control_excluded}")
    print("=" * 72)
    print(table)

    report_path = os.path.join(_RESULTS_DIR, f"baseline_seed{args.seed}_n{stats.total}.json")
    with open(report_path, "w", encoding="utf-8") as fh:
        json.dump(_report_payload(aggs, stats, args), fh, indent=2)
    table_path = os.path.join(_RESULTS_DIR, f"baseline_seed{args.seed}_n{stats.total}.txt")
    with open(table_path, "w", encoding="utf-8") as fh:
        fh.write(table + "\n")
    print(f"\nwrote {report_path}")
    print(f"wrote {table_path}")
    return 0
