/**
 * Rosetta Environment Extension
 *
 * Extends LIPS Environment with automatic LIPS ↔ JS conversion for seamless interop.
 * Provides Environment.defineRosetta() for declarative function wrapping.
 *
 * Lineage: foreign-function-interface marshalling at the JS↔Scheme boundary. The
 * goal that `schemeToJs`/`jsToScheme` round-trip to identity in both directions is
 * the project's bifunctor framing — see the bifunctor-iso note in docs/ and
 * docs/working-proposals/confluent-dataflow-graph-ir-2026-06-17.md.
 */

import { AValue, EMPTY_PROVENANCE, pointProvenance, unionProvenance } from "./values/primitives/AValue.js";
import { fromJs } from "./values/primitives/boxing.js";
import { CONSTANT_CTX, type RunContext } from "./values/primitives/RunContext.js";
import { deepProvenance } from "./values/deep-provenance.js";
import { ABool } from "./values/primitives/ABool.js";
import { ABytevector } from "./values/primitives/ABytevector.js";
import { AVector } from "./values/primitives/AVector.js";
import { AJSArray } from "./values/primitives/AJSArray.js";
import { AJSObject } from "./values/primitives/AJSObject.js";
import { AExact } from "./values/primitives/AExact.js";
import { AInexact } from "./values/primitives/AInexact.js";
import { APair } from "./values/primitives/APair.js";
import { ANil, nil } from "./values/primitives/ANil.js";
import { theVoid } from "./values/primitives/AVoid.js";
import { ASymbol } from "./values/primitives/ASymbol.js";
import { LAMBDA } from "./well-known-symbols.js";

// Membrane warnings (warnMembrane / setMembraneWarnings) now live in the leaf `membrane-warn.ts`,
// shared with boxing.ts's `function` boxer — extracted so the value layer needn't import this
// evaluator-heavy module just to warn. A non-portable JS value (a function, `undefined`, or a
// UNIQUE symbol) crossing INTO Scheme has no faithful representation → it materializes to #void,
// and `warnMembrane` makes that interop edge VISIBLE (a silent #void would hide a portability bug).
import { warnMembrane } from "./membrane-warn.js";
import { ImplInvocationCtx } from "./common/symbols/_bake.js";

interface RosettaOptions {
  forceBigInt?: boolean;
  returnEither?: boolean;
  /**
   * When true, the wrapper attaches a `ctx.argProvenance` array — one entry per
   * scheme arg, in order — holding that arg's DEEP provenance set (the union of
   * every AValue reachable inside it: itself, Pair car/cdr spines, JS arrays).
   * A list constructed by `(list a b c)` carries NO provenance on its spine —
   * only the elements do — so a shallow `arg.provenance` read misses per-element
   * origins entirely; the deep walk is what makes packed-into-array values keep
   * their per-field provenance. Computed BEFORE schemeToJs strips the AValue
   * identity. The array rides on `ctx`; since the wrapper now always receives
   * ctx, `argProvenance: true` also routes ctx to
   * the FN (so it can read the array) — see `fnWantsCtx` in createRosettaWrapper.
   */
  argProvenance?: boolean;
}

type Fn = (...args: any[]) => any;

export interface RosettaFunction {
  fn: Fn;
  options?: RosettaOptions;
  /**
   * The rosetta's TS signature, as an ambient `.d.ts` member-body fragment — e.g.
   * `"(ip: SchemeIP): SBool"` or `"(): List<Connection>"`. INERT at runtime (this
   * module never reads it; `arrival-scheme` has no TS compiler). It is harvested
   * by the node-only type-lens, which assembles `interface ArrShape { "<name>":
   * <type> }` leaves from every registered rosetta's `type` — so the type knowledge
   * lives WITH the rosetta (colocated with `fn`), not in a parallel `.d.ts` that
   * drifts. Same trust model as the builtin leaves: a faithful AUTHOR ASSERTION
   * over the `any` impl, checkable by eye, not mechanically derived from `fn`.
   * Base types (`List`, `SNum`, `SBool`, `SStr`, `Dict`) come from the lens prelude;
   * host entity types (`SchemeIP`, row shapes) come from the env's type-preamble.
   */
  type?: string;
  /**
   * Provenance role marker. By default a registered rosetta is a Rosetta-IN
   * SOURCE: it introduces external data, so its result MINTS a fresh provenance
   * leaf (the conservative default — never silently lose an origin). Set `pure:
   * true` to declare instead that the fn only TRANSFORMS its arguments (like
   * `string-append` / `dedent`): its result PROPAGATES the inputs' provenance —
   * a pipe/merge, not a source. Same trust model as `type` and the discovery/action
   * split: an author assertion over the `any` impl, not mechanically verifiable (JS
   * purity is undecidable here). LIVE at runtime: it gates the provenance mint —
   * `mintsPoint = pure !== true` in createRosettaWrapper, so a non-pure rosetta mints
   * a fresh point and a pure one forwards its inputs' provenance. ALSO the static
   * cut: the lineage classifier keys `isRosettaIn === !pure` (see docs/working-
   * proposals/confluent-dataflow-graph-ir-2026-06-17.md §5). NOTE: `pure` conflates
   * no-mint + forwards + no-effect; control/declaration forms (expose/approval/…) are
   * effectful-but-not-data-sourcing — a third category that takes `pure: true` for the
   * no-mint behavior. A richer source/pure/effectful taxonomy is deferred.
   */
  pure?: boolean;
}

/**
 * Structural shape of EvalContext.currentInvocation that this module relies
 * on. The full Invocation type lives in arrival-chain/trace.ts (and the
 * evaluator treats it as `unknown`); we duck-type here to avoid pulling in
 * a circular dependency. Exported so the symbol API (common/symbol.ts) reuses
 * the SAME duck-typed invocation shape for its provenance mint instead of
 * re-spelling the cast.
 */
export interface InvocationLike {
  id: number;
  isProvenancePoint?: boolean;
  /**
   * arrival-chain's Invocation provides this as a MobX action; a plain test POJO
   * doesn't. Preferred over a raw `isProvenancePoint` write so the flag flips
   * inside an action — MobX strict-mode (on in the studio) forbids the bare write.
   */
  markProvenancePoint?(): void;
  /**
   * Bind arbitrary node metadata (e.g. a `.prompt`'s file / model / inputs — the
   * card's display story), called directly by the rosetta fn at call time. Same
   * action-vs-POJO story as `markProvenancePoint`. The metadata is trace-side only
   * (read by the render) — it never crosses back into scheme.
   */
  setMetadata?(meta: unknown): void;
}

export interface CtxWithInvocation {
  currentInvocation?: InvocationLike;
}

const isLipsPair = (x: unknown): x is { car: unknown; cdr: unknown } =>
  x != null && typeof x === "object" && "car" in x && "cdr" in x;

export function schemeToJs(value: any, options: RosettaOptions = {}): any {
  // Handle null/undefined
  // `instanceof Nil` not `=== nil`: after the AValue refactor, `nil.withProvenance(p)`
  // mints fresh Nil clones (types.ts:87) — reference-equality misses them and would
  // leak the clone back into the JS caller. Mirrors guards.ts:is_nil (the Tier-1 fix
  // in 5f7f9e46a) which adopted the same class-based check.
  if (value == null || value instanceof ANil) return value;

  // Handle JS arrays (convert elements recursively)
  if (Array.isArray(value)) {
    return value.map((record) => schemeToJs(record, options));
  }

  // Boxed vector → raw JS array (elements converted recursively); boxed
  // bytevector → its raw Uint8Array. Without these, a boxed value leaks its
  // {kind,__vector__/__bytevector__,provenance} object shape to JS callers
  // (the MCP/trace serialization path). Mirrors the raw-array branch above and
  // the raw-Uint8Array fall-through.
  if (value instanceof AVector) {
    return value.__vector__.map((record) => schemeToJs(record, options));
  }
  if (value instanceof ABytevector) {
    return value.__bytevector__;
  }

  // Handle ExactNumber and InexactNumber
  if (value instanceof AExact) {
    const val = value.valueOf();
    if (options.forceBigInt) {
      return typeof val === "bigint" ? val : BigInt(Math.round(val as number));
    }
    // For exact integers, return number if safe
    if (value.denom === 1n) {
      if (value.num >= BigInt(Number.MIN_SAFE_INTEGER) && value.num <= BigInt(Number.MAX_SAFE_INTEGER)) {
        return Number(value.num);
      }
      return value.num; // Return bigint for large numbers
    }
    // For rationals, return the float value
    return val;
  }

  if (value instanceof AInexact) {
    // InexactNumber is always a JS float (reals-only — complex axis omitted).
    return value.real;
  }

  // Unwrap SchemeJSObject to source object
  if (value instanceof AJSObject) {
    return schemeToJs(value.source, options);
  }

  // Unwrap AJSArray to JS array
  if (value instanceof AJSArray) {
    return value.source.map((el: any) => schemeToJs(el, options));
  }

  // Unwrap SchemeBool to JS primitive
  if (value instanceof ABool) {
    return value.value;
  }

  // Handle SchemeString and Pair
  if (value && typeof value === "object") {
    if ("__string__" in value && typeof value.__string__ === "string") {
      return value.__string__;
    }
    // since for lisp empty list and nil is same entity, we specifically handle this scenario as
    // "if eventually cdr is nil, and we're materializing the array, it's array tail"
    if (isLipsPair(value)) {
      const head = schemeToJs(value.car, options);
      const tail = schemeToJs(value.cdr, options) ?? [];
      if (Array.isArray(tail)) {
        return [head, ...tail];
      } else if (tail instanceof ANil) {
        // Class check, not `=== nil`: a provenance-bearing Nil clone (see Nil import note above)
        // must still terminate the list — otherwise the tail leaks as `[head, <Nil-clone>]`.
        return [head];
      } else {
        return [head, tail];
      }
    }
    if (Object.getPrototypeOf(value) === Object.getPrototypeOf({}) || Object.getPrototypeOf(value) === null) {
      // Deep-unwrap nested Scheme values while preserving ALL own keys. `Object.entries`
      // silently drops symbol-keyed properties — string keys are unchanged, but symbol
      // slots (opaque/private backing data on objects crossing the membrane) were lost on
      // the Lips→JS round-trip. Enumerate string keys then own symbols so both survive.
      const out: Record<string | symbol, unknown> = {};
      for (const key of Object.keys(value)) out[key] = schemeToJs((value as Record<string, unknown>)[key], options);
      for (const sym of Object.getOwnPropertySymbols(value)) {
        out[sym] = schemeToJs((value as Record<symbol, unknown>)[sym], options);
      }
      return out;
    }
    // Check for arrival sequence-op terms BEFORE converting to plain objects — a value
    // carrying its own map/filter/reduce is a structure to preserve, not deep-unwrap.
    if (
      value["arrival/tagless-final/map"] !== undefined ||
      value["arrival/tagless-final/filter"] !== undefined ||
      value["arrival/tagless-final/reduce"] !== undefined
    ) {
      // Preserve sequence-op terms as-is
      return value;
    }

    // todo traverse enumerable fields?
  }

  if (typeof value === "number" && options.forceBigInt) {
    return BigInt(value);
  }

  return value;
}

/**
 * JS → scheme deep-stamping membrane. Single pass: every AValue constructed
 * on the way down inherits the supplied `provenance` set, so downstream
 * extractors (`car`, `cdr`, `dict-ref`, `@`) see element-only lineage that
 * already carries the rosetta's origin id (spec §5.3 Interpretation A).
 *
 * War story: pre-deep-stamp, jsToScheme constructed a Pair-chain whose outer
 * Pair received provenance via `result.withProvenance(...)` at the wrapper,
 * but every spine cons + every leaf inside stayed empty. The Tier-1 audit's
 * car/cdr "element-only" landing (lips.ts:2162) — correct per spec — then
 * exposed this gap: `(car (infer …))` returned a SchemeString carrying nothing,
 * and the v0 chain `(string-append "h" greeting)` lost the upstream infer id.
 * Pushing the stamp INTO `jsToScheme` reaches every constructed value in one
 * pass; no per-builtin re-stamp; symmetric with the membrane discipline
 * already applied at the AValue.fromJs entry.
 *
 * Plain JS objects → `SchemeJSObject` (was raw passthrough — closes the
 * cross-package audit's "jsToScheme doesn't consult boxer registry" finding).
 * Their entries box lazily on `.get(key)` so the wrapper's cache amortises
 * the cost without paying the full traversal on construction.
 *
 * `seen: WeakSet` terminates cycles on the JS-input side. If the source has a
 * cycle, the inner reference is returned as-is — the caller's outer Pair (or
 * SchemeJSObject) already carries the provenance, and the cycle re-enters
 * that wrapper rather than allocating an infinite spine.
 */
export function jsToScheme(
  ctx: RunContext,
  value: any,
  options: RosettaOptions = {},
  provenance: ReadonlySet<number> = EMPTY_PROVENANCE,
  seen: WeakSet<object> = new WeakSet(),
): any {
  // null → nil. undefined → #void + warn: `undefined` has no portable Scheme value (the
  // interpreter is host-agnostic), so a borrowed `undefined` materializes to the unspecified
  // value, loudly. (Was: both collapsed to nil.)
  if (value === null) {
    return provenance === EMPTY_PROVENANCE ? nil : new ANil(ctx, provenance);
  }
  if (value === undefined) {
    warnMembrane("a JS `undefined`");
    return theVoid;
  }

  // Cycle in JS-side input — return as-is. The caller's outer wrapper already
  // carries the stamp; this prevents the recursion from looping forever.
  if (typeof value === "object" && seen.has(value)) return value;
  if (typeof value === "object") seen.add(value);

  // Already-AValue input. Same-provenance fast-path preserves identity; Pair
  // recurses so children share the new lineage; leaves go through wrapper-
  // level `withProvenance` (entries of SchemeJSObject stay lazy via `.get`).
  if (value instanceof AValue) {
    if (provenance === EMPTY_PROVENANCE || provenance === value.provenance) return value;
    if (value instanceof APair) {
      return new APair(ctx,
        jsToScheme(ctx, value.car, options, provenance, seen),
        jsToScheme(ctx, value.cdr, options, provenance, seen),
        provenance,
      );
    }
    if (value instanceof AVector) {
      // Deep-stamp elements (parallel to Pair), keep it a vector. The container
      // also carries the provenance via the constructor arg.
      return new AVector(ctx,
        value.__vector__.map((el) => jsToScheme(ctx, el, options, provenance, seen)),
        provenance,
      );
    }
    return value.withProvenance(provenance);
  }

  // JS array → borrowed VECTOR (a JS array IS an R7RS vector — the faithful Rosetta
  // mapping; the old array→list cons was LIPS-era data coercion, now dissolved). AJSArray
  // keeps the source reference and boxes its elements lazily through the membrane on access.
  if (Array.isArray(value)) {
    return new AJSArray(ctx, value, provenance);
  }

  // Plain JS object → SchemeJSObject (lazy entries via .get cache).
  if (
    typeof value === "object" &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  ) {
    return new AJSObject(ctx, value as object, provenance);
  }

  // JS primitives → the boxer registry (number/bigint→exact/inexact, boolean→ABool,
  // string→AString) — never raw, so the sandbox only ever holds boxed AValues.
  const tag = typeof value;
  if (tag === "string" || tag === "number" || tag === "boolean" || tag === "bigint") {
    return fromJs(ctx, value, provenance);
  }

  // A REGISTERED JS symbol (`Symbol.for('x')`) has a portable string key → the keyword `:x`.
  // A UNIQUE symbol (`Symbol('x')`) has no portable identity → #void + warn (like a function).
  if (tag === "symbol") {
    const key = Symbol.keyFor(value as symbol);
    if (key !== undefined) return new ASymbol(ctx, ":" + key, provenance);
    warnMembrane("a unique JS symbol");
    return theVoid;
  }

  // A Scheme LAMBDA is represented internally as a plain JS function carrying the well-known
  // LAMBDA brand (set by the evaluator on every closure it creates — see well-known-symbols.ts).
  // It is ALREADY a scheme value, not host data crossing the boundary, so it passes through
  // untouched — the same pass-through `membrane.ts`'s `isSchemeValue`/`fromJS` give it. Without
  // this check, a `require`d file resolving to `{ kind: "eval", forms }` (the `.hbs`/`.prompt`
  // CALLABLE RULE shape: a scheme lambda over a directly-bound native verb) gets VOIDED the moment
  // it flows back out through `require`'s own rosetta wrapper — which re-runs every return value
  // through `jsToScheme` — even though it was never a "borrowed JS callback" to begin with.
  if (tag === "function" && LAMBDA in value) {
    return value;
  }

  // A borrowed JS function is NOT a Scheme value (and exposing it as callable would let Scheme
  // escape the host-agnostic sandbox into uncontrolled JS) → #void + warn. The deliberate,
  // generalized narrowing of JS interop: borrowed functions are not portable. (Was raw.)
  if (tag === "function") {
    warnMembrane("a JS function");
    return theVoid;
  }

  // Exotic objects (Promise, Buffer, …): the caller's responsibility (unchanged).
  return value;
}

/**
 * Duck-type the evaluator-appended trailing arg as an EvalContext.
 *
 * The flip makes EVERY rosetta wrapper (so the evaluator always
 * appends ctx and `inv` is always reachable to mint), which means the wrapper
 * must ALWAYS strip a trailing ctx. But some tests call a wrapper DIRECTLY (no
 * evaluator → no ctx appended), passing a real scheme value as the last arg —
 * an unconditional strip would eat it. So we strip only if the trailing arg
 * LOOKS like a context.
 *
 * Why this is unambiguous: by the time a wrapper runs under the evaluator, the
 * scheme DATA args are already evaluated scheme values (AValue subclasses,
 * SchemeJSObject, raw arrays/primitives) — the genuine EvalContext is the only
 * raw plain object carrying `resolver`/`currentInvocation`/`tap`/`signal` that
 * ever reaches here. A scheme value is never an AValue-excluded plain object with
 * a `resolver` field. `currentInvocation`/`tap`/`signal` may be absent on a
 * minimal ctx, but `resolver` is set on every EvalContext the evaluator threads
 * (ejection P5 made it the sole binding channel, replacing the former required
 * `env` probe), so the `resolver` probe suffices; the others are kept as a
 * belt-and-braces OR for any future ctx shape.
 */
export const looksLikeEvalContext = (
  x: unknown,
): x is Record<string, unknown> & Partial<CtxWithInvocation> =>
  x != null &&
  typeof x === "object" &&
  !(x instanceof AValue) &&
  !Array.isArray(x) &&
  ("resolver" in x || "currentInvocation" in x || "tap" in x || "signal" in x);

export const createRosettaWrapper = ({ fn, options = {}, pure = false }: RosettaFunction) => {
  // A `pure: true` rosetta is classified as a PIPE — it propagates its inputs' provenance and mints
  // nothing — which is sound only if it does NOT mutate those inputs. That soundness is now ENFORCED
  // BY CONSTRUCTION: borrowed JS inputs (AJSObject/AJSArray) freeze their source on first read, so a
  // pure rosetta physically cannot mutate them — the old dev-only purity ASSERT is gone. (See
  // AJSArray/AJSObject `freezeSource` + the `freezeRosettaReturns` run-ctx opt-out.)
  // THE FLIP: a non-pure rosetta is a Rosetta-IN SOURCE — it mints a fresh point
  // by default (data is born at the membrane crossing); a `pure: true` rosetta is
  // a PIPE that forwards its inputs' provenance and mints nothing. This is already
  // the documented default + the static classifier's cut (`isRosettaIn === !pure`);
  // the runtime now honors it instead of the legacy `provenancePoint` opt-in.
  const mintsPoint = pure !== true;

  return async function rosettaWrapper(this: ImplInvocationCtx, ...schemeArgs: any[]) {
    // Collect provenance from AValue inputs BEFORE schemeToJs runs — that pass
    // unwraps SchemeString/SchemeBool/SchemeJSObject down to JS primitives
    // and records, stripping the AValue identity (and the provenance field
    // along with it). The union is computed against the original schemeArgs.
    const inputAValues = schemeArgs.filter((a): a is AValue => a instanceof AValue);
    const inputProvenance = unionProvenance(inputAValues);

    // Per-arg DEEP provenance (opt-in), aligned to schemeArgs, parked on ctx
    // BEFORE schemeToJs strips the AValue identity. The consumer fn reads it to
    // attribute each named input to its concrete producer (e.g. a `.prompt`
    // building `inputsProvenance[field]`), recovering per-field origins that the
    // union — and the post-strip plain-JS args — can no longer distinguish.
    if (options.argProvenance === true && this.ctx && typeof this.ctx === "object") {
      (this.ctx as { argProvenance?: ReadonlySet<number>[] }).argProvenance = schemeArgs.map(deepProvenance);
    }

    try {
      const rawResult = await fn.apply(
        { ctx: this.ctx },
        schemeArgs.map((arg) => schemeToJs(arg, options)),
      );

      const inv = (this.ctx as CtxWithInvocation | undefined)?.currentInvocation;

      // Decide the output provenance BEFORE jsToScheme so the deep-stamp pass
      // reaches every constructed AValue in one traversal (spec §5.3 — every
      // element returned by a rosetta carries its origin from the moment it
      // crosses the boundary, not after a separate `withProvenance` walk on
      // the top-level container). The mint overrides inputs.
      //
      // No invocation in ctx: silent. The rosetta is being called from a path the
      // tap doesn't reach (e.g., direct JS invocation in tests); there's no node to
      // mark, fall back to input provenance.
      //
      // Node metadata (the card's display story) is bound separately and directly
      // by the rosetta fn via `ctx.currentInvocation.setMetadata(…)` at call time —
      // it's known up front, so it doesn't ride the result back through here.
      let resultProvenance = inputProvenance;
      if (mintsPoint && inv && typeof inv.id === "number") {
        // The real Invocation is a MobX observable — flip the flag through its
        // own action so this is safe under strict-mode (the studio enables it).
        // A plain POJO (direct-JS tests) has no method → set it directly.
        if (typeof inv.markProvenancePoint === "function") inv.markProvenancePoint();
        else inv.isProvenancePoint = true;
        resultProvenance = pointProvenance(inv.id);
      }

      const result = jsToScheme(
        (this.ctx as { runCtx?: RunContext } | undefined)?.runCtx ?? CONSTANT_CTX,
        rawResult,
        options,
        resultProvenance,
      );
      return options.returnEither ? [result, nil] : result;
    } catch (error) {
      console.error("Rosetta function error:", error);
      if (options.returnEither) {
        return [nil, error];
      } else {
        throw error;
      }
    }
  };
};

declare module "@here.build/arrival" {
  interface Environment {
    defineRosetta(name: string, config: RosettaFunction): void;
  }
}
