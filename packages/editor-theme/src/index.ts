// @here.build/editor-theme — hermetic CodeMirror look system.
//
// Fonts ship IN the package (OFL; no CDN). Writing vs reading split:
// JetBrains Mono under the caret, Monaspace Argon/Krypton in overlay rows.
//
// Happy path:
//   import { theme } from "@here.build/editor-theme";
//   import "@here.build/editor-theme/fonts.css";
//   extensions: [language, theme, /* host */]
//
// NOTE: fonts are NOT a side effect of this module — a CSS import inside a
// library dist gets dropped by rollup's css-in-dependency handling. Apps
// import the faces once, explicitly.

import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { formTheme } from "./form-theme.js";
import { lintMarks } from "./lint-marks.js";
import { overlayTheme } from "./overlay-theme.js";
import { searchMarks } from "./search-marks.js";
import { FONT_WRITING } from "./stacks.js";
import { structureMarks } from "./structure-marks.js";
import { darcula } from "./theme-darcula.js";

export {
  FONT_WRITING,
  FONT_READING_VALUES,
  FONT_READING_TYPES,
} from "./stacks.js";

export {
  SURFACE,
  TEXT,
  TEXT_PRIMARY,
  TEXT_SECONDARY,
  TEXT_TERTIARY,
  SEV_ERROR,
  SEV_WARNING,
  SEV_INFO,
  SEV_HINT,
  container,
  corners,
} from "./chrome.js";

export { darcula };
export { overlayTheme };
export { formTheme };
export { searchMarks };
export { lintMarks };
export { structureMarks };

export {
  ideaSearch,
  ideaSearchTheme,
  ideaSearchKeymap,
  createIdeaSearchPanel,
  openIdeaSearch,
  openIdeaReplace,
  setSearchOpenMode,
  type IdeaSearchOptions,
  type SearchOpenMode,
} from "./search-panel.js";


/** Editor surface typography: JetBrains Mono on the scroller. */
export const editorFont: Extension = EditorView.theme({
  ".cm-scroller": { fontFamily: FONT_WRITING },
});

/** Density + content padding + scroller. No forced height — notebook cells
 *  auto-size; fill-pane hosts add `editorFill` or size the parent. */
export const editorChrome: Extension = EditorView.theme({
  "&": { fontSize: "12.5px" },
  ".cm-content": { padding: "10px 0" },
  ".cm-scroller": { overflow: "auto" },
  "&.cm-focused": { outline: "none" },
});

/** Stretch the editor root to its parent (FileEditor / fill-pane hosts). */
export const editorFill: Extension = EditorView.theme({
  "&": { height: "100%", minHeight: "100%" },
});

/**
 * The product look — Darcula body/syntax + full overlay/form/mark chrome.
 * Drop on any CodeMirror 6 editor; enable autocomplete/lint/search extensions
 * and the classes light up without further host CSS.
 *
 * Does NOT force height:100% (notebook cells auto-size). Fill-pane hosts:
 *   extensions: [theme, editorFill, …]
 */
export const theme: Extension = [
  darcula,
  editorFont,
  editorChrome,
  overlayTheme,
  formTheme,
  searchMarks,
  lintMarks,
  structureMarks,
];
