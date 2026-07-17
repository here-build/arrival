/**
 * ARM-C — containers + the primitive-head registry + the fan constructor.
 *
 * Owns Dict (the one union member `extract()`'s dispatcher routes here) plus two
 * exported contracts the sibling arms call through:
 *
 *   1. `defaultRegistry` — the HeadRegistry (model/static-prov.ts): TOTAL head
 *      classification. The tables below are the auditable claim: one line per
 *      head, grouped by role, an unknown name falling through to
 *      `{role:"opaque", reason:"unknown-head/<name>"}` (I1 — never throw, never
 *      undefined). Lookups guard with `Object.hasOwn` rather than `in`/bracket
 *      access: a head name comes from the (adversarial) program's author, and a
 *      plain `in` check on an object literal is fooled by an inherited
 *      `Object.prototype` member (`"constructor" in FUSE_HEADS` is `true` even
 *      though no such head was ever registered) — exactly the mislabeling I1
 *      forbids.
 *   2. `buildFan` — the Fan constructor ARM-B calls for fan-role heads
 *      (`map`/`filter`/`fold`/…). The lambda's parameter(s) bind to SYNTHETIC
 *      attributions — there is no source expression to defer to, `element` is
 *      the distinguished one-of-collection projection — and the body extracts
 *      through the shared `extract()` dispatcher in a frame closed over the
 *      lambda's OWN defining scope (never the call site's — the same
 *      binding-site-scoping rule `wire/derive.ts`'s `resolveCallee` uses for
 *      ordinary beta-reduction). Collapse (T3a, contract-corrected 2026-07-15,
 *      see `collapse.ts`'s header for the full split): `buildFan` ALONE decides
 *      "combine" — a RAW-COREFORM check against the closed AC list (`AC_HEADS`,
 *      below) against the raw `fn` this arm still holds, BEFORE that identity
 *      is erased by extraction (`+`/`-`/`*` all extract to a bit-identical
 *      `FusedProv` — a body-only view can never tell them apart). Only a bare
 *      AC-head `Ref` (`(fold + 0 v)`) or a lambda whose entire raw body is
 *      exactly `(ac-head acc element)` qualifies — anything else defers to
 *      `inferCollapse(body)` for route-vs-lowered. Defaulting "combine" for
 *      anything less exact would BE the fold-collapse forge this design guards
 *      against — a `const` hidden behind an `if` inside a fold body must stay a
 *      visible `choice` node, never vanish into one fused value.
 *
 * Dict → BuildProv{ctor:"dict"}, one part per entry, `prov` the entry VALUE's
 * attribution. A key is program text, not data: `{:a 1}` and `{:b 1}` attribute
 * identically — only entry VALUES flow into the circuit, never key spellings.
 *
 * GEPA sweep (2026-07-15) — the real `gepa.scm` algorithm surfaced almost
 * nothing before this pass: every data-carrying head it calls that the
 * registry didn't yet know (`max-by`, `append`, `cadr`, the three predicates,
 * `infer/chat/user`) fell through to the unknown-head opaque default, and
 * `max-by` wraps the ENTIRE program's return value, so its opaque discarded
 * the whole circuit. The classifications added below (see each table's own
 * comments for the per-head seal claim) surface the chain; `max-by`'s mux
 * entry is the load-bearing one. `s/object`/`s/field/string` were left
 * unclassified BY THIS SWEEP (still opaque via the unknown-head fallback) on
 * the theory that `infer/chat`'s output-schema arg never carries evidence —
 * RECLASSIFIED 2026-07-16 (V's ruling, `classifyHead`'s own `s/`-namespace
 * rule below has the full account): that theory undercounted the cost. The
 * schema arg's opaque still flows into the mint's `closed` (a crossing's own
 * inputs — static-prov.ts's `MintProv` doc), which grounds the SELECTION
 * channel, and an opaque anywhere in a guard's selection fails
 * `guardGroundsInEvidence` (circuit-verdict.ts) even when the guard's own
 * evidence anchor is real — an evidence-grounded judgment was reading as
 * not-attestable purely because its schema arg was miscategorized. `every`/
 * `some` stay unclassified (still opaque via the unknown-head fallback)
 * because they never carry evidence: they are the higher-order predicate
 * combinators inside `dominates?`, never on a path this sweep needs to open;
 * `apply` is `max-by`'s KEY function (arg0) — `dispatchMux` only ever walks
 * the SOURCE arg (arg1), so `apply` is never even passed to `extract` and its
 * classification is moot either way.
 */
import type { CoreForm, DefineFn, Dict, Lambda, NodeId } from "../coreform/types.js";
import type { BuildProv, ChoiceProv, HeadClass, HeadRegistry, MintIntegrity, StaticProv } from "../model/static-prov.js";
import { inferCollapse } from "./collapse.js";
import { type Bound, type ExtractCtx, type Scope, checkReducing, extract, extractBody, lookup, opaque, resolveCallee } from "./index.js";

export function extractContainer(form: Dict, ctx: ExtractCtx): StaticProv {
  return {
    kind: "build",
    site: form.id,
    ctor: "dict",
    parts: form.entries.map((e) => ({ key: e.key, prov: extract(e.value, ctx) })),
  };
}

// ── the head registry ───────────────────────────────────────────────────────────

/** ⊗ over every argument, unconditionally (comparisons included — the runtime
 *  VALUE that wins a `min`/`max`/`<` is dynamic, so statically every operand is a
 *  potential contributor; there is no cheaper-but-still-sound answer). */
const FUSE_HEADS: Readonly<Record<string, true>> = {
  "+": true,
  "-": true,
  "*": true,
  "/": true,
  "=": true,
  "<": true,
  ">": true,
  "<=": true,
  ">=": true,
  abs: true,
  min: true,
  max: true,
  not: true,
  "string-length": true,
  hash: true,
  // Pure single-source conversions: a `->` cast is a transformation of its one
  // argument, transformation-blind ⇒ fuse (one source, all contributes) — the
  // content story of `(number->string (:v e))`. Tight, unambiguous core; a
  // wider registry-completeness sweep is a separate audited pass, not a guess.
  "number->string": true,
  "string->number": true,
  "symbol->string": true,
  "string->symbol": true,
  // GEPA sweep (2026-07-15) — predicates: the runtime boolean depends on
  // every operand, same ⊗-over-all-args rule as `=`/`<`/… above (comparisons
  // included since the WINNING value is dynamic, so statically every operand
  // is a potential contributor).
  "zero?": true,
  "null?": true,
  "string-ci=?": true,
  // GEPA sweep: list concatenation — every arg contributes to the fused
  // list, all visible; the pool-growth fuse in `generation`
  // (`(append pool (map mutate pool))`) is what lets the mutate/reflect/infer
  // subtree flow into the circuit instead of vanishing behind an
  // unclassified opaque (the worst offender before max-by itself).
  append: true,
};

/** The CLOSED fold-combinator AC list (§2c) — exactly 4 members: associative,
 *  void-free, arity-liftable. This is `buildFan`'s "combine" check, against the
 *  RAW `fn` CoreForm (a bare `Ref` or a lambda's literal one-line body) — never
 *  against an extracted `FusedProv`, which has already forgotten which head
 *  produced it (`+`/`-`/`*` all extract identically). This is a DIFFERENT axis
 *  than `FUSE_HEADS`'s attribution role — `FUSE_HEADS` also contains non-AC
 *  heads (`-`, `/`, the comparisons, `abs`, `min`, `max`, `not`, `hash`,
 *  `string-length`, the `->` casts) that must never combine — so `AC_HEADS`
 *  stays its own table rather than deriving from `FUSE_HEADS`'s membership.
 *  `string-append` (STRING_HEADS) and `cons` (BUILD_HEADS) are AC too; this
 *  table is fold-collapse-eligibility, not a duplicate of either registry. A
 *  5th member here is a closed-list violation (collapse-kind.test.ts pins the
 *  count) — extend only with a real associativity proof, never by convenience. */
const AC_HEADS = ["+", "*", "string-append", "cons"] as const;
type AcHead = (typeof AC_HEADS)[number];
const AC_HEAD_SET: ReadonlySet<AcHead> = new Set(AC_HEADS);
/** Membership guard doubling as a type predicate: the closed-4 invariant now
 *  lives in `AcHead`'s type (a 5th string here is a tsc error at every
 *  `AC_HEADS` literal, not just a runtime miss), and every call site narrows
 *  to `AcHead` instead of a bare `string` after the check. */
const isAcHead = (name: string): name is AcHead => AC_HEAD_SET.has(name as AcHead);

/** Where-provenance projection. `keyArg` names which positional arg supplies the
 *  key; `"self"` marks the heads whose "key" is the operation's own identity —
 *  there is no separate key argument (`car` always projects the first slot). */
const MUX_HEADS: Readonly<Record<string, number | "self">> = {
  car: "self",
  cdr: "self",
  first: "self",
  rest: "self",
  nth: 1, // (nth lst index) — index is the second positional arg
  "vector-ref": 1, // (vector-ref v index)
  assoc: 0, // (assoc key alist) — R7RS key-first order
  "dict-ref": 1, // (dict-ref d key) — container-first, matching vector-ref/nth
  // GEPA sweep (2026-07-15) — `cadr` = car-of-cdr, the pair's SECOND element:
  // a unary accessor, same shape as car/cdr/first/rest above, so it takes the
  // same "self" arm (unary arity, source = the one operand) — dispatchMux's
  // "self" branch stamps `key` as the head's own name ("cadr"), not a literal
  // numeric 1: the dispatch contract has no unary-plus-fixed-key shape to ask
  // for a bare index instead, and extending it is out of this sweep's scope.
  // Sound regardless: key is where-provenance METADATA, never a gate on
  // whether the source flows — the pair's attribution passes through
  // unconditionally either way.
  cadr: "self",
  // `(max-by keyfn list)` returns SOME element of `list` — a coarse
  // element-projection, MuxProv{key:null} ("statically unknown index",
  // already the model's vocabulary for this). Reusing the existing
  // keyArg-supplies-the-key convention with keyArg:0 gets this for free
  // *and* stays honest: arg0 is always the comparator function (a
  // Lambda/Ref), never a Lit, so `staticKeyOf` resolves it to null on every
  // real call — arg1 (the list) is the source. THE seal claim: this is
  // GEPA's OUTPUT WRAPPER — before this entry, max-by was an unknown head
  // and its opaque swallowed the entire program (the worst single-node
  // discard in the corpus); this entry passes the list's attribution
  // (the whole iterate/generation fan, with every infer/chat crossing
  // beneath it) through instead of discarding it. The comparator function
  // itself (arg0, `(lambda (c) (apply + (:scores c)))`) is never even
  // extracted — dispatchMux only walks the source arg — so `apply` staying
  // opaque in the registry never matters here; it is simply never reached.
  "max-by": 0,
};

/** Container mirror — per-part attribution preserved. `list`/`make-vector` share
 *  `vector`'s ctor: both are N positionally-keyed parts, the same shape as an
 *  explicit `vector` literal (the constitution folds lists and vectors to the
 *  same runtime array representation, so they share the static shape too).
 *  `dict` is listed for completeness — in practice `(dict …)` never reaches the
 *  registry (classify() intercepts it as a special form straight to a `Dict`
 *  node, ARM-C's own `extractContainer`), but the head genuinely IS build/dict
 *  and a registry entry costs nothing to keep honest. */
const BUILD_HEADS: Readonly<Record<string, BuildProv["ctor"]>> = {
  cons: "pair",
  list: "vector",
  vector: "vector",
  dict: "dict",
  "make-vector": "vector",
  // GEPA sweep (2026-07-15) — `(infer/chat/user content)` builds a chat
  // message struct; its one positional arg (the content string) becomes a
  // BUILD part, so the content stays a VISIBLE source — never a mux (which
  // could coarsen it to a single key) and never opaque (which would drop it
  // entirely). This is the const-preserving requirement itself:
  // `(infer/chat/user "FABRICATED")` must keep "FABRICATED" a visible
  // `const` part, exactly as any other BUILD ctor preserves its parts.
  "infer/chat/user": "dict",
};

/** Fuse with run-order preserved — ARM-B builds the StringProv; this table only
 *  classifies which heads are string-shaped. */
const STRING_HEADS: Readonly<Record<string, true>> = {
  "string-append": true,
  "string-join": true,
  substring: true,
  format: true,
};

/** A fresh indeterminate at a membrane crossing. `now`/`uuid`/`random` are
 *  ambient (I3's third verdict — environment-derived, no recorded input to
 *  ground against); the rest are evidence (a recorded crossing over real
 *  inputs — a prompt, a file path, a required module). */
const MINT_HEADS: Readonly<Record<string, MintIntegrity>> = {
  infer: "evidence",
  "infer/chat": "evidence",
  "read-file": "evidence",
  "require/eval": "evidence",
  now: "ambient",
  uuid: "ambient",
  random: "ambient",
};

/** The variable-arity aggregation boundary. `for-each` has no accumulator, so it
 *  aliases to `"map"` (element-only bind); `reduce`/`fold-left`/`fold-right`
 *  alias to `"fold"`.
 *
 *  OPEN AMBIGUITY (flagged, not silently resolved): `buildFan` binds a fold
 *  lambda's params POSITIONALLY — param0 is always acc, param1 always element,
 *  matching this dialect's own `fold` (confirmed by the fixture corpus's
 *  `(lambda (acc x) …)`, the JS-`Array.prototype.reduce` order). SRFI-1's
 *  `fold-right` traditionally calls its kons as `(elem acc)` — REVERSED. Since
 *  `HeadClass`'s `fanKind` has no fourth "reversed" bucket, a literal
 *  `fold-right` lambda written in the traditional order would have acc/element
 *  mislabeled by position. No example in this corpus uses `fold-right`; flagged
 *  here for whoever wires deeper SRFI-1 fidelity rather than silently guessed at. */
const FAN_HEADS: Readonly<Record<string, "map" | "filter" | "fold">> = {
  map: "map",
  filter: "filter",
  fold: "fold",
  reduce: "fold",
  // fold-left / fold-right REMOVED (orchestrator, 2026-07-15): SRFI-1's
  // fold-right calls its kons `(elem acc)` — REVERSED vs this dialect's
  // positional fold — and HeadClass.fanKind has no arg-order metadata, so the
  // acc/element binding would mislabel. Not a mark-erasure forge (consts stay
  // visible either way), but T3a's collapse-kind inference READS which param
  // the body uses (route-init vs route-last) — a swapped binding yields wrong
  // collapse claims. Fail-closed per I1: unknown-head → opaque, until a
  // per-head arg-order field lands with T3a.
  "for-each": "map",
};

export const defaultRegistry: HeadRegistry = {
  classifyHead(name: string): HeadClass {
    if (Object.hasOwn(FUSE_HEADS, name)) return { role: "fuse" };
    if (Object.hasOwn(MUX_HEADS, name)) return { role: "mux", keyArg: MUX_HEADS[name]! };
    if (Object.hasOwn(BUILD_HEADS, name)) return { role: "build", ctor: BUILD_HEADS[name]! };
    if (Object.hasOwn(STRING_HEADS, name)) return { role: "string" };
    if (Object.hasOwn(MINT_HEADS, name)) return { role: "mint", integrity: MINT_HEADS[name]! };
    if (Object.hasOwn(FAN_HEADS, name)) return { role: "fan", fanKind: FAN_HEADS[name]! };
    // `s/` — the reserved TYPE-SYNTAX namespace (V's ruling, 2026-07-16): every
    // head under this prefix (`s/object`, `s/field/string`, `s/enum`, …) is
    // arrival's type vocabulary, not a value operator (type-emit/emit.ts's own
    // comment: "s/* — s/enum, s/object, … — is the only type vocabulary,
    // prelude-loaded the same way BUILTIN_PREAMBLE is"). A FAMILY rule (a
    // namespace test), not an enumeration — `s/` is reserved wholesale, so
    // membership is closed by the prefix itself and needs no per-member table.
    //
    // (a) A descriptor CALL (`(s/object (s/field/string "label"))`) is
    //     ordinary DATA constructed from its args — usually author consts,
    //     possibly a dynamic field name/description built from evidence — so
    //     the honest classification is `fuse` (⊗ over the args' own
    //     where-provenance): an author-const schema stays a visible const, a
    //     schema built from evidence stays VISIBLE, nothing goes opaque.
    //     Const-classification was considered and REJECTED: it would erase
    //     real flow the moment a schema is built from evidence — unsound.
    //     Separately, the type-level NARROWING `s/*` performs at a crossing
    //     is identity-or-crash on execution (never a value transform) — it
    //     contributes NOTHING to attribution and rides the consuming mint's
    //     `closed` (selection, lineage-cut — static-prov.ts's `MintProv`
    //     doc). `fuse` for the descriptor plus that placement in `closed` is
    //     the FULL honest story; no separate "type-narrowing" role is needed.
    // (b) SEAM, not built: a FUTURE explicit value-narrowing form — applying
    //     `s/*` to a value actually flowing through the circuit, rather than
    //     constructing a schema descriptor from author/evidence args — would
    //     want an EXACT pass-through class (identity, never fuse) at that
    //     application site. No such form exists yet; every current `s/*`
    //     call is descriptor construction. Flagged for whoever adds it, not
    //     built ahead of the form that would need it.
    // (c) Safe under user shadowing: a scope-bound callee beta-reduces
    //     (`resolveCallee`/`betaReduce`, arm-control.ts) BEFORE the registry
    //     is ever consulted — `dispatchKnownHead` only runs for a FREE name
    //     (`extractApp`'s free-Ref branch). A user `(define (s/object x) …)`
    //     would shadow this rule entirely; it can never collide with it.
    if (name.startsWith("s/")) return { role: "fuse" };
    return { role: "opaque", reason: `unknown-head/${name}` };
  },
};

// ── the fan constructor ──────────────────────────────────────────────────────────

type FnForm = Lambda | DefineFn;
const isFnForm = (f: CoreForm): f is FnForm => f.kind === "Lambda" || f.kind === "DefineFn";

/** Resolve `fn` to a user-defined function plus the scope its body closes
 *  over. An inline Lambda closes over the CALL site's scope (it's written
 *  right there — that ONE check stays here, since `resolveCallee` only ever
 *  operates on an already-resolved `Bound`, never a raw callee CoreForm,
 *  mirroring `extractApp`'s own IIFE case, arm-control.ts); a `Ref` chases
 *  through however many ref-to-ref hops it takes via the SAME `resolveCallee`
 *  (index.ts) ordinary calls use — never a fan-specific one-hop-only lookup.
 *  That used to be this function's own weaker mechanism: a fan target one
 *  alias removed from its DefineFn (`(map step v)` with `step` bound to
 *  `Ref(generation)`) opaqued as unresolvable while the identical alias
 *  called directly resolved through `resolveCallee`'s chase — single-sourcing
 *  the resolver closes that precision gap (fail-closed either way, so no
 *  soundness was ever at stake, only how much a fan target can reach). `null`
 *  on anything else: a `Ref` bound to a synthetic `{prov}` value, an unbound
 *  `Ref`, a ref-chain that bottoms out free or cyclic, or a non-function form
 *  — `buildFan` keeps its own arity/shape policy on whatever this resolves
 *  to. */
function resolveFanFn(fn: CoreForm, ctx: ExtractCtx): { readonly fn: FnForm; readonly scope: Scope } | null {
  if (isFnForm(fn)) return { fn, scope: ctx.scope };
  if (fn.kind !== "Ref") return null;
  const bound = lookup(ctx.scope, fn.name);
  if (bound === undefined) return null;
  const resolution = resolveCallee(bound, ctx);
  return resolution.kind === "fn" ? { fn: resolution.fn, scope: resolution.scope } : null;
}

const FAN_ARITY: Readonly<Record<"map" | "filter" | "fold", number>> = { map: 1, filter: 1, fold: 2 };

/** Is `form` exactly `(ac-head p0 p1)` — a bare closed-list AC head applied to
 *  precisely the two named params, in order, with nothing else (no kwargs, no
 *  extra/missing positional args)? This is the "combine" shape check against
 *  the RAW CoreForm — the only place the combinator's identity still exists. */
function isBareAcCombinatorApp(form: CoreForm, params: readonly { readonly name: string }[]): boolean {
  if (form.kind !== "App") return false;
  if (form.fn.kind !== "Ref" || !isAcHead(form.fn.name)) return false;
  if (form.kwargs.length !== 0 || form.positionalArgs.length !== 2) return false;
  const [a0, a1] = form.positionalArgs;
  return a0!.kind === "Ref" && a0!.name === params[0]!.name && a1!.kind === "Ref" && a1!.name === params[1]!.name;
}

/** A resolved fold lambda combine-qualifies iff its ENTIRE raw body is exactly
 *  one `(ac-head acc element)` form — "nothing else" means no internal defines
 *  either, not just no extra trailing expressions. */
function isBareAcLambdaBody(target: FnForm): boolean {
  return target.body.length === 1 && isBareAcCombinatorApp(target.body[0]!, target.params);
}

export function buildFan(
  fanKind: "map" | "filter" | "fold",
  site: NodeId,
  fn: CoreForm,
  collection: StaticProv,
  init: StaticProv | null,
  ctx: ExtractCtx,
): StaticProv {
  // A bare AC-head Ref as a fold combinator (`(fold + 0 v)`) IS a valid
  // combinator with no user binding to resolve through — `resolveFanFn`'s
  // `lookup` would find nothing bound to `+` and fail closed to
  // fan/fn-unresolvable. Recognize it BEFORE resolution: the raw Ref's name
  // (not any extracted shape) is the combinator identity itself.
  if (fanKind === "fold" && fn.kind === "Ref" && isAcHead(fn.name)) {
    const element: StaticProv = { kind: "mux", site: fn.id, key: null, source: collection };
    const acc: StaticProv = init ?? opaque(site, "fan/fold-missing-init");
    const body: StaticProv = { kind: "fused", site: fn.id, sources: [acc, element] };
    return { kind: "fan", site, collection, body, collapse: "combine" };
  }

  const resolved = resolveFanFn(fn, ctx);
  if (!resolved) return opaque(fn.id, "fan/fn-unresolvable");
  const { fn: target } = resolved;

  // A rest param can satisfy the fixed COUNT while still being the wrong SHAPE
  // (it wants an array of trailing args, not one element's attribution) — fail
  // closed the same way an arity mismatch does.
  if (target.params.length !== FAN_ARITY[fanKind] || target.params.some((p) => p.rest)) {
    return opaque(site, "fan/arity");
  }
  if (checkReducing(ctx, target)) return opaque(site, "cyclic-binding");

  // The distinguished one-of-collection projection — every fan-body param that
  // stands for "the current element" binds to this SAME synthetic value.
  const element: StaticProv = { kind: "mux", site: fn.id, key: null, source: collection };

  const names = new Map<string, Bound>();
  if (fanKind === "fold") {
    names.set(target.params[0]!.name, { tag: "prov", prov: init ?? opaque(site, "fan/fold-missing-init") });
    names.set(target.params[1]!.name, { tag: "prov", prov: element });
  } else {
    names.set(target.params[0]!.name, { tag: "prov", prov: element });
  }
  const frame: Scope = { names, parent: resolved.scope };

  // The body walk (internal defines pooling into the frame, letrec-style
  // self-reference for recursive helpers, the last non-define form as the
  // value) is `extractBody` (index.ts) — the ONE defines-then-expressions
  // walk every body-hosting construct shares, not a fan-specific copy of it.
  const bodyCtx: ExtractCtx = { ...ctx, scope: frame, reducing: new Set([...ctx.reducing, target]) };
  const body = extractBody(target.body, bodyCtx, target.id, "fan/empty-body");

  // Lambda-form combine: `(fold (lambda (acc x) (+ acc x)) …)` — the raw body
  // is exactly `(ac-head acc element)` over the two params, nothing else. Only
  // fold has both an acc and an element to combine; map/filter never qualify
  // (FAN_ARITY holds them to 1 param, so this check is vacuous for them).
  if (fanKind === "fold" && isBareAcLambdaBody(target)) {
    return { kind: "fan", site, collection, body, collapse: "combine" };
  }

  if (fanKind === "filter") {
    const choice: ChoiceProv = { kind: "choice", site: fn.id, guards: [body], alts: [element] };
    return { kind: "fan", site, collection, body: choice, collapse: inferCollapse(choice) };
  }
  return { kind: "fan", site, collection, body, collapse: inferCollapse(body) };
}
