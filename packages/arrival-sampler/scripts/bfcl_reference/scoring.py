"""BFCL python-AST scoring — a faithful port of the TS side's ``bfcl-score.ts``.

BOUNDARY: this is the REFERENCE benchmark's scorer. It scores a model's NATIVE
python function-call output (``fn(arg=val, ...)``) against BFCL ``possible_answer``
ground truth. It is NOT part of ``@inhuman.tools/arrival-sampler`` — it imports none
of the sampler's TypeScript; it re-implements the matching rules so the python
baseline is methodologically IDENTICAL to the constrained TS runs it is compared
against.

WHY REPLICATE rather than vendor gorilla's ``ast_checker``: the whole point of this
baseline is an apples-to-apples comparison with the sampler's constrained-decode
numbers, and those are scored by ``inhuman/examples/intent-eval/src/bfcl/bfcl-score.ts``
(light type coercion, case-insensitive string match, value-set membership, optional
params omittable, order-relaxed Kuhn bipartite set matching for the parallel families).
Vendoring gorilla's checker would introduce a SECOND, subtly-different matcher and make
the two columns incomparable. So every rule here is a line-for-line port of the TS
``parsePythonCall`` / ``parsePythonForms`` / ``matchCallCore`` / ``bfclAstMatchSet`` path.

Source of the rules being ported:
  inhuman/examples/intent-eval/src/bfcl/bfcl-score.ts  (commit-local; see header there)
Source of the dataset + ground-truth contract:
  github.com/ShishirPatil/gorilla — berkeley-function-call-leaderboard, bfcl_eval/data
  (commit 6ea57973c7a6097fd7c5915698c54c17c5b1b6c8).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Callable, Literal, Optional

# ── parsed-call shape (mirrors ParsedArg / ParsedCall in bfcl-score.ts) ────────────

ArgKind = Literal["string", "number", "bool", "symbol", "list"]


@dataclass(frozen=True)
class ParsedArg:
    kind: ArgKind
    raw: str
    value: Any
    # For kind == "list": the ordered element args.
    elements: Optional[tuple["ParsedArg", ...]] = None


@dataclass(frozen=True)
class ParsedCall:
    name: str
    # Positional python args (no ``=``).
    args: tuple[ParsedArg, ...] = ()
    # Keyword args by param name (python ``fn(a=…, b=…)``).
    by_name: dict[str, ParsedArg] = field(default_factory=dict)


# ── python-call parsing (port of parsePythonCall / parsePythonForms) ───────────────

_IDENT_OPEN = re.compile(r"([A-Za-z_][A-Za-z0-9_.]*)\s*\(")


def _split_top_level(s: str) -> list[str]:
    """Split a python arg list on TOP-LEVEL commas (not inside quotes / brackets)."""
    out: list[str] = []
    depth = 0
    in_str: Optional[str] = None
    buf = ""
    i = 0
    while i < len(s):
        ch = s[i]
        if in_str is not None:
            buf += ch
            if ch == "\\":
                buf += s[i + 1] if i + 1 < len(s) else ""
                i += 2
                continue
            if ch == in_str:
                in_str = None
            i += 1
            continue
        if ch in ('"', "'"):
            in_str = ch
            buf += ch
        elif ch in ("(", "[", "{"):
            depth += 1
            buf += ch
        elif ch in (")", "]", "}"):
            depth -= 1
            buf += ch
        elif ch == "," and depth == 0:
            out.append(buf)
            buf = ""
        else:
            buf += ch
        i += 1
    if buf.strip() != "":
        out.append(buf)
    return out


def _top_level_eq_index(s: str) -> int:
    """Index of the top-level ``=`` separating a python keyword from its value."""
    in_str: Optional[str] = None
    depth = 0
    i = 0
    while i < len(s):
        ch = s[i]
        if in_str is not None:
            if ch == "\\":
                i += 1
            elif ch == in_str:
                in_str = None
            i += 1
            continue
        if ch in ('"', "'"):
            in_str = ch
        elif ch in ("(", "[", "{"):
            depth += 1
        elif ch in (")", "]", "}"):
            depth -= 1
        elif (
            ch == "="
            and depth == 0
            and (i + 1 >= len(s) or s[i + 1] != "=")
            and (i == 0 or s[i - 1] not in ("=", "!", "<", ">"))
        ):
            return i
        i += 1
    return -1


def _classify_py(raw: str) -> ParsedArg:
    """Classify a python value token (quoted string, number, True/False/None, list, symbol)."""
    raw = raw.strip()
    if (raw.startswith('"') and raw.endswith('"')) or (
        raw.startswith("'") and raw.endswith("'")
    ):
        inner = raw[1:-1].replace("\\'", "'").replace('\\"', '"').replace("\\\\", "\\")
        return ParsedArg("string", raw, inner)
    if raw in ("True", "False"):
        return ParsedArg("bool", raw, raw == "True")
    if raw == "None":
        return ParsedArg("symbol", raw, raw)
    if re.fullmatch(r"[+-]?(\d+\.?\d*|\.\d+)", raw):
        num = float(raw)
        # Keep integers as ints so ``12000`` round-trips against an integer accepted value.
        value: Any = int(num) if num.is_integer() and "." not in raw else num
        return ParsedArg("number", raw, value)
    if (raw.startswith("[") and raw.endswith("]")) or (
        raw.startswith("(") and raw.endswith(")")
    ):
        inner = raw[1:-1]
        elements = tuple(
            _classify_py(p.strip())
            for p in _split_top_level(inner)
            if p.strip() != ""
        )
        return ParsedArg("list", raw, raw, elements)
    return ParsedArg("symbol", raw, raw)


def _read_balanced(program: str, open_idx: int) -> int:
    """Index of the close that balances the ``(`` at ``open_idx`` (string + bracket aware)."""
    depth = 0
    in_str: Optional[str] = None
    i = open_idx
    while i < len(program):
        ch = program[i]
        if in_str is not None:
            if ch == "\\":
                i += 1
            elif ch == in_str:
                in_str = None
            i += 1
            continue
        if ch in ('"', "'"):
            in_str = ch
        elif ch in ("(", "[", "{"):
            depth += 1
        elif ch in (")", "]", "}"):
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return -1


def parse_python_call(program: str, expected_name: Optional[str] = None) -> Optional[ParsedCall]:
    """Parse the FIRST balanced python call ``name(arg=val, …)`` → ParsedCall, or None.

    Port of ``parsePythonCall``. A bare ``(args)`` with no leading identifier falls back
    to ``expected_name`` when supplied (BFCL simple/parallel offer exactly one function,
    so the name is unambiguous — the same leniency the TS side documents).
    """
    m = _IDENT_OPEN.search(program)
    if m is not None:
        name = m.group(1)
        open_idx = m.end() - 1
    elif expected_name is not None and "(" in program:
        name = expected_name
        open_idx = program.index("(")
    else:
        return None
    end = _read_balanced(program, open_idx)
    if end == -1:
        return None
    inner = program[open_idx + 1 : end]
    by_name: dict[str, ParsedArg] = {}
    positional: list[ParsedArg] = []
    for part in _split_top_level(inner):
        trimmed = part.strip()
        if trimmed == "":
            continue
        eq = _top_level_eq_index(trimmed)
        if eq != -1:
            key = trimmed[:eq].strip()
            val_raw = trimmed[eq + 1 :].strip()
            by_name[key] = _classify_py(val_raw)
        else:
            positional.append(_classify_py(trimmed))
    return ParsedCall(name=name, args=tuple(positional), by_name=by_name)


def _first_bracket_group(program: str) -> Optional[str]:
    """The text INSIDE the first top-level ``[...]`` group (BFCL prompt-mode wraps the answer in
    ONE bracket group: ``[call1, call2]``). Bracket- and string-aware. None if there is no ``[``.
    Everything after the matching ``]`` is DROPPED — this discards a runaway model's repeated groups
    and any echoed format-placeholder tail (the cause of inflated ``emitted`` counts that sank the
    parallel set-match)."""
    start = program.find("[")
    if start == -1:
        return None
    depth = 0
    quote: Optional[str] = None
    i = start
    while i < len(program):
        ch = program[i]
        if quote is not None:
            if ch == "\\":
                i += 2
                continue
            if ch == quote:
                quote = None
        elif ch in "\"'":
            quote = ch
        elif ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
            if depth == 0:
                return program[start + 1 : i]
        i += 1
    return program[start + 1 :]  # unterminated bracket — take the remainder


def parse_python_forms(program: str, offered_names: list[str]) -> list[ParsedCall]:
    """Parse the top-level python calls in the model's answer (port of ``parsePythonForms``).

    BFCL prompt-mode wraps the answer in ONE ``[...]`` group; we parse only the calls inside that
    FIRST group. A runaway model repeats the group and echoes the format placeholder after it —
    those tails must NOT inflate the emitted-call set (that made parallel emit 12 calls for an
    expected 2). Falls back to the whole program when there is no bracket wrapper. A bare tuple is
    inferred only when exactly ONE function is offered (otherwise it can't be disambiguated).
    """
    inner = _first_bracket_group(program)
    scope = inner if inner is not None else program
    out: list[ParsedCall] = []
    scan_from = 0
    for m in _IDENT_OPEN.finditer(scope):
        if m.start() < scan_from:
            continue  # inside a previous call's args — skip.
        open_idx = m.end() - 1
        end = _read_balanced(scope, open_idx)
        if end == -1:
            break  # unterminated final call — stop.
        slice_ = scope[m.start() : end + 1]
        call = parse_python_call(
            slice_, offered_names[0] if len(offered_names) == 1 else None
        )
        if call is not None:
            out.append(call)
        scan_from = end + 1
    return out


# ── value matching (port of bfclValueMatch / argSatisfiesParam / bfclListMatch) ────


def _bfcl_value_match(candidate: Any, accepted: Any) -> bool:
    """BFCL-style equality with light coercion (port of ``bfclValueMatch``)."""
    if candidate == accepted:
        return True
    if isinstance(accepted, bool) or isinstance(candidate, bool):
        # Guard: in python ``True == 1``; BFCL treats bool and number as distinct unless
        # exactly equal (handled above). Don't cross-coerce a bool with a number/string.
        return False
    if isinstance(accepted, (int, float)) and isinstance(candidate, str):
        try:
            return float(candidate) == float(accepted)
        except ValueError:
            return False
    if isinstance(accepted, str) and isinstance(candidate, (int, float)):
        return str(candidate) == accepted or _num_str_eq(candidate, accepted)
    if isinstance(accepted, str) and isinstance(candidate, str):
        return candidate.strip().lower() == accepted.strip().lower()
    return False


def _num_str_eq(candidate: float, accepted: str) -> bool:
    """``str(12000)`` vs an accepted ``"12000"`` and the int-float ``"12000.0"`` variants."""
    try:
        return float(candidate) == float(accepted)
    except ValueError:
        return False


def _arg_candidate_values(arg: ParsedArg) -> list[Any]:
    """A scalar arg's candidate value(s). (Python output carries no symbol→value map — a
    native call emits the literal directly — so a bare symbol scores its literal text.)"""
    return [arg.value]


def _bfcl_list_match(arg: ParsedArg, accepted: Any) -> bool:
    """Element-wise ordered exact-length list match (port of ``bfclListMatch``)."""
    if arg.kind != "list" or arg.elements is None:
        return False
    if not isinstance(accepted, list):
        return False
    if len(arg.elements) != len(accepted):
        return False
    return all(
        any(_bfcl_value_match(c, accepted[i]) for c in _arg_candidate_values(el))
        for i, el in enumerate(arg.elements)
    )


def _arg_satisfies_param(arg: ParsedArg, accepted: list[Any]) -> bool:
    """Does ``arg`` satisfy a param whose accepted set is ``accepted``? (Port of ``argSatisfiesParam``.)"""
    if arg.kind == "list":
        return any(_bfcl_list_match(arg, a) for a in accepted)
    cands = _arg_candidate_values(arg)
    return any(
        any(
            _bfcl_value_match(c, a)
            # A typed array-of-enum param: model names ONE value, accepted is ``["Vegan"]``.
            or (isinstance(a, list) and len(a) == 1 and _bfcl_value_match(c, a[0]))
            for a in accepted
        )
        for c in cands
    )


# ── per-call matching (port of matchCallCore) ──────────────────────────────────────


@dataclass(frozen=True)
class ParamVerdict:
    param: str
    typed: bool
    required: bool
    present: bool
    correct: bool


@dataclass(frozen=True)
class AstMatchResult:
    name_match: bool
    match: bool
    params: tuple[ParamVerdict, ...]


@dataclass(frozen=True)
class FnSchema:
    """One offered BFCL function — the subset of the schema scoring needs."""

    name: str
    param_order: tuple[str, ...]
    required: frozenset[str]
    typed: frozenset[str]  # params with an enum / finite domain (where the TS T-gate bites).


def _fn_schema(fn: dict[str, Any]) -> FnSchema:
    params = fn.get("parameters", {}) or {}
    props: dict[str, Any] = params.get("properties", {}) or {}
    required = frozenset(params.get("required", []) or [])
    typed: set[str] = set()
    for name, schema in props.items():
        scalar = schema
        if schema.get("type") == "array" and isinstance(schema.get("items"), dict):
            scalar = schema["items"]
        if scalar.get("enum"):
            typed.add(name)
    return FnSchema(
        name=fn["name"],
        param_order=tuple(props.keys()),
        required=required,
        typed=frozenset(typed),
    )


def match_call_core(
    call: Optional[ParsedCall], fn: FnSchema, gt: dict[str, list[Any]]
) -> AstMatchResult:
    """Score ONE parsed python call against ONE (function schema, accepted-arg map).

    Port of ``matchCallCore`` for the PYTHON binding (the ``call.byName`` / all-by-name
    path). Python output binds every param by name; a positional fallback binds by index.
    Required params must be present and value ∈ accepted; optionals are omittable iff their
    accepted list contains ``""``.
    """
    name_match = call is not None and call.name == fn.name
    params: list[ParamVerdict] = []
    for i, param in enumerate(fn.param_order):
        accepted = gt.get(param, [])
        is_req = param in fn.required
        typed = param in fn.typed
        omittable = any(v == "" for v in accepted)

        arg: Optional[ParsedArg] = None
        if call is not None:
            if call.by_name:
                arg = call.by_name.get(param)
                if arg is None and i < len(call.args):
                    arg = call.args[i]  # positional fallback for a mixed call.
            elif i < len(call.args):
                arg = call.args[i]

        present = arg is not None
        if arg is None:
            correct = (not is_req) and omittable
        else:
            correct = _arg_satisfies_param(arg, accepted)
        params.append(ParamVerdict(param, typed, is_req, present, correct))

    all_ok = all(p.correct for p in params)
    return AstMatchResult(name_match, name_match and all_ok, tuple(params))


# ── set matching for the parallel families (port of bfclAstMatchSet) ───────────────


@dataclass(frozen=True)
class SetMatchResult:
    name_match: bool
    matched_count: int
    expected_count: int
    emitted_count: int
    match: bool
    params: tuple[ParamVerdict, ...]


def _kuhn_max_matching(can_match: list[list[int]], n_right: int) -> list[int]:
    """Maximum bipartite matching (Kuhn's augmenting paths). Returns, per left node, the
    right node it is matched to (or -1). Port of the matching used in ``bfclAstMatchSet`` /
    ``assignRequiredByValue``."""
    right_to_left = [-1] * n_right

    def try_assign(left: int, seen: list[bool]) -> bool:
        for r in can_match[left]:
            if seen[r]:
                continue
            seen[r] = True
            if right_to_left[r] == -1 or try_assign(right_to_left[r], seen):
                right_to_left[r] = left
                return True
        return False

    n_left = len(can_match)
    left_matched = [False] * n_left
    for left in range(n_left):
        if try_assign(left, [False] * n_right):
            left_matched[left] = True
    # Invert: left node → its right node.
    left_to_right = [-1] * n_left
    for r in range(n_right):
        if right_to_left[r] != -1:
            left_to_right[right_to_left[r]] = r
    return left_to_right


def bfcl_ast_match_set(
    calls: list[ParsedCall],
    expected: list[dict[str, dict[str, list[Any]]]],
    schema_for: Callable[[str], Optional[FnSchema]],
) -> SetMatchResult:
    """Order-independent set match for the parallel families (port of ``bfclAstMatchSet``).

    Each (emitted, expected) pair is scored by ``match_call_core``; a maximum bipartite
    matching of expected→emitted maximises satisfied expected calls. ENTRY pass is
    BFCL-faithful all-or-nothing: every expected call satisfied AND no spurious extra call.
    """
    n_exp = len(expected)
    n_emit = len(calls)
    pair_result: list[list[Optional[AstMatchResult]]] = [
        [None] * n_emit for _ in range(n_exp)
    ]
    can_match: list[list[int]] = []
    for e, gt_map in enumerate(expected):
        fn_name = next(iter(gt_map.keys()), "")
        fn = schema_for(fn_name)
        gt_args = next(iter(gt_map.values()), {})
        row: list[int] = []
        for m in range(n_emit):
            r = (
                match_call_core(calls[m], fn, gt_args)
                if fn is not None
                else AstMatchResult(False, False, ())
            )
            pair_result[e][m] = r
            if r.match:
                row.append(m)
        can_match.append(row)

    assignment = _kuhn_max_matching(can_match, n_emit)

    params: list[ParamVerdict] = []
    matched_count = 0
    name_match_all = True
    for e in range(n_exp):
        gt_map = expected[e]
        fn_name = next(iter(gt_map.keys()), "")
        m = assignment[e]
        if m != -1:
            matched_count += 1
            r = pair_result[e][m]
            assert r is not None
            params.extend(r.params)
            if not r.name_match:
                name_match_all = False
        else:
            fn = schema_for(fn_name)
            gt_args = next(iter(gt_map.values()), {})
            r = (
                match_call_core(None, fn, gt_args)
                if fn is not None
                else AstMatchResult(False, False, ())
            )
            params.extend(r.params)
            name_match_all = False  # unmatched expected call ⇒ its function wasn't named.

    match = matched_count == n_exp and n_emit == n_exp
    return SetMatchResult(
        name_match=name_match_all,
        matched_count=matched_count,
        expected_count=n_exp,
        emitted_count=n_emit,
        match=match,
        params=tuple(params),
    )


# ── top-level entry scorer (dispatches single-call vs set by category) ─────────────


@dataclass(frozen=True)
class EntryScore:
    matched: bool  # the BFCL all-or-nothing verdict (single-call match or exact-set match).
    name_match: bool
    parsed: bool  # at least one call parsed out of the model output.
    params: tuple[ParamVerdict, ...]
    # parallel families only: per-call recovery (matched / expected calls).
    matched_calls: int = 0
    expected_calls: int = 0
    emitted_calls: int = 0


def score_irrelevance(offered: list[dict[str, Any]], model_output: str) -> EntryScore:
    """Score one IRRELEVANCE entry. The model is given functions that do NOT apply; it is
    CORRECT iff it emits NO valid call to a PROVIDED function (prose / "none apply" / empty =
    correct; any parseable call naming an offered function = a false positive = incorrect).

    The verdict turns on whether a parsed call NAMES an offered function — prose that merely
    mentions a function name without a balanced ``name(...)`` does not parse to a call, and a
    parsed call to some other (non-offered) symbol is not a false positive either.
    """
    offered_names = {fn["name"] for fn in offered}
    # parse_python_forms with the offered names: a bare ``(...)`` is only inferred as a call when
    # exactly one function is offered (same leniency as the AST tracks). Filter to calls whose
    # name is actually one of the offered functions — that is the false-positive condition.
    calls = parse_python_forms(model_output, [fn["name"] for fn in offered])
    false_positive_calls = [c for c in calls if c.name in offered_names]
    emitted = len(false_positive_calls)
    correct = emitted == 0
    return EntryScore(
        matched=correct,  # "matched" here means "got the irrelevance verdict right".
        name_match=correct,
        parsed=emitted > 0,  # parsed==True means a (wrong) call was emitted.
        params=(),
        matched_calls=0,
        expected_calls=0,
        emitted_calls=emitted,
    )


def score_entry(
    category: str,
    offered: list[dict[str, Any]],
    ground_truth: list[dict[str, dict[str, list[Any]]]],
    model_output: str,
) -> EntryScore:
    """Score one model output against one BFCL entry, dispatching on category.

    Takes the entry fields EXPLICITLY (``category`` / offered ``function`` list /
    ``ground_truth`` list) rather than a particular entry object, so this scorer stays
    decoupled from the dataset representation (boundary: no cross-import).

    ``simple`` / ``multiple`` → single-call match (``bfclAstMatch``).
    ``parallel`` / ``parallel_multiple`` → set match (``bfclAstMatchSet``).
    """
    if category in ("irrelevance", "live_irrelevance"):
        return score_irrelevance(offered, model_output)

    offered_names = [fn["name"] for fn in offered]
    schemas = {fn["name"]: _fn_schema(fn) for fn in offered}

    if category in ("parallel", "parallel_multiple"):
        calls = parse_python_forms(model_output, offered_names)
        result = bfcl_ast_match_set(
            calls, ground_truth, lambda name: schemas.get(name)
        )
        return EntryScore(
            matched=result.match,
            name_match=result.name_match,
            parsed=len(calls) > 0,
            params=result.params,
            matched_calls=result.matched_count,
            expected_calls=result.expected_count,
            emitted_calls=result.emitted_count,
        )

    # single-call (simple/multiple): BFCL requires EXACTLY ONE emitted call — its checker fails with
    # "Wrong number of functions" when len(model_output) != 1 (ast_checker.py). So count the calls in
    # the FIRST [...] group; a runaway/hallucinated EXTRA call fails the entry even when the first call
    # is correct (this was the +10pp leniency: we took the first call and ignored the extras).
    gt_map = ground_truth[0]
    expected_name = next(iter(gt_map.keys()), "")
    gt_args = next(iter(gt_map.values()), {})
    fn = schemas.get(expected_name) or _fn_schema(offered[0])
    emitted = parse_python_forms(model_output, offered_names)
    call = emitted[0] if emitted else None
    result = match_call_core(call, fn, gt_args)
    wrong_count = len(emitted) != 1  # BFCL "Wrong number of functions" — extras (or none) fail.
    return EntryScore(
        matched=result.match and not wrong_count,
        name_match=result.name_match,
        parsed=call is not None,
        params=result.params,
        matched_calls=1 if (result.match and not wrong_count) else 0,
        expected_calls=1,
        emitted_calls=len(emitted),
    )
