# @here.build/arrival-codemirror

CodeMirror 6 for arrival Scheme (classic + sugarcoat).

Ejected from inhuman-react so any surface can mount an IDE-grade `.scm` editor.

## Exports

- `schemeSugarcoat()` — StreamLanguage for s-exprs + sugarcoat (curly-infix, `k:`, `=>`, `== && ||`). Tags only.
- `paramHintsExtension("scheme" | "sugarcoat")` — view-only inlay hints for local define args. Pure.
- Structural: `schemeStructural`, `expandSelection`, `slurpForward` etc. + keymap. Verify-reparse net (no corruption).
- `schemeGhost(backend)` — inline Σ∩T preview (Tab accepts one symbol).
- `schemeIde(backend, opts?)` — full IDE bundle (or individuals: linter, hover, completion, goto, semanticHighlight).
- `sugarcoatIdeBackend(backend)` — wrap a classic backend for sugarcoat buffers.

Also re-exports decision fns for tests (`pickGhost`, `lineTailIsSafe`, `toCmDiagnostics`...).

## Backend seam

`SchemeIdeBackend` is structural (methods may be sync or Promise). Worker and in-process backends are interchangeable. Coordinates are always classic Scheme.

```ts
import { schemeSugarcoat, paramHintsExtension, schemeIde } from "@here.build/arrival-codemirror";
import { createBrowserSchemeLanguageService } from "@here.build/arrival-type-lens/browser";

const exts = [
  schemeSugarcoat(),
  paramHintsExtension("scheme"),
  schemeIde(createBrowserSchemeLanguageService()),
];
```

## Lenses

- Classic (`.scm`): full power (structural, ghost, hints, IDE).
- Sugarcoat: language + `paramHintsExtension("sugarcoat")` + `schemeIde(sugarcoatIdeBackend(backend))`.
- No bidirectional sync. Sugarcoat edits forward to canonical scheme via `sugarcoatToScheme`. Unparseable sugarcoat holds last good classic.

## Limitations

- Full IDE on sugarcoat requires sugarcoat↔classic span mapping (future).
- Structural ops and some decorations are classic-only (sugarcoat indent is semantic).
- Cross-file goto requires host `openFile` callback.

See source for `SchemeIdeBackend`, `SchemeGhostOptions`, `SchemeStructuralOptions`.
