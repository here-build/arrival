/**
 * ARM-B — application / control.
 *
 * Owns: App, DefineFn, Lambda, NamedLet, If, And, Or.
 *
 * Contracts (I1 throughout — lift or opaque, never mislabel):
 *  - If     → ChoiceProv { guards:[extract(cond)], alts:[extract(then), extract(else)] }.
 *             BOTH alts extracted — gray wires are the design's core claim. A
 *             literal alt stays a visible ConstProv (the guard-swap forge's
 *             signature; the verdict channel reads it, extract never hides it).
 *  - And/Or → ChoiceProv; every arg is BOTH a guard AND an alt (each arg can be
 *             the result and gates the rest). guards = args[0..n-1], alts = args
 *             (computed once, sliced twice — extract is pure, but there is no
 *             reason to walk each arg's subtree twice).
 *  - App    → resolve the callee, in order:
 *             (1) keyword head (`:field`) ⇒ MuxProv over the operand. Arity is
 *                 exactly one positional operand and zero kwargs; anything else
 *                 is opaque("keyword-arity") — there is no operand to project.
 *             (2)/(4) a user fn (scope-resolved DefineFn/Lambda, OR an IIFE
 *                 Lambda literal written directly in head position) ⇒
 *                 BETA-REDUCE (derive.ts's hardenings): no rest param and folded
 *                 arity must match param count ⇒ else opaque("callee-arity");
 *                 a callee already on the reduction stack ⇒
 *                 opaque("cyclic-binding") — UNLESS `recognizeTailFold` (below)
 *                 recognizes the narrow self-recursive fold/loop shape FIRST,
 *                 in which case the whole call lifts to a `FanProv` instead
 *                 (the NamedLet comment's "planned extension", landed for
 *                 DefineFn self-recursion): `(define (f p…) (if <base-guard>
 *                 <bare-param-base> (f <stepped-args>)))` — one `If`, one
 *                 branch a direct tail self-call, the other a bare Ref to
 *                 exactly one of `f`'s own params (the accumulator), no
 *                 self-reference anywhere else in the shape. `collection` =
 *                 the accumulator's SEED argument's attribution (the value
 *                 flowing in at the ORIGINAL call site); `element` = the usual
 *                 `MuxProv{key:null, source:collection}` (buildFan's own
 *                 mechanism); `body` = the attribution of the accumulator's
 *                 UPDATE expression (the recursive call's corresponding arg,
 *                 e.g. `(step pool)`) extracted with the accumulator param
 *                 bound to `element` — this is exactly fold's combinator body,
 *                 just hand-written as recursion instead of passed as a
 *                 lambda. `collapse` is ALWAYS "lowered": the update
 *                 expression's own dialect program (every internal `if`,
 *                 every literal) is extracted NORMALLY, so a const hidden
 *                 behind an `if` in the loop body stays a visible `choice`
 *                 alt — the same guard that keeps buildFan's fold-collapse
 *                 forge dead, reused here rather than re-invented. Anything
 *                 that doesn't match this exact shape (non-tail recursion,
 *                 mutual recursion, a base case that isn't a bare
 *                 param-Ref, two recursive branches, a stray self-reference
 *                 in the guard or elsewhere) falls straight through to the
 *                 unchanged cyclic-binding opaque below — recognition NEVER
 *                 guesses, it only fires on an unambiguous match. In the
 *                 ordinary (non-lifted) case, each param binds to its
 *                 ARGUMENT's OWN attribution evaluated in the CALLER's scope
 *                 — binding-site scoping, the mechanism that keeps a helper's
 *                 hidden guard visible (the reopened named-helper forge). The
 *                 body walk is `extractBody` (index.ts) — the ONE
 *                 defines-then-expressions walk every body-hosting construct
 *                 shares, so a beta-reduced callee's body, ARM-A's Begin/Let
 *                 bodies, and the program's own top level all treat a body
 *                 identically.
 *             (3) a free (not-in-scope) Ref ⇒ ctx.registry.classifyHead(name) —
 *                 fuse/mux/build/string/mint/fan/choice/opaque per HeadClass.
 *                 kwargs FOLD into the flat arg list (positional order, then
 *                 kwargs in source order) for fuse/mint/string/choice — never a
 *                 silent forge channel (hardening #4). mux/build/fan have a
 *                 rigid positional shape and reject ANY kwargs outright
 *                 (opaque("kwargs-unsupported-head")); an unknown head called
 *                 with kwargs and no positional args gets the more specific
 *                 opaque("kwargs-only-call") instead of the generic
 *                 unknown-head reason. fan kinds desugar to FanProv via ARM-C's
 *                 `buildFan` (treated as an opaque black box here — its body is
 *                 ARM-C's; collapse is always "lowered" until T3a).
 *             (5) anything else (a computed callee, a name bound to a
 *                 non-callable value, …) ⇒ opaque("unknown-callee").
 *  - DefineFn/Lambda in VALUE position (reached directly by the dispatcher, NOT
 *           through App's head — that path is fully handled inline above and
 *           never falls through to the generic `extract` on the callee) → the
 *           fn as a value closes over scope; a later App beta-reduces it. As a
 *           leaf value it is opaque("fn-as-value") until the callable-as-value
 *           design (tagless apply) lands. Fail closed.
 *  - NamedLet → the loop form: a recursion knot. G1 ships the SOUND default,
 *           unconditionally: opaque("named-let/unliftable"), UNCHANGED here —
 *           this bullet's own "planned extension" landed for self-recursive
 *           DefineFn (App's bullet, `recognizeTailFold`/`buildRecursionFan`
 *           below) but a NamedLet is a distinct CoreForm kind with no App/
 *           betaReduce path through it, so recognizing the same shape written
 *           as `(let loop (…) …)` is a separate, still-unattempted lift.
 *           Guessing at a partial lift here is exactly the kind of
 *           shape-matching that must not be attempted halfway — mislabeling
 *           is the only sin; opaque stays ALWAYS a correct answer.
 */
import type { And, App, CoreForm, DefineFn, If, Lambda, NamedLet, Or } from "../coreform/types.js";
import type { HeadClass, StaticProv } from "../model/static-prov.js";
// Circular with ./index.js by construction (same shape as ARM-A/ARM-C's own
// note): index.ts imports extractControl to dispatch INTO this module; this
// module imports extract to recurse back OUT to sibling-owned CoreForm kinds
// (a keyword accessor's operand, a fuse head's args, a callee's body — any of
// which can be a Lit/Ref/Dict/etc.). Sound because every cross-cycle reference
// happens from inside a function body, never at module-eval time.
import { type Bound, type ExtractCtx, type Scope, checkReducing, extract, extractBody, lastValueForm, lookup, opaque } from "./index.js";
import { buildFan } from "./arm-containers.js";

type ControlForm = App | DefineFn | Lambda | NamedLet | If | And | Or;

export function extractControl(form: ControlForm, ctx: ExtractCtx): StaticProv {
  switch (form.kind) {
    case "If":
      return extractIf(form, ctx);
    case "And":
    case "Or":
      return extractAndOr(form, ctx);
    case "App":
      return extractApp(form, ctx);
    case "DefineFn":
    case "Lambda":
      return opaque(form.id, "fn-as-value");
    case "NamedLet":
      return opaque(form.id, "named-let/unliftable");
  }
}

// ── If / And / Or ───────────────────────────────────────────────────────────────

function extractIf(form: If, ctx: ExtractCtx): StaticProv {
  const guard = extract(form.cond, ctx);
  return { kind: "choice", site: form.id, guards: [guard], alts: [extract(form.then, ctx), extract(form.else, ctx)] };
}

function extractAndOr(form: And | Or, ctx: ExtractCtx): StaticProv {
  const provs = form.args.map((a) => extract(a, ctx));
  return { kind: "choice", site: form.id, guards: provs.slice(0, -1), alts: provs };
}

// ── App ──────────────────────────────────────────────────────────────────────────

function extractApp(form: App, ctx: ExtractCtx): StaticProv {
  // (1) keyword accessor — `(:field obj)`.
  if (form.fn.kind === "Lit" && form.fn.value.kind === "keyword") {
    if (form.positionalArgs.length !== 1 || form.kwargs.length !== 0) return opaque(form.id, "keyword-arity");
    return { kind: "mux", site: form.id, key: form.fn.value.name, source: extract(form.positionalArgs[0]!, ctx) };
  }

  if (form.fn.kind === "Ref") {
    const bound = lookup(ctx.scope, form.fn.name);
    if (bound !== undefined) {
      const resolution = resolveCallee(bound, ctx);
      if (resolution.kind === "fn") return betaReduce(resolution.fn, resolution.scope, form, ctx);
      if (resolution.kind === "free") return dispatchKnownHead(form, ctx.registry.classifyHead(resolution.name), resolution.name, ctx);
      // Bound to something that isn't callable (a computed/dynamic value, a
      // synthetic fan projection, an exhausted ref-cycle, …) — not one of the
      // ladder's named cases; fail closed.
      return opaque(form.id, "unknown-callee");
    }
    // Free name — resolve as a known/unknown primitive head.
    return dispatchKnownHead(form, ctx.registry.classifyHead(form.fn.name), form.fn.name, ctx);
  }

  // (4) IIFE — an immediately-applied Lambda literal beta-reduces exactly like a
  // resolved user function; it is lexically written right here, so its closure
  // scope is simply the current scope.
  if (form.fn.kind === "Lambda") return betaReduce(form.fn, ctx.scope, form, ctx);

  // (5) anything else — a computed callee (`((pick-fn) x)`), an App/If/Dict/…
  // sitting in head position. Nothing left to resolve.
  return opaque(form.id, "unknown-callee");
}

/** The terminal outcome of chasing a callee `Ref` through zero or more
 *  ref-to-ref hops: a resolved user fn ready for beta-reduction (in ITS OWN
 *  binding scope, unchanged from the direct case), a free name reached at the
 *  chain's end (dispatch it exactly like today's direct free-Ref path), or
 *  nothing resolvable — stay opaque. */
type CalleeResolution =
  | { readonly kind: "fn"; readonly fn: DefineFn | Lambda; readonly scope: Scope }
  | { readonly kind: "free"; readonly name: string }
  | { readonly kind: "opaque" };

/** Chase a callee-position `Ref` through however many ref-to-ref hops it
 *  takes to bottom out (the higher-order/callable-as-value gap: a param like
 *  `step` bound to `Ref(generation)`, one level removed from the DefineFn
 *  `generation` actually is). Sound because refs are immutable in this
 *  dialect (no `set!` — see the arrival-immutable-no-dynamics law): a name
 *  resolving to a name resolving to a DefineFn/Lambda IS that DefineFn/Lambda,
 *  so chasing it is identical to calling it directly.
 *
 *  A resolved `"fn"` outcome (the terminal DefineFn/Lambda, direct OR chased)
 *  returns WITHOUT ever consulting `ctx.reducing` — that set stays exclusively
 *  `betaReduce`'s own territory (its `ctx.reducing.has(fn)` check, reported as
 *  `opaque("cyclic-binding")`), unchanged from before this chase existed. A
 *  direct self-call (`bound.expr` already a DefineFn/Lambda on the first hop,
 *  no chase needed) must keep hitting THAT check with THAT reason — folding a
 *  reducing-check in ahead of it here would intercept the exact same cycle
 *  one step earlier and relabel it `unknown-callee`, a real regression (wrong
 *  reason strings are the one thing I1 forbids).
 *
 *  The cycle guard below exists ONLY for the ref-to-ref hop itself (mirrors
 *  `extractRef`'s (arm-atoms.ts) own ref-chase guard, same `ctx.reducing` set,
 *  same shape: check the Ref node against `ctx.reducing` before following it,
 *  then extend `ctx.reducing` with that same Ref node before recursing). A
 *  repeat hop (`(define a b)(define b a)` called as a callee) is a
 *  definitional cycle and fails closed rather than diverging — bounded by the
 *  number of distinct Ref nodes in the chain, never unbounded.
 *
 *  Every other shape stays opaque, NEVER guessed: a synthetic `{tag:"prov"}`
 *  bound (a fan-body element, an input — not something a static callee chase
 *  may re-interpret as callable), or a bound expr that is neither `Ref` nor
 *  `DefineFn`/`Lambda` (a COMPUTED/dynamic callable — `(define f (pick-fn))`
 *  used through a param — cannot be resolved statically). */
function resolveCallee(bound: Bound, ctx: ExtractCtx): CalleeResolution {
  if (bound.tag === "prov") return { kind: "opaque" };
  const { expr, scope } = bound;
  if (expr.kind === "DefineFn" || expr.kind === "Lambda") return { kind: "fn", fn: expr, scope };
  if (expr.kind !== "Ref") return { kind: "opaque" };
  if (checkReducing(ctx, expr)) return { kind: "opaque" };
  const next = lookup(scope, expr.name);
  if (next === undefined) return { kind: "free", name: expr.name };
  return resolveCallee(next, { ...ctx, reducing: new Set(ctx.reducing).add(expr) });
}

/** Beta-reduce a call to a known callee (`DefineFn`/`Lambda`, scope-resolved OR
 *  an IIFE literal). Order matters (matches the spec's own ordering): shape
 *  first (rest param, folded arity) — these are facts about THIS call site, so
 *  they get the more specific reason when a mismatched call also happens to be
 *  recursive — THEN the cycle guard. Kwargs fold into the SAME flat, positional
 *  arg list used elsewhere (never a silent forge channel); each param binds
 *  positionally over that fold. Binding-site scoping: every arg's attribution
 *  is deferred in the CALLER's scope (`ctx.scope`), never the callee's — this is
 *  what keeps a helper's hidden guard visible instead of reading as opaque
 *  forwarding (derive.ts's reopened guard-swap forge). */
function betaReduce(fn: DefineFn | Lambda, calleeScope: Scope, form: App, ctx: ExtractCtx): StaticProv {
  if (fn.params.some((p) => p.rest)) return opaque(form.id, "callee-arity");
  const allArgs: readonly CoreForm[] = [...form.positionalArgs, ...form.kwargs.map((kw) => kw.value)];
  if (fn.params.length !== allArgs.length) return opaque(form.id, "callee-arity");
  if (checkReducing(ctx, fn)) return opaque(form.id, "cyclic-binding");

  // The tail-fold lift (see the App bullet's header note): only reachable on
  // the FIRST reduction of `fn` (the check above already ruled out a revisit),
  // and only for a named DefineFn — a bare Lambda has no name to self-call
  // through, so it can never match `recognizeTailFold`'s shape. Recognition
  // is a pure function of `fn`'s own body text; a non-match falls straight
  // through to the unchanged normal beta-reduction below.
  if (fn.kind === "DefineFn") {
    const fold = recognizeTailFold(fn);
    if (fold) return buildRecursionFan(fold, fn, calleeScope, allArgs, ctx);
  }

  const paramNames = new Map<string, Bound>();
  fn.params.forEach((p, i) => paramNames.set(p.name, { tag: "expr", expr: allArgs[i]!, scope: ctx.scope }));
  const paramFrame: Scope = { names: paramNames, parent: calleeScope };
  const reducing = new Set(ctx.reducing).add(fn);
  return extractBody(fn.body, { ...ctx, scope: paramFrame, reducing }, form.id);
}

// ── the tail-fold lift (self-recursive DefineFn ⇒ FanProv) ──────────────────────

/** The recognized shape: which param is the accumulator (returned bare in the
 *  base branch) and which raw CoreForm computes its NEXT value (the
 *  recursive call's corresponding argument — fold's combinator body, hand-
 *  written as recursion instead of passed as a lambda). */
interface TailFold {
  readonly accParamIndex: number;
  readonly updateExpr: CoreForm;
}

/** Is `form` exactly a direct tail call back to `fn` itself — `fn.fn` a Ref
 *  spelled `fn.name`? (Mutual recursion, or a call to anything else, never
 *  matches — this is the ONLY test that lets a DIFFERENT function's call
 *  through unrecognized, which is what keeps mutual recursion opaque.) */
function isDirectSelfCall(form: CoreForm, fn: DefineFn): form is App {
  return form.kind === "App" && form.fn.kind === "Ref" && form.fn.name === fn.name;
}

/** Generic free-reference scan — does `form`'s subtree contain a `Ref` spelled
 *  `name` ANYWHERE? Used only by `recognizeTailFold`'s guard checks (never by
 *  extraction itself): a self-reference outside the one recognized tail-call
 *  position — in the guard, in the base branch, or nested inside one of the
 *  recursive call's own arguments — means this is a MORE COMPLEX recursion
 *  shape (non-tail, a second recursive branch, …) that this narrow lift does
 *  not attempt; the caller bails to the unchanged opaque("cyclic-binding")
 *  default rather than guess. Exhaustive over CoreForm by tsc (no default
 *  arm) — the same totality discipline as `extract`'s own dispatcher. Quoted
 *  data (`Quote`) is inert program text, never re-classified, so it can never
 *  hide a live Ref — correctly excluded here the same way ARM-A excludes it
 *  from attribution. */
function containsRef(form: CoreForm, name: string): boolean {
  switch (form.kind) {
    case "Ref":
      return form.name === name;
    case "Lit":
    case "Quote":
    case "Require":
    case "Door":
      return false;
    case "Define":
      return containsRef(form.value, name) || (form.overridableType !== undefined && containsRef(form.overridableType, name));
    case "DefineFn":
      return (
        form.body.some((f) => containsRef(f, name)) || (form.overridableType !== undefined && containsRef(form.overridableType, name))
      );
    case "Lambda":
      return form.body.some((f) => containsRef(f, name));
    case "If":
      return containsRef(form.cond, name) || containsRef(form.then, name) || containsRef(form.else, name);
    case "And":
    case "Or":
      return form.args.some((a) => containsRef(a, name));
    case "Let":
    case "NamedLet":
      return form.bindings.some((b) => containsRef(b.init, name)) || form.body.some((f) => containsRef(f, name));
    case "Begin":
      return form.body.some((f) => containsRef(f, name));
    case "App":
      return containsRef(form.fn, name) || form.positionalArgs.some((a) => containsRef(a, name)) || form.kwargs.some((kw) => containsRef(kw.value, name));
    case "Dict":
      return form.entries.some((e) => containsRef(e.value, name));
  }
}

/** Does `fn`'s own raw body match the narrow self-recursive fold/loop shape?
 *  A pure syntactic check against the UN-EXTRACTED CoreForm — the same
 *  discipline `isBareAcLambdaBody` (arm-containers.ts) uses to read a
 *  combinator's identity before extraction erases it. Requires, in order
 *  (any failure ⇒ null, the caller's unchanged opaque("cyclic-binding") path):
 *   1. the body's value form (`lastValueForm`, index.ts — the same
 *      defines-then-expressions walk `extractBody` uses, minus the scope it
 *      would also build) is a single `If` — no cond/nested-If nesting
 *      attempted.
 *   2. exactly ONE of `then`/`else` is a direct tail self-call (both, or
 *      neither, bails — over-lifting guard).
 *   3. no OTHER reference to `fn.name` anywhere in the guard, the base
 *      branch, or the recursive call's own arguments (mutual/nested
 *      recursion, a second recursive site — none of this narrow lift's
 *      business).
 *   4. the recursive call's shape matches an ordinary beta-reduction call:
 *      no kwargs, positional arity === fn.params.length (fn's rest-param
 *      check already ran in `betaReduce` before this is called).
 *   5. the base branch is a BARE `Ref` to one of `fn`'s OWN params — the
 *      accumulator returned unchanged at the end of the loop. A computed
 *      base value (anything else) is a shape this lift does not attempt. */
function recognizeTailFold(fn: DefineFn): TailFold | null {
  const target = lastValueForm(fn.body);
  if (target === undefined || target.kind !== "If") return null;

  const branches: readonly [CoreForm, CoreForm] = [target.then, target.else];
  const selfIdx = branches.findIndex((b) => isDirectSelfCall(b, fn));
  if (selfIdx === -1) return null;
  const otherIdx = selfIdx === 0 ? 1 : 0;
  if (isDirectSelfCall(branches[otherIdx]!, fn)) return null; // both branches recurse — not this shape

  const recursiveApp = branches[selfIdx] as App;
  const baseBranch = branches[otherIdx]!;

  if (containsRef(target.cond, fn.name)) return null;
  if (containsRef(baseBranch, fn.name)) return null;
  if (recursiveApp.kwargs.length !== 0) return null;
  if (recursiveApp.positionalArgs.length !== fn.params.length) return null;
  if (recursiveApp.positionalArgs.some((a) => containsRef(a, fn.name))) return null;

  if (baseBranch.kind !== "Ref") return null;
  const accParamIndex = fn.params.findIndex((p) => p.name === baseBranch.name);
  if (accParamIndex === -1) return null;

  return { accParamIndex, updateExpr: recursiveApp.positionalArgs[accParamIndex]! };
}

/** Build the lifted `FanProv` — the fold/loop's `collection` is the
 *  accumulator's SEED (its argument at THIS call site, extracted in the
 *  CALLER's scope — binding-site scoping, unchanged from ordinary
 *  beta-reduction); `element` is the usual one-round projection (buildFan's
 *  own mechanism, reused rather than re-invented); `body` is the accumulator's
 *  UPDATE expression (the recursive call's own argument in that slot,
 *  fold's combinator body in every way but syntax) extracted with the
 *  accumulator param rebound to `element` and every OTHER param rebound to
 *  ITS OWN seed argument (an approximation for a param that itself changes
 *  round to round, e.g. a counter — sound because it never hides a source,
 *  it only stands in one concrete round for "some round"; the design's
 *  concern is fabrication, not precision). `collapse` is always "lowered" —
 *  never inferred, never combine/route — because the update expression's
 *  full dialect program (every internal `if`, every literal) is extracted
 *  through the ordinary `extract` dispatcher below, so a const hidden behind
 *  an `if` in the loop body surfaces as a visible `choice` alt exactly the
 *  way buildFan's own fold-collapse guard keeps it visible. */
function buildRecursionFan(
  fold: TailFold,
  fn: DefineFn,
  calleeScope: Scope,
  allArgs: readonly CoreForm[],
  ctx: ExtractCtx,
): StaticProv {
  const seedArg = allArgs[fold.accParamIndex]!;
  const collection = extract(seedArg, ctx);
  const element: StaticProv = { kind: "mux", site: fn.id, key: null, source: collection };

  const names = new Map<string, Bound>();
  fn.params.forEach((p, i) => {
    names.set(p.name, i === fold.accParamIndex ? { tag: "prov", prov: element } : { tag: "expr", expr: allArgs[i]!, scope: ctx.scope });
  });
  const frame: Scope = { names, parent: calleeScope };
  const reducing = new Set(ctx.reducing).add(fn);
  const body = extract(fold.updateExpr, { ...ctx, scope: frame, reducing });

  return { kind: "fan", site: fn.id, collection, body, collapse: "lowered" };
}

// ── known-head dispatch (path 3 — a free Ref, resolved via the registry) ────────

function dispatchKnownHead(form: App, head: HeadClass, name: string, ctx: ExtractCtx): StaticProv {
  const hasKwargs = form.kwargs.length > 0;
  const folded = (): readonly CoreForm[] => [...form.positionalArgs, ...form.kwargs.map((kw) => kw.value)];

  switch (head.role) {
    case "fuse":
      return { kind: "fused", site: form.id, sources: folded().map((a) => extract(a, ctx)) };
    case "string":
      return { kind: "string", site: form.id, runs: folded().map((a) => extract(a, ctx)) };
    case "choice": {
      const provs = folded().map((a) => extract(a, ctx));
      return { kind: "choice", site: form.id, guards: provs.slice(0, -1), alts: provs };
    }
    case "mint":
      return {
        kind: "mint",
        site: form.id,
        head: name,
        integrity: head.integrity,
        closed: folded().map((a) => extract(a, ctx)),
      };
    case "mux":
      return hasKwargs ? opaque(form.id, "kwargs-unsupported-head") : dispatchMux(form, head, name, ctx);
    case "build": {
      if (hasKwargs) return opaque(form.id, "kwargs-unsupported-head");
      // NUMERIC positional keys, always — regardless of `ctor` (pair/vector/
      // both alias here; `dict` reaches ARM-C's own `extractContainer`
      // instead, never this arm — arm-containers.ts's BUILD_HEADS comment).
      // A `cons`'s two parts are keyed 0/1, NOT "car"/"cdr" — those are the
      // ACCESSOR's own self-key, a DIFFERENT alphabet (`dispatchMux`'s "self"
      // arm below). `(car (cons a b))` therefore mux-projects a STRING key
      // against these NUMERIC part keys — zero matches, always — which
      // circuit-verdict.ts's mux case reads as sound-but-conservative
      // (opaque/not-attestable), never a forge. See
      // src/__tests__/verdict/circuit-verdict.test.ts's "car/cdr accessors
      // vs container builds" describe block for the worked example.
      const parts = form.positionalArgs.map((a, i) => ({ key: i, prov: extract(a, ctx) }));
      return { kind: "build", site: form.id, ctor: head.ctor, parts };
    }
    case "fan":
      return hasKwargs ? opaque(form.id, "kwargs-unsupported-head") : dispatchFan(form, head.fanKind, ctx);
    case "opaque":
      return hasKwargs && form.positionalArgs.length === 0
        ? opaque(form.id, "kwargs-only-call")
        : opaque(form.id, head.reason);
  }
}

/** `keyArg: "self"` — a fixed unary projection (`car`/`cdr`/`first`/`rest`): the
 *  key IS the head's own name, the source is the one operand. Otherwise
 *  `keyArg` names which positional slot supplies the key; the OTHER slot (the
 *  container) is the source. Static key iff that slot is itself a Lit
 *  string/number — else null, "still a projection, coarser" (static-prov.ts's
 *  own words for MuxProv.key). Out-of-range indices (a malformed/short call to
 *  a mux head) fail closed rather than index off the array. */
function dispatchMux(form: App, head: Extract<HeadClass, { role: "mux" }>, name: string, ctx: ExtractCtx): StaticProv {
  const args = form.positionalArgs;
  if (head.keyArg === "self") {
    // STRING self-key (the head's own name — "car"/"cdr"/"first"/"rest"), a
    // DIFFERENT alphabet than the generic "build" case's NUMERIC positional
    // keys above: a `cons`'s parts are keyed 0/1, so `(car (cons a b))`
    // filters "car" against {0,1} — zero matches, always. Sound-but-
    // conservative (never a forge — see the "build" case's comment above and
    // circuit-verdict.ts's mux case, the 0-hits fail-closed-to-opaque
    // fallback), not a bug to "fix" by changing either alphabet: it is the
    // documented intended behavior for this primitives-materialization idiom.
    return args.length === 1
      ? { kind: "mux", site: form.id, key: name, source: extract(args[0]!, ctx) }
      : opaque(form.id, "mux-arity");
  }
  const keyIdx = head.keyArg;
  const sourceIdx = keyIdx === 0 ? 1 : 0;
  if (keyIdx < 0 || keyIdx >= args.length || sourceIdx >= args.length) return opaque(form.id, "mux-arity");
  return { kind: "mux", site: form.id, key: staticKeyOf(args[keyIdx]!), source: extract(args[sourceIdx]!, ctx) };
}

function staticKeyOf(f: CoreForm): string | number | null {
  if (f.kind !== "Lit") return null;
  if (f.value.kind === "string") return f.value.value;
  if (f.value.kind === "number") return Number(f.value.text);
  return null;
}

/** `(map f coll)`/`(filter p coll)`: fnArg=arg0, coll=arg1, init=null.
 *  `(fold op init coll)`: fnArg=arg0, init=extract(arg1), coll=arg2. `buildFan`
 *  (ARM-C, treated as an opaque black box here) resolves/beta-reduces `fnArg`
 *  itself — it wants the raw CoreForm, not a pre-extracted attribution. */
function dispatchFan(form: App, fanKind: "map" | "filter" | "fold", ctx: ExtractCtx): StaticProv {
  const args = form.positionalArgs;
  if (fanKind === "fold") {
    if (args.length !== 3) return opaque(form.id, "fan-arity");
    return buildFan("fold", form.id, args[0]!, extract(args[2]!, ctx), extract(args[1]!, ctx), ctx);
  }
  if (args.length !== 2) return opaque(form.id, "fan-arity");
  return buildFan(fanKind, form.id, args[0]!, extract(args[1]!, ctx), null, ctx);
}
