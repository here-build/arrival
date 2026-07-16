/**
 * ASYNCNESS — E1c's cut-over (engine plan §2 E1c; docs/working-proposals/
 * arrival-mercury/async-await-plane.md's Mechanics 1-8). Asyncness becomes a
 * MODEL FACT (`SchemeSemanticModel.asyncnessOf`, model.ts) instead of a
 * post-emit rewriting pass; the dissolved `async-ify/async-ify.ts` is
 * deleted entirely. Its two-phase mechanism survives byte-for-byte, split
 * across two entry points so the ANALYSIS becomes a pure, queryable view and
 * the REWRITE stays a positioned pipeline step:
 *
 *  - `asyncnessOf(unit, seeds)` — Phase 1, ported verbatim: the call-graph
 *    fixpoint (declared-bottom iteration; monotone over the finite
 *    Arrow/FnDecl def set; terminates in ≤ N+1 passes — the SAME proof,
 *    unchanged) confined entirely inside this function. Returns
 *    `AsyncnessFacts` — pure per-node `typeOf`/`callType` and per-def
 *    `arrowAsync` reads against the now-stable fixpoint. Never mutates
 *    `unit`. `SchemeSemanticModel` wraps this verbatim as `sm.asyncnessOf`
 *    (model.ts) — a future LSP consumer (inlay hints: "this call awaits")
 *    reads it without ever paying for the rewrite below.
 *  - `materializeAsyncness(facts)` — Phase 2, ported verbatim: mint `Await`
 *    at every consuming position, apply the rewrite table (the `.map` →
 *    `Promise.all` collapse, the ArrayLit by-right batch, the
 *    filter/every/some door), set `.async`. A PURE READER of `facts` — the
 *    SAME `typeOf`/`callType`/`arrowAsync` closures `asyncnessOf` already
 *    computed feed BOTH phases (via the shared `makeRewriter` below, one
 *    rule set, zero drift between the predicate and the rewrite — the
 *    dissolved pass's own claim, preserved); nothing here re-derives the
 *    fixpoint. Positioned in the real pipeline (oracle/harness.ts) exactly
 *    where the dissolved `asyncIfy` ran — after LEGIBILITY, before
 *    `naming/imports.ts`'s `materializeImports` (see that module's header
 *    for the updated ordering note: this materializer's OWN seed detection
 *    keys off `RuntimeRef` symbol names exactly like the dissolved pass did,
 *    so the RuntimeRef→Ref commit still has to wait for it — the constraint
 *    is INHERITED, not dissolved, just re-attributed to this module).
 *
 * Why split the analysis out at all, given both phases still run back-to-
 * back in the real pipeline today: S4's own framing ("the model must answer
 * per-keystroke... even though the LSP consumers wire in later") — a view
 * reachable only by ALSO paying for the tree rewrite isn't a real view.
 * Splitting costs nothing here: Phase 1 and Phase 2 always shared one rule
 * set (the dissolved async-ify.ts's own header: "the per-def query reuses
 * the phase-2 rewriter verbatim, discarding its output") — `makeRewriter`
 * below IS that one rule set, parameterized over an oracle
 * (`typeOf`/`callType`/`arrowAsync`) instead of closing over a specific
 * mutable-then-frozen map, so both phases call the IDENTICAL
 * `rewriteExpr`/`rewriteStmt` implementation and can never drift apart.
 *
 * Seeds (unchanged, ported verbatim — the mission's MVP seam, the dissolved
 * async-ify.ts's own header): `seeds` is the SET of `RuntimeRef` symbols
 * whose runtime target returns a promise (today: `inferAsyncSeeds`,
 * rules/phase1.ts) — membership ⇒ promise, absence ⇒ sync. Sound because of
 * the identity fast-path: when no seed symbol occurs anywhere in `unit`, the
 * program is whole-program promise-free (rules/walker output is sync-shaped
 * by Law W; arrival has no other promise source), so treating every
 * absent-from-seeds shim as sync is exact, not optimistic —
 * `materializeAsyncness` returns `facts.unit` UNCHANGED (same reference) in
 * that case, exactly like the dissolved pass did.
 *
 * Scope pins (ported verbatim from the dissolved pass — still this wave's
 * documented deviations from the full spec, docs/working-proposals/
 * arrival-mercury/async-await-plane.md):
 *  - The aliased-RuntimeRef HOF form (`Call(chase→RuntimeRef("map"), [f,
 *    xs])`) is not recognized — only the `Method` shape Phase-1 rules emit.
 *  - `Method`'s own result is `"sync"` per the spec's table — a
 *    promise-returning method on a receiver is not seedable this wave
 *    (seeds key `RuntimeRef` call targets only).
 *  - `Promise` is referenced as a plain global `Ref`; the walker's module
 *    frame pre-seeds "Promise", so a user binding cleaning to `Promise`
 *    disambiguates to `Promise_2` instead of shadowing these rewrites.
 *  - No state-hoisting temps around awaits (constitution §5.2's immutability
 *    dividend): pure subexpressions inline directly across suspension
 *    points — this pass only ever wraps existing edges, never restructures
 *    around them.
 */
import type { Binding, CompilationUnit, Decl, NodeId, R, TsType } from "../residual/types.js";
import { Binding as mkBinding, Call, Member, Ref } from "../residual/types.js";

/**
 * A compile-time refusal — the rewrite table's two doored cells
 * (filter/every/some meeting a promise-typed callback), or Law W's
 * input-contract assert (a pre-existing `Await`/`async: true` — rules and
 * the walker are sync-shaped by construction; `asyncnessOf`/
 * `materializeAsyncness` must be the first and only place asyncness is
 * introduced). Ported verbatim from the dissolved `AsyncIfyDoorError`,
 * renamed for this module's new home; the message CODES (e.g.
 * `filter-async-predicate`, `law-w/input-not-sync-shaped`) are unchanged —
 * only the class name and the door-message prefix ("asyncness door:" in
 * place of "async-ify door:") reflect the new home.
 */
export class AsyncnessDoorError extends Error {
  readonly origin?: NodeId;
  constructor(code: string, reason: string, origin?: NodeId) {
    super(`asyncness door: ${code} — ${reason}`);
    this.name = "AsyncnessDoorError";
    this.origin = origin;
  }
}

/** The lattice — one bit, plus the transient `"unknown"` that only ever
 *  arises mid-analysis (never stored as a final fact — resolved toward
 *  `"promise"` at the one consuming edge that reads it, the over-await
 *  fallback). */
export type AsyncType = "sync" | "promise" | "unknown";

/** A defining node — the key space `arrowAsync` answers over. Local
 *  functions are always `Const`+`Arrow` in this algebra, so `Arrow` is the
 *  only nested boundary. */
export type FnDef = Extract<R, { t: "Arrow" }> | Extract<Decl, { t: "FnDecl" }>;

/**
 * The stable fact surface — Phase 1's output, and `SchemeSemanticModel.
 * asyncnessOf`'s (model.ts) return type. Pure queries against a fixed
 * `unit`; nothing here mutates or rewrites a tree.
 */
export interface AsyncnessFacts {
  /** The tree these facts were computed over. `materializeAsyncness` reads
   *  this rather than take a second, independently-suppliable `unit`
   *  parameter, so a caller cannot accidentally apply one program's facts
   *  to a different program's tree — every fact here is keyed by NODE
   *  IDENTITY from this exact `unit`, and would silently under-answer
   *  ("unknown"/not-async) against any other tree. */
  readonly unit: CompilationUnit;
  /** Is this Arrow/FnDecl definition async — the fixpoint's final answer. */
  readonly arrowAsync: (def: FnDef) => boolean;
  /** What does EVALUATING this node yield, right now? A `Ref` is always
   *  `"sync"` — see `makeRewriter`'s boxed note below. */
  readonly typeOf: (node: R) => AsyncType;
  /** What does INVOKING `callee` yield — only meaningful in `Call`/`Method`
   *  callee position. */
  readonly callType: (callee: R) => AsyncType;
  /** `false` iff no seed symbol occurs anywhere in `unit` — the
   *  identity-fast-path flag `materializeAsyncness` reads instead of
   *  re-walking the tree (mirrors the dissolved pass's own `seedFired`). */
  readonly hasAsync: boolean;
}

type DefEntry =
  | { readonly kind: "fn"; readonly def: FnDef }
  | { readonly kind: "alias"; readonly to: Binding }
  | { readonly kind: "runtime"; readonly symbol: string };

type BlockR = Extract<R, { t: "Block" }>;

const PROMISE = mkBinding("Promise");

const promiseWrap = (ty: TsType): TsType => ({ k: "ref", name: "Promise", args: [ty] });

/** `Comment`/`Annotated` are transparent for every fact this pass reads. */
function unwrap(n: R): R {
  let cur = n;
  while (cur.t === "Comment" || cur.t === "Annotated") cur = cur.t === "Comment" ? cur.node : cur.value;
  return cur;
}

/** Structural children of an `R` node — mirrors the renderer's `rChildren`
 *  (not exported; must agree with it on Arrow being the ONLY function
 *  boundary). This module's OWN independent copy, per this package's
 *  established "each pass owns its childrenOf" convention (legibility/
 *  tree.ts's header names the walker's, FRAME's, and the dissolved
 *  async-ify's own copies as the precedent) — this is that copy's new home,
 *  not a net-new fifth one. */
function childrenOf(node: R): readonly R[] {
  switch (node.t) {
    case "Ref":
    case "RuntimeRef":
    case "Lit":
    case "Continue":
      return [];
    case "Template":
      return node.exprs;
    case "Call":
    case "New":
      return [node.callee, ...node.args];
    case "Method":
      return [node.recv, ...node.args];
    case "Index":
      return [node.recv, node.index];
    case "Member":
      return [node.recv];
    case "Bin":
      return [node.left, node.right];
    case "Un":
      return [node.arg];
    case "Cond":
      return [node.test, node.then, node.else];
    case "Arrow":
      return [node.body];
    case "ArrayLit":
      return node.elements;
    case "ObjectLit":
      return node.entries.map((e) => e.value);
    case "Spread":
    case "Await":
    case "Throw":
      return [node.value];
    case "Block":
      return node.stmts;
    case "Const":
    case "Let":
      return [node.init];
    case "Assign":
      return [node.value];
    case "Return":
      return node.value === undefined ? [] : [node.value];
    case "While":
      return [node.test, node.body];
    case "ForOf":
      return [node.iterable, node.body];
    case "If":
      return node.else === undefined ? [node.test, node.then] : [node.test, node.then, node.else];
    case "Comment":
      return [node.node];
    case "Annotated":
      return [node.value];
  }
}

/** Law W's input contract, shared by `asyncnessOf`'s own collection walk and
 *  `makeRewriter`'s defensive `Await` case (unreachable after collection —
 *  defense in depth, ported verbatim). */
function lawWViolation(what: string, origin?: NodeId): never {
  throw new AsyncnessDoorError(
    "law-w/input-not-sync-shaped",
    `input residual carries ${what} — rules and the walker never mint asyncness (constitution §5.2); ` +
      `asyncnessOf/materializeAsyncness must be the first and only place it is introduced.`,
    origin,
  );
}

/**
 * THE rule set (async-await-plane.md Mechanics 2/3), parameterized over an
 * oracle instead of closing over a specific mutable/frozen map — the ONE
 * implementation both `asyncnessOf`'s throwaway Phase-1 query and
 * `materializeAsyncness`'s real Phase-2 rewrite call, so the two can never
 * drift apart.
 *
 * ── The subtlety this design almost got wrong (ported verbatim) ──
 * It is tempting to say "`Ref(b)`'s type is `arrowAsync(b)` when `b` names a
 * function." That conflates two different questions: holding/aliasing a
 * function value (always sync — a function object is never a promise) with
 * CALLING it (which needs `arrowAsync`). Because every ordinary
 * `Const`/`Let` already forces its `init` to resolve, a ready-bound `Ref` is
 * trivially sync for ANY binding — data or function. `callType`, not
 * `typeOf`, is the only place `arrowAsync` is consulted, and only in
 * `Call`/`Method` callee position.
 */
function makeRewriter(oracle: Pick<AsyncnessFacts, "typeOf" | "callType" | "arrowAsync">) {
  const { typeOf, callType, arrowAsync } = oracle;
  const mintAwait = (value: R): R => ({ t: "Await", value, origin: value.origin });

  /** A value-consuming position: the parent reads THROUGH the child's
   *  resolved value. Promise (and unknown, resolved pessimistically here
   *  and only here) ⇒ mint `Await`. */
  const consume = (n: R): R => {
    const r = rewriteExpr(n);
    return typeOf(n) === "sync" ? r : mintAwait(r);
  };

  const rewriteBlock = (b: BlockR): BlockR => ({ ...b, stmts: b.stmts.map(rewriteStmt) });

  const rewriteStmt = (n: R): R => {
    switch (n.t) {
      case "Const":
      case "Let":
        return { ...n, init: consume(n.init) };
      case "Assign":
        return { ...n, value: consume(n.value) };
      case "Return":
        return n.value === undefined ? n : { ...n, value: consume(n.value) };
      case "While":
        return { ...n, test: consume(n.test), body: rewriteBlock(n.body) };
      case "ForOf":
        return { ...n, iterable: consume(n.iterable), body: rewriteBlock(n.body) };
      case "If":
        return {
          ...n,
          test: consume(n.test),
          then: rewriteBlock(n.then),
          else: n.else === undefined ? undefined : rewriteStmt(n.else),
        };
      case "Throw":
        return { ...n, value: consume(n.value) };
      case "Continue":
        return n;
      case "Block":
        return rewriteBlock(n);
      case "Comment":
        return { ...n, node: rewriteStmt(n.node) };
      default:
        // Bare expression statement: the value is discarded, but the
        // interpreter still RESOLVES it (its evaluation is complete before
        // the next form) — consume, so a promise-typed statement settles in
        // program order instead of firing-and-forgetting.
        return consume(n);
    }
  };

  const rewriteExpr = (n: R): R => {
    switch (n.t) {
      case "Ref":
      case "RuntimeRef":
      case "Lit":
        return n;
      case "Template":
        return { ...n, exprs: n.exprs.map(consume) };
      case "Call":
      case "New":
        // Callee is invoked, not read-through — pass-through (a
        // promise-valued callee is deliberately unhandled: no rule produces
        // one). Args are eager concrete values (Scheme's strict evaluation)
        // — consumed.
        return { ...n, callee: rewriteExpr(n.callee), args: n.args.map(consume) };
      case "Method": {
        const recv = consume(n.recv);
        if (n.name === "map" && n.args.length === 1 && callType(n.args[0]!) !== "sync") {
          // The async-map collapse (rewrite table): a bare Await on
          // Promise<T>[] is identity — only Promise.all collapses
          // per-element. Callback slot is CONSULTED (callType), never
          // consumed — rewritten without an edge-await.
          const inner: R = { ...n, recv, args: [rewriteExpr(n.args[0]!)] };
          return mintAwait(Call(Member(Ref(PROMISE), "all"), [inner]));
        }
        if ((n.name === "filter" || n.name === "every" || n.name === "some") && n.args.length >= 1) {
          if (callType(n.args[0]!) === "promise") {
            throw new AsyncnessDoorError(
              `${n.name}-async-predicate`,
              `\`.${n.name}\` over a promise-returning predicate cannot be compiled faithfully — a pending ` +
                `promise is always truthy, so the un-rewritten shape silently ${
                  n.name === "filter" ? "keeps every element" : "answers as if every test passed"
                }` +
                `${n.name === "filter" ? "" : ", and short-circuiting is real behavior a Promise.all rewrite would change"}. ` +
                `Keep the predicate synchronous, or lift the async step out: map first, then ${n.name} on the resolved values.`,
              n.origin,
            );
          }
        }
        return { ...n, recv, args: n.args.map(consume) };
      }
      case "Index":
        return { ...n, recv: consume(n.recv), index: consume(n.index) };
      case "Member":
        return { ...n, recv: consume(n.recv) };
      case "Bin":
        // Uniform consumption incl. &&/||/?? — `await` completes where
        // written, before the operator decides; short-circuit order is
        // unchanged.
        return { ...n, left: consume(n.left), right: consume(n.right) };
      case "Un":
        return { ...n, arg: consume(n.arg) };
      case "Cond":
        // Branches are JOINED, never consumed — one Await lands around the
        // whole Cond at whatever edge consumes it (the `Promise<T> | T`
        // union case, free).
        return { ...n, test: consume(n.test), then: rewriteExpr(n.then), else: rewriteExpr(n.else) };
      case "Arrow": {
        const isAsync = arrowAsync(n);
        // An expression body IS the return value — a consuming position,
        // same as `Return`.
        const body = n.body.t === "Block" ? rewriteBlock(n.body) : consume(n.body);
        return { ...n, body, async: isAsync ? true : n.async };
      }
      case "ArrayLit": {
        // §2.3 by-right parallelization, structural case: ≥2 KNOWN-promise
        // siblings in one literal → one Promise.all. Unknown edges stay
        // sequential-awaited (module header).
        const isPar = (el: R): boolean => el.t !== "Spread" && typeOf(el) === "promise";
        if (n.elements.filter(isPar).length >= 2) {
          const elements = n.elements.map((el) => (isPar(el) ? rewriteExpr(el) : consume(el)));
          return mintAwait(Call(Member(Ref(PROMISE), "all"), [{ ...n, elements }]));
        }
        return { ...n, elements: n.elements.map(consume) };
      }
      case "ObjectLit":
        return { ...n, entries: n.entries.map((e) => ({ ...e, value: consume(e.value) })) };
      case "Spread":
        // Spreading a pending promise throws — the iterable must already be
        // concrete.
        return { ...n, value: consume(n.value) };
      case "Block":
        return rewriteBlock(n);
      case "Comment":
        return { ...n, node: rewriteExpr(n.node) };
      case "Annotated": {
        const value = rewriteExpr(n.value);
        // The two planes meet only at render — the Scheme-semantics type
        // (never Promise-shaped, Law V) is wrapped iff THIS pass flipped
        // the arrow.
        const type = n.value.t === "Arrow" && arrowAsync(n.value) === true ? promiseWrap(n.type) : n.type;
        return { ...n, value, type };
      }
      case "Await":
        return lawWViolation("an `Await`", n.origin); // unreachable after collect — defense-in-depth
      default:
        // Statement-only kinds cannot occupy an expression position (the
        // walker's position-pinned dispatch) — route through the statement
        // rules defensively.
        return rewriteStmt(n);
    }
  };

  /** An Await reachable without crossing a nested Arrow boundary belongs to
   *  THIS def — the renderer's own containsAwait rule, mirrored (Block/
   *  While/loop bodies are transparent, so one verdict governs both TCO
   *  renderings). */
  const containsAwaitShallow = (n: R): boolean => {
    if (n.t === "Await") return true;
    if (n.t === "Arrow") return false;
    return childrenOf(n).some(containsAwaitShallow);
  };

  return { consume, rewriteBlock, rewriteStmt, rewriteExpr, containsAwaitShallow };
}

/**
 * Phase 1 — THE VIEW: the fixpoint, confined entirely inside this function.
 * `SchemeSemanticModel.asyncnessOf` (model.ts) wraps this verbatim. Pure:
 * never mutates `unit`.
 */
export function asyncnessOf(unit: CompilationUnit, seeds: ReadonlySet<string>): AsyncnessFacts {
  // ── pre-pass: collect defs, Const-bound definitions, and the Law W input contract ──

  const defs: FnDef[] = [];
  const defSet = new Set<FnDef>();
  const defOf = new Map<object, DefEntry>(); // keyed by Binding IDENTITY (namer mints one per decl)
  let seedFired = false;

  const registerDef = (d: FnDef): void => {
    if (defSet.has(d)) return;
    defSet.add(d);
    defs.push(d);
  };

  /** Associate a `Const`/`ConstDecl` binding with what it names — a
   *  definition this pass can chase from a callee `Ref`. `Let` bindings are
   *  deliberately NOT associated: they are TCO loop machinery, reassignable
   *  via `Assign`, so a chase through one could go stale — unresolved ⇒
   *  `unknown` ⇒ over-await, the safe direction. */
  const associate = (binding: object, init: R): void => {
    const core = unwrap(init);
    if (core.t === "Arrow") defOf.set(binding, { kind: "fn", def: core });
    else if (core.t === "Ref") defOf.set(binding, { kind: "alias", to: core.binding });
    else if (core.t === "RuntimeRef") defOf.set(binding, { kind: "runtime", symbol: core.symbol });
  };

  const collect = (n: R): void => {
    switch (n.t) {
      case "Await":
        return lawWViolation("an `Await`", n.origin);
      case "Arrow":
        if (n.async === true) lawWViolation("`async: true` on an Arrow", n.origin);
        registerDef(n);
        collect(n.body);
        return;
      case "RuntimeRef":
        if (seeds.has(n.symbol)) seedFired = true;
        return;
      case "Const":
        if (n.pattern.t === "Binding") associate(n.pattern, n.init);
        collect(n.init);
        return;
      default:
        for (const c of childrenOf(n)) collect(c);
    }
  };
  const collectDecl = (d: Decl): void => {
    switch (d.t) {
      case "FnDecl":
        if (d.async === true) lawWViolation("`async: true` on a FnDecl", d.origin);
        registerDef(d);
        defOf.set(d.name, { kind: "fn", def: d });
        collect(d.body);
        return;
      case "ConstDecl":
        associate(d.name, d.init);
        collect(d.init);
        return;
      case "DeclComment":
        collectDecl(d.decl);
        return;
      case "Import":
      case "ImportType":
      case "Export":
        return;
    }
  };
  for (const d of unit.decls) collectDecl(d);
  for (const s of unit.body) collect(s);

  // ── the facts (async-await-plane.md Owned interfaces), read against the LIVE map ──

  const arrowAsyncMap = new Map<FnDef, boolean>(defs.map((d) => [d, false]));

  /** What does INVOKING `callee` yield? `Ref`s chase bare-`Const` alias
   *  chains to a known definition or a runtime symbol; anything unresolvable
   *  is `"unknown"` — resolved toward promise only at a consuming edge,
   *  never cached as a fact. */
  const callType = (callee: R): AsyncType => {
    const c = unwrap(callee);
    switch (c.t) {
      case "RuntimeRef":
        return seeds.has(c.symbol) ? "promise" : "sync";
      case "Arrow":
        return arrowAsyncMap.get(c) === true ? "promise" : "sync";
      case "Ref": {
        const seen = new Set<object>();
        let cur: object = c.binding;
        for (;;) {
          if (seen.has(cur)) return "unknown";
          seen.add(cur);
          const e = defOf.get(cur);
          if (e === undefined) return "unknown"; // parameter / untracked — over-await at the edge
          if (e.kind === "fn") return arrowAsyncMap.get(e.def) === true ? "promise" : "sync";
          if (e.kind === "runtime") return seeds.has(e.symbol) ? "promise" : "sync";
          cur = e.to;
        }
      }
      default:
        return "unknown"; // computed callee — over-await at the edge
    }
  };

  const join = (a: AsyncType, b: AsyncType): AsyncType =>
    a === "promise" || b === "promise" ? "promise" : a === "unknown" || b === "unknown" ? "unknown" : "sync";

  /** What does EVALUATING this node yield, right now? `Ref` is ALWAYS sync —
   *  by the time a value is bound, every ordinary binding position has
   *  already resolved it; holding a function value is sync regardless of
   *  what CALLING it yields (`callType`, above, is the only place
   *  `arrowAsync` is consulted). A `Block` is sync: the renderer awaits its
   *  async IIFE inline, so the VALUE the position sees is settled. */
  const typeOf = (n: R): AsyncType => {
    switch (n.t) {
      case "Call":
        return callType(n.callee);
      case "Cond":
        return join(typeOf(n.then), typeOf(n.else));
      case "Comment":
        return typeOf(n.node);
      case "Annotated":
        return typeOf(n.value);
      default:
        return "sync"; // incl. Method/New — see the module header's scope pins
    }
  };

  const arrowAsync = (def: FnDef): boolean => arrowAsyncMap.get(def) === true;

  // ── phase 1: the fixpoint (monotone, finite, order-free) ────────────────
  // Skipped entirely when no seed fired anywhere (the identity fast-path):
  // every `arrowAsyncMap` entry stays `false`, which is already the exact
  // correct answer (a whole-program-sync program has no async def).

  if (seedFired) {
    const rewriter = makeRewriter({ typeOf, callType, arrowAsync });
    const bodyNeedsAsync = (d: FnDef): boolean => {
      const body: R = d.body; // FnDecl.body is always a Block; Arrow.body may be an expression
      const rewritten = body.t === "Block" ? rewriter.rewriteBlock(body) : rewriter.consume(body);
      return rewriter.containsAwaitShallow(rewritten);
    };
    let changed = true;
    while (changed) {
      changed = false;
      for (const d of defs) {
        if (arrowAsyncMap.get(d) === true) continue;
        if (bodyNeedsAsync(d)) {
          arrowAsyncMap.set(d, true);
          changed = true;
        }
      }
    }
  }

  return { unit, arrowAsync, typeOf, callType, hasAsync: seedFired };
}

/**
 * Phase 2 — ported verbatim: mint `Await`s, apply the rewrite table, set
 * `.async` (and `promiseWrap` return annotations). A PURE READER of
 * `facts` — never re-derives `arrowAsync`/`typeOf`/`callType`. Identity
 * fast-path: `!facts.hasAsync` returns `facts.unit` UNCHANGED (same
 * reference).
 */
export function materializeAsyncness(facts: AsyncnessFacts): CompilationUnit {
  if (!facts.hasAsync) return facts.unit;

  const { rewriteBlock, rewriteStmt, consume } = makeRewriter(facts);

  const rewriteDecl = (d: Decl): Decl => {
    switch (d.t) {
      case "FnDecl": {
        const isAsync = facts.arrowAsync(d);
        return {
          ...d,
          body: rewriteBlock(d.body),
          async: isAsync ? true : d.async,
          returnType: isAsync && d.returnType !== undefined ? promiseWrap(d.returnType) : d.returnType,
        };
      }
      case "ConstDecl":
        return { ...d, init: consume(d.init) };
      case "DeclComment":
        return { ...d, decl: rewriteDecl(d.decl) };
      case "Import":
      case "ImportType":
      case "Export":
        return d;
    }
  };

  return {
    decls: facts.unit.decls.map(rewriteDecl),
    // Module top level is TLA-legal (the renderer threads insideAsync=true
    // there) — a top-level Await needs no enclosing def to flip.
    body: facts.unit.body.map(rewriteStmt),
  };
}
