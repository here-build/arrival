# Sampler decode architecture — kernel · strategy · backend

**Status:** design approved (V, 2026-06-21). Phase 1 in flight. This is the canonical
decomposition for the constrained-decode loop; it supersedes the "tiers baked into one
loop" shape that `unified-lookahead-branching-decoder.md` describes (those tiers become
*strategies* here — see "How it reframes existing code").

## Thesis

The sampler is three things that were tangled into one decode loop:

- **The constraint** is a pure predicate: `feasible(generated, token) => boolean`.
- **Decoding** is a *strategy* over that predicate (greedy, rollback, beam, sample, …).
- **The model+sequence** is a *substrate* the strategy drives.

The oracle is a predicate; decoding is a policy over it; the model is a device. Keeping
these separate is what makes the sampler autonomous, testable, and open to better search
than greedy.

## The three interfaces

Dependency direction is one-way: `kernel ← strategy → backend`. The kernel knows nothing
of strategies or models; a strategy composes the kernel and drives a backend; a backend
knows nothing of the constraint.

```
KERNEL (pure — no model, no async, no state, no I/O)
  makeFeasible(scanner, profile?) => (generated: string, token: string) => boolean
  closeable(scanner, generated: string) => boolean        // == feasible(generated, EOS)

BACKEND (substrate — the model+sequence as data)
  stepDistribution() => orderedTokenIds                   // ranked tokens at the cursor, best-first
  detokenize(id) / commit(ids) / position()
  rewind(start, end)                                      // KV-erase; the primitive rollback needs
  eosIds

STRATEGY (owns the decode loop; composes feasible + drives the backend)
  decode(ctx) => { program, telemetry }
    • greedy       — per-step first-feasible (+ force-emit + widen/structural-fallback)   [parity]
    • passthrough  — argmax, no feasible filter                                           [pluggability proof]
    • rollback     — DFS + backtrack on a bad commit                                      [the real problem]
    • beam / sample / lookahead                                                           [later peers]
```

`feasible(generated, token)` already exists as `isCandidateLive(scanner, prefix, str,
profile, slotState)` in `mask-compiler.ts` — the kernel is a closing-over wrapper
(scanner+profile closed, `slotState` derived from `generated` via `scanner.analyze`),
not new logic.

## Why this split

- **Purity ⇒ one-line tests.** Every gate test is `feasible(prefix, token) === expected` —
  model-free, sync, no strategy in the loop. The discipline that catches live bugs:
  put the structurally-wrong token in as the model's *top* pick and assert the veto
  (`feasible("(fn :distance 12000", ":distance") === false`). The two bugs this session
  (the structure-gate dead on GGUF; positional-keyed `:distance`-looping) both passed a
  green unit suite while the live decode was broken — because the suite tested gate logic
  in isolation, never drove the real decision under model pressure. Kernel tests close
  that gap by construction.
- **Pluggability ⇒ better-than-greedy search.** Greedy commits the highest-logit *feasible*
  token irrevocably; it's myopic (a locally-feasible token can force the model off its
  preferred, valid path). Rollback/beam search for the max-probability *valid* program.
  The predicate is what makes them cheap to express — they all just compose `feasible`.
- **The recognitions that fell out:**
  - **force-emit is `forcedNext(generated)`** — the unique token where `feasible(generated, ·)`
    holds. It's a greedy *optimization* (skip the model when the answer is forced),
    predicate-derived — not a model-coupled special path. (Reaching for the model from a
    place that only needed the oracle is exactly how it bit us in positional-keyed.)
  - **widen-K + structural-fallback are greedy's policy** for "no feasible token in the
    model's window" — not kernel facts. Rollback answers the same situation by backtracking
    instead of forcing a closer.
  - **the branch tier is rollback** — already present, just welded into the loop.

This is intent-over-materialization at the sampler layer: the kernel is the *constraint
intent*; strategies are *decode-policy materialization*.

## Design decisions

1. **The strategy owns the loop**, not a per-step pick. Greedy's `decode` is a per-step
   loop; rollback's is a DFS that rewinds. A per-step-pick signature can't express
   backtracking, so iteration belongs to the strategy. The runner only selects one and
   calls `decode`.
2. **Backend = the autoregressive (llama) shape.** It owns its loop and can `rewind`. The
   transformers mask-processor is a different integration — the *framework* owns the loop,
   the processor only masks — so it can't host rollback. It stays a fixed greedy/sample-
   via-mask path *outside* the strategy seam rather than being contorted to fit. (One
   honest leaky abstraction avoided.)
3. **Gradual migration, parity-bounded.** The runner routes `greedy|passthrough` through
   the new seam and everything else (branch/proxy/lookahead) to today's inline blocks
   until each is recast. Parity risk stays contained to greedy.

## Phase plan

- **Phase 1 — kernel.** `feasible.ts` (`makeFeasible`, `closeable`) + adversarial kernel
  tests (the wrong token as top-1 → veto). No behavior change. *In flight.*
- **Phase 2 — seam.** Wrap the llama binding as `Backend`; define `Strategy`; lift today's
  greedy walker (the `selectConstrainedStep` path + force-emit) into `GreedyStrategy` at
  **byte-parity**; add `PassthroughStrategy`; route the runner. force-emit folds into
  greedy as `forcedNext`.
- **Phase 3 — rollback.** The first real strategy. Generalizes the branch tier (which
  already rewinds the KV via `eraseContextTokenRanges`) into proper backtracking on a bad
  greedy commit. This is the problem the split exists to let us solve.

## How it reframes existing code

| Today (inline in `llama-cpp-generate.ts`)                | Under this architecture        |
|----------------------------------------------------------|--------------------------------|
| `isCandidateLive(...)`                                    | the **kernel** (`feasible`)    |
| `selectConstrainedStep` greedy walk + widen + fallback   | **GreedyStrategy**             |
| `tryForceEmitSingleton`                                   | greedy's `forcedNext` optimization |
| `decodeStrategy: "branch"` + `decodeArm` + KV-erase       | **RollbackStrategy** (Phase 3) |
| `decodeStrategy: "lookahead"`, the proxy tier             | later strategy peers           |
| `model` / `controlledEvaluate` / `eraseContextTokenRanges`| the **Backend**                |

The loop-unification (`select-constrained-step.ts`) already extracted the pure per-step
decision as a side effect of de-duplication — so the greedy core is *already* a pure,
sync, referentially-transparent function. This architecture names what that revealed and
opens the seam the rest of the strategies plug into.
