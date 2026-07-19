# Execution sequences — sessions, scopes, budgets

`exec` is one-shot: run a program, get plain JS values. Everything session-shaped — a REPL, a
long agent conversation, a multi-step pipeline — is `execState`, which returns `{ values, scope,
runCtx }`: the run's `scope` (where `define`s landed) and its `runCtx` (the per-run hermetic knobs).

## The two invariants

**Definitions accumulate through the scope; the returned `scope` IS the object you passed in.**
Thread `s1.scope` into the next call and the session continues — nothing is resent, and identity
holds (`s1.scope === s2.scope`). To name a session up front, mint one with `LexicalScope.fresh(name)`
and pass it to every call.

```typescript
const session = LexicalScope.fresh("agent-session");
await execState(`(define greeting "hello")`, { scope: session });
await execState(`(string-append greeting " world")`, { scope: session }); // "hello world"
```

`LexicalScope.fresh()` is an isolated lexical root — a second `fresh()` scope does not see the
first's names. Isolation is exactly *lexical*, never a crippled stdlib: builtins are not part of the
scope, they resolve through the run's capability base.

**Vocabulary and memory are orthogonal: `capabilities` are per call, `scope` carries.** A session can
gain or lose tools mid-way without losing its state — `capabilities` decide what verbs *this call* may
use, `scope` decides what definitions persist.

## Budgets — all three compose, first to fire wins

Execution is boundable, not bounded by default. The three bounds have edges worth stating so a host
doesn't learn them in production:

- **`budgetMs`** (wall-clock) is checked at trampoline ticks, so it bounds *interpretation* time and
  **cannot interrupt a run parked inside one native capability call** — a slow `fetch` answers in full
  or not at all (a 50ms budget over a native 200ms sleep returns at 200ms). The trampoline itself
  throws; no external controller is needed.
- **`signal`** is the only bound that reaches into native calls. When the deadline must also cover a
  slow native call, arm `signal` alongside `budgetMs`.
- **`heapBudget`** meters list-cell materialization at the collection-op choke points (map/filter/
  reduce/append/…). It does **not** bound string building or bigint growth (no cells), and borrowed
  host containers are zero-copy (reading one is not materializing it). Bound the data your capabilities
  mint, not the data they borrow.

A budget error ends the *call*, not the session — the scope and its definitions survive, so a REPL
loop catches, reports, and continues.

## The CLI over this surface

`@inhuman.tools/arrival-cli` is a REPL over exactly this scope/capability surface — one `LexicalScope`
per session, budgets per form, capabilities armed per call. It is this library API's first consumer,
not a different model.
