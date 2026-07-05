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

import { emitTypes } from "@inhuman-tools/mercury/types-emit";

import { balancePrefix, stringLiteralType } from "../balance.js";
import { PROGRAM_FILE } from "../virtual-files.js";
import {
  createTsgoClient,
  SYMBOL_FLAGS_VALUE,
  type ProjectId,
  type SnapshotId,
  type SymbolRef,
  type TsgoClient,
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

/** The TYPE EXPRESSION a candidate contributes to `__ok<…>`. Mirrors
 *  service-core's `typeofRef` EXACTLY (tsgo-equivalence): a STRING-LITERAL
 *  candidate (`"thai"`) → the literal type itself (so an enum-union slot proves
 *  it IN/OUT, not the kept-blind `typeof __arr["\"thai\""]`=any); an
 *  identifier-shaped non-builtin → `typeof <name>` (a program local; unresolved
 *  → 2304, error-any, kept); everything else (builtins, kebab/operator names)
 *  → `typeof __arr["…"]`. A callee is never string-shaped (`scanInnermostCall`
 *  reports a string head as `null`), so the literal branch is a no-op there. */
function typeofRef(name: string, builtinNames: ReadonlySet<string>): string {
  const lit = stringLiteralType(name);
  if (lit !== null) return lit;
  if (!builtinNames.has(name) && IDENTIFIER_SHAPED.test(name)) return `typeof ${name}`;
  return `typeof __arr[${JSON.stringify(name)}]`;
}

/** Map one verdict alias's resolved type to keep/drop. The alias is
 *  `[__ok<C>] extends [false] ? 3 : ([__ok<C>] extends [true] ? 1 : 2)` —
 *  DROP only on the definite literal `3` (its Value rides TypeResponse);
 *  `1`/`2`, unions (an error-any `C` distributes into `3 | 1 | 2` with no
 *  single value), `any` and anything unresolved all KEEP — the conservative
 *  contract falls out of the encoding. Two wire facts, found the hard way:
 *  the drop sentinel must be NON-ZERO (Value is `json:"value,omitempty"` —
 *  a literal `0` arrives with no value field, silently keeping every drop),
 *  and TypeFlags must not be consulted (tsgo renumbered the enum — strada's
 *  NumberLiteral=256 is 2048 there; `value === 3` needs no flag at all). */
function verdictOf(type: { value?: unknown } | null | undefined): boolean {
  return type?.value !== 3;
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
  /** Is the argument slot at `schemeOffset` a LIST/array TS type? `true` ⇒ the
   *  slot's `__E` extends `readonly unknown[]` (incl. a tuple like `[number,
   *  number]` — a list materializer slot), `false` ⇒ it does not, `null` ⇒
   *  unresolved (not a typed-call argument / unknown callee / un-nameable
   *  type). Feeds the sampler's PRECISE list-structure gate via the async typed
   *  scanner's `slotIsArray` stamp; `null` leaves the gate a no-op. */
  getSlotIsArray(scheme: string, schemeOffset: number): Promise<boolean | null>;
  /** Does the argument slot at `schemeOffset` ADMIT A BARE WORD AS A STRING VALUE? `true` ⇒ `__E` is
   *  not an array AND a plain `string` is assignable to it (`string` / `any` / `unknown`), so a bare
   *  value-word is a fair string materialization and the Σ gate exempts it here; `false` ⇒ number /
   *  boolean / object / array (a bare word stays masked); `null` ⇒ unresolved. Feeds the sampler's
   *  scalar-string Σ exemption via the async typed scanner's `slotIsStringy` stamp; `null` leaves the
   *  exemption inert. ENUM slots resolve `false` (the union is not `string`-assignable), which is correct —
   *  enum members are bound value-symbols that pass Σ unaided. */
  getSlotAcceptsBareWord(scheme: string, schemeOffset: number): Promise<boolean | null>;
  /** The ELEMENT-type verdict at an array-element cursor (CUT A). NODE-ONLY today (needs a contextual-type
   *  RPC the tsgo wasm surface lacks) — the tsgo lens returns `{ null, null }` (inert), so the array-element
   *  force-quote / enum-narrow gate is a no-op on the browser path. The node `service-core` lens implements
   *  it for both surfaces (the bfcl eval path). See `OracleState.elementIsStringy`. */
  getSlotElementType(
    scheme: string,
    schemeOffset: number,
  ): Promise<{ isStringy: boolean | null; enum: string[] | null }>;
  /** Does HEAD `head` (resolved in `scheme`'s scope) PROVABLY return a list/array? `true` ⇒
   *  `ReturnType<typeof head>` extends `readonly unknown[]` (a `list`/`vector`/`append` materializer),
   *  `false` ⇒ it provably does not (an element-returning `car`/`first`/accessor, OR a non-callable),
   *  `null` ⇒ unresolved. The ReturnType twin of {@link getSlotIsArray}; feeds the sampler's
   *  type-reachability gate (`arrayReturningHeads`). The gate masks ONLY on `true`, so `false`/`null` both
   *  ADMIT — the SOUND dual of a `ReturnType ⊆ T` query (an uninstantiated `car<T>` infers `unknown ⊄ T`,
   *  which a `⊆ T` test would over-drop, cutting the `(car …)` pipe). Slot-independent (no slot argument). */
  getHeadReturnsArray(scheme: string, head: string): Promise<boolean | null>;
  /** Is the argument slot at `schemeOffset` STRING-TYPED — `__E` a subtype of `string` (`string` or a closed
   *  string-literal union) and NOT an array? `true` ⇒ a non-string scalar literal (`#t`/`#f`, a number) is
   *  type-wrong (the structure gate masks it), `false` ⇒ number/boolean/object/array, `null` ⇒ unresolved.
   *  The `[__E] extends [string]` SUBTYPE twin of {@link getSlotAcceptsBareWord}'s `[string] extends [__E]`
   *  assignability test — the separation an enum needs (a string-literal union is `extends string` → true,
   *  but `string` is not assignable to it → acceptsBareWord false). Feeds the gate as `slotIsStringTyped`. */
  getSlotIsStringTyped(scheme: string, schemeOffset: number): Promise<boolean | null>;
  /** The builtin roster (ArrShape member names) — also the emitter's member
   *  set; exposed for tests/diagnostics. */
  builtinNames(): readonly string[];
  dispose(): void;
}

/** Map the `__isArr` alias's resolved type to the tri-state. The alias resolves
 *  to `1` (slot type extends `readonly unknown[]`), `2` (it does not), or — when
 *  `__E` is error-any (unresolved callee / no such parameter) — a UNION with no
 *  single `value` ⇒ `null` (superset-safe: the gate stays a no-op). Same
 *  non-zero-sentinel discipline as {@link verdictOf} (`value` is omitempty). */
function arrayVerdictOf(type: { value?: unknown } | null | undefined): boolean | null {
  return type?.value === 1 ? true : type?.value === 2 ? false : null;
}

/** Map the `__stringy` alias's resolved type to the tri-state (mirror of {@link arrayVerdictOf}): `1` ⇒ the
 *  slot admits a bare word as a string, `2` ⇒ it does not, anything else (error-any `__E` distributing to a
 *  union) ⇒ `null`. Same non-zero-sentinel discipline (`value` is omitempty). */
function stringyVerdictOf(type: { value?: unknown } | null | undefined): boolean | null {
  return type?.value === 1 ? true : type?.value === 2 ? false : null;
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
        // defeats union distribution), and per candidate ONE verdict ALIAS
        // folding the tri-state into a number literal. Verdicts are read with
        // a single batched getTypesAtPositions — DEMAND-driven (the checker
        // computes only the N alias types, the same laziness the JS
        // LanguageService's tuple read had), not a full-program diagnostics
        // pass; this halved the per-slot cost vs the diagnostics encoding.
        const emitted = emitTypes(balancePrefix(scheme), { hostMembers: builtins }).ts;
        let text =
          `${emitted}\n` +
          `type __ok<T> = (([T] extends [(...a: any[]) => infer R] ? ([R] extends [__E] ? true : false) : false) extends true ? true ` +
          `: ([T] extends [__E] ? true : false));\n` +
          `type __E = Parameters<${calleeRef}>[${slot.argIndex}];\n`;
        const positions: number[] = [];
        for (const [i, name] of pool.entries()) {
          const ref = typeofRef(name, builtins);
          positions.push(text.length + "type ".length); // the alias NAME — the node the type is read at
          text += `type __r${i} = [__ok<${ref}>] extends [false] ? 3 : ([__ok<${ref}>] extends [true] ? 1 : 2);\n`;
        }

        const w = await loadProgram(text);
        const types = await client.request<({ flags: number; value?: unknown } | null)[]>("getTypesAtPositions", {
          ...w,
          file: programPath,
          positions,
        });
        // An un-provable slot (callee not a value / not callable / no such
        // parameter) makes __E error-any ⇒ every alias distributes to a
        // non-literal ⇒ verdictOf keeps all — T never ADDS a wrong restriction.
        return pool.filter((_, i) => verdictOf(types[i]));
      });
    },
    getSlotIsArray(scheme, schemeOffset): Promise<boolean | null> {
      return serialize(async () => {
        const slot = scanInnermostCall(scheme.slice(0, schemeOffset));
        if (slot?.callee == null) return null; // not a call argument ⇒ Σ owns it, no structure gate
        const calleeRef = typeofRef(slot.callee, builtins);
        // The slot's expected type __E (same extraction as the verdict probe),
        // then ONE alias folding "__E extends readonly unknown[]" into a numeric
        // literal read by getTypesAtPositions — the same demand-driven, single
        // read the candidate verdicts use. `[__E]`-tuple wrapping defeats union
        // distribution (a `T[] | undefined` optional-list slot stays a list).
        const emitted = emitTypes(balancePrefix(scheme), { hostMembers: builtins }).ts;
        let text = `${emitted}\n` + `type __E = Parameters<${calleeRef}>[${slot.argIndex}];\n`;
        const position = text.length + "type ".length; // the alias NAME — where its resolved type is read
        text += `type __isArr = [__E] extends [readonly unknown[]] ? 1 : 2;\n`;
        const w = await loadProgram(text);
        const types = await client.request<({ flags: number; value?: unknown } | null)[]>("getTypesAtPositions", {
          ...w,
          file: programPath,
          positions: [position],
        });
        return arrayVerdictOf(types[0]);
      });
    },
    getSlotAcceptsBareWord(scheme, schemeOffset): Promise<boolean | null> {
      return serialize(async () => {
        const slot = scanInnermostCall(scheme.slice(0, schemeOffset));
        if (slot?.callee == null) return null; // not a call argument ⇒ Σ owns it, no exemption
        const calleeRef = typeofRef(slot.callee, builtins);
        // The slot's expected type __E (same extraction as getSlotIsArray), then ONE alias folding the
        // bare-word-as-string ladder into a numeric literal: NOT-array AND `string` assignable ⇒ 1 (stringy),
        // else 2. `[__E]`-tuple wrapping defeats union distribution (a `string | undefined` optional slot
        // stays stringy). An enum union resolves 2 (it is not `string`-assignable) — correct, its members are
        // bound value-symbols.
        const emitted = emitTypes(balancePrefix(scheme), { hostMembers: builtins }).ts;
        let text = `${emitted}\n` + `type __E = Parameters<${calleeRef}>[${slot.argIndex}];\n`;
        const position = text.length + "type ".length; // the alias NAME — where its resolved type is read
        text += `type __stringy = [__E] extends [readonly unknown[]] ? 2 : ([string] extends [__E] ? 1 : 2);\n`;
        const w = await loadProgram(text);
        const types = await client.request<({ flags: number; value?: unknown } | null)[]>("getTypesAtPositions", {
          ...w,
          file: programPath,
          positions: [position],
        });
        return stringyVerdictOf(types[0]);
      });
    },
    getSlotElementType(_scheme, _schemeOffset): Promise<{ isStringy: boolean | null; enum: string[] | null }> {
      // CUT A (array-element type recovery) is NODE-ONLY for now: it reads a node's CONTEXTUAL type
      // (`getContextualType` over the live emitted `'(…)` array-literal / `(list …)` materializer call),
      // which the tsgo wasm RPC surface (alias-name reads via `getTypesAtPositions`) does not expose. The
      // tsgo lens is the BROWSER/studio path, NOT the bfcl eval path (which uses the node `service-core`
      // lens, where both surfaces resolve). Return inert so the element gate is a no-op here (superset-safe,
      // browser byte-identical); recovering it over tsgo needs a contextual-type RPC (a later step).
      return Promise.resolve({ isStringy: null, enum: null });
    },
    getHeadReturnsArray(scheme, head): Promise<boolean | null> {
      return serialize(async () => {
        const ref = typeofRef(head, builtins);
        // ONE alias folding "head IS a function AND its return extends readonly unknown[]" into a numeric
        // literal. The array test sits INSIDE the function-arm (`: 2` otherwise): a NON-callable head — a
        // value symbol, an unbound name — must resolve `2` (NOT array, admit), not collapse through a
        // `never` return that `[never] extends [readonly unknown[]]` would mark `1`. Same demand-driven
        // single read as getSlotIsArray. `[…]`-tuple wrapping defeats union distribution.
        const emitted = emitTypes(balancePrefix(scheme), { hostMembers: builtins }).ts;
        let text = `${emitted}\n`;
        const position = text.length + "type ".length; // the alias NAME — where its resolved type is read
        text += `type __isArrRet = [${ref}] extends [(...a: any[]) => infer R] ? ([R] extends [readonly unknown[]] ? 1 : 2) : 2;\n`;
        const w = await loadProgram(text);
        const types = await client.request<({ flags: number; value?: unknown } | null)[]>("getTypesAtPositions", {
          ...w,
          file: programPath,
          positions: [position],
        });
        return arrayVerdictOf(types[0]);
      });
    },
    getSlotIsStringTyped(scheme, schemeOffset): Promise<boolean | null> {
      return serialize(async () => {
        const slot = scanInnermostCall(scheme.slice(0, schemeOffset));
        if (slot?.callee == null) return null; // not a call argument ⇒ no string-typed verdict
        const calleeRef = typeofRef(slot.callee, builtins);
        // The slot's __E, then ONE alias folding the SUBTYPE ladder into a numeric literal: NOT-array AND
        // `__E extends string` ⇒ 1 (string-typed: `string` or a string-literal union), else 2. `[__E]`-tuple
        // wrapping defeats union distribution (a `string | undefined` optional slot stays string-typed).
        const emitted = emitTypes(balancePrefix(scheme), { hostMembers: builtins }).ts;
        let text = `${emitted}\n` + `type __E = Parameters<${calleeRef}>[${slot.argIndex}];\n`;
        const position = text.length + "type ".length; // the alias NAME — where its resolved type is read
        text += `type __strTyped = [__E] extends [readonly unknown[]] ? 2 : ([__E] extends [string] ? 1 : 2);\n`;
        const w = await loadProgram(text);
        const types = await client.request<({ flags: number; value?: unknown } | null)[]>("getTypesAtPositions", {
          ...w,
          file: programPath,
          positions: [position],
        });
        return arrayVerdictOf(types[0]); // 1 ⇒ true (string-typed), 2 ⇒ false, else null — same tri-state map
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
