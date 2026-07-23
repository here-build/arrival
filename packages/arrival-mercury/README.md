# @inhuman.tools/arrival-mercury

**Arrival’s Mercury instance** — the scheme→TypeScript compiler that answers to
the Mercury paradigm.

**Mercury is a paradigm, not a package name** (same class of word as Roslyn): a
semantic model answers questions; emission is the last, dumbest step. This
package is one *instance* of that architecture. The visual-model→React instance
lives under `@here.build/mercury*`. The failed pass-pipeline predecessor
`@inhuman.tools/mercury` is deprecated and dissolving into the inhuman CLI.

## The four organs

| Organ | Role | Code |
|-------|------|------|
| **1. Semantic model** | Middle-end. Roslyn-style handle: decisions, not raw analyses. Policy lives here (`importsOf`, `asyncnessOf`, `shakeOf`, `idiomAt`, `factsAt`, …). | `src/model/` — **`SchemeSemanticModel`** |
| **2. Structural end** | All structural optimization before any backend sees the tree; shaken live artifact. | coreform + model views (`shakeOf`, …) |
| **3. Hybrid slotted tree** | Fluid Residual IR + hard `ts.factory` chunks (slots back into IR). | `src/residual/`, walker → `R` |
| **4. Lookahead materializer** | Census → allocate names → emit once top-down via `ts.factory`. Zero post-passes on text. | `src/naming/` materializers + `src/residual/render.ts` |

**Law:** if an emitter chooses *semantics*, that choice belongs on
`SchemeSemanticModel`. Manifestation (spelling, ramda call shape, file layout)
is the materializer’s only job.

### Gates

```bash
pnpm --filter @inhuman.tools/arrival-mercury run check:gates
# or from monorepo root:
pnpm check:mercury-gates
```

Locks: no `@inhuman.tools/mercury` package/deps, oracle greenfield-only,
type-emit free of type-lens imports, product APIs return `SchemeSemanticModel`.

### Emit contract = **loose** mode (not R7RS-strict)

Arrival’s interpreter defaults to **loose** (`ExecOptions.strict` defaults false):
nil-tolerance, list-ish ops on array/vector spines, extra reader conveniences.
**Strict** (`strict: true`) is opt-in portability testing via `strictGate` /
`PortabilityError`.

This compiler emits for **loose only**. We do not compile R7RS-strict throws
(car of `()`, car of a vector, …). Residuals match the default interpreter so
the oracle (also loose by default) can agree without a second “strict residual”
axis. That is intentional simplicity, not incompleteness.

`SchemeSemanticModel` is a **public** export and the product path’s named
middle-end — not an anonymous internal of `build/`. It may re-home to a
foundation package when LSP consumers land; the **name travels with it**.

## Product surfaces

- **`buildProject`** — multi-file in-memory project compile (CLI `inhuman build` / `inhuman compile` are disk clients of this).
- **`SchemeSemanticModel`** — organ 1; construct explicitly, then materialize from its views.
- **Oracle** — differential agreement: interpreter ≡ compiled (greenfield path only; legacy string emit is not gate-authoritative).

Also owns: front-end desugar/nodes, CoreForm, type glass (`emitTypes`),
**runtime imports** (`RUNTIME_MANIFEST`: stage0 Scheme-texture + **ramda** cold
stdlib), the `infer` family's `RuntimeRef` surface (stage0 stubs; still
carries only `infer`/`infer/scalar`/`infer/chat/scalar` — the mcp/llm/chat
rename hasn't reached this manifest yet, see `rules/phase1.ts`), residual
algebra + printer.

Cold stdlib: prefer `ramda` when arity/order match **loose** faces (e.g.
`length`). Keep stage0 for Law T, n-ary, wrong ramda shape (`max-by`,
`list-ref`), and **loose nil-tolerance** shims (`car`/`cdr` empty → `[]`).
See `RAMDA_DIVERGENCES` and `RUNTIME_MANIFEST`.

## Testing

See [TESTING.md](./TESTING.md) — the suite is an adversarial artifact: the
negative flows (forges refused, fail-closed paths) are the product; positive
flows exist so fail-closed doesn't degenerate into fail-everything.

## License

[FSL-1.1-MIT](./LICENSE.md) — Functional Source License 1.1, MIT Future License. Each version converts to MIT two years after its release date.
