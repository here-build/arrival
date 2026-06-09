// language-service — "Scheme LSP with the TS LSP API".
//
// A language service that MIRRORS `ts.LanguageService` but operates on Scheme
// source and Scheme positions. Internally it:
//   1. emits type-faithful virtual TS from the Scheme (`emitTypes`),
//   2. type-checks that TS against the shared PRE prelude + builtin leaves through
//      a single in-memory `ts.LanguageService`,
//   3. maps coordinates across the span lens (`Mapper`) — diagnostics OUT to
//      Scheme, cursor positions IN to TS.
//
// The method SHAPES mirror what `@codemirror/lint`, `hoverTooltip`, and
// `autocompletion` consume, so a CodeMirror extension wires straight onto them
// (see `language-service.test.ts` for the 5-line `@codemirror/lint` adapter).
//
// v1 recreates the compilation per source (the program text changes every call,
// the prelude is constant). The prelude file map is built ONCE and reused; only
// the `__program.ts` snapshot + its version bump per source. An incremental host
// that diffs the program file is a later optimization (noted inline).

import { emitTypes } from "@here.build/arrival-chain-view";
import ts from "typescript";

import { getPreludeFiles, PROGRAM_FILE } from "./prelude.js";
import { Mapper } from "./span-map.js";

/** A diagnostic in SCHEME coordinates (the lift-out result). Shape mirrors the
 *  fields `@codemirror/lint`'s `Diagnostic` and LSP's `Diagnostic` both need. */
export interface SchemeDiagnostic {
  /** Offset into the Scheme source where the diagnostic starts. */
  start: number;
  /** Length of the Scheme span the diagnostic covers. */
  length: number;
  /** 0-based line of `start` in the Scheme source. */
  line: number;
  /** 0-based column of `start` in the Scheme source. */
  character: number;
  /** `"error" | "warning" | "suggestion" | "message"` — LSP/CodeMirror severities. */
  severity: "error" | "warning" | "suggestion" | "message";
  /** The tsc diagnostic code (e.g. 2345), carried through for telemetry/explainers. */
  code: number;
  /** The flattened diagnostic message. */
  messageText: string;
}

/** Hover info in Scheme coordinates. */
export interface SchemeQuickInfo {
  /** The rendered type/signature string (the hover body). */
  displayText: string;
  /** The documentation/JSDoc string, if any. */
  documentation: string;
  /** The Scheme span the hover applies to (lifted from the TS textSpan). */
  span: { start: number; length: number } | null;
}

/** One completion entry (name + kind), mirroring `ts.CompletionEntry`'s essentials. */
export interface SchemeCompletionEntry {
  name: string;
  /** The `ts.ScriptElementKind` string (`"method"`, `"function"`, `"property"`…). */
  kind: string;
  /** The sort key tsc assigned (preserves the service's ranking). */
  sortText: string;
  insertText?: string;
}

/** A go-to-definition result in Scheme coordinates. */
export interface SchemeDefinition {
  /** The defined symbol's name. */
  name: string;
  /** The `ts.ScriptElementKind` string. */
  kind: string;
  /** The Scheme span of the definition (lifted), or `null` if it lands in the
   *  prelude/infrastructure (a builtin's `.d.ts` has no Scheme source). */
  span: { start: number; length: number } | null;
}

export interface SchemeLanguageServiceOptions {
  /** Override the tsc compiler options used for the virtual compilation. */
  compilerOptions?: ts.CompilerOptions;
}

const DEFAULT_OPTIONS: ts.CompilerOptions = {
  noEmit: true,
  strict: true,
  target: ts.ScriptTarget.ES2022,
  lib: ["lib.es2022.d.ts"],
  types: [],
  skipLibCheck: false,
};

/** Map a tsc `DiagnosticCategory` to the LSP/CodeMirror severity vocabulary. */
function severityOf(category: ts.DiagnosticCategory): SchemeDiagnostic["severity"] {
  switch (category) {
    case ts.DiagnosticCategory.Error:
      return "error";
    case ts.DiagnosticCategory.Warning:
      return "warning";
    case ts.DiagnosticCategory.Suggestion:
      return "suggestion";
    default:
      return "message";
  }
}

/** The object a `createSchemeLanguageService` returns — its methods mirror the
 *  `ts.LanguageService` ones they delegate to, but in Scheme coordinates. */
export interface SchemeLanguageService {
  getSemanticDiagnostics(scheme: string): SchemeDiagnostic[];
  getQuickInfoAtPosition(scheme: string, schemeOffset: number): SchemeQuickInfo | null;
  getCompletionsAtPosition(scheme: string, schemeOffset: number): SchemeCompletionEntry[];
  getDefinitionAtPosition(scheme: string, schemeOffset: number): SchemeDefinition[];
}

/**
 * Create a Scheme language service. Reuses ONE prelude file map + ONE
 * `LanguageServiceHost` whose only mutable cell is the emitted `__program.ts`
 * snapshot; each query emits fresh TS for its `scheme` argument and bumps the
 * program version so tsc re-checks it. (Recreate-per-source is fine for v1; an
 * incremental host that diffs the program text is a later optimization.)
 */
export function createSchemeLanguageService(opts?: SchemeLanguageServiceOptions): SchemeLanguageService {
  const options: ts.CompilerOptions = { ...DEFAULT_OPTIONS, ...opts?.compilerOptions };
  const preludeFiles = getPreludeFiles();

  // Mutable program cell + version, bumped each time we set a new emitted module.
  let programText = "export {};\n";
  let programVersion = 0;

  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => [...preludeFiles.keys(), PROGRAM_FILE],
    getScriptVersion: (fn) => (fn === PROGRAM_FILE ? String(programVersion) : "1"),
    getScriptSnapshot: (fn) => {
      if (fn === PROGRAM_FILE) return ts.ScriptSnapshot.fromString(programText);
      const inMem = preludeFiles.get(fn);
      if (inMem !== undefined) return ts.ScriptSnapshot.fromString(inMem);
      try {
        return ts.ScriptSnapshot.fromString(ts.sys.readFile(fn) ?? "");
      } catch {
        return undefined;
      }
    },
    getCurrentDirectory: () => "/",
    getCompilationSettings: () => options,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: (fn) => fn === PROGRAM_FILE || preludeFiles.has(fn) || ts.sys.fileExists(fn),
    readFile: (fn) => {
      if (fn === PROGRAM_FILE) return programText;
      return preludeFiles.has(fn) ? preludeFiles.get(fn) : ts.sys.readFile(fn);
    },
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };

  const service = ts.createLanguageService(host, ts.createDocumentRegistry());

  /** Emit `scheme`, install it as the program module, and return a Mapper over the
   *  resulting span lens (the bidirectional coordinate bridge for this source). */
  function loadSource(scheme: string): Mapper {
    const { ts: emitted, mappings } = emitTypes(scheme);
    programText = emitted;
    programVersion += 1;
    return new Mapper(mappings, scheme, emitted);
  }

  return {
    getSemanticDiagnostics(scheme): SchemeDiagnostic[] {
      const mapper = loadSource(scheme);
      const out: SchemeDiagnostic[] = [];
      for (const d of service.getSemanticDiagnostics(PROGRAM_FILE)) {
        if (d.start === undefined) continue;
        // Lift the TS diagnostic span OUT to Scheme. Drop diagnostics that don't
        // lift (unmapped prelude/infrastructure spans) — never surface a
        // wrong-positioned error.
        const span = mapper.toScheme(d.start);
        if (span === null) continue;
        const { line, character } = mapper.schemeOffsetToLineCol(span.start);
        out.push({
          start: span.start,
          length: span.length,
          line,
          character,
          severity: severityOf(d.category),
          code: d.code,
          messageText: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
        });
      }
      return out;
    },

    getQuickInfoAtPosition(scheme, schemeOffset): SchemeQuickInfo | null {
      const mapper = loadSource(scheme);
      const tsOffset = mapper.toTs(schemeOffset);
      if (tsOffset === null) return null;
      const info = service.getQuickInfoAtPosition(PROGRAM_FILE, tsOffset);
      if (info === undefined) return null;
      return {
        displayText: ts.displayPartsToString(info.displayParts),
        documentation: ts.displayPartsToString(info.documentation),
        span: mapper.toScheme(info.textSpan.start),
      };
    },

    getCompletionsAtPosition(scheme, schemeOffset): SchemeCompletionEntry[] {
      const mapper = loadSource(scheme);
      const tsOffset = mapper.toTs(schemeOffset);
      if (tsOffset === null) return [];
      const completions = service.getCompletionsAtPosition(PROGRAM_FILE, tsOffset, undefined);
      if (completions === undefined) return [];
      return completions.entries.map((e) => ({
        name: e.name,
        kind: e.kind,
        sortText: e.sortText,
        ...(e.insertText === undefined ? {} : { insertText: e.insertText }),
      }));
    },

    getDefinitionAtPosition(scheme, schemeOffset): SchemeDefinition[] {
      const mapper = loadSource(scheme);
      const tsOffset = mapper.toTs(schemeOffset);
      if (tsOffset === null) return [];
      const defs = service.getDefinitionAtPosition(PROGRAM_FILE, tsOffset);
      if (defs === undefined) return [];
      const out: SchemeDefinition[] = [];
      for (const d of defs) {
        // Only definitions that land in the PROGRAM file have a Scheme span; a
        // builtin's `.d.ts` definition lifts to `null` (no Scheme source).
        const span = d.fileName === PROGRAM_FILE ? mapper.toScheme(d.textSpan.start) : null;
        out.push({ name: d.name, kind: d.kind, span });
      }
      return out;
    },
  };
}
