# @inhuman.tools/mercury

Mercury — compilation for humans. A faithful, deterministic projection of an
[arrival-chain](../../../foundations/arrival/arrival/README.md) Scheme program into a target
language — the read-view "glass" over a chain program. TS-only (stage 1, per
`docs/working-proposals/inhuman-mercury-ts-dual-runtime.md`): the Python emitter,
the ax signature-DSL backend, and the dspy/langchain-py backends were deleted —
every emitted module is TypeScript.

The idea Mercury names: origin and target aren't conceptually different kinds of
things, so a compiler can lower into a target with more expressive power than the
source strictly needs — and spend that slack designing the output around the
reader's mental model, not a mechanical translation. here.build has its own
Mercury manifestation (its React/Next.js codegen); this is Inhuman's.

## Install

```bash
pnpm add @inhuman.tools/mercury
```

## Usage

```ts
import { projectToJs, compileProject } from "@inhuman.tools/mercury";

// Project a chain program's scheme into readable TS (the read-view).
const ts = projectToJs(program);
```

Entry points:

- `projectToJs` / `projectToJsRaw` — project a program into TS (formatted / raw).
- `compileProject` — multi-file compile (`CompileTarget`, `EmittedFile`; the
  `prompts` backend axis — today `langchain-js`, a second `ts-vercel-ai` backend
  lands in a later wave).
- `emitTypes` — emit a TypeScript type view.
- `sliceToTypeScript`, `formatJs` — focused helpers.

Subpath exports: `@inhuman.tools/mercury/browser` (browser-targeted entry) and `@inhuman.tools/mercury/types-emit`.

The projection is **deterministic and faithful** — the same program always yields the same output, and the output round-trips the program's semantics rather than re-interpreting them.

## License

[FSL-1.1-MIT](./LICENSE.md) — Functional Source License 1.1, MIT Future License. Each version converts to MIT two years after its release date.
