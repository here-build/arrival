# Execution sequences — sessions, scopes, budgets

`exec` is one-shot: run a program, get plain JS values. Everything session-shaped — a REPL, a
long agent conversation, a multi-step pipeline — is `execState` plus two handles it returns:
the run's `scope` (where `define`s landed) and its `runCtx` (the per-run hermetic knobs).
Every example below runs against the shipped package as written.

## Accumulate definitions across calls

`execState` returns `{ values, scope, runCtx }`. Pass the `scope` back in and the next call
continues the same lexical session — definitions accumulate, nothing is resent:

```typescript
import { execState } from "@here.build/arrival";

const s1 = await execState(`(define base 40)`);
const s2 = await execState(`(define bump (lambda (x) (+ x 2)))`, { scope: s1.scope });
const s3 = await execState(`(bump base)`, { scope: s2.scope });
// s3.values[0] ≙ 42; s1.scope === s2.scope === s3.scope (identity holds)
```

The `scope` you get back IS the object you passed (memoized per lexical frame), so holding any
one of them is holding the session.

## Name a session up front

When the session outlives one call chain — an agent turn loop, a notebook — mint the scope
first and thread it:

```typescript
import { execState, LexicalScope } from "@here.build/arrival";

const session = LexicalScope.fresh("agent-session");
await execState(`(define greeting "hello")`, { scope: session });
await execState(`(string-append greeting " world")`, { scope: session }); // "hello world"
```

`LexicalScope.fresh()` is an isolated lexical root: a second `fresh()` scope does not see the
first one's names (`greeting` there is `Unbound variable`, with suggestions). Builtins are not
part of the scope — they resolve through the run's capability base, so isolation is exactly
lexical, never a crippled stdlib.

## Capabilities are per call, the scope carries

Vocabulary and memory are orthogonal: `capabilities` decide what verbs *this call* may use,
`scope` decides what definitions persist. A session can gain or lose tools mid-way without
losing its state:

```typescript
const sess = LexicalScope.fresh();
await execState(`(define city "berlin")`, { scope: sess });                         // no tools
await execState(`(forecast-for city)`, { scope: sess, capabilities: [weather] });   // "cloudy in berlin"
```

## Budgets — every knob, observed

Execution is boundable, not bounded by default. All three bounds compose; whichever fires
first wins.

```typescript
// Wall-clock: the trampoline itself throws when the budget elapses — no external controller.
await exec(`(define (spin n) (spin (+ n 1))) (spin 0)`, { budgetMs: 100 });
// ⇒ ArrivalError: execution budget exceeded (99.99ms)

// Allocation: charged at the collection-op choke points (map/filter/reduce…), where a
// wall-clock tick can't see inside a single native pass.
await exec(`(map (lambda (x) x) big-list)`, { heapBudget: 100 });
// ⇒ ArrivalError: heap budget exceeded (100 cells) — a run materialized more list cells
//   than its allocation bound allows

// Killable, always:
const ctl = new AbortController();
setTimeout(() => ctl.abort(), 50);
await exec(`(define (spin n) (spin (+ n 1))) (spin 0)`, { signal: ctl.signal });
// ⇒ This operation was aborted
```

A budget error ends the *call*, not the session — the scope and its definitions survive, so a
REPL loop catches, reports, and continues.

## The CLI over this surface

`@here.build/arrival-cli` is a REPL over exactly this scope/capability surface — one
`LexicalScope` per session, budgets per form, capabilities armed per call. This doc
deliberately stops at the library API; the CLI is its first consumer, not a different model.
