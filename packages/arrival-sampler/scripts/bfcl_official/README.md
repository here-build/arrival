# BFCL v4 official reference runner (LM Studio-wired)

The **official** Berkeley Function Calling Leaderboard (`bfcl-eval`) v4 suite — the full,
faithful scoring pipeline — pointed at our local **LM Studio** OpenAI-compatible endpoint.

This provides the *minimal wrapper* to run the official BFCL harness against our sampler (or LM Studio).

The wrapper is just model registration + delegation to the official `bfcl` CLI (see bfcl_lmstudio.py).
All scoring, multi-turn, agentic logic is from the official gorilla/bfcl_eval — we do not reimplement.

Point `OPENAI_BASE_URL` at the sampler's server for constrained numbers.

---

## What's here

| File | Role |
|---|---|
| `gorilla/` | the official BFCL as a **git submodule** (gorilla repo, sparse-checked-out to `berkeley-function-call-leaderboard/`), pinned to commit `6ea5797` = PyPI release **2026.3.23** |
| `register_lmstudio_models.py` | registers our LM Studio served-id models into BFCL's `MODEL_CONFIG_MAPPING`, pointed at the OpenAI-compatible chat/FC handler (no upstream edit) |
| `bfcl_lmstudio.py` | thin wrapper: registers the rows, then delegates verbatim to the upstream `bfcl` CLI |
| `verify_pipeline.py` | **offline** verification — datasets load + all four scoring axes on canned input (no model calls) |
| `setup.sh` | create the python 3.12 venv, `pip install -e` from the submodule + `soundfile` |
| `run.sh` | convenience dispatcher (`verify` / `models` / `categories` / `mini` / `gen` / `eval`) |
| `.env.example` | endpoint config (`OPENAI_BASE_URL` etc.) — copy to `.env` |
| `requirements.lock.txt` | full resolved dependency lock (python 3.12) for reproducibility |
| `.venv/`, `result/`, `score/`, `.env` | gitignored (venv recreated via `setup.sh`; outputs land under `BFCL_PROJECT_ROOT` = this dir) |

---

## Prerequisites

- **python 3.12** (`brew install python@3.12`). System python 3.14 is too new for BFCL's deps.
- **LM Studio** running with its local server on (Developer → Start Server), default
  `http://localhost:1234/v1`, and the model(s) you want loaded/available.
- The gorilla **submodule** checked out (a sparse checkout — only the BFCL subdir, ~14 MB):
  ```bash
  git submodule update --init foundations/arrival/arrival-sampler/scripts/bfcl_official/gorilla
  ```

## One-time setup

```bash
cd foundations/arrival/arrival-sampler/scripts/bfcl_official
./setup.sh                 # creates ./.venv, installs bfcl_eval (editable) + soundfile
cp .env.example .env       # then edit OPENAI_BASE_URL / OPENAI_API_KEY if not LM Studio defaults
```

`setup.sh` installs `soundfile` explicitly — it's a `qwen_agent` transitive dep the wheel
doesn't pull, and the `bfcl` CLI fails to import without it.

---

## How the LM Studio endpoint is wired (the load-bearing detail)

Our model rows use BFCL's **`OpenAICompletionsHandler`** (`model_handler/api_inference/
openai_completion.py`) — a pure OpenAI-compatible **chat/completions** client. Its endpoint is a
clean, non-hardcoded environment knob:

| env var | meaning | default for us |
|---|---|---|
| `OPENAI_BASE_URL` | the OpenAI-compatible endpoint | `http://localhost:1234/v1` (LM Studio) |
| `OPENAI_API_KEY` | any non-empty dummy (LM Studio ignores it) | `lm-studio` |
| `OPENAI_DEFAULT_HEADERS` | optional JSON of extra request headers | *(empty)* |

To repoint BFCL at **any other** OpenAI-compatible server (e.g. our own constrained sampler's
`/v1/chat/completions`), change `OPENAI_BASE_URL` — nothing else. The handler supports **both**
function-calling channels off each model row's `is_fc_model` flag:

- `--model <id>-FC` → `is_fc_model=True` → native `tools=[…]` request, parses `message.tool_calls`
- `--model <id>` → `is_fc_model=False` → prompt mode (functions in the system prompt, text reply)

We do **not** use the OSS/`base_oss_handler` path (which loads a local HF tokenizer and hits
`/v1/completions` with a pre-templated string, sending the HF id as the `model` field — which
mismatches LM Studio's served id). The chat handler sends our **served id verbatim** and lets
the server apply the chat template.

### Registered models (served-id → handler)

`register_lmstudio_models.py` registers each LM Studio served id twice (prompt + `-FC`):
`arch-agent-1.5b/3b/7b`, `hammer2.1-3b`, `ibm/granite-4-h-tiny`, `qwen/qwen3-8b`,
`qwen/qwen3-14b`, `nanbeige4.1-3b`, `essentialai/rnj-1`, `zai-org/glm-4.7-flash`. Add any other
served id to the `_LMSTUDIO_SERVED_IDS` dict — it inherits the same wiring. Confirm what's
loaded with `curl http://localhost:1234/v1/models`.

---

## Categories (v4) and Overall weighting

The full v4 suite (`./run.sh categories` for the live list). Group alias `all` = 23 categories:

- **Non-Live AST** (10): `simple_python`, `simple_java`, `simple_javascript`, `multiple`,
  `parallel`, `parallel_multiple`, `irrelevance`
- **Live AST** (6): `live_simple`, `live_multiple`, `live_parallel`, `live_parallel_multiple`,
  `live_irrelevance`, `live_relevance`
- **Multi-Turn** (4): `multi_turn_base`, `multi_turn_miss_func`, `multi_turn_miss_param`,
  `multi_turn_long_context`
- **Agentic** (5): `memory_kv`, `memory_vector`, `memory_rec_sum`, `web_search_base`,
  `web_search_no_snippet`
- **Non-scoring** (1): `format_sensitivity`

Group aliases also accepted: `all`, `all_scoring`, `single_turn`, `non_live`, `live`,
`multi_turn`, `agentic`, `memory`, `web_search`, `python`, `non_python`.

**Retired in v4** (not scored, not present): executable `exec_*`, `rest`, `sql`. (They survive
only under `gorilla/.../bfcl_eval/data/unused_datasets/`.)

**Overall score weighting (v4):**

```
Overall = 0.10·NonLive + 0.10·Live + 0.10·Hallucination + 0.30·MultiTurn + 0.40·Agentic
```

(“Hallucination” = the irrelevance + relevance categories.) A single AST category is <1 % of
Overall. **Agentic (40 %) needs a real `SERPAPI_API_KEY` for web search — it cannot run
offline.** Skip `web_search_*` if you don't have one.

---

## Run the FULL suite

```bash
# all scoring categories (skip web_search if no SerpAPI key), one model:
./run.sh gen  arch-agent-3b  all_scoring
./run.sh eval arch-agent-3b  all_scoring
./run.sh bfcl scores                       # render the leaderboard table
```

Or the upstream CLI directly (the wrapper passes everything through):

```bash
BFCL_PROJECT_ROOT="$PWD" .venv/bin/python bfcl_lmstudio.py \
  generate --model arch-agent-3b --test-category non_live,multi_turn --skip-server-setup
BFCL_PROJECT_ROOT="$PWD" .venv/bin/python bfcl_lmstudio.py \
  evaluate --model arch-agent-3b --test-category non_live,multi_turn
```

> `--skip-server-setup` is **required** for our path — it tells BFCL to use the existing
> endpoint (`OPENAI_BASE_URL`) and **NOT** spin up its own vLLM/SGLang server.

Outputs land in `./result/` and `./score/` (gitignored), because `run.sh` exports
`BFCL_PROJECT_ROOT="$PWD"`.

## Run a MINI subset (a few entries)

```bash
# a whole small category (24 entries):
./run.sh gen  arch-agent-3b  live_parallel_multiple
./run.sh eval arch-agent-3b  live_parallel_multiple   # --partial-eval, scores the present set
```

`./run.sh eval` always passes **`--partial-eval`**, so it scores over whatever entries are
present in `result/` (a subset) instead of erroring on a count mismatch with the full category.
For a full category run (present == full count) it is a no-op — identical accuracy.

## The single-entry live smoke (`./run.sh mini`)

```bash
cd foundations/arrival/arrival-sampler/scripts/bfcl_official
cp .env.example .env                          # OPENAI_BASE_URL already = LM Studio
./run.sh mini  arch-agent-1.5b  simple_python   # generate ONE entry + score it (prints accuracy)
```

`./run.sh mini <model> <category> [id]` writes a one-id filter to BFCL's
`test_case_ids_to_generate.json`, runs `generate … --run-ids --skip-server-setup` (exactly one
request), then `evaluate … --partial-eval` and prints the accuracy. Omit `[id]` for the
category's first entry. (For the `-FC` channel: `./run.sh mini arch-agent-1.5b-FC simple_python`.)

Confirm LM Studio is reachable first: `curl -s http://localhost:1234/v1/models | head`.

> **Context-size errors under GPU contention.** If a heavy benchmark is using the GPU, LM Studio
> may JIT-load the model with a *reduced* context (or queue the request behind the big model for
> 60 s+) and return `400 - {'error': 'Context size has been exceeded.'}` — written into the
> result as an error entry (so `generate` still exits 0). This is **not** a runner bug: a direct
> `curl` succeeds when LM Studio is free. Fix by giving the model adequate context (load
> arch-agent-1.5b with its full 32 k context, or pause the overnight run) before launching.
> Verify the loaded context with
> `curl -s http://localhost:1234/api/v0/models/arch-agent-1.5b | python3 -c "import sys,json;print(json.load(sys.stdin)['loaded_context_length'])"`.

## FULL Arch-Agent-1.5B calibration (all categories)

Launch when LM Studio is free (one model loaded with full context). No `--run-ids` → full
per-category counts, so `evaluate` needs no special handling (the `--partial-eval` we always pass
is a no-op at full counts):

```bash
cd foundations/arrival/arrival-sampler/scripts/bfcl_official
cp .env.example .env                         # OPENAI_BASE_URL=http://localhost:1234/v1

# all SCORING categories EXCEPT agentic web_search (needs a real SERPAPI_API_KEY):
CATS="non_live,live,multi_turn,memory"
./run.sh gen  arch-agent-1.5b  "$CATS"        # the long run — hours
./run.sh eval arch-agent-1.5b  "$CATS"
./run.sh bfcl scores                          # render the leaderboard table

# include agentic web search too (only if SERPAPI_API_KEY is set in .env):
#   CATS="all_scoring"

# the native function-call channel instead of prompt mode (compare the two rows):
#   ./run.sh gen  arch-agent-1.5b-FC  "$CATS"  &&  ./run.sh eval arch-agent-1.5b-FC "$CATS"
```

`all_scoring` = every scored category (the 22 minus `format_sensitivity`). Drop `memory` too if
you only want the AST + multi-turn calibration. Each category's results land under
`result/arch-agent-1.5b/…`; scores under `score/`. Resume-friendly: re-running `gen` without
`--allow-overwrite` skips already-generated entries.

---

## Verify WITHOUT a live run (offline)

```bash
./run.sh verify
```

Confirms, with no model calls:

1. **All 23 v4 category datasets load** (via BFCL's own `load_dataset_entry`) — ~10,417 entries.
2. **Each of the four scoring axes** returns a sensible verdict on canned input:
   - AST value-match (`ast_checker`) — correct call → valid, wrong value → invalid
   - Hallucination boolean (`is_empty_output`) — empty vs. non-empty discrimination
   - Multi-turn state+response (`multi_turn_checker`) — runs the executor on a real
     `multi_turn_base` entry; ground-truth replay → valid
   - Agentic substring (`agentic_checker`) — answer present → valid, absent → invalid
3. **The registry resolves our LM Studio rows** to `OpenAICompletionsHandler` (the
   `OPENAI_BASE_URL` path), with the FC/prompt split.

Exit 0 = all passed.

---

## Reproducibility / pinning

- `bfcl_eval` is installed **editable** from the `gorilla` submodule, pinned to commit
  **`6ea57973c7a6097fd7c5915698c54c17c5b1b6c8`** — the same commit our `bfcl_reference/` dataset
  vendoring already pins, and identical to PyPI release **`2026.3.23`** (same date). To bump:
  `git -C gorilla fetch && git -C gorilla checkout <newer-commit>`, re-run `./setup.sh`, and
  commit the new gitlink.
- `requirements.lock.txt` records the full resolved dependency set for the venv.
- The datasets ship **inside** the package (`gorilla/.../bfcl_eval/data/`) — no first-run
  download.

## Notes / gotchas

- `bfcl version` raises a harmless `PackageNotFoundError` for the editable install (it queries
  dist metadata named `bfcl`); the provenance is the submodule commit hash. All other commands
  work.
- `soundfile` must be installed (handled by `setup.sh`) or the CLI fails to import (qwen_agent).
- Web-search agentic categories require `SERPAPI_API_KEY` and live network — they can't run
  against LM Studio alone.
