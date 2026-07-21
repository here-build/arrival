/**
 * Provenance lives on the value, not in a sidecar WeakMap. A WeakMap keyed by
 * object identity snaps the instant any builtin produces a fresh value
 * (`string-append`, `car`, `+`, hundreds more) — every builtin would have to
 * remember to re-stamp. On-value means a builtin can only forget to *propagate*
 * (visible: empty result-set), never to *carry*.
 *
 * The JS→Scheme boxing membrane (`fromJs` + the boxer registry) lives in
 * `boxing.ts`, NOT here — see that file for why the registry's writer is kept off
 * this (leakable) class.
 *
 * Lineage: provenance-on-the-value is how-provenance — provenance as an
 * expression/circuit over operators, not a flat trace (Green, Karvounarakis &
 * Tannen, "Provenance Semirings", PODS 2007). Its dual — a demanded slice of the
 * output induces the minimal slice of the input — is Galois slicing (Perera,
 * Acar, Cheney & Levy, "Functional Programs That Explain Their Work", ICFP 2012).
 */

import { INTEROP_BOUNDARY } from "../../membrane/interop-access.js";
import type { SeenMap } from "../structural-equal.js";
import type { MembraneExit, SchemeBounceMarker, SchemeValue } from "../types.js";
import { CONSTANT_CTX, type RunContext } from "../../run/RunContext.js";
import type { CallCtx } from "../../run/CallCtx.js";
import { LOCATION } from "../../well-known-symbols.js";
import type { SourceLocation } from "../../errors.js";

export const EMPTY_PROVENANCE: ReadonlySet<number> = new Set<number>();

/** The `arrival/provenanceChildren` default — a shared frozen empty, so the common case (every
 *  scalar) allocates nothing on a deep walk. */
const EMPTY_CHILDREN: readonly unknown[] = Object.freeze([]);

/**
 * The run-context of a maybe-boxed operand.
 *
 * TODO(ctx-elimination): this used to narrow `x instanceof AValue ? x.ctx : fallback` — the
 * run-correct source for any value derived from an operand that WAS an AValue, falling back to
 * the run-neutral CONSTANT_CTX for raw JS input. `AValue` no longer carries a per-value `ctx`
 * field at all (see the removal note on the class below), so there is nothing left to narrow:
 * every call now answers `fallback` unconditionally, which collapses `chargeHeap(ctxOf(x), n)`
 * call sites to a no-op (CONSTANT_CTX is always the unmetered/bootstrap context). `x` stays a
 * parameter (unused) so every existing call site keeps compiling unchanged — a later phase
 * restores this via an ambient/active run-context rather than a per-value field.
 */
export function ctxOf(x: SchemeValue, fallback: RunContext = CONSTANT_CTX): RunContext {
  void x;
  return fallback;
}

export type AKind =
  | "string"
  | "number"
  | "bool"
  | "pair"
  | "nil"
  | "symbol"
  | "character"
  | "procedure"
  | "lambda"
  | "object"
  | "js-array"
  | "vector"
  | "bytevector"
  | "void"
  | "keyword"
  | "dict";

export abstract class AValue {
  static [INTEROP_BOUNDARY] = true;
  abstract readonly kind: AKind;
  readonly provenance: ReadonlySet<number>;
  /** Source span, IMMUTABLE — set only at construction (the `location` constructor param
   *  below), never mutated in place. Was formerly APair-only (`[LOCATION]` + a mutating
   *  `setLocation()`); lives on the base now so every value kind (leaf literal, container
   *  literal) can carry a span, not just cons cells. A post-construction change mints a
   *  NEW instance via `withLocation` — exactly like `withProvenance` — never a write
   *  through this slot. SYMBOLS are the deliberate exception: `ASymbol` never receives a
   *  location (interning identity is load-bearing there — see parse_symbol).
   *
   *  `declare`d (no auto-emitted class-field initializer) and, when set, defined via
   *  `Object.defineProperty` as non-enumerable (see the constructor below) — the same
   *  hidden-metadata idiom `hidden_prop` (values-repr.ts) uses elsewhere. This is NOT
   *  cosmetic: a self-evaluating literal now routinely returns the SAME parsed instance
   *  as a computation's result (e.g. `(or #f #f 0)`), so an ENUMERABLE `[LOCATION]` would
   *  make every `expect(result).toEqual(new AExact(0))`-style test (there are hundreds)
   *  see a spurious mismatch against a freshly-built comparison value with no span. The
   *  span is real, on-value data — just never part of the value's STRUCTURAL identity. */
  declare [LOCATION]?: SourceLocation;

  /** REMOVED (ctx-elimination): this class used to carry a per-value `readonly ctx: RunContext`
   *  field — every AValue was minted with a RunContext, run-built values carrying the live run
   *  ctx and singletons/quoted-AST/bootstrap carrying CONSTANT_CTX. It never grew a real reader
   *  (the doc comment already said "no op consumes it yet") beyond `ctxOf`'s fallback narrowing
   *  and `AJSObject`/`AJSArray`'s `freezeRosettaReturns` read — the primary heap-metering path
   *  threads `runCtx` as an explicit op parameter instead, and does not need this field.
   *
   *  Removed outright rather than kept as dead weight. Accepted, deliberate breakage from this
   *  removal: `chargeHeap(ctxOf(x), n)` call sites are now no-ops (ctxOf always answers its
   *  CONSTANT_CTX fallback — see below), and `AJSObject`/`AJSArray`'s freeze-on-read now always
   *  freezes (the `freezeRosettaReturns: false` opt-out is unreachable). A later phase restores
   *  both via an ambient/active run-context rather than reintroducing a per-value field. */

  protected constructor(provenance: ReadonlySet<number> = EMPTY_PROVENANCE, location?: SourceLocation) {
    this.provenance = provenance;
    if (location !== undefined) {
      // Non-enumerable + non-writable + non-configurable: hidden from structural/
      // enumeration comparisons (see the field doc above) AND truly immutable — no
      // `this[LOCATION] = …` anywhere ever writes through this a second time.
      Object.defineProperty(this, LOCATION, { value: location, enumerable: false });
    }
  }

  /** Public reader for the immutable source span — the normal-case accessor a caller
   *  should reach for. */
  get location(): SourceLocation | undefined {
    return this[LOCATION];
  }

  /** Compat shim for cross-package callers (`arrival-chain`, `arrival-provenance`) that
   *  read a Pair's span as a method rather than the `.location` getter — kept so those
   *  packages' existing call sites keep compiling unchanged. */
  getLocation(): SourceLocation | undefined {
    return this.location;
  }

  /** RE-STAMP twin of `withProvenance`, for location: a value's source span is fixed at
   *  birth, so carrying a DIFFERENT span means minting a new instance, never writing
   *  through the `[LOCATION]` slot (the removed `setLocation` mutator). Default: most
   *  value kinds are located ONCE, at construction, and nothing downstream ever needs to
   *  re-stamp them — so the base answers `this` unchanged. The two real re-stamp callers
   *  today (the Parser's open-paren list-head re-stamp, syntax-rules' `carrySpan`) both
   *  target APair, which overrides this to mint a genuine clone. A future re-stamp path
   *  reaching a different concrete class should override here too, rather than reaching
   *  around this method. */
  withLocation(loc: SourceLocation): SchemeValue {
    void loc;
    return this as unknown as SchemeValue;
  }

  /** Plain-JS projection — the ONE Scheme→JS crossing protocol. Called two ways:
   *
   *   • SERIALIZATION (no `exit`): cache / log / HTTP / print-preview. A callable
   *     stringifies here by contract; a container egresses a lazy proxy whose elements
   *     unwrap through their OWN `arrival/toJS()` (bare, per-box identity).
   *   • MEMBRANE crossing (`exit` supplied): rosetta / exec exits, where a nested
   *     callable must become its reverse-membrane host fn and RosettaOptions must reach
   *     every element. Only the native containers (ADict/APair/AVector) read `exit` —
   *     they thread `exit.element` through each element's full recursive crossing under
   *     the pinned region scope; every scalar ignores it (its JS face is mode-independent).
   *     `exit` is built exclusively by rosetta's `egressAValue`.
   *
   *  A global protocol key (like `arrival/tagless-final/*`/`arrival/print`), written as a
   *  literal at each use site rather than declared as a named constant. (Formerly split
   *  into a sibling `arrival/toJSMembrane`; collapsed — `arrival/toJS()` ≡
   *  `arrival/toJS(bareExit)`, one method keyed on `exit` presence. See
   *  values/types.ts#MembraneExit and egress-proxy.ts's identity laws.) */
  abstract ["arrival/toJS"](exit?: MembraneExit): unknown;

  /** AValues are immutable — provenance updates mint a new instance. Returns the
   *  `SchemeValue` union (each concrete subclass overrides with its OWN narrower type, which
   *  is covariantly assignable to the union — so a statically-concrete receiver still gets the
   *  precise subtype; only an abstract-`AValue`-typed receiver falls back to the union here).
   *  NOT the abstract base `AValue`: abstract `AValue` is NOT assignable to `SchemeValue`, so an
   *  `AValue` return reds every `value.withProvenance(p)` that must flow back into a `SchemeValue`
   *  slot (e.g. a re-stamp of an `instanceof AValue`-narrowed arm result). NOT `this`: a clone
   *  mints `new ConcreteClass(...)`, which TS will not accept as `this` without a cast (`this`
   *  could be a narrower subtype), and a cast would re-mute the very signal this return type surfaces. */
  abstract withProvenance(p: ReadonlySet<number>): SchemeValue;

  /** DEEP provenance re-stamp — the inbound membrane's re-stamp claim (jsToScheme's AValue
   *  row), declared beside `arrival/toJS` as a class-owned protocol key (NOT tagless-final:
   *  it is a membrane crossing, not a scheme-surface op). A SPINE carrier (APair / AVector)
   *  implements it by minting a fresh spine whose children re-stamp through
   *  `reStampChild` (deep-restamp.ts); every carrier WITHOUT this term re-stamps shallowly
   *  via `withProvenance` (borrowed wrappers stay lazy — entries pick the stamp up on
   *  access). `ctx` is the CROSSING's RunContext (the caller's argument, not `this.ctx`) and
   *  `seen` terminates cyclic spines. */
  ["arrival/withProvenanceDeep"]?(ctx: RunContext, p: ReadonlySet<number>, seen?: WeakSet<object>): SchemeValue;

  /**
   * The READ-side twin of `withProvenanceDeep`: the values this one REACHES, for the deep
   * provenance union (`collapseProvenance`). A carrier that holds AValues must answer with them,
   * or its members are invisible to the trace and a wiring edge is silently lost.
   *
   * Concrete, not optional, and it lives HERE rather than as an `instanceof` ladder inside
   * provenance-collapse.ts (which is what it replaced) for two reasons: P7 — the class is the sole
   * authority on its own representation, and the write direction already obeys that, so the read
   * direction drifting away from it was a latent bug; and because the `instanceof` ladder forced
   * provenance-collapse to import every value class, which closed a module-init cycle the moment
   * a value class needed to `extends APair` (AJSArrayList does).
   *
   * DEFAULT: reaches nothing. Correct for every scalar, and the deliberate answer for AJSObject —
   * a dict's own point is collected, but its members are not a wiring path (access one first).
   */
  ["arrival/provenanceChildren"](): Iterable<unknown> {
    return EMPTY_CHILDREN;
  }

  // ── The tagless-final algebra — declared OPTIONAL on AValue, the single source of truth ──────
  // Every AValue (and subclass) MAY carry these `arrival/tagless-final/<op>` members; an entity
  // implements the SUBSET it can handle and omits the rest (the `symbol.taglessGuard` presence
  // check is what dispatches). The `undefined` lives in the `?` — declared METHOD-style on purpose:
  // a subclass may override an optional method, but overriding a function-typed *property*
  // (`?: (…) => …`) trips TS2425, so these stay methods. `equals` is additionally `abstract` on the
  // class above (required — every value is a Setoid). tagless-final.ts derives the op-name type +
  // runtime lock-step from `keyof AValue` — add an op by declaring it here.
  /**
   * Fantasy Land Setoid — structural equality, ON THE TERM. Making this abstract
   * forces EVERY subtype to own its `equal?` comparison (totality): a subtype
   * with no equals is a compile error, not a silent fall-through. `structuralEqual`
   * is the harness — it records the (this, other) co-induction pair, then dispatches
   * HERE, threading the shared `seen` so recursive terms (Pair/Vector) co-induct
   * through one visited set and mutual cycles terminate. The `seen` parameter is
   * optional: a direct `a["arrival/tagless-final/equals"](b)` call (no harness) starts a
   * fresh walk; leaf Setoids ignore it.
   */
  abstract ["arrival/tagless-final/equals"](other: unknown, seen?: SeenMap): boolean;
  /** Order — the ≤ of an Ord type (numbers, strings, chars, symbols, bytevectors). */
  ["arrival/tagless-final/lte"]?(other: unknown): boolean;
  /** Code-position lowering — a reader-minted literal node that has Clojure-style
   *  CODE-position element-evaluation semantics (a `[…]` vector / `{…}` dict literal)
   *  answers the `(vector …)` / `(dict …)` application it lowers to ONCE (cached on
   *  the term, keyed by node identity); the lowering is then evaluated through the
   *  normal apply path, so membrane marshaling / heap charging / provenance ride
   *  unchanged. A value with no such lowering — or a literal node NOT currently in
   *  lowering position (an R7RS `#(…)` constant; a membrane-boxed, non-literal
   *  AJSObject) — answers null: self-evaluating, no lowering. See
   *  eval/evaluator.ts "code-position lowering" for the datum-path dispatch. */
  ["arrival/tagless-final/lower"]?(): SchemeValue | null;
  /** Element count — the per-primitive divergence (elements' provenance) lives on the term. */
  ["arrival/tagless-final/length"]?(runCtx?: RunContext): AValue | number;
  /** Functor — map a fn over the elements (box-preserving or box-stripping per the term).
   *  `runCtx` REQUIRED: every real dispatcher
   *  (`env/r7rs/lists.ts`'s single-list `map`,
   *  `common/symbols/sequence.ts`'s wrapper) already threads `this.runCtx` — a live,
   *  defined RunContext — into the call, so an optional param here only ever bought a
   *  dead CONSTANT_CTX fallback at the implementor. Required mirrors `apply`'s own
   *  convention (declared required immediately below), the hottest term in this file. */
  ["arrival/tagless-final/map"]?(
    fn: (x: unknown) => unknown | Promise<unknown>,
    runCtx: RunContext,
  ): SchemeValue | Promise<SchemeValue>;
  /** Filterable — keep elements matching a pred (or RegExp). `runCtx` required — same
   *  reasoning as `map` above (`env/srfi/srfi-1.ts`'s dispatcher always threads it). */
  ["arrival/tagless-final/filter"]?(
    pred: ((x: unknown) => unknown | Promise<unknown>) | RegExp,
    runCtx: RunContext,
  ): SchemeValue | Promise<SchemeValue>;
  /** Foldable left-fold — scheme convention `fn(element, acc)`, seed last. `runCtx`
   *  required — same reasoning as `map` (`symbol.tagless`'s dispatcher always threads
   *  `this.runCtx`, the sole caller of this term). */
  ["arrival/tagless-final/reduce"]?<Acc>(
    fn: (element: unknown, acc: Acc) => Acc | Promise<Acc>,
    initial: Acc,
    runCtx: RunContext,
  ): Acc | Promise<Acc>;
  /** Ordering — a sorted sequence (container-preserving); default order is the elements'
   *  own `lte`. `runCtx` required — same reasoning as `map` (`env/srfi/srfi-95.ts`'s
   *  dispatcher always threads it; APair/AVector's own impls thread it into
   *  `deriveSortCompare`, op-helpers.ts). */
  ["arrival/tagless-final/sort"]?(
    comparator: ((a: unknown, b: unknown) => unknown) | undefined,
    runCtx: RunContext,
  ): SchemeValue;
  /** Prefix — the first n elements, in the receiver's OWN representation (list→fresh list
   *  with SRFI-1 dotted-tail tolerance; vector→fresh vector). `runCtx` required — same
   *  reasoning as `map` (`env/srfi/srfi-1.ts`'s sequence dispatcher always threads it). */
  ["arrival/tagless-final/take"]?(n: number, runCtx: RunContext): SchemeValue | Promise<SchemeValue>;
  /** Suffix — the receiver after its first n elements (list: the n-th cdr ITSELF, shared
   *  structure per SRFI-1; vector: a fresh same-kind vector). `runCtx` required — as `take`. */
  ["arrival/tagless-final/drop"]?(n: number, runCtx: RunContext): SchemeValue | Promise<SchemeValue>;
  /** Longest satisfying prefix — pred evaluated SEQUENTIALLY (the walk stops at the first
   *  falsy verdict, so filter's concurrent fan is not sound here); result in the receiver's
   *  own representation. `runCtx` required — `symbol.tagless`'s dispatcher always threads it. */
  ["arrival/tagless-final/take-while"]?(
    pred: (x: unknown) => unknown | Promise<unknown>,
    runCtx: RunContext,
  ): SchemeValue | Promise<SchemeValue>;
  /** The take-while remainder — list: a SHARED tail of the receiver; vector: a fresh
   *  same-kind vector. Same sequential-pred discipline and `runCtx` reasoning as take-while. */
  ["arrival/tagless-final/drop-while"]?(
    pred: (x: unknown) => unknown | Promise<unknown>,
    runCtx: RunContext,
  ): SchemeValue | Promise<SchemeValue>;
  /** Applicable — INVOKE this value as a procedure. Callability IS declaring this term: the
   *  evaluator call-head, the R7RS `apply` builtin, and every HOF dispatch through it uniformly,
   *  the same `resolveMethod` path `map`/`car` use. `args` are the scheme-value operands, `callCtx`
   *  is threaded WHOLE (never via `this` — `this` is the callable value itself, per the receiver
   *  convention) so the per-call invocation (provenance minting) arrives explicitly instead of
   *  being reconstructed downstream from ambient state; an impl that needs only the bare run state
   *  reads `callCtx.runCtx`. `canBounce` opts a lambda into the TCO bounce protocol (native/rosetta
   *  ignore it, only a scheme lambda reads it). */
  ["arrival/tagless-final/apply"]?(
    args: SchemeValue[],
    callCtx: CallCtx,
    canBounce?: boolean,
  ): SchemeValue | SchemeBounceMarker | Promise<SchemeValue>;
  /** Keyed member read — a member-carrying term (`AJSObject`, `ADict`, `AJSArray`) answers
   *  BOTH the `:key` keyword accessor's `apply` and the membrane's `readMember` face by
   *  implementing this. The key travels either as the caller's own SchemeValue (the keyword
   *  symbol itself — AKeywordSymbol hands itself) or as the face's normalized string; the
   *  RECEIVER decides how to fold/match it. Absence IS the semantics: a value without this
   *  term has no members (the face answers nil — Graal's "a leaf has no members"). A
   *  Promise-valued entry answers its lazy pending cell (a Promise of the settled box —
   *  pending-entry.ts); the async dispatch seams await it, and the read is sync after
   *  settlement. */
  ["arrival/tagless-final/get"]?(key: SchemeValue | string, runCtx?: RunContext): SchemeValue | Promise<SchemeValue>;
  /** Member existence — `@?`'s term; same receiver-owned key folding as `get`. */
  ["arrival/tagless-final/has"]?(key: SchemeValue | string): boolean;
  /** Own member names — `@keys`' term (JS-face strings; the polyglot verb boxes each). */
  ["arrival/tagless-final/keys"]?(): string[];
  /** Projection — the head of a pair-shaped term (APair computes on the term; ANil's is
   *  strict-gated: tolerant ⇒ nil, strict ⇒ the R7RS throw; AJSArray answers via its view). */
  ["arrival/tagless-final/car"]?(runCtx?: RunContext): SchemeValue;
  /** Projection — the tail (same family as `car`). */
  ["arrival/tagless-final/cdr"]?(runCtx?: RunContext): SchemeValue;
  /** Indexed read — the element at k (vector-shaped terms; a borrowed AJSArray answers too).
   *  A borrowed array's Promise-valued element answers its lazy pending cell (see `get`). */
  ["arrival/tagless-final/vector-ref"]?(k: number): SchemeValue | Promise<SchemeValue>;
  /** Semigroup — `this ⋄ other`: container-preserving PURE append (list/vector/bytevector
   *  concat builds a fresh spine, never mutates an operand). */
  ["arrival/tagless-final/concat"]?(other: unknown): SchemeValue;
  /** Traversable — effectful traversal; `of` lifts into the applicative. Return stays
   *  `unknown` honestly: the traversal's carrier is the applicative's, not the term's. */
  ["arrival/tagless-final/traverse"]?(of: (x: unknown) => unknown, f: (x: unknown) => unknown): unknown;
  /** Apply (Applicative) — accumulate through an applicative carrier (APair's traverse
   *  machinery probes it on mapped elements; optional — a carrier that implements it opts in). */
  ["arrival/tagless-final/ap"]?(other: unknown): unknown;
  // ── Type-predicate GUARDS (symbol.taglessGuard): the receiver answers its own kind; a value
  // lacking the method answers #f (the guard's graceful default — no instanceof reach-around).
  ["arrival/tagless-final/vector?"]?(): boolean;
  ["arrival/tagless-final/pair?"]?(): boolean;
  ["arrival/tagless-final/symbol?"]?(): boolean;
  ["arrival/tagless-final/char?"]?(): boolean;
}

/** Distinct-by-reference provenance sets: zero inputs → empty, one distinct set →
 *  forward it unchanged (singleton), two or more distinct sets → union them. */
export function unionProvenance(args: readonly AValue[]): ReadonlySet<number> {
  const distinct = new Set<ReadonlySet<number>>();
  for (const arg of args) {
    if (arg.provenance.size > 0) distinct.add(arg.provenance);
  }
  switch (true) {
    case distinct.size === 0:
      return EMPTY_PROVENANCE;
    case distinct.size === 1:
      return distinct.values().next().value!;
    default: {
      const merged = new Set<number>();
      for (const s of distinct) for (const x of s) merged.add(x);
      return merged;
    }
  }
}

/**
 * ADD an origin, never REPLACE one — the inbound membrane's stamping rule.
 *
 * ─── WHY THE MEMBRANE MUST BE ADDITIVE ───────────────────────────────────────────────────────
 *
 * A crossing is entitled to make a HOLISTIC claim — "the output is caused by the inputs, as a
 * whole" — because a JS impl is opaque and we cannot see that it didn't mix them. That claim is an
 * EDGE. What a crossing is NOT entitled to do is ERASE what the value already knew about its own
 * origin. Holistic means ADD AN EDGE, never REPLACE THE GRAPH.
 *
 * The membrane used to REPLACE (`withProvenanceDeep` re-stamped every node with the crossing's set).
 * That is not merely lossy — it can make a value's origin set NOT A SUPERSET of its true dependency
 * set, and THAT breaks the theorem the whole provenance layer stands on. `uneval` (provenance/
 * uneval.ts) reverse-slices a trace BY a value's provenance, and its soundness is stated in its own
 * header: "the language is pure dataflow with on-value provenance, so the effective value's origin
 * set IS its dependency set" (Galois slicing, Perera–Cheney). Drop an id and the slice is silently
 * TOO SMALL: the form that produced it is omitted, and the re-run cannot reproduce the value.
 *
 * The asymmetry is the whole point. OVER-approximation is safe — a larger sound slice still
 * re-derives, you merely lose minimality. UNDER-approximation is fatal, and silent. So the membrane
 * must be MONOTONE, and union is what makes `origin ⊇ dependencies` hold by construction.
 *
 * The reference-identity fast paths — `unionProvenance` forwarding a single distinct set's own Set
 * OBJECT, and the inbound re-stamp short-circuiting on `p === v.provenance` — happen to PRESERVE
 * additivity, but by identity accident, not by law. They are allocation-saving optimizations;
 * `origin ⊇ dependencies` holds only because UNION constructs it. Do not mistake the fast path for
 * the guarantee.
 *
 * (Granularity is NOT what this protects — that is reconstructed from the WIRING, not stored on the
 * value: the trace's `carrier-fields` classifies which field sub-expressions consumed which
 * producer, and `uneval` re-derives the access path on demand. The value carries only the point set.
 * What union protects is that point set's SOUNDNESS as a dependency set.)
 */
export function mergeProvenance(own: ReadonlySet<number>, added: ReadonlySet<number>): ReadonlySet<number> {
  if (added.size === 0 || own === added) return own;
  if (own.size === 0) return added;
  // Already subsumed — keep the existing SET OBJECT, so the identity fast paths downstream
  // (`p === v.provenance`) keep hitting and a re-crossing stays allocation-free and idempotent.
  let subsumed = true;
  for (const id of added) {
    if (!own.has(id)) {
      subsumed = false;
      break;
    }
  }
  if (subsumed) return own;
  return new Set([...own, ...added]);
}

export function pointProvenance(callId: number): ReadonlySet<number> {
  return new Set([callId]);
}

// ============================================================================
// INTEROP BOUNDARY (defensive on the abstract base): `accessMember`'s symbol-to-field
// auto-resolution walks the prototype chain of any object reachable from inference-plane
// scheme. Concrete subtypes are covered by the FAMILY RULE in interop-access.ts (own
// `[CLASS]` brand on the constructor = boundary) — they carry no per-class stamp anymore.
// The abstract base keeps this ONE explicit stamp as the defensive belt: a future
// CLASS-less subtype's walk still stops here, so exposure degrades to "blocked at
// AValue.prototype" rather than "exposed."
// ============================================================================
