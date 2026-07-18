# @inhuman.tools/arrival-type-lens

The **Scheme→TS type lens** foundation: the shared `PRE` prelude that the 34
builtin `.d.ts` leaves declaration-merge into, so arrival-chain Scheme programs
**bite** under `tsc` (`(car 5)` and `(+ "a" 1)` produce real diagnostics that lift
back to their `.scm` spans).

This package owns **Wave A** of the Scheme→TS type-lens DAG
(design doc, 2026-06-10, in the here.build monorepo docs):
the package scaffold + the `PRE` prelude + the reference leaf. The 34-way builtin
fan-out (Wave B) and the emitter/Volar plumbing (Waves C–E) build on top of it.

## Layout

```
src/
  prelude/
    types.d.ts                 ← PRE: base types + Dict + accessors + sexpr + ArrShape merge contract
    builtins/
      _TEMPLATE.d.ts           ← copy-paste stub for a leaf
      car.d.ts                 ← L01, the reference leaf
      <slug>.d.ts              ← 33 more, one per fan-out agent
  __tests__/
    prelude.test.ts            ← bite + merge proof (verdict)
```

## The leaf-authoring contract (read this if you are a fan-out agent)

You own **exactly one** file: `src/prelude/builtins/<slug>.d.ts`. You never read
another leaf. Everything you need is `PRE` (`../types.d.ts`) + your spec stub.

### 1. File path & slug

`src/prelude/builtins/<slug>.d.ts`. The slug is the scheme name; operator names get
a readable slug (`+`→`plus`, `<`/`>`/`<=`/`>=`/`=`→`compares`). The **file name is
cosmetic** — only the interface **member key** must be the exact scheme name.

### 2. The `interface ArrShape { … }` merge pattern

PRE declares an empty `interface ArrShape {}` and a `declare const __arr: ArrShape`.
Each leaf re-declares the interface with its ONE member; TypeScript merges all
`interface ArrShape` declarations across files into a single shape, and `__arr` is
typed by the union of every leaf's member.

```ts
// builtins/cdr.d.ts
interface ArrShape {
  cdr<T>(xs: List<T>): T[];
}
```

- **Operator / TS-illegal names → bracketed string keys**, legal inside an
  interface body, so no identifier cleaning is ever needed:
  ```ts
  interface ArrShape {
    "+"(...xs: number[]): number;
    "string-append"(...xs: string[]): string;
    "null?"(xs: List<unknown>): boolean;
  }
  ```
- **Multi-name families** (chained compares, the math cluster) are ONE file with
  several keys in the same interface block — they are cohesive (all-compares,
  all-string-ops), so finer splitting buys no parallelism.

> Why `interface` and not `declare const __arr: { … }`: object type literals on a
> `const` do **not** merge across files (you get a duplicate-identifier error);
> `interface` declarations **do** merge unconditionally. This is verified in
> `__tests__/prelude.test.ts`. Always extend `ArrShape`.

### 3. Plain TS scalars + PRE's structural types

Write signatures in plain TS scalars plus PRE's structural vocabulary:

| type | meaning |
|---|---|
| `string` / `number` / `boolean` | plain TS scalars — the membrane makes a boundary value *be* its plain JS type |
| `void` | the unspecified value (Scheme's unit) |
| `List<T>` | a Scheme proper list (readonly `T[]`) |
| `Pair<H, T>` | a cons cell / dotted pair `[head, tail]` |
| `Nil` | the empty list (`readonly []`) |
| `Dict<Pairs>` | the homoiconic-dict → precise-object mapped type |
| `Field<O, K>` | `(@ obj key)` / `(:key obj)` precise field read |
| `sexpr<F>(f, …a)` | typed-apply fallback for indirect/HOF call heads |

Scalars are plain TS — the LIPS↔JS membrane guarantees a boundary value *is* its
plain JS type, so no dialect is needed. (The `SNum`/`SStr`/`SBool`/`Unit` aliases
still exist in `types.d.ts` — each ≡ its primitive — but only as the compat bridge
for rosetta `type:` strings and the `(require)` synthesizer; don't author leaves
against them.)

### 4. The required 1-positive / 1-negative assertion

Each leaf adds a tiny verdict proving its signature bites. Mirror the cases in
`__tests__/prelude.test.ts` (run PRE + your leaf through a bare
`ts.LanguageService`):

- **POSITIVE** — a well-typed call → `getSemanticDiagnostics` returns `[]`.
  e.g. `__arr.cdr([1, 2, 3])` → no diagnostic.
- **NEGATIVE** — a mis-typed call → exactly one diagnostic.
  e.g. `__arr.cdr(5)` → one diagnostic (5 is not a list).

Self-check `vitest run` green against PRE before reporting. Do **not** commit (the
orchestrator gates the build + merged typecheck and commits with explicit
pathspecs). Report: your file path, pass/fail, and the diagnostic message you
observed (so the orchestrator can spot all-`any` regressions early).

## `typecheck` / `test`

```bash
pnpm typecheck   # tsc --noEmit over src (prelude + leaves compile & merge)
pnpm test        # vitest: the bite + merge proof
```

## Emitter contract (NEXT WAVE — recorded here so it is not lost)

The emitter (`types-emit.ts`, Wave C, lands in `arrival-chain-view`) lowers Scheme
forms to **virtual TS that is type-checked, never run**. The load-bearing
consequence for binding forms:

- **`(let ((x v)) body)` / `(let* …)` → a pure TS block statement**, NOT an IIFE:
  ```ts
  { const x = v; /* …body… */ }
  ```
  Because we only type-check (never execute), block-scoping is correct and
  ceremony-free — an IIFE would add a function boundary that distorts control-flow
  analysis and return-type inference for no benefit.
- **`set!`-ed variables lower to `let`** (the rest stay `const`), so reassignment
  type-checks without widening every binding.

This block-not-IIFE lowering is the reason PRE's `sexpr` is only the *fallback*:
most heads lower to direct calls inside these plain blocks, and TS checks them
natively.
