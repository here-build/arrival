import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { schemeToSweet, sweetToScheme } from "@here.build/arrival-sweet";
import { paramHintsExtension, schemeIde, schemeStructural, schemeSweet, sweetIdeBackend } from "../index.js";
import CodeMirror from "@uiw/react-codemirror";
import { useEffect, useMemo, useState } from "react";

import { darcula, FONT_WRITING, overlayTheme } from "@here.build/editor-theme";

import { useSchemeIde } from "./use-scheme-ide.js";
import { useSchemeRanker, type SchemeRankerConfig } from "./use-scheme-ranker.js";

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
  /** OPT-IN neural completion: an on-device model (default SmolLM2-360M
   *  q4f16, ~273MB one-time download — the measured quant-study winner) re-ranks the type-lens's proven
   *  candidates by its top-p nucleus. `true` = defaults; an object overrides
   *  model/dtype/device. Proof always wins — the model only orders within it. */
  neural?: boolean | SchemeRankerConfig;
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
}

/**
 * The arrival scheme editor — classic + sweet lens over a canonical `.scm` body.
 *
 * The lens (`scheme`/`sweet`) is CONTROLLED from the studio's unified
 * `[scheme][sweet][graph]` switch via the `view` prop. Sweet is the readable
 * lens over the canonical scheme (curly-infix, `=>` lambdas, colon kwargs); the
 * stored body is ALWAYS canonical scheme. The bifunctor is stable by
 * construction: sweet is derived from the classic exactly once, on entering the
 * sweet view, and from then on it is the truth while you're in it — every sweet
 * edit folds FORWARD to canonical scheme (`sweetToScheme`, per-form splice with a
 * canonical-reprint fallback) and propagates through `onChange`, but the sweet
 * buffer is never reflowed back from the classic, so your formatting is never
 * clobbered. A mid-edit sweet that doesn't parse holds the last good classic
 * (the body isn't corrupted) and shows an "unsaved" marker until it parses again.
 */
export function SchemeEditor({
  value,
  onChange,
  readOnly,
  view = "scheme",
  onSweetError,
  neural,
  onNavigate,
  classicExtensions,
  onCreateEditor,
}: SchemeEditorProps): React.ReactElement {
  // The classic scheme is canonical truth (mirrors File.body).
  const [text, setText] = useState(value);
  // The sweet buffer: the truth WHILE the sweet view is open. Seeded from the
  // classic on entering sweet and thereafter one-directional (sweet → classic).
  const [sweet, setSweet] = useState("");
  const [sweetErr, setSweetErr] = useState<string | null>(null);

  // Seed the sweet buffer from the canonical classic each time the lens switches
  // INTO sweet (deps: [view] only — a `text` change while in sweet comes FROM a
  // sweet edit, so reseeding on it would clobber the user's formatting). This is
  // the old `enterSweet`, now driven by the controlled `view` prop.
  useEffect(() => {
    if (view !== "sweet") return;
    try {
      setSweet(schemeToSweet(text));
      setSweetErr(null);
    } catch (e) {
      setSweet(text); // un-renderable scheme: fall back to raw, still editable
      setSweetErr(errMsg(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // Re-seed from an EXTERNAL change to the open file: the body changed underneath
  // us (lazily loaded on open, or edited on disk / by another client). A no-op when
  // `value` merely echoes our own edit — the studio updates `File.body`
  // optimistically + synchronously, so `value === text` for our own keystrokes and
  // this never clobbers active typing. Only a genuine outside change differs.
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
    setSweet(v); // keep the buffer exactly as typed — never reflow it
    try {
      // Splice against the current canonical: unchanged top-level forms keep
      // their exact bytes (comments + hand-formatting), only edited forms reprint.
      const classic = sweetToScheme(v, text);
      setText(classic);
      onChange?.(classic); // the body stays canonical scheme
      setSweetErr(null);
    } catch (e) {
      setSweetErr(errMsg(e)); // hold the last good classic; surface "unsaved"
    }
  };

  // The IDE backend (type-checked diagnostics / hover / completion / goto-def)
  // loads lazily and lands when ready; until then the editor is plain. The
  // backend answers in classic scheme coordinates; the sweet lens mounts the
  // SAME backend through `sweetIdeBackend` (the sweet↔classic span aligner).
  const ide = useSchemeIde(true);
  const ranker = useSchemeRanker(
    neural !== undefined && neural !== false ? (neural === true ? {} : neural) : null,
  );

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
      schemeStructural(),
      overlayTheme,
      ...(ide !== null
        ? [schemeIde(ide, { ...(ranker === null ? {} : { ranker }), ...(onNavigate === undefined ? {} : { openFile: onNavigate }) })]
        : []),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ide, ranker, onNavigate],
  );
  // The sweet lens always shows a .scm, so it always gets the (sweet) hints —
  // plus the full IDE through the sweet↔classic aligner. No neural ranker here:
  // the ghost model ranks over CLASSIC prefixes, and a sweet prefix would skew
  // its probabilities (structural ops likewise stay classic-only — sweet
  // indentation is semantic).
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
