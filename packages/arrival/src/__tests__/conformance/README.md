# Conformance suite — chibi corpus harness

One vitest row per Scheme test form from the chibi-scheme corpora
(`vendor/chibi-scheme/tests/r7rs-tests.scm`, ~1087 forms; SRFI-1 corpus beside it). This is
the value layer's coherence law against the spec (F4, `docs/test-suite-architecture.md`).

## Architecture

Collection time (top-level `await`): `chibi/manifest.ts` splits the corpus into ordered
*steps* — `setup`, `test`, `block`, `unreadable` (reader door), `section` — parses each form,
and assigns a verdict from `chibi/registries.ts`: `it` / `it.fails` (known gap, flips loudly
when fixed) / `it.skip` / `it.todo`.

Test time: `chibi/runner.ts` (CorpusRunner) drives one shared env per spec file with a
monotone cursor — `outcomeFor(step)` executes pending setups, then the form itself, through a
one-slot harness sink (`chibi/harness-capability.ts`). Comparison is scheme `equal?`, never a
JS-side duck-tolerance (P4).

## Env-state strategy — sequential `it`s, one shared env

The corpus is genuinely stateful (`force`/`delay` counters), so execution order must match
registration order — a plain ordered loop, not `it.each` partitioning. Rejected alternatives:
fork-per-test gives false isolation (closures capture creation frames by reference) at real
cost; prefix-replay is O(n²) and re-runs side effects; dependency analysis is unsound through
macro expansion. A setup failure stamps every downstream row with the poisoning step, so
poisoning is loud and attributed.

## Block steps

A top-level `(let () (define …) (test …) …)` is one *evaluation* with k *outcome slots*: the
first member's `it` triggers the block, each member consumes its slot, and members after a
mid-block abort get an explicit `block-aborted` outcome. The unit of evaluation is the
top-level form; the unit of verdict is the test form.

## Budgets and ordering guard

Every step runs under `budgetMs` — a wedge becomes a red row with a budget error, not a hung
run. The cursor throws on any out-of-order request ("corpus steps executed out of order —
check vitest sequence config"), so ordering is guarded, not assumed.

## Editing registries

A red row is either a real interpreter bug (fix the interpreter) or a registry row (known gap
with a cited reason). Registry rows are the anti-vacuity floor: a form that starts passing
while registered `it.fails` fails the suite — expected-failures flip loudly, never pass
silently.
