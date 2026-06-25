// symbol — the `arrival.symbol*` EnvCapability symbol-definition API.
//
// One zod contract, read (eventually) four ways: runtime validation (z.parse), static
// impl types (z.infer via the generics here), the harvested .d.ts (printed from the
// schema — printer BUILT in schema-to-ts.ts; type-lens wiring pending), and the JS↔Scheme membrane (each
// schema is the per-arg codec). This file builds the AUTHORED-extension layer:
//
//   const symbol = { native, rosetta, tagless, notImplemented }
//
// so `import * as arrival from "./symbol.js"` →  arrival.symbol.native`name: doc`(…)
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
//                       skippable/gated) → impl(decodedArgs) → await (async implicit) →
//                       encode return (codec) → build the scheme values-list. This mirrors
//                       createRosettaWrapper's schemeToJs → fn → jsToScheme spine, with
//                       the codecs standing in for the generic schemeToJs/jsToScheme.
//                       The impl is CTX-FREE: (decodedArgs) => result. withContext /
//                       argProvenance are DROPPED here — the impl never receives ctx.
//                       PROVENANCE MINTING is RESOLVED: the run-wrapper is `__withCtx` at the
//                       binding level (lower() binds it raw; the evaluator appends ctx), so it
//                       reads ctx.currentInvocation and mints/deep-stamps EXACTLY as
//                       createRosettaWrapper does (a non-pure rosetta SymbolDef = a source). The
//                       IMPL stays ctx-free — the wrapper strips ctx before decode.
//
//   symbol.notImplemented — no contract/impl, just `name: reason`. bake → a door:
//                       { kind: "door", name, reason } (the %purity-door story).
// ─────────────────────────────────────────────────────────────────────────────

import * as z from "./scheme-zod.js";
import type { APair } from "../values/primitives/APair.js";
import { AValue, pointProvenance, unionProvenance } from "../values/primitives/AValue.js";
import { jsToScheme } from "../rosetta.js";
import { CONSTANT_CTX, type RunContext } from "../values/primitives/RunContext.js";

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

/** A symbol's input/output contract. */
export interface Contract<I extends VectorSpec, O extends VectorSpec> {
  input: I;
  output: O;
  /** ROSETTA-ONLY. `pure: true` makes the rosetta a TRANSFORM, not a source: it FORWARDS the
   *  union of its inputs' provenance instead of minting a fresh point at the call site (mirrors
   *  legacy defineRosetta `pure: true`). Strict `=== true` — undefined/false = source (the
   *  default, mints). Ignored by `symbol.native` (native ops never mint). */
  readonly pure?: boolean;
}

/** The impl a contract demands: decoded args in, decoded return (or a promise) out.
 *  `DecodedArgs` strips `readonly` (`-readonly` mapped tuple) so a `const`-inferred
 *  contract tuple becomes a MUTABLE positional param list the impl can declare. */
export type Impl<I extends VectorSpec, O extends VectorSpec> = (
  ...args: DecodedArgs<I>
) => MaybePromise<DecodedReturn<O>>;

// ─────────────────────────────────────────────────────────────────────────────
// 2. SymbolDef — the baked, discriminated union
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

export type SymbolDef = NativeSymbolDef | RosettaSymbolDef | TaglessSymbolDef | SequenceSymbolDef | DoorSymbolDef | KeywordSymbolDef;

// ─────────────────────────────────────────────────────────────────────────────
// 3. Internals — name/doc parsing + vector normalization
// ─────────────────────────────────────────────────────────────────────────────

/** Parse `"name: human description"` from a tagged-template. Substitutions are
 *  interpolated first (so a `${verb}: …` template works), then split on the FIRST
 *  colon. No colon ⇒ the whole string is the name (doc undefined). */
function parseNameDoc(tpl: TemplateStringsArray, sub: readonly unknown[]): { name: string; doc?: string } {
  let raw = "";
  for (let i = 0; i < tpl.length; i++) {
    raw += tpl[i];
    if (i < sub.length) raw += String(sub[i]);
  }
  const colon = raw.indexOf(":");
  if (colon === -1) return { name: raw.trim() };
  return { name: raw.slice(0, colon).trim(), doc: raw.slice(colon + 1).trim() };
}

/** Normalize a VectorSpec to ONE zod schema describing the whole args/return vector:
 *  a bare tuple → `z.tuple`; an array-ish schema → itself. This is what `run` parses
 *  the decoded-args array against (and what the harvest will print from). */
function normalizeVector(spec: VectorSpec): z.ZodTypeAny {
  if (Array.isArray(spec)) {
    // z.tuple wants a non-empty tuple type; an empty contract ([]) is the 0-arg case.
    return spec.length === 0
      ? (z.tuple([]) as unknown as z.ZodTypeAny)
      : (z.tuple(spec as [z.ZodTypeAny, ...z.ZodTypeAny[]]) as unknown as z.ZodTypeAny);
  }
  return spec as z.ZodTypeAny;
}

/** Did the author give a 1-tuple output? Then the impl returns a SINGLE value (we wrap
 *  it as a 1-element values-list); otherwise it returns the values-vector already. */
function isSingleOutput(output: VectorSpec): boolean {
  return Array.isArray(output) && output.length === 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. bake — the three constructors' shared runtime
// ─────────────────────────────────────────────────────────────────────────────

interface NativeInput {
  kind: "native";
  name: string;
  doc?: string;
  contract: Contract<VectorSpec, VectorSpec>;
  impl: AnyFn;
}
interface RosettaInput {
  kind: "rosetta";
  name: string;
  doc?: string;
  contract: Contract<VectorSpec, VectorSpec>;
  impl: AnyFn;
}
interface DoorInput {
  kind: "door";
  name: string;
  reason: string;
}
interface TaglessInput {
  kind: "tagless";
  name: string;
  doc?: string;
  contract: Contract<VectorSpec, VectorSpec>;
}
interface SequenceInput {
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

function bakeNative(input: NativeInput): NativeSymbolDef {
  return {
    kind: "native",
    name: input.name,
    doc: input.doc,
    in: normalizeVector(input.contract.input),
    out: normalizeVector(input.contract.output),
    // NO runtime validation, NO codec — the impl works on scheme values directly.
    // "zod for types purely": the schemas live on the def for inference + the harvest.
    impl: input.impl,
  };
}

function bakeRosetta(input: RosettaInput, opts: BakeRuntimeOpts = {}): RosettaSymbolDef {
  const inSchema = normalizeVector(input.contract.input);
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
    // plain object carrying env/currentInvocation/tap/signal that reaches here. Same probe
    // as createRosettaWrapper's looksLikeEvalContext.
    let ctx: unknown = undefined;
    let schemeArgs = args;
    const last = args[args.length - 1];
    if (
      args.length > 0 &&
      last != null &&
      typeof last === "object" &&
      !(last instanceof AValue) &&
      !Array.isArray(last) &&
      ("env" in last || "currentInvocation" in last || "tap" in last || "signal" in last)
    ) {
      ctx = last;
      schemeArgs = args.slice(0, -1);
    }

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
    const decodedArgs = z.decode(inSchema, schemeArgs) as readonly unknown[];

    // 2. RUN the (ctx-free) impl. async is implicit.
    const result = await input.impl(...decodedArgs);

    // 3. PROVENANCE — the SAME spine as createRosettaWrapper. A SOURCE rosetta (default)
    //    MINTS a fresh point off ctx.currentInvocation; a PURE rosetta (`pure: true`) is a
    //    TRANSFORM that FORWARDS the input-provenance union instead (mirrors defineRosetta
    //    `pure: true`). With no invocation in ctx (direct-JS) a source also falls back to the
    //    input union. ★The forward-vs-mint choice is provenance-load-bearing: a pure rosetta
    //    that minted would fabricate a fresh origin (the seal-laundering class of bug).
    const inv = (ctx as { currentInvocation?: { id?: number; isProvenancePoint?: boolean; markProvenancePoint?(): void } } | undefined)
      ?.currentInvocation;
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
    if (singleOut) {
      // 1-tuple output: the impl returned a single value; encode it as a 1-vector.
      const encoded = (z.encode(outSchema, [result]) as readonly unknown[])[0];
      return jsToScheme((ctx as { runCtx?: RunContext } | undefined)?.runCtx ?? CONSTANT_CTX, encoded, {}, resultProvenance);
    }
    // multiple-values / array-ish output: the impl returned the values-vector already.
    const encoded = z.encode(outSchema, result) as unknown[];
    return encoded.map((v) => jsToScheme((ctx as { runCtx?: RunContext } | undefined)?.runCtx ?? CONSTANT_CTX, v, {}, resultProvenance));
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
  };
}

function bakeDoor(input: DoorInput): DoorSymbolDef {
  return { kind: "door", name: input.name, reason: input.reason };
}

/** Human description of a receiver for the type-mismatch error: an AValue reports its
 *  scheme `kind` ("number"/"pair"/"nil"/…), else the JS shape. */
function describeReceiver(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (v instanceof AValue) return v.kind;
  return Array.isArray(v) ? "array" : typeof v;
}

/** Bake a tagless dispatcher. No impl — `run` forwards to the operand's own
 *  `arrival/tagless-final/<name>` term method. Receiver = the LAST scheme arg (scheme places
 *  the collection last: `(map fn xs)`, `(car xs)`); the leading args + the run's RunContext
 *  (read ctx-aware off the evaluator-appended EvalContext) are passed through. A receiver that
 *  declares no such method is a TYPE MISMATCH — a clear throw, not a silent bypass. */
function bakeTagless(input: TaglessInput): TaglessSymbolDef {
  const method = `arrival/tagless-final/${input.name}`;
  const run = async (...args: unknown[]): Promise<unknown> => {
    // Strip the evaluator-appended ctx iff the trailing arg looks like one (same probe as
    // bakeRosetta). Unlike native, tagless is ctx-AWARE — it needs the run for the method.
    let ctx: unknown = undefined;
    let schemeArgs = args;
    const last = args[args.length - 1];
    if (
      args.length > 0 &&
      last != null &&
      typeof last === "object" &&
      !(last instanceof AValue) &&
      !Array.isArray(last) &&
      ("env" in last || "currentInvocation" in last || "tap" in last || "signal" in last)
    ) {
      ctx = last;
      schemeArgs = args.slice(0, -1);
    }
    const runCtx = (ctx as { runCtx?: RunContext } | undefined)?.runCtx ?? CONSTANT_CTX;
    const receiver = schemeArgs[schemeArgs.length - 1];
    const leading = schemeArgs.slice(0, -1);
    const fn = (receiver as Record<string, unknown> | null | undefined)?.[method];
    if (typeof fn !== "function") {
      throw new TypeError(
        `${input.name}: the ${describeReceiver(receiver)} primitive does not support \`${input.name}\` ` +
          `(it declares no ${method}). A tagless op lives ON the arrival terms whose algebra implements it.`,
      );
    }
    return await (fn as (...a: unknown[]) => unknown).call(receiver, ...leading, runCtx);
  };
  (run as { __withCtx?: boolean }).__withCtx = true;
  return { kind: "tagless", name: input.name, doc: input.doc, in: normalizeVector(input.contract.input), out: normalizeVector(input.contract.output), run };
}

/** Bake a ctx-aware op. `run` strips the evaluator-appended ctx (same probe as bakeRosetta/
 *  bakeTagless), extracts the run's RunContext, and hands it to the impl alongside the scheme
 *  args — so the impl can charge `runCtx.heapMeter` and read `runCtx.strict` without a holder. */
function bakeSequence(input: SequenceInput): SequenceSymbolDef {
  const impl = input.impl;
  const run = async (...args: unknown[]): Promise<unknown> => {
    let ctx: unknown = undefined;
    let schemeArgs = args;
    const last = args[args.length - 1];
    if (
      args.length > 0 &&
      last != null &&
      typeof last === "object" &&
      !(last instanceof AValue) &&
      !Array.isArray(last) &&
      ("env" in last || "currentInvocation" in last || "tap" in last || "signal" in last)
    ) {
      ctx = last;
      schemeArgs = args.slice(0, -1);
    }
    const runCtx = (ctx as { runCtx?: RunContext } | undefined)?.runCtx ?? CONSTANT_CTX;
    return await impl(schemeArgs, runCtx);
  };
  (run as { __withCtx?: boolean }).__withCtx = true;
  return { kind: "sequence", name: input.name, doc: input.doc, in: normalizeVector(input.contract.input), out: normalizeVector(input.contract.output), run };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. The three constructors (tagged-template → curry → generics)
// ─────────────────────────────────────────────────────────────────────────────
//
// The tagged template carries `name: human description`; it returns a GENERIC fn so
// TS infers the contract first, then checks the impl against the DECODED types. A
// wrong-typed impl is a COMPILE error — that inference is the load-bearing proof.

/** Native host fn over SCHEME VALUES (no ctx, no validation). The schemas are
 *  scheme-identity; the impl receives the terms. */
function native(tpl: TemplateStringsArray, ...sub: unknown[]) {
  const { name, doc } = parseNameDoc(tpl, sub);
  return <const I extends VectorSpec, const O extends VectorSpec>(
    contract: Contract<I, O>,
    impl: Impl<I, O>,
  ): NativeSymbolDef => bakeNative({ kind: "native", name, doc, contract, impl: impl as AnyFn });
}

/** Rosetta host fn in JS-LAND (decoded via the contract codecs). ctx-free for this step. */
function rosetta(tpl: TemplateStringsArray, ...sub: unknown[]) {
  const { name, doc } = parseNameDoc(tpl, sub);
  return <const I extends VectorSpec, const O extends VectorSpec>(
    contract: Contract<I, O>,
    impl: Impl<I, O>,
    opts?: BakeRuntimeOpts,
  ): RosettaSymbolDef => bakeRosetta({ kind: "rosetta", name, doc, contract, impl: impl as AnyFn }, opts);
}

/** Tagless host op — NO impl. Dispatches to the operand's own `arrival/tagless-final/<name>`
 *  term method (the per-A-entity declaration), threading the run ctx. The contract is the
 *  type/harvest surface; the behaviour lives on the terms. */
function tagless(tpl: TemplateStringsArray, ...sub: unknown[]) {
  const { name, doc } = parseNameDoc(tpl, sub);
  return <const I extends VectorSpec, const O extends VectorSpec>(
    contract: Contract<I, O>,
  ): TaglessSymbolDef => bakeTagless({ kind: "tagless", name, doc, contract });
}

/** Ctx-aware host op — the impl gets (schemeArgs, runCtx). For kernel-logic-bearing ops
 *  (heap-charge, run-strict) that aren't pure per-receiver dispatch. */
function sequence(tpl: TemplateStringsArray, ...sub: unknown[]) {
  const { name, doc } = parseNameDoc(tpl, sub);
  return <const I extends VectorSpec, const O extends VectorSpec>(
    contract: Contract<I, O>,
    impl: (args: unknown[], runCtx: RunContext) => unknown,
  ): SequenceSymbolDef => bakeSequence({ kind: "sequence", name, doc, contract, impl });
}

/** errors-as-doors — an OMITTED verb. No contract/impl, just the teaching reason. */
function notImplemented(tpl: TemplateStringsArray, ...sub: unknown[]): DoorSymbolDef {
  const { name, doc } = parseNameDoc(tpl, sub);
  return bakeDoor({ kind: "door", name, reason: doc ?? "" });
}

/** kernel KEYWORD — a special form made first-class. No contract/impl: the tagged
 *  template carries only `name: doc`; `lower()` binds `new Keyword(name)` and the
 *  evaluator dispatches `SPECIAL_FORMS[name]` on the resolved marker. */
function keyword(tpl: TemplateStringsArray, ...sub: unknown[]): KeywordSymbolDef {
  const { name, doc } = parseNameDoc(tpl, sub);
  return { kind: "keyword", name, doc };
}

/** The authored-extension symbol API. `import * as arrival from "./symbol.js"` →
 *  `arrival.symbol.native` + a `name: doc` template + `(contract, impl)`. */
export const symbol = { native, rosetta, tagless, sequence, notImplemented, keyword };

// ─────────────────────────────────────────────────────────────────────────────
// TYPE-LEVEL PROOFS — the load-bearing inference, checked by `pnpm typecheck`.
//
// These live HERE (not in *.test.ts) because both tsconfigs EXCLUDE `src/**/*.test.ts`
// — the test file's `@ts-expect-error` lines are NOT compiled by `pnpm typecheck`. The
// generic inference is the whole point of the API, so its proof must sit where tsc runs.
// Entirely type-level + a dead-code block: ZERO runtime cost, not exported, tree-shaken.
// ─────────────────────────────────────────────────────────────────────────────

type _Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type _Expect<T extends true> = T;

// native: an identity-schema tuple infers the impl arg as the SCHEME TERM.
type _NativeArgs = DecodedArgs<[typeof z.pair]>;
type _NativeArgsProof = _Expect<_Equal<_NativeArgs, [APair]>>;

// rosetta: a codec tuple infers the impl arg as the DECODED JS value.
type _RosettaArgs = DecodedArgs<[typeof z.string]>;
type _RosettaArgsProof = _Expect<_Equal<_RosettaArgs, [string]>>;

// the number family decodes to the codec's declared JS type.
type _NumArgs = DecodedArgs<[typeof z.number]>;
type _NumProof = _Expect<_Equal<_NumArgs, [number]>>;
type _BigIntArgs = DecodedArgs<[typeof z.bigint]>;
type _BigIntProof = _Expect<_Equal<_BigIntArgs, [bigint]>>;

// a 1-tuple output → a single decoded return.
type _SingleRet = DecodedReturn<[typeof z.number]>;
type _SingleRetProof = _Expect<_Equal<_SingleRet, number>>;

// variadic: z.array input → the element-array as the impl's rest params.
type _VariadicArgs = DecodedArgs<ReturnType<typeof z.array<typeof z.number>>>;
type _VariadicProof = _Expect<_Equal<_VariadicArgs, number[]>>;

// Exercise the negative direction: a wrong-typed impl must be a COMPILE error. Guarded
// by a `false` const so it never runs; each `@ts-expect-error` asserts the line below
// it does NOT typecheck.
const __RUN_TYPE_PROOFS__ = false;
function __typeProofs__(): void {
  if (__RUN_TYPE_PROOFS__) {
    // native: impl receives a Pair (identity), not a string.
    symbol.native`p: proof`(
      { input: [z.pair], output: [z.pair] },
      // @ts-expect-error — arg is Pair, annotating it string is wrong
      (p: string) => p as unknown as APair,
    );
    // rosetta: impl receives a decoded string, not a Pair.
    symbol.rosetta`r: proof`(
      { input: [z.string], output: [z.number] },
      // @ts-expect-error — arg is string, annotating it Pair is wrong
      (s: APair) => 1,
    );
    // rosetta return: output codec wants number; returning a string is wrong.
    symbol.rosetta`rr: proof`(
      { input: [z.string], output: [z.number] },
      // @ts-expect-error — return must be number, not string
      (s) => s,
    );
  }
}

// Keep the proof aliases "used" so noUnusedLocals (if ever on) stays quiet; type-only.
void __typeProofs__;
export type __SymbolTypeProofs = [
  _NativeArgsProof,
  _RosettaArgsProof,
  _NumProof,
  _BigIntProof,
  _SingleRetProof,
  _VariadicProof,
];
