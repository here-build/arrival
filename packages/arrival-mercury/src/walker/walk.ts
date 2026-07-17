/**
 * The ENGINE WALKER — CoreForm → sync-shaped Residual tree (constitution §3.1's EMIT
 * PASS driver, §3.5 special-form emission; component spec engine-walker.md, reconciled
 * against the constitution which wins on conflict).
 *
 * Laws enforced here:
 *  - Law T (truthiness), run-side: a condition emits bare iff `facts.boolean` proves it;
 *    otherwise the exact-Scheme guard `c !== false`. The read register always takes the
 *    clean form (§1 — glass is never executed; legibility is its correctness criterion).
 *  - Law W (await ownership): everything emitted here is SYNC-SHAPED. No `Await` is ever
 *    minted; ASYNC-IFY (a later pass/wave) owns every await.
 *  - Law F (fail-safe facts): the facts side-table defaults to empty — absence of a fact
 *    lands on the conservative residual, never the clean one.
 *  - Law A (arg-gating): registry rules receive per-argument facts, never result types.
 *  - §4.2 fallback ladder per free symbol: emit rule → eta (`rule.ref`, opt-in per
 *    symbol — R5c landed `car`'s instantiated-signature eta-expansion live; every OTHER
 *    `refPolicy: "eta"` symbol still has no `.ref` and degrades to the shim rung, Law
 *    F's value-position analog: absence of proof ⇒ conservative, never a guess) →
 *    RuntimeRef shim → door. Silence is impossible by construction. STALE-COMMENT NOTE
 *    (E3, "verify before you cite"): this bullet used to read "eta: SKIPPED this wave" —
 *    that predates R5c and was already inaccurate for `car` specifically before this
 *    wave touched the file; corrected here, not introduced by E3.
 *
 * Door materialization (the door-throw contract, wave-plan gate finding): a `Door` that
 * reaches the emitted artifact is a `Throw` residual whose message BEGINS with the
 * door's `code` ("<category>/<slug>: …") so the oracle's compiled-side classifier
 * catches every slug. Doors throw where the interpreter would — at evaluation time —
 * so a door on an untaken branch does not poison the program (interpreter parity).
 * The one compile-TIME refusal is `EmitCtx.door` (a rule declining a call site): that
 * throws `WalkDoorError` out of `walk()` itself.
 *
 * E3 — decisions, not analyses (engine plan §2 E3): the §4.2 ladder (rule / shim /
 * door) and Law T's guard form used to be decided INLINE here — `registry.lookup`
 * and `facts.get` calls scattered through `lowerApp`/`registryValueRef`/`truthTest`/
 * `lowerAndOr`. Both DECISIONS relocated to `../lowering/index.ts`
 * (`loweringDecisionAt`/`guardFormOf`, pure functions of explicit arguments) —
 * `../model/model.ts` wraps them as `sm.loweringDecisionAt`/`sm.guardFormOf`. This
 * walker now READS the two local closures `decisionFor`/`guardFor` (below), each
 * defaulting to the SAME relocated function called directly against `opts.registry`/
 * `opts.facts` when the model does not supply its own view — so every existing
 * hand-rolled-registry test in this package (never wiring `opts.loweringDecisionAt`/
 * `opts.guardFormOf`) is BYTE-IDENTICAL to before, exactly like `idiomAt`/
 * `prevalueOf`'s own "declining is always safe" default. `opts.registry` and
 * `opts.facts` therefore stay mandatory/present-by-default fields on `WalkOptions` —
 * only the WALKER's OWN body stops branching on them directly; see the S5-extended
 * lint (`model-imports-agree.test.ts`) for the mechanical check.
 *
 * E3 — the shake (engine plan §2 E3): `opts.shakeOf`, an OPTIONAL hook, prunes
 * dead-and-pure top-level `Define`/`DefineFn` forms (effectful crossings survive —
 * `../shake/index.ts`'s own header) at the SAME point `propagateTopLevelDefines`
 * already runs, unconditionally, just before it. Default `undefined` ⇒ no shake
 * ever fires — `propagateTopLevelDefines`'s own fold (substitute, never delete)
 * still applies regardless, so a caller without `shakeOf` keeps every top-level
 * binding physically present: an exported define is never silently dropped just
 * because nothing wired deletion in (WALKER-NAMING audit finding #2).
 *
 * Scope/naming (engine plan §2 E1a — the lookahead namer): this walk mints a Binding
 * (via `declareJs`/`fresh`) at every scheme binding site or engine-glue need, but
 * commits NO collision decision itself — every mint just records its scheme-name-or-
 * hint origin (../naming/origin.ts) and returns a PROVISIONAL Binding. Once the whole
 * tree is built, `walk()` hands it to `bindingCensusOf` (../naming/census.ts — every
 * binding site, entity kind, scope shape, destructure/singularize use-shape) then
 * `allocateNames` (../naming/allocate.ts — one global `@here.build/lexical-namer` pass:
 * candidate ladders, collision resolution, destructure slot names) then
 * `materializeNames` (../naming/materialize.ts — commits final text + destructure
 * shape onto the tree this function returns). `fresh()`-at-emit dying means exactly
 * this: no ad hoc `${name}_${n}` loop runs DURING the walk anymore — nested scopes
 * still never shadow and splicing a tail body into its parent block is still
 * unconditionally redeclare-safe, but that guarantee is now the allocation phase's
 * (scope-tree reservations propagate down, exactly as they did here before).
 */
import type { EmitConfig, EmitCtx, TypeFacts } from "@here.build/arrival/emit";

import type {
  And,
  App,
  ClassifyResult,
  CoreForm,
  Define,
  DefineFn,
  If as CfIf,
  Let as CfLet,
  Lit as CfLit,
  NamedLet,
  NodeId,
  Or,
  Param as CfParam,
  QuoteDatum,
  Require as CfRequire,
} from "../coreform/types.js";
import { guardFormOf, loweringDecisionAt } from "../lowering/index.js";
import type { GuardForm, LoweringDecision } from "../lowering/index.js";
import { allocateNames, bindingCensusOf, materializeNames, recordOrigin } from "../naming/index.js";
import { propagateTopLevelDefines, propagationDecisionAt } from "../propagate/index.js";
import type { EmitRegistry } from "../registry/harvest.js";
import { arrayChunkAst, type ChunkElement } from "../residual/chunk.js";
import type { Binding, CompilationUnit, Decl, Pattern, R } from "../residual/types.js";
import { STAGE0 } from "../runtime/stage0.js";
import type { ShakeDecision } from "../shake/index.js";
import {
  ArrayLit,
  ArrayPattern,
  Arrow,
  Assign,
  Binding as mkBinding,
  Block,
  Call,
  ChunkExpr,
  Comment,
  Cond,
  Const,
  ConstDecl,
  Continue,
  FnDecl,
  If as IfStmt,
  Index,
  Let as LetStmt,
  Lit,
  Bin,
  Method,
  New,
  ObjectLit,
  Ref,
  RestBinding,
  Return,
  RuntimeRef,
  Throw,
  While,
} from "../residual/types.js";
import { cleanName } from "./names.js";

/** A rule's typed refusal (`EmitCtx.door`) — the one COMPILE-time door. Surfaces as a
 *  compile diagnostic by escaping `walk()`; everything else the walker refuses becomes
 *  a runtime `Throw` residual (interpreter parity — see the module header). */
export class WalkDoorError extends Error {
  constructor(reason: string) {
    super(`walker door: ${reason}`);
    this.name = "WalkDoorError";
  }
}

export interface WalkOptions {
  readonly registry: EmitRegistry;
  /** TypeFacts side table, NodeId-keyed (typefacts-extraction.md's `.facts` field).
   *  Default empty ⇒ every decision conservative (Law F). */
  readonly facts?: ReadonlyMap<NodeId, TypeFacts>;
  /**
   * E2's idiom decision-view (engine plan §2 E2, second half:
   * `SchemeSemanticModel.idiomAt` — model.ts). Consulted at the TOP of every
   * `App` this walker lowers (see `lowerApp`, below) — the dissolved
   * `peephole()` whole-tree PASS used to pre-rewrite the tree before `walk()`
   * ever ran; this option is the SAME decision, consumed inline instead
   * (mirrors how `facts`, above, is already consulted per-node rather than
   * pre-baked into the tree). Default `undefined` ⇒ no idiom ever fires —
   * `lowerApp` falls straight through to its ordinary §4.2 ladder, exactly
   * the pre-E2 behavior (every existing hand-rolled-registry test in this
   * package that never supplies `idiomAt` is unaffected).
   */
  readonly idiomAt?: (node: App) => App | undefined;
  /**
   * R-G6's static-prevaluation decision-view (`../prevalue/index.ts`,
   * `../model/model.ts`'s `sm.prevalueOf`): consulted at the top of every
   * `If`/`And`/`Or` this walker lowers (`lowerExpr`, below, and
   * `tailLoopForm`'s own `If` arm — the one site that builds an `if`
   * statement directly instead of routing through `lowerExpr`) — mirrors
   * how `idiomAt`, above, is consulted at the top of `lowerApp`. Default
   * `undefined` ⇒ no fold ever fires — every existing hand-rolled-registry
   * test in this package that never supplies `prevalueOf` is unaffected,
   * exactly like `idiomAt`'s own default.
   */
  readonly prevalueOf?: (node: CfIf | And | Or) => CoreForm | undefined;
  /**
   * The structural-optimization lane's propagation decision-view
   * (`../propagate/index.ts`'s `propagationDecisionAt`, `../model/model.ts`'s
   * `sm.propagationOf`): consulted at the top of `letStmts` (below) — the
   * single function every `Let`-lowering site routes through — BEFORE the
   * body it returns is lowered, so a propagated literal is already in place
   * the moment `prevalueOf`, above, examines a nested `If`/`And`/`Or`
   * (`(let ((flag #t)) (if flag A B))` → propagate → `(if #t A B)` →
   * prevalue folds → `A`). UNLIKE `idiomAt`/`prevalueOf` (genuinely optional
   * folds), this decision is unconditionally sound wherever a `Let`/`let*`
   * appears — declining it is never REQUIRED, only ever a missed
   * optimization — so `undefined` here does not mean "never fires": the
   * walker's own `propagationFor` (below, mirroring `decisionFor`/
   * `guardFor`'s supplied-view-or-direct-default split) falls back to
   * calling `propagationDecisionAt` directly. Supplying a cached
   * `sm.propagationOf` only changes WHICH implementation answers (memoized
   * vs. recomputed), never WHETHER the fold applies — a bare `walk()` call
   * or a module-face build (neither wires this in) still gets the fold.
   * (Top-level `define` propagation is a separate, always-on pass — see
   * `propagateTopLevelDefines`'s own call site, further down, and its own
   * header for why it needs no gate at all.)
   */
  readonly propagationOf?: (node: CfLet) => CfLet | undefined;
  /**
   * The structural-optimization lane's other free fold
   * (`../propagate/index.ts`'s `sameBranchDecisionAt`, `sm.sameBranchOf`):
   * consulted immediately after `prevalueOf` declines, at the same two call
   * sites (`lowerExpr`'s "If" arm, `tailLoopForm`'s own "If" arm) — folds
   * `(if c A A)` (both arms the SAME trivially-pure value) even when `c`
   * itself is not provably constant. Default `undefined` ⇒ never fires.
   */
  readonly sameBranchOf?: (node: CfIf) => CoreForm | undefined;
  /** `"run"` = executable artifact (Law T strict); `"read"` = glass (clean forms). */
  readonly register: "run" | "read";
  /**
   * BUILD-MODE ADDITIVE HOOK (the loader/FRAME wave, `docs/working-proposals/
   * inhuman-build-cli.md` §2/§3): consulted at every one of the four `"Require"`
   * dispatch sites below (`lowerStmts`/`lowerTail`/`tailLoopForm`/`lowerExpr`) —
   * mirrors `idiomAt`/`prevalueOf`'s own "decline is always safe" discipline.
   * Default `undefined` ⇒ every existing caller (the oracle harness, every
   * hand-rolled-registry test in this package) is BYTE-IDENTICAL to today: a
   * `Require` node still lowers straight to `requireThrow` — oracle programs are
   * self-contained single files, so the loader-owns-import-planning door is
   * exactly the right answer there, unchanged.
   *
   * Under a build-mode caller (`../build/`), a `Require` node's PATH has already
   * been resolved to a compiled sibling's import binding (either a whole-module
   * default binding for a `(define x (require "y"))`/inline use, or — for the
   * bare, unbound spill case — a binding the caller only needs the WALKER to
   * accept as "handled" so the statement position emits nothing; the actual
   * spilled NAMES resolve through registry rows the caller overlays separately,
   * per the design doc's own module/program-face split). Returning a value here
   * never implies a runtime import materializes at THIS textual position — the
   * caller is responsible for hoisting its own `Import` decls onto the unit
   * this `walk()` call returns; this hook only decides what a `Require` node
   * ITSELF lowers to, in whichever position it was written.
   */
  readonly requireOf?: (node: CfRequire) => R | undefined;
  /**
   * E3's §4.2 ladder decision-view (`../lowering/index.ts`'s
   * `loweringDecisionAt`, `../model/model.ts`'s `sm.loweringDecisionAt`):
   * consulted by `lowerApp`'s free-`Ref` branch (`"call"` position) and
   * `registryValueRef` (`"value"` position) in place of a direct
   * `registry.lookup` + `row.kind`/`row.emit` branch. Default `undefined` ⇒
   * the SAME decision computed directly against `opts.registry` (see
   * `decisionFor`, above) — byte-identical to the pre-E3 inline ladder for
   * every existing hand-rolled-registry test in this package, exactly like
   * `idiomAt`/`prevalueOf`'s own default (the one difference: this decision
   * is not itself optional-to-fire, so the default RECOMPUTES it rather than
   * declining).
   */
  readonly loweringDecisionAt?: (name: string, position: "call" | "value") => LoweringDecision;
  /**
   * Law-T's guard-form decision-view (`../lowering/index.ts`'s
   * `guardFormOf`, `sm.guardFormOf`): consulted by `truthTest`/`allBoolean`
   * in place of a direct `facts.get(id)?.boolean === true` read. Default
   * `undefined` ⇒ the SAME decision computed directly against `opts.facts`
   * (see `guardFor`, above) — byte-identical to the pre-E3 inline check.
   */
  readonly guardFormOf?: (node: CoreForm, register: "run" | "read") => GuardForm;
  /**
   * Arrival's shake (`../shake/index.ts`'s `shakeTopLevel`, `sm.shakeOf`):
   * consulted ONCE, at the same point `propagateTopLevelDefines` already
   * runs (below) — prunes dead-and-pure top-level `Define`/`DefineFn` forms
   * from `forms` before `preRegisterDefines` ever sees them (effectful
   * crossings survive; requires are untouched — see that module's own
   * header). Default `undefined` ⇒ no shake ever fires, exactly like
   * `idiomAt`/`prevalueOf`'s own "decline is always safe" default — every
   * existing hand-rolled-registry test in this package that never supplies
   * `shakeOf` is unaffected.
   */
  readonly shakeOf?: (forms: readonly CoreForm[]) => ShakeDecision;
}

/** Statement-sequence mode: `tail` returns the last form's value; `stmt` discards it;
 *  a `LoopMode` rewrites the last form's tail positions into the TCO while-loop step. */
interface LoopMode {
  readonly loopName: string;
  readonly loopVars: readonly Binding[];
}
type SeqMode = "tail" | "stmt" | LoopMode;

/**
 * Walk a classified program into a CompilationUnit: top-level `Define`/`DefineFn`
 * become decls (`ConstDecl`/`FnDecl`), every other top-level form becomes a body
 * statement. NOTE the CompilationUnit shape renders all decls before the body, so a
 * top-level expression textually preceding a define it does not depend on is reordered
 * after it — top level is letrec*-flavored by construction (matching the pre-pass that
 * registers every top-level define name before lowering, so mutual recursion works).
 */
export function walk(classified: ClassifyResult, opts: WalkOptions): CompilationUnit {
  const facts = opts.facts ?? new Map<NodeId, TypeFacts>();
  const config: EmitConfig = { register: opts.register };
  const { registry } = opts;

  // ── E3: decisions, not analyses (module header) ───────────────────────────────────
  //
  // THE one named accessor onto the facts side-table — every fact read anywhere below
  // goes through this closure, never a second `facts.get(...)` call site (the
  // S5-extended lint's mechanical check, model-imports-agree.test.ts). Keyed by NodeId
  // directly (not a CoreForm node) — `registryValueRef`'s value-position call site only
  // ever has the bare id on hand, never a full node.
  const factsAt = (id: NodeId): TypeFacts | undefined => facts.get(id);

  // THE §4.2 ladder verdict, per free symbol reference: `opts.loweringDecisionAt` when
  // the model supplies its own view (the real pipeline, oracle/harness.ts's
  // `compileGreenfield`), else the SAME relocated decision (../lowering/index.ts)
  // computed directly against `registry` — byte-identical either way (idiomAt/
  // prevalueOf's own "declining is always safe" default, applied to a decision that
  // isn't itself optional: absent a supplied view, the walker still needs an answer,
  // so the default calls the very function the view would have called). The walker's
  // own body never calls `registry.lookup` again past this point.
  const decisionFor =
    opts.loweringDecisionAt ?? ((name: string, position: "call" | "value") => loweringDecisionAt(name, registry, position));

  // Law-T's guard form, per condition node: same supplied-view-or-relocated-default
  // split as `decisionFor`.
  const guardFor = opts.guardFormOf ?? ((n: CoreForm, register: "run" | "read") => guardFormOf(factsAt(n.id), register));

  // The structural-optimization lane's per-`Let` propagation decision: same
  // supplied-view-or-direct-default split as `decisionFor`/`guardFor` — unlike
  // `idiomAt`/`prevalueOf`'s genuinely optional folds, this one is
  // unconditionally sound everywhere a `Let`/`let*` can appear
  // (`propagationDecisionAt`'s own header), so the default computes it
  // directly instead of declining. Applies even where no `SchemeSemanticModel`
  // caches it (a bare `walk()` call, a module-face build) — every caller gets
  // the fold, cached or not (`WalkOptions.propagationOf`'s own doc).
  const propagationFor = opts.propagationOf ?? propagationDecisionAt;

  // ── naming: scheme-name resolution frames + provisional minting ─────────────────
  //
  // Collision avoidance no longer happens here (see the module header) — `declareJs`/
  // `fresh` mint a Binding with a PROVISIONAL text (cleanName's tier-1 candidate, or
  // the `__`-prefixed hint) and record its origin; `walk()`'s tail runs the census +
  // allocation + materialize pipeline that commits FINAL, collision-free text before
  // this function returns. `schemeFrames` (scheme-name → Binding resolution, for Ref
  // lookups) is the one piece of scoping state still needed here — it decides WHICH
  // binding a reference resolves to, which the naming phase never touches.

  const schemeFrames: Map<string, Binding>[] = [new Map()];

  const resolve = (name: string): Binding | undefined => {
    for (let i = schemeFrames.length - 1; i >= 0; i--) {
      const hit = schemeFrames[i]!.get(name);
      if (hit !== undefined) return hit;
    }
    return undefined;
  };
  /** Mint the provisional Binding for a scheme binding site — text is a placeholder
   *  (allocation decides the final, collision-free name); origin is recorded so the
   *  census can classify + ladder it. */
  const declareJs = (schemeName: string): Binding => recordOrigin(mkBinding(cleanName(schemeName)), { mint: "declared", text: schemeName });
  /** Mint a provisional engine-glue Binding (`ctx.fresh`'s implementation, and the
   *  guarded and/or cascade's own temp) — same provisional-text/origin-recording
   *  discipline as `declareJs`. */
  const fresh = (hint: string): Binding => recordOrigin(mkBinding(`__${cleanName(hint)}`), { mint: "fresh", text: hint });
  const bind = (name: string, b: Binding): void => {
    schemeFrames.at(-1)!.set(name, b);
  };
  const inSchemeFrame = <T>(fn: () => T): T => {
    schemeFrames.push(new Map());
    try {
      return fn();
    } finally {
      schemeFrames.pop();
    }
  };

  // ── doors ────────────────────────────────────────────────────────────────────────

  /** The door-throw contract: thrown message BEGINS with the door code. */
  const doorThrow = (code: string, message: string): R =>
    Throw(New(Ref(mkBinding("Error")), [Lit(`${code}: ${message}`)]));
  /** Expression-position door: a `Block` renders as an IIFE, so the throw stays an
   *  expression-legal shape and fires only if the position is actually evaluated. */
  const doorExpr = (code: string, message: string): R => Block([doorThrow(code, message)]);
  const requireThrow = (n: CfRequire): R =>
    doorThrow(
      "unsupported-form/require",
      `\`(require "${n.path}")\` — module loading is not compiled in this slice (the loader/FRAME wave owns import planning).`,
    );

  // ── registry dispatch (§4.2 ladder) ───────────────────────────────────────────────
  //
  // The ladder itself — rule vs shim vs door — is `decisionFor`'s decision (E3, above);
  // this walker only builds the residual the verdict calls for. The one narrowing seam
  // for the registry's opaquely-stored `EmitRule` (the former `ruleOf` comment: "the
  // engine re-instantiates it here, once, and nowhere else") relocated WITH the ladder
  // to `../lowering/index.ts` — `decision.rule`, below, already carries the narrowed
  // value.

  const ctxFor = (argFacts: TypeFacts[], selfFacts: TypeFacts | undefined, origin: NodeId): EmitCtx<R> => ({
    argFacts,
    selfFacts,
    config,
    originHint: origin,
    fresh: (hint) => fresh(hint),
    runtime: (symbol) => RuntimeRef(symbol),
    door: (reason) => {
      throw new WalkDoorError(reason);
    },
  });

  /** Structural switch over a `LoweringDecision` — never a semantic re-decision: reads
   *  the verdict's OWN fields, decides nothing about the registry itself. Shared by
   *  `registryValueRef` (below) and `lowerApp`'s free-`Ref` branch. */
  const lowerDoor = (decision: Extract<LoweringDecision, { rung: "door" }>): R => doorExpr(decision.code, decision.message);

  /** Value position of a FREE name (`(map car xss)`'s `car`, a define's RHS): the
   *  `"value"` ladder — `decisionFor`'s rule/shim/door verdict, built into a residual. */
  const registryValueRef = (name: string, id: NodeId): R => {
    const decision = decisionFor(name, "value");
    switch (decision.rung) {
      case "door":
        return lowerDoor(decision);
      case "rule":
        return decision.rule.ref!(ctxFor([], factsAt(id), id));
      case "shim":
        return RuntimeRef(decision.row.symbol);
    }
  };

  // ── Law T (truthiness) ─────────────────────────────────────────────────────────────

  /** Run-side Law T: bare iff `guardFor` proves it; otherwise exact-Scheme `c !== false`
   *  (only `#f` is false — `0`/`""` are truthy). Read register always bare (§1) — decided
   *  BY `guardFor` (`../lowering/index.ts`'s `guardFormOf`), not re-checked here. */
  const truthTest = (cond: CoreForm): R => {
    const c = lowerExpr(cond);
    return guardFor(cond, config.register) === "bare" ? c : Bin("!==", c, Lit(false));
  };

  // ── And/Or ─────────────────────────────────────────────────────────────────────────

  const allBoolean = (args: readonly CoreForm[]): boolean =>
    args.every((a) => guardFor(a, "run") === "bare");

  /**
   * The value-returning guarded cascade (Law T run-side; engine-walker.md §1): one
   * `Const` temp per non-last operand, checked once — the nested else-position `Block`
   * renders as an IIFE, so operand N+1 is never evaluated unless operand N failed the
   * check (`or`: t !== false picks t; `and`: t === false short-circuits with t).
   *
   * CONSERVATIVE-EFFECTS NOTE: every non-last operand gets a temp, so each operand is
   * evaluated exactly once — effectful operands safe by construction. §2.2 licenses
   * double-evaluating PURE operands (skipping the temp, `a !== false ? a : b`); that
   * optimization gates on `provenance`/`cacheClass` purity data this wave doesn't read.
   */
  const guardedChain = (args: readonly CoreForm[], kind: "and" | "or"): R => {
    const t = fresh(kind);
    const headR = lowerExpr(args[0]!);
    const rest = args.slice(1);
    const restR = rest.length === 1 ? lowerExpr(rest[0]!) : guardedChain(rest, kind);
    const test = Bin(kind === "or" ? "!==" : "===", Ref(t), Lit(false));
    return Block([Const(t, headR), Return(Cond(test, Ref(t), restR))]);
  };

  const lowerAndOr = (args: readonly CoreForm[], kind: "and" | "or"): R => {
    if (args.length === 0) return Lit(kind === "and"); // (and) → #t, (or) → #f
    if (args.length === 1) return lowerExpr(args[0]!);
    if (config.register === "read" || allBoolean(args)) {
      return args.map(lowerExpr).reduce((l, r) => Bin(kind === "and" ? "&&" : "||", l, r));
    }
    return guardedChain(args, kind);
  };

  // ── Quote / Lit / Dict ─────────────────────────────────────────────────────────────

  /**
   * E2 ingestion fold (engine plan §1 S2, §2 E2): QuoteDatum → ChunkElement.
   * ALWAYS slot-free — a QuoteDatum is a mirror datatype that never contains a
   * scheme variable reference at any depth (coreform/types.ts's own
   * invariant: quoted data is never re-classified as CoreForm), so there is
   * nothing to bridge back to. A nested list embeds its OWN chunk `ast`
   * inline (the `"ast"` element kind — residual/chunk.ts's own doc) rather
   * than a slot pointing at a second chunk, so `'(1 (2 3))` folds to ONE
   * genuinely nested `ts.ArrayLiteralExpression`.
   */
  const quoteElementOf = (d: QuoteDatum): ChunkElement => {
    switch (d.kind) {
      case "number":
        return { kind: "lit", value: Number(d.text) };
      case "string":
        return { kind: "lit", value: d.value };
      case "boolean":
        return { kind: "lit", value: d.value };
      case "symbol":
        return { kind: "lit", value: d.name };
      case "list":
        return { kind: "ast", node: arrayChunkAst(d.items.map(quoteElementOf)) };
    }
  };

  /** Representation law (§2.1): symbol → interned name STRING, list → a
   *  genuine `ts.factory` chunk (E2 ingestion fold — see `quoteElementOf`;
   *  the `list(1, 2)` stage0 shim never even enters the picture for quoted
   *  data, which was already shim-free before this wave — this fold changes
   *  the MECHANISM `ArrayLit`→real-AST, never the emitted bytes). A datum
   *  never contains a bare dot (dotted pairs folded at classify time).
   *  Numeric text is unconditional `Number(text)` — one-number RATIO ruling,
   *  zero dispatch (§7). */
  const datumToR = (d: QuoteDatum): R => {
    switch (d.kind) {
      case "number":
        return Lit(Number(d.text));
      case "string":
        return Lit(d.value);
      case "boolean":
        return Lit(d.value);
      case "symbol":
        return Lit(d.name);
      case "list":
        return ChunkExpr(arrayChunkAst(d.items.map(quoteElementOf)));
    }
  };

  /**
   * E2's ingestion-fold SCOPE gate (engine plan §2 E2; S2's "mixed literal/
   * variable… slots at variable positions", scoped conservatively this wave):
   * true iff `r`'s subtree contains NO `Call`/`Method`/`New`/`Arrow` anywhere
   * — i.e. the argument is data-like (literals, bound refs, accessor chains),
   * not computation. This is fold-scope POLICY, not a correctness
   * prerequisite: every generic walker sees through a chunk's slots
   * (mercury-ir.md's mutual-recursion rule, "never assume AST chunks are leaf
   * nodes" — residual/render.ts's `rChildren`, legibility/tree.ts's
   * `childrenOf`/`mapChildren`, naming/asyncness.ts's own `childrenOf` +
   * slot-rebuilding rewrite arms), so a Call or Arrow living in a slot is
   * found by the asyncness fixpoint, CSE, the binding census, and the import
   * materializer exactly like any other child position. The gate just keeps
   * THIS wave's fold to the literal-data churn class the plan names ("literal
   * arrays where list() shims stood") — widening it to computation-carrying
   * slots is E2b's call, not blocked by any walker. A bare `RuntimeRef` VALUE
   * (e.g. `(list 1 2 car)`, `car` unused as a call) passes this check —
   * holding a function reference is data-like, and both the import census
   * (`runtimeRefsOf` below) and the RuntimeRef→Ref import rewrite reach
   * through the slot regardless.
   */
  const isCallFree = (r: R): boolean => {
    switch (r.t) {
      case "Call":
      case "Method":
      case "New":
      case "Arrow":
        return false;
      case "Ref":
      case "RuntimeRef":
      case "Lit":
      case "Continue":
        return true;
      case "Template":
        return r.exprs.every(isCallFree);
      case "Index":
        return isCallFree(r.recv) && isCallFree(r.index);
      case "Member":
        return isCallFree(r.recv);
      case "Bin":
        return isCallFree(r.left) && isCallFree(r.right);
      case "Un":
        return isCallFree(r.arg);
      case "Cond":
        return isCallFree(r.test) && isCallFree(r.then) && isCallFree(r.else);
      case "ArrayLit":
        return r.elements.every(isCallFree);
      case "ObjectLit":
        return r.entries.every((e) => isCallFree(e.value));
      case "Spread":
      case "Await":
      case "Throw":
        return isCallFree(r.value);
      case "Block":
        return r.stmts.every(isCallFree);
      case "Const":
      case "Let":
        return isCallFree(r.init);
      case "Assign":
        return isCallFree(r.value);
      case "Return":
        return r.value === undefined || isCallFree(r.value);
      case "While":
        return isCallFree(r.test) && isCallFree(r.body);
      case "ForOf":
        return isCallFree(r.iterable) && isCallFree(r.body);
      case "If":
        return isCallFree(r.test) && isCallFree(r.then) && (r.else === undefined || isCallFree(r.else));
      case "Comment":
        return isCallFree(r.node);
      case "Annotated":
        return isCallFree(r.value);
      case "ChunkExpr":
      case "ChunkStmt":
        // Every chunk THIS function gates the construction of is call-free
        // internally by construction — checked here defensively (not
        // assumed) so this stays correct if a future wave (E2b: rules
        // returning chunks) ever builds one a different way.
        return r.slots === undefined || [...r.slots.values()].every(isCallFree);
    }
  };

  /** Not a valid Lit payload (`undefined` is — `Lit(undefined)` is real,
   *  legal data) — a distinct sentinel so `literalValueOf` can say "not a
   *  literal at all" without colliding with the literal value `undefined`. */
  const NOT_LITERAL: unique symbol = Symbol("not-literal");

  /** Extract the raw JS value from an already-lowered `Lit` R-node, or
   *  `NOT_LITERAL` iff `r` isn't one. `bigint` is host-value infra
   *  (residual/types.ts's own note) — scheme lowering never produces one, so
   *  it is excluded defensively rather than threaded through `ChunkElement`. */
  const literalValueOf = (r: R): string | number | boolean | null | undefined | typeof NOT_LITERAL => {
    if (r.t !== "Lit") return NOT_LITERAL;
    switch (r.value.k) {
      case "string":
      case "number":
      case "boolean":
        return r.value.value;
      case "null":
        return null;
      case "undefined":
        return undefined;
      case "bigint":
        return NOT_LITERAL;
    }
  };

  /**
   * E2's ingestion fold for a `list` call (S2): try to build a data-only
   * chunk-expression from ALREADY-LOWERED arguments (`argsR` — the same
   * values `lowerApp` would otherwise pass straight to
   * `Call(RuntimeRef("list"), argsR)`). `undefined` ⇒ abort: at least one
   * argument's lowered form fails `isCallFree` (computation, not data — see
   * that gate's doc: fold-scope policy this wave, never a walker-safety
   * requirement) — the caller falls back to the ordinary shim call,
   * unchanged. A `Lit`-shaped argument embeds INLINE (mercury's
   * own "short-circuits known primitives" move — no slot spent on a
   * constant); an already-folded, slot-free `ChunkExpr` (a nested `list`/
   * quote) splices its `ast` inline too, so nested literal lists produce ONE
   * genuinely nested AST, not a slot pointing at a second chunk.
   */
  const tryFoldListCall = (argsR: readonly R[]): R | undefined => {
    const elements: ChunkElement[] = [];
    const slots = new Map<string, R>();
    let slotN = 0;
    for (const arg of argsR) {
      const lit = literalValueOf(arg);
      if (lit !== NOT_LITERAL) {
        elements.push({ kind: "lit", value: lit });
        continue;
      }
      if (arg.t === "ChunkExpr" && arg.slots === undefined) {
        elements.push({ kind: "ast", node: arg.ast });
        continue;
      }
      if (!isCallFree(arg)) return undefined;
      const id = `__slot${slotN++}`;
      slots.set(id, arg);
      elements.push({ kind: "slot", id });
    }
    return ChunkExpr(arrayChunkAst(elements), slots.size > 0 ? slots : undefined);
  };

  const lowerLit = (n: CfLit): R => {
    const v = n.value;
    switch (v.kind) {
      case "number":
        return Lit(Number(v.text));
      case "string":
        return Lit(v.value);
      case "boolean":
        return Lit(v.value);
      case "undefined":
        return Lit(undefined);
      case "keyword":
        // Legal only as an App head (the accessor) or inside KwEntry — a keyword
        // surviving to plain expression position is stray (engine-walker.md §5).
        return doorExpr(
          "malformed-source/bare-keyword",
          `bare keyword \`:${v.name}\` in expression position — keywords mark call sites: \`(:${v.name} obj)\` or \`(f :${v.name} v)\`.`,
        );
    }
  };

  // ── bodies and sequences ───────────────────────────────────────────────────────────

  const defineBinding = new Map<NodeId, Binding>();
  /** Bodies are letrec*-flavored: direct `Define`/`DefineFn` names register up front so
   *  forward references (mutual recursion through lambdas) resolve. A define nested in
   *  a body-position `begin` misses the pre-pass and registers sequentially at its own
   *  statement (forward refs to IT stay free — conservative). */
  const preRegisterDefines = (forms: readonly CoreForm[]): void => {
    for (const f of forms) {
      if (f.kind === "Define" || f.kind === "DefineFn") {
        const b = declareJs(f.name);
        bind(f.name, b);
        defineBinding.set(f.id, b);
      }
    }
  };
  const bindingForDefine = (n: Define | DefineFn): Binding => {
    const pre = defineBinding.get(n.id);
    if (pre !== undefined) return pre;
    const b = declareJs(n.name);
    bind(n.name, b);
    defineBinding.set(n.id, b);
    return b;
  };

  const bodySeq = (forms: readonly CoreForm[], mode: SeqMode): R[] => {
    if (forms.length === 0) return mode === "stmt" ? [] : [Return(Lit(undefined))];
    preRegisterDefines(forms);
    const out: R[] = [];
    for (const f of forms.slice(0, -1)) out.push(...lowerStmts(f));
    const last = forms.at(-1)!;
    out.push(...(mode === "tail" ? lowerTail(last) : mode === "stmt" ? lowerStmts(last) : tailLoopForm(last, mode)));
    return out;
  };

  /** Statement position (value discarded). A value-shaped `Block` result (guarded
   *  cascade, named-let) is wrapped in an EXPLICIT IIFE — a bare `Block` statement
   *  would let its internal `Return` escape into the enclosing function. */
  const lowerStmts = (n: CoreForm): R[] => {
    switch (n.kind) {
      case "Define":
        return [Const(bindingForDefine(n), lowerExpr(n.value))];
      case "DefineFn": {
        const b = bindingForDefine(n); // registered BEFORE the body lowers — self-recursion resolves
        const fn = lowerLambdaLike(n.params, n.body);
        return [Const(b, Arrow(fn.params, collapseBody(fn.stmts)))];
      }
      case "Begin":
        return bodySeq(n.body, "stmt"); // splices — begin introduces no bindings
      case "Let":
        return [Block(letStmts(n, "stmt"))]; // bare block — scoped, no Return inside
      case "Door":
        return [doorThrow(n.code, n.message)];
      case "Require": {
        // Statement position — the require's own value is discarded either way
        // (the bare, unbound spill's actual payoff is the caller's registry
        // overlay, not this position). `requireOf` returning anything at all
        // means "handled" — emit nothing, the import is hoisted elsewhere.
        const handled = opts.requireOf?.(n);
        return handled !== undefined ? [] : [requireThrow(n)];
      }
      default: {
        const e = lowerExpr(n);
        return [e.t === "Block" ? Call(Arrow([], e), []) : e];
      }
    }
  };

  /** Tail position of a function body: statements ending in `Return` (or a door throw).
   *  A value-shaped `Block` from `lowerExpr` (let, begin, cascade, named-let) SPLICES
   *  its statements into the caller's block — the sole-body-unwrap invariant (§6),
   *  generalized to every tail: safe because the walker's overlapping-scope
   *  disambiguation means a spliced declaration can never redeclare an enclosing name,
   *  and nothing follows a tail. */
  const lowerTail = (n: CoreForm): R[] => {
    switch (n.kind) {
      case "Door":
        return [doorThrow(n.code, n.message)];
      case "Require": {
        // Tail position — the require's value MAY be observed (a file whose
        // trailing form is bare `(require "x")`), so a handled require returns
        // its resolved value, conservatively.
        const handled = opts.requireOf?.(n);
        return handled !== undefined ? [Return(handled)] : [requireThrow(n)];
      }
      case "Define":
      case "DefineFn":
        // A body whose LAST form is a define has unspecified value — bind, yield undefined.
        return [...lowerStmts(n), Return(Lit(undefined))];
      default: {
        const e = lowerExpr(n);
        return e.t === "Block" ? [...e.stmts] : [Return(e)];
      }
    }
  };

  // ── Let family ─────────────────────────────────────────────────────────────────────

  /**
   * One `Const` per binding for all four letKinds — `letKind` steers RESOLUTION only
   * (which scope each init sees), never emission (spec §2; coreform-ir.md §4.10):
   * `let` inits resolve outside the frame, `let*` progressively, `letrec`/`letrec*`
   * see every sibling (JS TDZ enforces use-before-init at runtime, which IS letrec*'s
   * own restriction). Caller owns the JS frame (block vs splice).
   */
  const letStmts = (n: CfLet, mode: SeqMode): R[] => {
    // The structural-optimization lane's propagation decision, consulted
    // FIRST — mirrors `lowerApp`'s own `idiomAt` consultation, and
    // `decisionFor`/`guardFor`'s own "supplied-view-or-direct-default" split
    // (above): this decision isn't itself optional (unconditionally sound
    // everywhere — `propagationDecisionAt`'s own header), so absent a cached
    // model view the walker still computes it directly rather than
    // declining. Runs BEFORE this function's own lowering (and therefore
    // before `prevalueOf`/`sameBranchOf` ever see a nested If/And/Or in
    // `effective.body`), so a propagated literal is already substituted in
    // place by the time either of those views examines it (see
    // `WalkOptions.propagationOf`'s own doc).
    const effective = propagationFor(n) ?? n;
    return inSchemeFrame(() => {
      const consts: R[] = [];
      if (effective.letKind === "let") {
        const inits = effective.bindings.map((b) => lowerExpr(b.init)); // outer scope — frame is pushed but empty
        effective.bindings.forEach((b, i) => {
          const jb = declareJs(b.name);
          bind(b.name, jb);
          consts.push(Const(jb, inits[i]!));
        });
      } else if (effective.letKind === "let*") {
        for (const b of effective.bindings) {
          const init = lowerExpr(b.init); // sees previous bindings only
          const jb = declareJs(b.name);
          bind(b.name, jb);
          consts.push(Const(jb, init));
        }
      } else {
        const jbs = effective.bindings.map((b) => {
          const jb = declareJs(b.name);
          bind(b.name, jb);
          return jb;
        });
        effective.bindings.forEach((b, i) => consts.push(Const(jbs[i]!, lowerExpr(b.init))));
      }
      return [...consts, ...bodySeq(effective.body, mode)];
    });
  };

  // ── NamedLet: TCO while-loop or declared arrow ─────────────────────────────────────

  /**
   * Ported from mercury `lower.ts` `selfTailOnly` (:714-784), retargeted to CoreForm
   * dispatch: TRUE iff every use of `loopName` is a kwarg-free CALL in OUR tail
   * position. Any value use, non-tail call, use under a nested lambda/define (capture),
   * rebinding, or a nested NAMED let's body (its tails are not ours) bails conservative
   * — the declared stack-bound arrow remains, faithfully.
   */
  const selfTailOnly = (body: readonly CoreForm[], loopName: string): boolean => {
    let ok = true;
    const walkSeq = (forms: readonly CoreForm[], tail: boolean): void => {
      forms.forEach((f, i) => walkForm(f, tail && i === forms.length - 1));
    };
    const walkForm = (n: CoreForm, tail: boolean): void => {
      if (!ok) return;
      switch (n.kind) {
        case "Ref":
          if (n.name === loopName) ok = false; // the loop used as a VALUE
          return;
        case "App": {
          if (n.fn.kind === "Ref" && n.fn.name === loopName) {
            if (!tail || n.kwargs.length > 0) {
              ok = false;
              return;
            }
            for (const a of n.positionalArgs) walkForm(a, false);
            return;
          }
          walkForm(n.fn, false);
          for (const a of n.positionalArgs) walkForm(a, false);
          for (const e of n.kwargs) walkForm(e.value, false);
          return;
        }
        case "If":
          walkForm(n.cond, false);
          walkForm(n.then, tail);
          walkForm(n.else, tail);
          return;
        case "Begin":
          walkSeq(n.body, tail);
          return;
        case "Let": {
          for (const b of n.bindings) {
            if (b.name === loopName) {
              ok = false; // rebinding — bail conservatively
              return;
            }
            walkForm(b.init, false);
          }
          walkSeq(n.body, tail); // a plain let's body keeps OUR tail
          return;
        }
        case "NamedLet": {
          if (n.loopName === loopName) {
            ok = false;
            return;
          }
          for (const b of n.bindings) {
            if (b.name === loopName) {
              ok = false;
              return;
            }
            walkForm(b.init, false);
          }
          walkSeq(n.body, false); // the inner loop's tail positions are not ours
          return;
        }
        case "Lambda":
          walkSeq(n.body, false); // any use inside a nested function is a capture — bails
          return;
        case "Define":
          walkForm(n.value, false);
          if (n.overridableType !== undefined) walkForm(n.overridableType, false);
          return;
        case "DefineFn":
          if (n.overridableType !== undefined) walkForm(n.overridableType, false);
          walkSeq(n.body, false);
          return;
        case "And":
        case "Or":
          // Scheme-tail for the last operand, but the guarded cascade emits it in
          // expression position — conservatively non-tail (mercury's default ditto).
          for (const a of n.args) walkForm(a, false);
          return;
        case "Dict":
          for (const e of n.entries) walkForm(e.value, false);
          return;
        case "Quote":
        case "Lit":
        case "Door":
        case "Require":
          return;
      }
    };
    walkSeq(body, true);
    return ok;
  };

  /** The TCO tail rewrite (mercury `emitTailForm`, :523-554): a recursive tail call
   *  becomes a SIMULTANEOUS reassignment (`[a, b] = [x, y]` — never sequential; the
   *  swap-preserving invariant, §6) + `continue`; `if`/`begin`/`let` distribute over
   *  their tail positions; every other leaf `return`s. */
  const tailLoopForm = (n: CoreForm, mode: LoopMode): R[] => {
    switch (n.kind) {
      case "App": {
        // selfTailOnly proved loopName is never shadowed, so a raw-name match is exact.
        if (n.fn.kind === "Ref" && n.fn.name === mode.loopName) {
          const args = n.positionalArgs.map(lowerExpr);
          const vars = mode.loopVars;
          const step: R[] =
            vars.length === 0
              ? []
              : vars.length === 1
                ? [Assign(vars[0]!, args[0] ?? Lit(undefined))]
                : [Assign(ArrayPattern([...vars]), ArrayLit(vars.map((_v, i) => args[i] ?? Lit(undefined))))];
          return [...step, Continue()];
        }
        break;
      }
      case "If": {
        // Same R-G6 consultation as `lowerExpr`'s "If" arm — this site builds
        // its own `IfStmt` directly (the TCO tail rewrite) rather than
        // routing through `lowerExpr`, so it needs its own check to avoid
        // visiting/emitting a statically-dead arm (and any door inside it).
        const folded = opts.prevalueOf?.(n);
        if (folded !== undefined) return tailLoopForm(folded, mode);
        // The same-branch identity, consulted second (mirrors `lowerExpr`'s
        // own ordering) — `prevalueOf` couldn't prove `n.cond`, but `then`/
        // `else` may still be the identical trivially-pure value regardless.
        const sameBranch = opts.sameBranchOf?.(n);
        if (sameBranch !== undefined) return tailLoopForm(sameBranch, mode);
        const thenB = Block(tailLoopForm(n.then, mode));
        const elseB = Block(tailLoopForm(n.else, mode));
        return [IfStmt(truthTest(n.cond), thenB, elseB)];
      }
      case "Begin":
        return bodySeq(n.body, mode);
      case "Let":
        return [Block(letStmts(n, mode))]; // nested block inside the while — Continue still binds the loop
      case "Door":
        return [doorThrow(n.code, n.message)];
      case "Require": {
        // Loop-tail position — same conservative "return the resolved value" as
        // `lowerTail`, above (an edge case: a named-let tail landing on a bare
        // require is exotic but not impossible).
        const handled = opts.requireOf?.(n);
        return handled !== undefined ? [Return(handled)] : [requireThrow(n)];
      }
      default:
        break;
    }
    return [Return(lowerExpr(n))];
  };

  /** Named-let statements, spliced into whatever block the caller owns. Inits lower in
   *  the OUTER scope for both shapes. */
  const namedLetStmts = (n: NamedLet): R[] => {
    const inits = n.bindings.map((b) => lowerExpr(b.init));
    if (selfTailOnly(n.body, n.loopName)) {
      return inSchemeFrame(() => {
        // The loop name itself is NOT bound: selfTailOnly proved no occurrence survives
        // except the tail calls the rewrite consumes.
        const loopVars = n.bindings.map((b) => {
          const jb = declareJs(b.name);
          bind(b.name, jb);
          return jb;
        });
        const decls = loopVars.map((jb, i) => LetStmt(jb, inits[i]!)); // `let` — reassigned by the loop step
        const loopBody = bodySeq(n.body, { loopName: n.loopName, loopVars });
        return [
          ...decls,
          // The fold marker: the one synthetic comment an axis-a rewrite leaves where
          // the reader would otherwise ask "where did my named let go" (§6 ledger).
          Comment(`[ts-base/self-tail-loop] named let \`${cleanName(n.loopName)}\` → while`, While(Lit(true), Block(loopBody))),
        ];
      });
    }
    // Declared-arrow fallback: `const loop = (…) => …; return loop(inits);` — the loop
    // binding in ITS own frame so the params/body can't collide with it.
    return inSchemeFrame(() => {
      const loopB = declareJs(n.loopName);
      bind(n.loopName, loopB);
      const fn = inSchemeFrame(() => {
        const params = n.bindings.map((b) => {
          const jb = declareJs(b.name);
          bind(b.name, jb);
          return jb;
        });
        return { params, stmts: bodySeq(n.body, "tail") };
      });
      return [Const(loopB, Arrow(fn.params, collapseBody(fn.stmts))), Return(Call(Ref(loopB), inits))];
    });
  };

  // ── Lambda / DefineFn ──────────────────────────────────────────────────────────────

  /** Params + body share ONE scheme frame (a body-level redeclare of a param is a
   *  distinct scheme binding needing its own resolution entry). Sync-shaped by law:
   *  no `async` bit exists here (Law W). */
  const lowerLambdaLike = (
    params: readonly CfParam[],
    body: readonly CoreForm[],
  ): { params: Pattern[]; stmts: R[] } =>
    inSchemeFrame(() => {
      const ps: Pattern[] = params.map((p) => {
        const jb = declareJs(p.name);
        bind(p.name, jb);
        return p.rest ? RestBinding(jb) : jb;
      });
      return { params: ps, stmts: bodySeq(body, "tail") };
    });

  /** `{ return e; }` → `e` — the expression-arrow collapse (`(x) => x`, not
   *  `(x) => { return x; }`). Anything else keeps its block. */
  const collapseBody = (stmts: R[]): R => {
    const only = stmts.length === 1 ? stmts[0]! : undefined;
    return only !== undefined && only.t === "Return" && only.value !== undefined ? only.value : Block(stmts);
  };

  // ── App (the §4.2 dispatch ladder) ────────────────────────────────────────────────

  const lowerApp = (n: App): R => {
    // E2's idiom decision, consulted FIRST (engine plan §2 E2, second half):
    // the dissolved `peephole()` pass used to pre-rewrite the tree so this
    // ladder never saw the un-folded shape at all; `idiomAt` is the SAME
    // decision, asked inline. A decision recurses through the ordinary
    // ladder (never re-entering THIS check a second time for the SAME
    // reason it wouldn't have under the old pass — see `idiomDecisionAt`'s
    // own header: the two idioms match disjoint head shapes, so a fused/
    // trimmed node can never match either again).
    const idiom = opts.idiomAt?.(n);
    if (idiom !== undefined) return lowerApp(idiom);

    // Rung 0 (structural, pre-registry): keyword accessor `(:field obj)`. Index+Lit,
    // never Member — Dict writes raw keys, and the read MUST share that one key-fold
    // (engine-walker.md §5: `(let ((d (dict :max-words 5))) (:max-words d))`).
    //
    // ALIST BRANCH (V's 2026-07-17 ruling): `obj` PROVEN array-backed (`list`/`pair`/
    // `nonEmptyList` — the closed TypeFacts vocabulary's only "this is array-shaped"
    // signals; a Dict carries NONE of them — typefacts/facts.ts's own doc calls out
    // "a plain dict object" as a type the vocabulary has nothing to say about) AND
    // whose ELEMENTS are themselves proven array-backed (`elementFacts`) is an ALIST
    // — a list of `[k, v]` entries, never a dict: `obj["field"]` silently reads
    // `undefined` (an array carries no string-keyed "field" own property). Lower
    // Object.entries-shaped instead: find the entry whose key matches, project its
    // value — mirroring the interpreter's own accessor exactly (`AKeywordSymbol.apply`
    // → `APair#get`, foundations/arrival/arrival/src/values/primitives/APair.ts: walk
    // the list, return the FIRST match's `cdr`, else `nil`). `?.[1]` alone yields
    // `undefined` on a miss where the interpreter yields `nil` (membrane JS face
    // `[]`) — the `??` gates on the FOUND PAIR, never the projected value, so a hit
    // whose stored value happens to itself be `undefined` is never mistaken for a miss.
    //
    // The ELEMENT check matters on its own: a proven list of plain SCALARS (`(list 1 2
    // 3)` — `list`/`nonEmptyList` true, but elements are numbers, not pairs) has no
    // `[k, ...]`-destructurable entries — `.find(([k]) => …)` would THROW on the first
    // non-iterable element ("1 is not iterable") where the pre-existing `Index` form
    // only ever read `undefined`. Requiring the SAME array-shape proof one level down
    // (`elementFacts`) keeps that degenerate case on its original, non-crashing
    // (if equally unproven-correct) path — this branch may only ever improve outcomes
    // over `Index`, never introduce a new crash Law F didn't already accept.
    //
    // UNKNOWN shape (no fact proven at either level — a Dict, a non-alist list, or a
    // genuinely unproven receiver) keeps today's `Index` form unchanged: the dict
    // case's own recommended narrowing (engine-walker.md §5) doubles as the safe Law-F
    // default when the alist shape isn't provable — no universal dict-or-alist runtime
    // dispatch exists yet (a follow-up's concern, not this branch's).
    if (n.fn.kind === "Lit" && n.fn.value.kind === "keyword") {
      const field = n.fn.value.name;
      if (n.positionalArgs.length !== 1 || n.kwargs.length > 0) {
        return doorExpr(
          "malformed-source/keyword-accessor-arity",
          `the accessor \`(:${field} obj)\` takes exactly one operand.`,
        );
      }
      const recv = lowerExpr(n.positionalArgs[0]!);
      const recvFacts: TypeFacts = factsAt(n.positionalArgs[0]!.id) ?? {};
      const provesArray = (f: TypeFacts | undefined): boolean =>
        f?.list === true || f?.pair === true || f?.nonEmptyList === true;
      const provenAlist = provesArray(recvFacts) && provesArray(recvFacts.elementFacts);
      if (provenAlist) {
        const k = fresh("k");
        const found = Method(recv, "find", [Arrow([ArrayPattern([k])], Bin("===", Ref(k), Lit(field)))]);
        return Index(Bin("??", found, ArrayLit([Lit(undefined), ArrayLit([])])), Lit(1));
      }
      return Index(recv, Lit(field));
    }

    // Kwarg-collapse once, up front (§4): kwargs → ONE trailing options object with
    // cleanName'd keys — the App key space (deliberately different from Dict's raw
    // keys; engine-walker.md §4/§5, matching today's lowerCall convention).
    const argsR: R[] = n.positionalArgs.map(lowerExpr);
    const argFacts: TypeFacts[] = n.positionalArgs.map((a) => factsAt(a.id) ?? {});
    if (n.kwargs.length > 0) {
      argsR.push(
        ObjectLit(n.kwargs.map((e) => ({ kind: "prop" as const, key: cleanName(e.key), value: lowerExpr(e.value) }))),
      );
      argFacts.push({});
    }

    if (n.fn.kind === "Ref") {
      const local = resolve(n.fn.name);
      // Resolved ⇒ ordinary lexical call — the registry is NEVER consulted (a locally
      // shadowed builtin compiles to the local: `(let ((car …)) (car xs))`). Lexical
      // scope resolution is STRUCTURAL (the walker's own schemeFrames bookkeeping),
      // never a registry/semantic decision — `decisionFor`, below, is asked ONLY once
      // a name is proven free, exactly where the pre-E3 walker first reached the
      // registry.
      if (local !== undefined) return Call(Ref(local), argsR);
      const decision = decisionFor(n.fn.name, "call");
      switch (decision.rung) {
        case "door":
          return lowerDoor(decision);
        case "rule":
          return decision.rule.call(argsR, ctxFor(argFacts, factsAt(n.id), n.id));
        case "shim": {
          // rung 3: the named-import shim — E2's ingestion fold (S2) intercepts
          // here for `list`: a data-only argument list folds directly to a
          // chunk-expression (a genuine TS array literal), killing the stage-0
          // `list(...)` shim call for exactly the class the mission names ("the
          // list(1, 2) stage0 shim dies for literal data"). `tryFoldListCall`
          // aborts (returns `undefined`) whenever any argument's lowered form
          // isn't call-free (`isCallFree` — a fold-SCOPE policy, not a
          // walker-safety gate: every walker sees through slots per
          // mercury-ir.md's mutual-recursion rule), keeping this wave's churn to
          // the literal-data class the plan names. This is a STRUCTURAL check on
          // the verdict's own `row.symbol` field, never a second registry read.
          if (decision.row.symbol === "list" && n.kwargs.length === 0) {
            const folded = tryFoldListCall(argsR);
            if (folded !== undefined) return folded;
          }
          return Call(RuntimeRef(decision.row.symbol), argsR); // rung 3: the named-import shim
        }
      }
    }
    // Any other callee shape (Lambda IIFE, computed fn, …): an ordinary call — the
    // renderer parenthesizes an immediate-lambda callee structurally.
    return Call(lowerExpr(n.fn), argsR);
  };

  // ── the expression dispatcher ──────────────────────────────────────────────────────

  const lowerExpr = (n: CoreForm): R => {
    switch (n.kind) {
      case "Ref": {
        const b = resolve(n.name);
        return b !== undefined ? Ref(b) : registryValueRef(n.name, n.id);
      }
      case "Lit":
        return lowerLit(n);
      case "Quote":
        return datumToR(n.datum);
      case "Dict":
        // RAW keys — the Dict key space (see lowerApp's kwarg note).
        return ObjectLit(n.entries.map((e) => ({ kind: "prop" as const, key: e.key, value: lowerExpr(e.value) })));
      case "App":
        return lowerApp(n);
      case "If": {
        // R-G6 static prevaluation, consulted FIRST (mirrors `lowerApp`'s own
        // `idiomAt` consultation): a provably-constant guard folds to
        // WHICHEVER branch is live, dropping the other whole — including any
        // prohibited-dynamics door inside it (never lowered, never visited).
        const folded = opts.prevalueOf?.(n);
        if (folded !== undefined) return lowerExpr(folded);
        // The same-branch identity, consulted second (see
        // `WalkOptions.sameBranchOf`'s own doc) — `prevalueOf` couldn't
        // prove `n.cond`, but `then`/`else` may still be the identical
        // trivially-pure value regardless of which way `cond` goes.
        const sameBranch = opts.sameBranchOf?.(n);
        if (sameBranch !== undefined) return lowerExpr(sameBranch);
        return Cond(truthTest(n.cond), lowerExpr(n.then), lowerExpr(n.else));
      }
      case "And":
      case "Or": {
        const folded = opts.prevalueOf?.(n);
        if (folded !== undefined) return lowerExpr(folded);
        return lowerAndOr(n.args, n.kind === "And" ? "and" : "or");
      }
      case "Lambda": {
        const fn = lowerLambdaLike(n.params, n.body);
        return Arrow(fn.params, collapseBody(fn.stmts));
      }
      case "Let":
        return Block(letStmts(n, "tail"));
      case "NamedLet":
        return Block(namedLetStmts(n));
      case "Begin":
        return n.body.length === 1 ? lowerExpr(n.body[0]!) : Block(bodySeq(n.body, "tail"));
      case "Define":
      case "DefineFn":
        // Bodies route defines through bodySeq; one reaching EXPRESSION position
        // (an if-arm, an argument) has no value semantics — defensive door.
        return doorExpr("malformed-source/define-position", "`define` in expression position has no value — use `let`.");
      case "Door":
        return doorExpr(n.code, n.message);
      case "Require":
        // Expression position — the require's value is genuinely consumed here
        // (a define RHS, an inline call argument); a handled require IS its
        // resolved value, unwrapped (no Block/Return wrapping needed, unlike
        // the statement-position sites above).
        return opts.requireOf?.(n) ?? Block([requireThrow(n)]);
    }
  };

  // ── top level ──────────────────────────────────────────────────────────────────────

  /** R7RS top-level `begin` splices into the top level. */
  const flattenTopBegins = (forms: readonly CoreForm[]): CoreForm[] =>
    forms.flatMap((f) => (f.kind === "Begin" ? flattenTopBegins(f.body) : [f]));

  // Top-level `define` VALUE-binding propagation (`../propagate/index.ts`'s
  // `propagateTopLevelDefines` — literal-only, order-independent; see that
  // function's own header for why copy-propagation is NOT attempted at this
  // scope). A pure, stateless whole-program pass — called directly, no
  // `SchemeSemanticModel` view mediates it, mirroring `flattenTopBegins`
  // just above. Runs BEFORE `preRegisterDefines`/the main loop so a
  // propagated top-level literal is already in place everywhere `walk()`
  // lowers, the same "propagation before prevaluation" ordering `letStmts`
  // gives its own bindings. UNCONDITIONAL, unlike the per-`Let` fold's
  // supplied-view-or-default split (`propagationFor`, above): this pass
  // NEVER deletes a binding (only substitutes a literal value at its use
  // sites, leaving the origin `define` in place) — deletion of a now-dead
  // define is exclusively `shakeOf`'s decision, below, which alone carries
  // the rootedness/liveness knowledge a caller may or may not have wired
  // in. Folding without deleting is sound for EVERY caller, including a
  // real (unwrapped) module top level where every define is a named export
  // (`../build/scm-module.ts`'s module face): the export survives untouched
  // even though its value now also appears inlined at every internal read
  // (WALKER-NAMING audit finding #2 — this pass and `letStmts`'s per-`Let`
  // fold used to share ONE gate, `opts.propagationOf`'s presence, which
  // meant a module face declining the unsound top-level half also lost the
  // always-sound per-`Let` half; they are independent now).
  const flatForms = flattenTopBegins(classified.forms);
  const propagatedForms = propagateTopLevelDefines(flatForms);
  // E3's shake (../shake/index.ts's `shakeTopLevel`, `sm.shakeOf`) — runs AFTER
  // propagation so a define propagation makes unreferenced is shake-eligible too
  // (module header's own composition note), BEFORE `preRegisterDefines`/the main
  // loop so a pruned define never even reaches lowering. Gated on `opts.shakeOf`
  // being supplied: this IS the pass that actually deletes a binding, so it
  // remains the only one of the two still opt-in — nothing is ever removed
  // until a caller supplies real reachability/export knowledge.
  const forms = opts.shakeOf !== undefined ? opts.shakeOf(propagatedForms).forms : propagatedForms;
  const decls: Decl[] = [];
  const body: R[] = [];
  preRegisterDefines(forms); // top level is letrec*-flavored — mutual recursion resolves
  for (const form of forms) {
    if (form.kind === "Define") {
      decls.push(ConstDecl(bindingForDefine(form), lowerExpr(form.value)));
    } else if (form.kind === "DefineFn") {
      const b = bindingForDefine(form);
      const fn = lowerLambdaLike(form.params, form.body);
      decls.push(FnDecl(b, fn.params, Block(fn.stmts)));
    } else {
      body.push(...lowerStmts(form));
    }
  }
  const provisional: CompilationUnit = { decls, body };

  // ── the naming phase: census → allocate → materialize (engine plan §2 E1a) ────────
  // Reservations: the stage-0 manifest's exported names for exactly the runtime
  // symbols THIS unit still references (runtimeRefsOf — the SAME census FRAME's own
  // import materializer runs over this unit later, post-legibility/ASYNC-IFY) — never
  // the whole manifest: reserving an export no surviving RuntimeRef needs would
  // needlessly block a same-named user binding
  // (e.g. a local `car` shadow, or an unrelated `odd` binding, when this program never
  // calls the stage-0 `odd?`/`car`-in-value-position exports). Plus the three
  // hardcoded globals other passes reference by raw Binding — "Error" (this walker's
  // own doorThrow), "Math" (the quotient rule), "Promise" (ASYNC-IFY's Promise.all
  // rewrites) — matching the reservation this walker used to pre-seed into jsFrames[0]
  // directly.
  const stillNeeded = [...runtimeRefsOf(provisional)].map((s) => STAGE0[s]).filter((v): v is string => v !== undefined);
  const census = bindingCensusOf(provisional);
  const allocation = allocateNames(census, [...stillNeeded, "Error", "Math", "Promise"]);
  return materializeNames(provisional, allocation);
}

// ── RuntimeRef census (minimal-FRAME's input; the frame-as-query mechanism §3.4) ──────

/** Every `RuntimeRef` symbol occurring in the unit, in first-occurrence order (decls
 *  before body, pre-order within each tree). The FRAME wave turns this census into
 *  the runtime-module import list; until then it is the derivable seam. */
export function runtimeRefsOf(unit: CompilationUnit): ReadonlySet<string> {
  const out = new Set<string>();
  const visit = (r: R): void => {
    switch (r.t) {
      case "RuntimeRef":
        out.add(r.symbol);
        return;
      case "Ref":
      case "Lit":
      case "Continue":
        return;
      case "Template":
        for (const e of r.exprs) visit(e);
        return;
      case "Call":
      case "New":
        visit(r.callee);
        for (const a of r.args) visit(a);
        return;
      case "Method":
        visit(r.recv);
        for (const a of r.args) visit(a);
        return;
      case "Index":
        visit(r.recv);
        visit(r.index);
        return;
      case "Member":
        visit(r.recv);
        return;
      case "Bin":
        visit(r.left);
        visit(r.right);
        return;
      case "Un":
      case "Spread":
      case "Await":
      case "Throw":
        visit("arg" in r ? r.arg : r.value);
        return;
      case "Cond":
        visit(r.test);
        visit(r.then);
        visit(r.else);
        return;
      case "Arrow":
        visit(r.body);
        return;
      case "ArrayLit":
        for (const e of r.elements) visit(e);
        return;
      case "ObjectLit":
        for (const e of r.entries) visit(e.value);
        return;
      case "Block":
        for (const s of r.stmts) visit(s);
        return;
      case "Const":
      case "Let":
        visit(r.init);
        return;
      case "Assign":
        visit(r.value);
        return;
      case "Return":
        if (r.value !== undefined) visit(r.value);
        return;
      case "While":
        visit(r.test);
        visit(r.body);
        return;
      case "ForOf":
        visit(r.iterable);
        visit(r.body);
        return;
      case "If":
        visit(r.test);
        visit(r.then);
        if (r.else !== undefined) visit(r.else);
        return;
      case "Comment":
        visit(r.node);
        return;
      case "Annotated":
        visit(r.value);
        return;
      case "ChunkExpr":
      case "ChunkStmt":
        // The chunk `ast` itself is opaque syntax (never re-walked as
        // ts.Node) — but `.slots` is the census's OWN bridge back to the
        // fluid tree, mercury-ir.md's rule ("not by walking, by indexing"):
        // a slot-safe `list` fold can still bridge to a bare `RuntimeRef`
        // VALUE (e.g. `(list 1 2 car)` — `isCallFree` in this file's
        // `lowerApp` section permits exactly that), so the import census
        // must see through the slot or a required import silently vanishes.
        if (r.slots !== undefined) for (const slot of r.slots.values()) visit(slot);
        return;
    }
  };
  const visitDecl = (d: Decl): void => {
    switch (d.t) {
      case "FnDecl":
        visit(d.body);
        return;
      case "ConstDecl":
        visit(d.init);
        return;
      case "DeclComment":
        visitDecl(d.decl);
        return;
      case "Import":
      case "ImportType":
      case "Export":
        return;
    }
  };
  for (const d of unit.decls) visitDecl(d);
  for (const s of unit.body) visit(s);
  return out;
}
