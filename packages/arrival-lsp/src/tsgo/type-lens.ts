// tsgo/type-lens — Layer T over the tsgo (TypeScript 7) checker: the vertical
// slice of the backend re-platforming, implementing the sampler's
// `getTypeValidCandidates` (the Σ∩T type gate) WITHOUT the JS LanguageService.
//
// TWO INVERSIONS vs service-core's machinery, one deliberate non-inversion:
//   • the CALL SLOT (callee + argIndex) is read off the SCHEME prefix by a
//     lexer-faithful scan (`scanInnermostCall`) — no sentinel atom, no TS AST
//     walk; we own the structure.
//   • verdicts are read from DIAGNOSTICS, not from `typeToString` over a probe
//     tuple — the ~160-char truncation bug class is structurally gone.
//   • the verdict itself STAYS in the type system's own inference: the probe
//     embeds service-core's `__ok<T>` conditional VERBATIM, so generic
//     instantiation is identical BY CONSTRUCTION. Two rejected drafts of this
//     file prove both halves are load-bearing: (a) direct
//     `isTypeAssignableTo(typeof C, __E)` compares FREE type parameters
//     (`car<T>(xs: List<T>): T` — `List<T2>` ⇸ `List<T>`) and narrowed every
//     generic slot to ∅, where `Parameters<>`/`extends` instantiate through
//     inference; (b) a two-line direct/return-unwrap OR missed `__ok`'s
//     TRI-STATE — a generic whose return instantiates to `any` collapses the
//     conditional to `boolean` ("unprovable"), which `__ok` defers to the
//     direct test (the `@` builtin is the witness).
//
// The tri-state is read with TWO assignment-tests per candidate:
//   const __vNt: true  = … as __ok<C>;   const __vNf: false = … as __ok<C>;
// `true` ⇒ t-line clean ⇒ KEEP. `false` ⇒ only f-line clean ⇒ DROP. `boolean`
// (unprovable / error-any from an unresolved name) ⇒ BOTH error ⇒ KEEP — the
// conservative contract (drop only the PROVEN ill-typed) falls out of the
// encoding with no error-code sniffing.
//
// Parity note (full-service port, not this slice): service-core's probe rode
// on `loadSource`, which first runs the param-annotation inference pass; this
// slice probes over the bare emit, so an UNANNOTATED lambda param stays `any`
// on both sides of the verdict — same keeps, one fewer narrowing source.
//
// Snapshot discipline: handle ids are snapshot-scoped, but this design needs
// only STRINGS across snapshots (the ArrShape member NAMES, read once at
// boot); each call loads one program+probe snapshot, reads diagnostics, and
// releases the predecessor. Calls serialize through a small mutex.

import { emitTypes } from "@here.build/arrival-chain-view/types-emit";

import { balancePrefix } from "../service-core.js";
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
  type TypeRef,
  type UpdateSnapshotResult,
} from "./client.js";

// ── the scheme-side call-slot scanner ────────────────────────────────────────

/** The argument slot the cursor sits in: the enclosing call's head atom (null
 *  when the head is not a plain atom — a string, a nested form — which the
 *  type layer treats as un-typeable ⇒ no narrowing) and the 0-based argument
 *  index. A partial atom AT the cursor occupies its slot but is not counted
 *  (the "stripped" semantics the typed-scanner's slot-prefix memoization
 *  already imposes). */
export interface CallSlot {
  callee: string | null;
  argIndex: number;
}

// An atom character — arrival's lexer: not whitespace / bracket / string /
// quote / comment. (Same class as service-core's ATOM_CHAR.)
const ATOM_CHAR = /[^\s()[\]{}"';]/;

/**
 * Scan an (incomplete) scheme PREFIX and return the innermost open call slot
 * at its end, or null when the cursor is not at a call's argument (top level,
 * operator position, no open form). String- / comment- / char-literal-aware,
 * matching `balancePrefix`'s lexer model. Purely lexical: special forms are
 * NOT distinguished here — `(define x ⟨cur⟩)` reports callee "define", which
 * then fails VALUE typing and conservatively keeps everything, the same net
 * verdict the TS-AST route produced via its non-call emit.
 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- a lexer state machine; the states ARE the function, splitting them apart hides the automaton
export function scanInnermostCall(prefix: string): CallSlot | null {
  interface Frame {
    headTaken: boolean;
    headAtom: string | null;
    completed: number;
  }
  const frames: Frame[] = [];
  let atom: string | null = null;
  let inString = false;
  let escape = false;
  let inLineComment = false;
  let blockDepth = 0;

  const deliverItem = (headCandidate: string | null): void => {
    const frame = frames.at(-1);
    if (frame === undefined) return;
    if (frame.headTaken) frame.completed += 1;
    else {
      frame.headTaken = true;
      frame.headAtom = headCandidate;
    }
  };
  const finishAtom = (): void => {
    if (atom === null) return;
    const text = atom;
    atom = null;
    deliverItem(text);
  };

  for (let i = 0; i < prefix.length; i++) {
    const c = prefix[i]!;
    if (inLineComment) {
      if (c === "\n") inLineComment = false;
      continue;
    }
    if (blockDepth > 0) {
      if (c === "#" && prefix[i + 1] === "|") {
        blockDepth += 1;
        i += 1;
      } else if (c === "|" && prefix[i + 1] === "#") {
        blockDepth -= 1;
        i += 1;
      }
      continue;
    }
    if (inString) {
      if (escape) escape = false;
      else if (c === "\\") escape = true;
      else if (c === '"') {
        inString = false;
        deliverItem(null); // a closed string is an item (never a named head)
      }
      continue;
    }
    if (c === "#" && prefix[i + 1] === "\\") {
      // char literal: `#\(`/`#\space` — the next char is payload, then the
      // normal atom rule keeps accumulating any trailing letters.
      atom = `${atom ?? ""}#\\${prefix[i + 2] ?? ""}`;
      i += 2;
      continue;
    }
    if (c === '"') {
      finishAtom();
      inString = true;
      continue;
    }
    if (c === ";") {
      finishAtom();
      inLineComment = true;
      continue;
    }
    if (c === "#" && prefix[i + 1] === "|") {
      finishAtom();
      blockDepth = 1;
      i += 1;
      continue;
    }
    if (c === "(" || c === "[") {
      finishAtom();
      frames.push({ headTaken: false, headAtom: null, completed: 0 });
      continue;
    }
    if (c === ")" || c === "]") {
      finishAtom();
      if (frames.length > 0) {
        frames.pop();
        deliverItem(null); // a completed form is an item (never a named head)
      }
      continue;
    }
    if (ATOM_CHAR.test(c)) {
      atom = (atom ?? "") + c;
      continue;
    }
    // whitespace and quote glue (' ` ,) end the current atom; the glue itself
    // is not an item — the next atom/form carries the count.
    finishAtom();
  }

  const frame = frames.at(-1);
  if (frame === undefined) return null; // top level
  if (!frame.headTaken) return null; // typing/awaiting the operator
  return { callee: frame.headAtom, argIndex: frame.completed };
}

// ── the tsgo-backed type lens ────────────────────────────────────────────────

const MOUNT = "/virtual";
const TSCONFIG_PATH = `${MOUNT}/tsconfig.json`;

// service-core's typeofRef gate: identifier-shaped names may resolve as
// program locals; everything else types only through the ambient `__arr`.
const IDENTIFIER_SHAPED = /^[A-Z_$][\w$]*$/i;

/** A `typeof` reference for a name — builtins (and any non-identifier name)
 *  through the ambient `__arr`; identifier-shaped non-builtins by name
 *  (program locals; unresolved → 2304, error-any, kept). Mirrors
 *  service-core's `typeofRef` exactly. */
function typeofRef(name: string, builtinNames: ReadonlySet<string>): string {
  if (!builtinNames.has(name) && IDENTIFIER_SHAPED.test(name)) return `typeof ${name}`;
  return `typeof __arr[${JSON.stringify(name)}]`;
}

/** One candidate's probe location in the assembled module: its `: true` and
 *  `: false` assignment-test statements. */
interface TriStateSpan {
  tStart: number;
  tEnd: number;
  fStart: number;
  fEnd: number;
}

/** Read the `__ok` tri-state off the diagnostics. DROP ⇔ `false` ⇔ the
 *  t-line errors while the f-line is clean; `true` and `boolean` (unprovable
 *  / error-any from 2304/2339 resolution failures — both lines error) KEEP. */
function readTriStateVerdicts(diagnostics: readonly TsgoDiagnostic[], spans: readonly TriStateSpan[]): boolean[] {
  const errorsIn = (start: number, end: number): boolean => diagnostics.some((d) => d.pos < end && d.end > start);
  return spans.map(({ tStart, tEnd, fStart, fEnd }) => !(errorsIn(tStart, tEnd) && !errorsIn(fStart, fEnd)));
}

export interface TsgoTypeLensOptions {
  /** The prelude file map (PRE + builtin leaves) — `getPreludeFiles()` (Node)
   *  or `getBundledPreludeFiles()` (browser). */
  preludeFiles: Map<string, string>;
  /** A connected transport to `tsgo --api -async -callbacks …`. */
  transport: TsgoTransport;
}

/** The async twin of service-core's Layer-T method (and of the typed-scanner's
 *  `TypeLens` contract), served by the tsgo checker. */
export interface TsgoTypeLens {
  getTypeValidCandidates(scheme: string, schemeOffset: number, candidates: readonly string[]): Promise<string[]>;
  /** The builtin roster (ArrShape member names) — also the emitter's member
   *  set; exposed for tests/diagnostics. */
  builtinNames(): readonly string[];
  dispose(): void;
}

export async function createTsgoTypeLens(options: TsgoTypeLensOptions): Promise<TsgoTypeLens> {
  const files = new Map<string, string>();
  const preludeNames: string[] = [];
  for (const [name, content] of options.preludeFiles) {
    files.set(`${MOUNT}/${name}`, content);
    preludeNames.push(name);
  }
  files.set(
    TSCONFIG_PATH,
    JSON.stringify({
      compilerOptions: {
        strict: true,
        target: "es2022",
        lib: ["es2022"],
        types: [],
        noEmit: true,
        skipLibCheck: true,
      },
      files: [...preludeNames, PROGRAM_FILE],
    }),
  );
  const programPath = `${MOUNT}/${PROGRAM_FILE}`;
  files.set(programPath, "export {};\n");

  const client: TsgoClient = createTsgoClient(options.transport, { files, roots: [MOUNT, "/"] });
  await client.request("initialize");

  let world: { snapshot: SnapshotId; project: ProjectId };
  {
    const snap = await client.request<UpdateSnapshotResult>("updateSnapshot", { openProject: TSCONFIG_PATH });
    const project = snap.projects.at(0);
    if (project === undefined) throw new Error("tsgo lens: updateSnapshot returned no project");
    world = { snapshot: snap.snapshot, project: project.id };
  }

  // The ArrShape member NAMES (real scheme names — `car`, `string-append`,
  // `+`, `odd?`, host tools), read ONCE: the prelude is constant for the
  // lens's lifetime, and names (unlike handle ids) survive snapshots. This is
  // the same single-source-of-truth read service-core derives via its
  // `__arr[""]` completion probe.
  const builtins = await (async (): Promise<Set<string>> => {
    const arr = await client.request<SymbolRef | null>("resolveName", {
      ...world,
      name: "__arr",
      file: programPath,
      position: 0,
      meaning: SYMBOL_FLAGS_VALUE,
    });
    if (arr === null)
      throw new Error(
        "tsgo lens: '__arr' did not resolve in the virtual project — the PRE prelude (__pre.d.ts) is missing from preludeFiles or failed to load",
      );
    const arrType = await client.request<TypeRef>("getTypeOfSymbol", { ...world, symbol: arr.id });
    const members = await client.request<SymbolRef[]>("getPropertiesOfType", { ...world, type: arrType.id });
    return new Set(members.map((m) => m.name).filter((n) => !n.startsWith("__")));
  })();

  /** Install a program text and return the world to query it in; the
   *  predecessor snapshot is released (fire-and-forget). */
  async function loadProgram(text: string): Promise<{ snapshot: SnapshotId; project: ProjectId }> {
    files.set(programPath, text);
    const previous = world.snapshot;
    const snap = await client.request<UpdateSnapshotResult>("updateSnapshot", {
      fileChanges: { changed: [programPath] },
    });
    const project = snap.projects.at(0);
    if (project === undefined) throw new Error("tsgo lens: updateSnapshot returned no project");
    world = { snapshot: snap.snapshot, project: project.id };
    if (previous !== world.snapshot) client.request("release", { snapshot: previous }).catch(() => undefined);
    return world;
  }

  // Serialize calls: each load releases the previous snapshot, so a world must
  // never be queried after the next load begins.
  let chain: Promise<unknown> = Promise.resolve();
  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const next = chain.then(task, task);
    chain = next.catch(() => undefined);
    return next;
  };

  return {
    getTypeValidCandidates(scheme, schemeOffset, candidates): Promise<string[]> {
      return serialize(async () => {
        const pool = [...candidates];
        if (pool.length === 0) return pool;
        const slot = scanInnermostCall(scheme.slice(0, schemeOffset));
        if (slot?.callee == null) return pool; // not a call argument ⇒ Σ owns it
        const calleeRef = typeofRef(slot.callee, builtins);

        // The probe module: the emitted program (locals stay in scope), the
        // slot's expected type __E, service-core's __ok<T> VERBATIM (fits =
        // the value, or a call's RETURN, is assignable — `[x]`-tuple wrapping
        // defeats union distribution), and per candidate the tri-state read.
        const emitted = emitTypes(balancePrefix(scheme), { hostMembers: builtins }).ts;
        let text =
          `${emitted}\n` +
          `type __ok<T> = (([T] extends [(...a: any[]) => infer R] ? ([R] extends [__E] ? true : false) : false) extends true ? true ` +
          `: ([T] extends [__E] ? true : false));\n`;
        const eStart = text.length;
        text += `type __E = Parameters<${calleeRef}>[${slot.argIndex}];\n`;
        const eEnd = text.length;
        const spans: TriStateSpan[] = [];
        for (const [i, name] of pool.entries()) {
          const ref = typeofRef(name, builtins);
          const tStart = text.length;
          text += `const __v${i}t: true = undefined as unknown as __ok<${ref}>;\n`;
          const tEnd = text.length;
          text += `const __v${i}f: false = undefined as unknown as __ok<${ref}>;\n`;
          spans.push({ tStart, tEnd, fStart: tEnd, fEnd: text.length });
        }

        const w = await loadProgram(text);
        const diagnostics = await client.request<TsgoDiagnostic[]>("getSemanticDiagnostics", {
          ...w,
          file: programPath,
        });

        // The slot side couldn't be proven (callee not a value / not callable /
        // no such parameter) ⇒ __E errors ⇒ keep everything — T never ADDS a
        // wrong restriction.
        if (diagnostics.some((d) => d.pos < eEnd && d.end > eStart)) return pool;

        const verdicts = readTriStateVerdicts(diagnostics, spans);
        return pool.filter((_, i) => verdicts[i]);
      });
    },
    builtinNames(): readonly string[] {
      return [...builtins];
    },
    dispose(): void {
      client.close();
    },
  };
}
