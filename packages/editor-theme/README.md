# `@here.build/editor-theme`

Hermetic **CodeMirror 6 look system**: self-hosted fonts + H-K-compensated Darcula + full overlay/form/mark chrome. No CDN, no Google Fonts, no host CSS for stock CM classes.

## Happy path

```ts
import { theme, editorFill } from "@here.build/editor-theme";
import "@here.build/editor-theme/fonts.css";

new EditorView({
  // editorFill only when the host is a fill-pane (not auto-height cells)
  extensions: [/* language */, theme, editorFill, /* host */],
});
```

Drop `theme` on any CM6 editor. Enable `@codemirror/{autocomplete,lint,language}` and completion popups, lint panels, match marks, fold, and bracket matching pick up the shared vocabulary without further styling.

### IDEA-style find / replace

```ts
import { theme, ideaSearch } from "@here.build/editor-theme";

extensions: [theme, ideaSearch()]
// Mod-f     → find (collapsed)
// Mod-Alt-f → find + replace (expanded, replace focused)
// Chevron   → toggle replace row
// Cc · W · .*  case / word / regexp
```

Do not also add bare `search()` / `searchKeymap` — `ideaSearch()` owns those.

## Pieces (when you need surgery)

| Export | What |
|--------|------|
| `theme` | Product compose (preferred) — no forced height |
| `editorFill` | `height: 100%` for fill-pane hosts |
| `darcula` | Editor body + H-K syntax |
| `editorFont` / `editorChrome` | Typeface + density/padding |
| `overlayTheme` | Tooltips, completion, hover, lint panel shell |
| `formTheme` | `.cm-button`, `.cm-textfield`, panels, stock search form |
| `searchMarks` | Search / selection-match decorations |
| `lintMarks` | Severity squiggles, actions, gutter tint |
| `structureMarks` | Brackets, fold placeholder/gutter |
| `FONT_WRITING` / `FONT_READING_*` | Font stacks |
| chrome tokens (`SURFACE`, `SEV_*`, …) | Shared palette |

## Fonts

Import CSS once at the app root (not as a side effect of the JS module — bundlers drop nested library CSS):

```ts
import "@here.build/editor-theme/fonts.css";
```

- **Writing** (under the caret): JetBrains Mono  
- **Reading** (completion rows, tooltip text): Monaspace Argon (values) / Krypton (types)

## Storybook

```bash
pnpm --filter @here.build/editor-theme storybook
```

Stories exercise body, search panel, completion, lint, and the full IDE surface together.

## Re-bake Darcula

Syntax lightness is solved through the Nayatani H-K model and baked to hex:

```bash
node scripts/bake-darcula.mjs
```
