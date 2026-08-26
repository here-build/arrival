# @inhuman.tools/arrival-mercury

Arrival Scheme → TypeScript. This package is the Scheme instance of the **Mercury**
architecture: a semantic model answers questions; emission is the last, dumbest step.

## Who this is for

| Surface | Role |
|---------|------|
| **`compileSource`** | Single-buffer compile (studio, REPL, tools). |
| **`buildProject`** | Multi-file in-memory compile. Disk I/O belongs to the host. |
| **`./type-emit`** | LSP type lens — `emitTypes` produces virtual TypeScript that is type-checked, never run. |
| **`./product`** + **`./circuit`** | Browser-safe compile and attribution-circuit projections. |

Differential agreement (interpreter ≡ compiled) is
**`@inhuman.tools/arrival-mercury-oracle`**. That package owns `tsx`; this compiler
must not carry it.

## Compile

```ts
import { compileSource } from "@inhuman.tools/arrival-mercury/product";

const { code, model } = await compileSource(
  `(define (greet name) (string-append "hi " name))\n(greet "x")`,
  { capabilities }, // host `EnvCapability[]` — the product vocabulary
);
```

Mercury does **not** default a product plane. Pass `capabilities` (mint a session
and harvest) or a pre-harvested `registry` (`greenfieldRegistryFor(session)`).
Omit both and `compileSource` throws.

## Exports

| Subpath | Surface | Browser-safe |
|---------|---------|--------------|
| **`.`** | Full compiler barrel (`compileSource`, `buildProject`, `SchemeSemanticModel`, …). Pulls `node:fs` via the project builder. | **No** |
| **`./product`** | `compileSource` | Yes |
| **`./circuit`** | Parse / desugar / classify + StaticProv projections (`circuitToSexpr`, mermaid, wireframe, …) | Yes |
| **`./front`** | `parseSexprs`, `desugar`, node helpers | Yes |
| **`./type-emit`** | `emitTypes` for `@inhuman.tools/arrival-lsp` | Yes |

The root barrel is **not** browser-safe (`node:fs`). Import `./product` or
`./circuit` from a browser / Vite graph.

## Emit contract = **loose** mode (not R7RS-strict)

Arrival’s interpreter defaults to **loose** (`ExecOptions.strict` defaults false):
nil-tolerance, list-ish ops on array/vector spines, extra reader conveniences.
**Strict** (`strict: true`) is opt-in portability testing via `strictGate` /
`PortabilityError`.

This compiler emits for **loose only**. We do not compile R7RS-strict throws
(car of `()`, car of a vector, …). Residuals match the default interpreter so
the oracle (also loose by default) can agree without a second “strict residual”
axis. That is intentional simplicity, not incompleteness.

## Gates

```bash
pnpm --filter @inhuman.tools/arrival-mercury run check:gates
```

Locks: no `@inhuman.tools/mercury` package/deps, oracle greenfield-only,
type-emit free of type-lens imports, product APIs return `SchemeSemanticModel`.

## Testing

```bash
pnpm test
pnpm --filter @inhuman.tools/arrival-mercury run check:gates
```

Oracle corpus and interpreter ≡ compiled agreement live in
`@inhuman.tools/arrival-mercury-oracle`.

Contributor-internal test architecture (fail-closed law, forge taxonomy):
[TESTING.md](./TESTING.md). Not a user-facing suite map.

## The four organs

Mercury is a paradigm, not a package name (same class of word as Roslyn). If an
emitter chooses *semantics*, that choice belongs on `SchemeSemanticModel`.
Manifestation (spelling, call shape, file layout) is the materializer’s only job.

| Organ | Role |
|-------|------|
| **1. Semantic model** | Middle-end handle: decisions, not raw analyses (`importsOf`, `asyncnessOf`, `shakeOf`, …). **`SchemeSemanticModel`** is a public export. |
| **2. Structural end** | Structural optimization before any backend sees the tree. |
| **3. Hybrid slotted tree** | Fluid Residual IR + hard `ts.factory` chunks. |
| **4. Lookahead materializer** | Census → allocate names → emit once top-down. Zero post-passes on text. |

## License

[FSL-1.1-MIT](./LICENSE.md) — Functional Source License 1.1, MIT Future License. Each version converts to MIT two years after its release date.
