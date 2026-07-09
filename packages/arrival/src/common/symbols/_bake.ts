// _bake: shared machinery behind arrival.symbol* EnvCapability — contract/decoded-type
// layer, the baked AEntity union + members, shared types + helpers the per-tag factory files
// (./native.ts, ./rosetta.ts, …) build their AEntity from directly (no separate bake* ctor — §4).
// Factories live one-per-file, re-assembled into `symbol` namespace by ./index.ts. Stable entry
// ../symbol.js re-exports both these types and `export * as symbol from "./index.js"`. Cut is acyclic:
// factories import from here; nothing imports back up through the namespace.
//
// One zod contract, four readers: runtime validation (z.parse), static impl types (z.infer via
// generics), harvested .d.ts (printer in type-layer/schema-to-ts.ts), JS↔Scheme membrane (each
// schema is the per-arg codec). This module builds the AUTHORED-extension layer:
//
//   const symbol = { native, rosetta, tagless, notImplemented, … }
//
// ─────────────────────────────────────────────────────────────────────────────
// THE RUNTIME MODEL (confirmed against live interpreter — src/rosetta.ts createRosettaWrapper,
// src/common/capability.ts ANativeProcedure/ARosettaProcedure binder):
//
//   symbol.native    schemas SCHEME-IDENTITY; impl over SCHEME VALUES (Pair, SchemeString, …).
//                    native() attaches { impl, in, out } with NO runtime validation and NO codec
//                    ("zod for TYPES purely"). capability.ts binds .impl into ANativeProcedure,
//                    invoked through `arrival/tagless-final/apply` — never a bare { value } binding.
//
//   symbol.rosetta   schemas CODECS; impl in JS-LAND (decoded). rosetta() produces wrapper:
//                    decode args → VALIDATE (zod, skippable) → impl.call(this, decodedArgs) →
//                    await (implicit) → encode return → build scheme values-list. Mirrors
//                    createRosettaWrapper schemeToJs → fn → jsToScheme spine. impl receives ONLY
//                    decoded scheme args POSITIONALLY — ctx never a param. ctx-coupled verbs read run-state
//                    off `this: CallCtx` (`this.runCtx.signal`, `this.invocation.currentInvocation`).
//                    PROVENANCE MINTING RESOLVED: evaluator appends ctx; wrapper reads this.invocation
//                    .currentInvocation and mints/deep-stamps exactly as createRosettaWrapper does
//                    (a `source`-role rosetta AEntity mints; `pipe` forwards — see `ProvenanceRole`
//                    below, PROVENANCE-PLAN.md Q2). withContext / argProvenance knobs DROPPED here.
//
//   symbol.notImplemented  no contract/impl, just `name: reason`. bake → door:
//                    { kind: "door", name, reason } (the %purity-door story).
// ─────────────────────────────────────────────────────────────────────────────

import * as z from "../scheme-zod.js";
import { AValue } from "../../values/primitives/AValue.js";
import { type RunContext } from "../../values/primitives/RunContext.js";
import { type CallCtx, makeCallCtx, missingCallCtxDoor, testCallCtx } from "../../values/primitives/CallCtx.js";
import { Macro } from "../../eval/Macro.js";
import { ZodType, ZodUnion } from "zod";
import { ProvenanceRoleShapeError } from "../../errors.js";

// ─────────────────────────────────────────────────────────────────────────────
// 1. The args-vector spec + decoded-type inference
// ─────────────────────────────────────────────────────────────────────────────

/** An args/return vector: a bare tuple of schemas (positional sugar) OR an array-ish
 *  schema (`z.array` variadic / `z.tuple` / `z.union` overload). */
export type VectorSpec = readonly z.ZodTypeAny[] | z.ZodTypeAny;

/** The TWO faces of one schema. A codec's `z.input` is its SCHEME face (AString, APair,
 *  ACallable) and its `z.output` the JS face (`string`, `array`, a callable) — one vocabulary,
 *  two processing rules: `symbol.native` (a CONTOUR, stays in value algebra) projects the scheme
 *  face; `symbol.rosetta` (the MEMBRANE, decode-in/encode-out) projects the JS face. A non-codec
 *  schema's faces coincide (`input ≡ output`), so pre-codec contracts type identically under
 *  either face — split is strictly additive. */
export type Face = "scheme" | "js";
type ProjectFaceAtom<S extends z.ZodTypeAny, F extends Face> = F extends "scheme" ? z.input<S> : z.output<S>;
type ProjectFaceArray<S extends z.ZodTypeAny[], F extends Face> = S extends [
  infer Head extends z.ZodTypeAny,
  infer Tail extends z.ZodTypeAny[],
]
  ? ProjectFace<Head, F> | ProjectFaceArray<Tail, F>
  : never;
type ProjectFace<S extends z.ZodTypeAny, F extends Face> =
  S extends ZodUnion<infer T extends z.ZodTypeAny[]> ? ProjectFaceArray<T, F> : ProjectFaceAtom<S, F>;

/** The ONE shared traversal: map a VectorSpec through the selected face (`z.output` for the
 *  membrane/JS face — the default, byte-identical to the pre-Face behavior — or `z.input` for
 *  the scheme face `symbol.native` projects). A tuple maps element-wise to a mutable tuple;
 *  a single schema infers bare (a variadic `z.array` schema's output is already an array,
 *  a scalar schema's output stays scalar).
 *  `DecodedArgs`/`DecodedReturn`/`DecodedArgsWithRest` are thin callers on top — they differ
 *  only in their OWN boundary handling (wrap a non-array single output in a 1-tuple; collapse
 *  a 1-tuple to its bare value), never in how a spec's shape decodes. */
export type SpecInfer<S extends VectorSpec, F extends Face = "js"> = S extends readonly z.ZodTypeAny[]
  ? { -readonly [K in keyof S]: ProjectFace<S[K] & z.ZodTypeAny, F> }
  : S extends z.ZodTypeAny
    ? ProjectFace<S, F>
    : never;

/** Decoded arg TYPES for the impl (selected face; default = codec OUTPUT/JS side). A bare
 *  tuple maps each element; an array-ish schema yields its element-array (variadic). */
export type DecodedArgs<S extends VectorSpec, F extends Face = "js"> =
  SpecInfer<S, F> extends readonly unknown[] ? SpecInfer<S, F> : [SpecInfer<S, F>];

/** Decoded RETURN type: single value when output is a 1-tuple, else the values-vector
 *  (multiple-values). */
export type DecodedReturn<O extends VectorSpec, F extends Face = "js"> = O extends readonly [z.ZodTypeAny]
  ? SpecInfer<O, F>[0]
  : SpecInfer<O, F>;

/** async is implicit — bake awaits. */
export type MaybePromise<T> = T | Promise<T>;

/** The variadic TAIL after a fixed leading `input` tuple:
 *  - a `z.ZodTypeAny` — repeated single element type (0+ times), the variadic-tail case; OR
 *  - a plain kwargs SHAPE record `{k: schema}` — trailing kwargs OBJECT. VALUES are schemas but
 *    the CONTAINER is a plain object, NOT a ZodType — the sound `instanceof z.ZodType`
 *    discriminator between the two (no combinator can make a plain record satisfy it).
 *  `undefined` = no rest (default). */
export type RestSpec = z.ZodTypeAny | Record<string, z.ZodTypeAny> | undefined;

/** Decoded arg types WITH a rest tail: `input`'s fixed-tuple decoded types, followed by a
 *  spread of `inputRest`'s element type (0+ times). A rest tail composes only with a FIXED
 *  leading tuple `input` (never a bare single/kwargs schema — no well-defined prefix length
 *  to split at), so a non-tuple `I` + a real `Rest` types to `never` rather than silently
 *  doing something else. No rest (`Rest` defaults to `undefined`) → today's `DecodedArgs<I>`,
 *  BYTE-IDENTICAL — strictly ADDITIVE, zero type/behavior difference for every existing
 *  declaration that doesn't set `inputRest`.
 *  `SpecInfer<I>` (not `DecodedArgs<I>`) supplies the fixed-tuple half — named as its OWN alias
 *  (not inlined) because TS's tuple-spread checker (error TS2574: A rest element type must be
 *  an array type) can't see a mapped type over a still-abstract `I` as array-shaped when
 *  written directly inside a `[...X, ...Y[]]` literal — a named alias resolves it. */
export type DecodedArgsWithRest<
  I extends VectorSpec,
  Rest extends RestSpec = undefined,
  F extends Face = "js",
> = Rest extends z.ZodTypeAny
  ? I extends readonly z.ZodTypeAny[]
    ? SpecInfer<I, F> extends infer Head extends readonly unknown[]
      ? [...Head, ...ProjectFace<Rest, F>[]]
      : never
    : never
  : Rest extends Record<string, z.ZodTypeAny>
    ? // kwargs: plain shape record `Rest` types the impl to ONE trailing arg — the decoded
      // kwargs OBJECT (each field projected through the face), a single object param NOT a spread.
      // Mirrors runtime `[z.decode(z.object(inputRest), fold(args))]`. `I` is `[]` at every
      // kwargs site (the whole call IS the object), so there's no fixed prefix to splice ahead of it.
      // Disjoint from the `z.ZodTypeAny` branch above: a plain record lacks ZodType's internals,
      // so it never matches `extends z.ZodTypeAny`.
      [{ [K in keyof Rest]: ProjectFace<Rest[K] & z.ZodTypeAny, F> }]
    : DecodedArgs<I, F>;

/** docs/PROVENANCE.md §2's declared-role vocabulary, data in string key space (P7) — the
 *  ONE field every symbol declaration carries instead of the retired `pure?`/`fanout?`
 *  booleans (PROVENANCE-PLAN.md Q2). `pipe`/`fan`/`source` are LIVE today (declaration
 *  defaults + the migrated booleans, below); `sink`/`transparent`/`loop`/`opaque` are
 *  GRAPH-LAYER targets no declaration marks yet (Q1's `src/values/lineage.ts` node kinds
 *  exist for them; Q3 wires the classifier to consume them) — the union names the full
 *  spec vocabulary now so `Contract.provenance`'s type is stable across Q2/Q3/Q4, not
 *  narrowed to "whatever's reachable today". */
export type ProvenanceRole = "pipe" | "fan" | "source" | "sink" | "transparent" | "loop" | "opaque";

/** A symbol's input/output contract. */
export interface Contract<I extends VectorSpec, O extends VectorSpec, Rest extends RestSpec = undefined> {
  input: I;
  /** Variadic TAIL after `input`'s fixed leading positions (e.g. `apply`'s callable first arg
   *  is `input`, its spread call-args are `inputRest`) — a fixed head with its OWN generic
   *  type parameter separate from the tail's, so the two can differ. Only meaningful when
   *  `input` is a fixed tuple — combining with a bare single-schema `input` is a contract-
   *  authoring error: `normalizeInputVector` throws. Absent ⇒ byte-identical to pre-`inputRest`. */
  inputRest?: Rest;
  output: O;
  /** Ambient `.d.ts` member-body signature override — e.g. `"(ip: SchemeIP) => SchemeIP"` —
   *  for the harvest (`schema-to-ts.ts`'s `signatureOf`), DECOUPLED from `input`/`output` zod
   *  schemas. Zod schemas stay the MEMBRANE description (what actually crosses at runtime);
   *  `type` is a separate author-asserted TYPE-LEVEL narrowing for what the harvest wants to
   *  see that zod can't itself express (a host entity type like `SchemeIP`, not just the honest
   *  `z.output` the membrane decodes to). Mirrors legacy `RosettaSpec.type`/`RosettaFunction.type`
   *  — author assertion, not mechanically derived, checkable by eye. INERT everywhere except
   *  the harvest: `native()`/`rosetta()`/`sequence()` carry it through; `signatureOf` prefers
   *  it over computing from `in`/`out`. Absent ⇒ byte-identical to zod-derived signature. */
  readonly type?: string;
  /** Declared PROVENANCE ROLE (docs/PROVENANCE.md §2's declaration vocabulary,
   *  PROVENANCE-PLAN.md Q2) — ONE key-space string per symbol, not a bag of booleans.
   *  `undefined` here means "this kind's default": `native()`/`sequence()`/`tagless()`/
   *  `taglessGuard()` default to `"pipe"` (pure pass-through — propagate, never mint);
   *  `rosetta()` defaults to `"source"` (mint a fresh point). The two ad-hoc booleans this
   *  field replaces are RETIRED (spec §2 EXCLUDED — "each had exactly two readers"):
   *  rosetta's old `pure: true` ⇒ `"pipe"` (forwards the input-provenance union instead of
   *  minting — BYTE-IDENTICAL behavior, rosetta.ts); native/sequence's old `fanout: true` ⇒
   *  `"fan"`. The RESOLVED role lands on the baked def (`NativeSymbolDef.provenance` etc.);
   *  capability.ts stamps it onto the bound callable (`provenanceRole`) so the lineage
   *  classifier reads it off `env.get(op)` — never a duck-read off an ad-hoc property (spec
   *  §2's EXCLUDED "heuristic classification"). See `assertProvenanceRoleShape` below for the
   *  two SHAPE-decidable contradictions this field is checked against at bake time. */
  readonly provenance?: ProvenanceRole;
  /** KIND-AGNOSTIC (native/rosetta). `true` = ASSEMBLY-TIME-ONLY: binds into the assembly's
   *  phase-gated prelude scope (kernel.ts `assembleEnv` — per-assembly Map answered by a resolver
   *  on the base env during the C3 loop), never into the runtime env. Callable from any later-
   *  applied capability's prelude during assembly; plain unbound-variable error at runtime —
   *  INCLUDING from lambdas a prelude defined (closures walk the live chain at call time).
   *  A prelude bridges a preludeOnly value to runtime by capturing the call's RESULT in an
   *  ordinary define, never the verb itself.
   *  See docs/package-specific/arrival-scheme/prelude-only-symbols-and-composable-prompt-2026-07-02.md §1. */
  readonly preludeOnly?: boolean;
}

// CallCtx/makeCallCtx moved to values/primitives/CallCtx.ts: ACallable.ts needs makeCallCtx
// as a real call; importing it from here closed a cycle (ACallable.ts → scheme-zod.ts → this
// file) that could leave a `z.instanceof(...)` codec's captured class permanently undefined
// depending on which path entered first. Re-exported here (not just imported) so existing
// `_bake.js` importers are unaffected.
export type { CallCtx };
export { makeCallCtx, testCallCtx, missingCallCtxDoor };

/** The impl a contract demands: decoded args in, decoded return (or a promise) out.
 *  `DecodedArgsWithRest` strips `readonly` (`-readonly` mapped tuple) so a `const`-inferred
 *  contract tuple becomes a MUTABLE positional param list; splices in `inputRest`'s decoded
 *  element type as a spread tail when declared.
 *  `F` selects the face: `"js"` (default — rosetta, decoded membrane side) or `"scheme"`
 *  (native — value-algebra side; `symbol.native` passes it). */
export type Impl<
  I extends VectorSpec,
  O extends VectorSpec,
  Rest extends RestSpec = undefined,
  F extends Face = "js",
> = (this: CallCtx, ...args: DecodedArgsWithRest<I, Rest, F>) => MaybePromise<DecodedReturn<O, F>>;

// ─────────────────────────────────────────────────────────────────────────────
// 2. AEntity — the baked discriminated union. Interpreter primitive, TYPE-ONLY (no class/runtime
//    footprint: the def itself is a plain object for every kind). RUNTIME BOUND VALUE capability.ts
//    installs differs by kind — plain object for door/keyword/macro, but a first-class
//    ANativeProcedure/ARosettaProcedure (ACallable subclass, invoked through `arrival/tagless-
//    final/apply`) for native/rosetta/tagless/tagless-guard/sequence — never a bare callable fn.
// ─────────────────────────────────────────────────────────────────────────────

type AnyFn = (...args: any[]) => unknown;

/** A native symbol: impl over SCHEME VALUES, no validation. Identity schemas for .d.ts harvest. */
export interface NativeSymbolDef {
  readonly kind: "native";
  readonly name: string;
  readonly doc?: string;
  readonly in: z.ZodTypeAny;
  readonly out: z.ZodTypeAny;
  readonly impl: AnyFn;
  /** See `Contract.type`. */
  readonly type?: string;
  /** See `Contract.preludeOnly`. */
  readonly preludeOnly?: boolean;
  /** RESOLVED provenance role (`contract.provenance ?? "pipe"` — see `Contract.provenance`).
   *  Non-optional: `native()` always resolves the default before baking. */
  readonly provenance: ProvenanceRole;
}

/** A rosetta symbol: impl in JS-land. `in`/`out` are codec schemas; `run` is the
 *  decode→validate→impl→encode wrapper produced by bake.
 *
 *  `M` = optional metadata (e.g. MCP annotations). Stored under `.metadata` so higher layers
 *  (arrival-mcp) carry tool-specific data without polluting the core schema.
 */
export interface RosettaSymbolDef<
  I extends z.ZodTypeAny = z.ZodTypeAny,
  O extends z.ZodTypeAny = z.ZodTypeAny,
  M extends Record<string, any> = Record<string, any>,
> {
  readonly kind: "rosetta";
  readonly name: string;
  readonly doc?: string;
  readonly in: I;
  readonly out: O;
  /** Raw JS-land impl (decoded args → result). Kept for harvest / inspection. */
  readonly impl: AnyFn;
  /** The interpretive wrapper: (…schemeArgs[, ctx]) => Promise<schemeValuesList>. Decodes
   *  (+ optionally validates) inputs, runs the (ctx-free) impl, awaits, encodes the output,
   *  then MINTS provenance off the evaluator-appended ctx (same spine as createRosettaWrapper —
   *  see `rosetta()` factory's `run` wrapper in rosetta.ts). */
  readonly run: (this: CallCtx, ...schemeArgs: unknown[]) => Promise<unknown>;
  /** RESOLVED provenance role (`contract.provenance ?? "source"` — see `Contract.provenance`).
   *  `"pipe"` = transform (forwards input provenance); `"source"` (default) mints. Non-optional:
   *  `rosetta()` always resolves the default before baking. Replaces the retired `pure?: boolean`
   *  (PROVENANCE-PLAN.md Q2 — `pure: true` migrated to `"pipe"`, byte-identical behavior). */
  readonly provenance: ProvenanceRole;
  /** See `Contract.type`. */
  readonly type?: string;
  /** See `Contract.preludeOnly`. */
  readonly preludeOnly?: boolean;
  /** Extra data carried by this symbol (MCP tool annotations, etc.). */
  readonly metadata?: M;
}

/** Tagless symbol: NO impl — bypass to operand's own `arrival/tagless-final/<name>`. `run` is
 *  ctx-aware dispatcher (receiver = last scheme arg, per scheme's `(op …args collection)`
 *  convention) that hands the method the run's RunContext as trailing arg, with detailed error
 *  when operand declares no such method. */
export interface TaglessSymbolDef {
  readonly kind: "tagless";
  readonly name: string;
  readonly doc?: string;
  readonly in: z.ZodTypeAny;
  readonly out: z.ZodTypeAny;
  readonly run: (...schemeArgs: unknown[]) => Promise<unknown>;
  /** Always `"pipe"` — `tagless()` takes no `Contract`, so there is no author override
   *  channel yet (see `Contract.provenance`'s kind-default table). */
  readonly provenance: ProvenanceRole;
}

/** Tagless GUARD — like `symbol.tagless`, but a receiver with no such method yields `#f` (graceful
 *  predicate) rather than throwing. Dispatch form for type predicates: `(vector? x)` asks x's OWN
 *  `arrival/tagless-final/vector?`, defaulting to `#f` when x can't answer — no host-type
 *  `instanceof` reach-around in the builtin. */
export interface TaglessGuardSymbolDef {
  readonly kind: "tagless-guard";
  readonly name: string;
  readonly doc?: string;
  readonly in: z.ZodTypeAny;
  readonly out: z.ZodTypeAny;
  readonly run: (...schemeArgs: unknown[]) => Promise<unknown>;
  /** Always `"pipe"` — same rationale as `TaglessSymbolDef.provenance`. */
  readonly provenance: ProvenanceRole;
}

/** Ctx-aware op: impl receives scheme args AND the run's RunContext (dual of `symbol.native`,
 *  which is ctx-FREE). For kernel-logic-bearing ops that aren't pure per-receiver dispatch
 *  (map/filter/reduce charge `runCtx.heapMeter`, then dispatch to the term's own algebra).
 *  `run` is the ctx-aware wrapper that strips evaluator ctx, extracts runCtx, calls impl. */
export interface SequenceSymbolDef {
  readonly kind: "sequence";
  readonly name: string;
  readonly doc?: string;
  readonly in: z.ZodTypeAny;
  readonly out: z.ZodTypeAny;
  readonly run: (this: CallCtx, ...schemeArgs: unknown[]) => Promise<unknown>;
  /** See `Contract.type`. */
  readonly type?: string;
  /** RESOLVED provenance role (`contract.provenance ?? "pipe"` — see `Contract.provenance`).
   *  Non-optional: `sequence()` always resolves the default before baking. Replaces the
   *  retired `.fanout` stamped onto `run` (PROVENANCE-PLAN.md Q2). */
  readonly provenance: ProvenanceRole;
}

/** An omitted verb (errors-as-doors). No contract/impl — just the teaching reason. */
export interface DoorSymbolDef {
  readonly kind: "door";
  readonly name: string;
  readonly reason: string;
}

/** A kernel KEYWORD: special form, made first-class. `lower()` binds `new Keyword(name)`; the
 *  evaluator resolves a call head through the env and dispatches `SPECIAL_FORMS[name]` when it
 *  resolves to that marker — aliasable + lexically shadowable (the dual of cxr). */
export interface KeywordSymbolDef {
  readonly kind: "keyword";
  readonly name: string;
  readonly doc?: string;
}

/** Non-evaluating MACRO form: impl is a raw JS transformer (a `Macro`/`Syntax`), bound as-is by
 *  assembly — NOT arg-evaluating (native/rosetta) nor evaluator-dispatched (keyword). Home for
 * syntax-rules + the macro family carrying a JS expander; generic `is_macro`/`is_syntax` eval
 * hook expands whatever it binds. */
export interface MacroSymbolDef {
  readonly kind: "macro";
  readonly name: string;
  readonly macro: Macro;
}

export type AEntity =
  | NativeSymbolDef
  | RosettaSymbolDef
  | TaglessSymbolDef
  | TaglessGuardSymbolDef
  | SequenceSymbolDef
  | DoorSymbolDef
  | KeywordSymbolDef
  | MacroSymbolDef;

// ─────────────────────────────────────────────────────────────────────────────
// 3. Internals — name/doc parsing + vector normalization
// ─────────────────────────────────────────────────────────────────────────────

/** Parse `"name: human description"` from a tagged-template. Substitutions interpolated first,
 *  then split on FIRST ": " (colon-SPACE) — the name/doc separator, per how every `symbol
 *  .notImplemented`/`symbol.native` template is actually authored ("name: doc"). Split on
 *  first bare colon is WRONG for a canonical name that itself CONTAINS a colon (SRFI-14's
 *  `char-set:whitespace: …`): bare-colon split truncates the name at "char-set". A colon inside
 *  the name is never followed by space (`char-set:whitespace`, `char-set:alphabetic`) — only
 *  the real name/doc separator is — so this handles both `name: doc` and `name:with:colons: doc`.
 *  No ": " ⇒ whole string is the name (doc undefined). */
export function parseNameDoc(tpl: TemplateStringsArray, sub: readonly unknown[]): { name: string; doc?: string } {
  let raw = "";
  for (let i = 0; i < tpl.length; i++) {
    raw += tpl[i];
    if (i < sub.length) raw += String(sub[i]);
  }
  const sep = raw.indexOf(": ");
  if (sep === -1) return { name: raw.trim() };
  return { name: raw.slice(0, sep).trim(), doc: raw.slice(sep + 1).trim() };
}

/** A zod schema describing a whole args/return VECTOR — its codec sides are array-shaped
 *  (a tuple `[a, b]` IS a `readonly unknown[]`; an array-ish schema's `T[]` is too). Typing
 *  the normalized schema this way lets `z.decode`/`z.encode` infer `readonly unknown[]` at
 *  the call site instead of `unknown` (a `ZodTypeAny`'s output) — so the wrapper reads the
 *  decoded args / encoded values-vector as an array WITHOUT an `as unknown[]` cast each time. */
type VectorSchema = z.ZodType<readonly unknown[], readonly unknown[]>;

/** Read a kwargs KEY off a raw scheme call arg — a `:key` argument is a self-evaluating ASymbol
 *  (keyword-tagless-apply.md), read the same way `dict`'s native impl reads one (env/polyglot.ts):
 *  stringify and strip a leading `:`. One protocol, shared here because a kwargs rosetta's input
 *  lowering folds the identical `:key value` pair sequence `dict` already folds. */
function kwargsKeyOf(arg: unknown): string {
  return String(arg).replace(/^:/, "");
}

/** Fold a `(tool :k v :k2 v2 …)` call's interleaved scheme args into the RAW kwargs object —
 *  a plain JS record keyed by kwargs shape's field names, valued by RAW (still-encoded) scheme
 *  values. The kwargs schema's OWN `z.decode` (run by caller, directly against the object
 *  schema — see `rosetta()` factory in rosetta.ts) then validates + decodes each field through
 *  its own per-property codec; this fold only does the array→object RESHAPE, not the per-field
 *  decode. A dangling keyword (odd arg count) doors with a teaching error. */
export function collectKwargsObject(args: readonly unknown[]): Record<string, unknown> {
  if (args.length % 2 !== 0) {
    throw new Error(
      `kwargs call has a dangling keyword with no value — expected interleaved \`:key value\` pairs, got ${args.length} arg(s)`,
    );
  }
  const obj: Record<string, unknown> = {};
  for (let i = 0; i + 1 < args.length; i += 2) {
    obj[kwargsKeyOf(args[i])] = args[i + 1];
  }
  return obj;
}

/** Normalize a VectorSpec to ONE `VectorSchema` describing the whole args/return vector:
 *  a bare tuple → `z.tuple`; an array-ish schema → itself. This is what `run` parses the
 *  decoded-args array against (and what the harvest prints from). (Kwargs no longer ride this
 *  fn: a kwargs contract is `input: []` + plain-record `inputRest`, folded to an object schema
 *  by `normalizeInputVector`, never a single object `input` reaching here.) */
export function normalizeVector(spec: VectorSpec): VectorSchema {
  // `Array.isArray`'s type guard is `arg is any[]`, which does NOT narrow a `readonly` array
  // OUT of the union on the false branch — so probe the tuple member with a guard that carries
  // the `readonly` element type, leaving the single-schema member on the `else`.
  if (isSchemaTuple(spec)) {
    // z.tuple wants a non-empty tuple of items; an empty contract ([]) is the 0-arg case.
    // The `[head, ...tail]` annotation is the only narrowing needed (a non-empty array can't be
    // proven from `.length`); a tuple's `out Output` IS array-shaped, so it assigns to
    // `VectorSchema` with no bridge.
    return spec.length === 0 ? z.tuple([]) : z.tuple(spec as [z.ZodTypeAny, ...z.ZodTypeAny[]]);
  }
  // A single array-ish schema (z.array variadic / a tuple / a union of those) — its codec sides
  // are array-shaped by the VectorSpec contract, but a bare `ZodTypeAny`'s static output is
  // `unknown`, so assert the vector shape ONCE here (the inner twin of the harvest-surface
  // contract) rather than on each decode/encode result.
  return spec as VectorSchema;
}

/** Is a VectorSpec the bare-tuple member (a positional list of schemas) rather than a single
 *  array-ish schema? A `readonly`-aware `Array.isArray` so the `else` branch narrows to the
 *  single-schema member (the stock guard's `arg is any[]` leaves `readonly` arrays in the union). */
function isSchemaTuple(spec: VectorSpec): spec is readonly z.ZodTypeAny[] {
  return Array.isArray(spec);
}

/** Normalize a contract's INPUT side to ONE combined `VectorSchema`, folding `inputRest` (when
 *  present) into a `z.tuple(fixed, rest)` — the SAME shape `def.in` already prints/decodes for a
 *  hand-authored variadic tuple (map/filter's `input: z.tuple([z.unknown()], z.unknown())`);
 *  `inputRest` just gives that shape a name split across two contract fields instead of one
 *  schema authored inline, so a fixed head and its variadic tail can be typed independently
 *  (`DecodedArgsWithRest`'s two generic params). Absent `inputRest` ⇒ byte-identical to
 *  `normalizeVector(input)` — this is what `native()`/`rosetta()` call for `.in`/`inSchema`
 *  (OUTPUT side stays plain `normalizeVector(contract.output)`, no rest concept there). */
export function normalizeInputVector(input: VectorSpec, inputRest: RestSpec): VectorSchema {
  if (inputRest === undefined) return normalizeVector(input);
  // kwargs: a plain shape record `inputRest` (values are ZodType, the CONTAINER is not) means the
  // whole call is a trailing kwargs OBJECT, not a variadic element. `.in` becomes the bare
  // `z.object(shape)` so the harvest prints the kwargs signature; `run` folds the raw `:k v` args
  // into that object at decode time. instanceof is the sound discriminator — no combinator can
  // make a plain record satisfy `instanceof z.ZodType`. (Cast: an object schema isn't array-shaped,
  // but the kwargs decode path never parses the raw args array against it, the same benign cast
  // the single-schema arm of `normalizeVector` already makes.)
  if (!(inputRest instanceof ZodType)) return z.object(inputRest) as unknown as VectorSchema;
  // A real `z.ZodType` `inputRest` (variadic tail) needs a FIXED prefix length to split the call's
  // raw args at — only a tuple `input` has one; a single-schema `input` covers the WHOLE call with
  // no well-defined split point. Combining `inputRest` with a single schema is a contract-authoring
  // bug: fail loudly here rather than silently ignoring the rest schema.
  if (!isSchemaTuple(input)) {
    throw new Error(
      "inputRest requires `input` to be a fixed positional tuple (e.g. [z.string]) — a single " +
        "schema `input` has no well-defined prefix length to split the rest at",
    );
  }
  // Mirrors the exact `z.tuple(fixed, rest)` call shape `map`/`filter` already author inline —
  // the cast narrows the (possibly empty, per `readonly z.ZodTypeAny[]`) tuple to the non-empty
  // form `z.tuple`'s rest-bearing overload demands; zod's own runtime doesn't care about the
  // static arity either way.
  return z.tuple(input as [z.ZodTypeAny, ...z.ZodTypeAny[]], inputRest) as VectorSchema;
}

/** Author gave a 1-tuple output? Then impl returns a SINGLE value (we wrap as 1-element
 *  values-list); otherwise it returns the values-vector already. */
export function isSingleOutput(output: VectorSpec): boolean {
  return Array.isArray(output) && output.length === 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3b. The DRIFT ALARM — declared `provenance` role vs contract SHAPE (docs/PROVENANCE.md
//     §2, PROVENANCE-PLAN.md Q2). Two contradictions are SHAPE-decidable; everything else
//     needs the JS body, which shape can't see (spec §2's own LIMIT).
// ─────────────────────────────────────────────────────────────────────────────

/** Every schema at a NORMALIZED VectorSchema's top level (see `normalizeVector`/
 *  `normalizeInputVector`) — a `z.tuple`'s items, an array-ish schema's lone element
 *  (wrapped as a 1-list so both shapes iterate uniformly), or `undefined` for anything else
 *  (a kwargs `z.object`, a bare non-container schema) — the checks below fall back to their
 *  own conservative default rather than guess past this. Same zod-4.3.6 `_zod.def` shape
 *  `type-layer/schema-to-ts.ts`'s `signatureOf` already introspects (verified there); a local
 *  copy because that module wants a differently-shaped return (printer-facing `TupleDef`/
 *  `ArrayDef`) and importing it here would pull the harvest/printer world into the bake layer. */
function topLevelSchemas(schema: z.ZodTypeAny): readonly z.ZodTypeAny[] | undefined {
  const def = (
    schema as {
      _zod?: { def?: { type?: string; items?: readonly z.ZodTypeAny[]; element?: z.ZodTypeAny } };
    }
  )._zod?.def;
  if (def?.type === "tuple") return def.items ?? [];
  if (def?.type === "array" && def.element) return [def.element];
  return undefined;
}

/** DRIFT ALARM (errors-as-doors): throws `ProvenanceRoleShapeError` when a declared
 *  `provenance` role CONTRADICTS its own contract's shape. Called at ASSEMBLY (bake time —
 *  `native()`/`rosetta()`/`sequence()`, on the schemas each already normalizes), never at
 *  call time — a wrong role is a declaration-authoring bug, not a runtime condition.
 *
 *  1. `sink`/`transparent` both claim NO real egress ("a sink is a port with no egress
 *     wire"; "a transparent crossing neither mints nor stamps" a value — lineage.ts) — a
 *     contract whose normalized OUTPUT vector carries a real return schema contradicts
 *     either.
 *  2. `fan` claims "apply this proc across elements" (map/filter/vector-map) — a contract
 *     whose normalized INPUT vector carries no `z.lambda` arm has no proc to apply.
 *
 *  LIMIT (spec §2, restated here — do not extend this function past it): shape catches
 *  CONTRADICTIONS, not LIES. A JS body that fans while declared `pipe` is
 *  consistent-but-wrong and invisible to shape; contract shape cannot see JS bodies, and
 *  arrange-vs-membership is semantic, not structural. Mitigation for that class is the W1
 *  agreement gate (spec §7) plus the generator corpus, never a shape guess bolted on here. */
export function assertProvenanceRoleShape(
  name: string,
  role: ProvenanceRole,
  inSchema: z.ZodTypeAny,
  outSchema: z.ZodTypeAny,
): void {
  if (role === "sink" || role === "transparent") {
    const items = topLevelSchemas(outSchema);
    const hasEgress = items === undefined ? true : items.length > 0;
    if (hasEgress) {
      throw new ProvenanceRoleShapeError(
        name,
        role,
        role === "sink"
          ? "a sink is a port with no egress wire, but this contract's output vector carries a real return value"
          : "a transparent crossing neither mints nor stamps a returned value, but this contract's output vector carries one",
      );
    }
  }
  if (role === "fan") {
    const items = topLevelSchemas(inSchema);
    const hasLambda =
      items === undefined ? z.lookupName(inSchema) === "lambda" : items.some((item) => z.lookupName(item) === "lambda");
    if (!hasLambda) {
      throw new ProvenanceRoleShapeError(
        name,
        role,
        "a fan op applies a proc across elements, but this contract's input vector has no z.lambda arm to apply",
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Shared contract-impl types the per-tag factories build their return value from.
//    NO separate "bake*` ctor anymore (see below — `bakeNative`/`bakeRosetta`/`bakeDoor`
//    used to live here) — each factory (`native.ts`/`rosetta.ts`/`sequence.ts`/…) wires its
//    own `AEntity` member directly from these types + helpers above.
// ─────────────────────────────────────────────────────────────────────────────

/** The impl a `symbol.sequence` contract demands: ONE args array (not spread — dual of native/
 *  rosetta's `Impl<I,O,Rest>`, which spreads positionally) typed via `DecodedArgs<I>`, the run's
 *  RunContext, decoded return (or promise) out via `DecodedReturn<O>`. Projects the SCHEME face
 *  (like `symbol.native` — a sequence op is a ctx-aware CONTOUR over scheme values, never a
 *  membrane crossing). No `Rest`: a sequence contract never carries `inputRest` (map/filter/sort's
 *  variadic tail is the tagless receiver's own term algebra, not a contract rest slot). */
export type SequenceImpl<I extends VectorSpec, O extends VectorSpec> = (
  args: DecodedArgs<I, "scheme">,
  runCtx: RunContext,
) => MaybePromise<DecodedReturn<O, "scheme">>;

/** Per-invocation knobs the wrapper honors. `validate` mirrors the design's `exec(src, { typecheck })`
 *  — see the decode note in `rosetta.ts` for the current fused-transform caveat. */
export interface BakeRuntimeOpts {
  /** Run zod validation on decoded args + encoded output. Default true. */
  validate?: boolean;
  /** Arbitrary metadata to attach to the symbol (e.g. MCP tool annotations). Stored in `.metadata`
   *  on the resulting RosettaSymbolDef. Use generic `RosettaSymbolDef<M>` to type it. */
  metadata?: Record<string, any>;
}

// `bakeNative`/`bakeRosetta`/`bakeDoor` used to live here as separately-importable
// constructors, each taking a `{kind, name, doc, contract, impl}` bag. DISSOLVED (2026-07):
// the same logic is now inlined directly into the returned closure of `native()`/`rosetta()`
// /`notImplemented()` (one file each) — producing a NativeSymbolDef/RosettaSymbolDef/DoorSymbolDef
// is ONLY possible by calling `symbol.native`/`symbol.rosetta`/`symbol.notImplemented`. No raw
// ctor here to reach around them with.

/** Human description of a receiver for the type-mismatch error: AValue reports its scheme `kind`
 *  ("number"/"pair"/"nil"/…), else the JS shape. */
export function describeReceiver(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (v instanceof AValue) return v.kind;
  return Array.isArray(v) ? "array" : typeof v;
}

/** A receiver's tagless-final term method: scheme args (leading operands + the run's RunContext)
 *  in, op result out. Always called with the receiver as `this`. */
type TermMethod = (this: unknown, ...args: unknown[]) => unknown;

/** Resolve a named term method off a (possibly non-object) receiver, typed — the dispatch
 *  primitive both `tagless()` (tagless.ts, throws when absent) and `taglessGuard()` (taglessGuard.ts,
 *  #f when absent) stand on, plus `srfi-1`'s `filter` sequence. Reads the member only when the
 *  receiver is a real object, returns the callable iff it IS one, else `undefined` — call site
 *  decides missing-policy without a raw `receiver as Record` / `fn as callable` cast. */
export function resolveMethod(receiver: unknown, method: string): TermMethod | undefined {
  if (receiver == null || (typeof receiver !== "object" && typeof receiver !== "function")) return undefined;
  const fn = (receiver as Record<string, unknown>)[method];
  return typeof fn === "function" ? (fn as TermMethod) : undefined;
}

// `bakeTagless`/`bakeTaglessGuard`/`bakeSequence` used to live here too, same reason as the
// `bake*` ctors above — DISSOLVED, inlined into `tagless()`/`taglessGuard()`/`sequence()`.

// Tagged-template factories (`native`/`rosetta`/`tagless`/…) live one-per-file under this
// directory; each imports shared types + helpers from here (NOT a `bake*` ctor — gone) and is
// re-assembled into `symbol` namespace by `./index.ts`. See `../symbol.js` for stable entry.
