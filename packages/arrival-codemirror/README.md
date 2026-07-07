# @here.build/arrival-codemirror

CodeMirror 6 for arrival Scheme (classic + sweet).

Ejected from inhuman-react so any surface can mount an IDE-grade `.scm` editor.

## Exports

- `schemeSweet()` — StreamLanguage for s-exprs + sweet (curly-infix, `k:`, `=>`, `== && ||`). Tags only.
- `paramHintsExtension("scheme" | "sweet")` — view-only inlay hints for local define args. Pure.
- Structural: `schemeStructural`, `expandSelection`, `slurpForward` etc. + keymap. Verify-reparse net (no corruption).
- `schemeGhost(backend)` — inline Σ∩T preview (Tab accepts one symbol).
- `schemeIde(backend, opts?)` — full IDE bundle (or individuals: linter, hover, completion, goto, semanticHighlight).
- `sweetIdeBackend(backend)` — wrap a classic backend for sweet buffers.

Also re-exports decision fns for tests (`pickGhost`, `lineTailIsSafe`, `toCmDiagnostics`...).

## Backend seam

`SchemeIdeBackend` is structural (methods may be sync or Promise). Worker and in-process backends are interchangeable. Coordinates are always classic Scheme.

```ts
import { schemeSweet, paramHintsExtension, schemeIde } from "@here.build/arrival-codemirror";
import { createBrowserSchemeLanguageService } from "@here.build/arrival-type-lens/browser";

const exts = [
  schemeSweet(),
  paramHintsExtension("scheme"),
  schemeIde(createBrowserSchemeLanguageService()),
];
```

## Lenses

- Classic (`.scm`): full power (structural, ghost, hints, IDE).
- Sweet: language + `paramHintsExtension("sweet")` + `schemeIde(sweetIdeBackend(backend))`.
- No bidirectional sync. Sweet edits forward to canonical scheme via `sweetToScheme`. Unparseable sweet holds last good classic.

## Limitations

- Full IDE on sweet requires sweet↔classic span mapping (future).
- Structural ops and some decorations are classic-only (sweet indent is semantic).
- Cross-file goto requires host `openFile` callback.

See source for `SchemeIdeBackend`, `SchemeGhostOptions`, `SchemeStructuralOptions`.
