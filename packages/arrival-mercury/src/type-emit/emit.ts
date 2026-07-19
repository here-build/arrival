/**
 * COPY-AS-CHUNK (constitution §4.5 — greenfield package, never shared imports).
 * Source: arrival/packages/mercury/src/types-emit.ts (already carrying
 * Phase 0's unconditional `__scmTruth` wrap in `emitIf`).
 *
 * Adaptations from the source chunk:
 *   - imports re-homed: parse/desugar/nodes/names/scheme-scope → `../front/` (this
 *     package's copies; `parseSexprs` no longer imports `@inhuman.tools/arrival-sugarcoat`),
 *     stdlib → `./builtins.js` (roster-only reduction).
 *   - Law T upgraded from Phase 0 (wrap EVERY condition) to the §5.3 narrowing-form
 *     grammar: a condition that is an NForm over `opts.narrowsMembers` emits NATIVE
 *     `!`/`&&`/`||`/bare-call so tsc's control-flow narrowing composes; everything
 *     else keeps the `__scmTruth` wrap (type-emit-lawt.md Mechanics §1–2). New:
 *     `EmitTypesOptions.narrowsMembers`, `Ctx.narrowsMembers`, `emitCondition`,
 *     `isNarrowingForm`, `emitNarrowingForm`.
 *   - `emitTypes` additionally accepts a pre-parsed forest (`readonly Node[]`,
 *     `parseSexprs` output — desugar still runs here). The lens pipeline feeds
 *     STRINGS (the required path); an engine already holding the parse forest may
 *     skip re-parsing. A CLASSIFIED forest (CoreForm) is deliberately NOT accepted:
 *     CoreForm nodes don't retain the raw `Node`s this walker (and its Atom-keyed
 *     `nameOf`) consumes — that representation swap is the spec's "CoreForm-era"
 *     slice (type-emit-lawt.md Mechanics §6), byte-compatible by contract.
 *
 * ── original module doc ──────────────────────────────────────────────────────
 *
 * types-emit — the TYPE-FAITHFUL Scheme→TS emitter for the type lens.
 *
 * Distinct from the RUN-faithful idiomatic emitters: this one emits virtual TS
 * that is *type-checked, never run*, against the `@inhuman.tools/arrival-lsp`
 * prelude (`PRE`). Every builtin application lowers to a direct `__arr.<name>(…)`
 * call so TS checks it natively against the merged `ArrShape`; opaque heads fall
 * back to PRE's `sexpr<F>(…)`.
 *
 * Because we never run the output, binding forms lower to PURE TS BLOCK
 * STATEMENTS, not IIFEs — block-scoping is correct for type-checking and adds no
 * function boundary to distort control-flow analysis (by design; see the
 * type-lens README "Emitter contract").
 *
 * It REUSES the front-end (parse → desugar → scope) and produces a span lens:
 * every emitted construct records the IR span it came from, so a tsc diagnostic
 * at a TS offset lifts back onto the right `.scm` form.
 */
import { desugar } from "../front/desugar.js";
import { cleanName } from "../front/names.js";
import {
  type Atom,
  head,
  isAtom,
  isBool,
  isKeyword,
  isList,
  isNil,
  isNumber,
  keywordName,
  type ListNode,
  type Node,
} from "../front/nodes.js";
import { parseSexprs } from "../front/parse.js";
import { resolveNames } from "../front/scheme-scope.js";
import { isBuiltin } from "./builtins.js";

/** One span-lens entry: a [tsStart, tsLength) range of the emitted TS that came
 *  from a [schemeStart, schemeLength) range of the source `.scm`. */
export interface Mapping {
  tsStart: number;
  tsLength: number;
  schemeStart: number;
  schemeLength: number;
}

export interface EmitTypesResult {
  ts: string;
  mappings: Mapping[];
  /** Indices (in source order) of top-level forms whose emit threw and degraded
   *  to an unmapped `unknown` placeholder — so the LSP/host can surface that a
   *  form is unanalyzed without the whole file blanking. */
  droppedForms: number[];
  /** See `Ctx.declaredNames`. */
  declaredNames: Map<string, string>;
}

/** A TS-identifier name (used unbracketed). Anything else is a bracketed string key. */
const TS_IDENT = /^[A-Z_$][\w$]*$/i;

/** Shared empty member set — the default when no host/narrows roster is injected. */
const EMPTY_SET: ReadonlySet<string> = new Set();

/** `__arr.car` for an identifier-safe builtin, `__arr["string-append"]` otherwise. */
const arrMember = (name: string): string => (TS_IDENT.test(name) ? `__arr.${name}` : `__arr[${JSON.stringify(name)}]`);

/**
 * The emit buffer: appends strings while tracking the running TS offset, and
 * records a {@link Mapping} whenever an emitted run carries an IR span. Spans are
 * `[start, end)` half-open (sugarcoat-render) → `schemeLength = end - start`.
 */
class Buf {
  private readonly parts: string[] = [];
  private len = 0;
  readonly mappings: Mapping[] = [];

  /** Append a literal TS chunk (no span). */
  raw(s: string): this {
    if (s.length > 0) {
      this.parts.push(s);
      this.len += s.length;
    }
    return this;
  }

  /** Append `s`, mapping its whole TS extent back to `node`'s IR span (if any). */
  spanned(s: string, node: Node | undefined): this {
    const span = node && (node as { span?: readonly [number, number] }).span;
    if (s.length > 0 && span) {
      this.mappings.push({
        tsStart: this.len,
        tsLength: s.length,
        schemeStart: span[0],
        schemeLength: span[1] - span[0],
      });
    }
    return this.raw(s);
  }

  get offset(): number {
    return this.len;
  }

  toString(): string {
    return this.parts.join("");
  }
}

/** Scope-resolved JS name for a bound identifier occurrence; `cleanName` for free
 *  refs / globals / builtins (absent from `nameOf`). */
type NameOf = Map<Atom, string>;

/**
 * Scan a forest for every identifier that is the target of a `(set! x …)`, by its
 * RESOLVED name — so its `const` declaration becomes a `let`. Reassignment must
 * type-check without widening every binding to `let`, so we only relax the ones
 * actually mutated.
 */
function collectSetBangNames(forest: readonly Node[], nameOf: NameOf): Set<string> {
  const out = new Set<string>();
  const visit = (n: Node): void => {
    if (!isList(n)) return;
    if (head(n) === "set!") {
      const target = n.list[1];
      if (isAtom(target)) out.add(nameOf.get(target) ?? cleanName(target.atom));
    }
    for (const c of n.list) visit(c);
  };
  for (const f of forest) visit(f);
  return out;
}

/** The per-program emit context (shared by every node walk). */
interface Ctx {
  buf: Buf;
  nameOf: NameOf;
  setVars: Set<string>;
  /**
   * Host-injected ambient members (sift's rosetta tools). A head in this set lowers
   * to `__arr["<name>"](…)` exactly like a builtin — so `typeof __arr["<name>"]`
   * resolves against the host's `ArrShape` leaf and `Parameters<…>` of the call
   * narrows the argument slot. The runtime evaluator is unaffected (this emitter is
   * the type-lens only); host tools are conceptually the same category as builtins —
   * ambient functions resolved through `__arr` — so this is the third head case, not
   * a special-case hack. Empty by default → behavior identical to pre-roster emit.
   */
  hostMembers: ReadonlySet<string>;
  /** The narrowing-form grammar's base-case set — see `EmitTypesOptions.narrowsMembers`.
   *  Threaded exactly like `hostMembers`. */
  narrowsMembers: ReadonlySet<string>;
  /** Emitted TS identifier → the ORIGINAL scheme source text it was minted from, populated
   *  at every `define`/`define/overridable` binding site (`emitDefine`). `cleanName` is
   *  lossy/many-to-one (predicate markers `?!*` are stripped, not encoded; `config/audience`,
   *  `config-audience`, `config_audience` all collapse to the same `configAudience`), so a
   *  pure inverse function is impossible — this tracks the mapping AT THE POINT it's minted
   *  instead. Exposed on `EmitTypesResult` so a consumer (autocomplete) can backport an
   *  emitted identifier to what the user actually typed. */
  declaredNames: Map<string, string>;
}

/** Emit a single TS expression for `n` into `ctx.buf`. */
function emitExpr(n: Node, ctx: Ctx): void {
  if (isAtom(n)) return emitAtom(n, ctx);
  if (isList(n)) return emitList(n, ctx);
  // Defensive: an unexpected node shape degrades to a transparent `unknown`.
  ctx.buf.raw("(undefined as unknown)");
}

/** The emitted name for a bound identifier occurrence (namer's, or cleanName). */
function emitName(a: Atom, ctx: Ctx): string {
  return ctx.nameOf.get(a) ?? cleanName(a.atom);
}

function emitAtom(a: Atom, ctx: Ctx): void {
  if (a.str) {
    ctx.buf.spanned(JSON.stringify(decodeString(a.atom)), a);
    return;
  }
  if (isBool(a)) {
    ctx.buf.spanned(a.atom === "#t" ? "true" : "false", a);
    return;
  }
  if (isNumber(a)) {
    ctx.buf.spanned(a.atom, a);
    return;
  }
  // A bare `:keyword` in value position is meaningless (accessor/kwarg-only) —
  // degrade to a transparent `unknown` rather than emit a broken identifier.
  if (a.atom.length > 1 && a.atom.startsWith(":")) {
    ctx.buf.spanned("(undefined as unknown)", a);
    return;
  }
  ctx.buf.spanned(emitName(a, ctx), a);
}

// The object-accessor family. A dict is a primitive object, so these all lower to
// NATIVE indexed access `(obj)["k"]…` — the fast TS path (no generic `keyof O`
// re-derivation per read, which made huge-object reads thrash), biting natively on
// a precise object and transparent on an opaque one (exactly the `(:field obj)`
// sugar). Grouped by arg shape (the runtime arg orders, grounded in ramda-functions.ts).
const ACCESSOR_OBJ_FIRST = new Set(["@"]); //                (@ obj :k)      → obj, key
const ACCESSOR_KEY_FIRST = new Set(["prop", "get", "access", "fetch"]); // (prop :k obj) → key, obj
const ACCESSOR_PATH = new Set(["path", "get-in", "navigate", "dig"]); //   (path KEYS obj) → keys, obj

/** A statically-extractable keyword sequence from `'(:a :b)` (quote) or
 *  `(list :a :b)`, else null — a dynamic path falls back to the generic call. */
function staticKeywordSeq(node: Node | undefined): string[] | null {
  if (!node || !isList(node) || isNil(node)) return null;
  const h = node.list[0];
  let items: readonly Node[];
  if (isAtom(h) && h.atom === "quote") {
    const inner = node.list[1];
    if (!inner || !isList(inner)) return null;
    items = inner.list;
  } else if (isAtom(h) && h.atom === "list") {
    items = node.list.slice(1);
  } else {
    return null;
  }
  const keys: string[] = [];
  for (const it of items) {
    if (!isKeyword(it)) return null;
    keys.push(keywordName(it));
  }
  return keys;
}

/** Lower an accessor head to native indexed access; false → caller emits the
 *  generic `__arr.<name>(…)` call (dynamic key/path, or wrong arity). */
function tryEmitAccessor(hName: string, n: ListNode, ctx: Ctx): boolean {
  const a = n.list.slice(1);
  let obj: Node | undefined;
  let keys: string[] | null;
  if (ACCESSOR_OBJ_FIRST.has(hName)) {
    obj = a[0];
    keys = a[1] && isKeyword(a[1]) ? [keywordName(a[1])] : null;
  } else if (ACCESSOR_KEY_FIRST.has(hName)) {
    keys = a[0] && isKeyword(a[0]) ? [keywordName(a[0])] : null;
    obj = a[1];
  } else {
    keys = staticKeywordSeq(a[0]);
    obj = a[1];
  }
  if (keys === null || keys.length === 0 || obj === undefined) return false;
  const start = ctx.buf.offset;
  ctx.buf.raw("(");
  emitExpr(obj, ctx);
  ctx.buf.raw(")");
  for (const k of keys) ctx.buf.raw(`[${JSON.stringify(k)}]`);
  recordSpan(ctx, start, n);
  return true;
}

function emitList(n: ListNode, ctx: Ctx): void {
  if (isNil(n)) {
    ctx.buf.spanned("[]", n);
    return;
  }
  const h = n.list[0]!;

  // `(:field obj)` accessor → `(obj)["field"]`. Direct member access is checked
  // natively by TS against a precise dict (and is `unknown`-transparent on an
  // opaque row), so it bites on the field-access moat without a runtime helper.
  if (isKeyword(h)) {
    const obj = n.list[1];
    const start = ctx.buf.offset;
    ctx.buf.raw("(");
    if (obj) emitExpr(obj, ctx);
    else ctx.buf.raw("undefined as unknown");
    ctx.buf.raw(`)[${JSON.stringify(keywordName(h))}]`);
    recordSpan(ctx, start, n);
    return;
  }

  const hName = isAtom(h) && !h.str ? h.atom : undefined;
  if (hName !== undefined) {
    switch (hName) {
      case "quote":
        return emitQuote(n.list[1], ctx, n);
      case "lambda":
        return emitLambda(n, ctx);
      case "if":
        return emitIf(n, ctx);
      case "let":
      case "let*":
      case "letrec":
      case "letrec*":
        // A let in EXPRESSION position has no statement-block placement; type-
        // faithfully it is its body's value. We emit the body expression directly
        // (the binding forms are checked as a block only at statement position —
        // see emitTopLet). For an expression-position let, fall through to a
        // transparent value so the file never blanks. The common case (let at a
        // body/top position) is handled by emitStmt.
        return emitLetExpr(n, ctx);
      case "begin":
        return emitBeginExpr(n, ctx);
      case "dict":
        return emitDict(n, ctx);
      case "set!":
        return emitSetExpr(n, ctx);
      case "define":
      case "define/overridable":
        // An internal define in expression position is not meaningful here.
        ctx.buf.spanned("(undefined as unknown)", n);
        return;
    }
    // A locally-bound head (a user `(define (concat …))`) SHADOWS builtins, host
    // members, and accessors — standard scope: the user's definition wins over the
    // ambient name. `nameOf.get(h)` is set iff `h` resolves to a binding. Without
    // this, adding a builtin leaf for a common name (`concat`, `prop`, `get`)
    // silently captures a user's same-named function and breaks infer-from-consumers.
    // (Syntactic special forms above are reserved and not shadowed here.)
    const headBound = isAtom(h) && ctx.nameOf.get(h) !== undefined;
    if (!headBound) {
      // The object-accessor family → native indexed access (fast path). Falls
      // through to the generic call below when the key/path is dynamic.
      if (
        (ACCESSOR_OBJ_FIRST.has(hName) || ACCESSOR_KEY_FIRST.has(hName) || ACCESSOR_PATH.has(hName)) &&
        tryEmitAccessor(hName, n, ctx)
      ) {
        return;
      }
      // A builtin OR a host-injected rosetta tool → ambient `__arr` member call.
      if (isBuiltin(hName) || ctx.hostMembers.has(hName)) return emitBuiltinCall(hName, n, ctx);
    }
  }

  // A non-builtin head: a local binding / free fn → direct call `f(a, b)`; an
  // opaque/computed head (e.g. `((car fns) x)`) → the `sexpr` fallback.
  return emitCall(h, n.list.slice(1), ctx, n);
}

/** Record a mapping covering `[start, buf.offset)` back to `node`'s span. */
function recordSpan(ctx: Ctx, start: number, node: Node): void {
  const span = (node as { span?: readonly [number, number] }).span;
  if (!span) return;
  const tsLength = ctx.buf.offset - start;
  if (tsLength > 0) {
    ctx.buf.mappings.push({ tsStart: start, tsLength, schemeStart: span[0], schemeLength: span[1] - span[0] });
  }
}

function emitBuiltinCall(name: string, n: ListNode, ctx: Ctx): void {
  const start = ctx.buf.offset;
  ctx.buf.raw(arrMember(name)).raw("(");
  emitArgs(n.list.slice(1), ctx);
  ctx.buf.raw(")");
  recordSpan(ctx, start, n);
}

/** A call whose head is NOT a builtin: a typed local / free fn → direct call;
 *  an opaque computed head → `sexpr(head, …args)`. */
function emitCall(fn: Node, args: Node[], ctx: Ctx, form: ListNode): void {
  const start = ctx.buf.offset;
  if (isAtom(fn) && !fn.str) {
    // A named head — emit a direct call `f(a, b)`. TS checks it against the
    // binding's inferred type (or `any` if free), which is the faithful behavior.
    emitExpr(fn, ctx);
    ctx.buf.raw("(");
    emitArgs(args, ctx);
    ctx.buf.raw(")");
  } else {
    // Opaque / computed head → the typed-apply fallback so arg↔param checking is
    // preserved across the indirect application.
    ctx.buf.raw("sexpr(");
    emitExpr(fn, ctx);
    for (const a of args) {
      ctx.buf.raw(", ");
      emitExpr(a, ctx);
    }
    ctx.buf.raw(")");
  }
  recordSpan(ctx, start, form);
}

/** Comma-separated argument expressions. Keyword args `(:k v)` collapse into a
 *  single trailing options object `{ k: v }`, mirroring the call convention. */
function emitArgs(args: Node[], ctx: Ctx): void {
  const positional: Node[] = [];
  const kwargs: [string, Node][] = [];
  let i = 0;
  while (i < args.length && !isKeyword(args[i])) positional.push(args[i++]!);
  while (i < args.length) {
    const k = args[i]!;
    if (!isKeyword(k)) {
      // A positional after a keyword is malformed; degrade transparently.
      positional.push(k);
      i += 1;
      continue;
    }
    const v = args[i + 1];
    kwargs.push([keywordName(k), v ?? { atom: "#f" }]);
    i += 2;
  }
  for (const [idx, p] of positional.entries()) {
    if (idx > 0) ctx.buf.raw(", ");
    emitExpr(p, ctx);
  }
  if (kwargs.length > 0) {
    if (positional.length > 0) ctx.buf.raw(", ");
    ctx.buf.raw("{ ");
    for (const [idx, [k, v]] of kwargs.entries()) {
      if (idx > 0) ctx.buf.raw(", ");
      ctx.buf.raw(`${tsKey(cleanName(k))}: `);
      emitExpr(v, ctx);
    }
    ctx.buf.raw(" }");
  }
}

/** A safe object key: bare identifier, or quoted string for anything else. */
function tsKey(k: string): string {
  return TS_IDENT.test(k) ? k : JSON.stringify(k);
}

function emitDict(n: ListNode, ctx: Ctx): void {
  const start = ctx.buf.offset;
  const args = n.list.slice(1);
  // `(dict :k v …)` → `{ k: v, … }` — a DIRECT object literal type. A dict is a
  // special primitive (an object), NOT an alist of pairs: it has no car/cdr, so we
  // model it as the object it is, not via a `Dict<Pairs>` mapped remap over an
  // entry-tuple. TS infers the object literal's type directly — the fast path TS
  // optimizes — and reads (`(:k d)` / native index) resolve against it natively.
  // The mapped-remap form was ~1.5× costlier to construct and forced the giant
  // `keyof`/union machinery that made huge-JSON integration thrash. Keys use raw
  // `keywordName` (NOT cleanName) so they match the `(:field obj)` accessor's index
  // key (`obj["field"]`, emitList) — construct-key and read-key MUST agree.
  ctx.buf.raw("{ ");
  let first = true;
  for (let i = 0; i + 1 < args.length; i += 2) {
    const k = args[i]!;
    const key = isKeyword(k) ? keywordName(k) : isAtom(k) ? k.atom : "";
    if (!first) ctx.buf.raw(", ");
    first = false;
    ctx.buf.raw(`${tsKey(key)}: `);
    emitExpr(args[i + 1]!, ctx);
  }
  ctx.buf.raw(first ? "}" : " }");
  recordSpan(ctx, start, n);
}

function emitIf(n: ListNode, ctx: Ctx): void {
  const start = ctx.buf.offset;
  const [, c, a, b] = n.list;
  // Law T (truthiness), type side (§5.2/§5.3): the condition slot has its OWN
  // emission path, distinct from value position — see emitCondition. Every `if`,
  // wherever it sits, classifies its own condition independently (a nested
  // `(if (if a b c) x y)` wraps at both levels). The `(`/`" ? "` literals, arm
  // emission, and the outer recordSpan are Phase-0-identical.
  ctx.buf.raw("(");
  if (c) emitCondition(c, ctx);
  else ctx.buf.raw("undefined as unknown");
  ctx.buf.raw(" ? ");
  if (a) emitExpr(a, ctx);
  else ctx.buf.raw("(undefined as unknown)");
  ctx.buf.raw(" : ");
  if (b) emitExpr(b, ctx);
  else ctx.buf.raw("(undefined as unknown)");
  ctx.buf.raw(")");
  recordSpan(ctx, start, n);
}

/**
 * Law T's dispatcher — `if`'s condition slot (type-emit-lawt.md Mechanics §1).
 *
 * A narrowing form emits NATIVE so tsc's control-flow narrowing composes; every
 * other condition wraps in `__scmTruth` (`(x: unknown) => boolean` — declared by
 * the LENS PRELUDE, arrival-lsp `src/prelude/types.d.ts`; this emitter only
 * REFERENCES it, never declares it). The plain-boolean wrapper carries no type
 * information back onto its argument, which blocks truthiness NARROWING of arm
 * references to the tested value — `(if x x 'fallback)` must not drop the
 * Scheme-truthy `0`/`""` from the true arm's type (§5.1's reproducible shape).
 * Deliberately not `x is Exclude<T, false>`: for a literal never itself `false`,
 * that excludes nothing forward and folds the false branch to `never` — the same
 * fold one level down (type-emit-lawt.md, "Owned interfaces" §4).
 *
 * The wrap branch records no span of its own: the nested expression already
 * records its spans at the already-shifted offsets (Buf appends forward — the
 * `"__scmTruth("` prefix lands BEFORE the inner emission fires, so no retroactive
 * arithmetic exists to get wrong); a diagnostic on the literal wrapper text falls
 * back to the enclosing `if`'s recordSpan — coarser, never dropped.
 */
function emitCondition(c: Node, ctx: Ctx): void {
  if (isNarrowingForm(c, ctx)) {
    emitNarrowingForm(c, ctx);
    return;
  }
  ctx.buf.raw("__scmTruth(");
  emitExpr(c, ctx); // UNCHANGED value-position emission, nested
  ctx.buf.raw(")");
}

/**
 * The narrowing-form grammar (constitution §5.3, Law T's exemption made semantic):
 *
 *   NForm ::= App(sym flagged narrows, …) | (not NForm) | (and NForm…) | (or NForm…)
 *
 * ALL-OR-NOTHING: this test runs over the WHOLE condition tree before one byte is
 * emitted (emitCondition dispatches on its verdict) — a single non-flagged operand
 * anywhere fails the whole form, and the entire condition wraps as one
 * `__scmTruth(…)` around the unchanged value-position lowering. A mixed clause
 * thus loses ALL narrowing rather than composing half-native, half-opaque text.
 *
 * `not`/`and`/`or` are recognized STRUCTURALLY by fixed name — never themselves
 * gated on `narrowsMembers` — only the base case (an arbitrary predicate
 * application) consults the harvested set. The shadow check applies uniformly to
 * `not`/`and`/`or` AND a bare predicate head, mirroring emitList's `headBound`
 * precedent: a user's `(define (not x) …)` shadows the grammar exactly as it
 * shadows ordinary builtin dispatch. `length > 1` excludes zero-arity
 * `(and)`/`(or)` — value forms, not guards; they wrap.
 */
function isNarrowingForm(n: Node, ctx: Ctx): boolean {
  if (!isList(n) || isNil(n)) return false;
  const h = n.list[0];
  if (!isAtom(h) || h.str || ctx.nameOf.get(h) !== undefined) return false; // shadow rule
  if (h.atom === "not") {
    const arg = n.list[1];
    return n.list.length === 2 && arg !== undefined && isNarrowingForm(arg, ctx);
  }
  if (h.atom === "and" || h.atom === "or") {
    return n.list.length > 1 && n.list.slice(1).every((arg) => isNarrowingForm(arg, ctx));
  }
  return ctx.narrowsMembers.has(h.atom);
}

/**
 * Native emission for a grammar-approved condition: `!`/`&&`/`||` composition over
 * bare `__arr` predicate calls, so tsc narrowing composes exactly as it already
 * does for one bare guard (`(if (not (null? xs)) (car xs) …)`,
 * `(if (and (pair? x) (pair? (cdr x))) …)` — the dominant guard shapes, §5.3).
 *
 * Each level records its OWN span (`recordSpan` here for `not`/`and`/`or`; the
 * leaf via emitBuiltinCall's own recordSpan — no duplicate entry), so the
 * Mapper's tightest-match lifts a diagnostic onto the innermost predicate call,
 * not the whole boolean expression. Every `and`/`or` level self-parenthesizes
 * unconditionally — this text is never human-read, so over-parenthesizing costs
 * nothing and kills precedence risk.
 */
function emitNarrowingForm(n: Node, ctx: Ctx): void {
  // emitCondition gates on isNarrowingForm, so a non-list can't reach here; the
  // re-narrow satisfies the checker and degrades transparently if it ever did.
  if (!isList(n)) return emitExpr(n, ctx);
  const h = n.list[0] as Atom; // guaranteed by isNarrowingForm's own guard
  const start = ctx.buf.offset;
  if (h.atom === "not") {
    ctx.buf.raw("!");
    emitNarrowingForm(n.list[1]!, ctx);
    recordSpan(ctx, start, n);
    return;
  }
  if (h.atom === "and" || h.atom === "or") {
    ctx.buf.raw("(");
    for (const [idx, arg] of n.list.slice(1).entries()) {
      if (idx > 0) ctx.buf.raw(h.atom === "and" ? " && " : " || ");
      emitNarrowingForm(arg, ctx);
    }
    ctx.buf.raw(")");
    recordSpan(ctx, start, n);
    return;
  }
  emitBuiltinCall(h.atom, n, ctx); // records its own span — no duplicate entry
}

function emitLambda(n: ListNode, ctx: Ctx): void {
  const start = ctx.buf.offset;
  const params = paramAtoms(n.list[1]);
  ctx.buf.raw("(");
  for (const [idx, p] of params.entries()) {
    if (idx > 0) ctx.buf.raw(", ");
    if (p.rest) ctx.buf.raw("...");
    ctx.buf.raw(emitName(p.atom, ctx));
    // No param type annotation: TS infers from usage / contextual typing, which
    // is the faithful default. (A NUM-aware pass may annotate later.)
  }
  ctx.buf.raw(") => ");
  emitArrowBody(n.list.slice(2), ctx);
  recordSpan(ctx, start, n);
}

/** The body of a lambda/define arrow. A single expression → `expr`; a sequence →
 *  a `{ … return last; }` block. An object-literal sole body is parenthesized. */
function emitArrowBody(forms: Node[], ctx: Ctx): void {
  if (forms.length === 0) {
    ctx.buf.raw("(undefined as unknown)");
    return;
  }
  if (forms.length === 1) {
    const only = forms[0]!;
    // A let/begin sole body IS the arrow's own block — emit as a real block.
    if (isList(only)) {
      const h = head(only);
      if ((h === "let" || h === "let*" || h === "letrec" || h === "letrec*") && !isAtom(only.list[1])) {
        emitLetBlock(only, ctx, "return ");
        return;
      }
      if (h === "begin") {
        emitBeginBlock(only.list.slice(1), ctx, "return ");
        return;
      }
    }
    // No emitted EXPRESSION starts with a bare `{` (object literals lower to
    // `__arr.dict(…)`, blocks are handled above), so a plain expression body needs
    // no defensive parenthesization.
    emitExpr(only, ctx);
    return;
  }
  emitBeginBlock(forms, ctx, "return ");
}

/** A `(begin a b last)` as a BLOCK: `{ a; b; return last; }` (or `lead`-prefixed). */
function emitBeginBlock(forms: Node[], ctx: Ctx, lastPrefix: string): void {
  ctx.buf.raw("{ ");
  emitBodyForms(forms, ctx, lastPrefix);
  ctx.buf.raw("}");
}

/** `begin` in EXPRESSION position: not block-placeable, so we emit just the last
 *  form's value (type-faithful — a `begin`'s type is its last form's). */
function emitBeginExpr(n: ListNode, ctx: Ctx): void {
  const forms = n.list.slice(1);
  if (forms.length === 0) {
    ctx.buf.spanned("(undefined as unknown)", n);
    return;
  }
  const start = ctx.buf.offset;
  // Emit leading forms as a comma sequence so any type errors in them still bite,
  // and the value is the last form.
  if (forms.length > 1) ctx.buf.raw("(");
  for (const [idx, f] of forms.entries()) {
    if (idx > 0) ctx.buf.raw(", ");
    emitExpr(f, ctx);
  }
  if (forms.length > 1) ctx.buf.raw(")");
  recordSpan(ctx, start, n);
}

/** A let / let-star / letrec as a TS BLOCK STATEMENT: `{ const x = v; body }`. The
 *  `lastPrefix` ("" at statement position, "return " inside an arrow body) is
 *  applied to the final body form. */
function emitLetBlock(n: ListNode, ctx: Ctx, lastPrefix: string): void {
  // Named let `(let loop ((x v)) …)` — a loop, not a binding block. Type-faithful
  // minimal lowering: declare the loop fn + its inits, then run the body block.
  if (isAtom(n.list[1])) {
    emitNamedLetBlock(n, ctx, lastPrefix);
    return;
  }
  const bindings = n.list[1];
  const bodyForms = n.list.slice(2);
  ctx.buf.raw("{ ");
  if (isList(bindings)) {
    for (const b of bindings.list) {
      if (isList(b) && isAtom(b.list[0])) {
        const name = emitName(b.list[0], ctx);
        const kw = ctx.setVars.has(name) ? "let" : "const";
        ctx.buf.raw(`${kw} ${name} = `);
        if (b.list[1]) emitExpr(b.list[1], ctx);
        else ctx.buf.raw("undefined as unknown");
        ctx.buf.raw("; ");
      }
    }
  }
  emitBodyForms(bodyForms, ctx, lastPrefix);
  ctx.buf.raw("}");
}

/** A named let → `{ const loop = (x) => {…}; <lastPrefix>loop(inits); }`. */
function emitNamedLetBlock(n: ListNode, ctx: Ctx, lastPrefix: string): void {
  const nameAtom = n.list[1] as Atom;
  const name = emitName(nameAtom, ctx);
  const bindings = n.list[2];
  const varAtoms: Atom[] = [];
  const inits: Node[] = [];
  if (isList(bindings)) {
    for (const b of bindings.list) {
      if (isList(b) && isAtom(b.list[0])) {
        varAtoms.push(b.list[0]);
        inits.push(b.list[1] ?? { atom: "#f" });
      }
    }
  }
  ctx.buf.raw("{ ");
  ctx.buf.raw(`const ${name} = (`);
  for (const [idx, v] of varAtoms.entries()) {
    if (idx > 0) ctx.buf.raw(", ");
    ctx.buf.raw(emitName(v, ctx));
  }
  ctx.buf.raw(") => ");
  emitArrowBody(n.list.slice(3), ctx);
  ctx.buf.raw("; ");
  ctx.buf.raw(lastPrefix);
  ctx.buf.raw(`${name}(`);
  for (const [idx, v] of inits.entries()) {
    if (idx > 0) ctx.buf.raw(", ");
    emitExpr(v, ctx);
  }
  ctx.buf.raw("); }");
}

/** Emit a body's forms inside an open block: leading forms as statements, the
 *  last form prefixed by `lastPrefix` (e.g. "return " / ""). */
function emitBodyForms(forms: Node[], ctx: Ctx, lastPrefix: string): void {
  for (const [idx, f] of forms.entries()) {
    if (idx === forms.length - 1) ctx.buf.raw(lastPrefix);
    emitStmtInner(f, ctx);
    ctx.buf.raw("; ");
  }
}

/**
 * A let / begin in EXPRESSION position (where a *value* is needed and no statement
 * block can be placed — e.g. `(define r (let ((x 1)) (+ x 1)))`). We emit an
 * immediately-invoked arrow `(() => { const x = …; return …; })()`: the binding
 * forms are still type-checked and the value flows. This is the ONE place an
 * arrow-call appears — the "block-not-IIFE" rule governs STATEMENT/body position
 * (where a bare block suffices and an IIFE would distort CFA); at expression
 * position the arrow is the type-faithful way to bind-and-yield. The block body is
 * built by the same {@link emitLetBlock} used at statement position.
 */
function emitLetExpr(n: ListNode, ctx: Ctx): void {
  const start = ctx.buf.offset;
  ctx.buf.raw("(() => ");
  emitLetBlock(n, ctx, "return ");
  ctx.buf.raw(")()");
  recordSpan(ctx, start, n);
}

function emitSetExpr(n: ListNode, ctx: Ctx): void {
  const start = ctx.buf.offset;
  const target = n.list[1];
  ctx.buf.raw("(");
  if (isAtom(target)) ctx.buf.raw(emitName(target, ctx));
  else ctx.buf.raw("(undefined as unknown)");
  ctx.buf.raw(" = ");
  if (n.list[2]) emitExpr(n.list[2], ctx);
  else ctx.buf.raw("undefined as unknown");
  ctx.buf.raw(")");
  recordSpan(ctx, start, n);
}

function emitQuote(datum: Node | undefined, ctx: Ctx, form: Node): void {
  const start = ctx.buf.offset;
  emitQuoteDatum(datum, ctx);
  recordSpan(ctx, start, form);
}

function emitQuoteDatum(datum: Node | undefined, ctx: Ctx): void {
  if (datum === undefined) {
    ctx.buf.raw("undefined as unknown");
    return;
  }
  if (isAtom(datum)) {
    if (datum.str) ctx.buf.raw(JSON.stringify(decodeString(datum.atom)));
    else if (isNumber(datum)) ctx.buf.raw(datum.atom);
    else if (isBool(datum)) ctx.buf.raw(datum.atom === "#t" ? "true" : "false");
    else ctx.buf.raw(JSON.stringify(datum.atom)); // quoted symbol → string
    return;
  }
  ctx.buf.raw("[");
  for (const [idx, d] of datum.list.entries()) {
    if (idx > 0) ctx.buf.raw(", ");
    emitQuoteDatum(d, ctx);
  }
  ctx.buf.raw("]");
}

// ── statement-position emit (top-level + body) ───────────────────────────────

/** Emit a top-level / body form as a STATEMENT. A value-bearing form is a bare
 *  expression here — the caller adds any `return`/`;` prefix/suffix. */
function emitStmtInner(form: Node, ctx: Ctx): void {
  if (isList(form) && (head(form) === "define" || head(form) === "define/overridable")) {
    emitDefine(form, ctx);
    return;
  }
  if (
    isList(form) &&
    (head(form) === "let" || head(form) === "let*" || head(form) === "letrec" || head(form) === "letrec*")
  ) {
    // A let at statement position is a real block statement.
    emitLetBlock(form, ctx, "");
    return;
  }
  if (isList(form) && head(form) === "begin") {
    emitBeginBlock(form.list.slice(1), ctx, "");
    return;
  }
  emitExpr(form, ctx);
}

function emitDefine(n: ListNode, ctx: Ctx): void {
  const start = ctx.buf.offset;
  const sig = n.list[1];
  if (isList(sig)) {
    // `(define (f a b) body)` → `const f = (a, b) => { … };`
    const nameAtom = isAtom(sig.list[0]) ? sig.list[0] : undefined;
    const name = nameAtom ? emitName(nameAtom, ctx) : "_";
    if (nameAtom) ctx.declaredNames.set(name, nameAtom.atom);
    const params = paramAtoms({ list: sig.list.slice(1) });
    const kw = ctx.setVars.has(name) ? "let" : "const";
    ctx.buf.raw(`${kw} ${name} = (`);
    for (const [idx, p] of params.entries()) {
      if (idx > 0) ctx.buf.raw(", ");
      if (p.rest) ctx.buf.raw("...");
      ctx.buf.raw(emitName(p.atom, ctx));
    }
    ctx.buf.raw(") => ");
    emitArrowBody(n.list.slice(2), ctx);
  } else {
    // `(define x v)` → `const x = <v>;`
    const name = isAtom(sig) ? emitName(sig, ctx) : "_";
    if (isAtom(sig)) ctx.declaredNames.set(name, sig.atom);
    const kw = ctx.setVars.has(name) ? "let" : "const";
    // `(define/overridable x type default)` compiles just like an ordinary define
    // FOR NOW: both sub-expressions emit exactly as any define's value would —
    // no dedicated type-tag lowering. The type tag is never a bare name standing
    // in for some other type (s/* — s/enum, s/object, … — is the only type
    // vocabulary, prelude-loaded the same way BUILTIN_PREAMBLE is), so it needs
    // no special-cased resolution: emitting it through the ordinary expression
    // path is what makes an unbound identifier there correctly bite as an
    // unresolved reference, same as any other free ref would. `x`'s own type
    // still just infers from `default` (last statement); the tag doesn't
    // annotate it yet.
    if (head(n) === "define/overridable" && n.list[2]) {
      emitExpr(n.list[2], ctx);
      ctx.buf.raw(";\n");
    }
    ctx.buf.raw(`${kw} ${name} = `);
    const valueIdx = head(n) === "define/overridable" ? 3 : 2;
    if (n.list[valueIdx]) emitExpr(n.list[valueIdx], ctx);
    else ctx.buf.raw("undefined as unknown");
  }
  recordSpan(ctx, start, n);
}

// ── pure helpers ─────────────────────────────────────────────────────────────

/** Parameter atoms, dotted rest `(a b . rest)` flagged. */
function paramAtoms(node: Node | undefined): { atom: Atom; rest: boolean }[] {
  if (!isList(node)) return [];
  const out: { atom: Atom; rest: boolean }[] = [];
  for (let i = 0; i < node.list.length; i++) {
    const p = node.list[i]!;
    if (isAtom(p) && p.atom === ".") {
      const rest = node.list[i + 1];
      if (isAtom(rest)) out.push({ atom: rest, rest: true });
      break;
    }
    if (isAtom(p)) out.push({ atom: p, rest: false });
  }
  return out;
}

/** Decode a scheme string literal's escapes (parser stores them raw). */
function decodeString(raw: string): string {
  return raw.replaceAll(/\\(.)/g, (_m, c: string) => {
    switch (c) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case "0":
        return "\0";
      default:
        return c;
    }
  });
}

/**
 * Emit type-faithful virtual TS for an arrival Scheme program, with a span lens
 * back to the source. The emitted module references the `@here.build/
 * arrival-lsp` prelude globals (`__arr`, `sexpr`, `Dict`, `__scmTruth`) —
 * prepend `PRE` (unmapped) before type-checking; nothing is declared here.
 *
 * Each top-level form is emitted under its own try/catch: a parse/emit failure on
 * one form degrades THAT form to an unmapped `unknown` (recorded in
 * `droppedForms`) and never throws out of `emitTypes`, so the LSP never blanks all
 * diagnostics. The module ends with `export {};` so top-level `const` bindings
 * are module-scoped and never collide across files in a shared program.
 */
export interface EmitTypesOptions {
  /** Host-injected ambient member names (sift rosetta tools) — heads lowered via
   *  `__arr[...]` so the type-lens resolves their signatures. See `Ctx.hostMembers`. */
  hostMembers?: ReadonlySet<string>;
  /**
   * Registry-harvested Law-N witnesses: head names whose Contract carries
   * `narrows: { witness }` (registry-emit.md owns the field + harvest — see
   * `narrowsMembersOf` for the reduction; consumed here only as a reduced KEY SET,
   * never the witness sub-field, which feeds a separate CI table). Feeds the
   * narrowing-form grammar: a condition reachable from `if` through zero or more
   * `not`/`and`/`or`, bottoming out ONLY in members of this set, emits NATIVE
   * `!`/`&&`/`||`/bare-call. Absent → EMPTY_SET → every condition wraps — Law F's
   * value-position analog: no witness ⇒ conservative, never reversed.
   */
  narrowsMembers?: ReadonlySet<string>;
}

export function emitTypes(source: string | readonly Node[], opts?: EmitTypesOptions): EmitTypesResult {
  const buf = new Buf();
  const droppedForms: number[] = [];

  let forest: Node[];
  try {
    forest = desugar(typeof source === "string" ? parseSexprs(source) : [...source]);
  } catch {
    // Whole-program parse failure: emit an empty module rather than throw.
    return { ts: "export {};\n", mappings: [], droppedForms: [], declaredNames: new Map() };
  }

  const nameOf = resolveNames(forest, []);
  const setVars = collectSetBangNames(forest, nameOf);
  const ctxBase: Ctx = {
    buf,
    nameOf,
    setVars,
    hostMembers: opts?.hostMembers ?? EMPTY_SET,
    narrowsMembers: opts?.narrowsMembers ?? EMPTY_SET,
    declaredNames: new Map(),
  };

  for (const [idx, form] of forest.entries()) {
    // `(require …)` is an environment directive (load a file into the env), not
    // a value form — there is nothing to type-check IN THIS BUFFER. Emitting it
    // as a call produced a bogus `Cannot find name 'require'` (+ an @types/node
    // upsell) from tsc. Skipped + recorded; the names a require brings into
    // scope stay unresolved until the lens grows cross-file resolution.
    if (isList(form) && head(form) === "require") {
      droppedForms.push(idx);
      continue;
    }
    const checkpoint = buf.offset;
    try {
      emitStmtTop(form, ctxBase);
      buf.raw(";\n");
    } catch {
      // Degrade this form to a transparent `unknown`. We can't easily rewind the
      // buffer, so append a fresh transparent statement; the partial emit (if any)
      // is harmless TS prefix. Record the drop.
      if (buf.offset === checkpoint) buf.raw("undefined as unknown;\n");
      droppedForms.push(idx);
    }
  }

  buf.raw("export {};\n");
  return { ts: buf.toString(), mappings: buf.mappings, droppedForms, declaredNames: ctxBase.declaredNames };
}

/** A top-level form: define → const; let/begin → block statement; else → expr stmt. */
function emitStmtTop(form: Node, ctx: Ctx): void {
  emitStmtInner(form, ctx);
}
