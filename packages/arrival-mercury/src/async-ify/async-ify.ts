/**
 * ASYNC-IFY — the post-emit `{sync, promise}` typed dataflow over the finished Residual
 * tree (constitution §5.2 Law W; component spec async-await-plane.md, reconciled against
 * the constitution which wins on conflict).
 *
 * The one law, applied everywhere: **await lands where a promise-typed edge meets a
 * value-consuming position.** Rules never mint `Await` and never see asyncness (Law W);
 * the walker's output is sync-shaped by contract (asserted here, loudly — an input
 * `Await`/`async: true` would silently corrupt this pass's own model). Every `Await` in
 * the output is minted by this pass; the renderer's Await-inside-async assertion is the
 * downstream safety net.
 *
 * Two phases over one rule set (async-await-plane.md Mechanics 1):
 *  - Phase 1, analysis to a fixpoint: `arrowAsync: Map<Arrow|FnDecl, boolean>` — the ONLY
 *    iterated state. Monotone (`false → true`, never back) over a finite def set, so the
 *    loop terminates in ≤ N+1 passes and the least fixpoint is iteration-order-free.
 *    The per-def query reuses the phase-2 rewriter verbatim (discarding its output) and
 *    asks "did an Await land in THIS def's own region?" — one rule set, zero drift
 *    between the predicate and the rewrite.
 *  - Phase 2, rewrite exactly once under the stable map: mint `Await`s, apply the rewrite
 *    table, set `.async` (and `promiseWrap` return annotations, Mechanics 8).
 *
 * Seeds (the mission's MVP seam, superseding the spec's three-valued `RuntimeAsyncSeeds`):
 * `asyncSeeds` is the SET of `RuntimeRef` symbols whose runtime returns a promise —
 * membership ⇒ promise, absence ⇒ sync. This is sound *because of the identity fast-path*:
 * when no seed symbol occurs in the unit at all, the program is whole-program promise-free
 * (rules never mint Await; arrival has no other promise source), so `asyncIfy` returns the
 * unit UNCHANGED — treating absent-from-seeds shims as sync is then exact, not optimistic.
 * Once a seed fires anywhere, promises exist, and the genuinely-unknown edges (calls
 * through parameters / computed callees) over-await — `await x` on a non-promise is the
 * JS spec's identity, so the failure mode is Law F's "uglier, never wrong".
 *
 * Rewrite table (what plain insertion can't fix):
 *  - `Method(xs, "map", [f])` with a non-sync callback → `Await(Promise.all(xs.map(f')))`,
 *    collapsed AT THE NODE (not at the eventual consuming edge — same resolved value,
 *    strictly less propagation machinery; the value leaves the node already resolved, which
 *    is exactly the interpreter's own semantics). Fires on `unknown` callbacks too: `.map`
 *    has already dispatched every call eagerly by the time any rewrite could run, so
 *    collapsing costs nothing when the callback was sync and prevents a leaked
 *    `Promise[]` when it wasn't (over-await polarity, Mechanics 7).
 *  - `ArrayLit` with ≥2 KNOWN-promise siblings → one `Await(Promise.all([...]))` — the
 *    §2.3 by-right parallelization, structural case only. Only `callType === "promise"`
 *    elements batch (seed-rooted, i.e. pure-source by this wave's registry); unknown edges
 *    await individually and sequentially — parallelizing a possibly-sink callee is not
 *    by-right (§2.3: sinks pin program order).
 *  - `Cond` JOINS its branches (`Promise<T> | T` just awaits at the consuming edge —
 *    a single `Await` around the whole conditional; over-await on the sync arm is identity).
 *  - `filter`/`every`/`some` with a promise-typed predicate → door (`AsyncIfyDoorError`):
 *    a promise is always truthy, so the un-rewritten shape silently keeps everything;
 *    the faithful fix is statement-shaped (spec Mechanics 3) and out of this wave.
 *
 * Scope pins (this wave, documented deviations from the full spec):
 *  - The aliased-RuntimeRef HOF form (`Call(chase→RuntimeRef("map"), [f, xs])`) is not
 *    recognized — only the `Method` shape Phase-1 rules emit.
 *  - `Method`'s own result is `"sync"` per the spec's table — a promise-returning method
 *    on a receiver is not seedable this wave (seeds key `RuntimeRef` call targets only).
 *  - `Promise` is referenced as a plain global `Ref`; the walker's module frame
 *    pre-seeds "Promise" (landed with the FRAME wave), so a user binding cleaning to
 *    `Promise` disambiguates to `Promise_2` instead of shadowing these rewrites.
 *  - No state-hoisting temps around awaits (constitution §5.2's immutability dividend):
 *    pure subexpressions inline directly across suspension points — this pass only ever
 *    wraps existing edges (`g(xs[0], await f(x))`), never restructures around them.
 */
import type { Binding, CompilationUnit, Decl, NodeId, R, TsType } from "../residual/types.js";
import { Binding as mkBinding, Call, Member, Ref } from "../residual/types.js";

/** A compile-time refusal from the rewrite table (the post-emission analogue of
 *  `EmitCtx.door` / `WalkDoorError`): the two doored cells are shapes this pass can
 *  neither insert nor rewrite into correctness, only refuse loudly. */
export class AsyncIfyDoorError extends Error {
  readonly origin?: NodeId;
  constructor(code: string, reason: string, origin?: NodeId) {
    super(`async-ify door: ${code} — ${reason}`);
    this.name = "AsyncIfyDoorError";
    this.origin = origin;
  }
}

export interface AsyncIfyOptions {
  /** `RuntimeRef` symbols whose runtime target returns a promise (the "infer" family).
   *  The set is an input this wave; the runtime-shim registration owns it later. */
  readonly asyncSeeds: ReadonlySet<string>;
}

type AsyncType = "sync" | "promise" | "unknown";

/** A defining node — the key space of `arrowAsync`. Local functions are always
 *  `Const`+`Arrow` in this algebra, so `Arrow` is the only nested boundary. */
type FnDef = Extract<R, { t: "Arrow" }> | Extract<Decl, { t: "FnDecl" }>;

type DefEntry =
  | { readonly kind: "fn"; readonly def: FnDef }
  | { readonly kind: "alias"; readonly to: Binding }
  | { readonly kind: "runtime"; readonly symbol: string };

type BlockR = Extract<R, { t: "Block" }>;

const PROMISE = mkBinding("Promise");

const promiseWrap = (ty: TsType): TsType => ({ k: "ref", name: "Promise", args: [ty] });

/** `Comment`/`Annotated` are transparent for every fact this pass reads. */
const unwrap = (n: R): R => {
  let cur = n;
  while (cur.t === "Comment" || cur.t === "Annotated") cur = cur.t === "Comment" ? cur.node : cur.value;
  return cur;
};

/**
 * THE pass. Runs once, after emission is otherwise finished (every rule fired) and
 * before render. Pure: the input unit is never mutated; when no seed symbol occurs in
 * the unit the SAME reference is returned (the identity fast-path — see module header
 * for why that fast-path is what makes set-shaped seeds sound).
 */
export function asyncIfy(unit: CompilationUnit, opts: AsyncIfyOptions): CompilationUnit {
  const seeds = opts.asyncSeeds;

  // ── pre-pass: collect defs, Const-bound definitions, and the Law W input contract ──

  const defs: FnDef[] = [];
  const defSet = new Set<FnDef>();
  const defOf = new Map<object, DefEntry>(); // keyed by Binding IDENTITY (namer mints one per decl)
  let seedFired = false;

  const lawW = (what: string, origin?: NodeId): never => {
    throw new AsyncIfyDoorError(
      "law-w/input-not-sync-shaped",
      `input residual carries ${what} — rules and the walker never mint asyncness (constitution §5.2); ` +
        `asyncIfy must be the first and only pass to introduce it.`,
      origin,
    );
  };

  const registerDef = (d: FnDef): void => {
    if (defSet.has(d)) return;
    defSet.add(d);
    defs.push(d);
  };

  /** Associate a `Const`/`ConstDecl` binding with what it names — a definition this
   *  pass can chase from a callee `Ref`. `Let` bindings are deliberately NOT associated:
   *  they are TCO loop machinery, reassignable via `Assign`, so a chase through one
   *  could go stale — unresolved ⇒ `unknown` ⇒ over-await, the safe direction. */
  const associate = (binding: object, init: R): void => {
    const core = unwrap(init);
    if (core.t === "Arrow") defOf.set(binding, { kind: "fn", def: core });
    else if (core.t === "Ref") defOf.set(binding, { kind: "alias", to: core.binding });
    else if (core.t === "RuntimeRef") defOf.set(binding, { kind: "runtime", symbol: core.symbol });
  };

  const collect = (n: R): void => {
    switch (n.t) {
      case "Await":
        return lawW("an `Await`", n.origin);
      case "Arrow":
        if (n.async === true) lawW("`async: true` on an Arrow", n.origin);
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
        if (d.async === true) lawW("`async: true` on a FnDecl", d.origin);
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

  // The identity fast-path: no seed occurs anywhere ⇒ the program is whole-program
  // promise-free ⇒ nothing to do, and "unknown" edges are exactly sync. Same reference.
  if (!seedFired || seeds.size === 0) return unit;

  // ── the facts (async-await-plane.md Owned interfaces), read against the LIVE map ──

  const arrowAsync = new Map<FnDef, boolean>(defs.map((d) => [d, false]));

  /** What does INVOKING `callee` yield? `Ref`s chase bare-`Const` alias chains to a
   *  known definition or a runtime symbol; anything unresolvable is `"unknown"` —
   *  resolved toward promise only at a consuming edge, never cached as a fact. */
  const callType = (callee: R): AsyncType => {
    const c = unwrap(callee);
    switch (c.t) {
      case "RuntimeRef":
        return seeds.has(c.symbol) ? "promise" : "sync";
      case "Arrow":
        return arrowAsync.get(c) === true ? "promise" : "sync";
      case "Ref": {
        const seen = new Set<object>();
        let cur: object = c.binding;
        for (;;) {
          if (seen.has(cur)) return "unknown";
          seen.add(cur);
          const e = defOf.get(cur);
          if (e === undefined) return "unknown"; // parameter / untracked — over-await at the edge
          if (e.kind === "fn") return arrowAsync.get(e.def) === true ? "promise" : "sync";
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

  /** What does EVALUATING this node yield, right now? `Ref` is ALWAYS sync — by the time
   *  a value is bound, every ordinary binding position has already resolved it; holding a
   *  function value is sync regardless of what CALLING it yields (the spec's boxed note —
   *  `callType`, above, is the only place `arrowAsync` is consulted). A `Block` is sync:
   *  the renderer awaits its async IIFE inline, so the VALUE the position sees is settled. */
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
        return "sync"; // incl. Method/New per the spec's table — see module-header scope pins
    }
  };

  // ── the rewriter — ONE rule set, used as phase-1 query and phase-2 rewrite ──────────

  const mintAwait = (value: R): R => ({ t: "Await", value, origin: value.origin });

  /** A value-consuming position: the parent reads THROUGH the child's resolved value.
   *  Promise (and unknown, resolved pessimistically here and only here) ⇒ mint `Await`. */
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
        // Bare expression statement: the value is discarded, but the interpreter still
        // RESOLVES it (its evaluation is complete before the next form) — consume, so a
        // promise-typed statement settles in program order instead of firing-and-forgetting.
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
        // Callee is invoked, not read-through — pass-through (a promise-valued callee is
        // deliberately unhandled: no rule produces one; spec Open Q 1). Args are eager
        // concrete values (Scheme's strict evaluation) — consumed.
        return { ...n, callee: rewriteExpr(n.callee), args: n.args.map(consume) };
      case "Method": {
        const recv = consume(n.recv);
        if (n.name === "map" && n.args.length === 1 && callType(n.args[0]!) !== "sync") {
          // The async-map collapse (rewrite table): a bare Await on Promise<T>[] is
          // identity — only Promise.all collapses per-element. Callback slot is
          // CONSULTED (callType), never consumed — rewritten without an edge-await.
          const inner: R = { ...n, recv, args: [rewriteExpr(n.args[0]!)] };
          return mintAwait(Call(Member(Ref(PROMISE), "all"), [inner]));
        }
        if ((n.name === "filter" || n.name === "every" || n.name === "some") && n.args.length >= 1) {
          if (callType(n.args[0]!) === "promise") {
            throw new AsyncIfyDoorError(
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
        // Uniform consumption incl. &&/||/?? — `await` completes where written, before
        // the operator decides; short-circuit order is unchanged (spec's ⚖️ Bin note).
        return { ...n, left: consume(n.left), right: consume(n.right) };
      case "Un":
        return { ...n, arg: consume(n.arg) };
      case "Cond":
        // Branches are JOINED, never consumed — one Await lands around the whole Cond at
        // whatever edge consumes it (the `Promise<T> | T` union case, free).
        return { ...n, test: consume(n.test), then: rewriteExpr(n.then), else: rewriteExpr(n.else) };
      case "Arrow": {
        const isAsync = arrowAsync.get(n) === true;
        // An expression body IS the return value — a consuming position, same as `Return`.
        const body = n.body.t === "Block" ? rewriteBlock(n.body) : consume(n.body);
        return { ...n, body, async: isAsync ? true : n.async };
      }
      case "ArrayLit": {
        // §2.3 by-right parallelization, structural case: ≥2 KNOWN-promise siblings in one
        // literal → one Promise.all. Unknown edges stay sequential-awaited (module header).
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
        // Spreading a pending promise throws — the iterable must already be concrete.
        return { ...n, value: consume(n.value) };
      case "Block":
        return rewriteBlock(n);
      case "Comment":
        return { ...n, node: rewriteExpr(n.node) };
      case "Annotated": {
        const value = rewriteExpr(n.value);
        // Mechanics 8: the two planes meet only at render — the Scheme-semantics type
        // (never Promise-shaped, Law V) is wrapped iff THIS pass flipped the arrow.
        const type = n.value.t === "Arrow" && arrowAsync.get(n.value) === true ? promiseWrap(n.type) : n.type;
        return { ...n, value, type };
      }
      case "Await":
        return lawW("an `Await`", n.origin); // unreachable after collect — defense-in-depth
      default:
        // Statement-only kinds cannot occupy an expression position (the walker's
        // position-pinned dispatch) — route through the statement rules defensively.
        return rewriteStmt(n);
    }
  };

  // ── phase 1: the fixpoint (monotone, finite, order-free — Mechanics 1) ─────────────

  /** An Await reachable without crossing a nested Arrow boundary belongs to THIS def —
   *  the renderer's own containsAwait rule, mirrored (Block/While/loop bodies are
   *  transparent, so one verdict governs both TCO renderings — Mechanics 5). */
  const containsAwaitShallow = (n: R): boolean => {
    if (n.t === "Await") return true;
    if (n.t === "Arrow") return false;
    return childrenOf(n).some(containsAwaitShallow);
  };

  const bodyNeedsAsync = (d: FnDef): boolean => {
    const body: R = d.body; // FnDecl.body is always a Block; Arrow.body may be an expression
    const rewritten = body.t === "Block" ? rewriteBlock(body) : consume(body);
    return containsAwaitShallow(rewritten);
  };

  let changed = true;
  while (changed) {
    changed = false;
    for (const d of defs) {
      if (arrowAsync.get(d) === true) continue;
      if (bodyNeedsAsync(d)) {
        arrowAsync.set(d, true);
        changed = true;
      }
    }
  }

  // ── phase 2: rewrite once, under the stable map ─────────────────────────────────────

  const rewriteDecl = (d: Decl): Decl => {
    switch (d.t) {
      case "FnDecl": {
        const isAsync = arrowAsync.get(d) === true;
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
    decls: unit.decls.map(rewriteDecl),
    // Module top level is TLA-legal (the renderer threads insideAsync=true there) — a
    // top-level Await needs no enclosing def to flip.
    body: unit.body.map(rewriteStmt),
  };
}

/** Structural children of an `R` node — the renderer's `rChildren`, mirrored (it is not
 *  exported; the two must agree on Arrow being the ONLY function boundary). */
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
