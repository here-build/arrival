# arrival-sampler OpenAI-compatible server

An OpenAI-compatible HTTP server that wraps the **constrained Scheme-tool-call sampler**
(`@inhuman.tools/arrival-sampler`). Any harness that speaks the OpenAI Chat Completions wire —
BFCL's OpenAI handler first, production clients later — can drive the constrained decoder by
pointing its `base_url` at this server's `/v1`.

Internally the decode is **constrained Scheme over a grant Σ** (the oracle masks the model so it
can only emit a parse-valid, bound-symbol call). The server's job is to translate the OpenAI edges:
OpenAI tools → grant Σ + rendered prompt on the way in, decoded Scheme → OpenAI `tool_calls` (or
text) on the way out.

> **Node-only.** The real decode loads a GGUF via `node-llama-cpp` (native addon). The translation
> pipeline + HTTP shell are pure and model-free (the test suite injects a canned decode).

**Boundaries (three primitives):**
- The *pure kernel* (structural + Σ gates, `selectConstrainedStep`, `isCandidateLive`, contracts) lives in the main export and is substrate-free.
- This directory + `../decode/llama-cpp-generate.ts` + `../decode/server-generate.ts` + ModelManager implement the **minimal** primitive 2 (on-demand GGUF + OpenAI surface). Default path is constrained greedy.
- The wiring supports multiple strategic search policies (greedy baseline + rollback, lookahead, branch) and
  model-family-specific mechanisms (fc-envelope) as part of the formal substrate.
- BFCL (primitive 3) drives this server via `OPENAI_BASE_URL`; orchestration stays in the harness (scripts/bfcl_*).

---

## Running it

The server resolves `@inhuman.tools/arrival` and `@inhuman.tools/arrival-sampler` through the **parent
sampler's `node_modules`** — no separate install. Build the sampler's server bundle once (the real
decode dynamically imports `@inhuman.tools/arrival-sampler/server`):

```bash
# from foundations/arrival/arrival-sampler
npm run build:server        # produces dist-server/ (the node-only decode entry)

# build + start this server (from scripts/openai-server)
../../node_modules/.bin/tsc                 # → dist/
node dist/cli.js --port 1234 --model Arch-Agent-1.5B
```

CLI flags:

| flag | meaning | default | env |
|------|---------|---------|-----|
| `--port` / `-p` | listen port | `1234` | — |
| `--model` / `-m` | default model id (or absolute `.gguf` path) when a request omits `model` | none | — |
| `--host` / `-h` | bind address | `127.0.0.1` | — |
| `--idle-timeout` | seconds of no requests for a model before its handle is offloaded (`0` disables) | `300` | `OPENAI_SERVER_IDLE_TIMEOUT_SEC` |
| `--max-resident` | max models held in memory at once (LRU-evict at capacity) | `1` | `OPENAI_SERVER_MAX_RESIDENT` |

Then point a harness at:

```
base_url = http://localhost:1234/v1     # i.e. OPENAI_BASE_URL=http://localhost:1234/v1
```

A request's `model` field selects the GGUF (resolved against `models/roster/`, by roster id, basename,
or explicit path — see `model-resolve.ts`).

> **The model binaries are not in the repo.** `GET /v1/models` lists the roster ids regardless; a
> `chat/completions` call against an id whose `.gguf` isn't downloaded yields a 500 naming the missing file.

### Drop-in LM-Studio-like model serving (ModelManager)

The server holds models like LM Studio: **JIT-load on demand, reuse across requests, idle-offload, LRU-evict
at capacity** — so a harness can point at one endpoint and request any served model id, and we load/free GGUFs
as needed under constraint.

- **JIT load.** First request for model `X` → resolve `X` → gguf (`model-resolve.ts`), `LlamaModelHandle.load(path)`, cache.
- **Reuse.** Repeat requests for a resident model reuse the handle (no reload) and reset its idle timer.
- **Idle offload.** After `--idle-timeout` seconds of no requests for a model, its handle is disposed (frees Metal/RAM). `0` keeps it resident forever.
- **Capacity / LRU.** `--max-resident` caps how many are held at once (default 1 — Metal realistically holds one). A new model at capacity evicts the least-recently-used **idle** model (disposing it **before** the new load — two handles never coexist).
- **Concurrency-safe.** Concurrent requests for the same model share one load (never double-load); a model that's mid-decode (lease held) is never offloaded or evicted; load/evict are serialized so a dispose can't race a decode.

`GET /v1/models` annotates each card with a non-standard `resident: boolean` (which gguf is loaded right now).

The mechanism is `ModelManager` (`model-manager.ts`), wired into `real-decode.ts`. It is generic over the
handle: it takes an injected `load(id)`/`dispose(handle)` — which is exactly what makes it model-free testable
(a counting fake loader replaces the GPU; a virtual scheduler drives the idle timer).

API sketch:

```ts
const mgr = new ModelManager({ load, dispose, idleTimeoutMs, maxResident, scheduler });
const lease = await mgr.acquire(modelId);   // JIT-load or reuse; evicts LRU at capacity
try { /* decode using lease.handle */ } finally { lease.release(); }  // or: await using lease = ...
mgr.residentIds();                          // ids currently loaded (for /v1/models)
await mgr.dispose();                         // free everything on shutdown
```

---

## Endpoints

### `POST /v1/chat/completions`

The one that matters. Standard OpenAI request + **one non-standard field**: `contract`.

### `GET /v1/models`

Lists the roster ids (present `.gguf` basenames ∪ known roster ids) in OpenAI list shape.

---

## The `contract` selector (FC vs prompt)

`contract` is a non-standard body field — OpenAI clients ignore unknown fields, and the custom BFCL
handler sets it. The **internal decode is constrained Scheme in both cases**; only the edges differ.

```jsonc
{ "model": "...", "messages": [...], "tools": [...], "contract": "fc" | "prompt" }
```

| | **`"fc"`** (default) | **`"prompt"`** |
|---|---|---|
| tools arrive in | `tools` array | `tools` array (still, for the grant Σ) |
| prompt surface | **verbose** full JSON schema | **compact** terse signatures (context win for small-ctx models) |
| response carries the call as | OpenAI `tool_calls` | **text** in `message.content` |
| `finish_reason` | `"tool_calls"` | `"stop"` |

### FC contract — request → response

Request:

```json
{
  "model": "Arch-Agent-1.5B",
  "messages": [{ "role": "user", "content": "What's the weather in Paris in celsius?" }],
  "tools": [{
    "type": "function",
    "function": {
      "name": "get_weather",
      "description": "Get the current weather for a location.",
      "parameters": {
        "type": "object",
        "properties": {
          "location": { "type": "string" },
          "unit": { "type": "string", "enum": ["celsius", "fahrenheit"] }
        },
        "required": ["location"]
      }
    }
  }],
  "contract": "fc"
}
```

Decoded Scheme (internal): `(get_weather "Paris" celsius)`

Response:

```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "created": 1700000000,
  "model": "Arch-Agent-1.5B",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": null,
      "tool_calls": [{
        "id": "call_0",
        "type": "function",
        "function": {
          "name": "get_weather",
          "arguments": "{\"location\":\"Paris\",\"unit\":\"celsius\"}"
        }
      }]
    },
    "finish_reason": "tool_calls",
    "logprobs": null
  }],
  "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 }
}
```

Note `arguments` is a **JSON string** (OpenAI's quirk), and the **positional** Scheme args are mapped to
**named** arguments using the tool's `parameters.properties` declaration order, each JSON-typed against its
schema (a bare number stays a JSON number, `#t` a boolean, `(list a b)` an array, an enum symbol its string).

### prompt contract — request → response

Same request with `"contract": "prompt"`. Response:

```json
{
  "object": "chat.completion",
  "model": "Arch-Agent-1.5B",
  "choices": [{
    "index": 0,
    "message": { "role": "assistant", "content": "(get_weather \"Paris\" celsius)" },
    "finish_reason": "stop",
    "logprobs": null
  }],
  "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 }
}
```

The call is returned **as text** (the Scheme/python call string), no `tool_calls`.

### Multi-call

A multi-call decode `(f …) (g …)` (or `(begin (f …) (g …))`) becomes **multiple** `tool_calls` in FC, or
the multi-call text in prompt. The parallel/parallel-multiple shape is handled.

### Prose / no-call seam

When no tools are offered, or the decode yields no parseable call, the response is a plain assistant **text**
message (`finish_reason: "stop"`, no `tool_calls`). This is the seam for future abstain/irrelevance and
agentic final-answers — see "Seams" below.

---

## Constraint mode

**Grammar mode (Σ + grammar) only.** The portable, stable path: the grant Σ is built from the tool names +
list-constructors + enum value-symbols, and the oracle masks decode to it. **Typed mode (Σ∩T) is deferred** —
it needs TS types derived from the tool JSON schema and the type layer is mid-rework. The extension point is
the `asyncTypeLens` argument in `real-decode.ts` (a clearly-marked `TODO(typed)`).

---

## What's tested vs deferred

Tested (model-free, no GPU — `npm test` / `vitest run`):

- **tools (OpenAI JSON) → grant Σ** — the right bound names/arity, enum value-symbols, list-constructors.
- **scheme → FC `tool_calls`** — positional→named via schema order, JSON-typed values, the subtle part.
- **prompt-contract rendering** — compact surface is terse (no per-param docs); response is text not tool_calls.
- **multi-call** — `(f …) (g …)` → multiple tool_calls; `(begin …)` unwrap.
- **prose seam** — no tools / unparseable decode → text message.
- **HTTP shell** — both endpoints over a real loopback socket (canned decode).
- **model resolution** — id/basename/path resolution against a temp roster dir.
- **ModelManager** (model-free, fake counting loader + virtual scheduler) — JIT-loads on first request,
  reuses on repeat (load count stays 1, same handle), idle-offloads after the timeout, LRU-evicts at
  capacity, never double-loads under concurrent same-model acquires, applies capacity back-pressure when all
  resident models are in use, removes a failed load (and retries), and disposes everything on shutdown.
- **build (`tsc`) + the sampler suite** stay green.

**Deferred (the live model run):** loading a real GGUF and decoding on the GPU. A benchmark is using
LM Studio/Metal, so `real-decode.ts` (the only file that touches `node-llama-cpp`) is never exercised by
tests — wire it when the GPU is free by starting the CLI against a downloaded model. The ModelManager's
real loader/disposer (resolve id → gguf, `loadLlamaModel`, free the llama context) is the GPU-touching part;
its lifecycle logic is fully tested with a fake loader.

---

## Seams left open

- **Typed mode (Σ∩T):** `real-decode.ts` `TODO(typed)` — build an `asyncTypeLens` from the tool schemas.
- **Abstain / agentic final-answer:** `handler.ts` prose path is a minimal stub; a richer abstain needs an
  unconstrained decode branch (the architecture does not assume every response is a call).
- **Usage metering:** `usage` is zeroed (the server-generate entry doesn't surface token counts yet).
- **Value-symbol de-sanitisation:** multi-word enums are emitted as quoted strings (round-trip exact); a
  symbol↔value map (the typed lens already tracks it) would let multi-word enums round-trip as bare symbols.

---

## File layout

```
scripts/openai-server/
  src/
    openai-types.ts      OpenAI wire shapes + the `contract` extension
    tool-env.ts          OpenAI tools → grant Σ (Environment) — generalized bfclToGrantEnv
    scheme-parse.ts      string-aware reader: scheme program → positional ParsedCall[]
    scheme-translate.ts  ParsedCall → OpenAI tool_calls (positional→named + JSON typing) — the subtle part
    prompt-render.ts     verbose (fc) vs compact (prompt) tool surfaces
    handler.ts           request→response core; DECODE INJECTED (the test seam)
    model-manager.ts     resident-model lifecycle: JIT load / reuse / idle offload / LRU evict (concurrency-safe)
    real-decode.ts       production DecodeFn wrapping generateWithExplain + ModelManager (node/GPU; not run in tests)
    model-resolve.ts     model id → gguf path (filesystem-driven); /v1/models listing
    server.ts            node http shell exposing the two endpoints
    cli.ts               `node dist/cli.js --port … --model …`
    index.ts             testable barrel (everything except real-decode + cli)
    __tests__/           model-free unit + HTTP integration tests
```
