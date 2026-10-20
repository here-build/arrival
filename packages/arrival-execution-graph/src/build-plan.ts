/**
 * The control skeleton of a `Plan`: a pure lexical walk over the parsed program that records,
 * in evaluation order, every call site of a designated symbol (steps) and the control
 * structures that decide how often and in what order they run (frames). It computes no
 * dataflow — `Plan.edges` is always empty here; `dataflow.ts` joins arrival's wireframe later.
 *
 * Callee resolution, innermost first: lexical binders on the walk path (let-family, lambda
 * formals, internal defines; a formal of an inlined call is bound to the actual argument's
 * callee) → program defines (top-level and `begin`-nested; the latest define at or before the
 * top-level form being walked, else a forward one) → `scope` (an opaque closure — `ALambda`
 * keeps no body AST) → `vocabulary`. Globals never shadow; a name is designated when its
 * resolution is a designated name.
 *
 * Frames exist only around steps: every frame is walked tentatively and dropped when its
 * subtree holds none. Program functions are inlined at each call site (`call` frames, keys
 * prefixed with `${callSiteSpan}▸`); a recursive call becomes a `recur` of the frame it
 * re-enters (tail position) or a collapsed `recursive` stub (non-tail).
 *
 * Forms are walked structurally — head plus the operand spine. A cdr cell carries a location
 * of its own (`(map ask xs)` has a cell spanned `ask@…`) but is never a form; a bare
 * designated symbol passed as an argument has no Pair, so its step is keyed by the host call:
 * `${hostSpan}#arg<k>`.
 */

import { type LexicalScope, type SchemeValue, z } from "@here.build/arrival";
import { scopeId, writeForm } from "@here.build/arrival/provenance";

import {
  type Binding,
  bindingsOf,
  bracketItems,
  type DuckPair,
  type DuckSymbol,
  elements,
  isKeyword,
  isPair,
  isSymbol,
  kindOf,
  listItems,
  nameIs,
  operandSlots,
  symbolsIn,
  symName,
} from "./datum.js";
import type { CallbackRole, FrameKind, Plan, PlanFrame, PlanItem, PlanKey, PlanStep, Vocabulary } from "./plan.js";

export interface BuildPlanInput {
  readonly forms: readonly SchemeValue[];
  readonly symbols: ReadonlySet<string>;
  readonly vocabulary: Vocabulary;
  readonly scope?: LexicalScope;
}

export const PROGRAM_KEY = "<program>";

// ── forms ────────────────────────────────────────────────────────────────────────────────

/** An operand of a call form. */
interface Operand {
  readonly form: unknown;
}
const spine = (list: unknown): Operand[] => listItems(list).map((form) => ({ form }));

const spanOf = (form: unknown): string | undefined => (isPair(form) ? scopeId(form) : undefined);
/** Spans of the located Pairs a form list enters directly — seen through `[…]`/`{…}`
 *  literals, which lower to unlocated calls with no invocation of their own. */
const rootsOf = (forms: readonly unknown[]): string[] =>
  forms.flatMap((f): string[] => {
    if (isPair(f)) return [scopeId(f)];
    const items =
      bracketItems(f) ?? (kindOf(f) === "dict" ? (f as { literalForms?: unknown[] }).literalForms : undefined);
    return items ? rootsOf(items) : [];
  });
const print = (form: unknown): string => {
  try {
    return writeForm(form);
  } catch {
    return "?";
  }
};

// ── callee resolution ────────────────────────────────────────────────────────────────────

/** A program-defined procedure: a `define`d function or a lambda literal, with the lexical
 *  environment it closes over. `id` is its defining form — the recursion identity. */
interface Fn {
  readonly kind: "fn";
  readonly id: object;
  readonly name: string | undefined;
  readonly formals: readonly string[];
  readonly rest: string | undefined;
  readonly body: readonly unknown[];
  readonly env: Env;
  readonly designated: string | undefined;
  /** A lambda literal written inside an untracked macro use: its body gets no invocations. */
  readonly inMacro?: boolean;
}
/** A name outside the program text: scope binding, vocabulary entry, or unbound. */
interface Global {
  readonly kind: "global";
  readonly name: string;
  readonly designated: string | undefined;
  readonly entry: unknown;
}
/** A named-let loop variable. */
interface LoopVar {
  readonly kind: "loop";
  readonly id: object;
}
interface Value {
  readonly kind: "value";
}
/** A define whose right-hand side is a bare symbol, resolved lazily (forward references). */
interface Alias {
  readonly kind: "alias";
  readonly target: string;
  readonly env: Env;
  readonly as: string | undefined;
}
type Ref = Fn | Global | LoopVar | Value;
type Slot = Ref | Alias;

const VALUE: Value = { kind: "value" };

class Env {
  readonly vars = new Map<string, Slot>();
  constructor(readonly parent: Env | undefined) {}
  /** The innermost binding of `name`. */
  lookup(name: string): Slot | undefined {
    return this.vars.get(name) ?? this.parent?.lookup(name);
  }
}

const designatedOf = (r: Ref): string | undefined =>
  r.kind === "fn" || r.kind === "global" ? r.designated : undefined;

// ── the mutable plan under construction ──────────────────────────────────────────────────

interface Frame {
  kind: "frame";
  key: PlanKey;
  span: string;
  path: string;
  frame: FrameKind;
  label: string;
  symbol?: string;
  children: Item[];
  params: string[];
  bodyRoots: string[];
  armTests?: (string | undefined)[];
  recurSpans?: string[];
  iterationMarker?: string;
  tail?: boolean;
  host?: string;
  hostSite?: string;
  role?: CallbackRole;
  onRaise?: true;
  recursive?: boolean;
  /** A tail-recursive stub absorbed into its loop's `recurSpans`. */
  dropped?: boolean;
}
type Item = PlanStep | Frame;

/** One frame the walk is inside of that can be re-entered: an inlined call, a callback body,
 *  a named let. */
interface Entry {
  readonly kind: "call" | "callback" | "loop";
  readonly id: object;
  readonly frame: Frame;
  /** Every recursive site re-entering this frame, as the stub planted there. */
  readonly sites: { readonly stub: Frame; readonly tail: boolean }[];
}

interface Ctx {
  readonly out: Frame;
  readonly env: Env;
  readonly stack: readonly Entry[];
  readonly path: string;
  /** R7RS tail position relative to the innermost entry. */
  readonly tail: boolean;
  /** When `tail`: the lowest stack index the position is also in tail position for. */
  readonly tailBase: number;
  /** Index of the top-level form being walked — the call time for global resolution. */
  readonly top: number;
  /** Inside a macro use the plan does not expand: steps get `via: "macro"`. */
  readonly hosted?: boolean;
}

const MAX_DEPTH = 64;

const hasSteps = (item: Item): boolean =>
  item.kind === "step" || (item.dropped !== true && (item.recursive === true || item.children.some(hasSteps)));

const newFrame = (frame: FrameKind, path: string, span: string, label: string, extra: Partial<Frame> = {}): Frame => ({
  kind: "frame",
  key: path + span,
  span,
  path,
  frame,
  label,
  children: [],
  params: [],
  bodyRoots: [],
  ...extra,
});

/** Lambda-list → formals + rest: `(a b)`, `(a . r)`, `r`. */
function formalsOf(list: unknown): { formals: string[]; rest: string | undefined } {
  const formals: string[] = [];
  let c = list;
  for (; isPair(c); c = c.cdr) if (isSymbol(c.car)) formals.push(symName(c.car));
  return { formals, rest: isSymbol(c) ? symName(c) : undefined };
}

/** A clause test that always holds: `else` or `#t`. */
const isCatchAll = (test: unknown): boolean => nameIs(test, "else") || print(test) === "#t";

/** `(test => proc)` → proc's operand, else undefined. */
const arrowProc = (clauseRest: unknown): Operand | undefined => {
  const ops = spine(clauseRest);
  return ops.length >= 2 && nameIs(ops[0]!.form, "=>") ? ops[1] : undefined;
};

// ── the walker ───────────────────────────────────────────────────────────────────────────

type Special = (form: DuckPair, ctx: Ctx) => void;

class Walker {
  readonly diagnostics = new Set<string>();
  readonly root = new Env(undefined);
  private readonly globals = new Map<string, { index: number; slot: Slot }[]>();
  private readonly macros = new Set<string>();
  private readonly reach = new Map<object, boolean>();
  private readonly reaching = new Set<object>();

  constructor(
    private readonly symbols: ReadonlySet<string>,
    private readonly vocabulary: Vocabulary,
    private readonly scope: LexicalScope | undefined,
  ) {}

  // ── pass 0: program defines ──

  collectGlobals(forms: readonly unknown[]): void {
    const visit = (form: unknown, index: number): void => {
      if (!isPair(form) || !isSymbol(form.car)) return;
      const head = symName(form.car);
      switch (head) {
        case "begin": {
          for (const f of elements(form.cdr)) visit(f, index);
          break;
        }
        case "define-macro": {
          const sig = isPair(form.cdr) ? form.cdr.car : undefined;
          const name = isPair(sig) ? sig.car : sig;
          if (isSymbol(name)) this.macros.add(symName(name));
          break;
        }
        case "define": {
          const def = this.defineSlot(form, this.root);
          if (!def) return;
          const list = this.globals.get(def.name) ?? [];
          list.push({ index, slot: def.slot });
          this.globals.set(def.name, list);
          break;
        }
      }
    };
    for (const [i, f] of forms.entries()) visit(f, i);
  }

  /** `(define (f . formals) body…)` / `(define f (lambda …))` → Fn; `(define f g)` → alias. */
  private defineSlot(form: DuckPair, env: Env): { name: string; slot: Slot } | undefined {
    if (!isPair(form.cdr)) return undefined;
    const target = form.cdr.car;
    const rest = form.cdr.cdr;
    const global = env === this.root;
    if (isPair(target) && isSymbol(target.car)) {
      const name = symName(target.car);
      const { formals, rest: restFormal } = formalsOf(target.cdr);
      const designated = global && this.symbols.has(name) ? name : undefined;
      return {
        name,
        slot: {
          kind: "fn",
          id: form as object,
          name,
          formals,
          rest: restFormal,
          body: elements(rest),
          env,
          designated,
        },
      };
    }
    if (!isSymbol(target)) return undefined;
    const name = symName(target);
    const init = isPair(rest) ? rest.car : undefined;
    const as = global && this.symbols.has(name) ? name : undefined;
    if (this.isLambda(init, env))
      return { name, slot: { ...this.lambda(init as DuckPair, env, name), designated: as } };
    if (isSymbol(init)) return { name, slot: { kind: "alias", target: symName(init), env, as } };
    return { name, slot: VALUE };
  }

  private lookupGlobal(name: string, top: number): Slot | undefined {
    const defs = this.globals.get(name);
    if (!defs) return undefined;
    let found: Slot | undefined;
    for (const d of defs) if (d.index <= top) found = d.slot;
    return found;
  }

  resolve(name: string, env: Env, top: number, seen = new Set<Alias>()): Ref {
    const local = env.lookup(name);
    if (local !== undefined) return this.deref(local, top, seen);
    const global = this.lookupGlobal(name, top);
    if (global !== undefined) return this.deref(global, top, seen);
    let value: unknown;
    try {
      value = this.scope?.lookup(name);
    } catch {
      value = undefined;
    }
    const entry = value ?? this.vocabulary.get(name);
    const own = nameOfValue(value);
    let designated: string | undefined;
    if (this.symbols.has(name)) designated = name;
    else if (own !== undefined && this.symbols.has(own)) designated = own;
    return { kind: "global", name, designated, entry };
  }

  private deref(slot: Slot, top: number, seen: Set<Alias>): Ref {
    if (slot.kind !== "alias") return slot;
    if (seen.has(slot)) return VALUE;
    seen.add(slot);
    const r = this.resolve(slot.target, slot.env, top, seen);
    if (slot.as === undefined || designatedOf(r) !== undefined) return r;
    return r.kind === "fn" || r.kind === "global" ? { ...r, designated: slot.as } : r;
  }

  private isLambda(form: unknown, env: Env): boolean {
    return isPair(form) && nameIs(form.car, "lambda") && env.lookup("lambda") === undefined;
  }

  private lambda(form: DuckPair, env: Env, name?: string): Fn {
    const parts = isPair(form.cdr) ? form.cdr : undefined;
    const { formals, rest } = formalsOf(parts?.car);
    return {
      kind: "fn",
      id: form as object,
      name,
      formals,
      rest,
      body: elements(parts?.cdr),
      env,
      designated: undefined,
    };
  }

  /** The callee a form denotes when used as a value: a symbol's resolution, a lambda literal. */
  private refOf(form: unknown, ctx: Ctx): Ref {
    if (isSymbol(form)) return this.resolve(symName(form), ctx.env, ctx.top);
    if (this.isLambda(form, ctx.env))
      return { ...this.lambda(form as DuckPair, ctx.env), inMacro: ctx.hosted === true };
    return VALUE;
  }

  private isMacro(name: string): boolean {
    if (this.macros.has(name)) return true;
    let value: unknown;
    try {
      value = this.scope?.lookup(name);
    } catch {
      value = undefined;
    }
    const entry = (value ?? this.vocabulary.get(name)) as Record<string, unknown> | undefined;
    return entry?.["arrival/is-macro"] === true;
  }

  // ── reach: may a procedure's body run a step? (least fixpoint; over-approximates) ──

  mayReach(fn: Fn): boolean {
    const memo = this.reach.get(fn.id);
    if (memo !== undefined) return memo;
    if (this.reaching.has(fn.id)) return false;
    this.reaching.add(fn.id);
    const formals = new Set(formalNames(fn));
    const result = fn.body.some((form) => this.formReaches(fn, formals, form));
    this.reaching.delete(fn.id);
    this.reach.set(fn.id, result);
    return result;
  }

  /** One body form of `fn`: a designated name, a procedure that reaches, or a formal called. */
  private formReaches(fn: Fn, formals: ReadonlySet<string>, form: unknown): boolean {
    for (const name of symbolsIn(form)) {
      if (this.symbols.has(name)) return true;
      if (formals.has(name)) continue;
      const r = this.resolve(name, fn.env, Number.POSITIVE_INFINITY);
      if ((r.kind === "fn" && r.id !== fn.id && this.mayReach(r)) || designatedOf(r) !== undefined) return true;
    }
    // A formal in head position calls whatever the caller passes — decided per call site.
    return formals.size > 0 && callsAny(form, formals);
  }

  private reachesAsCallback(r: Ref): boolean {
    return designatedOf(r) !== undefined || (r.kind === "fn" && this.mayReach(r));
  }

  // ── forms ──

  walk(form: unknown, ctx: Ctx): void {
    if (isPair(form)) {
      this.walkPair(form, ctx);
      return;
    }
    const items =
      bracketItems(form) ?? (kindOf(form) === "dict" ? (form as { literalForms?: unknown[] }).literalForms : undefined);
    if (items) for (const el of items) this.walk(el, nonTail(ctx));
  }

  private walkPair(form: DuckPair, ctx: Ctx): void {
    if (isSymbol(form.car)) {
      const name = symName(form.car);
      if (ctx.env.lookup(name) === undefined) {
        const special = SPECIAL[name];
        if (special) {
          special.call(this, form, ctx);
          return;
        }
        if (this.isMacro(name)) {
          this.walkUnknownForm(form, name, ctx);
          return;
        }
      }
    }
    this.walkCall(form, ctx);
  }

  walkBody(forms: readonly unknown[], ctx: Ctx): void {
    this.bindInternalDefines(forms, ctx.env);
    for (const [i, f] of forms.entries()) this.walk(f, { ...ctx, tail: ctx.tail && i === forms.length - 1 });
  }

  /** letrec* semantics: every internal define is visible to the whole body. */
  private bindInternalDefines(forms: readonly unknown[], env: Env): void {
    if (env === this.root) return;
    for (const f of forms) {
      if (!isPair(f)) continue;
      if (nameIs(f.car, "begin")) this.bindInternalDefines(elements(f.cdr), env);
      else if (nameIs(f.car, "define")) {
        const def = this.defineSlot(f, env);
        if (def) env.vars.set(def.name, def.slot);
      }
    }
  }

  walkSeq(forms: readonly unknown[], ctx: Ctx): void {
    for (const [i, f] of forms.entries()) this.walk(f, { ...ctx, tail: ctx.tail && i === forms.length - 1 });
  }

  /** A macro use the plan does not expand, walked operand by operand. Only macros known to
   *  splice the user's own Pairs (`and-let*`) keep located steps; every other expansion builds
   *  Pairs at the macro use's location, so its steps are hosted: the projector lands each call
   *  the expansion makes on its step, the macro invocation stands in for the rest. */
  private walkUnknownForm(form: DuckPair, name: string, ctx: Ctx): void {
    const hosted = !SPLICING_MACROS.has(name);
    this.diagnostics.add(
      `"${name}" at ${scopeId(form)} is a macro the plan does not expand; its operands were walked as plain ` +
        `expressions in order${hosted ? ", and their steps take the macro invocation's state" : ""}`,
    );
    const inner = hosted ? { ...nonTail(ctx), hosted: true } : nonTail(ctx);
    for (const { form: op } of spine(form.cdr)) if (isPair(op)) this.walk(op, inner);
  }

  // ── calls ──

  private walkCall(form: DuckPair, ctx: Ctx): void {
    const site = scopeId(form);
    const ops = spine(form.cdr);
    let ref: Ref;
    if (isSymbol(form.car)) ref = this.resolve(symName(form.car), ctx.env, ctx.top);
    else if (this.isLambda(form.car, ctx.env))
      ref = { ...this.lambda(form.car as DuckPair, ctx.env), inMacro: ctx.hosted === true };
    else {
      this.walk(form.car, nonTail(ctx));
      ref = VALUE;
    }

    if (ref.kind === "loop") {
      this.walkOperands(ops, ctx, "the loop");
      this.recur(ref, site, ctx);
      return;
    }
    if (ref.kind === "fn") {
      this.walkOperands(ops, ctx, undefined);
      this.enter(
        ref,
        site,
        ops,
        ops.map((o) => this.refOf(o.form, ctx)),
        ctx,
      );
      return;
    }
    if (ref.kind === "global" && ref.name === "apply" && ref.designated === undefined && ops.length > 0) {
      this.walkApply(site, ops, ctx);
      return;
    }
    if (ref.kind === "global") {
      const callbacks = this.callbacks(ref, ops, ctx);
      if (callbacks.some((c) => c.reaches)) {
        this.walkHost(site, ref, ops, callbacks, ctx);
        return;
      }
    }
    this.walkOperands(ops, ctx, ref.kind === "global" ? ref.name : "a computed procedure");
    const designated = designatedOf(ref);
    if (designated !== undefined) this.pushStep(ctx, site, designated, ops);
  }

  /** Operands in order. With `valueHost`, a bare designated symbol among them is a value the
   *  host does not call: no step, one diagnostic. */
  private walkOperands(ops: readonly Operand[], ctx: Ctx, valueHost: string | undefined): void {
    for (const op of ops) {
      if (!isSymbol(op.form)) this.walk(op.form, nonTail(ctx));
      else if (valueHost !== undefined) this.noteValue(op, valueHost, ctx);
    }
  }

  private noteValue(op: Operand, host: string, ctx: Ctx): void {
    if (!isSymbol(op.form) || isKeyword(op.form)) return;
    const designated = designatedOf(this.resolve(symName(op.form), ctx.env, ctx.top));
    if (designated !== undefined)
      this.diagnostics.add(`\`${designated}\` passed as a value to \`${host}\` — not called here`);
  }

  private pushStep(ctx: Ctx, span: string, symbol: string, ops: readonly Operand[], via?: "apply"): void {
    const v = ctx.hosted ? "macro" : via;
    const step: PlanStep = {
      kind: "step",
      key: ctx.path + span,
      span,
      path: ctx.path,
      symbol,
      args: argsOf(ops),
      ...(v ? { via: v } : {}),
    };
    ctx.out.children.push(step);
  }

  /** Inline a program procedure at `site` (operands already walked). */
  private enter(fn: Fn, site: string, ops: readonly Operand[], argRefs: readonly Ref[], ctx: Ctx, via?: "apply"): void {
    const reachingArg = argRefs.some((r) => this.reachesAsCallback(r));
    const fallback = (): void => {
      if (fn.designated === undefined) {
        for (const op of ops) this.noteValue(op, fn.name ?? "λ", ctx);
      } else {
        this.pushStep(ctx, site, fn.designated, ops, via);
      }
    };
    if (!this.mayReach(fn) && !reachingArg) {
      fallback();
      return;
    }
    const j = findLastIndex(ctx.stack, (e) => e.id === fn.id);
    if (j >= 0) {
      this.recurse(j, site, ctx, ctx.tail && ctx.tailBase <= j, ctx.path);
      return;
    }
    if (ctx.stack.length >= MAX_DEPTH) {
      this.diagnostics.add(`inlining stopped at depth ${MAX_DEPTH} (${site}); deeper calls are not planned`);
      return;
    }
    const frame = newFrame("call", ctx.path, site, fn.name ?? "λ", {
      params: formalNames(fn),
      bodyRoots: rootsOf(fn.body),
      ...(fn.designated === undefined ? {} : { symbol: fn.designated }),
    });
    const entry: Entry = { kind: "call", id: fn.id, frame, sites: [] };
    this.walkFnBody(fn, argRefs, entry, `${ctx.path}${site}▸`, ctx, ctx.tail);
    settleRecursion(entry);
    if (hasSteps(frame)) ctx.out.children.push(frame);
    else fallback();
  }

  /** `fn`'s body inside `entry.frame`, formals bound to `argRefs`. `tailCall`: the body is
   *  also in tail position for every entry the call site was. */
  private walkFnBody(fn: Fn, argRefs: readonly Ref[], entry: Entry, path: string, ctx: Ctx, tailCall: boolean): void {
    const env = new Env(fn.env);
    for (const [i, f] of fn.formals.entries()) env.vars.set(f, argRefs[i] ?? VALUE);
    if (fn.rest) env.vars.set(fn.rest, VALUE);
    const index = ctx.stack.length;
    this.walkBody(fn.body, {
      out: entry.frame,
      env,
      stack: [...ctx.stack, entry],
      path,
      tail: true,
      tailBase: tailCall ? Math.min(ctx.tailBase, index) : index,
      top: ctx.top,
      // A named procedure's body Pairs are the user's own and get tapped even when the call was
      // built by a macro; a lambda literal written inside the macro use does not.
      hosted: fn.inMacro === true,
    });
  }

  /** A call re-entering the `j`-th stack entry: a collapsed stub at the site. Once the entry's
   *  walk ends, `settleRecursion` absorbs the stubs into a loop iff every site is a tail call. */
  private recurse(j: number, site: string, ctx: Ctx, tail: boolean, path: string): void {
    const entry = ctx.stack[j]!;
    const { frame } = entry;
    const stub = newFrame("call", path, site, frame.label, {
      params: frame.params,
      bodyRoots: frame.bodyRoots,
      recursive: true,
      ...(frame.symbol === undefined ? {} : { symbol: frame.symbol }),
    });
    ctx.out.children.push(stub);
    entry.sites.push({ stub, tail: tail && entry.kind !== "callback" });
  }

  private recur(ref: LoopVar, site: string, ctx: Ctx): void {
    const j = findLastIndex(ctx.stack, (e) => e.id === ref.id);
    if (j < 0) {
      this.diagnostics.add(`loop variable called outside its loop at ${site}; not planned as an iteration`);
      return;
    }
    this.recurse(j, site, ctx, ctx.tail && ctx.tailBase <= j, ctx.path);
  }

  private walkApply(site: string, ops: readonly Operand[], ctx: Ctx): void {
    const [f, ...args] = ops as [Operand, ...Operand[]];
    const ref = this.refOf(f.form, ctx);
    if (!isSymbol(f.form) && ref.kind !== "fn") this.walk(f.form, nonTail(ctx));
    this.walkOperands(args, ctx, site);
    if (ref.kind === "fn")
      this.enter(
        ref,
        site,
        args,
        args.map(() => VALUE),
        ctx,
        "apply",
      );
    else if (ref.kind === "global" && ref.designated !== undefined)
      this.pushStep(ctx, site, ref.designated, args, "apply");
  }

  // ── higher-order hosts ──

  /** `(cut f <>…)` / `(cute f …)` with a symbol `f`: the callback is `f` itself, applied by the
   *  host (the macro builds an untracked lambda; the call gets no invocation of its own). */
  private cutTarget(form: unknown, ctx: Ctx): DuckSymbol | undefined {
    if (!isPair(form) || !isSymbol(form.car) || ctx.env.lookup(symName(form.car)) !== undefined) return undefined;
    if (symName(form.car) !== "cut" && symName(form.car) !== "cute") return undefined;
    const f = isPair(form.cdr) ? form.cdr.car : undefined;
    return isSymbol(f) ? f : undefined;
  }

  /** The operands `host` calls back. Lambda positions come from the host's contract; with no
   *  readable contract every procedure operand counts, its role taken in operand order. */
  private callbacks(host: Global, ops: readonly Operand[], ctx: Ctx): Callback[] {
    const out: Callback[] = [];
    const lambdaAt = lambdaPositions(host.entry);
    let role = 0;
    for (const [index, op] of ops.entries()) {
      if (lambdaAt !== undefined && lambdaAt(index) === undefined) continue;
      const cut = this.cutTarget(op.form, ctx);
      if (cut !== undefined) {
        const ref = this.resolve(symName(cut), ctx.env, ctx.top);
        const roleIndex = lambdaAt?.(index) ?? role++;
        out.push({ op: { form: cut }, index, roleIndex, ref, reaches: this.reachesAsCallback(ref) });
        continue;
      }
      if (!isSymbol(op.form) && !this.isLambda(op.form, ctx.env)) {
        this.noteComputedCallback(op.form, ctx);
        continue;
      }
      const ref = this.refOf(op.form, ctx);
      if (ref.kind === "value" || ref.kind === "loop") continue;
      if (ref.kind === "global" && ref.designated === undefined && !isProcedure(ref.entry)) continue;
      const roleIndex = lambdaAt?.(index) ?? role++;
      out.push({ op, index, roleIndex, ref, reaches: this.reachesAsCallback(ref) });
    }
    return out;
  }

  /** A callback operand that is a call returning a reaching lambda: not planned, said so. */
  private noteComputedCallback(form: unknown, ctx: Ctx): void {
    if (!isPair(form) || !isSymbol(form.car)) return;
    const head = this.resolve(symName(form.car), ctx.env, ctx.top);
    if (head.kind === "fn" && head.body.some((b) => this.isLambda(b, head.env)) && this.mayReach(head)) {
      this.diagnostics.add(
        `callback ${scopeId(form)} is computed by a call; its body is not planned (only lambda literals and named procedures are)`,
      );
    }
  }

  /** A builtin (or designated) host given at least one reaching callback. The collection
   *  operands evaluate first; each reaching callback then becomes one frame. */
  private walkHost(
    site: string,
    host: Global,
    ops: readonly Operand[],
    callbacks: readonly Callback[],
    ctx: Ctx,
  ): void {
    const reaching = new Set(callbacks.filter((c) => c.reaches).map((c) => c.index));
    this.walkOperands(
      ops.filter((_, k) => !reaching.has(k)),
      ctx,
      host.name,
    );
    const entry = host.entry as
      | { provenanceRole?: string; callbackRoles?: readonly (string | null | undefined)[] }
      | undefined;
    let first = true;
    const before = ctx.out.children.length;
    for (const cb of callbacks) {
      if (!cb.reaches) continue;
      const role = entry?.callbackRoles?.[cb.roleIndex] ?? undefined;
      const span = first ? site : `${site}#${cb.index}`;
      first = false;
      const frame = hostFrame(host.name, site, span, ctx.path, entry?.provenanceRole, role);
      this.walkCallback(cb, frame, `${site}#arg${cb.index}`, `${ctx.path}${span}▸`, ctx);
      if (hasSteps(frame)) ctx.out.children.push(frame);
    }
    if (host.designated !== undefined) {
      const frames = ctx.out.children.slice(before).filter((c): c is Frame => c.kind === "frame");
      if (frames.length > 0) for (const f of frames) f.symbol = host.designated;
      else this.pushStep(ctx, site, host.designated, ops);
    }
  }

  /** A bare designated callback has no Pair (its spine cell is not a form, F21): the step is
   *  keyed `${hostSpan}#arg<k>` and runs inside the host's invocation. */
  private walkCallback(cb: Callback, frame: Frame, argSpan: string, namedPath: string, ctx: Ctx): void {
    const { ref, op } = cb;
    const bare = (): void => {
      const designated = designatedOf(ref);
      if (designated === undefined) return;
      frame.children.push({
        kind: "step",
        key: ctx.path + argSpan,
        span: argSpan,
        path: ctx.path,
        symbol: designated,
        args: [],
        via: viaOf(ctx),
      });
    };
    if (ref.kind !== "fn") {
      bare();
      return;
    }
    frame.params = formalNames(ref);
    frame.bodyRoots = rootsOf(ref.body);
    if (ref.name !== undefined && ref.name !== frame.host) frame.label = `${frame.host} ${ref.name}`;
    const j = findLastIndex(ctx.stack, (e) => e.id === ref.id);
    if (j >= 0) {
      const span = isSymbol(op.form) ? argSpan : (spanOf(op.form) ?? argSpan);
      this.recurse(j, span, { ...ctx, out: frame }, false, namedPath);
      return;
    }
    if (ctx.stack.length >= MAX_DEPTH) return;
    // A named procedure's body can be inlined elsewhere too: give its keys this host's prefix.
    const path = isSymbol(op.form) ? namedPath : ctx.path;
    this.walkFnBody(ref, [], { kind: "callback", id: ref.id, frame, sites: [] }, path, ctx, false);
    if (!hasSteps(frame) && ref.designated !== undefined) {
      frame.children = [];
      frame.bodyRoots = [];
      bare();
    }
  }

  // ── binding forms ──

  private walkLet(form: DuckPair, ctx: Ctx, kind: "let" | "let*" | "letrec"): void {
    const rest = elements(form.cdr);
    if (kind === "let" && isSymbol(rest[0])) {
      this.walkNamedLet(form, symName(rest[0]), rest[1], rest.slice(2), ctx);
      return;
    }
    const bindings = bindingsOf(rest[0]);
    const env = new Env(ctx.env);
    if (kind === "let") this.bindParallel(bindings, env, ctx);
    else if (kind === "let*") this.bindSequential(bindings, env, ctx);
    else this.bindRecursive(bindings, env, ctx);
    this.walkBody(rest.slice(1), { ...ctx, env });
  }

  /** `let`: every init sees the outer scope. */
  private bindParallel(bindings: readonly Binding[], env: Env, ctx: Ctx): void {
    const refs = bindings.map((b) => {
      if (b.hasInit) this.walk(b.init, { ...nonTail(ctx), env: ctx.env });
      return this.refOf(b.init, ctx);
    });
    for (const [i, b] of bindings.entries()) env.vars.set(b.name, refs[i]!);
  }

  /** `let*`: each init sees the bindings before it. */
  private bindSequential(bindings: readonly Binding[], env: Env, ctx: Ctx): void {
    for (const b of bindings) {
      const inner = { ...nonTail(ctx), env };
      if (b.hasInit) this.walk(b.init, inner);
      env.vars.set(b.name, this.refOf(b.init, inner));
    }
  }

  /** `letrec`/`letrec*`: lambdas see every binding of the frame. */
  private bindRecursive(bindings: readonly Binding[], env: Env, ctx: Ctx): void {
    const inner = { ...nonTail(ctx), env };
    for (const b of bindings) {
      env.vars.set(b.name, this.isLambda(b.init, env) ? this.lambda(b.init as DuckPair, env, b.name) : VALUE);
    }
    for (const b of bindings) {
      if (b.hasInit) this.walk(b.init, inner);
      if (isSymbol(b.init)) env.vars.set(b.name, this.refOf(b.init, inner));
    }
  }

  private walkNamedLet(form: DuckPair, name: string, bindingList: unknown, body: unknown[], ctx: Ctx): void {
    const bindings = bindingsOf(bindingList);
    for (const b of bindings) if (b.hasInit) this.walk(b.init, nonTail(ctx));
    const span = scopeId(form);
    const frame = newFrame("loop", ctx.path, span, name, {
      params: bindings.map((b) => b.name),
      bodyRoots: rootsOf(body),
      recurSpans: [],
      tail: true,
    });
    const id = form as object;
    const env = new Env(ctx.env);
    env.vars.set(name, { kind: "loop", id });
    const inner = new Env(env);
    for (const b of bindings) inner.vars.set(b.name, VALUE);
    const index = ctx.stack.length;
    const entry: Entry = { kind: "loop", id, frame, sites: [] };
    this.walkBody(body, {
      ...ctx,
      out: frame,
      env: inner,
      stack: [...ctx.stack, entry],
      tail: true,
      tailBase: ctx.tail ? Math.min(ctx.tailBase, index) : index,
    });
    settleRecursion(entry);
    if (hasSteps(frame)) ctx.out.children.push(frame);
  }

  private walkDo(form: DuckPair, ctx: Ctx): void {
    const [specs, exit, ...body] = elements(form.cdr);
    const vars = elements(specs).map((s) => elements(s));
    for (const v of vars) if (v.length > 1) this.walk(v[1], nonTail(ctx));
    const [test, ...results] = elements(exit);
    const steps = vars.filter((v) => v.length > 2).map((v) => v[2]);
    const span = scopeId(form);
    const frame = newFrame("loop", ctx.path, span, "do", {
      params: vars.flatMap((v) => (isSymbol(v[0]) ? [symName(v[0])] : [])),
      bodyRoots: rootsOf([test, ...body, ...steps]),
      ...(spanOf(test) === undefined ? {} : { iterationMarker: spanOf(test) }),
    });
    const env = new Env(ctx.env);
    for (const p of frame.params) env.vars.set(p, VALUE);
    const inner: Ctx = { ...ctx, out: frame, env, tail: false };
    this.walk(test, inner);
    this.walkBody(body, inner);
    for (const s of steps) this.walk(s, inner);
    if (hasSteps(frame)) ctx.out.children.push(frame);
    this.walkSeq(results, { ...ctx, env });
  }

  private walkWhile(form: DuckPair, ctx: Ctx): void {
    const [test, ...body] = elements(form.cdr);
    const span = scopeId(form);
    const frame = newFrame("loop", ctx.path, span, "while", {
      bodyRoots: rootsOf([test, ...body]),
      ...(spanOf(test) === undefined ? {} : { iterationMarker: spanOf(test) }),
    });
    const inner: Ctx = { ...ctx, out: frame, env: new Env(ctx.env), tail: false };
    this.walk(test, inner);
    this.walkBody(body, inner);
    if (hasSteps(frame)) ctx.out.children.push(frame);
  }

  // ── branches ──

  /** One `branch` frame with an `arm` per entry; dropped when no arm holds a step. An arm's
   *  `tests` are walked inside it (cond clause k ≥ 1) and count toward the branch's interior. */
  private branch(ctx: Ctx, span: string, label: string, arms: readonly Arm[], extra: Partial<Frame> = {}): void {
    const frame = newFrame("branch", ctx.path, span, label, extra);
    for (const [k, arm] of arms.entries()) {
      const armSpan = `${span}#${k}`;
      const armFrame = newFrame("arm", ctx.path, armSpan, arm.label, { bodyRoots: rootsOf(arm.roots) });
      arm.walk({ ...ctx, out: armFrame });
      frame.children.push(armFrame);
      frame.bodyRoots.push(...rootsOf(arm.inner ?? []), ...armFrame.bodyRoots);
    }
    if (arms.some((a) => a.test !== undefined)) frame.armTests = arms.map((a) => a.test);
    if (frame.children.some(hasSteps)) ctx.out.children.push(frame);
  }

  private walkIf(form: DuckPair, ctx: Ctx): void {
    const [test, then, ...otherwise] = elements(form.cdr);
    this.walk(test, nonTail(ctx));
    const alt = otherwise.slice(0, 1);
    this.branch(ctx, scopeId(form), "if", [
      { label: "then", roots: [then], walk: (c) => this.walk(then, c) },
      { label: "else", roots: alt, walk: (c) => this.walkSeq(alt, c) },
    ]);
  }

  private walkWhen(form: DuckPair, ctx: Ctx, unless: boolean): void {
    const [test, ...body] = elements(form.cdr);
    this.walk(test, nonTail(ctx));
    const bodyArm: Arm = {
      label: unless ? "else" : "then",
      roots: body,
      walk: (c) => this.walkBody(body, { ...c, env: new Env(c.env) }),
    };
    const empty: Arm = { label: unless ? "then" : "else", roots: [], walk: () => {} };
    this.branch(ctx, scopeId(form), unless ? "unless" : "when", unless ? [empty, bodyArm] : [bodyArm, empty]);
  }

  /** `cond`-shaped clauses as ONE branch: clause 0's test is the selector (walked before the
   *  branch); clause k ≥ 1's test runs inside arm k, before its body. A catch-all clause
   *  (`else` / `#t`) ends the chain — later clauses never run; without one the chain ends in an
   *  implicit empty arm, labelled `implicit`. */
  private walkClauses(clauses: readonly unknown[], ctx: Ctx, span: string, label: string, implicit = "else"): void {
    const arms: Arm[] = [];
    for (const [k, clause] of clauses.entries()) {
      const [test, ...body] = elements(clause);
      const rest = isPair(clause) ? clause.cdr : undefined;
      const arrowSpan = `${span}#clause${k}`;
      if (nameIs(test, "else")) {
        arms.push({ label: "else", roots: body, walk: (c) => this.walkClauseBody(body, rest, c, arrowSpan) });
        break;
      }
      if (k === 0) this.walk(test, nonTail(ctx));
      const inner = k === 0 ? [] : [test];
      const catchAll = isCatchAll(test);
      arms.push({
        label: print(test),
        roots: body,
        inner,
        test: spanOf(test),
        walk: (c) => {
          for (const t of inner) this.walk(t, nonTail(c));
          this.walkClauseBody(body, rest, c, arrowSpan);
        },
      });
      if (catchAll) break;
      if (k === clauses.length - 1) arms.push({ label: implicit, roots: [], walk: () => {} });
    }
    this.branch(ctx, span, label, arms);
  }

  /** A clause body, or `=> proc` applied to the test value (a bare designated proc is a step
   *  keyed `arrowSpan`: it has no Pair of its own). */
  private walkClauseBody(body: readonly unknown[], rest: unknown, ctx: Ctx, arrowSpan: string): void {
    const arrow = arrowProc(rest);
    if (!arrow) {
      this.walkSeq(body, ctx);
      return;
    }
    const ref = this.refOf(arrow.form, ctx);
    if (!isSymbol(arrow.form) && ref.kind !== "fn") this.walk(arrow.form, nonTail(ctx));
    const designated = designatedOf(ref);
    if (ref.kind === "fn" && (designated === undefined || this.mayReach(ref))) {
      this.enter(ref, spanOf(arrow.form) ?? arrowSpan, [], [VALUE], ctx);
    } else {
      if (designated !== undefined) {
        ctx.out.children.push({
          kind: "step",
          key: ctx.path + arrowSpan,
          span: arrowSpan,
          path: ctx.path,
          symbol: designated,
          args: [],
          via: viaOf(ctx),
        });
      }
    }
  }

  private walkCond(form: DuckPair, ctx: Ctx): void {
    this.walkClauses(elements(form.cdr).map(clauseList), ctx, scopeId(form), "cond");
  }

  private walkCase(form: DuckPair, ctx: Ctx): void {
    const [key, ...clauses] = elements(form.cdr);
    const span = scopeId(form);
    this.walk(key, nonTail(ctx));
    const arms: Arm[] = clauses.map(clauseList).map((clause, k) => {
      const [datums, ...body] = elements(clause);
      const rest = isPair(clause) ? clause.cdr : undefined;
      return {
        label: nameIs(datums, "else") ? "else" : print(datums),
        roots: body,
        walk: (c: Ctx) => this.walkClauseBody(body, rest, c, `${span}#clause${k}`),
      };
    });
    if (!arms.some((a) => a.label === "else")) arms.push({ label: "else", roots: [], walk: () => {} });
    this.branch(ctx, span, "case", arms);
  }

  /** `(and …)` / `(or …)`: a `seq` frame of every operand's steps, in order — each operand runs
   *  only while no earlier one short-circuited. The frame exists only when an operand after the
   *  first reaches a step; otherwise the first operand's steps stay in the enclosing frame. */
  private walkAndOr(form: DuckPair, ctx: Ctx, op: "and" | "or"): void {
    const ops = elements(form.cdr);
    const span = scopeId(form);
    const seq = newFrame("seq", ctx.path, span, op, { bodyRoots: rootsOf(ops) });
    const inner: Ctx = { ...ctx, out: seq };
    let firstCount = 0;
    for (const [i, operand] of ops.entries()) {
      this.walk(operand, i === ops.length - 1 ? inner : nonTail(inner));
      if (i === 0) firstCount = seq.children.length;
    }
    if (seq.children.slice(firstCount).some(hasSteps)) ctx.out.children.push(seq);
    else ctx.out.children.push(...seq.children);
  }

  /** `guard`/`try`: a `seq` — the body always runs, possibly partially — ending in an
   *  "on raise" branch whose one arm is the handler: on a raise the handler always runs (a
   *  guard whose clauses all fail re-raises from inside it, its clause chain's own else). */
  private walkProtected(
    form: DuckPair,
    ctx: Ctx,
    label: "guard" | "try",
    body: readonly unknown[],
    handlerRoots: readonly unknown[],
    handler: (c: Ctx) => void,
    after: readonly unknown[] = [],
  ): void {
    const span = scopeId(form);
    const seq = newFrame("seq", ctx.path, span, label, { bodyRoots: rootsOf([...body, ...handlerRoots, ...after]) });
    const inner: Ctx = { ...ctx, out: seq, env: new Env(ctx.env), tail: false };
    this.walkBody(body, inner);
    this.branch(inner, `${span}/raise`, "on raise", [{ label: "handler", roots: handlerRoots, walk: handler }], {
      onRaise: true,
    });
    this.walkSeq(after, inner);
    if (hasSteps(seq)) ctx.out.children.push(seq);
  }

  /** `(guard (e clause…) body…)`; the clauses are cond-shaped, a leading `else`/`#t` clause is
   *  the handler itself. */
  private walkGuard(form: DuckPair, ctx: Ctx): void {
    const [spec, ...body] = elements(form.cdr);
    const [variable, ...clauses] = elements(spec).map(clauseList);
    const span = scopeId(form);
    const handlerRoots = clauses.flatMap((c) => {
      const [t, ...b] = elements(c);
      return nameIs(t, "else") ? b : [t, ...b];
    });
    this.walkProtected(form, ctx, "guard", body, handlerRoots, (c) => {
      const env = new Env(c.env);
      if (isSymbol(variable)) env.vars.set(symName(variable), VALUE);
      const hc = { ...c, env };
      const [first] = clauses;
      const [t, ...b] = elements(first);
      if (first !== undefined && isCatchAll(t)) {
        this.walkClauseBody(b, isPair(first) ? first.cdr : undefined, hc, `${span}#clause0`);
      } else this.walkClauses(clauses, hc, `${span}/handler`, "guard clauses", "else · re-raise");
    });
  }

  /** `(try body (catch (e) handler…) (finally expr…))`. */
  private walkTry(form: DuckPair, ctx: Ctx): void {
    const [body, ...clauses] = elements(form.cdr);
    const clause = (name: string): unknown[] => {
      const c = clauses.find((x) => isPair(x) && nameIs(x.car, name));
      return c === undefined ? [] : elements((c as DuckPair).cdr);
    };
    const [variableList, ...handler] = clause("catch");
    const variable = elements(variableList)[0];
    this.walkProtected(
      form,
      ctx,
      "try",
      [body],
      handler,
      (c) => {
        const env = new Env(c.env);
        if (isSymbol(variable)) env.vars.set(symName(variable), VALUE);
        this.walkBody(handler, { ...c, env });
      },
      clause("finally"),
    );
  }

  private walkQuasi(template: unknown, ctx: Ctx, depth: number): void {
    const items =
      bracketItems(template) ??
      (kindOf(template) === "vector" ? (template as { __vector__: unknown[] }).__vector__ : undefined);
    if (items) {
      for (const el of items) this.walkQuasi(el, ctx, depth);
      return;
    }
    if (!isPair(template)) return;
    if (nameIs(template.car, "unquote") || nameIs(template.car, "unquote-splicing")) {
      const inner = isPair(template.cdr) ? template.cdr.car : undefined;
      if (depth === 1) this.walk(inner, nonTail(ctx));
      else this.walkQuasi(inner, ctx, depth - 1);
      return;
    }
    if (nameIs(template.car, "quasiquote")) {
      this.walkQuasi(isPair(template.cdr) ? template.cdr.car : undefined, ctx, depth + 1);
      return;
    }
    let c: unknown = template;
    for (; isPair(c); c = c.cdr) this.walkQuasi(c.car, ctx, depth);
    this.walkQuasi(c, ctx, depth);
  }
}

interface Callback {
  readonly op: Operand;
  readonly index: number;
  readonly roleIndex: number;
  readonly ref: Ref;
  readonly reaches: boolean;
}

interface Arm {
  readonly label: string;
  readonly roots: readonly unknown[];
  /** Forms walked inside the arm before its roots (a cond clause test); interior of the
   *  branch, but their presence does not mean the arm ran. */
  readonly inner?: readonly unknown[];
  readonly test?: string;
  readonly walk: (ctx: Ctx) => void;
}

/** The frame of one callback of a host call. A declared `accumulator` chains (`loop`); a `fan`
 *  host with a declared role runs it per element (`par`); anything undeclared is a `callback`. */
function hostFrame(
  host: string,
  site: string,
  span: string,
  path: string,
  hostRole: string | undefined,
  role: string | undefined,
): Frame {
  let kind: FrameKind = "callback";
  if (role === "accumulator") kind = "loop";
  else if (hostRole === "fan" && role !== undefined) kind = "par";
  return newFrame(kind, path, span, host, {
    host,
    hostSite: site,
    ...(kind !== "callback" && role !== undefined ? { role: role as CallbackRole } : {}),
  });
}

/** All recursive sites in tail position → the frame is a `loop` over them; any non-tail site
 *  → the frame stays a `call` (nested instances), with a collapsed stub at every site. */
function settleRecursion(entry: Entry): void {
  const { frame, sites } = entry;
  if (sites.length === 0) return;
  if (sites.every((s) => s.tail)) {
    frame.frame = "loop";
    frame.recurSpans = sites.map((s) => s.stub.span);
    frame.tail = true;
    for (const s of sites) s.stub.dropped = true;
  } else {
    frame.frame = "call";
    delete frame.recurSpans;
    delete frame.tail;
  }
}

/** Which operand positions the host's contract declares as `z.lambda`: position → index in
 *  lambda order (the `callbackRoles` index), or `undefined` for a non-lambda position. The
 *  whole result is `undefined` when the contract does not say — no contract, or a tagless
 *  shape that carries declared `callbackRoles` but no lambda arm. */
function lambdaPositions(entry: unknown): ((k: number) => number | undefined) | undefined {
  const callable = entry as { contract?: { in?: unknown }; callbackRoles?: unknown } | undefined;
  const shape = callable?.contract?.in;
  if (shape === undefined) return undefined;
  let def: Record<string, unknown> | undefined;
  try {
    def = z.defOf(shape);
  } catch {
    return undefined;
  }
  let items: unknown[];
  if (def?.type === "tuple" && Array.isArray(def.items)) items = def.items as unknown[];
  else if (def?.type === "array") items = [];
  else return undefined;
  const tail = def.type === "tuple" ? def.rest : def.element;
  const isLambda = (schema: unknown): boolean =>
    schema !== undefined && schema !== null && z.lookupName(schema) === "lambda";
  const fixed = items.map(isLambda);
  const restLambda = isLambda(tail);
  if (!fixed.includes(true) && !restLambda && callable?.callbackRoles !== undefined) return undefined;
  return (k) => {
    if (k < fixed.length) return fixed[k] ? fixed.slice(0, k).filter(Boolean).length : undefined;
    return restLambda ? fixed.filter(Boolean).length + (k - fixed.length) : undefined;
  };
}

/** Macros whose expansion splices the user's located Pairs, so the trace taps them (F11). */
const SPLICING_MACROS: ReadonlySet<string> = new Set(["and-let*"]);

const viaOf = (ctx: Ctx): "callback" | "macro" => (ctx.hosted ? "macro" : "callback");

const nonTail = (ctx: Ctx): Ctx => (ctx.tail ? { ...ctx, tail: false } : ctx);
const formalNames = (fn: Fn): string[] => [...fn.formals, ...(fn.rest ? [fn.rest] : [])];
const clauseList = (clause: unknown): unknown => {
  const items = bracketItems(clause);
  if (!items) return clause;
  // A bracket clause `[test expr…]`: rebuild the spine so `elements`/`arrowProc` read it alike.
  let list: unknown = { kind: "nil" };
  for (let i = items.length - 1; i >= 0; i--) list = { kind: "pair", car: items[i], cdr: list };
  return list;
};

function findLastIndex<T>(xs: readonly T[], pred: (x: T) => boolean): number {
  for (let i = xs.length - 1; i >= 0; i--) if (pred(xs[i]!)) return i;
  return -1;
}

function nameOfValue(v: unknown): string | undefined {
  if (v === null || typeof v !== "object") return undefined;
  const { __name__, name } = v as { __name__?: unknown; name?: unknown };
  if (typeof __name__ === "string") return __name__;
  return typeof name === "string" ? name : undefined;
}

const isProcedure = (entry: unknown): boolean => {
  const kind = kindOf(entry);
  return kind === "procedure" || kind === "lambda" || typeof entry === "function";
};

/** Does any Pair in `form` call one of `names` in head position? */
function callsAny(form: unknown, names: ReadonlySet<string>): boolean {
  const seen = new Set<unknown>();
  const visit = (n: unknown): boolean => {
    if (!isPair(n) || seen.has(n)) return false;
    seen.add(n);
    if (isSymbol(n.car) && names.has(symName(n.car))) return true;
    for (let c: unknown = n; isPair(c); c = c.cdr) if (visit(c.car)) return true;
    return false;
  };
  return visit(form);
}

/** Operands as step slots ({@link operandSlots}), each with its value operand's source. */
const argsOf = (ops: readonly Operand[]): { slot: string; source: string }[] =>
  operandSlots(ops.map((o) => o.form)).map(({ slot, at }) => ({ slot, source: print(ops[at]!.form) }));

const SPECIAL: Readonly<Partial<Record<string, Special>>> = {
  quote: () => {},
  lambda: () => {},
  "define-macro": () => {},
  quasiquote(this: Walker, form, ctx) {
    callPrivate(this, "walkQuasi", isPair(form.cdr) ? form.cdr.car : undefined, ctx, 1);
  },
  define(this: Walker, form, ctx) {
    if (!isPair(form.cdr) || !isSymbol(form.cdr.car)) return;
    const init = isPair(form.cdr.cdr) ? form.cdr.cdr.car : undefined;
    this.walk(init, nonTail(ctx));
  },
  "set!"(this: Walker, form, ctx) {
    const [, value] = elements(form.cdr);
    this.walk(value, nonTail(ctx));
  },
  "define-syntax"(this: Walker, form) {
    this.diagnostics.add(
      `syntax-rules macro defined at ${scopeId(form)} is not expanded; its uses are walked as plain calls`,
    );
  },
  begin(this: Walker, form, ctx) {
    this.walkSeq(elements(form.cdr), ctx);
  },
  let(this: Walker, form, ctx) {
    callPrivate(this, "walkLet", form, ctx, "let");
  },
  "let*"(this: Walker, form, ctx) {
    callPrivate(this, "walkLet", form, ctx, "let*");
  },
  letrec(this: Walker, form, ctx) {
    callPrivate(this, "walkLet", form, ctx, "letrec");
  },
  "letrec*"(this: Walker, form, ctx) {
    callPrivate(this, "walkLet", form, ctx, "letrec");
  },
  do(this: Walker, form, ctx) {
    callPrivate(this, "walkDo", form, ctx);
  },
  while(this: Walker, form, ctx) {
    callPrivate(this, "walkWhile", form, ctx);
  },
  if(this: Walker, form, ctx) {
    callPrivate(this, "walkIf", form, ctx);
  },
  when(this: Walker, form, ctx) {
    callPrivate(this, "walkWhen", form, ctx, false);
  },
  unless(this: Walker, form, ctx) {
    callPrivate(this, "walkWhen", form, ctx, true);
  },
  cond(this: Walker, form, ctx) {
    callPrivate(this, "walkCond", form, ctx);
  },
  case(this: Walker, form, ctx) {
    callPrivate(this, "walkCase", form, ctx);
  },
  and(this: Walker, form, ctx) {
    callPrivate(this, "walkAndOr", form, ctx, "and");
  },
  or(this: Walker, form, ctx) {
    callPrivate(this, "walkAndOr", form, ctx, "or");
  },
  guard(this: Walker, form, ctx) {
    callPrivate(this, "walkGuard", form, ctx);
  },
  try(this: Walker, form, ctx) {
    callPrivate(this, "walkTry", form, ctx);
  },
};

function callPrivate(w: Walker, method: string, ...args: unknown[]): void {
  (w as unknown as Record<string, (...a: unknown[]) => void>)[method]!.apply(w, args);
}

// ── assembly ─────────────────────────────────────────────────────────────────────────────

function freeze(frame: Frame): PlanFrame {
  const children = frame.children
    .filter((c) => c.kind === "step" || (c.dropped !== true && (frame.frame === "branch" || hasSteps(c))))
    .map((c): PlanItem => (c.kind === "step" ? c : freeze(c)));
  return {
    kind: "frame",
    key: frame.key,
    span: frame.span,
    path: frame.path,
    frame: frame.frame,
    label: frame.label,
    ...(frame.symbol === undefined ? {} : { symbol: frame.symbol }),
    children,
    params: frame.params,
    bodyRoots: frame.bodyRoots,
    ...(frame.armTests ? { armTests: frame.armTests } : {}),
    ...(frame.recurSpans && frame.frame === "loop" ? { recurSpans: frame.recurSpans } : {}),
    ...(frame.iterationMarker === undefined ? {} : { iterationMarker: frame.iterationMarker }),
    ...(frame.tail !== undefined && frame.frame === "loop" ? { tail: frame.tail } : {}),
    ...(frame.host === undefined ? {} : { host: frame.host }),
    ...(frame.hostSite === undefined ? {} : { hostSite: frame.hostSite }),
    ...(frame.role === undefined ? {} : { role: frame.role }),
    ...(frame.onRaise ? { onRaise: true } : {}),
    ...(frame.recursive ? { recursive: true } : {}),
  };
}

/** The control skeleton of `forms` over `symbols`. Pure; `edges` is always empty. */
export function buildPlan(input: BuildPlanInput): Plan {
  const { forms, symbols, vocabulary, scope } = input;
  const w = new Walker(symbols, vocabulary, scope);
  w.collectGlobals(forms);
  const root = newFrame("seq", "", PROGRAM_KEY, "program", { bodyRoots: rootsOf(forms) });
  for (const [top, form] of forms.entries())
    w.walk(form, { out: root, env: w.root, stack: [], path: "", tail: false, tailBase: 0, top });

  const frozen = freeze(root);
  const byKey = new Map<PlanKey, PlanItem>();
  const bySpan = new Map<string, PlanKey[]>();
  const parentOf = new Map<PlanKey, PlanKey>();
  const index = (item: PlanItem): void => {
    if (byKey.has(item.key)) w.diagnostics.add(`duplicate plan key ${item.key}; the later item shadows the earlier`);
    byKey.set(item.key, item);
    const keys = bySpan.get(item.span) ?? [];
    keys.push(item.key);
    bySpan.set(item.span, keys);
    if (item.kind === "frame") {
      for (const c of item.children) parentOf.set(c.key, item.key);
      for (const c of item.children) index(c);
    }
  };
  index(frozen);
  return { root: frozen, byKey, bySpan, parentOf, edges: [], diagnostics: [...w.diagnostics] };
}
