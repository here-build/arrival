# @inhuman.tools/arrival-lsp

Scheme language service for arrival: a **type lens** over TypeScript's
`LanguageService` (Volar-shaped — virtual TS, never run; diagnostics/completions/
hover lifted back to Scheme spans). Ships **node + browser worker** runtimes so
IDEs and tools (codemirror, the inhuman studio editor) share one substrate.

The `PRE` prelude and builtin `.d.ts` leaves declaration-merge so Scheme
programs **bite** under `tsc` (`(car 5)` and `(+ "a" 1)` produce real diagnostics
on `.scm` spans) — that prelude, its builtin leaves, and the leaf-authoring
contract now live in the sibling package
`@inhuman.tools/arrival-internals-types-prelude` (`src/prelude/types.d.ts` +
`src/prelude/builtins/*.d.ts`, proven by its own `src/__tests__/prelude.test.ts`);
see that package to add or change a builtin leaf.

## Layout

```
src/
  index.ts               ← public barrel (language-service, span-map, typed-scanner, host-prelude, service-core)
  language-service.ts    ← Node entry: disk prelude + `typescript` package libs
  browser.ts             ← Browser/worker entry: bundled prelude + inlined TS libs (this package's vite build)
  service-core.ts        ← environment-agnostic core: emitTypes → ts.LanguageService → Mapper
  worker.ts              ← (Shared)Worker entry attaching ls-server to the worker's ports
  ls-client.ts / ls-server.ts / ls-protocol.ts  ← worker wire protocol (light/heavy split)
  host-prelude.ts        ← assemble a lens `host` option from a host's rosetta type registry
  span-map.ts            ← bidirectional position lens over emitTypes's Mapping[]
  typed-scanner.ts       ← the Σ∩T bridge: narrow a completion scanner by Layer T
  balance.ts             ← balance an incomplete Scheme prefix for cursor queries
  __tests__/             ← language-service, browser-service, host-prelude, ls-protocol, etc. (verdicts)
```

## `typecheck` / `test`

```bash
pnpm typecheck   # tsc --noEmit over src
pnpm test        # vitest: language-service, browser-service, host-prelude, ls-protocol, typed-scanner, etc.
```

## Emitter contract

The emitter (`emitTypes`, `@inhuman.tools/arrival-mercury`'s
`src/type-emit/emit.ts`, imported here via `service-core.ts`) lowers Scheme forms
to **virtual TS that is type-checked, never run**. The load-bearing consequence
for binding forms:

- **`(let ((x v)) body)` / `(let* …)` at STATEMENT position → a pure TS block
  statement**, NOT an IIFE:
  ```ts
  { const x = v; /* …body… */ }
  ```
  Because we only type-check (never execute), block-scoping is correct and
  ceremony-free — an IIFE would add a function boundary that distorts control-flow
  analysis and return-type inference for no benefit.
- **At EXPRESSION position** (a value is needed and no statement block can be
  placed, e.g. `(define r (let ((x 1)) (+ x 1)))`), the same binding form lowers
  to an immediately-invoked arrow instead — `(() => { const x = …; return …; })()`
  — the one place an arrow-call appears; the block-not-IIFE rule governs
  statement/body position only.
- **`set!`-ed variables lower to `let`** (the rest stay `const`), so reassignment
  type-checks without widening every binding.

This block-not-IIFE lowering is the reason PRE's `sexpr` is only the *fallback*:
most heads lower to direct calls inside these plain blocks, and TS checks them
natively.
