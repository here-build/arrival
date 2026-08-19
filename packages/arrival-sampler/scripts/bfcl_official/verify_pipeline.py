#!/usr/bin/env python
"""Offline pipeline verification for the official BFCL v4 runner — NO live model calls.

Confirms the three things the setup brief asks for WITHOUT touching LM Studio:

  1. EVERY v4 category dataset loads from the package, with its entry count.
  2. Each of the FOUR scoring axes runs on a CANNED model output and returns a sensible verdict:
       • AST value-match          (ast_checker)            — simple python call
       • Hallucination boolean    (is_empty_output)        — irrelevance + relevance
       • Multi-turn state+response(multi_turn_checker)     — on a REAL multi_turn_base entry
       • Agentic substring        (agentic_checker)        — web-search answer match
  3. The model registry resolves our LM Studio rows (registered via register_lmstudio_models).

Run:  python verify_pipeline.py     (from scripts/bfcl_official, venv active)
Exit code 0 = all axes returned the expected verdict; non-zero = a regression to localize.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

# Register our LM Studio rows first (so axis 3 can assert they resolve).
from register_lmstudio_models import register as _register_lmstudio

import bfcl_eval
from bfcl_eval.constants.category_mapping import ALL_CATEGORIES
from bfcl_eval.constants.enums import Language
from bfcl_eval.eval_checker.agentic_eval.agentic_checker import agentic_checker
from bfcl_eval.eval_checker.ast_eval.ast_checker import ast_checker
from bfcl_eval.utils import is_empty_output, load_dataset_entry

_PKG_DATA = Path(bfcl_eval.__file__).resolve().parent / "data"

_PASS = "PASS"
_FAIL = "FAIL"
_failures: list[str] = []


def _check(name: str, ok: bool, detail: str = "") -> None:
    print(f"  [{_PASS if ok else _FAIL}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        _failures.append(name)


# ── 1. every v4 category dataset loads ────────────────────────────────────────────────────────

def verify_datasets() -> None:
    print("\n=== 1. datasets load (all v4 categories) ===")
    # Use BFCL's OWN loader (load_dataset_entry) over the canonical ALL_CATEGORIES list so the
    # special-cased categories (memory_* share BFCL_v4_memory.json; web_search_* share
    # BFCL_v4_web_search.json; format_sensitivity has its own loader) resolve faithfully.
    grand_total = 0
    failed: list[str] = []
    for cat in ALL_CATEGORIES:
        try:
            entries = load_dataset_entry(cat)
            n = len(entries)
            grand_total += n
            print(f"    {cat:28s} {n:5d}")
        except Exception as exc:  # noqa: BLE001 — report which category failed to load
            failed.append(f"{cat}: {type(exc).__name__}: {exc}")
            print(f"    {cat:28s}  LOAD-ERROR: {exc}")
    _check(
        f"all {len(ALL_CATEGORIES)} v4 categories load via load_dataset_entry",
        not failed,
        f"{grand_total} total entries" if not failed else f"failures: {failed}",
    )


# ── 2a. AST value-match axis ──────────────────────────────────────────────────────────────────

def verify_ast() -> None:
    print("\n=== 2a. AST value-match (ast_checker) ===")
    # A minimal 'simple' python entry: one function, one ground-truth call.
    func_doc = [
        {
            "name": "get_weather",
            "description": "Get the weather for a city.",
            "parameters": {
                "type": "dict",
                "properties": {
                    "city": {"type": "string", "description": "City name."},
                    "unit": {"type": "string", "enum": ["celsius", "fahrenheit"]},
                },
                "required": ["city"],
            },
        }
    ]
    possible_answer = [{"get_weather": {"city": ["Paris"], "unit": ["celsius", ""]}}]

    correct = ast_checker(
        func_doc, [{"get_weather": {"city": "Paris", "unit": "celsius"}}],
        possible_answer, Language.PYTHON, "simple", "verify",
    )
    _check("correct call → valid", correct.get("valid") is True, json.dumps(correct))

    wrong = ast_checker(
        func_doc, [{"get_weather": {"city": "London", "unit": "celsius"}}],
        possible_answer, Language.PYTHON, "simple", "verify",
    )
    _check("wrong value → invalid", wrong.get("valid") is False,
           wrong.get("error_type", ""))


# ── 2b. Hallucination boolean (irrelevance / relevance) ───────────────────────────────────────

def verify_hallucination() -> None:
    print("\n=== 2b. Hallucination boolean (is_empty_output: irrelevance + relevance) ===")
    # irrelevance: the CORRECT behaviour is NO call → empty decoded output → counts correct.
    empty_decoded: list = []
    _check("empty output is 'empty' (irrelevance pass / relevance fail)",
           is_empty_output(empty_decoded) is True)

    # a real call present → NOT empty (irrelevance fail / relevance pass).
    nonempty_decoded = [{"get_weather": {"city": "Paris"}}]
    _check("non-empty call is NOT 'empty' (irrelevance fail / relevance pass)",
           is_empty_output(nonempty_decoded) is False)

    # [{}] and non-FC-format also count empty (the patch the checker documents).
    _check("[{}] counts as empty", is_empty_output([{}]) is True)


# ── 2c. Multi-turn state + response checker (on a real entry) ─────────────────────────────────

def verify_multi_turn() -> None:
    print("\n=== 2c. Multi-turn state+response (multi_turn_checker, real entry) ===")
    from bfcl_eval.eval_checker.multi_turn_eval.multi_turn_checker import multi_turn_checker

    # Load one real multi_turn_base entry + its ground truth (the checker EXECUTES the calls
    # against the backend classes named in involved_classes, so it needs a real entry).
    base = _load_jsonl(_PKG_DATA / "BFCL_v4_multi_turn_base.json")[0]
    gt = _load_jsonl(_PKG_DATA / "possible_answer" / "BFCL_v4_multi_turn_base.json")[0]
    ground_truth: list[list[str]] = gt["ground_truth"]  # list[turn][call-strings]

    # The checker expects the model's decoded result as list[turn][step][call-strings]
    # (3-deep — see eval_runner's `multi_turn_model_result_list_decoded`), whereas ground_truth
    # is list[turn][call-strings] (2-deep). Faithfully replay each turn as ONE step containing
    # that turn's reference calls. Replaying the reference answer MUST satisfy both the state and
    # response checks → valid True, proving the executor + state/response comparators run
    # end-to-end (the load-bearing wiring) without needing a model.
    model_decoded = [[list(turn)] for turn in ground_truth]

    result = multi_turn_checker(
        model_decoded, ground_truth, base, "multi_turn_base", "verify",
    )
    # The result dict may carry live backend objects (e.g. a Directory state) → not JSON-able.
    # Report only the scalar verdict fields.
    summary = {k: result.get(k) for k in ("valid", "error_type") if k in result}
    _check("ground-truth replay → valid (executor+state+response ran)",
           result.get("valid") is True, str(summary))


# ── 2d. Agentic substring axis ────────────────────────────────────────────────────────────────

def verify_agentic() -> None:
    print("\n=== 2d. Agentic substring (agentic_checker: web-search answer match) ===")
    possible = ["Golden Gate Bridge", "1937"]
    hit = agentic_checker(
        "The bridge opened in 1937 and is called the Golden Gate Bridge.", possible
    )
    _check("answer present → valid", hit.get("valid") is True)

    miss = agentic_checker("I could not find that information.", possible)
    _check("answer absent → invalid", miss.get("valid") is False,
           miss.get("error_type", ""))


# ── 3. registry resolves our LM Studio rows ───────────────────────────────────────────────────

def verify_registry() -> None:
    print("\n=== 3. model registry resolves LM Studio rows ===")
    added = _register_lmstudio()
    from bfcl_eval.constants.model_config import MODEL_CONFIG_MAPPING as M
    sample = ["arch-agent-3b", "arch-agent-3b-FC", "qwen/qwen3-8b", "qwen/qwen3-8b-FC"]
    present = [k for k in sample if k in M]
    _check(f"registered {len(added)} rows; sample resolves",
           present == sample, f"resolved {present}")
    # confirm the handler is the OpenAI-compatible chat handler (the base-url path).
    from bfcl_eval.model_handler.api_inference.openai_completion import OpenAICompletionsHandler
    cfg = M.get("arch-agent-3b")
    _check("arch-agent-3b → OpenAICompletionsHandler (OPENAI_BASE_URL path)",
           cfg is not None and cfg.model_handler is OpenAICompletionsHandler)
    _check("arch-agent-3b-FC is_fc_model True (native tools=)",
           M["arch-agent-3b-FC"].is_fc_model is True)
    _check("arch-agent-3b is_fc_model False (prompt mode)",
           M["arch-agent-3b"].is_fc_model is False)


def _load_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.open(encoding="utf-8") if line.strip()]


def main() -> int:
    print(f"bfcl_eval loaded from: {Path(bfcl_eval.__file__).resolve().parent}")
    verify_datasets()
    verify_ast()
    verify_hallucination()
    verify_multi_turn()
    verify_agentic()
    verify_registry()
    print("\n" + "=" * 70)
    if _failures:
        print(f"RESULT: {len(_failures)} check(s) FAILED: {_failures}")
        return 1
    print("RESULT: all offline checks PASSED (live model call deferred — see README).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
