# @inhuman.tools/arrival-lsp

Scheme language service for arrival: a **type lens** over TypeScript’s
`LanguageService` (Volar-shaped — virtual TS, never run; diagnostics/completions/
hover lifted back to Scheme spans). Ships **node + browser worker** runtimes so
IDEs and tools (codemirror, mercury type-emit, MCP) share one substrate.

The shared `PRE` prelude and builtin `.d.ts` leaves declaration-merge so Scheme
programs **bite** under `tsc` (`(car 5)` and `(+ "a" 1)` produce real diagnostics
on `.scm` spans).

## Layout

```
src/
  prelude/
    types.d.ts                 ← PRE: base types + Dict + accessors + sexpr + ArrShape merge contract
    builtins/
      _TEMPLATE.d.ts           ← copy-paste stub for a leaf
      car.d.ts                 ← the reference leaf
      <slug>.d.ts              ← one per builtin
  __tests__/
    prelude.test.ts            ← bite + merge proof (verdict)
```

## The leaf-authoring contract (read this before adding a builtin leaf)

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

Run `vitest run` green against PRE before considering a leaf done.

## `typecheck` / `test`

```bash
pnpm typecheck   # tsc --noEmit over src (prelude + leaves compile & merge)
pnpm test        # vitest: the bite + merge proof
```

## Emitter contract (planned)

The emitter (`types-emit.ts`) lowers Scheme forms to **virtual TS that is
type-checked, never run**. The load-bearing consequence for binding forms:

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
