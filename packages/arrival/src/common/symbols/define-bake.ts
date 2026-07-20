// define-bake — the BAKE-TIME machinery `symbol.define`/`symbol.defineSyntax` need but
// cannot run at factory-call time: body parse + span-location, the FV locality law +
// eager-forward-reference check, derived-role classification, and the actual
// evaluate-then-bind step (two-phase, sequential-RHS binding — the full contract is below,
// at `bindCapabilityDefines`). Invoked from `../capability.ts`'s apply() Pass 2, once phase
// 1 (every non-define kind) has already bound.
//
// Kept OUT of `../capability.ts` itself: this pulls in the reader, `provenance/lineage.ts`'s
// classifier, `provenance/prelude.ts`'s fixpoint, and the callable-invocation primitives
// (`eval/call-function.ts`, `eval/Macro.ts`) — a real amount of machinery capability.ts
// doesn't otherwise touch. None of these import `common/capability.ts` back,
// so the edge is one-directional; `CapabilityLike`/`ExportableSpec` below are LOCAL
// structural types (not imported from capability.ts) so this file never has to import
// the class it's invoked from at all — capability.ts's real `EnvCapability`/`CapabilitySpec`
// satisfy them structurally.

import invariant from "tiny-invariant";
import { ZodError } from "zod";
import * as z from "../scheme-zod.js";
import { formatPositionalRejection } from "./positional-rejection.js";
import { parse as readerParse } from "../../reader/parse.js";
import { freeVars } from "../../provenance/wireframe/free-vars.js";
import type { Classifier, DeclaredRole } from "../../provenance/lineage.js";
import { classifyProgramPrelude } from "../../provenance/prelude.js";
import { DefineForwardReferenceError, DefineLocalityError, ProvenanceRoleShapeError } from "../../errors.js";
import { APair } from "../../values/primitives/APair.js";
import { ASymbol } from "../../values/primitives/ASymbol.js";
import { nil } from "../../values/primitives/ANil.js";
import { CONSTANT_CTX } from "../../run/RunContext.js";
import { ANativeProcedure, type ACallable } from "../../values/primitives/ACallable.js";
import { call_function } from "../../eval/call-function.js";
import { Macro, type MacroInvokeContext } from "../../eval/Macro.js";
import type { SchemeValue } from "../../values/types.js";
import type { EvalSchemeInto, ResolverSpec, SchemeEnv } from "../scheme-env.js";
import type { PreludeBindTarget } from "../kernel.js";
import type { AEntity, DefineSymbolDef, DefineSyntaxSymbolDef, ProvenanceRole } from "./_bake.js";

// ─────────────────────────────────────────────────────────────────────────────
// Local structural types — no import of `../capability.js` (would be a type-only
// cycle; harmless in itself, but unnecessary — everything here is satisfiable
// structurally by the real `EnvCapability`/`CapabilitySpec`).
// ─────────────────────────────────────────────────────────────────────────────

/** The slice of `EnvCapability` the allowlist/exports walk needs: identity, its DAG
 *  edges, its declared resolvers, and its memoized `exports()`. */
export interface CapabilityLike {
  readonly name: string;
  readonly spec: {
    readonly deps?: readonly CapabilityLike[];
    readonly resolvers?: readonly ResolverSpec[];
  };
  exports(): Promise<ReadonlySet<string>>;
}

/** The slice of `CapabilitySpec` the `exports` computation (below) needs. */
export interface ExportableSpec {
  readonly symbols?: unknown; // a plain record is statically enumerable; a builder fn is not (a LIMIT)
  readonly symbolPrefix?: string;
  readonly prelude?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// The KEYWORD_SYNTAX baseline — core's keyword-bound names, UNCONDITIONAL: every
// `SPECIAL_FORMS` entry (`eval/evaluator.ts`) is ALSO bound as a `symbol.keyword` value
// in `env/core/core.ts`, so as long as the FV walker's own unmodeled-head gap
// (`while`/`try`/`define-macro` — `free-vars.ts`'s documented default-arm fallthrough)
// needs a name in scope, it is one of these 20 — the SAME set `env/core/core.ts`'s
// `symbols` record declares. Hardcoded here (not derived by walking for a `scheme/core`
// dep) because "no program can run without them" — assembled mode roots `core`
// universally regardless of a particular capability's OWN declared `deps`, so gating on
// dep-declaration would under-allow a define using `if`/`cond`/`let` merely because THIS
// capability happens not to list `scheme/core` as a dep (most don't; they get it for free
// through env-roots' universal rooting).
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// The resolver-synth family — `SPECIAL_FORMS ∪ exports ∪ RESOLVER-SYNTH FAMILY
// (car/cdr/...)`. `car`/`cdr` (and the whole `c[ad]+r` family) are NOT a
// capability-declared export anywhere (`env/r7rs/lists.ts`'s own header: "served by
// a resolver, not this pack") — they're synthesized by a KERNEL-level fallback
// (`eval/Resolver.ts`'s `cxrUnfold`), consulted only AFTER an ordinary env-lookup
// miss, ABOVE any capability's own resolvers. No `ResolverSpec` anywhere registers
// this family, so `resolverAnswers`'s pure-resolver probe (below) can never see it —
// it must be recognized DIRECTLY, the same way `static-validation/vocabulary.ts`
// (`CXR_RE`) and `eval/Resolver.ts` (`CXR_RE`) already do. Local copy of the SAME
// regex, per the local-copy convention both of those files document (re-derived,
// not imported — see vocabulary.ts's own comment on why).
// ─────────────────────────────────────────────────────────────────────────────
const CXR_RE = /^c[ad]+r$/;

export const KEYWORD_SYNTAX_BASELINE: ReadonlySet<string> = new Set([
  "lambda",
  "define",
  "define-macro",
  "let",
  "let*",
  "letrec",
  "letrec*",
  "and",
  "or",
  "if",
  "begin",
  "quote",
  "quasiquote",
  "cond",
  "case",
  "when",
  "unless",
  "do",
  "while",
  "try",
]);

// ─────────────────────────────────────────────────────────────────────────────
// Parse + span-locate, memoized per def OBJECT (module-level capability constants mean N
// assemblies parse once; a builder-form capability that mints a fresh def per activation
// simply never hits the cache, an honest LIMIT).
// ─────────────────────────────────────────────────────────────────────────────
const parseCache = new WeakMap<DefineSymbolDef | DefineSyntaxSymbolDef, SchemeValue>();

/** Parse a define's body (the reader is called with `source = "«capability»#«name»"` so
 *  every Pair in the body is located, and a declaration-site error names
 *  `scheme/srfi-1#fold-right:3:8` instead of an anonymous blob). Body must parse to
 *  EXACTLY one top-level form ("the body is the RHS EXPRESSION, not a whole define
 *  form") — a malformed declaration (0 or 2+ forms) is an authoring bug, not a runtime
 *  condition, so this fails loud via `invariant`. */
export async function parseDefineBody(
  capabilityName: string,
  def: DefineSymbolDef | DefineSyntaxSymbolDef,
): Promise<SchemeValue> {
  const cached = parseCache.get(def);
  if (cached !== undefined) return cached;
  const forms = await readerParse(def.body, `${capabilityName}#${def.name}`);
  invariant(
    forms.length === 1,
    `symbol.${def.kind} "${def.name}" @ ${capabilityName}: body must parse to exactly ONE expression (the RHS), got ${forms.length}`,
  );
  const form = forms[0];
  parseCache.set(def, form);
  return form;
}

// ─────────────────────────────────────────────────────────────────────────────
// Small duck-typed local helpers — the SAME "own tiny Pair/Symbol walker per file"
// convention `slice.ts`/`prelude.ts`/`free-vars.ts` each already follow (none of
// their private helpers are exported across the module boundary).
// ─────────────────────────────────────────────────────────────────────────────

/** Is `body`'s top-level form `(lambda …)`? A lambda RHS late-binds — a forward
 *  reference inside it resolves at CALL time, never at bake. */
function isLambdaForm(body: unknown): boolean {
  return body instanceof APair && body.car instanceof ASymbol && body.car.__name__ === "lambda";
}

/** The elements of a macro-call argument chain (`code` in `Macro.invoke`'s terms) —
 *  UNEVALUATED forms, fexpr-style. Bounded by program size (a macro call's own
 *  argument list), so no heap-metering concern (mirrors `free-vars.ts`'s `chainOf`). */
function formsOf(code: unknown): SchemeValue[] {
  const out: SchemeValue[] = [];
  let cur: unknown = code;
  while (cur instanceof APair) {
    out.push(cur.car);
    cur = cur.cdr;
  }
  return out;
}

/** Synthesize the shape `classifyProgramPrelude` (`provenance/prelude.ts`) expects
 *  (it extracts name+body from a REAL top-level define form; a `symbol.define`'s
 *  own body is just the RHS). `name` here is the BOUND verb (prefixed, if the
 *  capability declares `symbolPrefix`) — matching what a SIBLING define's body
 *  actually calls at runtime through the shared env, so the fixpoint's reference
 *  closure (`referencedSymbols`, over the WHOLE synthesized form including `name`
 *  itself) lines up with real call sites.
 *
 *  TWO shapes, matching `defineBodyOf`'s (prelude.ts) own two arms — NOT a uniform
 *  `(define name body)`: a callable's `body` IS `(lambda formals …)`, and
 *  `classify()`'s OWN "lambda" arm returns a bare `{kind:"literal"}` for a lambda
 *  VALUE ("the body's lineage is realised only when applied") — synthesizing the
 *  value-shape `(define name (lambda …))` would make EVERY procedure define look
 *  port-free by construction, the classifier never descending into it. Reconstruct
 *  the FUNCTION shape instead (`(define (name . formals) . bodyForms)`) so
 *  `defineBodyOf`'s function arm strips the lambda wrapper and classifies the
 *  LAMBDA'S OWN last body form (`lastOf`) — exactly how an ordinary prelude-authored
 *  `(define (f args) body…)` already classifies today. A non-lambda body (a
 *  constant) keeps the plain `(define name value)` shape unchanged.
 *
 *  CONSTANT_CTX here is a verified STRUCTURAL SENTINEL, not a dropped run ctx: the
 *  synthesized form is genuinely PRE-RUN bake work — fed only to
 *  `classifyProgramPrelude`/`freeVars` (structural walks with zero `.ctx` reads) and
 *  discarded after classification. It never enters a run, so there is no meter to
 *  charge and no identity to carry. */
function synthesizeDefine(name: string, body: SchemeValue): SchemeValue {
  const nameSym = new ASymbol(CONSTANT_CTX, name);
  if (
    body instanceof APair &&
    body.car instanceof ASymbol &&
    body.car.__name__ === "lambda" &&
    body.cdr instanceof APair
  ) {
    const formals = body.cdr.car;
    const bodyForms = body.cdr.cdr;
    return new APair(
      CONSTANT_CTX,
      new ASymbol(CONSTANT_CTX, "define"),
      new APair(CONSTANT_CTX, new APair(CONSTANT_CTX, nameSym, formals), bodyForms),
    );
  }
  return new APair(
    CONSTANT_CTX,
    new ASymbol(CONSTANT_CTX, "define"),
    new APair(CONSTANT_CTX, nameSym, new APair(CONSTANT_CTX, body, nil)),
  );
}

/** Every `EnvCapability` reachable from `roots` (deduped by identity — a diamond dep
 *  graph must not double-walk a shared dep), roots FIRST — mirrors `capability.ts`'s
 *  own `collectPrelude` DAG walk. */
function transitiveDeps(roots: readonly CapabilityLike[]): CapabilityLike[] {
  const seen = new Set<CapabilityLike>();
  const out: CapabilityLike[] = [];
  const visit = (cap: CapabilityLike): void => {
    if (seen.has(cap)) return;
    seen.add(cap);
    out.push(cap);
    for (const dep of cap.spec.deps ?? []) visit(dep);
  };
  for (const r of roots) visit(r);
  return out;
}

/** The resolver-synth family probe: does some PURE resolver in `deps` (+ the
 *  capability's OWN `ownResolvers`) answer `name`? A resolver's `resolve` may throw
 *  on a name it doesn't recognize (the `c[ad]+r` family's own teaching door) — that
 *  is "did not answer" for this probe's purpose, not a bake-time failure. Only `pure`
 *  resolvers license the allowlist — a `pure: true` declaration promises NAME-STABLE
 *  results, the SAME license `ResolverSpec.pure`'s own doc grants for chain memoization
 *  (scheme-env.ts): an impure resolver might answer differently tomorrow, so it cannot
 *  retroactively justify a bake-time pass. */
function resolverAnswers(
  name: string,
  deps: readonly CapabilityLike[],
  ownResolvers: readonly ResolverSpec[],
): boolean {
  const resolvers = [...ownResolvers, ...transitiveDeps(deps).flatMap((d) => d.spec.resolvers ?? [])];
  for (const r of resolvers) {
    if (r.pure !== true) continue;
    try {
      if (r.resolve(name) !== undefined) return true;
    } catch {
      // did not answer — see doc above.
    }
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// `EnvCapability.exports()` — the interim, prelude-parsing arm.
// ─────────────────────────────────────────────────────────────────────────────

const DEFINE_HEADS = new Set(["define", "define-macro", "define-syntax"]);

/** Top-level `define`/`define-macro`/`define-syntax` names in `source` —
 *  `macroAwareDefineNames` closes a gap `extractDefines`/`defineNameOf` both have
 *  (they match ONLY the literal `define` head) but applied as a NEW, narrowly-scoped
 *  walker here rather than widening those two studio/provenance-facing functions,
 *  which have their own established consumers and contracts. */
export async function macroAwareDefineNames(source: string): Promise<ReadonlySet<string>> {
  const forms = await readerParse(source);
  const names = new Set<string>();
  for (const form of forms) {
    const name = defineHeadNameOf(form);
    if (name !== null) names.add(name);
  }
  return names;
}

function defineHeadNameOf(form: unknown): string | null {
  if (!(form instanceof APair) || !(form.car instanceof ASymbol)) return null;
  const head = form.car.__name__;
  if (typeof head !== "string" || !DEFINE_HEADS.has(head)) return null;
  if (!(form.cdr instanceof APair)) return null;
  const target = form.cdr.car;
  if (target instanceof APair && target.car instanceof ASymbol) {
    // (define (name args…) …) / (define-macro (name . args) …)
    return typeof target.car.__name__ === "string" ? target.car.__name__ : null;
  }
  if (target instanceof ASymbol) {
    // (define name value) / (define-syntax name (syntax-rules …))
    return typeof target.__name__ === "string" ? target.__name__ : null;
  }
  return null;
}

/** `EnvCapability.exports`: prefixed `spec.symbols` keys (builder-form is not
 *  statically enumerable — LIMIT, contributes nothing here) ∪ macro-aware define
 *  names parsed from `spec.prelude` (the migration-interim arm; shrinks toward nothing
 *  as capabilities move their `prelude` text blob to declared `symbol.define`s, pack
 *  by pack). Async + memoized by the CALLER (`EnvCapability.exports()` itself) —
 *  parsing is inherently async, so this can never be a real synchronous getter. */
export async function computeCapabilityExports(spec: ExportableSpec): Promise<ReadonlySet<string>> {
  const names = new Set<string>();
  const prefix = spec.symbolPrefix ?? "";
  if (typeof spec.symbols !== "function") {
    for (const key of Object.keys((spec.symbols as Record<string, unknown> | undefined) ?? {})) names.add(prefix + key);
  }
  if (spec.prelude !== undefined) {
    for (const n of await macroAwareDefineNames(spec.prelude)) names.add(n);
  }
  return names;
}

// ─────────────────────────────────────────────────────────────────────────────
// The evaluate-then-bind step. One capability-scoped temp binding per
// define, through the SAME injected `evalScheme` prelude eval already uses (never
// a direct `eval/generator-exec.ts` import here — that would both violate
// `common/scheme-env.ts`'s "the evaluator is INJECTED" boundary AND risk a real
// import cycle back through env/base-packs.ts). `(define tmp bodyString)` evaluated
// against `scope` binds `tmp` there as an ordinary side effect (exactly how a
// prelude's OWN defines land today); reading it back via `scope.get(tmp)` recovers
// the BOXED scheme value `evalScheme`'s string-only, toJS-unwrapping return type
// cannot give us directly. The temp name is discarded (never bound at `verb`) —
// only the REAL define's contract-wrapped (or, for a constant, bare) value lands
// at `verb`, via `bindTarget`.
// ─────────────────────────────────────────────────────────────────────────────
let tempCounter = 0;

async function evaluateBody(
  scope: SchemeEnv,
  evalScheme: EvalSchemeInto<SchemeEnv>,
  bodyString: string,
): Promise<unknown> {
  const tempName = `%%arrival-define-tmp%%${tempCounter++}`;
  await evalScheme(scope, `(define ${tempName} ${bodyString})`);
  return scope.get(tempName);
}

// RUNCTX SHARING — why sibling lambda-form defines batch: threading the caller's
// real `runCtx` through `call_function` (above) is necessary but not sufficient for a
// `WeakMap<RunContext, …>`-keyed dynamic-extent slot to survive a `symbol.define`→
// `symbol.define` call — because `evalLambda`'s runner (evaluator.ts) ALWAYS evaluates a
// lambda's body against its DEFINITION-TIME `ctx.runCtx`, never the call-time one
// (call-time runCtx threading is a separate, later concern). Every `evalScheme` call
// mints a FRESH `RunContext` (`generator-exec.ts`'s `exec()` → `makeRunContext()`) — so
// evaluating N sibling `symbol.define` bodies through N SEPARATE `evalScheme` calls (one
// `evaluateBody` call each) bakes N SIBLING ALambdas each closed over a DIFFERENT
// RunContext identity, permanently unable to share a WeakMap-keyed slot with each other
// (e.g. `with-exception-handler` and `raise-continuable`, both `scheme/r7rs/exceptions`
// own defines) — a capability's prelude, evaluated as one whole TEXT BLOB in a single
// `evalScheme` call, never had this problem: every define it contained shared one
// bake-time RunContext by construction, and per-define declaration must preserve that.
//
// Fix, scoped to LAMBDA-form entries only: batch every lambda-form body's `(define
// tmp body)` into ONE combined program, evaluated in ONE `evalScheme` call — this
// restores the shared-identity property for exactly the entries where it matters
// (a lambda VALUE is what closes over `ctx.runCtx`). This is SAFE precisely because
// minting a lambda VALUE never touches its BODY — "a forward reference inside it
// resolves at CALL time" (`isLambdaForm`'s note above) — so batching changes nothing
// about WHEN a lambda's free variables resolve (still call-time, against whatever the
// capability's `scope`/`env` looks like by then, fully bound), only WHEN the inert
// closure itself is minted. A NON-lambda (eager) entry is the opposite: its value IS its
// evaluation, so an eager RHS referencing an EARLIER sibling's REAL bound name
// (`srfi-235`'s `always`, whose body is the bare identifier `constantly`, declared just
// before it) needs that sibling ALREADY bound via `bindTarget` — batching eager entries
// together breaks exactly this case (`Unbound variable 'constantly'`), so eager entries
// are deliberately EXCLUDED from this batch and keep the original per-entry
// evaluate-THEN-bindTarget interleaving (`evaluateBody` above), sequential in
// declaration order.
async function evaluateBodies(
  scope: SchemeEnv,
  evalScheme: EvalSchemeInto<SchemeEnv>,
  bodyStrings: readonly string[],
): Promise<unknown[]> {
  const tempNames = bodyStrings.map(() => `%%arrival-define-tmp%%${tempCounter++}`);
  const combinedSource = bodyStrings.map((body, i) => `(define ${tempNames[i]} ${body})`).join("\n");
  await evalScheme(scope, combinedSource);
  return tempNames.map((tempName) => scope.get(tempName));
}

/** The scheme-face validating wrapper: `z.decode` against the normalized
 *  input/output vectors runs PURELY for its throw-on-mismatch side effect — the
 *  decoded value is discarded, and the ORIGINAL scheme args/return flow through
 *  unchanged (the same face `symbol.native` types, "nothing crosses the
 *  membrane" — a scheme body never sees a decoded JS value). `validate: false`
 *  (the same cost valve `BakeRuntimeOpts` gives rosetta) skips both checks. */
function buildDefineProcedure(verb: string, def: DefineSymbolDef, closureValue: unknown): ANativeProcedure {
  const closure = closureValue as ACallable;
  return new ANativeProcedure({
    name: verb,
    // Arity is introspection-only in this cut, same convention every OTHER kind's
    // bind arm uses (native/sequence/tagless/rosetta all bind `{min:0, max:null}`
    // here too) — tighten from `def.in` when the MCP/type-lens surface consumes it.
    arity: { min: 0, max: null },
    contract: def,
    // `ANativeProcedure["arrival/tagless-final/apply"]` invokes `impl(args, runCtx)` —
    // the CALLER's real per-call `RunContext`, never `CONSTANT_CTX`. `impl`'s second
    // parameter must reach `call_function`'s `{ runCtx }` option below, or the call
    // silently re-defaults to `CONSTANT_CTX`. Threading `runCtx` through honestly here
    // is necessary but NOT sufficient on its own: `evalLambda`'s runner (evaluator.ts)
    // evaluates a lambda's BODY against its DEFINITION-TIME `ctx.runCtx`, not the
    // call-time one handed to its apply term (call-time runCtx threading is a separate,
    // later concern) — so this only matters once the closure's OWN definition-time
    // `ctx.runCtx` is itself consistent across sibling `symbol.define` bodies. See
    // `evaluateBodies`'s comment (this file, above) for that half of the fix.
    impl: (rawArgs, runCtx) => {
      // SPINE ADOPTION runs BEFORE validation — the chart is chosen, THEN the gate judges it.
      //
      // The order is load-bearing, not incidental. A slot declared `z.pair` means "a non-empty
      // spine"; a borrowed JS array READ AS A SPINE satisfies that, but only once it has been
      // projected. Validate first and `z.pair` rejects the raw array before adoption can ever run —
      // which is exactly how `(last (some-tool …))` died, on a ZodError, for a list it could have
      // walked perfectly. Adopt first and the gate sees the value the body will actually get, so it
      // judges the truth: a non-empty array passes `z.pair`, and an EMPTY one adopts to `nil` and is
      // correctly rejected ("last: requires a non-empty list").
      //
      // And note adoption is NOT the decode below. `z.decode` is the PLANE crossing (scheme → JS),
      // and its result is discarded here ON PURPOSE: a scheme body must never receive a
      // JS-marshalled value. That is why the first attempt at this fix — making the list schema a
      // `z.codec` that materialized an APair chain — was dead code: it eagerly copied every tool
      // array and threw the copy away, while the raw array sailed on to the body and hung it.
      // Adoption is a REPRESENTATION choice on the SCHEME plane: AValue in, AValue out, O(1), same
      // backing store. Nothing crosses out.
      const args = def.adoptArgs === undefined ? rawArgs : (def.adoptArgs(rawArgs) as typeof rawArgs);
      // A rejection is a DOOR on every boundary. A raw `ZodError` here is unactionable —
      // Zod v4's `ZodError.message` is the pretty-printed JSON of `.issues`, naming no verb,
      // argument, or value. `symbol.define` is every R7RS/SRFI builtin (`count`, `some`,
      // `last`, `filter`, …), so the whole stdlib surface routes rejections through the SAME
      // positional humanizer the tool-call surface uses — `formatPositionalRejection`, which
      // owns the grammar and the motivating corpus incident.
      if (def.validate) {
        try {
          z.decode(def.in, args);
        } catch (e) {
          if (e instanceof ZodError) throw new Error(formatPositionalRejection(def.name, e, args, def.in));
          throw e;
        }
      }
      return (async (): Promise<SchemeValue> => {
        // `unknown`, not `SchemeValue`, until validated below: the multi-value arm
        // needs to read it as an array, which `SchemeValue` doesn't overlap directly
        // (mirrors `rosetta.ts`'s own `result` — the raw awaited callable return).
        // `call_function`'s declared return type is bare `SchemeValue` (its own
        // `resolve_promises` helper's annotation, even though it may hand back a
        // real Promise at runtime — `env/r7rs/lists.ts`'s callers rely on exactly
        // that) — `Promise.resolve(...)` makes the awaited expression honestly
        // Thenable either way, settled or already a value.
        const result: unknown = await Promise.resolve(
          call_function(closure, args as SchemeValue[], { runCtx }),
        );
        if (def.validate) {
          const resultVector: readonly unknown[] = def.singleOut ? [result] : (result as readonly unknown[]);
          z.decode(def.out, resultVector);
        }
        return result as SchemeValue;
      })();
    },
  });
}

/** Wind an evaluated `(lambda (formals expr . body) …)` closure into a `Macro`
 *  fexpr transformer — define-syntax binds through the same door define-macro's
 *  evaluation takes. The transformer receives the UNEVALUATED
 *  call-site argument forms (fexpr semantics) and applies the closure to them
 *  through the ordinary callable seam (`call_function` — lexical scoping, the
 *  closure's OWN captured definition-time scope, not the use site's `this=env`). */
function buildMacro(verb: string, def: DefineSyntaxSymbolDef, closureValue: unknown): Macro {
  const closure = closureValue as ACallable;
  const macro = new Macro(
    verb,
    function (this: unknown, code: unknown, evalArgs: MacroInvokeContext): Promise<SchemeValue> {
      const argForms = formsOf(code);
      // `evalArgs.runCtx` is REQUIRED on `MacroInvokeContext` (the Wave-3 macro-engine
      // plumb, the CONSTANT_CTX audit §4): the
      // evaluator's is_macro dispatch — the only builder of this context — always threads
      // its live `EvalContext.runCtx`. A define-syntax fexpr body therefore runs with the
      // INVOKING run's real context (its meter, cache, signal), whether that run is a
      // user exec or the bake-time `evalScheme` exec (which mints a real RunContext too).
      return Promise.resolve(
        call_function(closure, argForms, { runCtx: evalArgs.runCtx }),
      ) as Promise<SchemeValue>;
    },
    def.doc,
  );
  // Carry the DECLARED ternary walk attribute onto the bound value — the one channel a
  // validator's assembled-mode vocabulary can read it back from.
  macro.macroAttribute = def.macroAttribute;
  return macro;
}

// ─────────────────────────────────────────────────────────────────────────────
// The orchestration entry — capability.ts's apply() Pass 2 calls this once, after
// every non-define kind (Pass 1) has bound.
// ─────────────────────────────────────────────────────────────────────────────

export interface BindCapabilityDefinesArgs {
  readonly capabilityName: string;
  /** Every verb (prefixed) this capability's OWN `symbolsRec` declares — phase 1
   *  (already bound in `env`) AND phase 2 (this call's `entries`) — the letrec*
   *  NAME VISIBILITY set: every name in K is visible to every OTHER name in K for
   *  the FV check, regardless of textual/binding order. */
  readonly ownNames: ReadonlySet<string>;
  /** The `symbol.define`/`symbol.defineSyntax` entries, `[verb, def]`, in
   *  DECLARATION order (JS object-key insertion order). */
  readonly entries: readonly (readonly [string, DefineSymbolDef | DefineSyntaxSymbolDef])[];
  readonly deps: readonly CapabilityLike[];
  readonly ownResolvers: readonly ResolverSpec[];
  /** Where names OUTSIDE this capability's own define set resolve from — the
   *  classifier reads `.provenanceRole` off whatever is ALREADY bound here (phase 1
   *  + deps, thanks to two-phase order). */
  readonly env: SchemeEnv;
  /** Where a define's body evaluates — `ctx?.preludeEvalScope ?? env` (mirrors
   *  today's prelude eval target exactly). */
  readonly scope: SchemeEnv;
  readonly bindTarget: (def: AEntity) => PreludeBindTarget;
  readonly evalScheme?: EvalSchemeInto<SchemeEnv>;
}

export async function bindCapabilityDefines(args: BindCapabilityDefinesArgs): Promise<void> {
  const { capabilityName, ownNames, entries, deps, ownResolvers, env, scope, bindTarget } = args;
  if (entries.length === 0) return;
  invariant(
    args.evalScheme !== undefined,
    `capability "${capabilityName}" has symbol.define/symbol.defineSyntax declarations but no evalScheme was provided to lower()`,
  );
  const evalScheme = args.evalScheme;

  // Parse once per def (memoized).
  const parsedByDef = new Map<DefineSymbolDef | DefineSyntaxSymbolDef, SchemeValue>();
  for (const [, def] of entries) parsedByDef.set(def, await parseDefineBody(capabilityName, def));

  // The bake allowlist: SPECIAL_FORMS ∪ KEYWORD_SYNTAX ∪ ownNames(K) ∪ exports(deps).
  const allowlist = new Set<string>(KEYWORD_SYNTAX_BASELINE);
  for (const n of ownNames) allowlist.add(n);
  for (const dep of transitiveDeps(deps)) for (const n of await dep.exports()) allowlist.add(n);

  // FV law + eager-forward-reference check — `symbol.define` bodies only (a
  // `symbol.defineSyntax` body's "free variables" would name the EXPANSION env,
  // categorically out of scope here).
  const remaining = new Set(entries.map(([verb]) => verb));
  for (const [verb, def] of entries) {
    remaining.delete(verb); // "remaining" now = names declared strictly AFTER this one
    if (def.kind !== "define") continue;
    const body = parsedByDef.get(def)!;
    const free = freeVars(body);
    for (const name of free) {
      if (allowlist.has(name)) continue;
      if (CXR_RE.test(name)) continue; // resolver-synth family — see CXR_RE's comment above
      if (resolverAnswers(name, deps, ownResolvers)) continue;
      throw new DefineLocalityError(name, def.name, capabilityName);
    }
    if (!isLambdaForm(body)) {
      for (const name of free) {
        if (remaining.has(name)) throw new DefineForwardReferenceError(def.name, name, capabilityName);
      }
    }
  }

  // Derived provenance role: `classifyProgramPrelude`'s fixpoint, run over this
  // capability's OWN `symbol.define` set (verb-named synthetic forms so the
  // fixpoint's reference closure matches real call sites); the env-derived
  // classifier resolves everything OUTSIDE that set (phase 1 + deps, already bound).
  const defineEntries = entries.filter((e): e is readonly [string, DefineSymbolDef] => e[1].kind === "define");
  const classifier: Classifier = {
    roleOf: (op) =>
      (env.get(op, { throwError: false }) as { provenanceRole?: DeclaredRole } | undefined)?.provenanceRole,
  };
  const syntheticForms = defineEntries.map(([verb, def]) => synthesizeDefine(verb, parsedByDef.get(def)!));
  const membership = classifyProgramPrelude(syntheticForms, classifier);
  const derivedRoleByVerb = new Map<string, ProvenanceRole>();
  for (const [verb] of defineEntries) derivedRoleByVerb.set(verb, membership.wireframe.has(verb) ? "opaque" : "pipe");
  for (const [verb, def] of defineEntries) {
    const derived = derivedRoleByVerb.get(verb)!;
    if (def.declaredProvenance !== undefined && def.declaredProvenance !== derived) {
      throw new ProvenanceRoleShapeError(
        def.name,
        def.declaredProvenance,
        `derived (the capability-set fixpoint over "${capabilityName}"'s own symbol.define set) as ` +
          `"${derived}" — ${membership.reasons.get(verb) ?? "its body is fixpoint-closed (reaches no port, directly or transitively)"}`,
      );
    }
  }

  // Evaluate + bind, SEQUENTIALLY, in declaration order (each RHS sees only what
  // evaluated before it; a lambda body late-binds any forward reference).
  // Lambda-form entries are pre-evaluated as ONE batch (see `evaluateBodies`'s
  // comment: shares one bake-time RunContext across this capability's own lambda
  // defines) — safe because minting a lambda VALUE never touches its body,
  // regardless of relative declaration order. Eager (non-lambda) entries are
  // resolved lazily below, one `evaluateBody` call each, interleaved with
  // `bindTarget` exactly as before (an eager RHS may need an EARLIER sibling's
  // real bound name already in `scope`).
  const lambdaValueByDef = new Map<DefineSymbolDef | DefineSyntaxSymbolDef, unknown>();
  {
    const lambdaEntries = entries.filter(([, def]) => isLambdaForm(parsedByDef.get(def)!));
    const lambdaValues = await evaluateBodies(
      scope,
      evalScheme,
      lambdaEntries.map(([, def]) => def.body),
    );
    for (let i = 0; i < lambdaEntries.length; i++) lambdaValueByDef.set(lambdaEntries[i][1], lambdaValues[i]);
  }
  for (let i = 0; i < entries.length; i++) {
    const [verb, def] = entries[i];
    const value = lambdaValueByDef.has(def) ? lambdaValueByDef.get(def) : await evaluateBody(scope, evalScheme, def.body);
    if (def.kind === "define-syntax") {
      bindTarget(def).set(verb, buildMacro(verb, def, value));
      continue;
    }
    if (!def.callable) {
      if (def.validate) z.decode(def.out, [value]);
      bindTarget(def).set(verb, value);
      continue;
    }
    const proc = buildDefineProcedure(verb, def, value);
    (proc as { provenanceRole?: ProvenanceRole }).provenanceRole = derivedRoleByVerb.get(verb) ?? "pipe";
    bindTarget(def).set(verb, proc);
  }
}
