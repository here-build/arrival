// tsgo/scheme-service — the FULL SchemeLanguageService surface (async twin)
// over the tsgo (TypeScript 7) wasm checker: the remaining six methods beyond
// type-lens.ts's T-gate, browser-safe (no `typescript`, no node builtins).
//
// THE INVERSION, completed: scheme-shaped questions are answered by the
// arrival READER (scope enumeration for completions, binding sites for
// go-to-definition, cursor role for context — parseSexprs + spans we own);
// TYPE-shaped questions go to the checker over RPC (diagnostics, hover
// types, slot/param types, fit verdicts, symbol classification). The JS-TS
// service answered both kinds by interrogating the emitted TS through the
// LanguageService because that was the only brain available; here each
// question goes to its native layer.
//
// DOCUMENTED DIVERGENCES from service-core (the parity suite pins the rest):
//   • no param-annotation inference pass (loadSource's checker.getContextualType
//     fixpoint) — an unannotated lambda param stays implicit-any, so hovers/
//     verdicts that depended on inferred annotations degrade CONSERVATIVELY
//     (more keeps, `any` hovers), never wrongly.
//   • hover displayText is `name: <typeToString>` (+ leaf JSDoc), not tsc
//     displayParts — cosmetic.
//   • hover/definition spans come from the SCHEME atom/form directly (no
//     TS-span round trip) — at least as precise as the lifted spans.
//   • completions enumerate scheme scope (top-level defines + enclosing
//     lambda/define params) + the ArrShape roster + host members — the
//     substrate-baseline subtraction dance disappears with the substrate.

import { parseSexprs, type Node } from "@here.build/arrival-chain/sweet";
import { emitTypes } from "@here.build/arrival-chain-view/types-emit";

import { balancePrefix } from "../balance.js";
import { Mapper } from "../span-map.js";
import { PROGRAM_FILE } from "../virtual-files.js";
import {
  createTsgoClient,
  SYMBOL_FLAGS_VALUE,
  type ProjectId,
  type SnapshotId,
  type SymbolRef,
  type TsgoClient,
  type TsgoDiagnostic,
  type TsgoTransport,
  type TypeId,
  type TypeRef,
  type UpdateSnapshotResult,
} from "./client.js";
import { scanInnermostCall } from "./type-lens.js";

// ── shared scheme-coordinate result shapes (mirror service-core's) ───────────

export interface SchemeDiagnostic {
  start: number;
  length: number;
  line: number;
  character: number;
  severity: "error" | "warning" | "suggestion" | "message";
  code: number;
  messageText: string;
}
export interface SchemeQuickInfo {
  displayText: string;
  documentation: string;
  span: { start: number; length: number } | null;
}
export interface SchemeCompletionEntry {
  name: string;
  kind: string;
  sortText: string;
  insertText?: string;
}
export interface SchemeRichCompletion extends SchemeCompletionEntry {
  detail?: string;
  fits?: boolean;
  callable?: boolean;
}
export interface SchemeCompletionContext {
  position: "operator" | "argument" | "top";
  slot?: { callee: string; argIndex: number; paramType?: string };
  entries: SchemeRichCompletion[];
}
export interface SchemeClassifiedSpan {
  start: number;
  length: number;
  kind: string;
}
export interface SchemeDefinition {
  name: string;
  kind: string;
  span: { start: number; length: number } | null;
  file?: string;
}

/** The async service surface — method-compatible with ls-protocol's
 *  AsyncSchemeLanguageService (the worker wire shape). */
export interface TsgoSchemeService {
  getSemanticDiagnostics(scheme: string): Promise<SchemeDiagnostic[]>;
  getQuickInfoAtPosition(scheme: string, schemeOffset: number): Promise<SchemeQuickInfo | null>;
  getCompletionsAtPosition(scheme: string, schemeOffset: number): Promise<SchemeCompletionEntry[]>;
  getCompletionContext(scheme: string, schemeOffset: number): Promise<SchemeCompletionContext>;
  getDefinitionAtPosition(scheme: string, schemeOffset: number): Promise<SchemeDefinition[]>;
  getSemanticClassifications(scheme: string): Promise<SchemeClassifiedSpan[]>;
  getTypeValidCandidates(scheme: string, schemeOffset: number, candidates: readonly string[]): Promise<string[]>;
  setProjectFiles(files: Record<string, string>): Promise<void>;
  /** The ArrShape roster (+ host members) — Σ grant material and the
   *  emitter's member set; constant for the service lifetime. */
  builtinNames(): readonly string[];
  dispose(): void;
}

export interface TsgoSchemeServiceOptions {
  preludeFiles: Map<string, string>;
  transport: TsgoTransport;
  /** Host-injected rosetta tools — same two-part seam as service-core. */
  host?: { prelude: string; members: readonly string[] };
}

// ── scheme-side helpers (the reader owns structure) ──────────────────────────

const ATOM_CHAR = /[^\s()[\]{}"';]/;
const SCHEME_ATOM = /^[\w\-!$%&*+./<=>?@^~:]+$/;
const IDENTIFIER_SHAPED = /^[A-Z_$][\w$]*$/i;
const CALLABLE_SIG = /=>/;

function atomBoundsAt(scheme: string, offset: number): [number, number] {
  let start = offset;
  while (start > 0 && ATOM_CHAR.test(scheme[start - 1]!)) start--;
  let end = offset;
  while (end < scheme.length && ATOM_CHAR.test(scheme[end]!)) end++;
  return [start, end];
}

function parsedForest(scheme: string): Node[] {
  try {
    return parseSexprs(balancePrefix(scheme));
  } catch {
    return [];
  }
}

const isAtom = (n: Node | undefined): n is Node & { atom: string } => n !== undefined && "atom" in n;
const isList = (n: Node | undefined): n is Node & { list: Node[] } => n !== undefined && "list" in n;

/** One scheme binding: name + the span of its BINDING site (define form /
 *  param atom) + whether it binds a lambda (callable). */
interface SchemeBinding {
  name: string;
  span: { start: number; length: number };
  kind: "define" | "param";
  callable: boolean;
}

/** Enumerate bindings visible at `offset`: every top-level define (scheme
 *  load semantics — the flat const emit makes them module-wide), plus params
 *  of every lambda / `(define (f …) …)` sugar whose body CONTAINS the offset. */
function bindingsAt(forest: readonly Node[], offset: number | null): SchemeBinding[] {
  const out: SchemeBinding[] = [];
  const spanOf = (n: Node): { start: number; length: number } | null =>
    n.span === undefined ? null : { start: n.span[0], length: n.span[1] - n.span[0] };
  const pushParams = (paramList: Node): void => {
    if (!isList(paramList)) return;
    for (const p of paramList.list) {
      if (!isAtom(p)) continue;
      const span = spanOf(p);
      if (span !== null) out.push({ name: p.atom, span, kind: "param", callable: false });
    }
  };
  const visit = (form: Node, topLevel: boolean): void => {
    if (!isList(form)) return;
    const [head, second, third] = form.list;
    const contains = offset !== null && form.span !== undefined && form.span[0] <= offset && offset <= form.span[1];
    if (isAtom(head) && head.atom === "define" && topLevel) {
      if (isAtom(second)) {
        const span = spanOf(form);
        if (span !== null)
          out.push({
            name: second.atom,
            span,
            kind: "define",
            callable: isList(third) && isAtom(third.list[0]) && third.list[0].atom === "lambda",
          });
      } else if (isList(second) && isAtom(second.list[0])) {
        // (define (f p…) body) sugar — f is a callable define; params scope to the form.
        const span = spanOf(form);
        if (span !== null) out.push({ name: second.list[0].atom, span, kind: "define", callable: true });
        if (contains) pushParams({ list: second.list.slice(1) } as Node);
      }
    }
    if (isAtom(head) && head.atom === "lambda" && contains && second !== undefined) pushParams(second);
    for (const child of form.list) visit(child, false);
  };
  for (const form of forest) visit(form, true);
  return out;
}

/** `(require "path")` refs — same contract as service-core's scanRequires. */
function scanRequireRefs(scheme: string): { path: string; span: { start: number; length: number } }[] {
  const out: { path: string; span: { start: number; length: number } }[] = [];
  for (const form of parsedForest(scheme)) {
    if (!isList(form) || form.span === undefined) continue;
    const [head, arg] = form.list;
    if (!isAtom(head) || head.atom !== "require") continue;
    if (!isAtom(arg) || (arg as { str?: boolean }).str !== true) continue;
    out.push({ path: arg.atom, span: { start: form.span[0], length: form.span[1] - form.span[0] } });
  }
  return out;
}

/** Pull the leading JSDoc above each `"name": …` ArrShape member out of the
 *  prelude leaves — the hover documentation source (we OWN the .d.ts text;
 *  no checker API needed). */
function extractLeafDocs(preludeFiles: ReadonlyMap<string, string>): Map<string, string> {
  const docs = new Map<string, string>();
  const memberRe = /\/\*\*([\s\S]*?)\*\/\s*(?:readonly\s+)?"([^"]+)"\s*:/g;
  for (const [, text] of preludeFiles) {
    for (const m of text.matchAll(memberRe)) {
      const body = m[1]!
        .split("\n")
        .map((l) => l.replace(/^\s*\*\s?/, "").trim())
        .filter((l) => !l.startsWith("@"))
        .join(" ")
        .trim();
      if (body.length > 0 && !docs.has(m[2]!)) docs.set(m[2]!, body);
    }
  }
  return docs;
}

// ── diagnostics lift (scheme-speak, mirroring service-core's rewrites) ───────

const SCHEME_LEGAL_TS_CODES = new Set([2451, 2300]); // redeclare/duplicate — legal scheme redefinition
const CATEGORY_NAMES = ["warning", "error", "suggestion", "message"] as const; // tsgo diagnostics.Category iota order

function typeofRef(name: string, builtinNames: ReadonlySet<string>): string {
  if (!builtinNames.has(name) && IDENTIFIER_SHAPED.test(name)) return `typeof ${name}`;
  return `typeof __arr[${JSON.stringify(name)}]`;
}

// ── the service ──────────────────────────────────────────────────────────────

export async function createTsgoSchemeService(options: TsgoSchemeServiceOptions): Promise<TsgoSchemeService> {
  const MOUNT = "/virtual";
  const TSCONFIG = `${MOUNT}/tsconfig.json`;
  const programPath = `${MOUNT}/${PROGRAM_FILE}`;

  const files = new Map<string, string>();
  const preludeNames: string[] = [];
  for (const [name, content] of options.preludeFiles) {
    files.set(`${MOUNT}/${name}`, content);
    preludeNames.push(name);
  }
  if (options.host !== undefined) {
    files.set(`${MOUNT}/__host.d.ts`, options.host.prelude);
    preludeNames.push("__host.d.ts");
  }
  files.set(
    TSCONFIG,
    JSON.stringify({
      // noImplicitAny OFF: this service has no param-annotation inference pass
      // (the documented divergence), so unannotated lambda params are
      // implicit-any BY DESIGN — reporting 7006 on every lambda would punish
      // the user for our pass being absent. Matches the IDE's LS_OPTIONS.
      compilerOptions: {
        strict: true,
        noImplicitAny: false,
        target: "es2022",
        lib: ["es2022"],
        types: [],
        noEmit: true,
        skipLibCheck: true,
      },
      files: [...preludeNames, PROGRAM_FILE],
    }),
  );
  files.set(programPath, "export {};\n");

  const leafDocs = extractLeafDocs(options.preludeFiles);
  let projectFiles: Readonly<Record<string, string>> = {};
  const resolveModule = (path: string): string | null =>
    projectFiles[path] ?? projectFiles[path.replace(/^\.\//, "")] ?? null;

  const client: TsgoClient = createTsgoClient(options.transport, { files, roots: [MOUNT, "/"] });
  await client.request("initialize");

  let world: { snapshot: SnapshotId; project: ProjectId };
  {
    const snap = await client.request<UpdateSnapshotResult>("updateSnapshot", { openProject: TSCONFIG });
    const project = snap.projects.at(0);
    if (project === undefined) throw new Error("tsgo scheme-service: updateSnapshot returned no project");
    world = { snapshot: snap.snapshot, project: project.id };
  }

  // The ArrShape roster: names once (snapshot-stable strings), signatures
  // rendered once (constant for the service lifetime — prelude + host fixed).
  const arr = await client.request<SymbolRef | null>("resolveName", {
    ...world,
    name: "__arr",
    file: programPath,
    position: 0,
    meaning: SYMBOL_FLAGS_VALUE,
  });
  if (arr === null)
    throw new Error("tsgo scheme-service: '__arr' did not resolve — the PRE prelude is missing or failed to load");
  const arrType = await client.request<TypeRef>("getTypeOfSymbol", { ...world, symbol: arr.id });
  const allMembers = await client.request<SymbolRef[]>("getPropertiesOfType", { ...world, type: arrType.id });
  const memberSymbols = allMembers.filter((m) => !m.name.startsWith("__"));
  const builtins = new Set(memberSymbols.map((m) => m.name));
  const memberTypes = await client.request<(TypeRef | null)[]>("getTypesOfSymbols", {
    ...world,
    symbols: memberSymbols.map((m) => m.id),
  });
  const builtinSigs = new Map<string, string>();
  await Promise.all(
    memberSymbols.map(async (m, i) => {
      const t = memberTypes[i];
      if (t === null || t === undefined) return;
      const rendered = await client.request<string>("typeToString", { ...world, type: t.id });
      builtinSigs.set(m.name, rendered);
    }),
  );

  /** Emit `scheme` WITH its require closure (deps-first, cycle-safe) and
   *  install it; returns the program Mapper + per-dep units (own mappers). */
  interface DepUnit {
    path: string;
    base: number;
    length: number;
    mapper: Mapper;
  }
  async function loadSource(scheme: string): Promise<{
    mapper: Mapper;
    depUnits: DepUnit[];
    requires: ReturnType<typeof scanRequireRefs>;
    programText: string;
  }> {
    const requires = scanRequireRefs(scheme);
    interface RawUnit {
      path: string;
      base: number;
      length: number;
      source: string;
      localMappings: { tsStart: number; tsLength: number; schemeStart: number; schemeLength: number }[];
    }
    const rawDeps: RawUnit[] = [];
    let prefix = "";
    if (requires.length > 0) {
      const visited = new Set<string>();
      const emitDep = (path: string): void => {
        if (visited.has(path)) return;
        visited.add(path);
        const source = resolveModule(path);
        if (source === null) return;
        for (const nested of scanRequireRefs(source)) emitDep(nested.path);
        const dep = emitTypes(source, { hostMembers: builtins });
        const text = dep.ts.replace(/export \{\};\n$/, "");
        rawDeps.push({ path, base: prefix.length, length: text.length, source, localMappings: dep.mappings });
        prefix += text;
      };
      for (const r of requires) emitDep(r.path);
    }
    const { ts: emitted, mappings } = emitTypes(scheme, { hostMembers: builtins });
    const programText = prefix + emitted;
    files.set(programPath, programText);
    const previous = world.snapshot;
    const snap = await client.request<UpdateSnapshotResult>("updateSnapshot", {
      fileChanges: { changed: [programPath] },
    });
    const project = snap.projects.at(0);
    if (project === undefined) throw new Error("tsgo scheme-service: updateSnapshot returned no project");
    world = { snapshot: snap.snapshot, project: project.id };
    if (previous !== world.snapshot) client.request("release", { snapshot: previous }).catch(() => undefined);
    const depUnits = rawDeps.map((u) => ({
      path: u.path,
      base: u.base,
      length: u.length,
      mapper: new Mapper(u.localMappings, u.source, programText.slice(u.base, u.base + u.length)),
    }));
    const programMappings = mappings.map((m) => ({ ...m, tsStart: m.tsStart + prefix.length }));
    return { mapper: new Mapper(programMappings, scheme, programText), depUnits, requires, programText };
  }

  /** The shared verdict batch (the T-gate core, reused by completions):
   *  null = no narrowing applies at this offset. */
  async function slotVerdicts(
    scheme: string,
    schemeOffset: number,
    names: readonly string[],
  ): Promise<{ verdicts: boolean[]; callee: string; argIndex: number; paramType?: string } | null> {
    const slot = scanInnermostCall(scheme.slice(0, schemeOffset));
    if (slot?.callee == null) return null;
    const calleeRef = typeofRef(slot.callee, builtins);
    const emitted = emitTypes(balancePrefix(scheme), { hostMembers: builtins }).ts;
    let text =
      `${emitted}\n` +
      `type __ok<T> = (([T] extends [(...a: any[]) => infer R] ? ([R] extends [__E] ? true : false) : false) extends true ? true ` +
      `: ([T] extends [__E] ? true : false));\n` +
      `type __E = Parameters<${calleeRef}>[${slot.argIndex}];\n`;
    const positions: number[] = [];
    for (const [i, name] of names.entries()) {
      const ref = typeofRef(name, builtins);
      positions.push(text.length + "type ".length);
      text += `type __r${i} = [__ok<${ref}>] extends [false] ? 3 : ([__ok<${ref}>] extends [true] ? 1 : 2);\n`;
    }
    const ePos = text.length + "type ".length;
    text += `type __rE = [__E];\n`; // the slot's expected type, rendered for the context card
    files.set(programPath, text);
    const previous = world.snapshot;
    const snap = await client.request<UpdateSnapshotResult>("updateSnapshot", {
      fileChanges: { changed: [programPath] },
    });
    const project = snap.projects.at(0);
    if (project === undefined) throw new Error("tsgo scheme-service: updateSnapshot returned no project");
    world = { snapshot: snap.snapshot, project: project.id };
    if (previous !== world.snapshot) client.request("release", { snapshot: previous }).catch(() => undefined);
    const types = await client.request<({ value?: unknown; id: TypeId } | null)[]>("getTypesAtPositions", {
      ...world,
      file: programPath,
      positions: [...positions, ePos],
    });
    const verdicts = names.map((_, i) => types[i]?.value !== 3);
    let paramType: string | undefined;
    const eType = types.at(-1);
    if (eType !== null && eType !== undefined) {
      const args = await client.request<TypeRef[] | null>("getTypeArguments", { ...world, type: eType.id });
      const inner = args?.at(0);
      if (inner !== undefined) {
        const rendered = await client.request<string>("typeToString", { ...world, type: inner.id });
        if (rendered !== "any" && rendered !== "unknown") paramType = rendered;
      }
    }
    return {
      verdicts,
      callee: slot.callee,
      argIndex: slot.argIndex,
      ...(paramType === undefined ? {} : { paramType }),
    };
  }

  // Serialize: every method installs its own program; a world must never be
  // queried after the next load begins.
  let chain: Promise<unknown> = Promise.resolve();
  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const next = chain.then(task, task);
    chain = next.catch(() => undefined);
    return next;
  };

  function completionEntries(scheme: string, schemeOffset: number): SchemeCompletionEntry[] {
    const forest = parsedForest(scheme);
    const seen = new Set<string>();
    const out: SchemeCompletionEntry[] = [];
    for (const b of bindingsAt(forest, schemeOffset)) {
      if (seen.has(b.name) || b.name.startsWith("__")) continue;
      seen.add(b.name);
      out.push({
        name: b.name,
        kind: b.kind === "param" ? "parameter" : b.callable ? "function" : "const",
        sortText: "0",
      });
    }
    for (const name of builtins) {
      if (seen.has(name)) continue; // a local shadowing a builtin wins
      seen.add(name);
      out.push({ name, kind: "method", sortText: "1" });
    }
    return out;
  }

  return {
    getSemanticDiagnostics(scheme): Promise<SchemeDiagnostic[]> {
      return serialize(async () => {
        const { mapper, depUnits, requires } = await loadSource(scheme);
        const raw = await client.request<TsgoDiagnostic[]>("getSemanticDiagnostics", { ...world, file: programPath });
        const out: SchemeDiagnostic[] = [];
        const depProblems = new Map<string, number>();
        const depAt = (tsOffset: number): DepUnit | null => {
          for (const u of depUnits) if (tsOffset >= u.base && tsOffset < u.base + u.length) return u;
          return null;
        };
        for (const d of raw) {
          if (SCHEME_LEGAL_TS_CODES.has(d.code)) continue;
          const dep = depAt(d.pos);
          if (dep !== null) {
            if (d.category === 1 /* CategoryError */) depProblems.set(dep.path, (depProblems.get(dep.path) ?? 0) + 1);
            continue;
          }
          const span = mapper.toScheme(d.pos);
          if (span === null) continue;
          const { line, character } = mapper.schemeOffsetToLineCol(span.start);
          const lifted = scheme.slice(span.start, span.start + span.length);
          let severity: SchemeDiagnostic["severity"] = CATEGORY_NAMES[d.category] ?? "message";
          let messageText = d.text;
          if (d.code === 2304 || d.code === 2552) {
            const atom = SCHEME_ATOM.test(lifted) ? lifted : /Cannot find name '([^']+)'/.exec(messageText)?.[1];
            severity = "suggestion";
            messageText = `Cannot find name '${atom ?? lifted}' in this file or its \`require\`s.`;
          } else if (d.code === 2339 && messageText.includes("'ArrShape'")) {
            const prop = /Property '([^']+)'/.exec(messageText)?.[1];
            severity = "suggestion";
            messageText = `'${prop ?? lifted}' has no builtin type signature yet — the call is unchecked.`;
          }
          out.push({ start: span.start, length: span.length, line, character, severity, code: d.code, messageText });
        }
        for (const [path, count] of depProblems) {
          const ref = requires.find((r) => r.path === path);
          if (ref === undefined) continue;
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
      });
    },

    getQuickInfoAtPosition(scheme, schemeOffset): Promise<SchemeQuickInfo | null> {
      return serialize(async () => {
        const [aStart, aEnd] = atomBoundsAt(scheme, schemeOffset);
        if (aStart === aEnd) return null;
        const atom = scheme.slice(aStart, aEnd);
        // Builtins: the roster signature IS the hover (the emitted position
        // lands inside `__arr["…"]`, whose element type reads as ArrShape).
        let rendered: string | null = builtins.has(atom) ? (builtinSigs.get(atom) ?? null) : null;
        if (rendered === null) {
          const { mapper } = await loadSource(balancePrefix(scheme));
          const tsOffset = mapper.toTs(aStart);
          if (tsOffset !== null) {
            const t = await client.request<TypeRef | null>("getTypeAtPosition", {
              ...world,
              file: programPath,
              position: tsOffset,
            });
            if (t !== null) rendered = await client.request<string>("typeToString", { ...world, type: t.id });
          }
        }
        if (rendered === null || rendered === "any") return null;
        return {
          displayText: `${atom}: ${rendered}`,
          documentation: leafDocs.get(atom) ?? "",
          span: { start: aStart, length: aEnd - aStart },
        };
      });
    },

    getCompletionsAtPosition(scheme, schemeOffset): Promise<SchemeCompletionEntry[]> {
      return Promise.resolve(completionEntries(scheme, schemeOffset));
    },

    getCompletionContext(scheme, schemeOffset): Promise<SchemeCompletionContext> {
      return serialize(async () => {
        const entries = completionEntries(scheme, schemeOffset);
        const [aStart] = atomBoundsAt(scheme, schemeOffset);
        const slot = scanInnermostCall(scheme.slice(0, schemeOffset));
        const position: SchemeCompletionContext["position"] =
          slot === null
            ? scheme.slice(0, aStart).trimEnd().endsWith("(")
              ? "operator"
              : "top"
            : slot.callee === null
              ? "operator"
              : "argument";
        let verdicts: boolean[] | null = null;
        let slotCard: SchemeCompletionContext["slot"];
        if (position === "argument") {
          const v = await slotVerdicts(
            scheme,
            schemeOffset,
            entries.map((e) => e.name),
          );
          if (v !== null) {
            verdicts = v.verdicts;
            slotCard = {
              callee: v.callee,
              argIndex: v.argIndex,
              ...(v.paramType === undefined ? {} : { paramType: v.paramType }),
            };
          }
        }
        const rich: SchemeRichCompletion[] = entries.map((e, i) => {
          const detail = builtinSigs.get(e.name);
          const fits = verdicts?.[i];
          return {
            ...e,
            ...(detail === undefined ? {} : { detail, callable: CALLABLE_SIG.test(detail) }),
            ...(detail === undefined && e.kind === "function" ? { callable: true } : {}),
            ...(fits === undefined ? {} : { fits }),
          };
        });
        return { position, ...(slotCard === undefined ? {} : { slot: slotCard }), entries: rich };
      });
    },

    getDefinitionAtPosition(scheme, schemeOffset): Promise<SchemeDefinition[]> {
      const [aStart, aEnd] = atomBoundsAt(scheme, schemeOffset);
      if (aStart === aEnd) return Promise.resolve([]);
      const name = scheme.slice(aStart, aEnd);
      const local = bindingsAt(parsedForest(scheme), schemeOffset)
        .filter((b) => b.name === name)
        // params (innermost) win over defines; later defines shadow earlier.
        .toSorted((a, b) => (a.kind === b.kind ? a.span.start - b.span.start : a.kind === "param" ? 1 : -1))
        .at(-1);
      if (local !== undefined)
        return Promise.resolve([{ name, kind: local.kind === "param" ? "parameter" : "const", span: local.span }]);
      // A required file's define — search the project table (dep coordinates).
      for (const ref of scanRequireRefs(scheme)) {
        const source = resolveModule(ref.path);
        if (source === null) continue;
        const dep = bindingsAt(parsedForest(source), null).findLast((b) => b.name === name && b.kind === "define");
        if (dep !== undefined) return Promise.resolve([{ name, kind: "const", span: dep.span, file: ref.path }]);
      }
      if (builtins.has(name)) return Promise.resolve([{ name, kind: "method", span: null }]);
      return Promise.resolve([]);
    },

    getSemanticClassifications(scheme): Promise<SchemeClassifiedSpan[]> {
      return serialize(async () => {
        const { mapper } = await loadSource(scheme);
        // A const that BINDS A LAMBDA classifies as "function" (the tsc
        // classifier's verdict for const-arrows) — the reader knows which
        // defines are lambdas; symbol flags alone say only "variable".
        const callableDefines = new Set(
          bindingsAt(parsedForest(scheme), null)
            .filter((b) => b.callable)
            .map((b) => b.name),
        );
        // Candidate tokens: every use-site atom (binder forms classify via the
        // lexical layer, mirroring service-core's token-faithful-only rule).
        const atoms: { start: number; length: number }[] = [];
        const seenAt = new Set<number>();
        const walk = (form: Node): void => {
          if (isAtom(form)) {
            const span = form.span;
            if (span !== undefined && !seenAt.has(span[0]) && SCHEME_ATOM.test(form.atom)) {
              seenAt.add(span[0]);
              atoms.push({ start: span[0], length: span[1] - span[0] });
            }
            return;
          }
          if (isList(form)) for (const c of form.list) walk(c);
        };
        for (const f of parsedForest(scheme)) walk(f);
        const mapped = atoms
          .map((a) => ({ ...a, tsOffset: mapper.toTs(a.start) }))
          .filter((a): a is typeof a & { tsOffset: number } => a.tsOffset !== null);
        if (mapped.length === 0) return [];
        const symbols = await client.request<(SymbolRef | null)[]>("getSymbolsAtPositions", {
          ...world,
          file: programPath,
          positions: mapped.map((a) => a.tsOffset),
        });
        const out: SchemeClassifiedSpan[] = [];
        for (const [i, a] of mapped.entries()) {
          const sym = symbols[i];
          if (sym === null || sym === undefined) continue;
          // Our emit never produces `var`: FunctionScopedVariable(1) ⇒ a
          // PARAMETER; BlockScopedVariable(2) ⇒ a const (a lambda-binding
          // const presents as "function"); Function(16) ⇒ fn.
          const name = scheme.slice(a.start, a.start + a.length);
          const kind =
            (sym.flags & 1) === 0
              ? (sym.flags & 2) === 0
                ? (sym.flags & 16) === 0
                  ? null
                  : "function"
                : callableDefines.has(name)
                  ? "function"
                  : "variable"
              : "parameter";
          if (kind === null) continue;
          out.push({ start: a.start, length: a.length, kind });
        }
        return out;
      });
    },

    getTypeValidCandidates(scheme, schemeOffset, candidates): Promise<string[]> {
      return serialize(async () => {
        const pool = [...candidates];
        if (pool.length === 0) return pool;
        const v = await slotVerdicts(scheme, schemeOffset, pool);
        if (v === null) return pool;
        return pool.filter((_, i) => v.verdicts[i]);
      });
    },

    setProjectFiles(next): Promise<void> {
      projectFiles = next;
      return Promise.resolve();
    },

    builtinNames(): readonly string[] {
      return [...builtins];
    },

    dispose(): void {
      client.close();
    },
  };
}
