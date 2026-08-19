// oracle-types.ts — structural contract for the pure static sampler (primitive 1).
//
// This is part of the kernel exported from the package root. It is deliberately substrate-free
// (no runtime dependencies on any model backend).
//
// Callers (llm-wiring in ./server, tests, custom backends) supply a compatible `OracleScanner`
// (typically from `@inhuman.tools/arrival/oracle` or a test stub).
// The TYPE-LAYER fields (`slotIsArray`, `elementIsStringy`, etc.) are stamped by the sampler's
// own `narrowByTypeAsync` — the base oracle never produces them. See mask-compiler.ts.
//
// This mirrors arrival `src/oracle/contract.ts` (itself a mirror of sift's canonical
// `oracle-contract.ts`). TWO TIERS: `StructuralOracleState` is a true SUBSET of arrival's OracleState
// (the fields the base oracle produces — any real `OracleScanner` satisfies it; contract-parity pins it
// field-by-field, as the `feasible ≡ !overClosed` property over a truncation corpus, AND as a
// compile-time subset of arrival's real type). `OracleState` extends it with the optional TYPE-LAYER
// fields the SAMPLER stamps — arrival never produces those (see OracleState's note).

/** Position of the token at/after the cursor — head = OPERATOR; later = ARGUMENT; depth-0 = TOP. */
export type CursorPosition = "top" | "operator" | "argument";

/** The kind of the enclosing form — `application` is the Σ-constrained case. */
export type FormKind = "top" | "application" | "lambda-list" | "quote" | "lazy-arm";

/** The STRUCTURAL base the real arrival oracle produces — a pure function of the accepted prefix, with
 *  NO type-layer stamping. This is the contract a cross-language reoracle must satisfy, and exactly what
 *  contract-parity pins (field-by-field + the `feasible ≡ !overClosed` property over a truncation corpus
 *  + a compile-time subset assertion against arrival's real type). Any real `OracleScanner` satisfies it. */
export interface StructuralOracleState {
  /** The cursor is inside an atom being typed (not at a token boundary). */
  readonly midToken: boolean;
  /** Operator / argument / top — the position of the token at/after the cursor. */
  readonly position: CursorPosition;
  /** The kind of the enclosing form. */
  readonly formKind: FormKind;
  /** Could the program legally END here? (depth 0, not mid-string/comment.) The EOS gate. */
  readonly closeable: boolean;
  /** A `)` appeared before its `(` — a real misnesting. `scanner.feasible(prefix) === !overClosed`,
   *  so the resumable session path reads STRUCTURAL feasibility off the session's own `state` instead
   *  of a second `feasible(prefix)` re-scan. (arrival: `feasible` is literally `!scan(p).overClosed`.) */
  readonly overClosed: boolean;
  /** Σ — bound identifiers valid at the cursor, position-filtered. `null` ⇒ Σ not modelled. */
  validSymbols(): ReadonlySet<string> | null;
}

/** The full state the mask consumes: the {@link StructuralOracleState} base PLUS the optional TYPE-LAYER
 *  tier the SAMPLER stamps (`narrowByTypeAsync` over a type lens). Arrival NEVER produces the typed fields
 *  — the base structural oracle leaves them unset and the precise gates no-op (grammar-mode) when unset.
 *  ⚠️ A reoracle that implements only the structural base and stubs these `undefined` PASSES contract-parity
 *  yet silently runs in grammar-mode: the typed tier is the SECOND, sampler-owned conformance boundary,
 *  pinned model-free by the structure/element gate tests (its real-lens path is the tsgo POC in __experiments__). */
export interface OracleState extends StructuralOracleState {
  /** The argument slot's TS type is an ARRAY/list type — stamped by the TYPE LAYER (the async typed
   *  scanner, from the lens's `slotIsArray` query), consumed by the precise list-structure gate. `true`
   *  ⇒ a value here must be a list materializer (reject scalar literals → fixes under-listing); `false`
   *  ⇒ a scalar (reject list literals → the literal kind of over-listing); `undefined`/`null` ⇒ unknown.
   *  The base STRUCTURAL oracle leaves it unset ⇒ NO structure-gate (grammar mode is byte-identical). */
  readonly slotIsArray?: boolean | null;
  /** The argument slot ADMITS A BARE WORD AS A STRING value — stamped by the TYPE LAYER (from the lens's
   *  `getSlotAcceptsBareWord` query), consumed by the scalar-string Σ exemption in `passesSigmaOnState`.
   *  `true` ⇒ the slot's TS type is a free-form `string`/`any` (NOT array, NOT number-only), so the model's
   *  bare value-word (`men`) is a fair materialization of the string value (`(fn men)` ≡ `(fn "men")`) and
   *  is exempted from the Σ bound-symbol gate HERE; `false` ⇒ number/boolean/object/array (a bare word stays
   *  Σ-masked — genuinely wrong); `undefined`/`null` ⇒ unknown (the exemption stays inert — the bare word
   *  stays Σ-gated, superset-safe). The base STRUCTURAL oracle leaves it unset ⇒ NO exemption (grammar mode
   *  byte-identical). ENUM slots resolve `false` — an enum member is already a bound value-symbol that passes
   *  Σ unaided, so it needs no exemption. */
  readonly slotIsStringy?: boolean | null;
  /** The ELEMENT type at an ARRAY-ELEMENT cursor is a free-form `string`/`any`/`unknown` — stamped by the
   *  TYPE LAYER (from the lens's `getSlotElementType` query), consumed by the array-element structure gate.
   *  `true` ⇒ the cursor sits at a value-START inside an array surface (`(list …)`, `'(…)`) whose ELEMENT is
   *  a string/any — a bare multi-word element whitespace-splits at the scorer, so the quoted form is FORCED
   *  here (bare-word START masked, `"` admitted; a nested list-opener masked). This is the INVERSE action of
   *  the scalar `slotIsStringy` (which ADMITS a bare word at a SCALAR string slot) — at an array element the
   *  bare word is MASKED. `false` ⇒ number/boolean/object/array-of-array element (no force-quote). `undefined`
   *  /`null` ⇒ not an array-element cursor / unresolved (the gate stays inert — superset-safe). The base
   *  STRUCTURAL oracle leaves it unset ⇒ NO force-quote (grammar mode byte-identical). */
  readonly elementIsStringy?: boolean | null;
  /** The argument slot's TS type is STRING-TYPED — a subtype of `string` (`string` or a closed
   *  string-literal union like `"a"|"b"`) and NOT an array — stamped by the TYPE LAYER (from the lens's
   *  `getSlotIsStringTyped` query), consumed by the structure gate. `true` ⇒ a non-string scalar literal
   *  (`#t`/`#f`/`#\c`, a NUMBER) is type-wrong at this slot and is MASKED (only a quoted string, a bound
   *  enum member via Σ, or a `T`-producing call belongs). This is DISTINCT from `slotIsStringy` (free-form
   *  `string`/`any`, which ADMITS a bare word): an ENUM is `slotIsStringTyped === true` (mask non-string
   *  literals) but `slotIsStringy===false` (its members are bound symbols, not free-form — no bare-word
   *  exemption). `false` ⇒ number/boolean/object/array (a `#`-literal / number may be RIGHT — not masked);
   *  `undefined`/`null` ⇒ unknown (the non-string-literal masking stays inert — superset-safe). The base
   *  STRUCTURAL oracle leaves it unset ⇒ NO masking (grammar mode byte-identical). */
  readonly slotIsStringTyped?: boolean | null;
  /** The PROVABLY-ARRAY-RETURNING head symbols valid at the cursor — stamped by the TYPE LAYER (from the
   *  lens's `getHeadReturnsArray` query over the slot's Σ), consumed by the TYPE-REACHABILITY gate. The
   *  subset of the slot's bound symbols whose `ReturnType` extends `readonly unknown[]` (`list`/`vector`/
   *  `append`-style materializers). Present ONLY in a SCALAR context (a scalar value slot, or a NESTED
   *  OPERATOR whose enclosing slot is scalar), where a call whose head returns an ARRAY is a dead end — its
   *  result `T[] ⊄ T` can never fill the scalar slot. The gate masks a `(head` opener (or a nested-operator
   *  head) iff its head can ONLY complete to one of these (no reachable, non-array head shares the prefix) —
   *  so a bare `(` (empty head, prefixes BOTH array and non-array heads) and `(car`/`(first` (element
   *  returns) stay ADMITTED, preserving the sequential-execution pipe. `undefined` ⇒ not a scalar context /
   *  unresolved ⇒ the reachability arm is a no-op (superset-safe — the `(head` opener stays admitted). The
   *  base STRUCTURAL oracle leaves it unset ⇒ NO reachability masking (grammar mode byte-identical). */
  readonly arrayReturningHeads?: ReadonlySet<string>;
  /** The ELEMENT type at an ARRAY-ELEMENT cursor is a closed STRING-LITERAL UNION — its MEMBERS — stamped by
   *  the TYPE LAYER (from the lens's `getSlotElementType` query). The Σ∩T array analog: at an array element
   *  whose type is an enum, narrow the legal symbols to exactly these members (mirrors the scalar enum
   *  narrowing, which the OUTER-slot `getTypeValidCandidates` handles but cannot reach inside `(list …)`'s
   *  `unknown` / `'(…)`'s quote). `undefined`/`null` ⇒ not a finite string-literal element (the free-form or
   *  non-array case) ⇒ no enum narrowing. The base STRUCTURAL oracle leaves it unset (grammar mode unchanged). */
  readonly elementEnum?: readonly string[] | null;
}

/** A resumable oracle over a growing prefix (arrival `contract.ts:OracleSession`). The session path
 *  in the lazy processor opens ONE of these over the committed prefix per step, then per candidate
 *  `clone().advance(candidateStr)` and reads `state` — O(candidateStr) instead of O(prefix) per
 *  candidate. STRUCTURAL SUBSET: only the members the per-candidate verdict derivation consumes. */
export interface OracleSession {
  /** Extend the accepted prefix by `text` (one or many tokens). */
  advance(text: string): void;
  /** A detached copy at the current prefix — for masking candidate continuations (no shared state). */
  clone(): OracleSession;
  /** The verdict at the current cursor. Byte-identical to `scanner.analyze(prefix)` for the same
   *  accumulated prefix (arrival builds both via the same `makeState(scan(prefix), …)`). */
  readonly state: OracleState;
}

/** The stateless oracle entry — analyse a whole prefix from scratch. The subset the mask consumes;
 *  any arrival `OracleScanner` (from `makeOracle(env?)`) satisfies this structurally. The optional
 *  `session` is the resumable perf seam: present on the real `makeOracle` scanners, absent on toy
 *  test stubs (the lazy processor falls back to the stateless re-scan when it is absent). */
export interface OracleScanner {
  analyze(prefix: string): OracleState;
  feasible(prefix: string): boolean;
  /** Open a resumable session seeded with an optional prefix. */
  session?(prefix?: string): OracleSession;
}
