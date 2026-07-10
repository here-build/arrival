// define-bake — the BAKE-TIME machinery `symbol.define`/`symbol.defineSyntax` need but
// cannot run at factory-call time (docs/working-proposals/symbol-define-static-program-
// validation.md §1/§2, wave W1): body parse + span-location (§1.3), the FV locality law
// + eager-forward-reference check (§2.1/§2.3), derived-role classification (§1.4), and
// the actual evaluate-then-bind step (§1.5/§2.3's two-phase, sequential-RHS binding).
// Invoked from `../capability.ts`'s apply() Pass 2, once phase 1 (every non-define kind)
// has already bound.
//
// Kept OUT of `../capability.ts` itself: this pulls in the reader, `values/lineage.ts`'s
// classifier, `provenance/prelude.ts`'s fixpoint, and the callable-invocation primitives
// (`eval/call-function.ts`, `eval/Macro.ts`) — a real amount of machinery capability.ts
// doesn't otherwise touch. None of these import `common/capability.ts` back (verified),
// so the edge is one-directional; `CapabilityLike`/`ExportableSpec` below are LOCAL
// structural types (not imported from capability.ts) so this file never has to import
// the class it's invoked from at all — capability.ts's real `EnvCapability`/`CapabilitySpec`
// satisfy them structurally.

import invariant from "tiny-invariant";
import * as z from "../scheme-zod.js";
import { parse as readerParse } from "../../reader/parse.js";
import { freeVars } from "../../provenance/wireframe/free-vars.js";
import type { Classifier, DeclaredRole } from "../../values/lineage.js";
import { classifyProgramPrelude } from "../../provenance/prelude.js";
import { DefineForwardReferenceError, DefineLocalityError, ProvenanceRoleShapeError } from "../../errors.js";
import { APair } from "../../values/primitives/APair.js";
import { ASymbol } from "../../values/primitives/ASymbol.js";
import { nil } from "../../values/primitives/ANil.js";
import { CONSTANT_CTX } from "../../values/primitives/RunContext.js";
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

/** The slice of `CapabilitySpec` the `exports` computation (below, §2.2) needs. */
export interface ExportableSpec {
  readonly symbols?: unknown; // a plain record is statically enumerable; a builder fn is not (§2.2 LIMIT)
  readonly symbolPrefix?: string;
  readonly prelude?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// §2.1's KEYWORD_SYNTAX baseline — core's keyword-bound names, UNCONDITIONAL
// (rev2 fix): every `SPECIAL_FORMS` entry (`eval/evaluator.ts`) is ALSO bound as a
// `symbol.keyword` value in `env/core/core.ts`, so as long as the FV walker's own
// unmodeled-head gap (`while`/`try`/`define-macro` — `free-vars.ts`'s documented
// default-arm fallthrough) needs a name in scope, it is one of these 20 — the SAME
// set `env/core/core.ts`'s `symbols` record declares. Hardcoded here (not derived
// by walking for a `scheme/core` dep) per the rev2 ruling: "no program can run
// without them" — assembled mode roots `core` universally regardless of a
// particular capability's OWN declared `deps`, so gating on dep-declaration would
// under-allow a define using `if`/`cond`/`let` merely because THIS capability
// happens not to list `scheme/core` as a dep (most don't; they get it for free
// through env-roots' universal rooting).
// ─────────────────────────────────────────────────────────────────────────────
const KEYWORD_SYNTAX_BASELINE: ReadonlySet<string> = new Set([
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
// §1.3 — parse + span-locate, memoized per def OBJECT (module-level capability
// constants mean N assemblies parse once; a builder-form capability that mints a
// fresh def per activation simply never hits the cache, an honest LIMIT — §1.3).
// ─────────────────────────────────────────────────────────────────────────────
const parseCache = new WeakMap<DefineSymbolDef | DefineSyntaxSymbolDef, SchemeValue>();

/** Parse a define's body (the reader is called with `source = "«capability»#«name»"` —
 *  §1.3 — so every Pair in the body is located, and a declaration-site error names
 *  `scheme/srfi-1#fold-right:3:8` instead of an anonymous blob). Body must parse to
 *  EXACTLY one top-level form (§1.1's "the body is the RHS EXPRESSION, not a whole
 *  define form") — a malformed declaration (0 or 2+ forms) is an authoring bug, not a
 *  runtime condition, so this fails loud via `invariant`. */
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

/** Is `body`'s top-level form `(lambda …)`? A lambda RHS late-binds (§2.3) — a
 *  forward reference inside it resolves at CALL time, never at bake. */
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
 *  constant) keeps the plain `(define name value)` shape unchanged. */
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

/** §2.1's resolver-synth family probe: does some PURE resolver in `deps` (+ the
 *  capability's OWN `ownResolvers`) answer `name`? A resolver's `resolve` may throw
 *  on a name it doesn't recognize (the `c[ad]+r` family's own teaching door) — that
 *  is "did not answer" for this probe's purpose, not a bake-time failure. Only
 *  `pure` resolvers license the allowlist (§3.5's "NAME-STABLE… licenses… to
 *  memoize" — the SAME license this probe needs: an impure resolver might answer
 *  differently tomorrow, so it cannot retroactively justify a bake-time pass). */
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
// §2.2 — `EnvCapability.exports()` (the interim, prelude-parsing arm).
// ─────────────────────────────────────────────────────────────────────────────

const DEFINE_HEADS = new Set(["define", "define-macro", "define-syntax"]);

/** Top-level `define`/`define-macro`/`define-syntax` names in `source` (§2.2's
 *  `macroAwareDefineNames` — the fix `extractDefines`/`defineNameOf` both need
 *  (they match ONLY the literal `define` head, per the design doc's verified
 *  citations) but applied as a NEW, narrowly-scoped walker here rather than
 *  widening those two studio/provenance-facing functions, which have their own
 *  established consumers and contracts). */
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

/** `EnvCapability.exports` (§2.2): prefixed `spec.symbols` keys (builder-form is not
 *  statically enumerable — LIMIT, contributes nothing here) ∪ macro-aware define
 *  names parsed from `spec.prelude` (the migration-interim arm; empties out as W4
 *  retires `prelude` pack by pack). Async + memoized by the CALLER (`EnvCapability
 *  .exports()` itself) — parsing is inherently async, so this can never be a real
 *  synchronous getter. */
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
// The evaluate-then-bind step (§1.5/§2.3). One capability-scoped temp binding per
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

/** The scheme-face validating wrapper (§1.2): `z.decode` against the normalized
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
    impl: (args) => {
      if (def.validate) z.decode(def.in, args);
      return (async (): Promise<SchemeValue> => {
        // `unknown`, not `SchemeValue`, until validated below: the multi-value arm
        // needs to read it as an array, which `SchemeValue` doesn't overlap directly
        // (mirrors `rosetta.ts`'s own `result` — the raw awaited callable return).
        // `call_function`'s declared return type is bare `SchemeValue` (its own
        // `resolve_promises` helper's annotation, even though it may hand back a
        // real Promise at runtime — `env/r7rs/lists.ts`'s callers rely on exactly
        // that) — `Promise.resolve(...)` makes the awaited expression honestly
        // Thenable either way, settled or already a value.
        const result: unknown = await Promise.resolve(call_function(closure, args as SchemeValue[]));
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
 *  fexpr transformer (§1.5: "define-syntax… bound through the same door define-
 *  macro's evaluation takes today"). The transformer receives the UNEVALUATED
 *  call-site argument forms (fexpr semantics) and applies the closure to them
 *  through the ordinary callable seam (`call_function` — lexical scoping, the
 *  closure's OWN captured definition-time scope, not the use site's `this=env`). */
function buildMacro(verb: string, def: DefineSyntaxSymbolDef, closureValue: unknown): Macro {
  const closure = closureValue as ACallable;
  return new Macro(
    verb,
    function (this: unknown, code: unknown, evalArgs: MacroInvokeContext): Promise<SchemeValue> {
      const argForms = formsOf(code);
      return Promise.resolve(call_function(closure, argForms, { runCtx: evalArgs.runCtx })) as Promise<SchemeValue>;
    },
    def.doc,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The orchestration entry — capability.ts's apply() Pass 2 calls this once, after
// every non-define kind (Pass 1) has bound.
// ─────────────────────────────────────────────────────────────────────────────

export interface BindCapabilityDefinesArgs {
  readonly capabilityName: string;
  /** Every verb (prefixed) this capability's OWN `symbolsRec` declares — phase 1
   *  (already bound in `env`) AND phase 2 (this call's `entries`) — the §2.3
   *  "letrec* NAME VISIBILITY" set: every name in K is visible to every OTHER name
   *  in K for the FV check, regardless of textual/binding order. */
  readonly ownNames: ReadonlySet<string>;
  /** The `symbol.define`/`symbol.defineSyntax` entries, `[verb, def]`, in
   *  DECLARATION order (JS object-key insertion order — §2.3). */
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

  // §1.3 — parse once per def (memoized).
  const parsedByDef = new Map<DefineSymbolDef | DefineSyntaxSymbolDef, SchemeValue>();
  for (const [, def] of entries) parsedByDef.set(def, await parseDefineBody(capabilityName, def));

  // §2.1's bake allowlist: SPECIAL_FORMS ∪ KEYWORD_SYNTAX ∪ ownNames(K) ∪ exports(deps).
  const allowlist = new Set<string>(KEYWORD_SYNTAX_BASELINE);
  for (const n of ownNames) allowlist.add(n);
  for (const dep of transitiveDeps(deps)) for (const n of await dep.exports()) allowlist.add(n);

  // §2.1 FV law + §2.3 eager-forward-reference — `symbol.define` bodies only (a
  // `symbol.defineSyntax` body's "free variables" would name the EXPANSION env,
  // §1.1 — categorically out of scope for this wave).
  const remaining = new Set(entries.map(([verb]) => verb));
  for (const [verb, def] of entries) {
    remaining.delete(verb); // "remaining" now = names declared strictly AFTER this one
    if (def.kind !== "define") continue;
    const body = parsedByDef.get(def)!;
    const free = freeVars(body);
    for (const name of free) {
      if (allowlist.has(name)) continue;
      if (resolverAnswers(name, deps, ownResolvers)) continue;
      throw new DefineLocalityError(name, def.name, capabilityName);
    }
    if (!isLambdaForm(body)) {
      for (const name of free) {
        if (remaining.has(name)) throw new DefineForwardReferenceError(def.name, name, capabilityName);
      }
    }
  }

  // §1.4 — derived provenance role: `classifyProgramPrelude`'s fixpoint, run over
  // this capability's OWN `symbol.define` set (verb-named synthetic forms so the
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
        `derived (§1.4's capability-set fixpoint over "${capabilityName}"'s own symbol.define set) as ` +
          `"${derived}" — ${membership.reasons.get(verb) ?? "its body is fixpoint-closed (reaches no port, directly or transitively)"}`,
      );
    }
  }

  // §2.3 — evaluate + bind, SEQUENTIALLY, in declaration order (each RHS sees only
  // what evaluated before it; a lambda body late-binds any forward reference).
  for (const [verb, def] of entries) {
    const value = await evaluateBody(scope, evalScheme, def.body);
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
