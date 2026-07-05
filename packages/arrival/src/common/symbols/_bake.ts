// symbols/_bake — the SHARED machinery behind the `arrival.symbol*` EnvCapability
// symbol-definition API: the contract/decoded-type machinery, the baked `AEntity`
// union + its members, and the `bake*` constructors the per-tag factory files
// (`./native.ts`, `./rosetta.ts`, …) stand on. The factories live one-per-file under
// this directory and are re-assembled into the `symbol` namespace by `./index.ts`;
// the package's stable entry `../symbol.js` re-exports BOTH this module's types and
// `export * as symbol from "./index.js"`. The cut is acyclic: factory files import
// the bake fns + types from HERE; nothing here imports back up through the namespace.
//
// One zod contract, read (eventually) four ways: runtime validation (z.parse), static
// impl types (z.infer via the generics here), the harvested .d.ts (printed from the
// schema — printer BUILT in type-layer/schema-to-ts.ts; type-lens wiring pending), and the JS↔Scheme membrane (each
// schema is the per-arg codec). This module builds the AUTHORED-extension layer:
//
//   const symbol = { native, rosetta, tagless, notImplemented, … }
//
// so `import * as arrival from "../symbol.js"` →  arrival.symbol.native`name: doc`(…)
//
// ─────────────────────────────────────────────────────────────────────────────
// THE RUNTIME MODEL (the interpretive call) — confirmed against the live interpreter
// (src/rosetta.ts createRosettaWrapper, and the `{ value }` env.set path):
//
//   symbol.native    — schemas are SCHEME-IDENTITY; impl works on SCHEME VALUES
//                       (Pair, SchemeString, …), exactly like today's { value: fn }
//                       ops. bake.native attaches { impl, in, out } with NO runtime
//                       validation and NO codec — "zod for TYPES purely" (the schema
//                       is there for static inference + the future .d.ts harvest). The
//                       baked .impl IS the binding (≈ today's { value } + type metadata).
//
//   symbol.rosetta   — schemas are CODECS; impl works in JS-LAND (decoded). bake.rosetta
//                       produces a wrapper:  decode args (codec) → VALIDATE (zod parse,
//                       skippable/gated) → impl.call(invCtx, decodedArgs) → await (async
//                       implicit) → encode return (codec) → build the scheme values-list. This
//                       mirrors createRosettaWrapper's schemeToJs → fn → jsToScheme spine, with
//                       the codecs standing in for the generic schemeToJs/jsToScheme.
//                       The impl receives ONLY the decoded scheme args POSITIONALLY — ctx is
//                       never a param. ctx-coupled verbs read run-state lazily off a per-call
//                       invocation-`this` (`this.aborted` / `this.abortSignal` / `this.invocation`
//                       — accessor getters over the captured ctx); a pure verb is an arrow that
//                       ignores `this`, so the call is byte-identical to `impl(decodedArgs)` and
//                       materializes nothing. (This lazy invocation-`this` REPLACES the planned
//                       `symbol.contextual`.) PROVENANCE MINTING is RESOLVED: the run-wrapper is
//                       `__withCtx` at the binding level (lower() binds it raw; the evaluator
//                       appends ctx), so it reads ctx.currentInvocation and mints/deep-stamps
//                       EXACTLY as createRosettaWrapper does (a non-pure rosetta AEntity = a
//                       source). withContext / argProvenance contract knobs are DROPPED here.
//
//   symbol.notImplemented — no contract/impl, just `name: reason`. bake → a door:
//                       { kind: "door", name, reason } (the %purity-door story).
// ─────────────────────────────────────────────────────────────────────────────

import * as z from "../scheme-zod.js";
import { attestDeep, freshIfSingleton } from "../../values/attestation.js";
import { AValue, pointProvenance, unionProvenance } from "../../values/primitives/AValue.js";
import { jsToScheme, looksLikeEvalContext, type CtxWithInvocation } from "../../rosetta.js";
import { CONSTANT_CTX, type RunContext } from "../../values/primitives/RunContext.js";
import { Macro } from "../../eval/Macro.js";
import { KEYWORD_ACCESSOR_FIELD } from "../../Environment.js";

// ─────────────────────────────────────────────────────────────────────────────
// 1. The args-vector spec + decoded-type inference
// ─────────────────────────────────────────────────────────────────────────────

/** An args/return vector: a bare tuple of schemas (positional sugar) OR an array-ish
 *  schema (`z.array` variadic / `z.tuple` / `z.union` overload). */
export type VectorSpec = readonly z.ZodTypeAny[] | z.ZodTypeAny;

/** Decoded arg TYPES for the impl (the codec OUTPUT side). A bare tuple maps each
 *  element's `z.output`; an array-ish schema yields its element-array (variadic). */
export type DecodedArgs<S extends VectorSpec> = S extends readonly z.ZodTypeAny[]
  ? { -readonly [K in keyof S]: z.output<S[K] & z.ZodTypeAny> }
  : S extends z.ZodTypeAny
    ? z.output<S> extends readonly unknown[]
      ? z.output<S>
      : [z.output<S>]
    : never;

/** Decoded RETURN type: a single value when the output is a 1-tuple, else the
 *  values-vector (multiple-values). */
export type DecodedReturn<O extends VectorSpec> = O extends readonly [z.ZodTypeAny]
  ? z.output<O[0] & z.ZodTypeAny>
  : O extends readonly z.ZodTypeAny[]
    ? { -readonly [K in keyof O]: z.output<O[K] & z.ZodTypeAny> }
    : O extends z.ZodTypeAny
      ? z.output<O>
      : never;

/** async is implicit — bake awaits. */
export type MaybePromise<T> = T | Promise<T>;

/** The variadic TAIL schema after a fixed leading `input` tuple — `undefined` when a
 *  contract has no rest (the default, unchanged shape). */
export type RestSpec = z.ZodTypeAny | undefined;

/** The fixed-tuple decoded-types half of `DecodedArgsWithRest` — pulled into its OWN
 *  homomorphic-mapped-type alias (rather than written inline inside the spread below) because
 *  TS's tuple-spread checker (`error TS2574: A rest element type must be an array type`) can't
 *  see a mapped type over a still-abstract `I` as array-shaped when it's written directly inside
 *  a `[...X, ...Y[]]` literal — naming it as its own tuple-constrained alias resolves it. Same
 *  computation `DecodedArgs`'s tuple branch does. */
type DecodedTupleArgs<T extends readonly z.ZodTypeAny[]> = { -readonly [K in keyof T]: z.output<T[K] & z.ZodTypeAny> };

/** Decoded arg types WITH a rest tail: `input`'s fixed-tuple decoded types, followed by a
 *  spread of `inputRest`'s element type (repeated 0+ times). A rest tail only composes with
 *  a FIXED leading tuple `input` (never a bare single/kwargs schema — there's no well-defined
 *  prefix length to split at), so a non-tuple `I` combined with a real `Rest` types to `never`
 *  rather than silently doing something else. No rest (`Rest` defaults to `undefined`) falls
 *  through to today's `DecodedArgs<I>`, BYTE-IDENTICAL — this is a strictly ADDITIVE change,
 *  zero behavior/type difference for every existing declaration that doesn't set `inputRest`. */
export type DecodedArgsWithRest<I extends VectorSpec, Rest extends RestSpec = undefined> =
  Rest extends z.ZodTypeAny
    ? I extends readonly z.ZodTypeAny[]
      ? DecodedTupleArgs<I> extends infer Head extends readonly unknown[]
        ? [...Head, ...z.output<Rest>[]]
        : never
      : never
    : DecodedArgs<I>;

/** A symbol's input/output contract. */
export interface Contract<I extends VectorSpec, O extends VectorSpec, Rest extends RestSpec = undefined> {
  input: I;
  /** The variadic TAIL after `input`'s fixed leading positions (e.g. `apply`'s callable first
   *  arg is `input`, its spread call-args are `inputRest`) — a fixed head with its OWN generic
   *  type parameter separate from the tail's, so the two can differ (`apply`'s happen to both be
   *  `z.value`, but `DecodedArgsWithRest`'s mechanism doesn't assume that). Only meaningful when
   *  `input` is a fixed tuple — combining it with a bare single-schema `input` (today's "wholly
   *  variadic" shape) is a contract-authoring error: `normalizeInputVector` throws rather than
   *  silently ignoring it. Optional; absent ⇒ byte-identical to the pre-`inputRest` behavior. */
  inputRest?: Rest;
  output: O;
  /** ROSETTA-ONLY. `pure: true` makes the rosetta a TRANSFORM, not a source: it FORWARDS the
   *  union of its inputs' provenance instead of minting a fresh point at the call site (mirrors
   *  legacy defineRosetta `pure: true`). Strict `=== true` — undefined/false = source (the
   *  default, mints). Ignored by `symbol.native` (native ops never mint). */
  readonly pure?: boolean;
  /** NATIVE/SEQUENCE. `fanout: true` marks a fan-out op (map/filter/vector-map) — one whose
   *  lineage classifies to a per-element fan template. `bakeNative`/`bakeSequence` stamp a plain
   *  `.fanout = true` on the bound fn; the lineage classifier reads it off `env.get(op)` (the
   *  `SPECULATE` shape, minus the Symbol). Declared here on the contract, not in a name-list —
   *  so fan-ness follows the binding (alias-correct), not a string match. */
  readonly fanout?: boolean;
  /** KIND-AGNOSTIC (native/rosetta). `true` marks the symbol ASSEMBLY-TIME-ONLY: it binds into
   *  the assembly's phase-gated prelude scope (kernel.ts `assembleEnv` — a per-assembly Map
   *  answered by a resolver on the base env while the C3 loop runs), never into the runtime env.
   *  Callable from any later-applied capability's prelude during assembly; a plain
   *  unbound-variable error everywhere at runtime — INCLUDING from lambdas a prelude defined
   *  (closures walk the live chain at call time). A prelude bridges a preludeOnly value to
   *  runtime by capturing the call's RESULT in an ordinary define, never the verb itself. See
   *  docs/package-specific/arrival-scheme/prelude-only-symbols-and-composable-prompt-2026-07-02.md §1. */
  readonly preludeOnly?: boolean;
}

/** The impl a contract demands: decoded args in, decoded return (or a promise) out.
 *  `DecodedArgsWithRest` strips `readonly` (`-readonly` mapped tuple) so a `const`-inferred
 *  contract tuple becomes a MUTABLE positional param list the impl can declare, and splices in
 *  `inputRest`'s decoded element type as a spread tail when the contract declares one. */
export type Impl<I extends VectorSpec, O extends VectorSpec, Rest extends RestSpec = undefined> = (
  ...args: DecodedArgsWithRest<I, Rest>
) => MaybePromise<DecodedReturn<O>>;

// ─────────────────────────────────────────────────────────────────────────────
// 2. AEntity — the baked, discriminated union (an interpreter primitive — TYPE-ONLY,
//    no class/runtime footprint; the bound runtime value stays whatever shape it's always
//    been — a plain object for door/keyword/macro, a real callable fn for native/rosetta/
//    tagless/tagless-guard/sequence).
// ─────────────────────────────────────────────────────────────────────────────

type AnyFn = (...args: any[]) => unknown;

/** A native symbol: impl over SCHEME VALUES, no validation. Carries the (identity)
 *  schemas for the future .d.ts harvest. */
export interface NativeSymbolDef {
  readonly kind: "native";
  readonly name: string;
  readonly doc?: string;
  readonly in: z.ZodTypeAny;
  readonly out: z.ZodTypeAny;
  readonly impl: AnyFn;
  /** See `Contract.preludeOnly`. */
  readonly preludeOnly?: boolean;
}

/** A rosetta symbol: impl in JS-land. `in`/`out` are the (codec) schemas; `run` is the
 *  decode→validate→impl→encode wrapper produced by bake. */
export interface RosettaSymbolDef {
  readonly kind: "rosetta";
  readonly name: string;
  readonly doc?: string;
  readonly in: z.ZodTypeAny;
  readonly out: z.ZodTypeAny;
  /** The raw JS-land impl (decoded args → result). Kept for the harvest / inspection. */
  readonly impl: AnyFn;
  /** The interpretive wrapper: (…schemeArgs[, ctx]) => Promise<schemeValuesList>. Decodes
   *  + (optionally) validates inputs, runs the (ctx-free) impl, awaits, encodes the output,
   *  then MINTS provenance off the evaluator-appended ctx (same spine as createRosettaWrapper —
   *  see bakeRosetta). Tagged `__withCtx` so EnvCapability.lower() can bind it directly and the
   *  evaluator appends ctx as the trailing arg; a direct-JS caller (no ctx) is duck-type-safe. */
  readonly run: ((...schemeArgs: unknown[]) => Promise<unknown>) & { __withCtx?: boolean };
  /** `true` = a transform (forwards input provenance); default/false = a source (mints). */
  readonly pure?: boolean;
  /** See `Contract.preludeOnly`. */
  readonly preludeOnly?: boolean;
}

/** A tagless symbol: NO impl — the bypass to the operand's own `arrival/tagless-final/<name>`
 *  declaration. `run` is the ctx-aware dispatcher (receiver = the last scheme arg, per scheme's
 *  `(op …args collection)` convention) that hands the method the run's RunContext as its trailing
 *  arg, with a detailed type-mismatch error when the operand declares no such method. */
export interface TaglessSymbolDef {
  readonly kind: "tagless";
  readonly name: string;
  readonly doc?: string;
  readonly in: z.ZodTypeAny;
  readonly out: z.ZodTypeAny;
  readonly run: ((...schemeArgs: unknown[]) => Promise<unknown>) & { __withCtx?: boolean };
}

/** A tagless GUARD — like `symbol.tagless`, but a receiver that declares no such method
 *  yields `#f` (a graceful predicate) rather than throwing (the hard op). The dispatch form
 *  for type predicates: `(vector? x)` asks x's OWN `arrival/tagless-final/vector?`, defaulting
 *  to #f when x can't answer — no host-type `instanceof` reach-around in the builtin. */
export interface TaglessGuardSymbolDef {
  readonly kind: "tagless-guard";
  readonly name: string;
  readonly doc?: string;
  readonly in: z.ZodTypeAny;
  readonly out: z.ZodTypeAny;
  readonly run: ((...schemeArgs: unknown[]) => Promise<unknown>) & { __withCtx?: boolean };
}

/** A ctx-aware op: the impl receives the scheme args AND the run's RunContext (the dual of
 *  `symbol.native`, which is ctx-FREE). For ops that are kernel-logic-bearing — heap-charged,
 *  run-strict-reading — yet are NOT pure per-receiver dispatch (`symbol.tagless`): map/filter/
 *  reduce charge `runCtx.heapMeter` then dispatch to the term's own algebra. `run` is the
 *  ctx-aware wrapper that strips the evaluator ctx, extracts runCtx, and calls the impl. */
export interface SequenceSymbolDef {
  readonly kind: "sequence";
  readonly name: string;
  readonly doc?: string;
  readonly in: z.ZodTypeAny;
  readonly out: z.ZodTypeAny;
  readonly run: ((...schemeArgs: unknown[]) => Promise<unknown>) & { __withCtx?: boolean };
}

/** An omitted verb (errors-as-doors). No contract/impl — just the teaching reason. */
export interface DoorSymbolDef {
  readonly kind: "door";
  readonly name: string;
  readonly reason: string;
}

/** A kernel KEYWORD: a special form, made first-class. No contract/impl — just the
 *  dispatch `name`. `lower()` binds `new Keyword(name)`; the evaluator resolves a call
 *  head through the env and dispatches `SPECIAL_FORMS[name]` when it resolves to that
 *  marker — so the special form is aliasable + lexically shadowable (the dual of cxr). */
export interface KeywordSymbolDef {
  readonly kind: "keyword";
  readonly name: string;
  readonly doc?: string;
}

/** A non-evaluating MACRO form: the impl is a raw JS transformer (a `Macro`/`Syntax`),
 *  bound as-is by assembly — NOT arg-evaluating (native/rosetta) nor evaluator-dispatched
 *  (keyword). The home for syntax-rules + the macro family that carries a JS expander; the
 *  generic `is_macro`/`is_syntax` eval hook expands whatever it binds. */
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

/** Parse `"name: human description"` from a tagged-template. Substitutions are
 *  interpolated first (so a `${verb}: …` template works), then split on the FIRST
 *  colon. No colon ⇒ the whole string is the name (doc undefined). */
export function parseNameDoc(tpl: TemplateStringsArray, sub: readonly unknown[]): { name: string; doc?: string } {
  let raw = "";
  for (let i = 0; i < tpl.length; i++) {
    raw += tpl[i];
    if (i < sub.length) raw += String(sub[i]);
  }
  const colon = raw.indexOf(":");
  if (colon === -1) return { name: raw.trim() };
  return { name: raw.slice(0, colon).trim(), doc: raw.slice(colon + 1).trim() };
}

/** A zod schema describing a whole args/return VECTOR — its codec sides are array-shaped
 *  (a tuple `[a, b]` IS a `readonly unknown[]`; an array-ish schema's `T[]` is too). Typing
 *  the normalized schema this way lets `z.decode`/`z.encode` infer `readonly unknown[]` at the
 *  call site instead of `unknown` (a `ZodTypeAny`'s output) — so the wrapper reads the decoded
 *  args / encoded values-vector as an array WITHOUT an `as unknown[]` on every result. */
type VectorSchema = z.ZodType<readonly unknown[], readonly unknown[]>;

/** Read a kwargs KEY off a raw scheme call arg — the pluck closure's `KEYWORD_ACCESSOR_FIELD`
 *  (the SAME read `dict`'s native impl uses, env/polyglot.ts), falling back to stripping a
 *  leading `:` off the arg's string form. One protocol, shared here because a kwargs rosetta's
 *  input lowering folds the identical `:key value` pair sequence `dict` already folds. */
function kwargsKeyOf(arg: unknown): string {
  const tagged = arg as { [KEYWORD_ACCESSOR_FIELD]?: string } | null;
  if (
    tagged != null &&
    (typeof tagged === "function" || typeof tagged === "object") &&
    tagged[KEYWORD_ACCESSOR_FIELD]
  ) {
    return tagged[KEYWORD_ACCESSOR_FIELD];
  }
  return String(arg).replace(/^:/, "");
}

/** Fold a `(tool :k v :k2 v2 …)` call's interleaved scheme args into the RAW kwargs object —
 *  a plain JS record keyed by the kwargs shape's field names, valued by the RAW (still-encoded)
 *  scheme values. The kwargs schema's OWN `z.decode` (run by the caller, directly against the
 *  object schema — see bakeRosetta) then validates + decodes each field through its own
 *  per-property codec; this fold only performs the array→object RESHAPE, not the per-field
 *  decode. A dangling keyword (odd arg count) doors with a teaching error rather than silently
 *  dropping it. */
function collectKwargsObject(args: readonly unknown[]): Record<string, unknown> {
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
 *  a bare tuple → `z.tuple`; an array-ish schema → itself. This is what `run` parses
 *  the decoded-args array against (and what the harvest will print from).
 *
 *  ★A `z.kwargs(...)` object input is DELIBERATELY left as-is here (the "any other single
 *  schema" arm below) — it is NOT array-shaped, and normalizing it into a `VectorSchema`
 *  would change what `def.in`/`def.out` (the HARVEST surface the type-layer printer reads,
 *  schema-to-ts.ts's `paramList`) structurally see, regressing the type-layer's kwargs
 *  signature printing. The kwargs array↔object RESHAPE instead happens ONLY at the runtime
 *  decode call site (bakeRosetta's `run`, gated by `z.isKwargs`) — `def.in` stays the bare,
 *  unwrapped kwargs object schema, byte-identical to before this reshape existed. */
function normalizeVector(spec: VectorSpec): VectorSchema {
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
  // contract) rather than on each decode/encode result. (A kwargs object rides this arm too —
  // see the note above; its "vector shape" assertion is never exercised at decode time.)
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
 *  `normalizeVector(input)` — this is what `bakeNative`/`bakeRosetta` call for `.in`/`inSchema`
 *  (the OUTPUT side stays plain `normalizeVector(contract.output)`, no rest concept there). */
function normalizeInputVector(input: VectorSpec, inputRest: RestSpec): VectorSchema {
  if (inputRest === undefined) return normalizeVector(input);
  // `inputRest` needs a FIXED prefix length to split the call's raw args at — only a tuple
  // `input` has one; a single schema (bare variadic, or a `z.kwargs` object) covers the WHOLE
  // call with no well-defined split point. Combining `inputRest` with either is a contract-
  // authoring bug: fail loudly here rather than silently ignoring the rest schema (which is what
  // would happen if this guard didn't exist — `normalizeVector` would just return the single
  // schema unchanged and the declared `inputRest` would silently never apply).
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

/** Did the author give a 1-tuple output? Then the impl returns a SINGLE value (we wrap
 *  it as a 1-element values-list); otherwise it returns the values-vector already. */
function isSingleOutput(output: VectorSpec): boolean {
  return Array.isArray(output) && output.length === 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. bake — the three constructors' shared runtime
// ─────────────────────────────────────────────────────────────────────────────

export interface NativeInput {
  kind: "native";
  name: string;
  doc?: string;
  // Widened over the full `RestSpec` union (not the default-`undefined` 2-arg shape) so a
  // contract declaring `inputRest` is a valid `NativeInput.contract` too — the tagged-template
  // factories (`native.ts`) hand this a `Contract<I, O, Rest>` for whatever concrete `Rest` the
  // author declared.
  contract: Contract<VectorSpec, VectorSpec, RestSpec>;
  impl: AnyFn;
}
export interface RosettaInput {
  kind: "rosetta";
  name: string;
  doc?: string;
  contract: Contract<VectorSpec, VectorSpec, RestSpec>;
  impl: AnyFn;
}
export interface DoorInput {
  kind: "door";
  name: string;
  reason: string;
}
export interface TaglessInput {
  kind: "tagless";
  name: string;
  doc?: string;
}
export interface SequenceInput {
  kind: "sequence";
  name: string;
  doc?: string;
  contract: Contract<VectorSpec, VectorSpec>;
  impl: (args: unknown[], runCtx: RunContext) => unknown;
}

/** Per-invocation knobs the wrapper honors. `validate` mirrors the design's
 *  `exec(src, { typecheck })` — see the decode note in bakeRosetta for the current
 *  fused-transform caveat. */
export interface BakeRuntimeOpts {
  /** Run zod validation on decoded args + encoded output. Default true. */
  validate?: boolean;
}

/** The structural slice of EvalContext the symbol wrappers read. Duck-typed (the full
 *  `EvalContext` lives in eval/evaluator.ts; pulling it here would be a layering cycle —
 *  same reason rosetta.ts duck-types it). Reuses rosetta's `CtxWithInvocation` for the
 *  `currentInvocation` shape (so the provenance mint reads the SAME `InvocationLike`, not a
 *  re-spelled cast) and adds the two extra fields symbol.ts threads: the per-run `runCtx` (for
 *  heap/strict) and the budget `signal` (the lazy invocation-`this`'s `aborted`/`abortSignal`).
 *  All optional: a direct-JS call (tests, host) hands NO ctx, so every reader tolerates absence. */
interface EvalContextSlice extends CtxWithInvocation {
  runCtx?: RunContext;
  signal?: AbortSignal;
}

/** Narrow the evaluator-appended trailing arg to the EvalContext slice the symbol wrappers read,
 *  or `undefined` for a direct-JS call. Composes rosetta's `looksLikeEvalContext` (the shared
 *  duck-type probe — `resolver`/`currentInvocation`/`tap`/`signal`) and widens its narrow
 *  `Partial<CtxWithInvocation>` result to the `runCtx`-bearing slice this module threads. One
 *  typed seam replacing the scattered `ctx as { runCtx?: … }` / `ctx as { currentInvocation?… }`
 *  casts; the `ctx` it inspects is `unknown` until proven a context. */
function asEvalContext(ctx: unknown): EvalContextSlice | undefined {
  return looksLikeEvalContext(ctx) ? ctx : undefined;
}

/** The per-call **invocation context** — the lazy `this` a rosetta impl is called with.
 *  Verbs that need run-state declare a `function` impl and read `this.abortSignal` /
 *  `this.aborted` / `this.invocation`; the 50+ pure verbs are arrows that ignore `this`
 *  entirely (so `impl.call(invCtx, …)` is byte-identical to `impl(…)` for them).
 *
 *  Every member is an **accessor getter** that reads the captured `ctx` on access, so a verb
 *  that never touches them materializes NOTHING — zero cost on the pure-verb hot path. */
export interface InvocationContext {
  /** Has the run been aborted? `ctx.signal?.aborted`, coerced to a real boolean (no signal /
   *  no ctx ⇒ `false`: a run with no budget signal is, by definition, not aborted). */
  readonly aborted: boolean;
  /** The run's `AbortSignal` (for `fetch(url, { signal: this.abortSignal })` and friends), or
   *  `undefined` when the run carries no budget signal / the impl was called direct-JS. */
  readonly abortSignal: AbortSignal | undefined;
  /** The invocation CARRIER the inference seam (infer / mcp / agentic) forwards to its host
   *  resolver — `{ currentInvocation }`, the exact `{ currentInvocation?: unknown }` shape `InferFn`
   *  / `McpEffectContext` are typed for (and the only field those resolvers structurally read, to
   *  mark/trace the provenance node). It mirrors what the legacy `withContext` path forwarded as
   *  its `ctx` arg: `createRosettaWrapper` handed the raw EvalContext, off which the resolver read
   *  `.currentInvocation` — this is that field, re-wrapped to the minimal carrier. Direct-JS (no
   *  ctx) ⇒ `{ currentInvocation: undefined }` (the resolver's `ctx?.currentInvocation` ⇒ absent).
   *  Provenance MINTING is independent: `bakeRosetta` mints off the REAL captured ctx, so a verb
   *  reading `this.invocation` and the wrapper's mint both reach the same `currentInvocation`. */
  readonly invocation: { currentInvocation: unknown };
}

/** Build the lazy invocation-`this` over a captured ctx (or `undefined` for a direct-JS call).
 *  The getters close over `ctx` and read it on access — nothing is computed until a verb that
 *  declared a `function` impl actually touches `this.*`. */
function makeInvocationContext(ctx: EvalContextSlice | undefined): InvocationContext {
  return {
    get aborted(): boolean {
      return ctx?.signal?.aborted ?? false;
    },
    get abortSignal(): AbortSignal | undefined {
      return ctx?.signal;
    },
    get invocation(): { currentInvocation: unknown } {
      // The minimal `{ currentInvocation }` carrier the inference seam forwards to its host
      // resolver — structurally the `InferFn` / `McpEffectContext` ctx. Re-wrap (not the raw
      // `ctx.currentInvocation`) so the resolver's `ctx?.currentInvocation` reaches the same
      // Invocation the legacy `withContext` path delivered via the whole EvalContext.
      return { currentInvocation: ctx?.currentInvocation };
    },
  };
}

export function bakeNative(input: NativeInput): NativeSymbolDef {
  const impl = input.impl;
  // `fanout: true` → stamp the bound fn (capability binds def.impl raw; the lineage classifier
  // reads `.fanout` off env.get(op) — the SPECULATE shape, minus the Symbol).
  if (input.contract.fanout) (impl as { fanout?: boolean }).fanout = true;
  return {
    kind: "native",
    name: input.name,
    doc: input.doc,
    in: normalizeInputVector(input.contract.input, input.contract.inputRest),
    out: normalizeVector(input.contract.output),
    // NO runtime validation, NO codec — the impl works on scheme values directly.
    // "zod for types purely": the schemas live on the def for inference + the harvest.
    impl,
    preludeOnly: input.contract.preludeOnly,
  };
}

export function bakeRosetta(input: RosettaInput, opts: BakeRuntimeOpts = {}): RosettaSymbolDef {
  const inSchema = normalizeInputVector(input.contract.input, input.contract.inputRest);
  const outSchema = normalizeVector(input.contract.output);
  const singleOut = isSingleOutput(input.contract.output);
  // `pure: true` → TRANSFORM (forward input provenance); default → SOURCE (mint). Strict
  // `=== true` so only an explicit opt-out forwards (undefined/false stay sources).
  const pure = input.contract.pure === true;
  // Per-invocation validation gate (the design's `exec(src, { typecheck })`). Retained
  // for the trust model + future use; see the decode note below for why it currently
  // can't be a no-op for the codec family. Default from bake opts.
  const defaultValidate = opts.validate !== false;

  // The interpretive wrapper. Mirrors createRosettaWrapper's spine
  // (schemeToJs → fn → jsToScheme), with the contract codecs standing in for the
  // generic conversions and zod doing the (gated) validation, and the SAME ctx-driven
  // provenance mint at the end. Tagged `__withCtx` (below) so the evaluator appends
  // EvalContext as the trailing arg; a direct-JS caller (tests) passes a scheme value
  // there instead — duck-typed so it is NOT mis-stripped (mirrors createRosettaWrapper).
  const run = async (...args: unknown[]): Promise<unknown> => {
    // Strip the evaluator-appended ctx iff the trailing arg LOOKS like one. By the time
    // the wrapper runs under the evaluator the scheme DATA args are already scheme values
    // (AValue subclasses / raw arrays-primitives); the genuine EvalContext is the only raw
    // plain object carrying resolver/currentInvocation/tap/signal that reaches here (probe
    // keys on `resolver` — the single always-present field since ejection P5 removed `env`).
    // Same probe as createRosettaWrapper's looksLikeEvalContext.
    const ctx = asEvalContext(args[args.length - 1]);
    const schemeArgs = ctx === undefined ? args : args.slice(0, -1);

    // Collect input provenance from the RAW scheme args BEFORE decode strips the AValue
    // identity (decode unwraps SchemeString/SchemeBool/… to JS primitives). The fallback
    // when no invocation is in ctx (direct-JS calls) is this input union — exactly
    // createRosettaWrapper's behavior.
    const inputAValues = schemeArgs.filter((a): a is AValue => a instanceof AValue);
    const inputProvenance = unionProvenance(inputAValues);

    // 1. DECODE args via the input codecs. In zod, a codec's TRANSFORM (the membrane
    //    crossing) and its input-side VALIDATION are FUSED inside `decode` — you can't
    //    run the transform without the instanceof/refinement guard. The membrane is
    //    structural (not optional), so decode always runs. For the primitive codec
    //    family the only validation BEYOND the transform is `z.integer`'s safe-int check
    //    (itself part of the boundary contract, not skippable noise) — so `validate`
    //    is effectively always-on here. The flag stays on the API to track trust and to
    //    host a real split once a schema carries skippable refinements; the no-op path
    //    is intentionally NOT faked. TODO(typecheck-skip): wire a transform-only decode
    //    when a contract gains refinements a trusted caller may skip.
    void defaultValidate;
    // A `z.kwargs(...)` input is a single OBJECT schema, not array-shaped — `inSchema` (the
    // generic `VectorSchema`-typed handle `normalizeVector` hands back unchanged for it, see
    // that fn's note) can't decode the RAW interleaved `:key value` pairs array directly
    // against an object schema. Fold the pairs into the plain object `dict` would build
    // (`collectKwargsObject` — the same KEYWORD_ACCESSOR_FIELD read), THEN decode that object
    // against the (narrowed, honest) kwargs schema, and wrap the one decoded value as the
    // 1-element args array `DecodedArgs` already gives a non-tuple, non-array-output contract
    // member. `isKwargs` narrows `input.contract.input` from `VectorSpec` to the branded
    // object schema — no cast needed.
    const decodedArgs: readonly unknown[] = z.isKwargs(input.contract.input)
      ? [z.decode(input.contract.input, collectKwargsObject(schemeArgs))]
      : z.decode(inSchema, schemeArgs);

    // 2. RUN the impl with a per-call **invocation `this`** (the lazy invocation-context). The
    //    impl still receives ONLY the decoded scheme args positionally — ctx is NOT a param. A
    //    ctx-coupled verb declares a `function` impl and reads run-state lazily off `this`
    //    (`this.aborted` / `this.abortSignal` / `this.invocation`); a pure verb is an arrow that
    //    ignores `this`, so `impl.call(invCtx, …)` is byte-identical to `impl(…)`. The getters
    //    read the captured `ctx` ON ACCESS, so a pure verb materializes nothing. async is implicit.
    const invCtx = makeInvocationContext(ctx);
    const result = await input.impl.call(invCtx, ...decodedArgs);

    // 3. PROVENANCE — the SAME spine as createRosettaWrapper. A SOURCE rosetta (default)
    //    MINTS a fresh point off ctx.currentInvocation; a PURE rosetta (`pure: true`) is a
    //    TRANSFORM that FORWARDS the input-provenance union instead (mirrors defineRosetta
    //    `pure: true`). With no invocation in ctx (direct-JS) a source also falls back to the
    //    input union. ★The forward-vs-mint choice is provenance-load-bearing: a pure rosetta
    //    that minted would fabricate a fresh origin (the seal-laundering class of bug).
    const inv = ctx?.currentInvocation;
    let resultProvenance = inputProvenance;
    if (!pure && inv && typeof inv.id === "number") {
      if (typeof inv.markProvenancePoint === "function") inv.markProvenancePoint();
      else inv.isProvenancePoint = true;
      resultProvenance = pointProvenance(inv.id);
    }

    // 4. ENCODE the output via the output codecs (codec encode = z.encode), then DEEP-STAMP
    //    with the minted provenance. The codec builds the scheme value(s) with EMPTY
    //    provenance, so the stamp is a separate re-walk (vs. createRosettaWrapper, which
    //    stamps DURING jsToScheme construction). `jsToScheme(v, {}, prov)` is the canonical
    //    re-stamp: given an already-AValue with a fresh provenance it deep-clones the
    //    Pair/vector spine + leaves with that provenance (rosetta.ts jsToScheme AValue
    //    branch), reaching every constructed value in one pass. CONTAINER-AWARE: the
    //    multiple-values case is a RAW JS ARRAY (the scheme values-vector) — stamp each
    //    ELEMENT and keep the JS array, because jsToScheme over a JS array would (correctly,
    //    for data) build a Pair-chain, which is the WRONG shape for a values-vector.
    //    ATTESTATION (values/attestation.ts) rides the SAME walk position: a SOURCE
    //    rosetta's return is machine-made (a tool result), so its spine + leaves are
    //    deep-attested — `car`/`vector-ref`/plucks on it hand back already-attested
    //    boxes at the manifold boundary. A PURE rosetta is a transform: its return
    //    keeps only what the impl itself chose to attest (the manifold's `s/*`
    //    validators attest their identity-returns this way).
    //    (`freshIfSingleton` first: `fromJs` reuses the shared #t/#f flyweights on the
    //    empty-provenance fast path, and the program-wide singletons must never attest.)
    if (singleOut) {
      // 1-tuple output: the impl returned a single value; encode it as a 1-vector.
      const encoded = z.encode(outSchema, [result])[0];
      const boxed: unknown = jsToScheme(ctx?.runCtx ?? CONSTANT_CTX, encoded, {}, resultProvenance);
      return pure ? boxed : attestDeep(freshIfSingleton(boxed));
    }
    // multiple-values / array-ish output: the impl returned the values-vector already (an array
    // by the multi-output contract — `DecodedReturn` is the values-vector when output isn't a
    // 1-tuple), so it IS the `readonly unknown[]` the output codec encodes.
    const encoded = z.encode(outSchema, result as readonly unknown[]);
    return encoded.map((v) => {
      const boxed: unknown = jsToScheme(ctx?.runCtx ?? CONSTANT_CTX, v, {}, resultProvenance);
      return pure ? boxed : attestDeep(freshIfSingleton(boxed));
    });
  };
  // ALWAYS tag — the wrapper needs ctx appended to mint (mirrors createRosettaWrapper,
  // where every wrapper is __withCtx post-flip). The strip-guard above keeps direct-JS
  // calls (no ctx) safe.
  (run as { __withCtx?: boolean }).__withCtx = true;

  return {
    kind: "rosetta",
    name: input.name,
    doc: input.doc,
    in: inSchema,
    out: outSchema,
    impl: input.impl,
    run,
    pure,
    preludeOnly: input.contract.preludeOnly,
  };
}

export function bakeDoor(input: DoorInput): DoorSymbolDef {
  return { kind: "door", name: input.name, reason: input.reason };
}

/** Human description of a receiver for the type-mismatch error: an AValue reports its
 *  scheme `kind` ("number"/"pair"/"nil"/…), else the JS shape. */
function describeReceiver(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (v instanceof AValue) return v.kind;
  return Array.isArray(v) ? "array" : typeof v;
}

/** A receiver's tagless-final term method: scheme args (the leading operands + the run's
 *  RunContext) in, the op result out. Always called with the receiver as `this`. */
type TermMethod = (this: unknown, ...args: unknown[]) => unknown;

/** Resolve a named term method off a (possibly non-object) receiver, typed — the dispatch
 *  primitive both `bakeTagless` (throws when absent) and `bakeTaglessGuard` (#f when absent)
 *  stand on, plus `srfi-1`'s `filter` sequence. Reads the member only when the receiver is a
 *  real object, returns the callable iff it IS one, else `undefined` — so the call site decides
 *  the missing-method policy without a raw `receiver as Record` / `fn as callable` cast. */
function resolveMethod(receiver: unknown, method: string): TermMethod | undefined {
  if (receiver == null || (typeof receiver !== "object" && typeof receiver !== "function")) return undefined;
  const fn = (receiver as Record<string, unknown>)[method];
  return typeof fn === "function" ? (fn as TermMethod) : undefined;
}

/** Bake a tagless dispatcher. No impl — `run` forwards to the operand's own
 *  `arrival/tagless-final/<name>` term method. Receiver = the LAST scheme arg (scheme places
 *  the collection last: `(map fn xs)`, `(car xs)`); the leading args + the run's RunContext
 *  (read ctx-aware off the evaluator-appended EvalContext) are passed through. A receiver that
 *  declares no such method is a TYPE MISMATCH — a clear throw, not a silent bypass. */
export function bakeTagless(input: TaglessInput): TaglessSymbolDef {
  const method = `arrival/tagless-final/${input.name}`;
  const run = async (...args: unknown[]): Promise<unknown> => {
    // Strip the evaluator-appended ctx iff the trailing arg looks like one (the shared
    // `asEvalContext` probe). Unlike native, tagless is ctx-AWARE — it needs the run for the method.
    const ctx = asEvalContext(args[args.length - 1]);
    const schemeArgs = ctx === undefined ? args : args.slice(0, -1);
    const runCtx = ctx?.runCtx ?? CONSTANT_CTX;
    const receiver = schemeArgs[schemeArgs.length - 1];
    const leading = schemeArgs.slice(0, -1);
    const fn = resolveMethod(receiver, method);
    if (fn === undefined) {
      throw new TypeError(
        `${input.name}: the ${describeReceiver(receiver)} primitive does not support \`${input.name}\` ` +
          `(it declares no ${method}). A tagless op lives ON the arrival terms whose algebra implements it.`,
      );
    }
    return await fn.call(receiver, ...leading, runCtx);
  };
  (run as { __withCtx?: boolean }).__withCtx = true;
  // No contract: the placeholder harvest surface is fixed (like `bakeTaglessGuard`). The real
  // per-op types live on the receiver's `arrival/tagless-final/<name>` member (AValue), the
  // source of truth — `tagless-final.ts` derives the op-name type from there.
  return { kind: "tagless", name: input.name, doc: input.doc, in: z.array(z.unknown()), out: z.unknown(), run };
}

/** Bake a tagless GUARD dispatcher. Same receiver-resolution as bakeTagless (last scheme arg),
 *  but a missing method returns `false` (#f) instead of throwing — the predicate / optional form.
 *  `(vector? x)` → x's own `arrival/tagless-final/vector?` if present, else #f. The name is FREE
 *  (a per-type predicate), so — unlike the algebra-keyed `tagless` — it is not a declared op. */
export function bakeTaglessGuard(input: { name: string; doc?: string }): TaglessGuardSymbolDef {
  const method = `arrival/tagless-final/${input.name}`;
  const run = async (...args: unknown[]): Promise<unknown> => {
    const ctx = asEvalContext(args[args.length - 1]);
    const schemeArgs = ctx === undefined ? args : args.slice(0, -1);
    const runCtx = ctx?.runCtx ?? CONSTANT_CTX;
    const receiver = schemeArgs[schemeArgs.length - 1];
    const leading = schemeArgs.slice(0, -1);
    const fn = resolveMethod(receiver, method);
    if (fn === undefined) return false; // graceful #f — the receiver simply can't answer
    return await fn.call(receiver, ...leading, runCtx);
  };
  (run as { __withCtx?: boolean }).__withCtx = true;
  return { kind: "tagless-guard", name: input.name, doc: input.doc, in: z.array(z.unknown()), out: z.unknown(), run };
}

/** Bake a ctx-aware op. `run` strips the evaluator-appended ctx (same probe as bakeRosetta/
 *  bakeTagless), extracts the run's RunContext, and hands it to the impl alongside the scheme
 *  args — so the impl can charge `runCtx.heapMeter` and read `runCtx.strict` without a holder. */
export function bakeSequence(input: SequenceInput): SequenceSymbolDef {
  const impl = input.impl;
  const run = async (...args: unknown[]): Promise<unknown> => {
    const ctx = asEvalContext(args[args.length - 1]);
    const schemeArgs = ctx === undefined ? args : args.slice(0, -1);
    const runCtx = ctx?.runCtx ?? CONSTANT_CTX;
    return await impl(schemeArgs, runCtx);
  };
  (run as { __withCtx?: boolean }).__withCtx = true;
  // `fanout: true` → stamp the bound fn (capability binds def.run; cell-less packs bind it raw,
  // so the classifier reads `.fanout` off env.get(op) — the SPECULATE shape, minus the Symbol).
  if (input.contract.fanout) (run as { fanout?: boolean }).fanout = true;
  return { kind: "sequence", name: input.name, doc: input.doc, in: normalizeVector(input.contract.input), out: normalizeVector(input.contract.output), run };
}

// The tagged-template factories (`native`/`rosetta`/`tagless`/…) live one-per-file under
// this directory; each imports the matching `bake*` + types from here and is re-assembled
// into the `symbol` namespace by `./index.ts`. See `../symbol.js` for the stable entry.
