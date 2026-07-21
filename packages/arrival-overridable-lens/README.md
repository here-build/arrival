# @inhuman.tools/arrival-overridable-lens

Static (pre-eval) reading of a program's `(define/overridable …)` surface for [Arrival](../arrival/README.md). Parses, **never evaluates** — so a tool can discover a program's declared knobs without running its effects.

## Install

```bash
pnpm add @inhuman.tools/arrival-overridable-lens
```

## Usage

```ts
import { extractOverridableForms, foldSchemaTag } from "@inhuman.tools/arrival-overridable-lens";

const forms = await extractOverridableForms(source);   // top-level (define/overridable …) knobs
for (const f of forms) {
  const tag = foldSchemaTag(f.typeNode);                // { ok: true, value: "string" | ["enum", …] | … }
  // f.defaultNode is the raw default parse node — evaluate or read it per your need
}
```

The surface, in two halves:

- **Walk** — `overridableFormsFromForms` (over already-parsed forms; pure, never throws) and `extractOverridableForms` (parses a source, `[]` on failure). Top-level only; hands back raw `typeNode`/`defaultNode` parse nodes. Plus `extractRequires` for the config-in-config `(require …)` edges.
- **Fold** — `foldSchemaTag`: a parse node of an `s/*` schema form → its canonical tagged-list value, with zero evaluation. The pre-eval dual of core's post-eval `tagToJsonSchema` (`@inhuman.tools/arrival/schema-tag`).

Consumed one-way by the out-of-core overridable lenses — studio form fields, the API `:input` deriver, the CLI argv mapper. Core never holds parse nodes, so this lives out of core and deps it downward.

## License

[FSL-1.1-MIT](./LICENSE.md) — Functional Source License 1.1, MIT Future License. Each version converts to MIT two years after its release date.
