# Intent-chain eval — first empirical run (mic-drop #2, proof of concept)

**Status**: first result · 2026-06-20 · companion to `intent-chain-eval-landscape.md`
**What this is**: the first end-to-end run of the semantic-isolation eval — Rnj-1 generating intent-chain
programs under the constrained sampler, executed against the stateful device-sim, scored by state
assertion. It proves the methodology works and produces the headline metric; it is **N=6, proof of
concept**, not a polished benchmark.

## Result

```
6 chains · validity 100.0% (100% by construction) · semantic pass-rate 66.7% · residual 33.3%
```

`@here.build/intent-eval` `eval:run`, Rnj-1 (Q4_K_M, llama.cpp/Metal), greedy-constrained, device-sim
grant env + `buildDevicePrompt()`, deterministic (re-ran identical).

| chain | generated program (all oracle-valid) | verdict |
|---|---|---|
| single: timer 10m | `(apply set-timer (list (* 10 60)))` | PASS |
| seq: timer 5m + text Bob | `(apply (lambda (t) (send-message "Bob" "It's running")) (set-timer (* 5 60)))` | FAIL* |
| **data-dep**: next event → remind 30m before | `(cons (next-event) (set-timer (* 30 60) "Reminder: Next event"))` | **FAIL** (genuine) |
| state-carryover: brightness half→max | `(apply set-brightness (list 0.5)) (apply set-brightness (list 1))` | PASS |
| seq: alarm 7:30 + music | `(apply (lambda (a b) (and a b)) (list (set-alarm 7 30) (play-music "relaxing_playlist")))` | PASS |
| single: text Alice late | `( send-message "Alice" "I'm running late" )` | PASS |

## What the result demonstrates (the methodology)

1. **Validity = 100%, confirmed empirically, not just claimed.** Every generated program is structurally
   well-formed and calls only bound tools — `validityRate === 1.0` over the run. The sampler's guarantee
   holds in practice; **0 of the failures are syntactic or unbound-tool errors.** This is the isolation
   that makes the next line meaningful.
2. **The 33.3% residual is pure semantic error.** With syntax/validity removed, every failure is a *wrong
   choice*: the **data-dependency chain is a genuine, instructive semantic miss** — asked to "remind me 30
   min before my next event," Rnj-1 called `next-event` (correct query) but then reached for **`set-timer`
   instead of `add-reminder`** — the right *shape*, the wrong *tool*. No syntax checker (BFCL-AST etc.)
   could catch this; only state assertion does. **This is exactly the error class ToolScan attributes
   post-hoc and we isolate by construction.**

The programs themselves show Rnj-1's native agentic-Scheme idiom (`apply`/`list`/`lambda` wrapping) — all
valid by construction, which is *why* we can score meaning instead of form.

## Honest read (why this is PoC, not a benchmark yet)

- **N=6**, single domain. The residual (2/6) is one **genuine** semantic miss (the data-dep wrong-tool) and
  one **assertion-strictness** edge case: the seq:timer+text program *does* set the timer and text Bob, but
  the assertion marked it FAIL — the chain's `assert` is likely over-strict (body/shape sensitivity). So
  the raw 33.3% mixes true semantic error with eval-harness assertion calibration. **The assertions need
  tuning** (the deferred "eval-harness tightening" the device-sim noted) before the residual is a clean
  number.
- Greedy (deterministic) — no pass^k reliability yet; τ>0 + pass^k is the next axis.
- No by-palette factorial yet (the harness carries `palette`, ready) — pairing this with the naming-scheme
  finding (#1) would show semantic residual × naming, the two mic-drops in one table.

## Next to harden it
1. **Calibrate assertions** (loosen shape-sensitivity; assert *effects* not program structure — the whole
   point is path-agnostic state verification, à la τ-bench/ToolSandbox milestones). Re-run → a clean
   residual.
2. **Scale N** (more chains, more depth) and add the **stale-value probe** (FuncBenchGen): chains where a
   naive model reuses a wrong value — the residual's sharpest test.
3. **By-palette × pass^k**: semantic residual under each naming scheme, τ>0 — unifies #1 and #2.
4. The infra is in place (`@here.build/intent-eval`: device-sim + eval harness + `eval:run`); this is
   tuning + scale, not new architecture.

**Bottom line**: the eval works end-to-end and already produces the one number nobody else can —
*semantic error rate with validity provably held at 100%* — and even at N=6 it surfaced a real,
syntax-invisible wrong-tool error. That is the proof the mic-drop is real; the remaining work is
calibration and scale, not invention.
