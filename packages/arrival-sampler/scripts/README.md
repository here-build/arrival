# BFCL python reference-benchmark runner

A standalone Python tool that measures each roster model's **native** python
function-calling ability on the BFCL v4 python tracks — **no arrival oracle, no Scheme, no
constrained decoding**. This establishes the baseline the sampler's constrained runs are
compared against.

## Boundary (read first)

Lightweight reference runner for native (unconstrained) BFCL python tracks. Reads only rosters.json.
No sampler TS imported.

For constrained sampler numbers, use the official harness wrapper (this dir's bfcl_official/) pointing at the
sampler OpenAI server. We minimize our code; rely on official BFCL for scoring/harness.

- **Inference** goes through **LM Studio's** OpenAI-compatible HTTP API so V can watch
  progress + logs live in the LM Studio UI (never a local gguf load).
- **Dataset**: BFCL v4 python tracks fetched from
  [github.com/ShishirPatil/gorilla](https://github.com/ShishirPatil/gorilla) at commit
  `6ea57973c7a6097fd7c5915698c54c17c5b1b6c8`,
  `berkeley-function-call-leaderboard/bfcl_eval/data/` (the same source + commit the TS side
  vendored from).
- **Scoring**: a faithful port of
  `inhuman/examples/intent-eval/src/bfcl/bfcl-score.ts` — same AST-matching rules (light
  type coercion, case-insensitive string match, value-set membership, optional params
  omittable, order-independent Kuhn bipartite set matching for the parallel families). We
  replicate rather than vendor gorilla's `ast_checker` so the python baseline is
  methodologically **identical** to the constrained TS runs it is compared against (a second,
  subtly-different matcher would make the two columns incomparable).

## Install

Zero third-party dependencies — pure Python standard library. Requires **Python 3.10+**.

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt   # installs nothing — stdlib only, by design
```

## Run

From this `scripts/` directory:

```bash
# Scoring self-test — no LM Studio needed (verifies sampling + the AST matcher).
python -m bfcl_reference --dry-run

# Tiny live smoke test through the loaded models in LM Studio.
python -m bfcl_reference --roster fast --n 5

# The full sweep (V kicks this off once all models are downloaded in LM Studio).
python -m bfcl_reference --roster full --n 400 --seed 20260621

# Restrict to specific roster keys.
python -m bfcl_reference --models qwen/qwen3-8b,qwen/qwen3-14b --n 100
```

### Two modes: `native` (default) vs `calibrate`

The runner has **two prompt modes**, selected by `--mode`:

| | `native` (default) | `calibrate` |
|---|---|---|
| **Purpose** | the constraint-delta experiment (our terse prompt) | **leaderboard calibration** against published BFCL numbers |
| **Prompt** | our own instruction; functions in the **user** turn | byte-faithful BFCL v4 *prompt-mode default* "classic" system prompt (`ret_fmt=python&tool_call_tag=False&func_doc_fmt=json&prompt_fmt=plaintext&style=classic`); functions in the **system** turn; JSON func-doc; `[func_name(arg=val), ...]` call format |
| **Sampling** | seeded stratified `--n` draw, **control ids excluded** | **FULL** category sets, no sampling, no control exclusion (must match the published denominator) |
| **Categories** | the 4 python-AST tracks | the 4 AST tracks **+** non-live & live **irrelevance** |
| **Output** | per-model score table | per-category **ours-vs-published** comparison + calibration verdict |

The calibrate-mode prompt is reproduced verbatim from gorilla's
`bfcl_eval/constants/default_prompts.py` + `model_handler/utils.py` at the pinned commit (it
byte-matches the assembled default system prompt). The `[...]` bracket wrapper and multiple
comma-separated calls are parsed by the same AST parser as the bare-`fn()` native mode (the
parser searches for `name(` and reads balanced parens, so the surrounding `[ ]` and any markdown
fences are skipped transparently).

**Irrelevance scoring is inverted:** the model is handed functions that do NOT apply and is
CORRECT iff it emits **no valid call to a provided function** (prose / "none apply" / empty =
correct; any parseable call naming an offered function = a false positive). Non-live and live
irrelevance are reported separately and as their unweighted mean (the mean is the published
`Irrelevance` column).

```bash
# SMOKE first — a few entries per category, every category touched (deterministic, upstream order).
python -m bfcl_reference --mode calibrate --models Mungert/Arch-Agent-1.5B-GGUF --smoke-limit 20

# Full calibration for one model (FULL denominators: simple 400, multiple/parallel/par-mult 200
# each, irrelevance 240, live_irrelevance 884 — 2124 entries; cached per cell).
python -m bfcl_reference --mode calibrate --models Mungert/Arch-Agent-1.5B-GGUF
# (--calibrate is an alias for --mode calibrate)
```

> **Overall is NOT reproducible here.** BFCL v4 overall = `0.10·NonLive + 0.10·Live +
> 0.10·Irrelevance + 0.30·MultiTurn + 0.40·Agentic`. 70% of it is Multi-Turn + Agentic, which
> this AST-only harness does not run. A python-AST number is <1% of overall and projects ONLY to
> its per-category column — never to the overall rank. The comparison table shows every v4
> bucket; the ones we don't run are marked "not run — needs …", never silently dropped.

### Flags

| Flag | Default | Meaning |
|---|---|---|
| `--mode {native,calibrate}` | `native` | prompt mode (see table above) |
| `--calibrate` | off | alias for `--mode calibrate` |
| `--smoke-limit <int>` | (none) | calibrate only: at most N entries **per category** (deterministic) |
| `--roster {fast,full,extended,all}` | `full` | which `rosters.json` roster to run |
| `--models <key,key>` | (none) | restrict to specific `owner/repo` roster keys |
| `--n <int>` | `200` | (native only) total entries sampled across the four python tracks |
| `--seed <int>` | `20260621` | (native only) reproducible draw — same seed ⇒ same sample |
| `--base-url <url>` | `http://localhost:1234/v1` | LM Studio OpenAI base URL |
| `--max-tokens <int>` | `512` | max completion tokens per call |
| `--refresh-data` | off | re-fetch the BFCL tracks from gorilla (ignore the dataset cache) |
| `--dry-run` | off | scoring self-test against mock responses (no LM Studio) |

## Environment variables

| Var | Default | Meaning |
|---|---|---|
| `LMSTUDIO_BASE_URL` | `http://localhost:1234/v1` | LM Studio server base URL (overridden by `--base-url`) |

The API key is any non-empty string (LM Studio ignores it); the runner sends a placeholder.

## How it works

1. **Roster** — reads `../rosters.json`; resolves each `owner/repo` key to a served LM Studio
   model id by `GET /v1/models` + normalized repo-name match (lowercase, strip
   non-alphanumerics, drop a trailing `gguf`), mirroring the TS `resolveGguf`. A roster model
   **not currently loaded** in LM Studio is **loud-skipped** with a clear note — never a crash.
2. **Sample** — a seeded, **stratified random** draw across all four python tracks (`simple`,
   `multiple`, `parallel`, `parallel_multiple`), proportional to each track's available size,
   **excluding** every id in the curated control slice (the 40 enum-heavy `simple_python_*`
   entries the TS mechanisms were tuned on — the overfitting guard). The runner prints the
   per-track counts and the control-exclusion count (no silent truncation).
3. **Score** — for each `(model, entry)`: the model's native python output is parsed into a
   call AST and matched against `possible_answer` by the ported BFCL rules. Single-call match
   for `simple`/`multiple`; order-independent exact-set match for the parallel families.
4. **Cache** — two caches under `scripts/.bfcl-cache/` (gitignored): the downloaded BFCL
   dataset, and per-`(model, entry)` responses + scores. A re-run with the same seed/roster
   hits the cache and does **no new inference** for already-scored cells.
5. **Output** — a per-model score table (AST accuracy, per-track breakdown, typed/free param
   accuracy, validity) echoed to stdout and written to `scripts/.bfcl-results/` (gitignored)
   as both a `.txt` table and a `.json` report with full provenance.

## Honest failure

One bad cell never aborts the sweep:
- A model not served → loud-skip note.
- LM Studio unreachable → the runner falls back to the scoring self-test and reports that the
  live run was skipped.
- A chat/completion transport error → logged warning; that entry scores as an empty output
  (a miss), and the sweep continues.
- An unparseable model output → scores as a non-match (validity rate drops), never a crash.
