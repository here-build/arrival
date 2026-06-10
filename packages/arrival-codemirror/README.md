# @here.build/arrival-codemirror

CodeMirror 6 support for arrival scheme (classic + sweet), ejected from
`@here.build/inhuman-react` so any here.build surface (and anyone else) can mount
an IDE-grade `.scm` editor.

## What's inside

- **`schemeSweet()`** — a `LanguageSupport` covering canonical Scheme s-expressions
  AND the sweet-expression superset (curly-infix `{a + b}`, colon kwargs, `=>`
  lambdas, glyph operators). Emits semantic highlight tags only — bring your theme.
- **`paramHintsExtension(lens)`** — parameter inlay hints for calls to local
  `(define (f …))`s, per lens (`"scheme"` / `"sweet"`). Pure analysis, runtime-free.
- **`schemeIde(backend)`** — the IDE bundle: type-checked diagnostics
  (`@codemirror/lint`), hover signatures+docs, completion, Cmd/Ctrl-click
  go-to-definition. Individual pieces exported too (`schemeLinter`, `schemeHover`,
  `schemeCompletion`, `schemeGotoDefinition`).

## The backend seam

IDE extensions are wired onto a **`SchemeIdeBackend`** — a structural interface
whose methods may answer sync or with a `Promise` (so an in-process service and a
worker-hosted one both fit). `@here.build/arrival-type-lens`'s
`SchemeLanguageService` is assignable as-is:

```ts
import { createBrowserSchemeLanguageService } from "@here.build/arrival-type-lens/browser";
import { schemeSweet, paramHintsExtension, schemeIde } from "@here.build/arrival-codemirror";

const extensions = [
  schemeSweet(),
  paramHintsExtension("scheme"),
  schemeIde(createBrowserSchemeLanguageService()),
];
```

The IDE features operate in CLASSIC scheme coordinates. In a sweet-lens buffer,
use the language + `paramHintsExtension("sweet")` only — the sweet↔classic span
mapping needed to lift diagnostics into sweet coordinates is future work.
