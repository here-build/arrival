import { useEffect, useMemo, useState } from "react";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { schemeToSweet, sweetToScheme } from "@here.build/arrival-sweet";
import { darcula, FONT_WRITING, overlayTheme } from "@here.build/editor-theme";
import CodeMirror from "@uiw/react-codemirror";

import {
  paramHintsExtension,
  schemeIde,
  schemeStructural,
  schemeSweet,
  sweetIdeBackend,
  type SchemeStructuralOptions,
} from "../index.js";
import { useSchemeIde } from "./use-scheme-ide.js";

// JetBrains Mono — the WRITING font (the reading fonts live in the popup; see
// @here.build/editor-theme's fonts.css for the writing/reading split).
const editorTheme = EditorView.theme({
  "&": { height: "100%" },
  ".cm-scroller": { fontFamily: FONT_WRITING, fontSize: "12.5px" },
});

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

type View = "scheme" | "sweet";

export interface SchemeEditorProps {
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  /** Which lens to show. CONTROLLED by the studio's unified
   *  `[scheme][sweet][graph]` switch (the graph mode is handled above this — when
   *  graph is shown, FileEditor isn't mounted). */
  view?: View;
  /** Reports the sweet buffer's parse state up so the studio can show the
   *  "⚠ unsaved" marker next to the switch (null = parses / not in sweet). */
  onSweetError?: (err: string | null) => void;
  /** Cross-file goto-def: Cmd/Ctrl-click on a `require`d name lands here —
   *  `(path, span-in-that-file)`. The studio wires its file switcher. */
  onNavigate?: (path: string, span: { start: number; length: number }) => void;
  /** Host extensions mounted on the CLASSIC lens only (the saas shell's run
   *  plumbing: cost-bar decorations, focus/blur run triggers, cursor tracking).
   *  Classic-only because they anchor to classic source offsets — the sweet
   *  lens moves them. */
  classicExtensions?: Extension[];
  /** The classic lens's EditorView, for hosts that dispatch into it (cost-bar
   *  decoration refresh). Called with the view on mount, null on unmount. */
  onCreateEditor?: (view: EditorView | null) => void;
  /** Paredit-style structural editing on the CLASSIC lens (expand/contract
   *  selection, slurp/barf, splice, kill-sexp, strict delete protection,
   *  structural indent) — OFF by default. It reassigns several muscle-memory
   *  chords (Alt-↑/↓ shadows Move Line, Mod-Shift-K shadows Delete Line) and
   *  refuses any Backspace/Delete that would unbalance the buffer (Alt-Backspace
   *  / mac Ctrl-Backspace force-deletes past it). Pass `true` for the defaults,
   *  or an options object to disable individual pieces. */
  structuralEditing?: boolean | SchemeStructuralOptions;
}

/**
 * Classic + sweet lenses over canonical `.scm`.
 *
 * Controlled `view` prop. Sweet = readable surface; canonical scheme is
 * always the persisted truth.
 *
 * Lens contract (one-directional, stable bifunctor):
 * - Enter sweet: derive once via schemeToSweet (user formatting preserved).
 * - While in sweet: sweet buffer is authoritative; edits forward via
 *   sweetToScheme (per-form splice + canonical reprint fallback).
 * - Never reflow sweet from classic (would clobber formatting).
 * - Unparseable sweet: hold last good classic, surface error.
 * - External value change (not our echo) re-seeds.
 *
 * Structural/parens hints only on classic. IDE uses sweetIdeBackend on sweet.
 */
export function SchemeEditor({
  value,
  onChange,
  readOnly,
  view = "scheme",
  onSweetError,
  onNavigate,
  classicExtensions,
  onCreateEditor,
  structuralEditing = false,
}: SchemeEditorProps): React.ReactElement {
  // The classic scheme is canonical truth (mirrors File.body).
  const [text, setText] = useState(value);
  // The sweet buffer: the truth WHILE the sweet view is open. Seeded from the
  // classic on entering sweet and thereafter one-directional (sweet → classic).
  const [sweet, setSweet] = useState("");
  const [sweetErr, setSweetErr] = useState<string | null>(null);

  // Seed sweet only on entering sweet (view dep). A text change while sweet
  // is active came from sweet itself — reseeding would destroy formatting.
  useEffect(() => {
    if (view !== "sweet") return;
    try {
      setSweet(schemeToSweet(text));
      setSweetErr(null);
    } catch (error) {
      setSweet(text); // un-renderable scheme: fall back to raw, still editable
      setSweetErr(errMsg(error));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // External file change (not our optimistic echo) re-seeds text.
  // value === text for our own edits (studio is optimistic).
  useEffect(() => {
    if (value !== text) setText(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  // Surface the parse state to the studio's switch (only meaningful in sweet).
  useEffect(() => onSweetError?.(view === "sweet" ? sweetErr : null), [sweetErr, view, onSweetError]);

  // The classic view handle goes null whenever the classic editor unmounts —
  // switching to the sweet lens or unmounting entirely — so a host never
  // dispatches into a destroyed view.
  useEffect(() => {
    if (view === "sweet") onCreateEditor?.(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => onCreateEditor?.(null), []);

  const onSchemeChange = (v: string): void => {
    setText(v);
    onChange?.(v);
  };

  const onSweetChange = (v: string): void => {
    setSweet(v); // never reflow user's sweet formatting
    try {
      // Forward: unchanged top forms keep exact bytes; edited ones reprint.
      const classic = sweetToScheme(v, text);
      setText(classic);
      onChange?.(classic);
      setSweetErr(null);
    } catch (error) {
      setSweetErr(errMsg(error)); // hold last good classic
    }
  };

  // The IDE backend (type-checked diagnostics / hover / completion / goto-def)
  // loads lazily and lands when ready; until then the editor is plain. The
  // backend answers in classic scheme coordinates; the sweet lens mounts the
  // SAME backend through `sweetIdeBackend` (the sweet↔classic span aligner).
  const ide = useSchemeIde(true);

  const classicExt = useMemo<Extension[]>(
    // Parameter inlay hints + structural (paredit) editing are .scm-only, and
    // CLASSIC-lens-only — the sweet lens's indentation is semantic, so
    // structural ops there would be wrong, not just unmapped.
    () => [
      schemeSweet(),
      darcula,
      editorTheme,
      ...(classicExtensions ?? []),
      paramHintsExtension("scheme"),
      ...(structuralEditing === false
        ? []
        : [schemeStructural(structuralEditing === true ? undefined : structuralEditing)]),
      overlayTheme,
      ...(ide === null
        ? []
        : [
            schemeIde(ide, {
              ...(onNavigate === undefined ? {} : { openFile: onNavigate }),
            }),
          ]),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ide, onNavigate, structuralEditing],
  );
  // The sweet lens always shows a .scm, so it always gets the (sweet) hints —
  // plus the full IDE through the sweet↔classic aligner. (Structural ops stay
  // classic-only — sweet indentation is semantic.)
  const sweetExt = useMemo<Extension[]>(
    () => [
      schemeSweet(),
      darcula,
      editorTheme,
      paramHintsExtension("sweet"),
      ...(ide === null
        ? []
        : [overlayTheme, schemeIde(sweetIdeBackend(ide), onNavigate === undefined ? {} : { openFile: onNavigate })]),
    ],
    [ide, onNavigate],
  );

  const basicSetup = { lineNumbers: true, highlightActiveLine: false, foldGutter: true };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
        {view === "sweet" ? (
          <CodeMirror
            key="sweet"
            value={sweet}
            extensions={sweetExt}
            editable={!readOnly}
            onChange={onSweetChange}
            theme="none"
            height="100%"
            style={{ height: "100%" }}
            basicSetup={basicSetup}
          />
        ) : (
          <CodeMirror
            key="scheme"
            value={text}
            extensions={classicExt}
            editable={!readOnly}
            onChange={onSchemeChange}
            onCreateEditor={(view) => onCreateEditor?.(view)}
            theme="none"
            height="100%"
            style={{ height: "100%" }}
            basicSetup={basicSetup}
          />
        )}
      </div>
    </div>
  );
}
