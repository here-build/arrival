// ide — IDE-grade CodeMirror extensions for arrival scheme, over a backend seam.
//
// Four capabilities, each wired onto ONE method of a `SchemeIdeBackend`:
//   • schemeLinter        → getSemanticDiagnostics   (@codemirror/lint)
//   • schemeHover         → getQuickInfoAtPosition   (hoverTooltip)
//   • schemeCompletion    → getCompletionsAtPosition (@codemirror/autocomplete)
//   • schemeGotoDefinition→ getDefinitionAtPosition  (Cmd/Ctrl-click)
//
// The backend is STRUCTURAL and may answer sync or async — arrival-type-lens's
// `SchemeLanguageService` is assignable as-is (the in-process service), and a
// worker-hosted backend fits the same seam without touching the extensions.
// All coordinates are CLASSIC scheme offsets — the backend's own coordinate
// space (the type lens lifts TS spans there). Sweet-lens buffers should not
// mount these until a sweet↔classic span mapping exists.

import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { linter, type Diagnostic } from "@codemirror/lint";
import type { Extension } from "@codemirror/state";
import { EditorView, hoverTooltip, type Tooltip } from "@codemirror/view";

// ── the backend seam ───────────────────────────────────────────────────────
// Structural twins of arrival-type-lens's Scheme* types (a devDep typecheck in
// __tests__ pins assignability so drift is caught at `pnpm typecheck`). Widened
// to MaybePromise: CodeMirror's lint/hover/completion sources all accept
// promises, so a worker backend is the same seam.

type MaybePromise<T> = T | Promise<T>;

/** A diagnostic in Scheme coordinates (mirrors arrival-type-lens `SchemeDiagnostic`). */
export interface SchemeIdeDiagnostic {
  start: number;
  length: number;
  severity: "error" | "warning" | "suggestion" | "message";
  /** The tsc diagnostic code, carried for telemetry/explainers. */
  code: number;
  messageText: string;
}

/** Hover info in Scheme coordinates (mirrors `SchemeQuickInfo`). */
export interface SchemeIdeQuickInfo {
  displayText: string;
  documentation: string;
  span: { start: number; length: number } | null;
}

/** One completion entry (mirrors `SchemeCompletionEntry`). */
export interface SchemeIdeCompletionEntry {
  name: string;
  /** A `ts.ScriptElementKind` string (`"function"`, `"var"`, `"property"`, …). */
  kind: string;
  sortText: string;
  insertText?: string;
}

/** A go-to-definition result (mirrors `SchemeDefinition`); `span: null` means
 *  the definition lands outside the buffer (a builtin's `.d.ts`). */
export interface SchemeIdeDefinition {
  name: string;
  kind: string;
  span: { start: number; length: number } | null;
}

/** What the IDE extensions need from a language service, in Scheme coordinates. */
export interface SchemeIdeBackend {
  getSemanticDiagnostics(scheme: string): MaybePromise<SchemeIdeDiagnostic[]>;
  getQuickInfoAtPosition(scheme: string, schemeOffset: number): MaybePromise<SchemeIdeQuickInfo | null>;
  getCompletionsAtPosition(scheme: string, schemeOffset: number): MaybePromise<SchemeIdeCompletionEntry[]>;
  getDefinitionAtPosition(scheme: string, schemeOffset: number): MaybePromise<SchemeIdeDefinition[]>;
}

// ── pure mappers (exported for tests) ──────────────────────────────────────

/** Lift backend diagnostics into `@codemirror/lint` shape, clamped to the doc. */
export function toCmDiagnostics(diags: readonly SchemeIdeDiagnostic[], docLength: number): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const d of diags) {
    const from = Math.max(0, Math.min(d.start, docLength));
    const to = Math.max(from, Math.min(d.start + d.length, docLength));
    out.push({
      from,
      to,
      severity: d.severity === "error" ? "error" : d.severity === "warning" ? "warning" : "info",
      message: d.messageText,
      source: `scheme-ts(${d.code})`,
    });
  }
  return out;
}

/** `ts.ScriptElementKind` → CodeMirror completion `type` (drives the icon). */
const COMPLETION_TYPE: Record<string, string> = {
  method: "method",
  function: "function",
  "local function": "function",
  var: "variable",
  "local var": "variable",
  let: "variable",
  const: "constant",
  property: "property",
  getter: "property",
  parameter: "variable",
  keyword: "keyword",
  module: "namespace",
  class: "class",
  interface: "interface",
  type: "type",
  enum: "enum",
  "enum member": "constant",
  alias: "variable",
};

/** Map backend completion entries into CodeMirror `Completion`s. */
export function toCmCompletions(entries: readonly SchemeIdeCompletionEntry[]): Completion[] {
  return entries.map((e) => ({
    label: e.name,
    type: COMPLETION_TYPE[e.kind] ?? "variable",
    ...(e.insertText === undefined ? {} : { apply: e.insertText }),
  }));
}

// ── extensions ─────────────────────────────────────────────────────────────

export interface SchemeLinterOptions {
  /** Debounce after the last edit before re-linting (ms). Default 600. */
  delay?: number;
}

/** Type-checked diagnostics: squiggles + the lint gutter/panel vocabulary. */
export function schemeLinter(backend: SchemeIdeBackend, options?: SchemeLinterOptions): Extension {
  return linter(
    async (view) =>
      toCmDiagnostics(await backend.getSemanticDiagnostics(view.state.doc.toString()), view.state.doc.length),
    { delay: options?.delay ?? 600 },
  );
}

/** Hover: the signature/inferred type + docs of the symbol under the pointer. */
export function schemeHover(backend: SchemeIdeBackend): Extension {
  return [
    hoverTooltip(async (view, pos): Promise<Tooltip | null> => {
      const info = await backend.getQuickInfoAtPosition(view.state.doc.toString(), pos);
      if (info === null || (info.displayText === "" && info.documentation === "")) return null;
      const from = info.span?.start ?? pos;
      const to = info.span === null ? pos : info.span.start + info.span.length;
      return {
        pos: from,
        end: to,
        create: () => {
          const dom = document.createElement("div");
          dom.className = "cm-scheme-quickinfo";
          if (info.displayText !== "") {
            const sig = document.createElement("code");
            sig.className = "cm-scheme-quickinfo-signature";
            sig.textContent = info.displayText;
            dom.append(sig);
          }
          if (info.documentation !== "") {
            const doc = document.createElement("div");
            doc.className = "cm-scheme-quickinfo-docs";
            doc.textContent = info.documentation;
            dom.append(doc);
          }
          return { dom };
        },
      };
    }),
    quickInfoTheme,
  ];
}

const quickInfoTheme = EditorView.baseTheme({
  ".cm-scheme-quickinfo": { maxWidth: "44em", padding: "4px 6px" },
  ".cm-scheme-quickinfo-signature": { whiteSpace: "pre-wrap", display: "block" },
  ".cm-scheme-quickinfo-docs": { whiteSpace: "pre-wrap", marginTop: "4px", opacity: "0.8" },
});

// A scheme symbol run before the cursor — the same atom-char class the sweet
// reader uses (scheme-sweet.ts SYMBOL_BODY), so `string-upcase`, `+`, `list->vec`
// complete as ONE token. A single character class under `*` cannot backtrack —
// the slow-regex flag is a false positive on the `$` anchor.
// eslint-disable-next-line sonarjs/slow-regex
const SYMBOL_BEFORE = /[\w\-!$%&*+./<=>?@^~]*$/;

/** The completion source alone — compose into your own `autocompletion()`. */
export function schemeCompletionSource(backend: SchemeIdeBackend): CompletionSource {
  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    const word = ctx.matchBefore(SYMBOL_BEFORE);
    if (word === null || (word.from === word.to && !ctx.explicit)) return null;
    const entries = await backend.getCompletionsAtPosition(ctx.state.doc.toString(), ctx.pos);
    if (entries.length === 0) return null;
    return { from: word.from, options: toCmCompletions(entries), validFor: SYMBOL_BEFORE };
  };
}

/** Completion wired as the editor's autocompletion (overrides other sources). */
export function schemeCompletion(backend: SchemeIdeBackend): Extension {
  return autocompletion({ override: [schemeCompletionSource(backend)] });
}

/** Cmd/Ctrl-click on a symbol jumps to its definition (in-buffer spans only —
 *  a builtin's definition lives in the prelude and has no buffer span). */
export function schemeGotoDefinition(backend: SchemeIdeBackend): Extension {
  return EditorView.domEventHandlers({
    mousedown: (event, view) => {
      if (!(event.metaKey || event.ctrlKey) || event.button !== 0) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos === null) return false;
      void (async () => {
        const defs = await backend.getDefinitionAtPosition(view.state.doc.toString(), pos);
        const span = defs.find((d) => d.span !== null)?.span;
        if (span === undefined || span === null) return;
        view.dispatch({
          selection: { anchor: span.start, head: span.start + span.length },
          scrollIntoView: true,
          userEvent: "select.definition",
        });
      })();
      return true; // claim the click — don't also move the caret mid-jump
    },
  });
}

export interface SchemeIdeOptions {
  lint?: boolean | SchemeLinterOptions;
  hover?: boolean;
  completion?: boolean;
  gotoDefinition?: boolean;
}

/** The IDE bundle: lint + hover + completion + go-to-definition (each opt-out). */
export function schemeIde(backend: SchemeIdeBackend, options?: SchemeIdeOptions): Extension {
  const ext: Extension[] = [];
  if (options?.lint !== false)
    ext.push(schemeLinter(backend, typeof options?.lint === "object" ? options.lint : undefined));
  if (options?.hover !== false) ext.push(schemeHover(backend));
  if (options?.completion !== false) ext.push(schemeCompletion(backend));
  if (options?.gotoDefinition !== false) ext.push(schemeGotoDefinition(backend));
  return ext;
}
