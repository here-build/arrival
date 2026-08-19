"""Register our LM Studio (and, later, our own sampler) served models into the official
BFCL ``MODEL_CONFIG_MAPPING`` — IN PLACE, without editing the vendored submodule.

BOUNDARY: this is the ONLY here.build-authored code that touches BFCL internals. It adds rows
to the official model registry; it does not patch handlers, scorers, datasets, or the CLI. Run
it (via ``bfcl_lmstudio.py``) BEFORE the ``bfcl`` CLI reads the mapping.

──────────────────────────────────────────────────────────────────────────────────────────────
WHY ``OpenAICompletionsHandler`` AND NOT the OSS handlers
──────────────────────────────────────────────────────────────────────────────────────────────
BFCL ships two ways to talk to a local/remote OpenAI-compatible server:

1. ``OSSHandler`` (``model_handler/local_inference/base_oss_handler.py``) — the path the
   pre-registered ``katanemo/Arch-Agent-*`` / ``MadeAgents/Hammer2.1-*`` rows use. It:
     • loads the model's HF *tokenizer* locally (``AutoTokenizer.from_pretrained(model_name)``)
       to apply the chat template + count tokens, then
     • hits the ``/v1/completions`` (text-completion) endpoint with a PRE-TEMPLATED string,
       sending ``model=<the HF id>``.
   Two frictions for us: (a) it needs the HF tokenizer downloaded, and (b) it sends the HF id
   (``katanemo/Arch-Agent-3B``) as the ``model`` field, but LM Studio serves it as
   ``arch-agent-3b`` → "model not found". (``REMOTE_OPENAI_TOKENIZER_PATH`` can split those, but
   it is the heavier path.)

2. ``OpenAICompletionsHandler`` (``model_handler/api_inference/openai_completion.py``) — a pure
   OpenAI-compatible **chat/completions** client. It:
     • reads ``OPENAI_BASE_URL`` + ``OPENAI_API_KEY`` (+ optional ``OPENAI_DEFAULT_HEADERS``)
       from the environment — the base URL is a clean, non-hardcoded knob,
     • sends the ``model`` field verbatim (so we set it to the LM-Studio served id),
     • supports BOTH function-calling modes off the ``is_fc_model`` flag:
         – ``is_fc_model=True``  → native ``tools=[...]`` request, parses ``message.tool_calls``,
         – ``is_fc_model=False`` → prompt mode (functions in the system prompt, text reply),
     • lets the SERVER apply the chat template (no local tokenizer download).

(2) is the faithful match for an arbitrary OpenAI-compatible endpoint — LM Studio today, our
own constrained ``/v1/chat/completions`` sampler tomorrow. The endpoint is swapped purely by
``OPENAI_BASE_URL``; nothing here is LM-Studio-specific except the default served ids below.

──────────────────────────────────────────────────────────────────────────────────────────────
THE BASE-URL KNOB (the load-bearing detail for driving our own endpoint)
──────────────────────────────────────────────────────────────────────────────────────────────
    OPENAI_BASE_URL          e.g. http://localhost:1234/v1   (LM Studio)
                             e.g. http://localhost:8080/v1   (our sampler, later)
    OPENAI_API_KEY           any non-empty dummy (LM Studio ignores it; our server may check)
    OPENAI_DEFAULT_HEADERS   optional JSON, e.g. {"X-Trace": "bfcl"} — extra headers per request

No code change is needed to repoint BFCL at a different OpenAI-compatible server: set
``OPENAI_BASE_URL`` and pick a registered model whose ``model_name`` matches a served id.
"""

from __future__ import annotations

from bfcl_eval.constants import model_config as _mc
from bfcl_eval.model_handler.api_inference.openai_completion import OpenAICompletionsHandler

# The served-id → display-name roster. Keys are EXACTLY the ids LM Studio reports at
# ``GET /v1/models`` (see scripts/bfcl_reference/lmstudio.py + the project's rosters.json).
# The ``model_name`` we register IS that served id — it goes out verbatim as the OpenAI
# ``model`` field, so LM Studio resolves it without a mapping layer.
#
# Each served id is registered TWICE:
#   "<id>"      → prompt mode   (is_fc_model=False) — BFCL puts functions in the system prompt
#   "<id>-FC"   → function-call (is_fc_model=True)  — BFCL sends native tools=, reads tool_calls
# Pick the variant via ``--model`` to compare the two channels (matches the leaderboard's split
# between a model's "(Prompt)" and "(FC)" rows).
_LMSTUDIO_SERVED_IDS: dict[str, str] = {
    "arch-agent-1.5b": "Arch-Agent-1.5B (LM Studio)",
    "arch-agent-3b": "Arch-Agent-3B (LM Studio)",
    "arch-agent-7b": "Arch-Agent-7B (LM Studio)",
    "hammer2.1-3b": "Hammer2.1-3b (LM Studio)",
    "ibm/granite-4-h-tiny": "Granite-4.0-H-Tiny (LM Studio)",
    "qwen/qwen3-8b": "Qwen3-8B (LM Studio)",
    "qwen/qwen3-14b": "Qwen3-14B (LM Studio)",
    "nanbeige4.1-3b": "Nanbeige4.1-3B (LM Studio)",
    "essentialai/rnj-1": "rnj-1 (LM Studio)",
    "zai-org/glm-4.7-flash": "GLM-4.7-Flash (LM Studio)",
    # FULL-PRECISION (f16/bf16) arch for the quantization-calibration run: the q8 `arch-agent-1.5b` reads ~5pp
    # below the published fp16 leaderboard (simple_python 84.5 vs 89.5); this row points at the f16 gguf so we
    # can confirm the gap closes (= the divergence is quant, not harness). LM Studio serves it under the file id.
    "arch-agent-1.5b.gguf": "Arch-Agent-1.5B-f16 (LM Studio)",
    # add any other served id here; it inherits the OpenAI-compatible chat/FC wiring.
    #
    # OUR CONSTRAINED-SAMPLER ENDPOINT (the "oracle" side). Served by scripts/openai-server, NOT LM Studio —
    # run with OPENAI_BASE_URL=http://localhost:1235/v1 pointing at the endpoint. The endpoint resolves this id
    # to the arch-1.5b gguf and decodes it under the grant-Σ + grammar oracle (constrained scheme → tool_calls).
    # Use the `-FC` row (endpoint default contract returns OpenAI tool_calls). Result dir is separate from the
    # LM-Studio rows, so the two channels (native vs oracle) compare side by side.
    "arch-agent-1.5b-oracle": "Arch-Agent-1.5B (oracle/constrained, q8)",
  # f16 oracle — same constrained endpoint, full-precision gguf. Lets us isolate the constraint's effect on a
  # CALIBRATED baseline (f16 native == published) and compare oracle q8 vs f16 head to head.
  "arch-agent-1.5b-f16-oracle": "Arch-Agent-1.5B (oracle/constrained, f16)",
}

# Marker so the wrapper can sanity-print what it added.
LMSTUDIO_REGISTERED: list[str] = []


def _entry(served_id: str, display: str, *, is_fc: bool) -> _mc.ModelConfig:
    """One ``ModelConfig`` row pointing at the OpenAI-compatible chat handler.

    ``model_name`` is the served id (sent verbatim as the OpenAI ``model`` field). ``url`` /
    ``org`` / ``license`` are metadata-only (the leaderboard renders them); they do not affect
    inference.

    ``underscore_to_dot`` tracks the OpenAI tool-name regex, NOT result-dir naming. The OpenAI
    function-calling API restricts names to ``^[a-zA-Z0-9_-]{1,64}$`` — NO dots — so a BFCL
    namespaced function like ``math.factorial`` is sanitized to ``math_factorial`` before the model
    ever sees it, and the model emits the underscored name. The AST checker only re-matches when
    ``underscore_to_dot=True`` (it converts the dotted GROUND TRUTH to underscores —
    ``ast_checker.py`` ``re.sub(r"\\.", "_", name)``, applied ONLY to names containing a dot, so a
    genuine ``get_weather`` is never corrupted). Therefore:
      • FC rows (``is_fc=True``) hit the tools API → dots stripped → MUST be True, else every dotted
        function scores 0 ("Function name not found"). (The official ``katanemo/Arch-Agent`` row is
        False only because it runs via the OSS/vLLM prompt-template path, not the OpenAI tools API.)
      • Prompt rows render functions as TEXT in the system prompt, where dots survive → False.
    """
    suffix = " · FC" if is_fc else " · Prompt"
    return _mc.ModelConfig(
        model_name=served_id,
        display_name=display + suffix,
        url="https://lmstudio.ai",
        org="local",
        license="varies-per-model",
        model_handler=OpenAICompletionsHandler,
        input_price=None,
        output_price=None,
        is_fc_model=is_fc,
        underscore_to_dot=is_fc,
    )


def register(*, overwrite: bool = False) -> list[str]:
    """Inject the LM Studio rows into the live ``MODEL_CONFIG_MAPPING`` (in place).

    Mutates the SAME dict object the CLI and the generation entrypoint already imported
    by-reference, so the additions are visible everywhere. Returns the list of registered keys.
    Existing keys are left untouched unless ``overwrite=True`` (so we never clobber a
    pre-registered upstream model by accident).
    """
    mapping = _mc.MODEL_CONFIG_MAPPING
    added: list[str] = []
    for served_id, display in _LMSTUDIO_SERVED_IDS.items():
        for key, is_fc in ((served_id, False), (f"{served_id}-FC", True)):
            if key in mapping and not overwrite:
                continue
            mapping[key] = _entry(served_id, display, is_fc=is_fc)
            added.append(key)
    LMSTUDIO_REGISTERED.clear()
    LMSTUDIO_REGISTERED.extend(added)
    return added


if __name__ == "__main__":  # quick self-check: register + list, no inference
    keys = register()
    print(f"registered {len(keys)} LM Studio model rows:")
    for k in keys:
        print(f"  {k}")
