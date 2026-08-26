# @inhuman.tools/arrival-mercury-oracle

Black-box interpreter ≡ compiled agreement: compile → tsx-import → run.

This package isolates `tsx`. The compiler (`@inhuman.tools/arrival-mercury`) must not carry that runtime dependency; the session-assembly seam and value utilities live down in the compiler and are re-exported here.

Node / CI only. The compiled artifact is imported through a tsx ESM loader.

## Surface

- `runOracle(session, source)` — one differential run (`agreementOf` over interpreter vs compiled outcomes).
- `openOracleSession(capabilities)` — assemble the shared interpreter session. The host passes the capability roster; this package does not default a product plane.
- Corpus helpers: `runCorpusCase`, `outcomeMatches`, `ExpectedOutcome` (three-way expected / interpreter / compiled, or `divergent` halves).
- `greenfieldRegistryFor(session)` — emit overlay harvested from the session the host assembled.

Gate subject is `"greenfield"` only (`OracleSubject`; the string-emit path is gone). Pass `capabilities` into the session; do not expect a default product plane or a default registry.

```ts
import { openOracleSession, runOracle } from "@inhuman.tools/arrival-mercury-oracle";

const session = await openOracleSession(capabilities);
const verdict = await runOracle(session, "(+ 1 2)");
```

## Compiler

The scheme→TS compiler is `@inhuman.tools/arrival-mercury` (`SchemeSemanticModel`, residual, render). This package is the agreement harness around it.

## License

[FSL-1.1-MIT](./LICENSE.md) — Functional Source License 1.1, MIT Future License.
