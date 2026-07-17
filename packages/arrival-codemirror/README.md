# @inhuman.tools/arrival-codemirror

**Paredit and a real language server, in the same editor.** CodeMirror 6 for
[arrival](../arrival/README.md) Scheme — classic s-expressions and the
[Sugarcoat](../arrival-sugarcoat/README.md) face — with structural editing and
TypeScript-powered IDE intelligence fused into one extension set.

Those two traditions have always lived in different worlds. Structural editing is the Lisp
lineage's crown jewel (Emacs paredit, Calva, Cursive): the buffer is a tree, edits are tree
operations, unbalanced parens are impossible. Language servers are the ALGOL lineage's: hover
types, red squiggles, ranked completion — powered by a type checker Lisps historically don't
have. arrival gets both at once because of one architectural fact: **its type checker is `tsc`**.
The `s/*` contract layer gives every symbol a TypeScript signature, `@here.build/arrival-type-lens`
lowers a Scheme program into a typed TS view, `tsc` checks that view, and every diagnostic lifts
back to its `.scm` span. This package is where that pays out in an editor: slurp a form into a
call *and watch the argument's type error appear* — the same buffer, the same keystroke ladder.

Everything below ships and is exercised by the test suite (`src/__tests__/`, including drift
guards that pin the real arrival-type-lens service against the backend seam).

## What's in the box

- **`schemeSugarcoat()`** — the language mode. One `StreamLanguage` covers classic Scheme *and*
  the full Sugarcoat superset: curly-infix, `k:` / `:key` keywords, `=>`, `== && ||`,
  at-expressions with their interpolation sub-mode, the whole R7RS numeric-literal zoo (radix/exactness/complex —
  lifted faithfully from the legacy scheme mode). Emits highlight *tags* only — bring your own
  theme.

- **`schemeStructural()`** — paredit for the classic lens: expand/contract selection ladder,
  slurp/barf, splice, kill-sexp, strict delete protection, depth-based structural indent. TRUE
  structure comes from the real reader (`parseSexprs`, spans on every node), not the highlighter
  — and every edit passes a **verify-reparse net**: if the result wouldn't parse, the op is a
  no-op. A structural op corrupting the buffer is impossible, not merely unlikely. Protection self-suspends on
  an unbalanced buffer (you can always hand-repair; pasted-unbalanced text stays editable) and
  resumes when it balances. Quote sugar is understood: splicing `'(…)` never strands the `'`.

- **`schemeIde(backend)`** — the language-server surface, one extension per verb:
  - `schemeLinter` — type-checked diagnostics as squiggles (real tsc codes, carried through);
  - `schemeHover` — inferred type signature + docs of the symbol under the pointer;
  - `schemeCompletion` — Σ∩T-ranked completion: entries carry `fits` (proven type-fit for the
    argument slot — the same machinery that masks the sampler's logits, surfaced for a human),
    grouped into fixed-rank sections (*fits this slot* / *in scope* / *builtins* / *forms*).
    Tiered boost, never filter: unfit candidates demote but stay visible. Special forms complete
    as snippets in head position, bare keywords elsewhere;
  - `schemeGotoDefinition` — Cmd/Ctrl-click jumps to a definition, in-buffer or cross-file
    through your `openFile` hook (`require`d names carry their file);
  - `schemeSemanticHighlight` — what the checker *knows* an identifier is (parameter, local,
    function, property…) painted over the lexical layer.

- **`schemeGhost(backend)`** — inline ghost completion: the best Σ∩T candidate rendered dim
  after the cursor, but only where insertion is provably safe (nothing but whitespace/closers to
  end of line), and never at an operator head with an empty prefix — that would be guessing. Tab
  ladder: snippet field > popup selection > ghost > default.

- **`paramHintsExtension("scheme" | "sugarcoat")`** — inlay parameter-name hints before the
  arguments of local defines. Pure static analysis, view-only widgets, never in buffer text.

- **`sugarcoatIdeBackend(backend)`** — the same IDE on the Sugarcoat face. Wraps a
  classic-coordinate backend with the sugarcoat↔classic span aligner, so
  `schemeIde(sugarcoatIdeBackend(backend))` mounts hover/lint/completion/goto on the sweet
  syntax — three lenses end-to-end: sugarcoat → classic → TypeScript. It also carries
  surface-face lints of its own (patterns that are *valid* Sugarcoat but near-certainly not what
  the author meant, found by custdev with LLM authors).

- **`/react`** — the batteries-included mount: `<SchemeEditor>` renders one canonical `.scm`
  through either lens (Sugarcoat derives on entry, edits fold back losslessly, canonical Scheme
  stays the persisted truth), and `useSchemeIde()` loads a shared language service down a
  graceful ladder — SharedWorker → dedicated Worker → in-thread → plain editor — so `tsc` stays
  off the main thread while a worker rung holds (the in-thread rung trades that for
  availability) and a failed rung degrades instead of breaking. `setSchemeIdeFiles` /
  `setSchemeIdeRequireTypes` feed it project files for `(require …)` resolution.

## The seam

Every IDE extension is wired to exactly one method of a structural `SchemeIdeBackend`:

```ts
interface SchemeIdeBackend {
  getSemanticDiagnostics(scheme: string): MaybePromise<SchemeIdeDiagnostic[]>;
  getQuickInfoAtPosition(scheme: string, offset: number): MaybePromise<SchemeIdeQuickInfo | null>;
  getCompletionsAtPosition(scheme: string, offset: number): MaybePromise<SchemeIdeCompletionEntry[]>;
  getDefinitionAtPosition(scheme: string, offset: number): MaybePromise<SchemeIdeDefinition[]>;
  getSemanticClassifications?(scheme: string): MaybePromise<SchemeIdeClassifiedSpan[]>;   // optional
  getCompletionContext?(scheme: string, offset: number): MaybePromise<SchemeIdeCompletionContext>; // optional
}
```

Methods may answer sync or with a Promise, so an in-process service and a worker behind a
message port satisfy the *same* seam — `@here.build/arrival-type-lens` fits directly, in either
mode. The optional methods are presence-gated feature unlocks: `getSemanticClassifications`
turns on semantic highlighting, `getCompletionContext` upgrades completion and the ghost to the
Σ∩T-ranked pipeline. Coordinates are always classic Scheme; Sugarcoat buffers translate through
`sugarcoatIdeBackend`.

## Quick start

```ts
import { EditorView, lineNumbers } from "@codemirror/view";
import { closeBrackets } from "@codemirror/autocomplete";
import { createBrowserSchemeLanguageService } from "@here.build/arrival-type-lens/browser";
import {
  paramHintsExtension, schemeIde, schemeStructural, schemeSugarcoat,
} from "@inhuman.tools/arrival-codemirror";

new EditorView({
  parent: document.querySelector("#editor")!,
  doc: `(define (greet name)\n  (string-append "hello, " name))\n\n(greet 42)\n`,
  extensions: [
    lineNumbers(),
    closeBrackets(),
    schemeSugarcoat(),               // language + highlighting
    schemeStructural(),              // paredit
    paramHintsExtension("scheme"),   // inlay hints
    schemeIde(createBrowserSchemeLanguageService()),  // tsc, in an editor
  ],
});
```

`(greet 42)` gets a real type error — `tsc`'s, lifted to the `.scm` span. Runnable versions of
this and two more setups live in [`demos/`](./demos/README.md).

## Structural keymap

Five transformation chords, browser-safe, zero `Ctrl+Alt+char` (AltGr-safe). A failed
*transformation* chord does nothing (falling through to a default like Delete Line would be a
destructive surprise); *selection* chords degrade gracefully.

| Chord | Op |
|---|---|
| `Alt-↑` / `Alt-↓` | expand / contract selection (the ladder remembers its steps) |
| `Mod-Shift-K` | slurp forward — `(a \| b) c` → `(a b c)` |
| `Mod-Shift-J` | barf forward — `(a \| b c)` → `(a b) c` |
| `Alt-S` | splice — `(a \| b c)` → `a b c` |
| `Mod-Shift-Backspace` | kill-sexp |
| `Alt-Backspace` (mac: `Ctrl-Backspace`) | force delete — the strict-protection escape hatch |

Strict delete protection refuses any Backspace/Delete that would unbalance a currently-balanced
buffer — the caret steps over the delimiter instead, paredit-style.

## Honest edges

- **Structural ops are classic-lens-only, by design.** Sugarcoat's indentation is semantic —
  slurp/barf there would be wrong, not just unmapped.
- **The IDE on Sugarcoat goes through span alignment.** A position inside sugar that has no
  classic token answers empty; diagnostics inside sugar lift to the enclosing paired node.
  Unparseable Sugarcoat degrades to no answers (the editor keeps its last good state).
- **`#\…` char literals and `#|…|#` block comments are outside the structural reader's
  vocabulary** — their presence suspends structure (conservative: they would *mis*-parse rather
  than throw). Highlighting and the IDE are unaffected.
- **The ghost and the completion popup never race** — the unprompted moment at a narrowed
  argument slot belongs to the ghost; Ctrl-Space always brings the list; the popup hides the
  ghost.

## Demos

[`demos/`](./demos/README.md) — three minimal, typechecked setups:

1. **`vanilla-ide.ts`** — the quick-start above: vanilla CM6, no framework.
2. **`sugarcoat-flip.ts`** — one program, two faces, the *same* backend on both
   (classic directly; Sugarcoat through `sugarcoatIdeBackend`).
3. **`react-editor.tsx`** — `<SchemeEditor>` with the lens switch and worker-backed IDE.

## License

**[FSL-1.1-MIT](./LICENSE.md)** — Functional Source License 1.1, MIT Future License; each version
converts to MIT two years after its release. Same license and same plain-words intent as the
[arrival core](../arrival/README.md#license): your own pipelines, agency work, and internal
platforms are always fair use; the one reserved lane is a competing self-service product.
Questions: team@here.build
