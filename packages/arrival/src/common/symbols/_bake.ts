// _bake: shared machinery behind arrival.symbol* EnvCapability — contract/decoded-type
// layer, the baked AEntity union + members, shared types + helpers the per-tag factory files
// (./native.ts, ./rosetta.ts, …) build their AEntity from directly (no separate bake* ctor).
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
// THE RUNTIME MODEL (the implementing sites: src/rosetta.ts createRosettaWrapper,
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
//                    below). withContext / argProvenance knobs DROPPED here.
//
//   symbol.notImplemented  no contract/impl, just `name: reason`. bake → door:
//                    { kind: "door", name, reason } (the %purity-door story).
// ─────────────────────────────────────────────────────────────────────────────

import * as z from "../scheme-zod.js";
import { AValue } from "../../values/primitives/AValue.js";
import { type RunContext } from "../../values/primitives/RunContext.js";
import { type CallCtx, makeCallCtx, testCallCtx } from "../../values/primitives/CallCtx.js";
import { Macro } from "../../eval/Macro.js";
import { ZodType, ZodUnion } from "zod";
import { CacheClassShapeError, KeywordPairingError, ProvenanceRoleShapeError } from "../../errors.js";
// TYPE-ONLY (erased — no runtime edge back up into capability.ts, which imports this
// module's values): the per-env binding context a DYNAMIC metadata field resolves
// against. Same erased-import posture kernel.ts takes for `DegradedCapability`.
import type { Activation } from "../capability.js";

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
 *  membrane/JS face — the default — or `z.input` for the scheme face `symbol.native`
 *  projects). A tuple maps element-wise to a mutable tuple;
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

// ─────────────────────────────────────────────────────────────────────────────
// 1.5 Symbol metadata — the per-FIELD static-or-dynamic vocabulary
//     (exec-phases-and-dynamic-metadata.md §2.1–§2.3). Every declaration kind
//     carries an optional `metadata` extension bag; each FIELD is either static
//     data or a lazily-resolved function of the assembly's activation.
// ─────────────────────────────────────────────────────────────────────────────

/** One metadata field: STATIC data, or a DYNAMIC `(this: Activation) => value` resolved
 *  lazily at READ time (describe/catalog), per read, against the phase-2 activation —
 *  never at bake/lower (a dynamic field touching `this.resources.x.live` at assembly
 *  would spawn the resource eagerly — the connection storm the worker-ephemerality
 *  ruling forbids). The discriminant is `typeof === "function"`: a static field can
 *  therefore never BE a function — that is the rule, not a limitation (a function-valued
 *  "static" datum has no serialization/digest/rehydration story, i.e. it was never
 *  static). Per-FIELD union, deliberately NOT a whole-record builder
 *  (`metadata: (activation) => record` is rejected — it would re-open the builder-form
 *  arm the hermetic-symbols design retires); per-field keeps the static subset
 *  enumerable with zero assembly. Resolution semantics live in `./metadata.js`'s
 *  `resolveMetadata`. */
export type MetadataField<A = Activation<any, any>, V = unknown> =
  | V // STATIC — data, enumerable pre-assembly
  | ((this: A) => MaybePromise<V>); // DYNAMIC — resolved lazily at read, per read

/** A symbol's metadata extension bag — the kind-agnostic `metadata?` slot every def
 *  carries. Def-level facts (`doc`, `type`, `provenance`, `preludeOnly`) stay def-level,
 *  contract-derived; this is the extension channel (MCP annotations, catalog text,
 *  dashboard fields). */
export type MetadataRecord<A = Activation<any, any>> = Record<string, MetadataField<A>>;

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
 *  doing something else. No rest (`Rest` defaults to `undefined`) reduces to plain
 *  `DecodedArgs<I>` — zero type/behavior difference for a declaration that doesn't set
 *  `inputRest`.
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

/** The declared-role vocabulary, data in string key space (P7 — the class/def stays the
 *  representation authority; this field is data, never a duck-read) — the ONE field every
 *  symbol declaration carries, replacing a bag of ad-hoc booleans. `pipe`/`fan`/`source` are
 *  LIVE today (declaration defaults, below); `sink`/`transparent`/`loop`/`opaque` are
 *  GRAPH-LAYER targets no declaration marks yet (`src/values/lineage.ts`'s node kinds exist
 *  for them; a future classifier consumes them) — the union names the full vocabulary now so
 *  `Contract.provenance`'s type stays stable as more roles go live, never narrowed to
 *  "whatever's reachable today". */
export type ProvenanceRole = "pipe" | "fan" | "source" | "sink" | "transparent" | "loop" | "opaque";

/** The CACHE-CLASS vocabulary (Solidity's — Ruling A, arrival-mcp-rework-over-phases.md §2.3):
 *  an explicit declaration, never derived from the lineage role. See `Contract.cacheClass`. */
export type CacheClass = "view" | "pure";

/** The CALLBACK-role vocabulary — the per-z.lambda-arm dual of `ProvenanceRole` (which names
 *  the HOST symbol's role). Extracted from contract SHAPE where shape decides, declared
 *  (`Contract.callbackRoles`) where it underdetermines — `extractCallbackRoles` below owns
 *  the exact split:
 *  - `element-transformer` — the callback's return BECOMES the element (map's fn). Parallel
 *    track composition.
 *  - `control` — boolean/ordering returns: the ONE merged selector+decision role (the
 *    selector/decision split stays merged until a product query needs it — one cone color).
 *    filter's pred, sort's less?, member/assoc's compare.
 *  - `effect` — void/unused returns under sink-ish hosts (the for-each family). Terminal
 *    track composition — no egress.
 *  - `accumulator` — the fold-shaped acc-position arm. DECLARES THE ACC CHAIN: chained
 *    track composition (`egress(Tᵢ) → ingress(Tᵢ₊₁)`, the ONLY sanctioned inter-track edge —
 *    the track-separation law's one exception). */
export type CallbackRole = "element-transformer" | "control" | "effect" | "accumulator";

/** Resolved per-arm callback roles, aligned with the contract's z.lambda arms IN LAMBDA
 *  ORDER (k-th entry = k-th lambda arm, NOT k-th input position — sort's less? sits at
 *  input position 1 but is lambda arm 0). An `undefined` entry = underdetermined-and-
 *  undeclared: shape decided nothing and the author declared nothing — HONEST data for the
 *  classifier, which consumes this positionally, never a guessed default. */
export type CallbackRoles = readonly (CallbackRole | undefined)[];

/** A symbol's input/output contract. */
export interface Contract<I extends VectorSpec, O extends VectorSpec, Rest extends RestSpec = undefined> {
  input: I;
  /** Variadic TAIL after `input`'s fixed leading positions (e.g. `apply`'s callable first arg
   *  is `input`, its spread call-args are `inputRest`) — a fixed head with its OWN generic
   *  type parameter separate from the tail's, so the two can differ. Only meaningful when
   *  `input` is a fixed tuple — combining with a bare single-schema `input` is a contract-
   *  authoring error: `normalizeInputVector` throws. Absent ⇒ the plain fixed-tuple contract,
   *  no rest tail. */
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
  /** Declared PROVENANCE ROLE — ONE key-space string per symbol, not a bag of booleans.
   *  `undefined` here means "this kind's default": `native()`/`sequence()`/`tagless()`/
   *  `taglessGuard()` default to `"pipe"` (pure pass-through — propagate, never mint);
   *  `rosetta()` defaults to `"source"` (mint a fresh point). The RESOLVED role lands on the
   *  baked def (`NativeSymbolDef.provenance` etc.); capability.ts stamps it onto the bound
   *  callable (`provenanceRole`) so the lineage classifier reads it off `env.get(op)` — never
   *  a duck-read off an ad-hoc property. See `assertProvenanceRoleShape` below for the two
   *  SHAPE-decidable contradictions this field is checked against at bake time. */
  readonly provenance?: ProvenanceRole;
  /** EXPLICIT cache class (Solidity's vocabulary) — a declaration, never derived:
   *  - "view":  cacheable ACROSS runs — a boundary snapshot worth persisting. Demands a
   *             serializable contract (shape gate: `assertCacheClassShape`): a cache entry
   *             must serialize.
   *  - "pure":  regenerateable — deterministic from its decoded args; recovery = re-call;
   *             NEVER persisted cross-run. No shape gate (nothing of it is stored).
   *  - absent:  regenerateable — the SAFE default; an undeclared verb re-runs on replay.
   *  Both view and pure remain provenance `source` on the LINEAGE axis ("we cannot not
   *  do it") — this field is the cache axis, `provenance` stays the lineage axis.
   *  NAMING HAZARD: legacy defineRosetta's `pure: true` meant provenance PIPE
   *  (`RosettaSpec.pure` / createRosettaWrapper's `mintsPoint = pure !== true` — mints
   *  nothing); THIS `pure` is a cache class on a source. Different axes, same word; the
   *  legacy path is dying and never carries this field. */
  readonly cacheClass?: CacheClass;
  /** Declared CALLBACK roles, one per z.lambda arm IN LAMBDA ORDER — the override channel
   *  for exactly the arms whose role the contract SHAPE underdetermines (`z.lambda` is a
   *  bare callable schema carrying no return shape, so the callback's own return — control's
   *  boolean/ordering, element-transformer's value — is invisible to shape; only the HOST's
   *  output vector decides anything). Two shape rules, split by strength
   *  (`extractCallbackRoles`):
   *  - DECIDED — void-family host output ⇒ every lambda arm is `effect` (the callback's
   *    product has no egress wire to ride); a declaration CONTRADICTING a decided arm
   *    throws `ProvenanceRoleShapeError` at bake (the drift-door extension).
   *  - DEFAULT — `fan`-role host with value egress ⇒ `element-transformer`; a declaration
   *    OVERRIDES freely (filter is fan-shaped like map but its pred is `control` — the
   *    shapes are identical, so the default must yield; under-trigger, never guess).
   *  Underdetermined + undeclared arms resolve to `undefined` (honest holes). May be
   *  SHORTER than the lambda-arm count (trailing arms fall to shape/undefined); LONGER
   *  throws — a role for a phantom callback is a decidable contradiction. */
  readonly callbackRoles?: readonly CallbackRole[];
  /** KIND-AGNOSTIC (native/rosetta). `true` = ASSEMBLY-TIME-ONLY: binds into the assembly's
   *  phase-gated prelude scope (kernel.ts `assembleEnv` — per-assembly Map answered by a resolver
   *  on the base env during the C3 loop), never into the runtime env. Callable from any later-
   *  applied capability's prelude during assembly; plain unbound-variable error at runtime —
   *  INCLUDING from lambdas a prelude defined (closures walk the live chain at call time).
   *  A prelude bridges a preludeOnly value to runtime by capturing the call's RESULT in an
   *  ordinary define, never the verb itself. */
  readonly preludeOnly?: boolean;
}

// CallCtx/makeCallCtx moved to values/primitives/CallCtx.ts: ACallable.ts needs makeCallCtx
// as a real call; importing it from here closed a cycle (ACallable.ts → scheme-zod.ts → this
// file) that could leave a `z.instanceof(...)` codec's captured class permanently undefined
// depending on which path entered first. Re-exported here (not just imported) so existing
// `_bake.js` importers are unaffected.
export type { CallCtx };
export { makeCallCtx, testCallCtx };

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
  /** RESOLVED cache class — the authored `Contract.cacheClass`, shape-gated at bake
   *  (`assertCacheClassShape`). OPTIONAL by design: absent = regenerateable, the safe
   *  default (never a resolved kind-default like `provenance`'s). capability.ts stamps
   *  it onto the bound callable beside `provenanceRole`. */
  readonly cacheClass?: CacheClass;
  /** RESOLVED per-lambda-arm callback roles (`extractCallbackRoles` — shape + declared
   *  override; see `Contract.callbackRoles`). `undefined` when the contract has no z.lambda
   *  arm. capability.ts stamps this onto the bound callable beside `provenanceRole`. */
  readonly callbackRoles?: CallbackRoles;
  /** Extension bag — see `MetadataRecord` (kind-agnostic; every def carries the slot). */
  readonly metadata?: MetadataRecord;
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
   *  `rosetta()` always resolves the default before baking. */
  readonly provenance: ProvenanceRole;
  /** RESOLVED cache class — see `NativeSymbolDef.cacheClass`. The baked rosetta `run`
   *  wrapper is the ONE membrane chokepoint the run-cache interception (values/run-cache.ts)
   *  gates on this. Absent = regenerateable (never touches the serialized cache). */
  readonly cacheClass?: CacheClass;
  /** RESOLVED per-lambda-arm callback roles — see `NativeSymbolDef.callbackRoles`. */
  readonly callbackRoles?: CallbackRoles;
  /** See `Contract.type`. */
  readonly type?: string;
  /** See `Contract.preludeOnly`. */
  readonly preludeOnly?: boolean;
  /** Extra data carried by this symbol (MCP tool annotations, etc.) — the same
   *  kind-agnostic slot every def carries (see `MetadataRecord`); rosetta keeps its
   *  generic `M` so a higher layer can type its own bag (`RosettaSymbolDef<M>`).
   *  Fields obey the `MetadataField` union: fn-valued fields are DYNAMIC, resolved
   *  at read time against the assembly's activation. */
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
  /** DECLARED per-callable-arg callback roles. A tagless def's contract is shapeless by
   *  construction (`in: z.array(z.value)` — the real per-op types live on the receiver
   *  terms), so shape can NEVER extract here; `withCallbackRoles` below is the declaration
   *  channel (srfi-1's `reduce` declares its acc chain through it — the "fold declares acc
   *  chain" case). */
  readonly callbackRoles?: CallbackRoles;
  /** Extension bag — see `MetadataRecord` (kind-agnostic; every def carries the slot). */
  readonly metadata?: MetadataRecord;
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
  /** See `TaglessSymbolDef.callbackRoles` — same shapeless-contract rationale. */
  readonly callbackRoles?: CallbackRoles;
  /** Extension bag — see `MetadataRecord` (kind-agnostic; every def carries the slot). */
  readonly metadata?: MetadataRecord;
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
   *  Non-optional: `sequence()` always resolves the default before baking. */
  readonly provenance: ProvenanceRole;
  /** RESOLVED cache class — see `NativeSymbolDef.cacheClass`. */
  readonly cacheClass?: CacheClass;
  /** RESOLVED per-lambda-arm callback roles — see `NativeSymbolDef.callbackRoles`. */
  readonly callbackRoles?: CallbackRoles;
  /** Extension bag — see `MetadataRecord` (kind-agnostic; every def carries the slot). */
  readonly metadata?: MetadataRecord;
}

/** Structured CAUSE for a door — the owning capability + WHAT missing input would satisfy
 *  it, so a static reader (a validator, discovery, the wireframe) can derive the causal
 *  chain from a bound door instead of reaching into an anonymous throwing closure.
 *
 *  ADDITIVE, stamped SEPARATELY from `notImplemented()` — the factory (`./notImplemented.js`)
 *  is called from inside a `symbols` record literal, before the `EnvCapability` wrapping it
 *  exists, so it cannot know its own owner. `common/capability.ts`'s door bind arm derives
 *  `owner` from the binding capability's OWN `name` at bake (`lower().apply()`), with
 *  `needs: []`: a `notImplemented` door is a PERMANENT design omission (set!, call/cc,
 *  mutators — R7RS features arrival omits by the purity invariant), never conditional on an
 *  absent config/dep, so it has nothing to list there. A NON-EMPTY `needs` is the door-SET-
 *  DEGRADATION kind — a capability lowered degraded because a declared config key was
 *  ABSENT.
 *
 *  `needs` SCOPE is deliberately CONFIGURATION-ONLY: a `dependency` need would name an
 *  UNROOTED capability (one absent from the assembled root set, so its own doors never bind
 *  at all — C3 pulls deps as object edges, not string ids), and that naming has no policy
 *  yet; inventing one here would be exactly the kind of undesigned decision this type
 *  shouldn't make. This type ships only what's actually derivable at bake with no open
 *  question: the owning capability's id + its own declared `configuration` schema keys.
 *  `dependency` (and any `resource` need — a capability's own resource, not subject to the
 *  SAME unrooted-naming hole, but equally unpopulated today) is a strictly additive
 *  extension once that policy is designed — never a retrofit that reshapes this scope. */
export interface DoorCause {
  readonly owner: string;
  readonly needs: readonly { readonly kind: "configuration"; readonly key: string; readonly hint?: string }[];
}

/** An omitted verb (errors-as-doors). No contract/impl — just the teaching reason.
 *  `cause` is ADDITIVE (`DoorCause`, above) — `notImplemented()` never sets it;
 *  `common/capability.ts` stamps it at bake for every door it binds. Absent only for a
 *  `DoorSymbolDef` built and used OUTSIDE that bind path (a raw `symbol.notImplemented`
 *  template read directly, as `symbol.test.ts` pins).
 *
 *  `preludeOnly` — see `Contract.preludeOnly` (KIND-AGNOSTIC). No `notImplemented` door
 *  sets it today — every declared door binds into the runtime env — but `capability.ts`'s
 *  door bind arm routes through the SAME `bindTarget(def)` every other kind does, so a
 *  future door WOULD honor it — the field exists so that routing is actually meaningful,
 *  not just structurally present. */
export interface DoorSymbolDef {
  readonly kind: "door";
  readonly name: string;
  readonly reason: string;
  readonly cause?: DoorCause;
  readonly preludeOnly?: boolean;
  /** Extension bag — see `MetadataRecord` (kind-agnostic; every def carries the slot). */
  readonly metadata?: MetadataRecord;
}

/** A kernel KEYWORD: special form, made first-class. `lower()` binds `new Keyword(name)`; the
 *  evaluator resolves a call head through the env and dispatches `SPECIAL_FORMS[name]` when it
 *  resolves to that marker — aliasable + lexically shadowable (the dual of cxr). */
export interface KeywordSymbolDef {
  readonly kind: "keyword";
  readonly name: string;
  readonly doc?: string;
  /** Extension bag — see `MetadataRecord` (kind-agnostic; every def carries the slot). */
  readonly metadata?: MetadataRecord;
}

/** Non-evaluating MACRO form: impl is a raw JS transformer (a `Macro`/`Syntax`), bound as-is by
 *  assembly — NOT arg-evaluating (native/rosetta) nor evaluator-dispatched (keyword). Home for
 * syntax-rules + the macro family carrying a JS expander; generic `is_macro`/`is_syntax` eval
 * hook expands whatever it binds. */
export interface MacroSymbolDef {
  readonly kind: "macro";
  readonly name: string;
  readonly macro: Macro;
  /** Extension bag — see `MetadataRecord` (kind-agnostic; every def carries the slot). */
  readonly metadata?: MetadataRecord;
}

/** A SCHEME-BODIED value/procedure declaration. `symbol.define` decomposes a capability's
 *  prelude into individually-declared, contract-bearing defines — the missing link that
 *  makes capability-owned scheme code visible to static analysis (freeVars, the provenance
 *  classifier, a future validator).
 *
 *  `in`/`out` are ALWAYS normalized VectorSchemas — for a PROCEDURE (`callable: true`,
 *  contract authored as a `Contract<I,O,Rest>` record) they're the real arg/return vectors;
 *  for a CONSTANT (`callable: false`, contract authored as a single `ZodTypeAny`) they're
 *  `z.tuple([])` in / a 1-tuple wrapping the value schema out — the 0-ary-procedure
 *  convention every OTHER vector-shaped reader already uses, so harvest/arity code never
 *  special-cases constants structurally.
 *
 *  `callable` is NOT derivable from `in`/`out` shape alone (a genuine 0-ary THUNK —
 *  `(lambda () …)` — also normalizes to an empty `in` tuple) — it is the FACTORY's own
 *  discriminator (`contract instanceof ZodType` ⇒ constant), carried here so
 *  `capability.ts`'s bind arm never has to re-guess it. */
export interface DefineSymbolDef {
  readonly kind: "define";
  readonly name: string;
  readonly doc?: string;
  readonly in: z.ZodTypeAny;
  readonly out: z.ZodTypeAny;
  /** See the class doc above. */
  readonly callable: boolean;
  /** Is the call boundary's RETURN a single value (`isSingleOutput`'s reading of the
   *  AUTHORED, pre-normalization `output`) rather than a multi-value/variadic vector?
   *  Always `true` for a constant. Stored explicitly (not re-derived from the
   *  NORMALIZED `out` schema at bind time) because `out` is already a `VectorSchema`
   *  (a `z.tuple`/array-ish instance) by the time it reaches this def — `isSingleOutput`
   *  itself only reads the raw pre-normalization `VectorSpec` shape (`Array.isArray`),
   *  which the normalized schema no longer structurally is. */
  readonly singleOut: boolean;
  /** The authored RHS EXPRESSION source (a `(lambda …)` for a procedure, a plain
   *  expression for a constant) — NOT a whole `(define name …)` form, so the name lives in
   *  exactly one place. Parsed + memoized at first bake. */
  readonly body: string;
  /** FNV-1a over body + contract's stable text — minted EAGERLY at declaration construction
   *  (cheap string hash), not deferred to bake. */
  readonly bodyHash: string;
  /** DERIVED provenance role — a fixpoint over the capability's whole `symbol.define` set
   *  via `classifyProgramPrelude`'s algorithm, run at bake against the assembly's own
   *  env-derived classifier. Port-free (fixpoint-closed) ⇒ `"pipe"`; port-reaching (direct
   *  or transitive) ⇒ `"opaque"` (the conservative collapse — the full per-body LineageNode
   *  tree is always re-derivable from `body`/`bodyHash` for a future finer-grained
   *  consumer). An optional `provenance` on the AUTHORING contract stays legal as a drift
   *  door (declared-vs-derived mismatch throws `ProvenanceRoleShapeError` at bake) — it is
   *  never itself the resolved value here. */
  readonly provenance: ProvenanceRole;
  /** The AUTHORED `Contract.provenance`, if the author declared one (procedure defines
   *  only — a constant's bare `ZodTypeAny` contract has no slot for it). Carried so bake
   *  can run the drift door (declared-vs-derived): a declared role that CONTRADICTS the
   *  derived classification throws `ProvenanceRoleShapeError`. Never itself the resolved
   *  `provenance` above — that field is always the DERIVED value (or the innocuous
   *  `"pipe"` placeholder before bake runs). */
  readonly declaredProvenance?: ProvenanceRole;
  /** See `Contract.type`. */
  readonly type?: string;
  /** See `Contract.preludeOnly`. */
  readonly preludeOnly?: boolean;
  /** Per-call zod validation gate (a cost valve) — mirrors rosetta's
   *  `BakeRuntimeOpts.validate`, resolved to a concrete boolean at bake (default
   *  `true`) since the wrapper is built once the evaluated closure is available. */
  readonly validate: boolean;
  /** Extension bag — see `MetadataRecord` (kind-agnostic; every def carries the slot). */
  readonly metadata?: MetadataRecord;
}

/** A SCHEME-BODIED macro/expander declaration — `symbol.define`'s sibling for macro forms.
 *  Contract-FREE (a macro has no call-boundary, no provenance role — its "free variables"
 *  would name the EXPANSION env, a categorically different static-analysis story) — carries
 *  the ternary `macroAttribute` static attribute instead (stored verbatim as authored; the
 *  walker that consumes it is a separate concern). The body is a scheme LAMBDA expression
 *  over the macro's OWN fexpr formals (e.g. `(lambda (formals expr . body) …)` for
 *  `receive`) — evaluated once per bake, then wound into a `Macro` fexpr transformer at
 *  bind time (capability.ts's apply arm). */
export interface DefineSyntaxSymbolDef {
  readonly kind: "define-syntax";
  readonly name: string;
  readonly doc?: string;
  readonly body: string;
  readonly bodyHash: string;
  /** `"opaque"` (DEFAULT, safe under-report) | `"expression"` | `"binder"`. Stores the
   *  AUTHORED value verbatim; no validation or consumption happens here. */
  readonly macroAttribute: "opaque" | "expression" | "binder";
  /** See `Contract.preludeOnly` — kind-agnostic, same routing every other kind honors. */
  readonly preludeOnly?: boolean;
  /** Extension bag — see `MetadataRecord` (kind-agnostic; every def carries the slot). */
  readonly metadata?: MetadataRecord;
}

export type AEntity =
  | NativeSymbolDef
  | RosettaSymbolDef
  | TaglessSymbolDef
  | TaglessGuardSymbolDef
  | SequenceSymbolDef
  | DoorSymbolDef
  | KeywordSymbolDef
  | MacroSymbolDef
  | DefineSymbolDef
  | DefineSyntaxSymbolDef;

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
    throw new KeywordPairingError("dangling-keyword", args.length);
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
    throw new KeywordPairingError("input-rest-needs-tuple");
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
// 3b. The DRIFT ALARM — declared `provenance` role vs contract SHAPE. Two contradictions
//     are SHAPE-decidable; everything else needs the JS body, which shape can't see.
// ─────────────────────────────────────────────────────────────────────────────

/** Every schema at a NORMALIZED VectorSchema's top level (see `normalizeVector`/
 *  `normalizeInputVector`) — a `z.tuple`'s items, an array-ish schema's lone element
 *  (wrapped as a 1-list so both shapes iterate uniformly), or `undefined` for anything else
 *  (a kwargs `z.object`, a bare non-container schema) — the checks below fall back to their
 *  own conservative default rather than guess past this. Same zod-4.3.6 `_zod.def` shape
 *  `type-layer/schema-to-ts.ts`'s `signatureOf` already introspects (verified there); a local
 *  copy because that module wants a differently-shaped return (printer-facing `TupleDef`/
 *  `ArrayDef`) and importing it here would pull the harvest/printer world into the bake layer.
 *  EXPORTED (beyond this module's own gates below) for `rosetta.ts`'s z.value-callable door
 *  (Ruling A, longcat thesis-2 attack 3 adjudication) — it reads the SAME shallow slot view
 *  `contractMayCarryCallable` reads, to find which top-level positions are bare `z.value`. */
export function topLevelSchemas(schema: z.ZodTypeAny): readonly z.ZodTypeAny[] | undefined {
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
 *  LIMIT (do not extend this function past it): shape catches CONTRADICTIONS, not LIES. A
 *  JS body that fans while declared `pipe` is consistent-but-wrong and invisible to shape;
 *  contract shape cannot see JS bodies, and arrange-vs-membership is semantic, not
 *  structural. Mitigation for that class is an agreement gate plus the generator corpus,
 *  never a shape guess bolted on here. */
export function assertProvenanceRoleShape(
  name: string,
  role: ProvenanceRole,
  inSchema: z.ZodTypeAny,
  outSchema: z.ZodTypeAny,
): void {
  if (role === "sink" || role === "transparent") {
    const items = topLevelSchemas(outSchema);
    // VOID-FAMILY reading (the same no-egress reading `extractCallbackRoles`'s `voidEgress`
    // takes): a zero-item output vector AND an all-`undefinedResult` vector both carry no
    // real egress — `output: [z.undefinedResult]` is a void verb, not a return value. This
    // is the sink gate the run-cache tombstone-skip (§2.2's replay table) stands on: a
    // sink's replay-skip returns void, sound only because the contract PROVED void here.
    const hasEgress = items === undefined ? true : items.some((item) => z.lookupName(item) !== "undefinedResult");
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

/** Every schema a cache-class gate must inspect: a normalized vector's top-level slots
 *  (`topLevelSchemas`), PLUS a kwargs `z.object`'s per-field codecs (a kwargs contract's
 *  `.in` is the bare object schema — its fields are the slots that cross), PLUS the bare
 *  schema itself when nothing introspects (so `z.lookupName` can still name it). Local to
 *  the cache gate: the provenance gates deliberately stay on `topLevelSchemas`' narrower
 *  read (their conservative fallbacks differ). */
function cacheGateSlots(schema: z.ZodTypeAny): readonly z.ZodTypeAny[] {
  const items = topLevelSchemas(schema);
  if (items !== undefined) return items;
  const def = (schema as { _zod?: { def?: { type?: string; shape?: Record<string, z.ZodTypeAny> } } })._zod?.def;
  if (def?.type === "object" && def.shape) return Object.values(def.shape);
  return [schema];
}

/** THE REGION-SCOPE GATE (openRegionScope-gap Ruling A, arrival-mcp-rework-over-phases.md's
 *  sibling ruling on capability/symbol.rosetta parity with legacy `createRosettaWrapper`):
 *  does this contract's (already-normalized) INPUT vector carry a slot that might hand the
 *  impl a LIVE callable? Two slot kinds can:
 *  - `z.procedure` — TYPED marshaling; decode ALWAYS wraps the incoming scheme callable into
 *    a host fn bound to whatever region scope is ambient (`currentRegionScope() ??
 *    DETACHED_SCOPE`, scheme-zod.ts). If nothing opened a real scope, the wrapper silently
 *    binds to the shared, never-closing `DETACHED_SCOPE` — a reverse call through it re-enters
 *    under `DETACHED_SCOPE.runCtx` (`CONSTANT_CTX`), NOT the live run's context, which is
 *    exactly the burst-bypass hole this gate exists to close (a lambda calling a sink verb
 *    would fire the sink inline instead of enqueueing under the live run's `effects`).
 *  - `z.value` — the declared RAW escape hatch ("impl does its own conversion", scheme-zod.ts's
 *    own doc on `value`): decode performs NO transform, so the impl receives the raw scheme
 *    value untouched and MAY itself call `schemeToJs`/`applyCallback` on it if it happens to be
 *    a callable — reading the SAME ambient scope `z.procedure`'s decode reads.
 *
 *  Used by `rosetta()` (rosetta.ts) to decide, ONCE at bake, whether its baked `run` wrapper
 *  needs to open a region scope around a call at all — mirroring the legacy
 *  `createRosettaWrapper`, which scoped EVERY invocation unconditionally (it had no contract to
 *  gate on). A lambda-free verb (the overwhelming majority: `+`, `string-append`, every plain
 *  data-in/data-out rosetta) never mints a scope, never touches the WeakMap wrapper cache —
 *  zero cost, byte-identical to before this ruling landed.
 *
 *  `z.value` is included per an explicit adjudication, not an oversight: contract SHAPE cannot
 *  see whether a raw value passing through a `z.value` slot happens to be a callable the impl
 *  later hands to a reverse crossing — under-gating there would silently reopen the exact hole
 *  this function exists to close for a small, real family of verbs (the manifold/infer `value`
 *  slots documented in scheme-zod.ts). The ruling errs toward scoping: correctness over the
 *  micro-cost of an unused scope on the rarer verb that declares `z.value` for something
 *  genuinely non-callable.
 *
 *  Checked on the INPUT side only — `z.procedure`'s own doc bans the OTHER direction ("rosetta
 *  result is never a bare JS function — provenance untraceable"), and the region discipline this
 *  gate enables (the escape/pending doors) is specifically about a SCHEME callable crossing INTO
 *  JS; a JS callback crossing INTO scheme via `z.procedure`'s `encode` arm is a forward crossing
 *  with no region concern. */
export function contractMayCarryCallable(inSchema: z.ZodTypeAny): boolean {
  return cacheGateSlots(inSchema).some((slot) => {
    const slotName = z.lookupName(slot);
    return slotName === "procedure" || slotName === "value";
  });
}

/** THE `view` SHAPE GATE (errors-as-doors, beside `assertProvenanceRoleShape` — the same
 *  bake-time pattern): a `view` cache class demands a SERIALIZABLE contract — no `z.lambda`
 *  arms (a callable can't be a boundary snapshot), no `z.value` slots (the declared raw
 *  escape hatch, by definition not serializable) — because a cache entry must serialize
 *  (arrival-mcp-rework-over-phases.md §2.3, Ruling A). A contradiction throws
 *  `CacheClassShapeError` at BAKE; the author's way out is declaring `pure` (or nothing).
 *  `pure` has NO shape gate: recovery is re-call, nothing of it is persisted. Called by
 *  `native()`/`rosetta()`/`sequence()` on the schemas each already normalizes.
 *
 *  Checked on BOTH vectors: an input `z.value`/`z.lambda` breaks the cache KEY (decoded
 *  args must canonicalize to JSON — run-cache.ts's `canonicalJson`), an output one breaks
 *  the cache ENTRY (the decoded-face value must serialize). `z.lookupName` resolves
 *  through `.optional()` wrappers, so an optional lambda arm still gates. */
export function assertCacheClassShape(
  name: string,
  cacheClass: CacheClass | undefined,
  inSchema: z.ZodTypeAny,
  outSchema: z.ZodTypeAny,
): void {
  if (cacheClass !== "view") return; // pure / absent: regenerateable, nothing persists — no gate.
  for (const [side, schema] of [
    ["input", inSchema],
    ["output", outSchema],
  ] as const) {
    for (const slot of cacheGateSlots(schema)) {
      const slotName = z.lookupName(slot);
      if (slotName === "lambda") {
        throw new CacheClassShapeError(
          name,
          cacheClass,
          `a view's cache entry must serialize, but this contract's ${side} vector carries a z.lambda arm — ` +
            `a callable is not a boundary snapshot; declare "pure" (recovery = re-call) or drop the declaration`,
        );
      }
      if (slotName === "value") {
        throw new CacheClassShapeError(
          name,
          cacheClass,
          `a view's cache entry must serialize, but this contract's ${side} vector carries a z.value slot ` +
            `(the declared raw escape hatch — raw crossings don't serialize); declare "pure" (recovery = ` +
            `re-call) or narrow the slot to a data codec`,
        );
      }
    }
  }
}

/** CALLBACK-role extraction from the contract: per z.lambda arm, derive a `CallbackRole`
 *  from SHAPE (arm position + return schema) with the declared `Contract.callbackRoles`
 *  overriding exactly where shape underdetermines. Returns the resolved per-arm array
 *  (lambda order), or `undefined` when the contract carries no z.lambda arm at all.
 *
 *  What shape can actually see — and the strength split it forces:
 *  - `z.lambda` is a bare callable schema (scheme-zod.ts): it carries NO return shape, so
 *    the CALLBACK's own return is invisible. Only the HOST contract's vectors decide
 *    anything.
 *  - DECIDED: void-family host egress (every top-level output schema `undefinedResult`, or
 *    a zero-output vector) ⇒ every lambda arm is `effect` — whatever the callback returns
 *    has no egress wire to ride (for-each/string-for-each/vector-for-each). An override
 *    contradicting this THROWS (the drift-door extension; same `ProvenanceRoleShapeError`
 *    family, errors-as-doors).
 *  - DEFAULT: `fan`-role host with value egress ⇒ `element-transformer` (map/vector-map).
 *    Overridable WITHOUT the door: filter's contract is shape-identical to map's yet its
 *    pred is `control` — arrange-vs-membership is semantic, so the default must yield.
 *  - NOT extracted: `control` — a callback's boolean/ordering return is exactly what
 *    z.lambda can't express, and the host's own boolean egress is NOT a proxy (procedure?
 *    takes a z.lambda it never invokes and returns a boolean — a host-return rule would
 *    door an introspection subject as a decision callback). `accumulator` — fold-shaped
 *    acc-position is a semantic fact (and `reduce` is a shapeless tagless def anyway); both
 *    arrive by declaration only. The standing rule: the door must UNDER-trigger, never
 *    guess.
 *
 *  Decidable contradictions that DO door: a declared roles array LONGER than the lambda-arm
 *  count (a role for a phantom callback — including any declaration on a lambda-free
 *  contract), and a declaration against a DECIDED arm that disagrees with it. */
export function extractCallbackRoles(
  name: string,
  hostRole: ProvenanceRole,
  inSchema: z.ZodTypeAny,
  outSchema: z.ZodTypeAny,
  declared: readonly CallbackRole[] | undefined,
): CallbackRoles | undefined {
  const inItems = topLevelSchemas(inSchema) ?? [];
  // Lambda arms in input order. `lookupName` resolves through `.optional()` wrappers
  // (scheme-zod.ts resolveCore walks `innerType`), so `z.lambda.optional()` (sort's less?,
  // member/assoc's compare) counts as a lambda arm — as it must: the role describes the
  // callback WHEN PRESENT.
  const lambdaCount = inItems.filter((item) => z.lookupName(item) === "lambda").length;
  if (declared !== undefined && declared.length > lambdaCount) {
    throw new ProvenanceRoleShapeError(
      name,
      declared.join(","),
      lambdaCount === 0
        ? "callbackRoles declared, but this contract's input vector has no z.lambda arm to carry a callback role"
        : `callbackRoles declares ${declared.length} role(s), but this contract's input vector carries only ${lambdaCount} z.lambda arm(s) — a role for a phantom callback`,
    );
  }
  if (lambdaCount === 0) return undefined;
  // Void-family egress: every top-level output schema is `undefinedResult`, INCLUDING the
  // vacuous zero-output vector (`output: []` — same no-egress reading the sink/transparent
  // check above takes). A non-introspectable output (`topLevelSchemas` undefined) stays
  // conservative: NOT void, nothing decided.
  const outItems = topLevelSchemas(outSchema);
  const voidEgress = outItems !== undefined && outItems.every((item) => z.lookupName(item) === "undefinedResult");
  const roles: (CallbackRole | undefined)[] = [];
  for (let k = 0; k < lambdaCount; k++) {
    const decided: CallbackRole | undefined = voidEgress ? "effect" : undefined;
    const declaredRole = declared?.[k];
    if (declaredRole !== undefined && decided !== undefined && declaredRole !== decided) {
      throw new ProvenanceRoleShapeError(
        name,
        declaredRole,
        `callback arm ${k} is shape-DECIDED "${decided}" (void-family host egress — the callback's product has no egress wire), contradicting the declared "${declaredRole}"`,
      );
    }
    const dflt: CallbackRole | undefined = hostRole === "fan" && !voidEgress ? "element-transformer" : undefined;
    roles.push(declaredRole ?? decided ?? dflt);
  }
  return roles;
}

/** DECLARATION channel for the contract-LESS kinds (tagless/tagless-guard): their `in` is
 *  the shapeless `z.array(z.value)` (the real per-op algebra lives on the receiver terms),
 *  so `extractCallbackRoles` can never see their callbacks — declaration is the ONLY
 *  channel, and there is no shape for a declaration to contradict (no drift door here BY
 *  CONSTRUCTION, not by leniency). Roles align with the op's callable args in call order.
 *  The one live use is the acc-chain marker: srfi-1's `reduce` declares `["accumulator"]`
 *  — the "fold declares acc chain" case, the chained track-composition operator's source. */
export function withCallbackRoles<D extends TaglessSymbolDef | TaglessGuardSymbolDef>(
  def: D,
  callbackRoles: readonly CallbackRole[],
): D {
  return { ...def, callbackRoles };
}

/** The ACC-CHAIN marker, read as data: chained composition — `egress(Tᵢ) → ingress(Tᵢ₊₁)`
 *  is the ONLY sanctioned inter-track edge; the track-separation law's one exception. True
 *  iff the resolved roles carry an `accumulator` arm — the classifier's own read. */
export function declaresAccChain(callbackRoles: CallbackRoles | undefined): boolean {
  return callbackRoles !== undefined && callbackRoles.includes("accumulator");
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Shared contract-impl types the per-tag factories build their return value from.
//    NO separate "bake*" ctor — each factory (`native.ts`/`rosetta.ts`/`sequence.ts`/…)
//    wires its own `AEntity` member directly from these types + helpers above.
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
  /** Metadata to attach to the symbol (e.g. MCP tool annotations). Stored in `.metadata`
   *  on the resulting def. Use generic `RosettaSymbolDef<M>` to type it. Fields obey the
   *  `MetadataField` union — a fn-valued field is DYNAMIC (resolved lazily at read time
   *  against the assembly's activation, see `./metadata.js`); everything else is static data. */
  metadata?: MetadataRecord;
}

// No separate, importable `bakeNative`/`bakeRosetta`/`bakeDoor` constructors here: the
// baking logic is inlined directly into the returned closure of `native()`/`rosetta()`/
// `notImplemented()` (one file each) — producing a NativeSymbolDef/RosettaSymbolDef/
// DoorSymbolDef is ONLY possible by calling `symbol.native`/`symbol.rosetta`/
// `symbol.notImplemented`. No raw ctor here to reach around them with.

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

// Same convention for `tagless()`/`taglessGuard()`/`sequence()`: no separate `bake*` ctor,
// each inlines its own baking logic directly.

// Tagged-template factories (`native`/`rosetta`/`tagless`/…) live one-per-file under this
// directory; each imports shared types + helpers from here (NOT a `bake*` ctor — gone) and is
// re-assembled into `symbol` namespace by `./index.ts`. See `../symbol.js` for stable entry.
