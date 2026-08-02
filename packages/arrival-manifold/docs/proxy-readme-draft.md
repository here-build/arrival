> Marketing README draft written against the arrival-manifold surface — "@arrival/proxy" is a working title for the product this package IS; no package by that name exists.

# @arrival/proxy

**Smarter, with a context discipline that keeps getting cheaper — and every number below
comes with its control.**

`@arrival/proxy` sits between your agent and your MCP servers. Instead of N tool schemas and
raw JSON floods, your model gets **one tool: a REPL that already speaks all your tools.**

```
                        before                      after
context per session     ~40 tool schemas            1 tool
600-row tool result     600 rows into context       3 rows the model asked for
"A, then B per item"    N round-trips               1 expression
a 400 error             a guessing turn             an instruction
```

```bash
npx @arrival/proxy wrap     # your servers, unchanged — one new front door
```

## Context discipline

In real agentic sessions we measured, **prompt tokens outnumber completion tokens 41:1** —
your bill is mostly the same tool outputs replayed turn after turn, and every replayed byte
is another chance for the model to drift onto something irrelevant. Two mechanisms attack
exactly that:

**Results are compacted structurally, not truncated blindly.** Collections shrink, long
strings clip, and the model is told what was reduced and how to drill in — captured verbatim
from a real run:

```
#| ⚠ output reduced to fit response budget (request too large): showing ≤32 items per
   collection, ≤80 chars per string — filter/map/reduce the collection in your program to
   keep only the items you need, instead of paging them all back |#
```

**The model filters at the source, so the flood never happens.** It doesn't page 600 rows
back into your context to find 3 — it sends the filter TO the data:

```scheme
(define commits (github_list_commits :owner "you" :repo "app" :per_page 100))
(map (lambda (c) (:date (:author (:commit c))))
     (filter (lambda (c) (string-contains (:message (:commit c)) "fix")) commits))
```

One call. Only dates of fix-commits enter your context. And the REPL session persists —
`(define …)` once, refine across turns, never re-fetch.

The catalog that enables all this costs ~2% prompt growth. The compaction pays that back on
the first large result, then keeps paying.

**The honest cost box.** At a matched observation budget, the proxy currently spends
~1.2–1.5× native's median prompt tokens per task — the model takes more steps, because
steps are how it fetches, filters, and verifies, and those steps are where the accuracy
comes from (see the numbers below: the exchange rate is ~3–5× better than what raw
reasoning-token spend buys on agentic tasks). And the premium is falling release over
release: two optimization batches cut total spend **37%** at flat accuracy, mostly by
deleting repeated teaching and retry round-trips. We publish the cost curve with the
accuracy curve; if you find a workload where the trade doesn't pay, that's a bug report
we want.

## Making the model smarter

This is the counterintuitive half, and it's control-backed, not vibes:

**+5 points of task coverage at the SAME observation budget.** On MCP Atlas (89 real
multi-server tasks, frontier model), the scheme surface beats native JSON function calling by
at least +5 points — and when we piped our compaction under native JSON as a control, native
didn't move. The gain isn't prettier truncation. **The gain is the language.**

Why would a language make a model smarter? Fifty years of programming-language training data.
Handing a model N JSON schemas makes those schemas its whole universe; handing it a language
inherits everything the language implies — composition, variables, iteration, the entire
mental model it already has from training. The model was better than its interface all along.

Two more mechanisms compound it:

- **Errors are doors, not walls.** Every rejection names what broke, why, and the exact next
  action — including "stop retrying, this tool is degraded" when a server starts lying, and
  a TypeScript-powered diagnosis under failed calls (wrong arg type, misspelled parameter —
  inferred from your servers' actual schemas). A raw error costs the model a reasoning turn
  to reconstruct what happened; a door deletes that turn.
- **Failure modes get deleted at the source.** We run the benchmark as a fuzzer, autopsy
  every failure, and either fix the environment or teach at the exact point of confusion —
  not in a prompt the model has to remember 30 turns later.

## Install (60 seconds)

You already have MCP servers configured. The proxy relocates them one level down and takes
their place — same servers, same keys, new front door:

```bash
npx @arrival/proxy wrap        # autodetects: Claude Code, Claude Desktop, Cursor, Codex
npx @arrival/proxy unwrap      # restores your config, byte-identical
npx @arrival/proxy doctor      # see EXACTLY what the model will see + its token cost,
                               # and catch broken servers before the model meets them
```

Anything else speaking `mcpServers` JSON:

```bash
npx @arrival/proxy --config ./manifold.json
```

Security gets narrower, not wider: each upstream keeps its own `env` block, and the proxy
passes each child **only its own** variables. No telemetry, nothing phones home.

## What the model sees

One tool whose description is a catalog — every upstream tool a typed function:

```
(github_list_commits :owner string :repo string :per_page number? (max 100)) - List commits
(filesystem_read_text_file :path string) - Read a file as text
(memory_read_graph) -> {entities:list, relations:list} - Read the knowledge graph
```

The model can even ask for a bigger window when it has a reason (`:response-size`, capped),
and the tool description itself warns it that bigger responses cost you money and cost it
attention. We negotiate with the model honestly, and it responds in kind.

## Honest numbers

- **+6–10 points coverage / up to +17.5pp task pass-rate** vs native JSON function calling
  (MCP Atlas, LongCat-2.0, same judge both arms) — and the proxy at HALF native's
  observation budget still wins by +5.5pts. The compaction-under-JSON control ruled out
  prettier-truncation as the cause; the delta is the language surface.
- **The proxy converts observation budget into accuracy; native doesn't.** Proxy climbs
  monotonically as budget grows; native at 5× budget gained +0.004.
- **Cost premium ~1.2–1.5× median prompt tokens at matched budget, falling** — two
  optimization batches cut total spend 37% at flat accuracy. Encoding is not the overhead
  (s-expressions measured at parity ±2–4% with JSON); the envelope adds <9% to response
  bytes; the spend is extra information-gathering steps, which is also where the accuracy
  comes from.
- **Six replicate runs land in a σ≈0.02 band.** We publish the band, not the best run.
- What we do NOT claim: that individual teaching tweaks move benchmark means. We tested —
  they don't. Capability is information-bound; the wins are context discipline plus
  deleting the long tail of failure modes. Methodology + raw defect ledgers in `docs/`.

## Configuration

```jsonc
{
  "mcpServers": { /* your existing entries, verbatim */ },
  "observation": { "maxTotalChars": 40000 },   // response budget (model may request more per call)
  "typeHints": "telemetry"                     // "off" | "telemetry" | "on-error"
}
```

| env var | effect |
|---|---|
| `MANIFOLD_TYPE_HINTS` | override typeHints mode |
| `MANIFOLD_OBS_MAX_CHARS` | override the response budget |

## When NOT to use this

- One or two servers, a handful of simple tools — native calling is fine; the catalog buys little.
- Models below the ~7B function-calling floor — the REPL inherits the floor, it doesn't fix it.
- Single-shot tools with tiny outputs — nothing to compact, nothing to compose.

## FAQ

**The model tried to call `github_list_commits` directly.**
Happens occasionally; the proxy answers with a retry instruction naming the exact wrapper
call. Recovery is near-total — we measure it.

**A server changed its tool list mid-session.**
Handled — `tools/listChanged` rebuilds the catalog live.

**Scheme? My model writes Python.**
Every frontier and mid-tier model we tested writes this fluently — it's the lingua franca of
fifty years of CS text. The parens are load-bearing: they're what makes programs cheap to
validate, compose, and teach against. Your model knows more Lisp than you think.

---

*Built on [Arrival](../arrival/README.md) — a language designed for models to speak. The
proxy is one application: your MCP servers, presented as a language instead of a form.*
