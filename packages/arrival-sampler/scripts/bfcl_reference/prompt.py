"""Prompt construction for the python reference benchmark.

BOUNDARY: reference-benchmark prompting. No sampler imports.

Two prompt MODES live here:

* ``native`` (the default, for the constraint-delta experiment) — the baseline measures each
  model's NATIVE python function-calling ability with OUR own terse instruction. Functions go
  in the USER turn; the model is told to emit ``fn(arg=val, ...)``, one call per line.

* ``calibrate`` (BFCL-faithful, for leaderboard calibration) — a byte-for-byte reproduction of
  BFCL v4's **prompt-mode default** system prompt
  (``ret_fmt=python&tool_call_tag=False&func_doc_fmt=json&prompt_fmt=plaintext&style=classic``)
  so our numbers can be compared against the published per-category columns. The "classic"
  system prompt carries the JSON func-doc and the ``[func_name(arg=val), ...]`` bracket-wrapped
  call contract; the USER turn carries only the original question content. The exact strings are
  taken from gorilla's ``bfcl_eval/constants/default_prompts.py`` + ``model_handler/utils.py``
  at commit ``6ea57973c7a6097fd7c5915698c54c17c5b1b6c8`` (the same commit the dataset pins) —
  not paraphrased.
"""

from __future__ import annotations

import json
from typing import Any

# ── native mode (the existing terse prompt — DEFAULT; do not change its semantics) ───────────

_SYSTEM = (
    "You are a function-calling assistant. You are given one or more python functions and a "
    "user request. Respond with ONLY the python function call(s) that fulfill the request — "
    "no prose, no explanation, no markdown fences. Use keyword arguments "
    "(e.g. fname(arg1=value1, arg2=value2)). If multiple calls are needed, emit them all, "
    "one per line. Use python literals for values (strings in quotes, numbers bare, "
    "True/False/None, [..] for lists)."
)


def system_prompt() -> str:
    return _SYSTEM


def user_prompt(functions: list[dict[str, Any]], query: str) -> str:
    """Render the offered functions + the user query into the user turn (native mode)."""
    rendered = json.dumps(functions, indent=2)
    return (
        f"Available functions:\n{rendered}\n\n"
        f"User request: {query}\n\n"
        "Emit the python function call(s):"
    )


# ── calibrate mode (BFCL-faithful classic prompt) ────────────────────────────────────────────
#
# Reproduces the assembly in gorilla's ``formulate_system_prompt`` for the default config
# ``ret_fmt=python&tool_call_tag=False&func_doc_fmt=json&prompt_fmt=plaintext&style=classic``:
#   plaintext template = "{persona}{task}\n\n{tool_call_format}\n\n{multiturn_behavior}\n\n{available_tools}"
# The default config's output is exactly the ``_DEFAULT_SYSTEM_PROMPT`` reference string in
# ``default_prompts.py``. We hold the component strings verbatim and assemble them the same way
# (persona and task are concatenated with NO separator — matching upstream ``{persona}{task}``).

# These five strings are the "classic" PROMPT_STYLE_TEMPLATES entries, verbatim from upstream.
# NOTE: upstream concatenates ``{persona}{task}`` with NO separator, so the live system prompt
# reads "...composing functions.You are given..." (no space). The ``_DEFAULT_SYSTEM_PROMPT`` string
# in default_prompts.py is a hand-typed reference WITH a space and does NOT match what the code
# emits — we reproduce the CODE, so ``_BFCL_TASK`` carries no leading space.
_BFCL_PERSONA = "You are an expert in composing functions."
_BFCL_TASK = (
    "You are given a question and a set of possible functions. Based on the question, you will "
    "need to make one or more function/tool calls to achieve the purpose. If none of the "
    "functions can be used, point it out. If the given question lacks the parameters required by "
    "the function, also point it out."
)
# OUTPUT_FORMAT_MAPPING["python"]; PARAM_TYPE_MAPPING["python"] == "" (so a double space remains,
# exactly as upstream produces — we reproduce, not "clean up").
_BFCL_OUTPUT_FORMAT_PYTHON = (
    "[func_name1(params_name1=params_value1, params_name2=params_value2...), func_name2(params)]"
)
_BFCL_TOOL_CALL_NO_TAG = (
    "You should only return the function calls in your response.\n\n"
    "If you decide to invoke any of the function(s), you MUST put it in the format of "
    f"{_BFCL_OUTPUT_FORMAT_PYTHON}.  You SHOULD NOT include any other text in the response."
)
_BFCL_MULTITURN = (
    "At each turn, you should try your best to complete the tasks requested by the user within "
    "the current turn. Continue to output functions to call until you have fulfilled the user's "
    "request to the best of your ability. Once you have no more functions to call, the system "
    "will consider the current turn complete and proceed to the next turn or task."
)
# available_tools["classic"].format(format="json", functions=<json.dumps(functions, indent=4)>)
_BFCL_AVAILABLE_TOOLS_HEAD = "Here is a list of functions in json format that you can invoke.\n"

# Set True at import time only if the verbatim strings above were swapped for a fallback.
USED_FALLBACK = False


def bfcl_classic_system_prompt(functions: list[dict[str, Any]]) -> str:
    """BFCL v4 prompt-mode default 'classic' system prompt (functions live in the SYSTEM turn).

    Mirrors upstream ``formulate_system_prompt`` for the default config exactly:
    ``{persona}{task}\\n\\n{tool_call_no_tag}\\n\\n{multiturn}\\n\\n{available_tools}`` where the
    func-doc is ``json.dumps(functions, indent=4)``.
    """
    func_doc = json.dumps(functions, indent=4)
    available_tools = f"{_BFCL_AVAILABLE_TOOLS_HEAD}{func_doc}\n"
    return (
        f"{_BFCL_PERSONA}{_BFCL_TASK}\n\n"
        f"{_BFCL_TOOL_CALL_NO_TAG}\n\n"
        f"{_BFCL_MULTITURN}\n\n"
        f"{available_tools}"
    )


def bfcl_user_prompt(query: str) -> str:
    """BFCL prompt-mode user turn: the original question content, unmodified (functions are in
    the system prompt, not here)."""
    return query
