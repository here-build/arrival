# Why arrival omits IO and effects — Scheme as a dataflow algebra

The *why* under the purity invariant's IO clause.

## It is a subset of a real standard, not a bespoke pure language

arrival is a real R7RS Scheme interpreter that faithfully follows the **IO-less and
metaprogramming-less subset** of the standard. The omitted families (IO/effects, mutation, the
dynamic/reflective metaprogramming surface) are a **subset choice**, not a redefinition:
everything arrival runs means exactly what R7RS says, portable to any conforming Scheme. Adding
the IO + metaprogramming environment back would make arrival a full-fledged R7RS Scheme — nothing
in the design forecloses that. We leave that door closed by choice, not inability, because the
absence is what buys the guarantees below.

Choosing a *pure subset of a standardized language* — rather than inventing a bespoke pure DSL — is
the whole move, and it pays out three ways independent of the rewrite payoff:

- **Portability is structural, not aspirational.** Programs in the pure subset mean the same thing
  under any conforming implementation; behavior is pinned by a published standard and its
  conformance suite (we run chibi's official `r7rs-tests.scm`), not by our taste. A spec-derived
  boundary self-corrects in cases we never saw; a hand-rolled DSL drifts.
- **The language is battle-hardened.** R7RS-small is decades of design — evaluation model, numeric
  tower, hygiene, tail calls — already argued out and stress-tested. We inherit that instead of
  re-deriving (and re-bugging) it.
- **The ecosystem is reachable.** Pure-subset Scheme libraries and idioms work as-is; there is no
  DSL manual because the manual is the Scheme report.

## The payoff: arrival-chain ports to any R7RS by defining ~10 symbols

Because arrival stayed inside the standard, portability is a *property*, not something architected.
**arrival-chain (the pipeline layer built on arrival) reimplements from scratch on *any* conforming
R7RS by defining roughly ten symbols.** The pipeline library calls nothing but pure R7RS plus a
small **host seam** — the operations where a value enters or leaves the dataflow (the membrane
primitives: box / unbox / cross-the-edge / invoke-host). Everything else is ordinary pure Scheme the
target already provides. No portability layer, no per-Scheme backends: one library whose only
non-portable surface is ~10 function calls.

The trade is graceful. On vanilla R7RS those ten symbols are *plain* — identity boxing, values
without lineage — so you get a working arrival-chain minus the cool features (no provenance, no
trace-rewrite algebra, no membrane identity guarantees). On arrival proper, the same ten symbols are
the provenance-preserving membrane and the full capability lights up. Same pipeline code, two
substrates, distinguished only by what those ~10 definitions do.

## Referential transparency is what makes a pipeline a rewritable value

That faithful pure substrate makes a pipeline a *value you can rewrite*. A pure expression obeys
**referential transparency**: an expression may be replaced by its value (and vice versa) anywhere
it appears, and the program means the same thing. Every transformation we want on a pipeline is a
*licensed substitution*, licensed **only** because nothing in the language can observe or depend on
*when* or *how many times* an expression ran.

Each thing referential transparency licenses is a pipeline operation the platform actually needs:

| Rewrite | What it does | Why purity licenses it |
|---|---|---|
| **Reorder** | run independent stages in any order | no effect ordering to preserve — `a` before `b` ≡ `b` before `a` when neither observes the other |
| **Fuse** | collapse `map f ∘ map g` → `map (f ∘ g)` | no intermediate materialization is observable, so the intermediate need not exist |
| **Dedup / CSE** | compute a shared subexpression once | two occurrences of the same expression *are* the same value (the substitution, run backwards) |
| **Parallelize** | evaluate a fan-out concurrently | independence is structural, not a race — there is no shared mutable cell to contend for |
| **Cache / memoize** | reuse a prior result for the same inputs | the value is a pure function of its inputs; "same inputs" ⇒ "same value", always |
| **Replay** | re-run a pipeline and get an identical trace | nothing read the clock, the network, a file, or a mutable global; the run is reproducible |
| **Cull** | drop an unused stage | an unobserved pure expression has no effect to lose (dead-code elimination is sound) |

Every row is the *same theorem* at a different scale. That is the isomorphism: **pipeline
optimization = algebraic rewriting of a pure expression graph.** The graph is an algebra; the
rewrites are its laws.

## What IO would cost — concretely

Add one `(display x)`, one `(read)`, one `(get-environment-variable …)`, one mutable cell, and
every row above turns from *theorem* into *maybe*:

- **Reorder dies.** `(display "a")` then `(display "b")` is not the same program as the reverse. Once
  an effect is observable, evaluation order becomes part of the meaning and the scheduler is no
  longer free.
- **Fuse dies.** If the intermediate list was printed, it must be materialized — the fusion changes
  observable behavior.
- **Dedup dies.** Two `(read)` calls are *not* the same value; collapsing them changes what the
  program consumes.
- **Cache dies.** `(current-time)` returns a different value each call by design; memoizing it is
  wrong. Caching requires "value is a function of inputs," which an effect breaks at the root.
- **Replay dies.** A run that touched the network can't be reproduced from the graph alone — the
  environment is an implicit, invisible input.
- **Cull dies.** You can't drop `(delete-file f)` because its result is unused; the *effect* was the
  point.

One effect anywhere poisons the rewrites **everywhere downstream of it**, because the optimizer can
no longer prove independence. Purity is not a local property you can sprinkle — it is a global
invariant you either hold or don't. That is why IO is removed *out of the box*, not gated behind a
flag: a single escape hatch would forfeit the algebra for the whole graph.

## The provenance connection (same invariant, second face)

The purity invariant's *stated* reason is provenance soundness: every value carries the lineage of
where it was constructed, and lineage is sound only if values are immutable and evaluation is pure.
The dataflow-algebra reason is the *same invariant seen from the other side*:

- **Provenance** is the claim "this value came from exactly these inputs, here."
- **Referential transparency** is the claim "this value may be substituted for its defining
  expression, anywhere."

These are the same fact. A value whose identity is a pure function of its construction site
(provenance) is exactly a value you may freely substitute (transparency). So the two omitted families
fall out of one principle:

- **Writing methods** (set-car!/vector-set!/…) — break provenance (a value changes after its lineage
  was fixed) ⇒ break substitution (the "same" value isn't).
- **Dynamics + IO** (call/cc, parameterize, delay, read, write, ports, env) — break substitution
  (identity depends on control-flow extent / external state) ⇒ break provenance (no single
  construction site to root lineage at).

The trace engine that reads provenance and the optimizer that rewrites the pipeline read the **same
graph** under the same guarantee. Provenance makes the trace *trustworthy*; transparency makes the
graph *rewritable*. One invariant, two payoffs.

## Where the effects actually go

Abandoning effects *inside* the language does not mean the system does nothing. Effects live at the
**edges**, never in the dataflow:

- **Inputs** enter as already-constructed values at the boundary (a rosetta/FFI call's result is a
  value with provenance rooted at that call). The pipeline never *performs* the read; it *receives*
  the value.
- **Outputs** are the values the graph produces; the host decides what to do with them (persist,
  display, send). The graph computes *what*, the edge performs *whether/when*.

This is the functional-core / imperative-shell split, and it is why the capability surface (MCP)
"wraps intent, not impact": agents name the value they want, the host owns the effect of
materializing it. The pure core is not a limitation — it is the thing that lets the middle be a
reorderable, cacheable, replayable, fusable graph, with the order-dependent world quarantined to a
thin boundary the optimizer never reasons through.

## The test

Two questions decide whether a primitive belongs in arrival, in order:

1. **Is it R7RS?** We add the standard's primitive with the standard's semantics, not a bespoke one.
   Fidelity first — that is what keeps us a portable Scheme subset rather than a DSL.
2. **Does it preserve the right to substitute an expression for its value?** If yes, it is in the
   pure subset — dataflow. If it observes time, order, mutation, external state, or non-local
   control, it is an effect or a reflective/dynamic feature, and it sits *outside the subset*: at the
   edge, behind a door, not in the graph.

The cut is never product taste. It is the published standard (question 1) filtered by the
substitution property (question 2).
