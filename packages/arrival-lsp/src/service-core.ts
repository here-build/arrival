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

// The runtime-free reader (spans on every node) — the require scanner's truth.
import { emitTypes } from "@here.build/arrival-chain-view/types-emit";
import { parseSexprs, type Node } from "@here.build/arrival-sweet";
// The deep subpath (not the package index): the index re-exports `formatJs`,
// whose `eslint` import would drag the whole linter into any browser bundle of
// this service. `types-emit`'s closure is the pure front-end only.
import ts from "typescript";

import { balancePrefix, stringLiteralType } from "./balance.js";
import { Mapper } from "./span-map.js";
import { PROGRAM_FILE } from "./virtual-files.js";

// balancePrefix moved to balance.ts (the tsgo browser worker imports it
// without dragging `typescript` into its chunk); re-exported for consumers.
export { balancePrefix } from "./balance.js";

/** Completion-cursor sentinel for the type-mask probe. Plain letters only: `emitTypes`'
 *  `cleanName` strips leading/trailing `_`, so an underscore-wrapped marker would not survive to
 *  be found in the emitted TS. Unlikely to collide with a real scheme symbol. */
const SENTINEL = "qzcursorzq";

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

/** One rich completion entry — `SchemeCompletionEntry` plus what the type
 *  system knows about the candidate AT THIS CURSOR. */
export interface SchemeRichCompletion extends SchemeCompletionEntry {
  /** The candidate's type signature one-liner (`(xs: List<T>) => T`), when the
   *  checker can name it. Builtins always have one; locals usually do. */
  detail?: string;
  /** Slot verdict at an argument position — the sampler's Σ∩T mask, surfaced:
   *  `true` = proven to fit the parameter, `false` = proven NOT to fit,
   *  `undefined` = unknown / not at an argument slot. */
  fits?: boolean;
  /** True iff the candidate is callable (a function-typed value) — drives
   *  operator-position ranking (Σ's "callables only at the head" filter). */
  callable?: boolean;
}

/** The full completion answer for a cursor: entries + where the cursor IS. */
export interface SchemeCompletionContext {
  /** Σ-style cursor position: head of a form / argument of a call / top level. */
  position: "operator" | "argument" | "top";
  /** At an argument slot: the enclosing call + which parameter the cursor
   *  fills, with the parameter's type rendered (`xs: List<number>`). */
  slot?: { callee: string; argIndex: number; paramType?: string };
  entries: SchemeRichCompletion[];
}

/** A semantically-classified token span in Scheme coordinates — what an
 *  identifier IS (its role per the type checker), for semantic highlighting. */
export interface SchemeClassifiedSpan {
  start: number;
  length: number;
  /** The tsc 2020-format token type: `"parameter"`, `"variable"`, `"function"`,
   *  `"property"`, `"class"`, `"interface"`, `"type"`, `"typeParameter"`, … */
  kind: string;
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
  /** Present when the definition lives in a REQUIRED file: the require-path of
   *  that file (the span is in THAT file's coordinates). Absent = this buffer. */
  file?: string;
}

export interface SchemeLanguageServiceOptions {
  /** Override the tsc compiler options used for the virtual compilation. */
  compilerOptions?: ts.CompilerOptions;
  /**
   * `(require "path")` resolution — THE seam that keeps the lens filesystem-
   * blind (it runs in workers, browsers, tests): given the require string
   * verbatim, return that file's SOURCE, or null when unknown. When present,
   * the whole require closure (recursively, cycle-safe) is emitted AHEAD of
   * the program in the same virtual module — scheme's load-into-scope
   * semantics — so required defines resolve, type-flow, complete, and
   * goto-def across files. Absent → requires stay no-ops (soft suggestions).
   */
  resolveModule?: (path: string) => string | null;
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
  /**
   * The scheme STDLIB preamble source (arrival's `BUILTIN_PREAMBLE`) — the
   * `(define …)` helpers that are themselves written in scheme (`field`,
   * `values-of`, `keys-of`, `entries-of`, `take`, `drop`, `count-if`,
   * `infer/chat/*`, `s/*`, and the `define/overridable` family). These are NOT
   * rosettas (no native impl, no `.d.ts` leaf) — they are scheme source that the
   * runtime always loads ahead of the user's program. The lens emits this source
   * into the SAME virtual module ahead of the require closure (an implicit,
   * always-present dependency) so its defines resolve, type-flow, and complete
   * exactly like a required file's. DERIVED from the one source of truth — never
   * restated as hand-written leaves. Absent → those names read as unresolved.
   */
  schemePrelude?: string;
  /**
   * `(require "data.json")` → granular SHAPE — the editor twin of the runtime
   * loader registry. Given a `(require)`d path verbatim, return the TS type the
   * lens should give that require (in the lens vocabulary: `SStr`/`SNum`/
   * `List<…>`/object literals), or null when the path has no static shape (a
   * `.scm` library, an opaque blob). DERIVED host-side from the SAME loader
   * registry the runtime parses with (`resolveRequireType` over the kernel
   * loader), so a custom extension's `type` provider reaches the editor too.
   *
   * For each require path that yields a non-null shape, the lens emits a
   * `declare global { interface ArrShape { require(specifier: "<path>"): <T>; } }`
   * string-literal overload — TS hoists it ahead of the general
   * `(specifier: SStr): unknown` so `(require "data.json")` resolves to the
   * precise shape instead of `unknown`. A path with a shape is ALSO skipped as a
   * scheme dependency (it is data, not loadable forms). Absent → every require
   * stays `unknown` (today's behavior). */
  resolveRequireType?: (path: string) => string | null;
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

// tsc's 2020-format semantic token types, by index (the encoding packs
// `(tokenType + 1) << 8`, so decode with `(classification >> 8) - 1`).
const TOKEN_TYPES = [
  "class",
  "enum",
  "interface",
  "namespace",
  "typeParameter",
  "type",
  "parameter",
  "variable",
  "enumMember",
  "property",
  "function",
  "member",
] as const;

// A single scheme atom (one symbol token) — the lift-faithfulness gate for
// semantic classifications. Same character class as the sweet reader's atoms.
const SCHEME_ATOM = /^[\w\-!$%&*+./<=>?@^~:]+$/;

/** One `(require "path")` occurrence: the path + the form's span (the anchor
 *  for per-file summary diagnostics). */
export interface RequireRef {
  path: string;
  span: { start: number; length: number };
}

/** Scan a source's top-level forms for `(require "…")` — via the real reader
 *  (string/comment-safe), spans included. Unparseable source → []. */
export function scanRequires(scheme: string): RequireRef[] {
  let forest: Node[];
  try {
    forest = parseSexprs(scheme);
  } catch {
    return [];
  }
  const out: RequireRef[] = [];
  for (const form of forest) {
    if (!("list" in form) || form.span === undefined) continue;
    const [head, arg] = form.list;
    if (head === undefined || !("atom" in head) || head.atom !== "require") continue;
    if (arg === undefined || !("atom" in arg) || arg.str !== true) continue;
    out.push({ path: arg.atom, span: { start: form.span[0], length: form.span[1] - form.span[0] } });
  }
  return out;
}

/** Every `(require "literal")` path ANYWHERE in the tree — value-position
 *  (`(define x (require "data.json"))`) included, not just statement-position.
 *  `scanRequires` finds the top-level load-into-scope requires (the `.scm` dep
 *  closure); this finds the data-file requires whose VALUE is bound, so the lens
 *  can give each its precise shape. Deduped, order-preserving. */
export function scanAllRequirePaths(scheme: string): string[] {
  let forest: Node[];
  try {
    forest = parseSexprs(scheme);
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const visit = (node: Node): void => {
    if (!("list" in node)) return;
    const [head, arg] = node.list;
    if (head !== undefined && "atom" in head && head.atom === "require" && arg !== undefined && "atom" in arg && arg.str === true) {
      seen.add(arg.atom);
    }
    for (const child of node.list) visit(child);
  };
  for (const form of forest) visit(form);
  return [...seen];
}

/** Scheme-legal forms tsc rejects: redefinition is allowed in scheme — both
 *  `(define x 1) (define x 2)` in one file AND a program define shadowing a
 *  required one — but the flat `const` emit makes tsc cry 2451/2300. */
const SCHEME_LEGAL_TS_CODES = new Set([2451 /* Cannot redeclare */, 2300 /* Duplicate identifier */]);

/** Collect the rendered types a parameter's USE SITES expect inside `body`
 *  (checker.getContextualType per occurrence). Inner arrows re-binding the
 *  name shadow it (skipped). `null` = blocked: a site demanded a type the
 *  annotation gate rejects — conflicting/unprintable evidence, do not annotate. */
function expectedTypesOf(name: string, body: ts.Node, checker: ts.TypeChecker): Set<string> | null {
  const expected = new Set<string>();
  let blocked = false;
  const walk = (n: ts.Node): void => {
    if (blocked) return;
    // An inner arrow re-binding the name shadows it — stop descending.
    if (ts.isArrowFunction(n) && n.parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === name)) return;
    if (ts.isIdentifier(n) && n.text === name) {
      const t = checker.getContextualType(n);
      if (t !== undefined) {
        const rendered = checker.typeToString(t);
        if (annotatableType(rendered)) expected.add(rendered);
        else if (rendered !== "any" && rendered !== "unknown") blocked = true;
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(body);
  return blocked ? null : expected;
}

/** The rendered-type gate for inferred annotations: reject the unknowable and
 *  the unprintable (an annotation must round-trip through the ambient
 *  prelude's vocabulary). */
function annotatableType(rendered: string): boolean {
  if (rendered === "any" || rendered === "unknown" || rendered === "never") return false;
  if (rendered.length > 60 || rendered.includes("qzcursorzq") || rendered.includes("__")) return false;
  return true;
}

// An atom character (arrival's lexer: not whitespace/bracket/string/quote/comment) —
// the same class the sampler's typed-scanner uses for partial-atom stripping.
const ATOM_CHAR = /[^\s()[\]{}"';]/;

/** The bounds of the atom containing `offset` (both edges = `offset` when the
 *  cursor sits on whitespace/structure — nothing to strip). */
function atomBoundsAt(scheme: string, offset: number): [number, number] {
  let start = offset;
  while (start > 0 && ATOM_CHAR.test(scheme[start - 1]!)) start--;
  let end = offset;
  while (end < scheme.length && ATOM_CHAR.test(scheme[end]!)) end++;
  return [start, end];
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
  /**
   * The LOOP-CLOSING completion: the same Σ∩T machinery that masks the
   * sampler's logits (position discrimination + slot-fit probing), surfaced
   * for a human. One call returns everything a rich completion UI needs —
   * entries with signatures + per-candidate slot verdicts + the cursor's
   * position and expected parameter type.
   */
  getCompletionContext(scheme: string, schemeOffset: number): SchemeCompletionContext;
  getDefinitionAtPosition(scheme: string, schemeOffset: number): SchemeDefinition[];
  /**
   * Semantic token classifications in Scheme coordinates — the merge layer over
   * lexical highlighting: an editor keeps the grammar's keyword/string/paren
   * colors and lays the checker's KNOWLEDGE (this is a parameter / a local / a
   * function) on top. Only token-faithful lifts are returned: a TS token whose
   * span lifts to a single scheme ATOM (use-sites). Binder occurrences lift to
   * whole forms under the current emitter mappings and are dropped — the
   * lexical layer already paints binders (definitionKeyword/DEFNAME).
   */
  getSemanticClassifications(scheme: string): SchemeClassifiedSpan[];
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
  // The emitter's member roster — a head in this set lowers to `__arr[…]` so its
  // signature bites and its slots narrow. DERIVED, not listed: the merged
  // ArrShape itself (prelude leaves + host leaf, read back off the checker via
  // the `__arr[""]` probe) is the single source of truth. Authoring a new
  // builtins/ leaf is the ONLY step to teach both the emitter and completions a
  // name; a hand-kept roster here would be a third list drifting against the
  // leaves and chain-view's projection stdlib. Lazy: the probe needs `service`.
  let memberRoster: ReadonlySet<string> | null = null;
  const emitterMembers = (): ReadonlySet<string> => {
    memberRoster ??= new Set([...builtinCompletions().map((e) => e.name), ...(opts?.host?.members ?? [])]);
    return memberRoster;
  };

  // The scheme stdlib preamble, emitted ONCE to TS and cached — it's constant
  // for the service's lifetime. Sits at the very front of every program module
  // (ahead of the require closure) as an implicit, always-present dependency, so
  // its `(define …)` helpers resolve in program scope. Its own internal spans are
  // unmapped (no Mapper), so any diagnostic inside it is dropped on lift-out.
  let schemePreludeTs: string | null = null;
  const emittedSchemePrelude = (): string => {
    if (schemePreludeTs === null) {
      schemePreludeTs =
        opts?.schemePrelude === undefined
          ? ""
          : emitTypes(opts.schemePrelude, { hostMembers: emitterMembers() }).ts.replace(/export \{\};\n$/, "");
    }
    return schemePreludeTs;
  };

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

  // Completion-vocabulary caches (lazy, constant for the service's lifetime —
  // all depend only on the prelude + host, never on the program).
  let baselineNames: Set<string> | null = null;
  let builtinEntries: SchemeCompletionEntry[] | null = null;
  let builtinSigs: Map<string, string> | null = null;

  /** One emitted unit of the require closure: a required file's TS segment in
   *  the concatenated module, with its OWN mapper (its scheme coordinates). */
  interface DepUnit {
    path: string;
    /** [base, base+length) — the unit's TS segment in the program module. */
    base: number;
    length: number;
    mapper: Mapper;
  }

  /** The most recent loadSource's require closure (parallel to the program
   *  mapper the caller got back) — consumed by diagnostics (per-file error
   *  summaries) and definitions (cross-file lifts). */
  let depUnits: DepUnit[] = [];
  let programRequires: RequireRef[] = [];

  /**
   * Emit `scheme` — WITH its require closure when `resolveModule` is present —
   * install the concatenation as the program module, run USAGE-BASED PARAMETER
   * INFERENCE over it (inferParamInsertions: V's "infer from consumers"), and
   * return a Mapper over the PROGRAM's segment. Required files keep their own
   * mappers in `depUnits`. Closure order is dependencies-first (post-order
   * DFS, visited-set cycle-safe), matching scheme's load semantics; a dep's
   * trailing `export {};` is stripped (one module, one export statement).
   */
  function loadSource(scheme: string): Mapper {
    const resolve = opts?.resolveModule;
    const resolveReqType = opts?.resolveRequireType;
    // Requires are walked when EITHER seam is present: `resolveModule` emits
    // `.scm` deps into scope, `resolveRequireType` emits data-file overloads.
    programRequires = resolve === undefined && resolveReqType === undefined ? [] : scanRequires(scheme);
    // `(require "data.json")` overloads, collected during the dep walk (a data
    // path is an overload, NOT a scheme dep — see emitDep). Prepended to the
    // module as a `declare global` augmentation so they merge into ArrShape.
    const requireOverloads: string[] = [];
    // 1. Emit every unit (deps first), tracking raw segments + LOCAL mappings.
    interface RawUnit {
      path: string;
      base: number;
      length: number;
      source: string;
      localMappings: { tsStart: number; tsLength: number; schemeStart: number; schemeLength: number }[];
    }
    const rawDeps: RawUnit[] = [];
    // The scheme stdlib preamble leads the module — an implicit dependency ahead
    // of the require closure. Untracked in rawDeps: it has no Scheme mapper, so
    // its defines are in scope but its own spans never lift to a diagnostic.
    let prefix = emittedSchemePrelude();
    // Data-file requires resolve to a shape (overload), scheme requires load into
    // scope (dep). A path is a data file iff the registry yields a type for it.
    // Collected over the WHOLE tree (value-position `(define x (require …))`
    // included), deduped, so each `(require "data.json")` gets its precise shape.
    const dataReqTypes = new Map<string, string>();
    const collectDataReqs = (source: string): void => {
      if (resolveReqType === undefined) return;
      for (const path of scanAllRequirePaths(source)) {
        if (dataReqTypes.has(path)) continue;
        const reqType = resolveReqType(path);
        if (reqType !== null) dataReqTypes.set(path, reqType);
      }
    };
    collectDataReqs(scheme);
    if (programRequires.length > 0) {
      const visited = new Set<string>();
      const emitDep = (path: string): void => {
        if (visited.has(path)) return;
        visited.add(path);
        // A data file (registry yields a shape) is an OVERLOAD, not a scheme
        // dep — emitting its source as scheme would parse JSON/YAML as forms and
        // bind nothing. Its overload is collected by collectDataReqs; stop here.
        if (dataReqTypes.has(path) || (resolveReqType?.(path) ?? null) !== null) return;
        if (resolve === undefined) return;
        const source = resolve(path);
        if (source === null) return;
        collectDataReqs(source);
        for (const nested of scanRequires(source)) emitDep(nested.path);
        const dep = emitTypes(source, { hostMembers: emitterMembers() });
        const text = dep.ts.replace(/export \{\};\n$/, "");
        rawDeps.push({ path, base: prefix.length, length: text.length, source, localMappings: dep.mappings });
        prefix += text;
      };
      for (const r of programRequires) emitDep(r.path);
    }
    for (const [path, reqType] of dataReqTypes) {
      requireOverloads.push(`require(specifier: ${JSON.stringify(path)}): ${reqType};`);
    }
    // The string-literal `require` overloads merge into the global ArrShape via
    // `declare global` (the program is a module, so a bare `interface ArrShape`
    // would be module-local). TS hoists these specialized overloads ahead of the
    // general `(specifier: SStr): unknown`, so each `(require "data.json")`
    // resolves to its precise shape. Unmapped (ambient) — never lifts a span.
    if (requireOverloads.length > 0) {
      prefix += `declare global { interface ArrShape {\n${requireOverloads.map((o) => `  ${o}`).join("\n")}\n} }\n`;
    }
    const { ts: emitted, mappings } = emitTypes(scheme, { hostMembers: emitterMembers() });
    const programBase = prefix.length;
    programText = prefix + emitted;
    programVersion += 1;

    // 2. Parameter inference: each unannotated arrow param's USE SITES are
    //    asked (checker.getContextualType) what they expect; unanimous →
    //    `: T` injected at the param. Then every coordinate system shifts:
    //    an insertion at p moves positions ≥ p and widens spans containing p.
    const insertions = inferParamInsertions();
    let programMappings: { tsStart: number; tsLength: number; schemeStart: number; schemeLength: number }[];
    if (insertions.length > 0) {
      let next = "";
      let at = 0;
      for (const ins of insertions) {
        next += programText.slice(at, ins.pos) + ins.text;
        at = ins.pos;
      }
      programText = next + programText.slice(at);
      programVersion += 1;
      const shiftAt = (p: number): number =>
        p + insertions.reduce((s, ins) => s + (ins.pos <= p ? ins.text.length : 0), 0);
      const widen = (start: number, len: number): number =>
        len + insertions.reduce((s, ins) => s + (ins.pos > start && ins.pos < start + len ? ins.text.length : 0), 0);
      for (const u of rawDeps) {
        const newBase = shiftAt(u.base);
        u.localMappings = u.localMappings.map((m) => ({
          ...m,
          tsLength: widen(u.base + m.tsStart, m.tsLength),
          tsStart: shiftAt(u.base + m.tsStart) - newBase,
        }));
        u.length = shiftAt(u.base + u.length) - newBase;
        u.base = newBase;
      }
      programMappings = mappings.map((m) => ({
        ...m,
        tsLength: widen(programBase + m.tsStart, m.tsLength),
        tsStart: shiftAt(programBase + m.tsStart),
      }));
    } else {
      programMappings = mappings.map((m) => ({ ...m, tsStart: m.tsStart + programBase }));
    }

    // 3. Mappers over the FINAL text.
    depUnits = rawDeps.map((u) => ({
      path: u.path,
      base: u.base,
      length: u.length,
      mapper: new Mapper(u.localMappings, u.source, programText.slice(u.base, u.base + u.length)),
    }));
    return new Mapper(programMappings, scheme, programText);
  }

  /** V's "infer from consumers": for every UNANNOTATED arrow parameter in the
   *  current program module, collect what its use sites EXPECT
   *  (checker.getContextualType — `(string-append str1 …)` expects SStr at
   *  str1's slot) and, when all sites agree on one rendered type, produce a
   *  `: T` insertion at the parameter. Shadowed inner re-bindings are skipped;
   *  conflicting or unknowable sites leave the param unannotated (the
   *  conservative degrade — never a wrong annotation, TS generics can't do
   *  this at all: they infer at call sites, never from bodies). */
  function inferParamInsertions(): { pos: number; text: string }[] {
    const program = service.getProgram();
    const sf = program?.getSourceFile(PROGRAM_FILE);
    if (!sf || !program) return [];
    const checker = program.getTypeChecker();
    const insertions: { pos: number; text: string }[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isArrowFunction(node)) {
        for (const param of node.parameters) {
          if (param.type !== undefined || !ts.isIdentifier(param.name)) continue;
          const expected = expectedTypesOf(param.name.text, node.body, checker);
          if (expected !== null && expected.size === 1) {
            insertions.push({ pos: param.name.end, text: `: ${[...expected][0]!}` });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return insertions.toSorted((a, b) => a.pos - b.pos);
  }

  /** The dep unit containing a TS offset of the concatenated module, if any. */
  function depAt(tsOffset: number): DepUnit | null {
    for (const u of depUnits) if (tsOffset >= u.base && tsOffset < u.base + u.length) return u;
    return null;
  }

  return {
    getSemanticDiagnostics(scheme): SchemeDiagnostic[] {
      const mapper = loadSource(scheme);
      const out: SchemeDiagnostic[] = [];
      // Problems INSIDE required files don't belong on this buffer's spans —
      // they roll up into one summary per require form (provenance, not noise).
      const depProblems = new Map<string, number>();
      for (const d of service.getSemanticDiagnostics(PROGRAM_FILE)) {
        if (d.start === undefined) continue;
        // Scheme-legal redefinition (in-file or program-shadows-required) —
        // never an error in scheme, only in the flat const emit.
        if (SCHEME_LEGAL_TS_CODES.has(d.code)) continue;
        const dep = depAt(d.start);
        if (dep !== null) {
          if (d.category === ts.DiagnosticCategory.Error)
            depProblems.set(dep.path, (depProblems.get(dep.path) ?? 0) + 1);
          continue;
        }
        // Lift the TS diagnostic span OUT to Scheme. Drop diagnostics that don't
        // lift (unmapped prelude/infrastructure spans) — never surface a
        // wrong-positioned error.
        const span = mapper.toScheme(d.start);
        if (span === null) continue;
        const { line, character } = mapper.schemeOffsetToLineCol(span.start);
        const lifted = scheme.slice(span.start, span.start + span.length);
        let severity = severityOf(d.category);
        let messageText = ts.flattenDiagnosticMessageText(d.messageText, "\n");
        // ── speak SCHEME, and never cry wolf on what the lens can't know ──
        // 2304/2552 "Cannot find name": an unknown free name may live outside
        // the lens's sight (no resolveModule → any required file; with it →
        // an unresolvable path / runtime-injected binding) → SUGGESTION, named
        // by the SCHEME atom (the TS message carries the cleanName'd twin).
        if (d.code === 2304 || d.code === 2552) {
          const atom = SCHEME_ATOM.test(lifted) ? lifted : /Cannot find name '([^']+)'/.exec(messageText)?.[1];
          severity = "suggestion";
          messageText =
            opts?.resolveModule === undefined
              ? `Cannot find name '${atom ?? lifted}' in this file (\`require\`d names aren't resolved yet).`
              : `Cannot find name '${atom ?? lifted}' in this file or its \`require\`s.`;
        }
        // 2339 on ArrShape: the emitter lowered a head it believes is a builtin,
        // but the prelude has no leaf — OUR roster gap, not the user's bug.
        else if (d.code === 2339 && messageText.includes("'ArrShape'")) {
          const prop = /Property '([^']+)'/.exec(messageText)?.[1];
          severity = "suggestion";
          messageText = `'${prop ?? lifted}' has no builtin type signature yet — the call is unchecked.`;
        }
        out.push({
          start: span.start,
          length: span.length,
          line,
          character,
          severity,
          code: d.code,
          messageText,
        });
      }
      // Roll dep problems up onto their require forms (first occurrence wins).
      for (const [path, count] of depProblems) {
        const ref = programRequires.find((r) => r.path === path);
        if (ref === undefined) continue; // transitively required — surfaces in ITS requirer
        const { line, character } = mapper.schemeOffsetToLineCol(ref.span.start);
        out.push({
          start: ref.span.start,
          length: ref.span.length,
          line,
          character,
          severity: "warning",
          code: 0,
          messageText: `required file "${path}" has ${count} type error${count === 1 ? "" : "s"} — open it for details.`,
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
      return computeEntries(scheme, schemeOffset);
    },

    getCompletionContext(scheme, schemeOffset): SchemeCompletionContext {
      const entries = computeEntries(scheme, schemeOffset);
      // Locate the cursor's role with the same sentinel machinery the sampler's
      // T mask uses — this IS the loop closure. The sentinel REPLACES the atom
      // being typed (mid-atom, the partial text is a continuation of the same
      // slot, not a completed earlier argument — the typed-scanner strips it
      // the same way before narrowing).
      const [atomStart, atomEnd] = atomBoundsAt(scheme, schemeOffset);
      const sentinelScheme = balancePrefix(`${scheme.slice(0, atomStart)} ${SENTINEL} ${scheme.slice(atomEnd)}`);
      const role = findCursorRole(sentinelScheme);
      const builtinSigs = builtinSignatures();
      // Locals' signatures resolve against the program's own emitted consts.
      const localNames = entries.filter((e) => !builtinSigs.has(e.name)).map((e) => e.name);
      const localSigs = probeLocalSignatures(scheme, localNames);
      // At an argument slot: one batched probe gives every candidate's verdict
      // (exactly the sampler's per-step mask) + the parameter's rendered type.
      let verdicts: (boolean | null)[] | null = null;
      let paramType: string | undefined;
      if (role.kind === "argument") {
        const probed = probeTypes(
          scheme,
          role.calleeText,
          role.argIndex,
          entries.map((e) => e.name),
        );
        verdicts = probed.verdicts;
        paramType = probed.paramType;
      }
      const rich: SchemeRichCompletion[] = entries.map((e, i) => {
        const detail = builtinSigs.get(e.name) ?? localSigs.get(e.name);
        const fits = verdicts?.[i];
        return {
          ...e,
          ...(detail === undefined ? {} : { detail }),
          ...(fits === null || fits === undefined ? {} : { fits }),
          ...(detail === undefined ? {} : { callable: CALLABLE_SIG.test(detail) }),
        };
      });
      return {
        position: role.kind,
        ...(role.kind === "argument"
          ? {
              slot: {
                // role.calleeText is TS-side currency (probeTypes embeds it in
                // probe source, so a builtin MUST stay `__arr["…"]` there); the
                // user-facing slot surfaces the SCHEME name — same glass rule
                // as the 2304/2552 message rewrite. BOTH emitter spellings
                // unwrap: element access (`__arr["string-append"]`) AND dot
                // access (`__arr.map`, identifier-safe names) — the dot form
                // used to leak TS currency into the slot card.
                callee:
                  /^__arr\["(.+)"\]$/.exec(role.calleeText)?.[1] ??
                  /^__arr\.([A-Za-z_$][\w$]*)$/.exec(role.calleeText)?.[1] ??
                  role.calleeText,
                argIndex: role.argIndex,
                ...(paramType === undefined ? {} : { paramType }),
              },
            }
          : {}),
        entries: rich,
      };
    },

    getDefinitionAtPosition(scheme, schemeOffset): SchemeDefinition[] {
      const mapper = loadSource(scheme);
      const tsOffset = mapper.toTs(schemeOffset);
      if (tsOffset === null) return [];
      const defs = service.getDefinitionAtPosition(PROGRAM_FILE, tsOffset);
      if (defs === undefined) return [];
      const out: SchemeDefinition[] = [];
      for (const d of defs) {
        if (d.fileName !== PROGRAM_FILE) {
          // A builtin's `.d.ts` definition — no scheme source anywhere.
          out.push({ name: d.name, kind: d.kind, span: null });
          continue;
        }
        // Inside the concatenated module: a REQUIRED file's segment lifts via
        // THAT file's mapper (own coordinates + its require-path); the
        // program's segment lifts via the shifted program mapper.
        const dep = depAt(d.textSpan.start);
        if (dep !== null) {
          const span = dep.mapper.toScheme(d.textSpan.start - dep.base);
          out.push({ name: d.name, kind: d.kind, span, ...(span === null ? {} : { file: dep.path }) });
          continue;
        }
        out.push({ name: d.name, kind: d.kind, span: mapper.toScheme(d.textSpan.start) });
      }
      return out;
    },

    getSemanticClassifications(scheme): SchemeClassifiedSpan[] {
      const mapper = loadSource(scheme);
      const encoded = service.getEncodedSemanticClassifications(
        PROGRAM_FILE,
        { start: 0, length: programText.length },
        ts.SemanticClassificationFormat.TwentyTwenty,
      );
      const out: SchemeClassifiedSpan[] = [];
      for (let i = 0; i < encoded.spans.length; i += 3) {
        const tsStart = encoded.spans[i]!;
        const classification = encoded.spans[i + 2]!;
        // 2020 format packs (tokenType + 1) << 8 | modifierSet.
        const kind = TOKEN_TYPES[(classification >> 8) - 1];
        if (kind === undefined) continue;
        const span = mapper.toScheme(tsStart);
        if (span === null) continue;
        // Token-faithful lifts only: the lifted text must be a single atom.
        // Binder positions and `__arr` infrastructure lift to their WHOLE form
        // (no token mapping yet) — painting `(define names …)` as "variable"
        // would be wrong+noisy, so they are dropped, not approximated.
        const text = scheme.slice(span.start, span.start + span.length);
        if (!SCHEME_ATOM.test(text)) continue;
        out.push({ start: span.start, length: span.length, kind });
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
      const role = findCursorRole(sentinelScheme);
      if (role.kind !== "argument") return cands; // not a typed-call argument slot → no T narrowing
      // 2. Batched conditional-type probe → per-candidate verdict in one checker read.
      const { verdicts } = probeTypes(scheme, role.calleeText, role.argIndex, cands);
      // 3. Keep iff PROVEN valid (true) OR unresolved (null) — never drop on uncertainty.
      return cands.filter((_, i) => verdicts[i] !== false);
    },
  };

  /** The shared completion-entry computation (see getCompletionsAtPosition):
   *  tsc's in-scope answer MINUS the substrate baseline PLUS the builtin roster. */
  function computeEntries(scheme: string, schemeOffset: number): SchemeCompletionEntry[] {
    // The prefix is mid-edit (usually unbalanced) — balance it so it parses; the cursor
    // offset is unchanged (closers append at the end). Query tsc at the ATOM'S
    // START, not the raw cursor: the end of a partial atom falls off its token
    // mapping into the enclosing form's mapping (→ `__arr.car`), where tsc
    // answers MEMBER completions — the whole scope vanished (caught 2026-06-10).
    const mapper = loadSource(balancePrefix(scheme));
    const tsOffset = mapper.toTs(atomBoundsAt(scheme, schemeOffset)[0]);
    if (tsOffset === null) return [];
    const completions = service.getCompletionsAtPosition(PROGRAM_FILE, tsOffset, undefined);
    // Answer in SCHEME terms, not virtual-TS terms (the raw tsc list is the
    // whole JS global scope — console, Array, the lens's own __arr/sexpr —
    // none of which is a scheme symbol; pure emission substrate):
    //   1. SUBTRACT the JS-global baseline (what an EMPTY program completes to);
    //      what survives is program-local bindings + context-specific members.
    //   2. MERGE the builtin roster (ArrShape members — real scheme names like
    //      `string-append`, plus host-injected rosetta tools) — tsc only offers
    //      them at `__arr.` member positions, which no scheme cursor reaches
    //      until the emitter maps head tokens; scheme-wise they are in scope
    //      at every position.
    const baseline = jsGlobalBaseline();
    const out: SchemeCompletionEntry[] = [];
    const seen = new Set<string>();
    for (const e of completions?.entries ?? []) {
      // Subtraction matches name AND kind: a program LOCAL that happens to
      // collide with a substrate name (`(define Array …)` — a const, vs the
      // baseline's type-only `Array` interface) must survive. Audited
      // 2026-06-10: name-only matching ate such locals.
      if (baseline.has(`${e.name} ${e.kind}`) || e.name.startsWith("__") || seen.has(e.name)) continue;
      seen.add(e.name);
      out.push({
        name: e.name,
        kind: e.kind,
        sortText: e.sortText,
        ...(e.insertText === undefined ? {} : { insertText: e.insertText }),
      });
    }
    for (const b of builtinCompletions()) {
      if (seen.has(b.name)) continue; // a local shadowing a builtin wins
      seen.add(b.name);
      out.push(b);
    }
    return out;
  }

  /** What an EMPTY program completes to at offset 0: the JS/lib global scope, TS
   *  keywords, and the lens's own infrastructure (`__arr`, `sexpr`, `List`, `Dict`…).
   *  None of it is a scheme symbol — it is the SUBTRACTION set for real queries
   *  (what survives subtraction is exactly what the PROGRAM brought into scope). */
  function jsGlobalBaseline(): Set<string> {
    if (baselineNames === null) {
      loadSource("");
      const c = service.getCompletionsAtPosition(PROGRAM_FILE, 0, undefined);
      // Keyed `name kind` so the subtraction is exact: a program VALUE binding
      // may legally share a name with a substrate TYPE (see the caller).
      baselineNames = new Set((c?.entries ?? []).map((e) => `${e.name} ${e.kind}`));
    }
    return baselineNames;
  }

  /** The builtin roster under its REAL scheme names (`car`, `string-append`, `+`,
   *  `odd?`, …, plus host-injected rosetta tools): string-literal completions at
   *  a raw `__arr[""]` ELEMENT-ACCESS position — exactly ArrShape's merged
   *  members. Element access, not `__arr.` member access: after a dot tsc omits
   *  every non-identifier name (un-typeable there), which silently drops the
   *  kebab/operator/`?` builtins — most of the roster. Bypasses the emitter
   *  (like `probeTypes`); scheme-wise these are in scope everywhere. */
  function builtinCompletions(): SchemeCompletionEntry[] {
    if (builtinEntries === null) {
      programText = '__arr[""];\nexport {};\n';
      programVersion += 1;
      const c = service.getCompletionsAtPosition(PROGRAM_FILE, '__arr["'.length, undefined);
      builtinEntries = (c?.entries ?? [])
        .filter((e) => !e.name.startsWith("__"))
        // tsc tags string-literal completions kind:"string"; semantically these
        // are the callable builtins — present them as methods.
        .map((e) => ({ name: e.name, kind: "method", sortText: e.sortText }));
    }
    return builtinEntries;
  }

  /** Emit the sentinel'd scheme, then walk the TS AST to where the SENTINEL landed —
   *  the cursor's Σ-style role:
   *    • inside a CallExpression's ARGUMENTS → `argument` + callee text + arg index
   *      (the T-narrowable slot);
   *    • AS a CallExpression's callee, or the scheme cursor sits right after `(`
   *      (the emitter lowers an unknown head so the sentinel is itself the call) →
   *      `operator`;
   *    • anywhere else → `top`. */
  function findCursorRole(
    sentinelScheme: string,
  ): { kind: "argument"; calleeText: string; argIndex: number } | { kind: "operator" } | { kind: "top" } {
    loadSource(sentinelScheme);
    const program = service.getProgram();
    const sf = program?.getSourceFile(PROGRAM_FILE);
    if (!sf) return { kind: "top" };
    let found: ReturnType<typeof findCursorRole> | null = null;
    const visit = (node: ts.Node): void => {
      if (found) return;
      if (ts.isIdentifier(node) && node.text === SENTINEL) {
        const s = node.getStart(sf);
        const e = node.getEnd();
        for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
          if (ts.isCallExpression(p)) {
            const argIndex = p.arguments.findIndex((a) => a.getStart(sf) <= s && e <= a.end);
            if (argIndex !== -1) {
              found = { kind: "argument", calleeText: p.expression.getText(sf), argIndex };
              return;
            }
            if (p.expression.getStart(sf) <= s && e <= p.expression.end) {
              found = { kind: "operator" };
              return;
            }
          }
        }
        found = { kind: "top" };
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return found ?? { kind: "top" };
  }

  /** Resolve a probe module and read the tuple type of `declare const <name>: […]`
   *  element by element off the checker — never through a whole-tuple
   *  `typeToString` (truncates past ~160 chars; audited 2026-06-10). */
  function readProbeTuple(probeProgramText: string, name: string): readonly ts.Type[] | null {
    programText = probeProgramText;
    programVersion += 1;
    const program = service.getProgram();
    const sf = program?.getSourceFile(PROGRAM_FILE);
    if (!sf || !program) return null;
    const checker = program.getTypeChecker();
    let probeNode: ts.Node | null = null;
    const find = (n: ts.Node): void => {
      if (probeNode) return;
      if (ts.isIdentifier(n) && n.text === name && ts.isVariableDeclaration(n.parent)) probeNode = n;
      else ts.forEachChild(n, find);
    };
    find(sf);
    if (!probeNode) return null;
    const tupleType = checker.getTypeAtLocation(probeNode);
    if (!(tupleType.flags & ts.TypeFlags.Object)) return null;
    return checker.getTypeArguments(tupleType as ts.TypeReference);
  }

  /** The current checker (valid until the next program load). */
  function checkerNow(): ts.TypeChecker | null {
    return service.getProgram()?.getTypeChecker() ?? null;
  }

  /** The TYPE EXPRESSION a candidate contributes to `__ok<…>`. THREE cases:
   *   • a STRING-LITERAL candidate (`"thai"` — the model emitted a quoted string,
   *     not a bound symbol) → the literal type ITSELF (`"thai"`), so `__ok`
   *     checks `["thai"] extends [__E]`. A literal union slot
   *     (`"thai"|"italian"`) narrows the wrong member out; a free-form `string`
   *     slot keeps it (`["thai"] extends [string]` = true) — never a wrong
   *     restriction. Without this the candidate degraded to
   *     `typeof __arr["\"thai\""]` = `any` ⇒ every literal survived (the gap).
   *   • an identifier-shaped non-builtin → `typeof <name>` (a program local).
   *   • everything else (builtins, kebab/operator names) → `typeof __arr["…"]`.
   *  The string-literal case is read off `isStringLiteralCandidate`. */
  function typeofRef(name: string, builtinNames: ReadonlySet<string>): string {
    const lit = stringLiteralType(name);
    if (lit !== null) return lit;
    if (!builtinNames.has(name) && /^[A-Z_$][\w$]*$/i.test(name)) return `typeof ${name}`;
    return `typeof __arr[${JSON.stringify(name)}]`;
  }

  /** Load a probe module and read, per candidate, whether it is type-valid in the given call slot.
   *  `true` = proven assignable, `false` = proven not, `null` = unresolved (kept by the caller).
   *  The probe rides ON TOP of the emitted program (locals stay in scope: a
   *  LOCAL callee's parameters resolve, a LOCAL candidate's type resolves —
   *  both were `any`-kept before). ONE program load for the whole list. */
  function probeTypes(
    scheme: string,
    calleeText: string,
    argIndex: number,
    candidates: string[],
  ): { verdicts: (boolean | null)[]; paramType?: string } {
    // `__ok<T>`: T fits the slot iff it IS the param type, OR it is a function whose RETURN type is
    // (the next token at an arg slot is usually a sub-call's operator). `[x]`-tuple wrapping defeats
    // union distribution. An unresolvable typeof is `any` ⇒ both branches `true` ⇒ kept.
    const okT =
      `type __ok<T> = (([T] extends [(...a: any[]) => infer R] ? ([R] extends [__E] ? true : false) : false) extends true ? true ` +
      `: ([T] extends [__E] ? true : false));`;
    const builtinNames = new Set(builtinSignatures().keys());
    // Ride the FULL require closure (loadSource concatenates it), so required
    // names resolve in the probe instead of degrading to `any`.
    loadSource(balancePrefix(scheme));
    const emitted = programText;
    const probeProgram = [
      emitted,
      `type __E = Parameters<typeof ${calleeText}>[${argIndex}];`,
      okT,
      `declare const __probe: [${candidates.map((n) => `__ok<${typeofRef(n, builtinNames)}>`).join(", ")}];`,
      `declare const __param: [__E];`,
    ].join("\n");
    const elements = readProbeTuple(probeProgram, "__probe");
    const checker = checkerNow();
    if (elements === null || checker === null) return { verdicts: candidates.map(() => null) };
    const verdicts = candidates.map((_, i) => {
      const el = elements[i];
      if (el === undefined) return null;
      const text = checker.typeToString(el); // a single literal: "true" / "false" / other
      return text === "true" ? true : text === "false" ? false : null;
    });
    // The expected parameter type, rendered — the slot's "what goes here".
    let paramType: string | undefined;
    const sf = service.getProgram()?.getSourceFile(PROGRAM_FILE);
    if (sf !== undefined) {
      let paramNode: ts.Node | null = null;
      const find = (n: ts.Node): void => {
        if (paramNode) return;
        if (ts.isIdentifier(n) && n.text === "__param" && ts.isVariableDeclaration(n.parent)) paramNode = n;
        else ts.forEachChild(n, find);
      };
      find(sf);
      if (paramNode !== null) {
        const t = checker.getTypeArguments(checker.getTypeAtLocation(paramNode) as ts.TypeReference)[0];
        if (t !== undefined) {
          const text = checker.typeToString(t);
          if (text !== "any" && text !== "unknown") paramType = text;
        }
      }
    }
    return { verdicts, ...(paramType === undefined ? {} : { paramType }) };
  }

  /** Builtin signatures, rendered once per service (the roster is constant):
   *  ONE ambient probe tuple `[typeof __arr["car"], …]`, element-wise reads. */
  function builtinSignatures(): Map<string, string> {
    if (builtinSigs === null) {
      const names = builtinCompletions().map((e) => e.name);
      const probeProgram = [
        "__arr;",
        `declare const __sigs: [${names.map((n) => `typeof __arr[${JSON.stringify(n)}]`).join(", ")}];`,
        "export {};",
      ].join("\n");
      const elements = readProbeTuple(probeProgram, "__sigs");
      const checker = checkerNow();
      builtinSigs = new Map();
      if (elements !== null && checker !== null) {
        for (const [i, n] of names.entries()) {
          const el = elements[i];
          if (el !== undefined) builtinSigs!.set(n, checker.typeToString(el));
        }
      }
    }
    return builtinSigs;
  }

  /** Render the locals' types by probing `typeof <name>` against the emitted
   *  program (they are its top-level consts). Unresolvable names render "any"
   *  and are omitted. */
  function probeLocalSignatures(scheme: string, names: readonly string[]): Map<string, string> {
    const out = new Map<string, string>();
    const idNames = names.filter((n) => /^[A-Z_$][\w$]*$/i.test(n));
    if (idNames.length === 0) return out;
    // Ride the FULL require closure (loadSource concatenates it), so required
    // names resolve in the probe instead of degrading to `any`.
    loadSource(balancePrefix(scheme));
    const emitted = programText;
    const probeProgram = [emitted, `declare const __sigs: [${idNames.map((n) => `typeof ${n}`).join(", ")}];`].join(
      "\n",
    );
    const elements = readProbeTuple(probeProgram, "__sigs");
    const checker = checkerNow();
    if (elements === null || checker === null) return out;
    for (const [i, n] of idNames.entries()) {
      const el = elements[i];
      if (el === undefined) continue;
      const text = checker.typeToString(el);
      if (text !== "any") out.set(n, text);
    }
    return out;
  }
}

/** A rendered signature that denotes a callable value (drives Σ's
 *  operator-position ranking client-side). */
const CALLABLE_SIG = /=>/;
