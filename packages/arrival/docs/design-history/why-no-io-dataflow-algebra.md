# Why arrival omits IO and effects — Scheme as a dataflow algebra

**Date:** 2026-06-11 · **Status:** foundational rationale · **Driver:** V + Claude
**Companion:** the purity invariant (memory `project-arrival-scheme-purity-invariant`,
`docs/plan-2026-06-11-purity-pass.md`). This doc is the *why* under that invariant's IO clause.

---

## The one sentence

arrival **is a real R7RS Scheme interpreter** — it faithfully follows the
**IO-less and metaprogramming-less subset** of the standard. It is not an ad-hoc
DSL that borrows Lisp syntax. Choosing a *pure subset of a standardized,
battle-hardened language* is the whole move: it gives structural guarantees of
portability, inherits decades of language design instead of inventing one, and lets
real Scheme code (and the ecosystem) that stays inside the subset run unchanged —
**and** that same purity is what makes a pipeline a value you can rewrite.

## It is a subset, not a different language

This matters, so state it plainly: the omitted families (IO/effects, mutation, the
dynamic/reflective metaprogramming surface) are a **subset choice**, not a
redefinition. Everything arrival *does* run is exactly what R7RS says it should run —
same semantics, same results, portable to any conforming Scheme. If we ever added the
IO + metaprogramming environment back, arrival would be a **full-fledged R7RS Scheme**
— nothing in the design forecloses that. We can; **we just don't need it**, and the
absence is what buys the guarantees below. The discipline is "stay within the pure
subset of a real standard," never "invent a bespoke pure language."

Why the fidelity is load-bearing (independent of the rewrite payoff):

- **Portability is structural, not aspirational.** Programs in the pure subset mean
  the same thing under any conforming implementation. arrival's behavior is pinned by
  a published standard and its conformance suite (we run chibi's official
  `r7rs-tests.scm`), not by our taste. A spec-derived boundary self-corrects in cases
  we never saw; a hand-rolled DSL drifts.
- **The language is battle-hardened.** R7RS small is the distillate of decades of
  design — evaluation model, numeric tower, hygiene, tail calls — already argued out
  and stress-tested. We inherit that instead of re-deriving (and re-bugging) it.
- **The ecosystem is reachable.** Pure-subset Scheme libraries and idioms work as-is;
  authors already know the language. There is no DSL manual, because the manual is
  the Scheme report.

## The payoff: arrival-chain ports to any R7RS by defining ~10 symbols

This is where the fidelity pays out, and it is a capability we get for free rather
than design. **arrival-chain (the inhuman interpreter / pipeline layer) can be
reimplemented from scratch on *any* conforming R7RS Scheme by defining roughly ten
symbols.** The pipeline library calls nothing but pure R7RS plus a small **host
seam** — the handful of operations where a value enters or leaves the dataflow (the
membrane primitives: box / unbox / cross-the-edge / invoke-host). Everything else is
ordinary pure Scheme the target already provides.

So portability is **not something we architect** — it is a property of having stayed
inside the standard. We do not write a portability layer, abstract over runtimes, or
maintain per-Scheme backends. We write **one library whose only non-portable surface
is ~10 function calls**, and on any other Scheme you supply those ten definitions and
the pipeline runs.

The trade is clean and graceful: on a vanilla R7RS those ten symbols are *plain*
implementations — identity boxing, values without lineage — so you get a **working
arrival-chain minus the cool features** (no provenance, no trace-rewrite algebra, no
membrane identity guarantees). On arrival proper, the same ten symbols are the
provenance-preserving membrane, and the full capability lights up. Same pipeline
code, two substrates, distinguished only by what those ~10 definitions do. The
standard does the portability; we only design the seam.

## The rewrite payoff — what the pure subset buys

Given that faithful pure substrate, purity also makes a pipeline a *value you can
rewrite*. IO and effects are absent precisely because their absence is what buys the
right to reorder, fuse, deduplicate, parallelize, cache, and replay a pipeline
arbitrarily — without ever asking "but what did it *do* along the way."

## The substitution that defines everything

A pure expression obeys **referential transparency**: an expression may be replaced
by its value (and vice versa) anywhere it appears, and the program means the same
thing. That is the whole game. Every transformation we want on a pipeline is a
*licensed substitution*, and every one of them is licensed **only** because nothing
in the language can observe or depend on *when* or *how many times* an expression ran.

Enumerate what referential transparency licenses, and notice each is a pipeline
operation the platform actually needs:

| Rewrite | What it does | Why purity licenses it |
|---|---|---|
| **Reorder** | run independent stages in any order | no effect ordering to preserve — `a` before `b` ≡ `b` before `a` when neither observes the other |
| **Fuse** | collapse `map f ∘ map g` → `map (f ∘ g)` | no intermediate materialization is observable, so the intermediate need not exist |
| **Dedup / CSE** | compute a shared subexpression once | two occurrences of the same expression *are* the same value (the substitution, run backwards) |
| **Parallelize** | evaluate a fan-out concurrently | independence is structural, not a race — there is no shared mutable cell to contend for |
| **Cache / memoize** | reuse a prior result for the same inputs | the value is a pure function of its inputs; "same inputs" ⇒ "same value", always |
| **Replay** | re-run a pipeline and get an identical trace | nothing read the clock, the network, a file, or a mutable global; the run is reproducible |
| **Cull** | drop an unused stage | an unobserved pure expression has no effect to lose (dead-code elimination is sound) |

Every row is the *same theorem* applied at a different scale. That is the
isomorphism: **pipeline optimization = algebraic rewriting of a pure expression
graph.** The graph is an algebra; the rewrites are its laws.

## What IO would cost — concretely

Add one `(display x)`, one `(read)`, one `(get-environment-variable …)`, one
mutable cell, and every row above turns from *theorem* into *maybe*:

- **Reorder dies.** `(display "a")` then `(display "b")` is not the same program as
  the reverse. The moment an effect is observable, evaluation order becomes part of
  the meaning, and the scheduler is no longer free.
- **Fuse dies.** If the intermediate list was printed, it must be materialized — the
  fusion changes observable behavior.
- **Dedup dies.** Two `(read)` calls are *not* the same value; collapsing them
  changes what the program consumes. The backwards-substitution is illegal.
- **Cache dies.** `(current-time)` returns a different value each call by design;
  memoizing it is wrong. Caching requires "value is a function of inputs," which an
  effect breaks at the root.
- **Replay dies.** A run that touched the network can't be reproduced from the graph
  alone — the environment is an implicit, invisible input.
- **Cull dies.** You can't drop `(delete-file f)` just because its result is unused;
  the *effect* was the point.

One effect anywhere poisons the rewrites **everywhere downstream of it**, because the
optimizer can no longer prove independence. Purity is not a local property you can
sprinkle — it is a global invariant you either hold or don't. That is why IO is
removed *out of the box*, not gated behind a flag: a single escape hatch would
forfeit the algebra for the whole graph.

## The provenance connection (same invariant, second face)

The purity invariant's *stated* reason is provenance soundness: every value carries
the lineage of where it was constructed, and lineage is sound only if values are
immutable and evaluation is pure. The dataflow-algebra reason is the *same invariant
seen from the other side*:

- **Provenance** is the claim "this value came from exactly these inputs, here."
- **Referential transparency** is the claim "this value may be substituted for its
  defining expression, anywhere."

These are the same fact. A value whose identity is a pure function of its
construction site (provenance) is exactly a value you may freely substitute
(transparency). Mutation falsifies the first by changing a value after construction;
an effect falsifies the second by making the value depend on *when* it was read. So
the two omitted families fall out of one principle:

- **Writing methods** (set-car!/vector-set!/…) — break provenance (a value changes
  after its lineage was fixed) ⇒ break substitution (the "same" value isn't).
- **Dynamics + IO** (call/cc, parameterize, delay, read, write, ports, env) — break
  substitution (identity depends on control-flow extent / external state) ⇒ break
  provenance (no single construction site to root lineage at).

The trace engine that reads provenance and the optimizer that rewrites the pipeline
are reading the **same graph** under the same guarantee. Provenance is what makes the
trace *trustworthy*; transparency is what makes the graph *rewritable*. One invariant,
two payoffs.

## Where the effects actually go

Abandoning effects *inside* the language does not mean the system does nothing. It
means effects live at the **edges**, never in the dataflow:

- **Inputs** enter as already-constructed values at the boundary (a rosetta/FFI call's
  result is a value with provenance rooted at that call). The pipeline never *performs*
  the read; it *receives* the value.
- **Outputs** are the values the graph produces; the host decides what to do with them
  (persist, display, send). The graph computes *what*, the edge performs *whether/when*.
- This is the standard functional-core / imperative-shell split, and it is why the
  capability surface (MCP) "wraps intent, not impact": agents name the value they want,
  the host owns the effect of materializing it.

So the pure core is not a limitation we tolerate — it is the thing that lets the
middle be **a reorderable, cacheable, replayable, fusable graph**, with the messy,
order-dependent world quarantined to a thin boundary the optimizer never has to
reason through.

## The test, restated

Two questions decide whether a primitive belongs in arrival, in order:

1. **Is it R7RS?** We add the standard's primitive with the standard's semantics, not
   a bespoke one. Fidelity first — that is what keeps us a portable Scheme subset
   rather than a DSL.
2. **Does it preserve the right to substitute an expression for its value?** If yes,
   it is in the pure subset — dataflow. If no — if it observes time, order, mutation,
   external state, or non-local control — it is an effect or a reflective/dynamic
   metaprogramming feature, and it sits *outside the chosen subset*: at the edge,
   behind a door, not in the graph.

So the cut is never product taste. It is the published standard (question 1) filtered
by the substitution property (question 2). The rewrite algebra is what that pure
subset buys; the standard is what keeps it a real, portable, ecosystem-compatible
language while it does. Adding the excluded R7RS features back would yield a
full-fledged R7RS Scheme — a door we leave closed by choice, not by inability.
