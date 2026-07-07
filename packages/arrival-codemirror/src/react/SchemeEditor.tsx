import { useEffect, useMemo, useState } from "react";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { schemeToSugarcoat, sugarcoatToScheme } from "@here.build/arrival-sugarcoat";
import { darcula, FONT_WRITING, overlayTheme } from "@here.build/editor-theme";
import CodeMirror from "@uiw/react-codemirror";

import {
  paramHintsExtension,
  schemeIde,
  schemeStructural,
  schemeSugarcoat,
  sugarcoatIdeBackend,
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

type View = "scheme" | "sugarcoat";

export interface SchemeEditorProps {
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  /** Which lens to show. CONTROLLED by the studio's unified
   *  `[scheme][sugarcoat][graph]` switch (the graph mode is handled above this — when
   *  graph is shown, FileEditor isn't mounted). */
  view?: View;
  /** Reports the sugarcoat buffer's parse state up so the studio can show the
   *  "⚠ unsaved" marker next to the switch (null = parses / not in sugarcoat). */
  onSugarcoatError?: (err: string | null) => void;
  /** Cross-file goto-def: Cmd/Ctrl-click on a `require`d name lands here —
   *  `(path, span-in-that-file)`. The studio wires its file switcher. */
  onNavigate?: (path: string, span: { start: number; length: number }) => void;
  /** Host extensions mounted on the CLASSIC lens only (the saas shell's run
   *  plumbing: cost-bar decorations, focus/blur run triggers, cursor tracking).
   *  Classic-only because they anchor to classic source offsets — the sugarcoat
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
 * Classic + sugarcoat lenses over canonical `.scm`.
 *
 * Controlled `view` prop. Sugarcoat = readable surface; canonical scheme is
 * always the persisted truth.
 *
 * Lens contract (one-directional, stable bifunctor):
 * - Enter sugarcoat: derive once via schemeToSugarcoat (user formatting preserved).
 * - While in sugarcoat: sugarcoat buffer is authoritative; edits forward via
 *   sugarcoatToScheme (per-form splice + canonical reprint fallback).
 * - Never reflow sugarcoat from classic (would clobber formatting).
 * - Unparseable sugarcoat: hold last good classic, surface error.
 * - External value change (not our echo) re-seeds.
 *
 * Structural/parens hints only on classic. IDE uses sugarcoatIdeBackend on sugarcoat.
 */
export function SchemeEditor({
  value,
  onChange,
  readOnly,
  view = "scheme",
  onSugarcoatError,
  onNavigate,
  classicExtensions,
  onCreateEditor,
  structuralEditing = false,
}: SchemeEditorProps): React.ReactElement {
  // The classic scheme is canonical truth (mirrors File.body).
  const [text, setText] = useState(value);
  // The sugarcoat buffer: the truth WHILE the sugarcoat view is open. Seeded from the
  // classic on entering sugarcoat and thereafter one-directional (sugarcoat → classic).
  const [sugarcoat, setSugarcoat] = useState("");
  const [sugarcoatErr, setSugarcoatErr] = useState<string | null>(null);

  // Seed sugarcoat only on entering sugarcoat (view dep). A text change while sugarcoat
  // is active came from sugarcoat itself — reseeding would destroy formatting.
  useEffect(() => {
    if (view !== "sugarcoat") return;
    try {
      setSugarcoat(schemeToSugarcoat(text));
      setSugarcoatErr(null);
    } catch (error) {
      setSugarcoat(text); // un-renderable scheme: fall back to raw, still editable
      setSugarcoatErr(errMsg(error));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // External file change (not our optimistic echo) re-seeds text.
  // value === text for our own edits (studio is optimistic).
  useEffect(() => {
    if (value !== text) setText(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  // Surface the parse state to the studio's switch (only meaningful in sugarcoat).
  useEffect(() => onSugarcoatError?.(view === "sugarcoat" ? sugarcoatErr : null), [sugarcoatErr, view, onSugarcoatError]);

  // The classic view handle goes null whenever the classic editor unmounts —
  // switching to the sugarcoat lens or unmounting entirely — so a host never
  // dispatches into a destroyed view.
  useEffect(() => {
    if (view === "sugarcoat") onCreateEditor?.(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => onCreateEditor?.(null), []);

  const onSchemeChange = (v: string): void => {
    setText(v);
    onChange?.(v);
  };

  const onSugarcoatChange = (v: string): void => {
    setSugarcoat(v); // never reflow user's sugarcoat formatting
    try {
      // Forward: unchanged top forms keep exact bytes; edited ones reprint.
      const classic = sugarcoatToScheme(v, text);
      setText(classic);
      onChange?.(classic);
      setSugarcoatErr(null);
    } catch (error) {
      setSugarcoatErr(errMsg(error)); // hold last good classic
    }
  };

  // The IDE backend (type-checked diagnostics / hover / completion / goto-def)
  // loads lazily and lands when ready; until then the editor is plain. The
  // backend answers in classic scheme coordinates; the sugarcoat lens mounts the
  // SAME backend through `sugarcoatIdeBackend` (the sugarcoat↔classic span aligner).
  const ide = useSchemeIde(true);

  const classicExt = useMemo<Extension[]>(
    // Parameter inlay hints + structural (paredit) editing are .scm-only, and
    // CLASSIC-lens-only — the sugarcoat lens's indentation is semantic, so
    // structural ops there would be wrong, not just unmapped.
    () => [
      schemeSugarcoat(),
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
  // The sugarcoat lens always shows a .scm, so it always gets the (sugarcoat) hints —
  // plus the full IDE through the sugarcoat↔classic aligner. (Structural ops stay
  // classic-only — sugarcoat indentation is semantic.)
  const sugarcoatExt = useMemo<Extension[]>(
    () => [
      schemeSugarcoat(),
      darcula,
      editorTheme,
      paramHintsExtension("sugarcoat"),
      ...(ide === null
        ? []
        : [overlayTheme, schemeIde(sugarcoatIdeBackend(ide), onNavigate === undefined ? {} : { openFile: onNavigate })]),
    ],
    [ide, onNavigate],
  );

  const basicSetup = { lineNumbers: true, highlightActiveLine: false, foldGutter: true };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
        {view === "sugarcoat" ? (
          <CodeMirror
            key="sugarcoat"
            value={sugarcoat}
            extensions={sugarcoatExt}
            editable={!readOnly}
            onChange={onSugarcoatChange}
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
