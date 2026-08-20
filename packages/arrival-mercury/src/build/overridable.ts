/**
 * `define/overridable` → the pipeline's env-chained parameter cone:
 *
 *   export default async function run(inhumanParams = {}) {
 *     const budget = inhumanParams.budget ?? (process.env.INHUMAN_BUDGET !== undefined
 *       ? Number(process.env.INHUMAN_BUDGET) : 100);
 *     …
 *   }
 *
 * Priority chain: explicit argument > env var > declared default.
 *
 * MECHANISM (why this lives at the registry layer, not a CoreForm/text rewrite):
 * scheme has no native `??`/`process.env` vocabulary to build this chain FROM, so
 * rather than hand-assembling JS text or splicing Residual nodes in post-walk
 * (fragile — depends on knowing exactly which `Const` in the walked output
 * corresponds to which overridable), each overridable `Define`'s VALUE is
 * replaced, BEFORE `walk()` ever runs, by a synthetic `App` calling one reserved
 * registry symbol (`__inhuman/overridable`) with five args: the overridable's
 * own (cleaned) name, its env-var key, its folded coercion tag, the ORIGINAL
 * declared-default CoreForm UNCHANGED, and a bare `Ref` to the wrapping
 * function's OWN params-parameter scheme name. That last arg is the trick that
 * avoids a chicken-and-egg: the wrapper's params Binding doesn't exist yet when
 * this registry row is BUILT (it's minted deep inside `walk()`'s own
 * `declareJs`/`bind`, invisible from outside) — but by the time the wrapper's
 * BODY is lowered, the params name is already bound in the enclosing scheme
 * frame (`lowerLambdaLike` binds params before lowering the body), so an
 * ORDINARY `Ref` to that name resolves correctly through the walker's own
 * lexical lookup, arriving at this rule's `call()` already-lowered to
 * `Ref(theRealBinding)` — no Binding needs to be threaded in from outside at
 * all. One `SymbolRule` resolves EVERY such call (the tag/name/env-key travel
 * as per-call-site literal arguments, not per-symbol registrations, so several
 * overridables of different declared types in one pipeline file share the row
 * without colliding) — the SAME dispatch ladder every other registry
 * symbol goes through; no post-walk tree surgery anywhere.
 *
 * v0 scope: only the plain-VALUE `define/overridable`
 * form lifts. A `define/overridable`'s fn-shorthand (`(define/overridable (f
 * params…) type body…)` — an overridable whose "default" is a function body, not
 * a value) has no sensible env-string coercion and is NOT part of the design
 * doc's own example; such a form is left as an ordinary `DefineFn` (module/
 * pipeline body function, un-lifted) with a caller-surfaced warning — an honest,
 * documented gap, not a silent miscompile.
 */
import type { CoreForm, Define, NodeId, ScalarLit, Span } from "../coreform/types.js";
import { cleanName } from "../walker/names.js";
import type { SymbolRule } from "../rules/overlay.js";
import { Bin, Binding as mkBinding, Call, Cond, Lit, Member, Ref, type R } from "../residual/types.js";

/** The reserved registry symbol name the synthetic `App` calls — never a real
 *  scheme identifier (never appears in any authored source), so it can never
 *  collide with a user binding or a real registry row. */
export const OVERRIDABLE_SYMBOL = "__inhuman/overridable";

/** The wrapper function's own params-parameter scheme name (deliberately
 *  hyphenated, `cleanName`-camelCases it to `inhumanParams` — distinctive
 *  enough that a real program's own top-level binding colliding with it is
 *  vanishingly unlikely; `--check` is the backstop for the rare case). */
export const PIPELINE_PARAMS_SCHEME_NAME = "inhuman-params";

/** One (fresh) `NodeId` generator — floor seeded above every id the real
 *  `classify()` pass minted for this file, mirroring
 *  `SchemeSemanticModel.mintIdiomId`'s own "above the real ceiling" discipline. */
export function idMinter(floor: number): () => NodeId {
  let next = floor;
  return () => next++ as NodeId;
}

const litStr = (id: () => NodeId, span: Span, value: string): CoreForm => ({
  kind: "Lit",
  id: id(),
  span,
  value: { kind: "string", value },
});

/** The Picoschema-adjacent type tags this v0 coercion understands. Anything else
 *  (an enum, an object shape, a symbol reference) passes through as a plain
 *  string — the SAME "honest gap, not a silent miscompile" posture the
 *  pretreat schema folder documents for its own unhandled shapes. */
export type CoercionTag = "number" | "integer" | "boolean" | "string";

/** Fold `overridableType` down to a coercion tag. Only a bare string-literal tag
 *  (`"number"`, `"integer"`, `"boolean"`) narrows; anything else — a bare
 *  symbol, an `s/*` composite, absent entirely — is `"string"` (no coercion,
 *  the always-safe default: the declared default and the env string both pass
 *  straight through). */
export function foldCoercionTag(t: CoreForm | undefined): CoercionTag {
  if (t !== undefined && t.kind === "Lit" && t.value.kind === "string") {
    const v = t.value.value;
    if (v === "number" || v === "integer" || v === "boolean") return v;
  }
  return "string";
}

/** `INHUMAN_<SCREAMING_SNAKE>` — a flat env convention (project/pipeline-scoped
 *  prefixing stays an open question, not decided here). */
export function envKeyFor(schemeName: string): string {
  return `INHUMAN_${schemeName
    .replace(/[?!]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase()}`;
}

/** Every top-level `Define` whose `overridableType` marks it `define/overridable`
 *  AND is a plain value (never `DefineFn` — see this module's header). Shared by
 *  every face/boundary that lifts overridables (`scm-module.ts`'s two faces,
 *  this file's own cross-file flow-up, below) so "which defines are liftable
 *  at all" has exactly one answer. */
export function isLiftableOverridable(f: CoreForm): f is Define {
  return f.kind === "Define" && f.overridableType !== undefined;
}

/**
 * Replace an overridable `Define`'s `.value` with the synthetic
 * `(__inhuman/overridable "name" "ENV_KEY" "tag" declared-default
 * inhuman-params)` call. `def` must already be known to carry
 * `overridableType !== undefined` and be a plain value-shaped `Define` (never a
 * `DefineFn` — see the module header).
 */
export function liftOverridable(def: Define, id: () => NodeId): Define {
  const span = def.span;
  const name = cleanName(def.name);
  const envKey = envKeyFor(def.name);
  const tag = foldCoercionTag(def.overridableType);
  const paramsRef: CoreForm = { kind: "Ref", id: id(), span, name: PIPELINE_PARAMS_SCHEME_NAME };
  const call: CoreForm = {
    kind: "App",
    id: id(),
    span,
    fn: { kind: "Ref", id: id(), span, name: OVERRIDABLE_SYMBOL },
    positionalArgs: [litStr(id, span, name), litStr(id, span, envKey), litStr(id, span, tag), def.value, paramsRef],
    kwargs: [],
  };
  return { ...def, value: call };
}

function literalString(r: R, what: string): string {
  if (r.t === "Lit" && r.value.k === "string") return r.value.value;
  throw new Error(`${OVERRIDABLE_SYMBOL}: internal shape error resolving its ${what} — expected a literal string argument`);
}

/** `process.env.<KEY>` — a raw external `Ref`, exactly like this file's sibling
 *  import bindings (`scm-module.ts`): never routed through the walker's own
 *  name-allocation phase (there is no local declaration site to collide with in
 *  the ordinary case — `--check` is the backstop for the rare pathological
 *  collision). */
function processEnvAccess(key: string): R {
  return Member(Member(Ref(mkBinding("process")), "env"), key);
}

/** `raw` when the coercion tag needs none (`"string"`); otherwise the JS
 *  coercion this needs (`Number(...)` for numeric tags,
 *  a `=== "true"` string compare for boolean — env vars are ALWAYS strings, so
 *  this only ever coerces the STRING SIDE of the chain, never the (already
 *  correctly-typed) declared default — see `buildEnvChain`'s own doc for why
 *  that split matters). */
function coerce(raw: R, tag: CoercionTag): R {
  if (tag === "number" || tag === "integer") return Call(Ref(mkBinding("Number")), [raw]);
  if (tag === "boolean") return Bin("===", raw, Lit("true"));
  return raw;
}

/**
 * `env present ? coerce(env) : declaredDefault` — the 2-tier core every
 * overridable resolves through, REGARDLESS of whether a `params` cone even
 * exists (a module-face overridable has none — see `MODULE_OVERRIDABLE_SYMBOL`,
 * below: without this factoring, a REQUIRED, non-pipeline file's OWN
 * `define/overridable` would compile as an inert plain value, its annotation
 * silently dropped — never even reading its env var). Factored out so
 * `buildEnvChain` (params-aware, below) and `moduleOverridableSymbolRule`
 * (params-less) share the identical env-or-default logic instead of forking
 * it.
 *
 * The branch is a `Cond`, not a plain `??`: `process.env.X` is a
 * `string | undefined`, and coercing `undefined` (`Number(undefined)` = `NaN`,
 * `undefined === "true"` = `false`) would silently corrupt the DECLARED
 * default's own, already-correct type the moment the env var is unset. Testing
 * presence first and coercing only the genuinely-present string keeps the
 * declared default exactly as authored.
 */
export function buildEnvOrDefault(envKey: string, tag: CoercionTag, declaredDefaultR: R): R {
  const rawEnv = processEnvAccess(envKey);
  return Cond(Bin("!==", rawEnv, Lit(undefined)), coerce(rawEnv, tag), declaredDefaultR);
}

/** `paramsRefR.<name> ?? (env present ? coerce(env) : declaredDefault)` — the
 *  full 3-tier chain, params-aware (composes {@link buildEnvOrDefault}). */
export function buildEnvChain(paramsRefR: R, name: string, envKey: string, tag: CoercionTag, declaredDefaultR: R): R {
  return Bin("??", Member(paramsRefR, name), buildEnvOrDefault(envKey, tag, declaredDefaultR));
}

/** The ONE registry row for {@link OVERRIDABLE_SYMBOL} — resolves every
 *  synthetic call `liftOverridable` mints to the real env-chain, via the
 *  ordinary registry dispatch ladder (no special-casing anywhere in
 *  `walk()` itself). `args[3]` (the already-WALKED declared-default
 *  expression) and `args[4]` (the already-WALKED, already-lexically-resolved
 *  params reference) are used exactly as the walker lowered them — a compound
 *  default (`(+ 1 2)`) still folds/idiomatizes normally, since both went
 *  through the ordinary recursive `lowerExpr` before this rule ever runs. */
export const overridableSymbolRule: SymbolRule = {
  emit: {
    call: (args) => {
      const [nameArg, envArg, tagArg, defaultR, paramsRefR] = args;
      if (nameArg === undefined || envArg === undefined || tagArg === undefined || defaultR === undefined || paramsRefR === undefined) {
        throw new Error(`${OVERRIDABLE_SYMBOL}: internal arity error — expected exactly 5 args, got ${args.length}`);
      }
      const name = literalString(nameArg, "name");
      const envKey = literalString(envArg, "env key");
      const tag = literalString(tagArg, "coercion tag") as CoercionTag;
      return buildEnvChain(paramsRefR, name, envKey, tag, defaultR);
    },
  },
};

// ─── Module-face overridables ────────────────────────────────────────────────
//
// A `define/overridable` in a file that compiles as an ordinary MODULE (not a
// pipeline) has no `params` cone to consult at all — there is no wrapping
// function, so there is no explicit-argument tier. It still deserves the
// SAME env-or-default resolution every pipeline-local overridable gets (the
// priority chain is a property of the LANGUAGE FEATURE, not of "being inside
// a pipeline"): `buildEnvOrDefault`'s 2-tier
// core, spliced in via the identical registry-symbol-dispatch technique as
// {@link OVERRIDABLE_SYMBOL} — a SEPARATE, 3-arg symbol (no name/params to
// carry) rather than overloading the 5-arg one with a sentinel "no params"
// value, so neither rule needs to branch on an absent argument.

/** The reserved registry symbol a MODULE-FACE overridable's synthetic call
 *  resolves through — {@link OVERRIDABLE_SYMBOL}'s params-less sibling. */
export const MODULE_OVERRIDABLE_SYMBOL = "__inhuman/overridable-local";

/** The ONE registry row for {@link MODULE_OVERRIDABLE_SYMBOL} — resolves every
 *  synthetic call `liftLocalOverridable` mints to `buildEnvOrDefault`'s 2-tier
 *  chain (no params reference exists at this call shape at all). */
export const moduleOverridableSymbolRule: SymbolRule = {
  emit: {
    call: (args) => {
      const [envArg, tagArg, defaultR] = args;
      if (envArg === undefined || tagArg === undefined || defaultR === undefined) {
        throw new Error(`${MODULE_OVERRIDABLE_SYMBOL}: internal arity error — expected exactly 3 args, got ${args.length}`);
      }
      const envKey = literalString(envArg, "env key");
      const tag = literalString(tagArg, "coercion tag") as CoercionTag;
      return buildEnvOrDefault(envKey, tag, defaultR);
    },
  },
};

/**
 * Replace a MODULE-FACE overridable `Define`'s `.value` with the synthetic
 * `(__inhuman/overridable-local "ENV_KEY" "tag" declared-default)` call —
 * {@link liftOverridable}'s params-less sibling. Same preconditions as
 * `liftOverridable` (`def` must satisfy {@link isLiftableOverridable}).
 */
export function liftLocalOverridable(def: Define, id: () => NodeId): Define {
  const span = def.span;
  const envKey = envKeyFor(def.name);
  const tag = foldCoercionTag(def.overridableType);
  const call: CoreForm = {
    kind: "App",
    id: id(),
    span,
    fn: { kind: "Ref", id: id(), span, name: MODULE_OVERRIDABLE_SYMBOL },
    positionalArgs: [litStr(id, span, envKey), litStr(id, span, tag), def.value],
    kwargs: [],
  };
  return { ...def, value: call };
}

// ─── Cross-file flow-up ──────────────────────────────────────────────────────
//
// "The pipeline's signature should be the transitive knob set": an
// overridable declared in a REQUIRED module is folded to a
// portable (name/envKey/tag/default) triple that survives the require
// boundary as plain data (`ExportShape.overridables`, below — `project.ts`'s
// cone walk collects it from every transitively-required file's shape) and
// gets lifted a SECOND time, into the ENTRY pipeline's own params cone —
// extending `liftOverridable`'s same-file mechanism across files.
//
// Unlike `liftOverridable` (which rewrites an EXISTING user-authored `Define`
// in place), `liftFlowedUpOverridable` builds the WHOLE synthetic `Define`
// from scratch: there is no CoreForm for a knob whose OWN `(define/overridable
// …)` lives in a DIFFERENT file's parse tree (different id space, different
// `SchemeSemanticModel`) — only its already-folded metadata crosses over.

/** What ONE file publishes about its OWN top-level overridables — bare name
 *  (pre-collision; `project.ts`'s cone walk decides namespacing across the
 *  whole transitive set, which no single file can see), its env key (a
 *  STABLE identity independent of who ends up requiring this file), its
 *  coercion tag, and its declared default FOLDED to a portable literal.
 *  `defaultLit` is `undefined` when the declared default ISN'T a plain
 *  literal (a computed expression) — an honest, named gap (project.ts's
 *  `build/overridable-flow-up-nonliteral-default`): the value can't be
 *  re-embedded in a DIFFERENT file's parse tree without re-parsing/
 *  re-lowering machinery not built here. */
export interface OverridableExport {
  readonly name: string;
  readonly envKey: string;
  readonly tag: CoercionTag;
  readonly defaultLit: ScalarLit | undefined;
}

/** Every top-level, value-shaped `define/overridable` in `forms`, folded to
 *  {@link OverridableExport}'s portable shape — computed for EVERY compiled
 *  file (module or pipeline face alike; a pipeline required by ANOTHER
 *  pipeline should ALSO surface its own knobs upward, so this is never
 *  gated on `isPipeline`). */
export function foldOverridableExports(forms: readonly CoreForm[]): OverridableExport[] {
  return forms.filter(isLiftableOverridable).map((def) => {
    const v = def.value;
    const defaultLit = v.kind === "Lit" && (v.value.kind === "number" || v.value.kind === "string" || v.value.kind === "boolean") ? v.value : undefined;
    return { name: cleanName(def.name), envKey: envKeyFor(def.name), tag: foldCoercionTag(def.overridableType), defaultLit };
  });
}

/** One overridable, transitively reached from an entry pipeline, ready to lift
 *  into ITS OWN params cone — {@link OverridableExport} plus the EXPOSED key
 *  `project.ts`'s cone walk decided (bare unless a collision forced the
 *  `<moduleAlias>.<name>` namespaced form, e.g. `"metric.threshold"`). */
export interface FlowedUpOverridable {
  readonly exposedKey: string;
  readonly envKey: string;
  readonly tag: CoercionTag;
  readonly defaultLit: ScalarLit | undefined;
}

/**
 * Synthesize a top-level `Define` for ONE flowed-up overridable, prepended
 * into the entry pipeline's wrapper body (`scm-module.ts`'s
 * `compilePipelineFace`) ALONGSIDE its own local ones. Reuses
 * {@link OVERRIDABLE_SYMBOL} (the SAME 5-arg params-aware call
 * `liftOverridable` mints) — `entry.exposedKey` is the property name read off
 * the wrapper's own params object (`Member`'s identifier gate,
 * residual/render.ts, already emits bracket notation for a non-identifier key
 * like `"metric.threshold"`); the new Define's OWN local JS binding name is a
 * SEPARATE, `index`-derived identity (see below) — never `exposedKey` itself.
 *
 * A `defaultLit` of `undefined` (the upstream module's declared default
 * wasn't a plain literal) still gets a full explicit-arg/env chain; only the
 * innermost fallback becomes `undefined` rather than silently guessing.
 *
 * `index` mints this Define's OWN local JS binding name (`inhuman-overridable-
 * <index>`, cleaned) — DELIBERATELY decoupled from `entry.exposedKey`. A
 * pipeline requiring the SAME module a flow-up entry came FROM (the common
 * case: a module face exports EVERY top-level define, including its own
 * overridables, as a named export — see `compileModuleFace`) already spill-
 * imports a local JS binding with that EXACT bare name (`threshold`, say) —
 * reusing it here would mint a SECOND, colliding declaration for the same
 * identifier. Nothing in the requiring file's OWN source ever names this
 * synthetic binding at all (that's the whole point of a flow-up default —
 * see this file's header), so its local text only needs to be UNIQUE, never
 * meaningful; `entry.exposedKey` alone carries the human-facing identity,
 * via `Member(paramsRefR, exposedKey)` below — same distinctive-marker
 * posture as `PIPELINE_PARAMS_SCHEME_NAME`'s own doc comment.
 */
export function liftFlowedUpOverridable(entry: FlowedUpOverridable, index: number, id: () => NodeId, span: Span): Define {
  const localName = cleanName(`inhuman-overridable-${index}`);
  const paramsRef: CoreForm = { kind: "Ref", id: id(), span, name: PIPELINE_PARAMS_SCHEME_NAME };
  const defaultForm: CoreForm =
    entry.defaultLit !== undefined ? { kind: "Lit", id: id(), span, value: entry.defaultLit } : { kind: "Lit", id: id(), span, value: { kind: "undefined" } };
  const call: CoreForm = {
    kind: "App",
    id: id(),
    span,
    fn: { kind: "Ref", id: id(), span, name: OVERRIDABLE_SYMBOL },
    positionalArgs: [litStr(id, span, entry.exposedKey), litStr(id, span, entry.envKey), litStr(id, span, entry.tag), defaultForm, paramsRef],
    kwargs: [],
  };
  return { kind: "Define", id: id(), span, name: localName, value: call };
}
