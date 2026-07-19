# @inhuman.tools/arrival-mercury

**Arrival’s Mercury instance** — the scheme→TypeScript compiler that answers to
the [Mercury paradigm](../../../../docs/foundations/mercury/mercury-as-paradigm.md).

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

`SchemeSemanticModel` is a **public** export and the product path’s named
middle-end — not an anonymous internal of `build/`. It may re-home to a
foundation package when LSP consumers land; the **name travels with it**.

## Product surfaces

- **`buildProject`** — multi-file in-memory project compile (CLI `inhuman build` / `inhuman compile` are disk clients of this).
- **`SchemeSemanticModel`** — organ 1; construct explicitly, then materialize from its views.
- **Oracle** — differential agreement: interpreter ≡ compiled (greenfield path only; legacy string emit is not gate-authoritative).

Also owns: front-end desugar/nodes, CoreForm, type glass (`emitTypes`), stage-0 /
cold-stdlib resolution, infer/mcp `RuntimeRef` surface (kept until @-symbol
declaration work), residual algebra + printer.

## Testing

See [TESTING.md](./TESTING.md) — the suite is an adversarial artifact: the
negative flows (forges refused, fail-closed paths) are the product; positive
flows exist so fail-closed doesn't degenerate into fail-everything.

## License

[FSL-1.1-MIT](./LICENSE.md) — Functional Source License 1.1, MIT Future License. Each version converts to MIT two years after its release date.
