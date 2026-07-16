/**
 * `define/overridable` → the pipeline's env-chained parameter cone (design doc §3):
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
 * without colliding) — the SAME §4.2 dispatch ladder every other registry
 * symbol goes through; no post-walk tree surgery anywhere.
 *
 * v0 scope (per this lane's directive): only the plain-VALUE `define/overridable`
 * form lifts. A `define/overridable`'s fn-shorthand (`(define/overridable (f
 * params…) type body…)` — an overridable whose "default" is a function body, not
 * a value) has no sensible env-string coercion and is NOT part of the design
 * doc's own example; such a form is left as an ordinary `DefineFn` (module/
 * pipeline body function, un-lifted) with a caller-surfaced warning — an honest,
 * documented gap, not a silent miscompile.
 */
import type { CoreForm, Define, NodeId, Span } from "../coreform/types.js";
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
 *  `.prompt` schema folder documents for its own unhandled shapes. */
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

/** `INHUMAN_<SCREAMING_SNAKE>` — design doc §3's flat env convention (v0's Q3
 *  lean; project/pipeline-scoped prefixing stays the open question the doc
 *  names, not decided here). */
export function envKeyFor(schemeName: string): string {
  return `INHUMAN_${schemeName
    .replace(/[?!]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase()}`;
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
 *  collision, per this lane's report). */
function processEnvAccess(key: string): R {
  return Member(Member(Ref(mkBinding("process")), "env"), key);
}

/** `raw` when the coercion tag needs none (`"string"`); otherwise the JS
 *  coercion the design doc's own example uses (`Number(...)` for numeric tags,
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
 * `paramsRefR.<name> ?? (env present ? coerce(env) : declaredDefault)`.
 *
 * The inner branch is a `Cond`, not a second `??`: `process.env.X` is a
 * `string | undefined`, and coercing `undefined` (`Number(undefined)` = `NaN`,
 * `undefined === "true"` = `false`) would silently corrupt the DECLARED
 * default's own, already-correct type the moment the env var is unset. Testing
 * presence first and coercing only the genuinely-present string keeps the
 * declared default exactly as authored.
 */
export function buildEnvChain(paramsRefR: R, name: string, envKey: string, tag: CoercionTag, declaredDefaultR: R): R {
  const rawEnv = processEnvAccess(envKey);
  const envOrDefault = Cond(Bin("!==", rawEnv, Lit(undefined)), coerce(rawEnv, tag), declaredDefaultR);
  return Bin("??", Member(paramsRefR, name), envOrDefault);
}

/** The ONE registry row for {@link OVERRIDABLE_SYMBOL} — resolves every
 *  synthetic call `liftOverridable` mints to the real env-chain, via the
 *  ordinary §4.2 registry dispatch ladder (no special-casing anywhere in
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
