// search-marks — in-buffer match decorations from @codemirror/search.
// Independent of whether the host uses stock search panel or createPanel.

import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { MATCH, MATCH_SELECTED, SELECTION_MATCH } from "./chrome.js";

export const searchMarks: Extension = EditorView.theme({
  ".cm-searchMatch": {
    backgroundColor: MATCH,
    borderRadius: "2px",
  },
  ".cm-searchMatch-selected": {
    backgroundColor: MATCH_SELECTED,
  },
  // highlightSelectionMatches (Mod-d / occurrence highlight)
  ".cm-selectionMatch": {
    backgroundColor: SELECTION_MATCH,
    borderRadius: "2px",
  },
});
