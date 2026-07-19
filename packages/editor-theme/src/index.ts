// @here.build/editor-theme — the redistributable editor look.
//
// Fonts ship IN the package (OFL; no CDN, no Google Fonts, offline-true) and
// load as a side effect of importing this module. The split is writing vs
// reading: JetBrains Mono under the caret, Monaspace in rendered overlay rows
// (texture healing reads beautifully in static text and jiggles under a
// caret — see fonts.css for the full rationale).

// NOTE the fonts are NOT a side effect of this module: a CSS import inside a
// library dist gets silently dropped by rollup's css-in-dependency handling
// (verified live: the woff2 assets were emitted, the @font-face rules lost).
// Apps import the faces once, explicitly:
//   import "@here.build/editor-theme/fonts.css";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { FONT_WRITING } from "./stacks.js";

export { FONT_WRITING, FONT_READING_VALUES, FONT_READING_TYPES } from "./stacks.js";

/** Editor surface typography: JetBrains Mono on the scroller. Sizing stays the
 *  host's business — this sets only the face. */
export const editorFont: Extension = EditorView.theme({
  ".cm-scroller": { fontFamily: FONT_WRITING },
});

/** The shared editor CHROME — fill-height, 12px, tidy content padding, scroll.
 *  Font is deliberately NOT here (compose with `editorFont`, or let a host like
 *  FileEditor set its own face), so one block serves both the raw-CodeMirror
 *  viewers and the IDE editor without fighting over the typeface. */
export const editorChrome: Extension = EditorView.theme({
  "&": { fontSize: "12px", height: "100%", minHeight: "100%" },
  ".cm-content": { padding: "10px 0" },
  ".cm-scroller": { overflow: "auto" },
});

export { darcula } from "./theme-darcula.js";
export { overlayTheme } from "./overlay-theme.js";
