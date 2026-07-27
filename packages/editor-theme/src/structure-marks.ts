// structure-marks — fold chrome + bracket matching (from @codemirror/language).

import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import {
  BRACKET_MATCH,
  BRACKET_MISMATCH,
  HAIRLINE,
  TEXT_SECONDARY,
  TEXT_TERTIARY,
} from "./chrome.js";
import { FONT_WRITING } from "./stacks.js";

export const structureMarks: Extension = EditorView.theme({
  "&.cm-focused .cm-matchingBracket": {
    backgroundColor: BRACKET_MATCH,
    outline: "none",
  },
  "&.cm-focused .cm-nonmatchingBracket": {
    backgroundColor: BRACKET_MISMATCH,
    outline: "none",
  },

  ".cm-foldPlaceholder": {
    backgroundColor: "oklch(1 0 0 / 0.06)",
    border: HAIRLINE,
    color: TEXT_SECONDARY,
    borderRadius: "3px",
    margin: "0 2px",
    padding: "0 4px",
    fontFamily: FONT_WRITING,
    fontSize: "0.9em",
    cursor: "pointer",
    "&:hover": {
      backgroundColor: "oklch(1 0 0 / 0.12)",
      color: "var(--color-text-primary, oklch(0.92 0 0 / 1))",
    },
  },

  ".cm-foldGutter span": {
    color: TEXT_TERTIARY,
    padding: "0 2px",
    cursor: "pointer",
    "&:hover": { color: TEXT_SECONDARY },
  },

  // Placeholder (empty doc hint) + special chars — restrained.
  ".cm-placeholder": {
    color: TEXT_TERTIARY,
    fontStyle: "normal",
  },
  ".cm-specialChar": {
    color: "#af3434",
  },
  ".cm-trailingSpace": {
    backgroundColor: "oklch(0.55 0.14 25 / 0.18)",
  },
});
