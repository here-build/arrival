// service-core — "Scheme LSP with the TS LSP API", environment-agnostic.
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
// This module is the ENVIRONMENT-AGNOSTIC core: it touches neither `node:fs`
// nor `ts.sys`, so it bundles for the browser. Where the prelude and the TS
// default lib come from is the `ServiceEnvironment` parameter — the Node entry
// (`language-service.ts`) reads them from disk; the browser entry (`browser.ts`)
// uses the build-time-generated bundles.
//
// v1 recreates the compilation per source (the program text changes every call,
// the prelude is constant). The prelude file map is built ONCE and reused; only
// the `__program.ts` snapshot + its version bump per source. An incremental host
// that diffs the program file is a later optimization (noted inline).

import { emitTypes } from "@here.build/arrival-chain-view";
import ts from "typescript";

import { Mapper } from "./span-map.js";
import { PROGRAM_FILE } from "./virtual-files.js";

/**
 * Balance an INCOMPLETE scheme prefix so it parses — for the cursor-position queries
 * (completion / quick-info), which by nature run on a mid-edit, usually-unbalanced prefix.
 * `emitTypes` requires a complete, parseable program (`parseSexprs` throws on an unclosed
 * paren → the whole emit degrades to an empty module → no span at the cursor → no completions).
 * Appending the missing close delimiters makes the prefix parse; the suffix is added at the END,
 * so every cursor offset within the original prefix maps unchanged. String / line-comment /
 * block-comment / char-literal aware, matching arrival's lexer (brackets `()[]` are
 * interchangeable on close, so a single `)` per open level suffices). The diagnostics path does
 * NOT balance — a genuinely malformed complete program should report its errors, not be repaired.
 */
/** Completion-cursor sentinel for the type-mask probe. Plain letters only: `emitTypes`'
 *  `cleanName` strips leading/trailing `_`, so an underscore-wrapped marker would not survive to
 *  be found in the emitted TS. Unlikely to collide with a real scheme symbol. */
const SENTINEL = "qzcursorzq";

function balancePrefix(scheme: string): string {
  let depth = 0;
  let inStr = false;
  let esc = false;
  let inLine = false;
  let block = 0;
  for (let i = 0; i < scheme.length; i++) {
    const c = scheme[i]!;
    if (inLine) {
      if (c === "\n") inLine = false;
      continue;
    }
    if (block > 0) {
      if (c === "#" && scheme[i + 1] === "|") {
        block++;
        i++;
      } else if (c === "|" && scheme[i + 1] === "#") {
        block--;
        i++;
      }
      continue;
    }
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === "#" && scheme[i + 1] === "\\") {
      i += 2;
      continue;
    } // char literal `#\(` — skip the next char
    if (c === '"') inStr = true;
    else if (c === ";") inLine = true;
    else if (c === "#" && scheme[i + 1] === "|") {
      block = 1;
      i++;
    } else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth = Math.max(0, depth - 1);
  }
  // An unterminated string can't be balanced into a valid token — close it too, then the parens.
  return scheme + (inStr ? '"' : "") + ")".repeat(depth);
}

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
  /**
   * Host-injected rosetta tools (sift's evidence tools), the seam that makes the type
   * mask narrow on injected symbols — not just the builtins. Two coupled parts, both
   * derived from ONE source (the env's `defineRosetta(name, { type })` registry, via
   * `assembleHostPrelude`):
   *   • `prelude` — ambient `.d.ts` text re-opening `interface ArrShape { "<name>": … }`
   *     (+ the host's entity types), merged into the same global scope as the builtin
   *     leaves. Makes `typeof __arr["<name>"]` resolve → the CANDIDATE side narrows.
   *   • `members` — the host member names. The emitter lowers a head in this set via
   *     `__arr["<name>"](…)` (like a builtin) so `Parameters<typeof head>` resolves →
   *     the SLOT side narrows (a host tool as the enclosing call head).
   */
  host?: { prelude: string; members: readonly string[] };
}

/**
 * Where the virtual compilation's NON-PROGRAM files come from — the seam between
 * the environment-agnostic core and the entry that knows the platform.
 */
export interface ServiceEnvironment {
  /** The prelude file map (PRE + builtin leaves) — the compilation's root files
   *  besides the program. The core adds `__host.d.ts` / `__program.ts` on top. */
  rootFiles: Map<string, string>;
  /** Lookup-only virtual files (the TS default-lib chain in the browser) — served
   *  to the compiler when it asks, but never offered as root files. */
  supportFiles?: ReadonlyMap<string, string>;
  /** Resolve the default-lib file name for the merged compiler options. Node:
   *  `ts.getDefaultLibFilePath`; browser: the bundled lib's virtual file name. */
  getDefaultLibFileName: (options: ts.CompilerOptions) => string;
  /** Optional real-fs fallback (Node: `ts.sys`) for files outside the maps —
   *  the on-disk default-lib chain. Absent in the browser: maps are everything. */
  sys?: Pick<ts.System, "readFile" | "fileExists" | "readDirectory" | "directoryExists" | "getDirectories">;
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
  /**
   * Layer T — the type-narrowed mask. Given the bound-symbol `candidates` valid at `schemeOffset`
   * (the sampler's Σ set), return the subset that is TYPE-VALID as the next token of the enclosing
   * call's current argument slot — i.e. a symbol whose value, or whose call's RETURN value, is
   * assignable to that parameter's type. The Σ∩T mask. When the cursor is NOT an argument of a
   * typed call (operator slot / top level / unknown callee), every candidate is returned (no
   * narrowing — Σ already constrains operators; T never *adds* a wrong restriction). A candidate
   * the type system can't resolve (a local binding, an injected tool without a declaration) is
   * kept — conservative: T only ever DROPS a provably ill-typed candidate, never a valid one.
   */
  getTypeValidCandidates(scheme: string, schemeOffset: number, candidates: readonly string[]): string[];
}

/**
 * Create a Scheme language service over an explicit {@link ServiceEnvironment}.
 * Reuses ONE prelude file map + ONE `LanguageServiceHost` whose only mutable cell
 * is the emitted `__program.ts` snapshot; each query emits fresh TS for its
 * `scheme` argument and bumps the program version so tsc re-checks it.
 * (Recreate-per-source is fine for v1; an incremental host that diffs the
 * program text is a later optimization.)
 */
export function createSchemeLanguageServiceCore(
  env: ServiceEnvironment,
  opts?: SchemeLanguageServiceOptions,
): SchemeLanguageService {
  const options: ts.CompilerOptions = { ...DEFAULT_OPTIONS, ...opts?.compilerOptions };
  const preludeFiles = env.rootFiles;
  const supportFiles = env.supportFiles ?? new Map<string, string>();
  // Host-injected leaf (sift's tool declarations) — merged into the same global ArrShape.
  if (opts?.host !== undefined) preludeFiles.set("__host.d.ts", opts.host.prelude);
  // The host member roster — heads in this set lower to `__arr[...]` so their slots narrow.
  const hostMembers: ReadonlySet<string> = new Set(opts?.host?.members);

  // Mutable program cell + version, bumped each time we set a new emitted module.
  let programText = "export {};\n";
  let programVersion = 0;

  const inMemory = (fn: string): string | undefined => preludeFiles.get(fn) ?? supportFiles.get(fn);

  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => [...preludeFiles.keys(), PROGRAM_FILE],
    getScriptVersion: (fn) => (fn === PROGRAM_FILE ? String(programVersion) : "1"),
    getScriptSnapshot: (fn) => {
      if (fn === PROGRAM_FILE) return ts.ScriptSnapshot.fromString(programText);
      const inMem = inMemory(fn);
      if (inMem !== undefined) return ts.ScriptSnapshot.fromString(inMem);
      try {
        const onDisk = env.sys?.readFile(fn);
        return onDisk === undefined ? undefined : ts.ScriptSnapshot.fromString(onDisk);
      } catch {
        return undefined;
      }
    },
    getCurrentDirectory: () => "/",
    getCompilationSettings: () => options,
    getDefaultLibFileName: (o) => env.getDefaultLibFileName(o),
    fileExists: (fn) => fn === PROGRAM_FILE || inMemory(fn) !== undefined || (env.sys?.fileExists(fn) ?? false),
    readFile: (fn) => {
      if (fn === PROGRAM_FILE) return programText;
      return inMemory(fn) ?? env.sys?.readFile(fn);
    },
    readDirectory: (path, extensions, exclude, include, depth) =>
      env.sys?.readDirectory(path, extensions, exclude, include, depth) ?? [],
    directoryExists: (dir) => env.sys?.directoryExists(dir) ?? false,
    getDirectories: (dir) => env.sys?.getDirectories(dir) ?? [],
  };

  const service = ts.createLanguageService(host, ts.createDocumentRegistry());

  /** Emit `scheme`, install it as the program module, and return a Mapper over the
   *  resulting span lens (the bidirectional coordinate bridge for this source). */
  function loadSource(scheme: string): Mapper {
    const { ts: emitted, mappings } = emitTypes(scheme, { hostMembers });
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
      const mapper = loadSource(balancePrefix(scheme)); // cursor query → balance the mid-edit prefix
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
      // The prefix is mid-edit (usually unbalanced) — balance it so it parses; the cursor
      // offset is unchanged (closers append at the end).
      const mapper = loadSource(balancePrefix(scheme));
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

    getTypeValidCandidates(scheme, schemeOffset, candidates): string[] {
      const cands = [...candidates];
      if (cands.length === 0) return cands;
      // 1. Locate the enclosing call's argument slot at the cursor. Insert the clean-name-proof
      //    sentinel at the cursor, balance, emit.
      const sentinelScheme = balancePrefix(
        `${scheme.slice(0, schemeOffset)} ${SENTINEL} ${scheme.slice(schemeOffset)}`,
      );
      const slot = findCallSlot(sentinelScheme);
      if (slot === null) return cands; // not a typed-call argument slot → no T narrowing
      // 2. Batched conditional-type probe → per-candidate verdict in one checker read.
      const verdict = probeTypes(slot.calleeText, slot.argIndex, cands);
      // 3. Keep iff PROVEN valid (true) OR unresolved (null) — never drop on uncertainty.
      return cands.filter((_, i) => verdict[i] !== false);
    },
  };

  /** Emit the sentinel'd scheme, then walk the TS AST to the CallExpression whose ARGUMENTS
   *  contain the sentinel → its callee text + the argument index the sentinel occupies. Null when
   *  the sentinel is not an argument of a call (operator slot / top level / not found). */
  function findCallSlot(sentinelScheme: string): { calleeText: string; argIndex: number } | null {
    loadSource(sentinelScheme);
    const program = service.getProgram();
    const sf = program?.getSourceFile(PROGRAM_FILE);
    if (!sf) return null;
    let found: { calleeText: string; argIndex: number } | null = null;
    const visit = (node: ts.Node): void => {
      if (found) return;
      if (ts.isIdentifier(node) && node.text === SENTINEL) {
        const s = node.getStart(sf);
        const e = node.getEnd();
        for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
          if (ts.isCallExpression(p)) {
            const argIndex = p.arguments.findIndex((a) => a.getStart(sf) <= s && e <= a.end);
            if (argIndex !== -1) {
              found = { calleeText: p.expression.getText(sf), argIndex };
              return;
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return found;
  }

  /** Load a probe module and read, per candidate, whether it is type-valid in the given call slot.
   *  `true` = proven assignable, `false` = proven not, `null` = unresolved (kept by the caller).
   *  ONE program load + ONE checker read for the whole candidate list. */
  function probeTypes(calleeText: string, argIndex: number, candidates: string[]): (boolean | null)[] {
    // `__ok<T>`: T fits the slot iff it IS the param type, OR it is a function whose RETURN type is
    // (the next token at an arg slot is usually a sub-call's operator). `[x]`-tuple wrapping defeats
    // union distribution. An unresolvable `typeof __arr[name]` is `any` ⇒ both branches `true` ⇒ kept.
    const okT =
      `type __ok<T> = (([T] extends [(...a: any[]) => infer R] ? ([R] extends [__E] ? true : false) : false) extends true ? true ` +
      `: ([T] extends [__E] ? true : false));`;
    const entry = (name: string) => `__ok<typeof __arr[${JSON.stringify(name)}]>`;
    programText = [
      "__arr;", // force the ambient `__arr` into scope
      `type __E = Parameters<typeof ${calleeText}>[${argIndex}];`,
      okT,
      `declare const __probe: [${candidates.map(entry).join(", ")}];`,
      "export {};",
    ].join("\n");
    programVersion += 1;
    const program = service.getProgram();
    const sf = program?.getSourceFile(PROGRAM_FILE);
    if (!sf || !program) return candidates.map(() => null);
    const checker = program.getTypeChecker();
    let probeNode: ts.Node | null = null;
    const find = (n: ts.Node): void => {
      if (probeNode) return;
      if (ts.isIdentifier(n) && n.text === "__probe" && ts.isVariableDeclaration(n.parent)) probeNode = n;
      else ts.forEachChild(n, find);
    };
    find(sf);
    if (!probeNode) return candidates.map(() => null);
    // Resolved tuple text, e.g. "[true, false, true, …]". A malformed probe → the alias name (no
    // brackets) → all null. `__E` unresolved (any) → all true.
    const text = checker.typeToString(checker.getTypeAtLocation(probeNode), undefined, ts.TypeFormatFlags.InTypeAlias);
    const m = text.match(/^\[(.*)\]$/s);
    if (!m) return candidates.map(() => null);
    const flags = m[1]!.split(",").map((s) => s.trim());
    return candidates.map((_, i) => (flags[i] === "true" ? true : flags[i] === "false" ? false : null));
  }
}
