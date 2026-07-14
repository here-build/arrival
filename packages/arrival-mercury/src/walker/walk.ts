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
 *  - §4.2 fallback ladder per free symbol: emit rule → (eta: SKIPPED this wave, degrades
 *    to shim — the instantiated-signature facts it needs haven't landed) → RuntimeRef
 *    shim → door. Silence is impossible by construction.
 *
 * Door materialization (the door-throw contract, wave-plan gate finding): a `Door` that
 * reaches the emitted artifact is a `Throw` residual whose message BEGINS with the
 * door's `code` ("<category>/<slug>: …") so the oracle's compiled-side classifier
 * catches every slug. Doors throw where the interpreter would — at evaluation time —
 * so a door on an untaken branch does not poison the program (interpreter parity).
 * The one compile-TIME refusal is `EmitCtx.door` (a rule declining a call site): that
 * throws `WalkDoorError` out of `walk()` itself.
 *
 * Scope/naming (this wave's minimal namer adapter): `cleanName`-ladder candidates +
 * scope-aware disambiguation — a binding whose candidate collides with ANY enclosing
 * open scope takes `${name}_${n}`, so nested scopes never shadow and splicing a tail
 * body into its parent block is unconditionally redeclare-safe (the same overlapping-
 * scope disambiguation the full lexical-namer performs). Disjoint scopes may reuse
 * names freely. `fresh()` mints `__`-prefixed glue names (`cleanName` can never emit
 * a leading underscore except the bare `_`, so user bindings cannot collide with them).
 */
import type { EmitConfig, EmitCtx, EmitRule, TypeFacts } from "@here.build/arrival/emit";

import type {
  App,
  ClassifyResult,
  CoreForm,
  Define,
  DefineFn,
  Let as CfLet,
  Lit as CfLit,
  NamedLet,
  NodeId,
  Param as CfParam,
  QuoteDatum,
  Require as CfRequire,
} from "../coreform/types.js";
import type { EmitRegistry, EmitRegistryRow } from "../registry/harvest.js";
import type { Binding, CompilationUnit, Decl, Pattern, R } from "../residual/types.js";
import {
  ArrayLit,
  ArrayPattern,
  Arrow,
  Assign,
  Binding as mkBinding,
  Block,
  Call,
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
  New,
  ObjectLit,
  Ref,
  RestBinding,
  Return,
  RuntimeRef,
  Throw,
  While,
} from "../residual/types.js";
import { cleanName, nameCandidates } from "./names.js";

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
  /** `"run"` = executable artifact (Law T strict); `"read"` = glass (clean forms). */
  readonly register: "run" | "read";
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

  // ── naming: scheme-name resolution frames + open JS-block name sets ─────────────

  const schemeFrames: Map<string, Binding>[] = [new Map()];
  // Module frame pre-seeds the globals the pipeline references by minted binding:
  // "Error" (door throws), "Math" (the quotient rule), "Promise" (ASYNC-IFY's
  // Promise.all rewrites). A user binding cleaning to any of these disambiguates to
  // `_2` instead of shadowing the global reference.
  const jsFrames: Set<string>[] = [new Set(["Error", "Math", "Promise"])];
  const freshUsed = new Set<string>();

  const resolve = (name: string): Binding | undefined => {
    for (let i = schemeFrames.length - 1; i >= 0; i--) {
      const hit = schemeFrames[i]!.get(name);
      if (hit !== undefined) return hit;
    }
    return undefined;
  };
  const jsTaken = (text: string): boolean => freshUsed.has(text) || jsFrames.some((f) => f.has(text));
  /** Mint the JS binding for a scheme name in the CURRENT JS block. Candidates ladder
   *  (`cleanName`, then `isFoo` for predicates), then `_2`/`_3`… against every OPEN
   *  scope — nested scopes never shadow (see module header). */
  const declareJs = (schemeName: string): Binding => {
    const candidates = nameCandidates(schemeName);
    let text = candidates.find((c) => !jsTaken(c));
    if (text === undefined) {
      for (let n = 2; ; n++) {
        const c = `${candidates[0]!}_${n}`;
        if (!jsTaken(c)) {
          text = c;
          break;
        }
      }
    }
    jsFrames.at(-1)!.add(text);
    return mkBinding(text);
  };
  const fresh = (hint: string): Binding => {
    const base = `__${cleanName(hint)}`;
    let text = base;
    for (let n = 2; jsTaken(text); n++) text = `${base}${n}`;
    freshUsed.add(text);
    jsFrames.at(-1)!.add(text);
    return mkBinding(text);
  };
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
  const inJsFrame = <T>(fn: () => T): T => {
    jsFrames.push(new Set());
    try {
      return fn();
    } finally {
      jsFrames.pop();
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

  /**
   * THE one explicit narrowing seam (wave-plan gate finding). `EmitRegistryRow.emit` is
   * stored opaque (`EmitRule` = `EmitRule<unknown>`) because arrival core cannot name
   * this package's `R` (§4.5 layering). Bivariant method-parameter checking makes a
   * rule authored against the real `R` assignable INTO the opaque slot, but the opaque
   * slot does not implicitly assign back out — the engine re-instantiates it here,
   * once, and nowhere else.
   */
  const ruleOf = (row: EmitRegistryRow): EmitRule<R> | undefined => row.emit as EmitRule<R> | undefined;

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

  const unresolvedDoor = (name: string): R =>
    doorExpr(
      "unsupported-form/unresolved-identifier",
      `\`${name}\` is not lexically bound and is not a registry symbol.`,
    );
  const doorRowExpr = (row: EmitRegistryRow): R =>
    doorExpr(`unsupported-form/${row.symbol}`, row.doorReason ?? `\`${row.symbol}\` is not supported in compiled output.`);

  /** Value position of a FREE name (`(map car xss)`'s `car`, a define's RHS): the same
   *  ladder as call position, minus the call — rule `ref` → refPolicy. `"eta"` degrades
   *  to shim this wave (needs `facts.callable`, the instantiated use-site signature —
   *  not extracted yet; Law F's value-position analog says shim is always sound). */
  const registryValueRef = (name: string, id: NodeId): R => {
    const row = registry.lookup(name);
    if (row === undefined) return unresolvedDoor(name);
    if (row.kind === "door") return doorRowExpr(row);
    const rule = ruleOf(row);
    if (rule?.ref !== undefined) return rule.ref(ctxFor([], facts.get(id), id));
    if (row.refPolicy === "door") {
      return doorExpr(
        `unsupported-form/${name}`,
        `\`${name}\` cannot be used as a first-class value in compiled output (refPolicy "door").`,
      );
    }
    return RuntimeRef(row.symbol); // "shim" (default) and this wave's "eta"
  };

  // ── Law T (truthiness) ─────────────────────────────────────────────────────────────

  /** Run-side Law T: bare iff proven boolean; otherwise exact-Scheme `c !== false`
   *  (only `#f` is false — `0`/`""` are truthy). Read register always bare (§1). */
  const truthTest = (cond: CoreForm): R => {
    const c = lowerExpr(cond);
    if (config.register === "read" || facts.get(cond.id)?.boolean === true) return c;
    return Bin("!==", c, Lit(false));
  };

  // ── And/Or ─────────────────────────────────────────────────────────────────────────

  const allBoolean = (args: readonly CoreForm[]): boolean =>
    args.every((a) => facts.get(a.id)?.boolean === true);

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

  /** Representation law (§2.1): symbol → interned name STRING, list → array. A datum
   *  never contains a bare dot (dotted pairs folded at classify time). Numeric text is
   *  unconditional `Number(text)` — one-number RATIO ruling, zero dispatch (§7). */
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
        return ArrayLit(d.items.map(datumToR));
    }
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
        return [Block(inJsFrame(() => letStmts(n, "stmt")))]; // bare block — scoped, no Return inside
      case "Door":
        return [doorThrow(n.code, n.message)];
      case "Require":
        return [requireThrow(n)];
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
      case "Require":
        return [requireThrow(n)];
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
  const letStmts = (n: CfLet, mode: SeqMode): R[] =>
    inSchemeFrame(() => {
      const consts: R[] = [];
      if (n.letKind === "let") {
        const inits = n.bindings.map((b) => lowerExpr(b.init)); // outer scope — frame is pushed but empty
        n.bindings.forEach((b, i) => {
          const jb = declareJs(b.name);
          bind(b.name, jb);
          consts.push(Const(jb, inits[i]!));
        });
      } else if (n.letKind === "let*") {
        for (const b of n.bindings) {
          const init = lowerExpr(b.init); // sees previous bindings only
          const jb = declareJs(b.name);
          bind(b.name, jb);
          consts.push(Const(jb, init));
        }
      } else {
        const jbs = n.bindings.map((b) => {
          const jb = declareJs(b.name);
          bind(b.name, jb);
          return jb;
        });
        n.bindings.forEach((b, i) => consts.push(Const(jbs[i]!, lowerExpr(b.init))));
      }
      return [...consts, ...bodySeq(n.body, mode)];
    });

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
        const thenB = inJsFrame(() => Block(tailLoopForm(n.then, mode)));
        const elseB = inJsFrame(() => Block(tailLoopForm(n.else, mode)));
        return [IfStmt(truthTest(n.cond), thenB, elseB)];
      }
      case "Begin":
        return bodySeq(n.body, mode);
      case "Let":
        return [Block(inJsFrame(() => letStmts(n, mode)))]; // nested block inside the while — Continue still binds the loop
      case "Door":
        return [doorThrow(n.code, n.message)];
      case "Require":
        return [requireThrow(n)];
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
        const loopBody = inJsFrame(() => bodySeq(n.body, { loopName: n.loopName, loopVars }));
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
      const fn = inSchemeFrame(() =>
        inJsFrame(() => {
          const params = n.bindings.map((b) => {
            const jb = declareJs(b.name);
            bind(b.name, jb);
            return jb;
          });
          return { params, stmts: bodySeq(n.body, "tail") };
        }),
      );
      return [Const(loopB, Arrow(fn.params, collapseBody(fn.stmts))), Return(Call(Ref(loopB), inits))];
    });
  };

  // ── Lambda / DefineFn ──────────────────────────────────────────────────────────────

  /** Params + body share ONE JS frame (TS params and body-block share a declaration
   *  scope — a body-level redeclare of a param is an error, so the namer must see them
   *  together). Sync-shaped by law: no `async` bit exists here (Law W). */
  const lowerLambdaLike = (
    params: readonly CfParam[],
    body: readonly CoreForm[],
  ): { params: Pattern[]; stmts: R[] } =>
    inSchemeFrame(() =>
      inJsFrame(() => {
        const ps: Pattern[] = params.map((p) => {
          const jb = declareJs(p.name);
          bind(p.name, jb);
          return p.rest ? RestBinding(jb) : jb;
        });
        return { params: ps, stmts: bodySeq(body, "tail") };
      }),
    );

  /** `{ return e; }` → `e` — the expression-arrow collapse (`(x) => x`, not
   *  `(x) => { return x; }`). Anything else keeps its block. */
  const collapseBody = (stmts: R[]): R => {
    const only = stmts.length === 1 ? stmts[0]! : undefined;
    return only !== undefined && only.t === "Return" && only.value !== undefined ? only.value : Block(stmts);
  };

  // ── App (the §4.2 dispatch ladder) ────────────────────────────────────────────────

  const lowerApp = (n: App): R => {
    // Rung 0 (structural, pre-registry): keyword accessor `(:field obj)`. Index+Lit,
    // never Member — Dict writes raw keys, and the read MUST share that one key-fold
    // (engine-walker.md §5: `(let ((d (dict :max-words 5))) (:max-words d))`).
    if (n.fn.kind === "Lit" && n.fn.value.kind === "keyword") {
      const field = n.fn.value.name;
      if (n.positionalArgs.length !== 1 || n.kwargs.length > 0) {
        return doorExpr(
          "malformed-source/keyword-accessor-arity",
          `the accessor \`(:${field} obj)\` takes exactly one operand.`,
        );
      }
      return Index(lowerExpr(n.positionalArgs[0]!), Lit(field));
    }

    // Kwarg-collapse once, up front (§4): kwargs → ONE trailing options object with
    // cleanName'd keys — the App key space (deliberately different from Dict's raw
    // keys; engine-walker.md §4/§5, matching today's lowerCall convention).
    const argsR: R[] = n.positionalArgs.map(lowerExpr);
    const argFacts: TypeFacts[] = n.positionalArgs.map((a) => facts.get(a.id) ?? {});
    if (n.kwargs.length > 0) {
      argsR.push(
        ObjectLit(n.kwargs.map((e) => ({ kind: "prop" as const, key: cleanName(e.key), value: lowerExpr(e.value) }))),
      );
      argFacts.push({});
    }

    if (n.fn.kind === "Ref") {
      const local = resolve(n.fn.name);
      // Resolved ⇒ ordinary lexical call — the registry is NEVER consulted (a locally
      // shadowed builtin compiles to the local: `(let ((car …)) (car xs))`).
      if (local !== undefined) return Call(Ref(local), argsR);
      const row = registry.lookup(n.fn.name);
      if (row === undefined) return unresolvedDoor(n.fn.name);
      if (row.kind === "door") return doorRowExpr(row);
      const rule = ruleOf(row); // the narrowing seam — see ruleOf
      if (rule !== undefined) return rule.call(argsR, ctxFor(argFacts, facts.get(n.id), n.id));
      return Call(RuntimeRef(row.symbol), argsR); // rung 3: the named-import shim
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
      case "If":
        return Cond(truthTest(n.cond), lowerExpr(n.then), lowerExpr(n.else));
      case "And":
        return lowerAndOr(n.args, "and");
      case "Or":
        return lowerAndOr(n.args, "or");
      case "Lambda": {
        const fn = lowerLambdaLike(n.params, n.body);
        return Arrow(fn.params, collapseBody(fn.stmts));
      }
      case "Let":
        return Block(inJsFrame(() => letStmts(n, "tail")));
      case "NamedLet":
        return Block(inJsFrame(() => namedLetStmts(n)));
      case "Begin":
        return n.body.length === 1 ? lowerExpr(n.body[0]!) : Block(inJsFrame(() => bodySeq(n.body, "tail")));
      case "Define":
      case "DefineFn":
        // Bodies route defines through bodySeq; one reaching EXPRESSION position
        // (an if-arm, an argument) has no value semantics — defensive door.
        return doorExpr("malformed-source/define-position", "`define` in expression position has no value — use `let`.");
      case "Door":
        return doorExpr(n.code, n.message);
      case "Require":
        return Block([requireThrow(n)]);
    }
  };

  // ── top level ──────────────────────────────────────────────────────────────────────

  /** R7RS top-level `begin` splices into the top level. */
  const flattenTopBegins = (forms: readonly CoreForm[]): CoreForm[] =>
    forms.flatMap((f) => (f.kind === "Begin" ? flattenTopBegins(f.body) : [f]));

  const forms = flattenTopBegins(classified.forms);
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
  return { decls, body };
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
