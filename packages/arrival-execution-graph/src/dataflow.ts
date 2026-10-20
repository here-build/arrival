/**
 * The dataflow join: arrival's prospective wireframe (`buildWireframe`) laid onto the control
 * skeleton as `PlanEdge`s, matched by span. Pure; the skeleton tree is returned unchanged.
 *
 * Each wireframe graph is instantiated at a place in the plan: a context is a graph, the call
 * path its spans are keyed under, and the plan frame that owns its ingress and egress (`main` →
 * the program root; a fan template → the `par`; a binder interior → the `loop`; a define
 * template → the `call` frame of that call site; a lambda's `closure` template → the frame the
 * skeleton drew for its body). A wire becomes edges from each producer it references (a node's
 * egress, or the owner's param port for a formal) to the port its consumer node maps to. A
 * region's free variable reads what its `capture:<name>` wire supplies in the enclosing graph.
 *
 * A wire's params are read precisely: the emitter re-wraps the original `let`-family binding
 * structure around each wire body (sound verbatim, not minimal), so a param bound by a binding
 * the body never uses is dead and contributes no edge (`liveParams`).
 *
 * The join degrades honestly: a wireframe throw yields no edges and a diagnostic naming the
 * error; a wire end with no plan item, or a free variable neither a plan frame nor a capture
 * binds, is dropped, counted and noted. Arrival's bugs are fixed upstream, not worked around
 * here.
 */

import { parse, type SchemeValue } from "@here.build/arrival";
import {
  buildWireframe,
  type Classifier,
  type Wire,
  type WireframeBuildOptions,
  type WireframeGraph,
  type WireframeNode,
  type WireframeProgram,
  type WireParam,
  scopeId,
  writeForm,
} from "@here.build/arrival/provenance";

import {
  type Binding,
  bindingsOf,
  bracketItems,
  isKeyword,
  isPair,
  isSymbol,
  kindOf,
  listItems,
  nameIs,
  symbolName,
  symbolsIn,
} from "./datum.js";
import {
  parentFrame,
  type PathStep,
  type Plan,
  type PlanEdge,
  type PlanFrame,
  type PlanItem,
  type PlanKey,
  type PlanPort,
  type PlanStep,
  type Vocabulary,
  type WireShape,
} from "./plan.js";

export interface DataflowInput {
  /** The forms `buildPlan` walked — spans must agree. */
  readonly forms: readonly SchemeValue[];
  readonly symbols: ReadonlySet<string>;
  readonly vocabulary: Vocabulary;
}

interface VocabularyEntry {
  readonly provenanceRole?: string;
  readonly callbackRoles?: ReturnType<NonNullable<WireframeBuildOptions["callbackRolesOf"]>>;
}

/** The view is relative to the user's designation: declared `fan`/`loop` structure is kept for
 *  every op, a designated op is a `source` (or its declared `sink`), every other declared
 *  membrane role is demoted to a pipe. */
function wireframeOptions({ symbols, vocabulary }: DataflowInput): WireframeBuildOptions {
  const entry = (op: string) => vocabulary.get(op) as VocabularyEntry | undefined;
  const classifier: Classifier = {
    roleOf(op) {
      const role = entry(op)?.provenanceRole;
      if (role === "fan" || role === "loop") return role;
      if (symbols.has(op)) return role === "sink" ? "sink" : "source";
      return undefined;
    },
  };
  return {
    classifier,
    isBaseName: (name) => vocabulary.has(name) || /^c[ad]+r$/.test(name),
    callbackRolesOf: (op) => entry(op)?.callbackRoles,
  };
}

// ── plan geometry ────────────────────────────────────────────────────────────────────────

interface End {
  readonly key: PlanKey;
  readonly port: PlanPort;
}

/** A producer port; `control` when its value reaches the consumer only as a pruned branch's
 *  decision. */
interface Producer extends End {
  readonly control?: boolean;
}

interface Context {
  readonly graph: WireframeGraph;
  readonly path: string;
  readonly owner: PlanFrame;
  /** Fan template: the callback role deciding where the egress goes. */
  readonly role?: string;
  /** Binder interior: the binder op (`named-let`, `do`). */
  readonly binder?: string;
}

const isFrame = (item: PlanItem | undefined): item is PlanFrame => item?.kind === "frame";
const IDENTITY = /^\(lambda \(([^\s()]+)\) \1\)$/;

/** Wireframe operand index → the plan step's slot (`(f :k v)` is two operands, one slot). */
function stepSlot(step: PlanStep, operand: number): string {
  let raw = 0;
  for (const arg of step.args) {
    const width = arg.slot.startsWith(":") ? 2 : 1;
    if (operand < raw + width) return arg.slot;
    raw += width;
  }
  return `arg${operand}`;
}

/** `arg2` → 2, `arg` → 0 (prefix `arg`); `undefined` for another slot. */
const operandIndex = (slot: string, prefix: string): number | undefined => {
  const digits = slot.slice(prefix.length);
  if (!slot.startsWith(prefix) || !/^\d*$/.test(digits)) return undefined;
  return digits === "" ? 0 : Number(digits);
};

// ── wire liveness ────────────────────────────────────────────────────────────────────────

const LET_FAMILY = new Set(["let", "let*", "letrec", "letrec*"]);

/** The params of a wire `(lambda (p…) body)` its value depends on: peel the re-wrapped
 *  `let`-family frames, take the inner expression's symbols, then walk the bindings outward
 *  (reverse order within a frame), keeping a binding only when its name is live. `undefined`
 *  when the wire is not that shape — every param then counts. `symbolsIn` over-approximates
 *  the free variables, which only ever keeps a binding live. */
export function liveParams(wire: unknown): Set<string> | undefined {
  const body = readWireBody(wire);
  return body && liveIn(body, body.exprs, NO_CUTS);
}

const NO_CUTS: ReadonlySet<unknown> = new Set();

/** A wire read once: its params, the re-wrapped `let` frames (outermost first), the inner
 *  expressions, and which names stand for a param through those frames. */
interface WireBody {
  readonly params: readonly string[];
  readonly frames: readonly LetFrame[];
  readonly exprs: readonly unknown[];
  /** name → the param it stands for (`undefined`: bound to something else). */
  readonly alias: ReadonlyMap<string, string | undefined>;
  /** name → the form it is bound to, when that is not a bare name (`inbox` → `(:threads in0)`). */
  readonly inits: ReadonlyMap<string, unknown>;
}

function readWireBody(wire: unknown): WireBody | undefined {
  if (!isPair(wire) || !nameIs(wire.car, "lambda")) return undefined;
  const [list, ...rest] = listItems(wire.cdr);
  if (!isPair(list) && kindOf(list) !== "nil") return undefined;
  const params = listItems(list).flatMap((p) => symbolName(p) ?? []);
  const { frames, exprs } = peelLets(rest);
  const alias = new Map<string, string | undefined>();
  const inits = new Map<string, unknown>();
  for (const { kind, bindings } of frames) {
    // `let` inits see the scope outside the frame; `let*` / `letrec` see earlier bindings.
    const seen = kind === "let" ? new Map(alias) : alias;
    const next = bindings.map((b) => {
      const init = symbolName(b.init);
      return [b.name, init === undefined ? undefined : resolve(seen, init)] as const;
    });
    for (const [name, to] of next) alias.set(name, to);
    for (const b of bindings) {
      if (symbolName(b.init) === undefined) inits.set(b.name, b.init);
      else inits.delete(b.name);
    }
  }
  return { params, frames, exprs, alias, inits };
}

/** The params `exprs` (inner expressions of `body`) depend on, `cuts` (by identity) not entered. */
function liveIn(body: WireBody, exprs: readonly unknown[], cuts: ReadonlySet<unknown>): Set<string> {
  let live = new Set<string>();
  for (const e of exprs) symbolsIn(e, live, cuts);
  for (const frame of body.frames.toReversed()) live = liveOutside(frame, live);
  return new Set(body.params.filter((p) => live.has(p)));
}

interface LetFrame {
  readonly kind: string;
  readonly bindings: readonly Binding[];
}

/** The re-wrapped `let`-family frames around a wire body, outermost first, and the body inside. */
function peelLets(body: unknown[]): { frames: LetFrame[]; exprs: unknown[] } {
  const frames: LetFrame[] = [];
  let exprs = body;
  for (;;) {
    const [only] = exprs;
    if (exprs.length !== 1 || !isPair(only)) break;
    const [head, bindingList, ...inner] = listItems(only);
    const kind = symbolName(head);
    // A named let (a symbol where the bindings go) is a loop, not a re-wrap.
    if (kind === undefined || !LET_FAMILY.has(kind) || isSymbol(bindingList)) break;
    frames.push({ kind, bindings: bindingsOf(bindingList) });
    exprs = inner;
  }
  return { frames, exprs };
}

const symbolsOf = (forms: readonly unknown[], out: Set<string>): Set<string> => {
  for (const f of forms) symbolsIn(f, out);
  return out;
};

/** The names live outside `frame`, given those live inside it. */
function liveOutside({ kind, bindings }: LetFrame, live: Set<string>): Set<string> {
  if (kind === "let*") {
    for (const b of bindings.toReversed()) {
      if (!live.has(b.name)) continue;
      live.delete(b.name);
      symbolsOf([b.init], live);
    }
    return live;
  }
  const kept = bindings.filter((b) => live.has(b.name));
  if (kind !== "let") {
    // letrec: a binding is live when the body or another live binding's rhs uses it.
    for (let grew = true; grew; ) {
      const used = symbolsOf(
        kept.map((b) => b.init),
        new Set(),
      );
      const more = bindings.filter((b) => !kept.includes(b) && used.has(b.name));
      kept.push(...more);
      grew = more.length > 0;
    }
  }
  const names = new Set(bindings.map((b) => b.name));
  const next = new Set([...live].filter((n) => !names.has(n)));
  // `let` rhs see the outer scope; `letrec` rhs see the frame's own names.
  const rhs = symbolsOf(
    kept.map((b) => b.init),
    new Set(),
  );
  for (const n of rhs) if (kind === "let" || !names.has(n)) next.add(n);
  return next;
}

// ── wire shape ───────────────────────────────────────────────────────────────────────────

/** A wire's shape without its id and text: what the value goes through between producer and
 *  consumer, read on the liveness-peeled inner expression. */
export type WireForm = Omit<WireShape, "id" | "text">;

const integerOf = (form: unknown): number | undefined => {
  if (typeof form === "number") return Number.isInteger(form) ? form : undefined;
  const n = form as { kind?: string; num?: unknown; denom?: unknown } | null;
  return n?.kind === "number" && n.denom === 1 && typeof n.num === "number" && Number.isInteger(n.num)
    ? n.num
    : undefined;
};

/** One projection step `(op x …)` → the step and `x`; `undefined` for anything else. */
function projectionStep(form: unknown): { step: PathStep; of: unknown } | undefined {
  if (!isPair(form)) return undefined;
  const head = symbolName(form.car);
  const [of, key, ...rest] = listItems(form.cdr);
  if (head === undefined || of === undefined || rest.length > 0) return undefined;
  if (key === undefined) {
    if (head === "car") return { step: { car: true }, of };
    return isKeyword(form.car) ? { step: { field: head.slice(1) }, of } : undefined;
  }
  if (head === "list-ref" || head === "vector-ref") {
    const index = integerOf(key);
    return index === undefined ? undefined : { step: { index }, of };
  }
  return head === "@" && isKeyword(key) ? { step: { field: symbolName(key)!.slice(1) }, of } : undefined;
}

/** A name through the `let` aliases in scope: the param it stands for, itself when unbound. */
const resolve = (scope: ReadonlyMap<string, string | undefined>, name: string): string | undefined =>
  scope.has(name) ? scope.get(name) : name;

/** `expr` (an inner expression of `body`): identity when it is a bare param, a projection when
 *  it is a chain of field / `car` / literal-index reads over one param (path in application
 *  order), compute otherwise. A `let`-family name bound to a bare param (or to another such
 *  name) reads as that param — the emitter re-wraps the program's own bindings — and a name
 *  bound to a projection chain composes into the path (`(let* ((a (:x in0)) (b (car a))) b)` →
 *  `.x[0]`). A `cuts` form (a conditional drawn as its own area) counts as a param: the area's
 *  result. */
function classify(body: WireBody, expr: unknown, cuts: ReadonlySet<unknown>): WireForm {
  let base = expr;
  const path: PathStep[] = [];
  // Each hop enters one binding; a binding's init never names itself, the bound only guards.
  for (let hops = 0; hops <= body.inits.size; hops++) {
    for (let p = projectionStep(base); p && !cuts.has(base); p = projectionStep(base)) {
      path.unshift(p.step);
      base = p.of;
    }
    const bound = symbolName(base);
    if (bound === undefined || resolve(body.alias, bound) !== undefined || !body.inits.has(bound)) break;
    base = body.inits.get(bound);
  }
  const name = symbolName(base);
  const param = name === undefined ? undefined : resolve(body.alias, name);
  if (cuts.has(base) || (param !== undefined && body.params.includes(param))) {
    return path.length === 0 ? { kind: "identity" } : { kind: "projection", path };
  }
  const head = isPair(expr) ? expr.car : expr;
  const op = symbolName(head) ?? (isPair(head) ? print(head) : undefined);
  return { kind: "compute", ...(op === undefined ? {} : { op }) };
}

/** `wire` = `(lambda (p…) body)` classified on its (last) inner expression — see `classify`. */
export function wireForm(wire: unknown): WireForm {
  const body = readWireBody(wire);
  return body ? classify(body, body.exprs.at(-1), NO_CUTS) : { kind: "compute" };
}

const print = (form: unknown): string => {
  try {
    return writeForm(form);
  } catch {
    return "?";
  }
};

/** `exprs` printed, each cut conditional shown as `(if …)` and each cut param (`node` ref) as
 *  its producer: `(ask …)`. */
function exprText(exprs: readonly unknown[], cuts: ReadonlySet<unknown>, cut: ReadonlyMap<string, string>): string {
  let text = exprs.map(print).join(" ");
  for (const c of cuts) {
    if (isPair(c)) text = text.replace(print(c), `(${symbolName(c.car) ?? "?"} …)`);
  }
  for (const [param, producer] of cut) {
    const name = param.replaceAll(/[$()*+.?[\\\]^{|}]/g, String.raw`\$&`);

    text = text.replaceAll(new RegExp(String.raw`(?<=^|[\s()[\]{}])${name}(?=$|[\s()[\]{}])`, "g"), producer);
  }
  return text;
}

// ── conditionals drawn as areas ──────────────────────────────────────────────────────────

const CONDITIONALS = new Set(["if", "when", "unless", "cond", "case"]);
/** and/or: the value of the operand that short-circuits is the form's value. */
const SHORT_CIRCUIT: ReadonlySet<string> = new Set(["and", "or"]);

/** The sub-forms of a form, positionally: a list's items, a `[…]` literal's elements. */
const partsOf = (form: unknown): unknown[] => (isPair(form) ? listItems(form) : (bracketItems(form) ?? []));

/** Where a (piece of a) wire sits: the program form it is (`span`; an arm's own span when the
 *  value is an atom with no form — `unlocated`), and the frame holding it when not the
 *  consumer's. */
interface Placement {
  readonly span: string;
  readonly container?: PlanKey;
  readonly unlocated?: boolean;
}

/** A control form inside a wire body that the plan draws as an area (a frame at its span). */
interface Cut {
  readonly frame: PlanFrame;
  readonly head: string;
  /** The control form in the wire body, and the program's own form it re-prints. */
  readonly form: unknown;
  readonly surface: unknown;
}

/** An area whose values `valuesOf` does not read: a loop, fan or call (their own wireframe
 *  context carries the interior), or a `seq` other than and/or/guard/try. */
const opaque = (c: Cut): boolean =>
  c.frame.frame !== "branch" && !(c.frame.frame === "seq" && ["and", "or", "guard", "try"].includes(c.head));

/** A value expression an area's `out` reads: `form` (wire) / `surface` (program), into `into`'s
 *  `out`, inside `scope` (an arm, or the area itself). */
interface AreaValue {
  readonly form: unknown;
  readonly surface: unknown;
  readonly into: PlanFrame;
  readonly scope: PlanFrame;
}

const pick = (w: readonly unknown[], s: readonly unknown[], i: number): [unknown, unknown] | undefined =>
  i >= 0 && i < w.length && i < s.length ? [w[i], s[i]] : undefined;

/** A cond-shaped clause's value: its last body form (none for a test-only or `=>` clause). */
function clauseValue(w: unknown, s: unknown): [unknown, unknown] | undefined {
  const [wc, sc] = [partsOf(w), partsOf(s)];
  if (wc.length < 2 || wc.length !== sc.length || wc.some((x) => nameIs(x, "=>"))) return undefined;
  return [wc.at(-1), sc.at(-1)];
}

/** `(try body (catch (e) handler…) …)`: the catch clause's items after `catch`. */
const catchOf = (items: readonly unknown[]): unknown[] => {
  const c = items.find((x) => isPair(x) && nameIs(x.car, "catch"));
  return c === undefined ? [] : listItems((c as { cdr: unknown }).cdr);
};

/** Conditional `head`'s value expression for arm `k` (wire form, program form), when it has one:
 *  `if` then/else; `when`/`unless` the body's last form; a `cond`/`case` clause's last body
 *  form (a test-only or `=>` clause has none, nor has an implicit arm). */
function armValue(head: string, form: unknown, surface: unknown, k: number): [unknown, unknown] | undefined {
  const [w, s] = [listItems(form), listItems(surface)];
  if (head === "if") return pick(w, s, 2 + k);
  if (head === "when" || head === "unless")
    return k === (head === "when" ? 0 : 1) && w.length > 2 ? pick(w, s, w.length - 1) : undefined;
  const first = head === "case" ? 2 : 1;
  return clauseValue(w[first + k], s[first + k]);
}

/** Every wire source of the program, read with arrival's own reader in one batch (one form per
 *  source); a source the batch cannot read is read alone, `undefined` when that fails too. */
async function readWires(program: WireframeProgram): Promise<Map<string, unknown>> {
  const sources = new Set<string>();
  const visit = (graph: WireframeGraph): void => {
    for (const w of graph.wires) sources.add(w.source);
    for (const n of graph.nodes) {
      if (n.kind === "binder") visit(n.interior);
      else if ((n.kind === "fan" || n.kind === "closure") && n.template) visit(n.template);
    }
  };
  visit(program.main);
  for (const t of program.templates.values()) visit(t.graph);
  const list = [...sources];
  const read = async (src: string): Promise<unknown[] | undefined> => {
    try {
      return await parse(src);
    } catch {
      return undefined;
    }
  };
  const batch = await read(list.map((s) => `${s}\n`).join(""));
  if (batch?.length === list.length) return new Map(list.map((s, i) => [s, batch[i]]));
  const forms = await Promise.all(
    list.map(async (s) => {
      const one = await read(s);
      return one?.length === 1 ? one[0] : undefined;
    }),
  );
  return new Map(list.map((s, i) => [s, forms[i]]));
}

/** `(begin e… en)` → `en`; any other form as is. */
const lastOfBegin = (form: unknown): unknown =>
  isPair(form) && nameIs(form.car, "begin") ? (listItems(form.cdr).at(-1) ?? form) : form;

// ── the join ─────────────────────────────────────────────────────────────────────────────

class Join {
  readonly edges: PlanEdge[] = [];
  readonly notes = new Set<string>();
  readonly dropped = new Map<string, number>();
  wires = 0;
  /** Live params per wire source (`undefined`: unreadable, every param counts). */
  private readonly liveness = new Map<string, ReadonlySet<string> | undefined>();
  private readonly parent = (key: PlanKey) => parentFrame(this.plan, key);
  /** Param refs filtered out as bound by a binding the wire body never uses. */
  deadBindings = 0;
  /** Steps no wireframe node maps to. */
  unreachedSteps = 0;
  /** Frames a wireframe context or region node landed on. */
  private readonly claimed = new Set<PlanKey>();
  /** Plan items some wireframe node resolved to. */
  private readonly joined = new Set<PlanKey>();
  /** A region's free variables: interior graph → name → what its `capture:<name>` wire reads. */
  private readonly captured = new Map<WireframeGraph, Map<string, Producer[]>>();

  constructor(
    private readonly plan: Plan,
    private readonly program: WireframeProgram,
    private readonly symbols: ReadonlySet<string>,
    private readonly wireForms: ReadonlyMap<string, unknown>,
    private readonly forms: readonly unknown[],
  ) {}

  run(): void {
    const queue: Context[] = [{ graph: this.program.main, path: "", owner: this.plan.root }];
    for (let ctx = queue.shift(); ctx; ctx = queue.shift()) {
      this.claimed.add(ctx.owner.key);
      for (const [i, n] of ctx.graph.nodes.entries()) queue.push(...this.open(ctx, n, i));
      for (const wire of ctx.graph.wires) this.wire(ctx, wire);
    }
  }

  private drop(reason: string, note: string): void {
    this.dropped.set(reason, (this.dropped.get(reason) ?? 0) + 1);
    this.notes.add(note);
  }

  private isAncestor(frame: PlanFrame, key: PlanKey): boolean {
    for (let p = this.parent(key); p; p = this.parent(p.key)) if (p === frame) return true;
    return false;
  }

  /** The plan item a node's span denotes in `ctx`: `path + span`, else the one item with that
   *  span inside the context owner (a callback the skeleton keyed under a host prefix that the
   *  wireframe did not lift into a template). */
  private item(ctx: Context, node: WireframeNode): PlanItem | undefined {
    // A closure is a value: its span is the lambda (or, for a named callback, its host's).
    if (node.kind === "port" || node.kind === "recur" || node.kind === "closure" || node.span === "?") return undefined;
    const inside = (this.plan.bySpan.get(node.span) ?? []).filter((k) => this.isAncestor(ctx.owner, k));
    const found =
      this.plan.byKey.get(ctx.path + node.span) ?? (inside.length === 1 ? this.plan.byKey.get(inside[0]!) : undefined);
    if (found) this.joined.add(found.key);
    return found;
  }

  /** The loop frame whose recursion re-enters at `span`, searching outward from the owner. */
  private recurLoop(ctx: Context, span: string): PlanFrame | undefined {
    for (let f: PlanFrame | undefined = ctx.owner; f; f = this.parent(f.key)) {
      if (f.frame === "loop" && f.recurSpans?.includes(span)) return f;
    }
    return undefined;
  }

  /** How a template-ref lands in the plan: an inlined call (or tail-recursion loop) that opens
   *  the template, a collapsed recursive stub, or a recursion site of an enclosing loop. */
  private templateRef(ctx: Context, node: Extract<WireframeNode, { kind: "template-ref" }>) {
    const item = this.item(ctx, node);
    if (isFrame(item)) return item.recursive ? { stub: item } : { call: item };
    const loop = this.recurLoop(ctx, node.span);
    return loop ? { recur: loop } : {};
  }

  /** Sub-contexts a node opens. */
  private open(ctx: Context, node: WireframeNode, index: number): Context[] {
    if (node.kind === "closure") return this.openClosure(ctx, node);
    const item = this.item(ctx, node);
    if (node.kind === "binder") {
      if (!isFrame(item)) return this.unopened(node.interior, `${node.op} ${node.span}`);
      this.claimed.add(item.key);
      return [{ graph: node.interior, path: ctx.path, owner: item, binder: node.op }];
    }
    if (node.kind === "template-ref") return this.openTemplate(ctx, node);
    if (node.kind === "guard" && isFrame(item)) this.guardHops(item);
    if (node.kind !== "fan") return [];
    if (!isFrame(item)) {
      return node.template ? this.unopened(node.template, `${node.op} ${node.span}`) : [];
    }
    return this.openFan(ctx, node, index, item);
  }

  /** The frame the skeleton drew for a lambda's body (an IIFE's `call`, a host's `par` / `loop`
   *  / `callback`): the outermost frame under the context owner whose body roots are the
   *  lambda's body forms. */
  private closureOwner(ctx: Context, node: Extract<WireframeNode, { kind: "closure" }>): PlanFrame | undefined {
    const lambda = this.surfaceOf(node.span);
    if (!isPair(lambda) || !nameIs(lambda.car, "lambda")) return undefined;
    const body = new Set(
      listItems(lambda.cdr)
        .slice(1)
        .filter((f) => isPair(f))
        .map((f) => scopeId(f)),
    );
    let best: PlanFrame | undefined;
    for (const f of this.plan.byKey.values()) {
      if (!isFrame(f) || f.path !== ctx.path || !f.bodyRoots.some((r) => body.has(r))) continue;
      if (f !== ctx.owner && !this.isAncestor(ctx.owner, f.key)) continue;
      if (!best || this.isAncestor(f, best.key)) best = f;
    }
    return best;
  }

  /** A lambda literal's private interior, at the frame drawn for its body. Its result goes where
   *  the frame's declared callback role sends it. A ref closure (a define or port used as a
   *  value) opens nothing here: a fan reads it off its `fn` wire. */
  private openClosure(ctx: Context, node: Extract<WireframeNode, { kind: "closure" }>): Context[] {
    if (!node.template) return [];
    const owner = this.closureOwner(ctx, node);
    if (!owner) return this.unopened(node.template, `closure ${node.span}`);
    this.claimed.add(owner.key);
    const path = owner.frame === "call" ? `${owner.key}▸` : ctx.path;
    return [{ graph: node.template, path, owner, ...(owner.role ? { role: owner.role } : {}) }];
  }

  /** A guard's clauses branch flows into its on-raise branch, and that into the guard. */
  private guardHops(guard: PlanFrame): void {
    const { raise, clauses } = this.guardParts(guard);
    if (clauses) this.hop(clauses, raise);
    this.hop(raise, guard);
  }

  /** A guard/try `seq`'s on-raise branch, and the clause branch inside its handler arm when the
   *  first clause is not a catch-all. */
  private guardParts(guard: PlanFrame): { raise?: PlanFrame; clauses?: PlanFrame } {
    const raise = guard.children.find((x): x is PlanFrame => x.kind === "frame" && x.onRaise === true);
    const clauses = this.plan.byKey.get(`${guard.key}/handler`);
    return { ...(raise ? { raise } : {}), ...(isFrame(clauses) && clauses.frame === "branch" ? { clauses } : {}) };
  }

  /** An inlined call's template, keyed under the call's prefix. */
  private openTemplate(ctx: Context, node: Extract<WireframeNode, { kind: "template-ref" }>): Context[] {
    const at = this.templateRef(ctx, node);
    if (!at.call) return [];
    this.claimed.add(at.call.key);
    const template = this.program.templates.get(node.name);
    if (!template) {
      this.drop("unmappable", `template "${node.name}" referenced at ${node.span} is missing from the wireframe`);
      return [];
    }
    return [{ graph: template.graph, path: `${at.call.key}▸`, owner: at.call }];
  }

  /** A fan's callback: its lifted template, a named procedure's template, or a bare step. A
   *  callback that is not a lambda literal or a prelude name arrives on the fan's `fn` wire as a
   *  closure: a define's or a port's name, or a lambda (which opens its own interior). */
  private openFan(
    ctx: Context,
    node: Extract<WireframeNode, { kind: "fan" }>,
    index: number,
    item: PlanFrame,
  ): Context[] {
    this.claimed.add(item.key);
    const role = node.callbackRoles?.[0] ?? undefined;
    if (node.template) return [{ graph: node.template, path: ctx.path, owner: item, ...(role ? { role } : {}) }];
    const fn = node.fnOp ?? this.fnRef(ctx, index);
    if (fn === undefined) return [];
    const template = this.program.templates.get(fn);
    if (template) {
      // The skeleton inlines a named callback under the host's prefix; read it off the plan.
      const paths = [`${item.key}▸`, ctx.path];
      const path =
        paths.find((p) =>
          template.graph.nodes.some((n) => {
            const k = n.kind === "port" || n.kind === "recur" ? undefined : this.plan.byKey.get(p + n.span);
            return k !== undefined && this.isAncestor(item, k.key);
          }),
        ) ?? paths[0]!;
      return [{ graph: template.graph, path, owner: item, ...(role ? { role } : {}) }];
    }
    if (this.symbols.has(fn)) this.bareCallback(item, role);
    return [];
  }

  /** The name a fan's `fn` wire passes: the define or port a ref closure names. */
  private fnRef(ctx: Context, index: number): string | undefined {
    const wire = ctx.graph.wires.find((w) => w.consumer.node === index && w.consumer.slot === "fn");
    const ref = wire?.paramRefs.length === 1 ? wire.paramRefs[0] : undefined;
    const node = ref?.kind === "node" ? ctx.graph.nodes.at(ref.node) : undefined;
    if (node?.kind !== "closure" || !node.ref) return undefined;
    return node.ref.kind === "define" ? node.ref.name : node.ref.op;
  }

  /** `(map ask xs)`: the par's single step reads the element and is the element's result. */
  private bareCallback(par: PlanFrame, role: string | undefined): void {
    const step = par.children.find((c): c is PlanStep => c.kind === "step");
    if (!step) return;
    this.joined.add(step.key);
    this.edges.push({
      from: { key: par.key, port: this.paramPort(par, 0) },
      to: { key: step.key, port: "in:arg0" },
      kind: "data",
    });
    if (role === "effect") return;
    const control = role === "control";
    this.edges.push({
      from: { key: step.key, port: "out" },
      to: { key: par.key, port: control ? "control" : "out" },
      kind: control ? "control" : "data",
    });
  }

  private unopened(graph: WireframeGraph, where: string): Context[] {
    if (graph.nodes.some((n) => n.kind !== "port" && n.kind !== "recur")) {
      this.notes.add(`wireframe region ${where} has no plan frame; its interior is not joined`);
    }
    return [];
  }

  private paramPort(frame: PlanFrame, k: number): PlanPort {
    const param = frame.params.at(k);
    if (param !== undefined) return `in:${param}`;
    this.notes.add(`${frame.key} has no param for operand ${k}; its ingress is named source${k}`);
    return `in:source${k}`;
  }

  // ── wires ──

  /** Where a wire lands, the frame its free variables are looked up from, and its kind. */
  private target(
    ctx: Context,
    wire: Wire,
  ): { to: End; scope: PlanFrame; kind: PlanEdge["kind"] } | "collapsed" | "elided" | undefined {
    const { node: c, slot } = wire.consumer;
    const node = ctx.graph.nodes.at(c);
    if (!node) return undefined;
    const item = this.item(ctx, node);
    switch (node.kind) {
      case "port":
        return this.egress(ctx);
      case "recur": {
        const k = operandIndex(slot, "arg") ?? 0;
        return { to: { key: ctx.owner.key, port: this.paramPort(ctx.owner, k) }, scope: ctx.owner, kind: "recur" };
      }
      case "source":
      case "sink":
      case "transparent":
      case "opaque": {
        if (!item) return undefined;
        const k = operandIndex(slot, "arg") ?? 0;
        if (item.kind === "frame") return this.ingress(item, k);
        return { to: { key: item.key, port: `in:${stepSlot(item, k)}` }, scope: this.outside(item.key), kind: "data" };
      }
      case "fan":
        return isFrame(item) ? this.ingress(item, operandIndex(slot, "source") ?? 0) : "collapsed";
      case "binder":
        return isFrame(item) ? this.ingress(item, operandIndex(slot, "arg") ?? 0) : "collapsed";
      case "mux":
        return isFrame(item) ? this.muxTarget(item, slot, node.op) : "collapsed";
      case "guard":
        return isFrame(item) ? this.guardTarget(item, slot) : "collapsed";
      case "template-ref":
        return this.callTarget(ctx, node, operandIndex(slot, "arg") ?? 0);
      case "closure":
        // A closure consumes only its captures, read before `target`.
        return undefined;
    }
  }

  /** A guard/try: the protected body into its `out`; clause `k`'s test into the clause branch's
   *  `control`, its value into that branch's `out` inside arm `k` (a catch-all handler: the
   *  on-raise branch's). */
  private guardTarget(
    guard: PlanFrame,
    slot: string,
  ): { to: End; scope: PlanFrame; kind: PlanEdge["kind"] } | undefined {
    if (slot === "body") return { to: { key: guard.key, port: "out" }, scope: guard, kind: "data" };
    const { raise, clauses } = this.guardParts(guard);
    const branch = clauses ?? raise;
    if (!branch) return undefined;
    if (operandIndex(slot, "selector") !== undefined) {
      return { to: { key: branch.key, port: "control" }, scope: branch, kind: "control" };
    }
    const k = operandIndex(slot, "arm");
    if (k === undefined) return undefined;
    const arm = branch.children[clauses ? k : 0];
    return { to: { key: branch.key, port: "out" }, scope: isFrame(arm) ? arm : branch, kind: "data" };
  }

  /** Operand `k` of a call to a program procedure: the inlined call (or recursion stub), or —
   *  for a tail recursion site — the next iteration of its loop. */
  private callTarget(
    ctx: Context,
    node: Extract<WireframeNode, { kind: "template-ref" }>,
    k: number,
  ): { to: End; scope: PlanFrame; kind: PlanEdge["kind"] } | undefined {
    const at = this.templateRef(ctx, node);
    const frame = at.call ?? at.stub;
    if (frame) return this.ingress(frame, k);
    if (!at.recur) return undefined;
    return { to: { key: at.recur.key, port: this.paramPort(at.recur, k) }, scope: ctx.owner, kind: "recur" };
  }

  /** The context's result into its owner: `out`, or `control` for a `control` callback; an
   *  `effect` callback's result goes nowhere. */
  private egress(ctx: Context): { to: End; scope: PlanFrame; kind: PlanEdge["kind"] } | "elided" {
    if (ctx.role === "effect") return "elided";
    const control = ctx.role === "control";
    return {
      to: { key: ctx.owner.key, port: control ? "control" : "out" },
      scope: ctx.owner,
      kind: control ? "control" : "data",
    };
  }

  /** The frame enclosing `key` — where free variables of a wire into it are looked up. */
  private outside(key: PlanKey): PlanFrame {
    return this.parent(key) ?? this.plan.root;
  }

  /** Operand `k` into a frame's param port. */
  private ingress(frame: PlanFrame, k: number): { to: End; scope: PlanFrame; kind: "data" } {
    return { to: { key: frame.key, port: this.paramPort(frame, k) }, scope: this.outside(frame.key), kind: "data" };
  }

  /** A branch's selector (`control`), or arm `k`'s value into the branch's `out`. An and/or
   *  selector is its first operand, whose value is the result when it short-circuits: a value. */
  private muxTarget(
    branch: PlanFrame,
    slot: string,
    op: string,
  ): { to: End; scope: PlanFrame; kind: PlanEdge["kind"] } {
    const arm = operandIndex(slot, "arm");
    if (arm === undefined && SHORT_CIRCUIT.has(op))
      return { to: { key: branch.key, port: "out" }, scope: branch, kind: "data" };
    if (arm === undefined)
      return { to: { key: branch.key, port: "control" }, scope: this.outside(branch.key), kind: "control" };
    const armFrame = branch.children[arm];
    return { to: { key: branch.key, port: "out" }, scope: isFrame(armFrame) ? armFrame : branch, kind: "data" };
  }

  private wire(ctx: Context, wire: Wire): void {
    this.wires++;
    if (wire.consumer.slot.startsWith("capture:")) return this.capture(ctx, wire);
    if (wire.consumer.slot === "fn") return this.callbackValue(ctx, wire);
    const target = this.target(ctx, wire);
    if (target === "collapsed" || target === "elided") return;
    if (!target) {
      const node = ctx.graph.nodes.at(wire.consumer.node);
      this.drop(
        "unmappable",
        `wire ${wire.span} → ${describe(node)}.${wire.consumer.slot}: no plan item at ${ctx.path}${node?.span ?? "?"}`,
      );
      return;
    }
    const isOwnerOut = target.to.key === ctx.owner.key && target.to.port === "out";
    let refs = this.liveRefs(wire, true);
    const form = this.wireForms.get(wire.source);
    let body = form === undefined ? undefined : readWireBody(form);
    let surface = this.surfaceOf(wire.span);
    let span = wire.span;
    const node = ctx.graph.nodes.at(wire.consumer.node);
    if (body && node?.kind === "guard" && wire.consumer.slot === "body") {
      // The protected body's value is its last form; the forms before it run for effect.
      surface = this.protectedValue(node.span);
      body = { ...body, exprs: [lastOfBegin(body.exprs.at(-1))] };
      refs = this.refsIn(wire, body, body.exprs, NO_CUTS);
      if (isPair(surface)) span = scopeId(surface);
    }
    const cuts = body ? this.areas(ctx, body.exprs.at(-1), surface) : [];
    if (!body || cuts.length === 0) {
      // A port-coupled mux's arm wire (arrival splits those itself) sits in its arm.
      const arm = target.scope.frame === "arm" && target.to.port === "out" ? target.scope.key : undefined;
      const at = { span, ...(arm === undefined ? {} : { container: arm }) };
      const shape = this.shape(ctx, wire, body, body?.exprs ?? [], NO_CUTS, target.to, at);
      this.emit(ctx, wire, shape, this.producers(ctx, refs, target.scope, isOwnerOut, new Set()), target);
      return;
    }
    this.split(ctx, wire, body, body.exprs, cuts, target, isOwnerOut, { span });
  }

  /** The program form a guard/try's protected body ends in: a guard's last body form, a try's
   *  one body form. */
  private protectedValue(span: string): unknown {
    const items = listItems(this.surfaceOf(span));
    if (nameIs(items[0], "try")) return items[1];
    return items.length > 2 ? items.at(-1) : undefined;
  }

  /** A region's capture: what the enclosing graph supplies for one free variable of its interior,
   *  read by the interior's wires that name it. */
  private capture(ctx: Context, wire: Wire): void {
    const node = ctx.graph.nodes.at(wire.consumer.node);
    let interior: WireframeGraph | undefined;
    if (node?.kind === "binder") interior = node.interior;
    else if (node?.kind === "fan" || node?.kind === "closure") interior = node.template;
    if (!node || !interior) return;
    const frame = node.kind === "closure" ? this.closureOwner(ctx, node) : this.item(ctx, node);
    const scope = isFrame(frame) ? this.outside(frame.key) : ctx.owner;
    const producers = this.producers(ctx, this.liveRefs(wire, true), scope, false, new Set());
    const names = this.captured.get(interior) ?? new Map<string, Producer[]>();
    names.set(wire.consumer.slot.slice("capture:".length), producers);
    this.captured.set(interior, names);
  }

  /** A fan's callback value. A closure is the callback itself (opened as a region); a callback
   *  computed from step results has no port to land on. */
  private callbackValue(ctx: Context, wire: Wire): void {
    const computed = this.liveRefs(wire, true).filter(
      (r) => r.kind !== "node" || ctx.graph.nodes.at(r.node)?.kind !== "closure",
    );
    if (computed.length === 0) return;
    this.drop("unmappable", `wire ${wire.span} → fn: a computed callback value is not drawn`);
  }

  /** A wire through conditionals the plan draws as `branch` areas: each conditional is cut —
   *  the rest of the expression reads the branch's `out` — and every arm's value becomes its own
   *  wire inside that arm, into the branch's `out` (split again where it holds a conditional). */
  private split(
    ctx: Context,
    wire: Wire,
    body: WireBody,
    exprs: readonly unknown[],
    cuts: readonly Cut[],
    target: { to: End; scope: PlanFrame; kind: PlanEdge["kind"] },
    intoOwnerOut: boolean,
    at: Placement,
  ): void {
    const cutForms = new Set(cuts.map((c) => c.form));
    const shape = this.shape(ctx, wire, body, exprs, cutForms, target.to, at);
    const producers = [
      ...this.producers(ctx, this.refsIn(wire, body, exprs, cutForms), target.scope, intoOwnerOut, new Set()),
      ...cuts.map((c): Producer => ({ key: c.frame.key, port: "out" })),
    ];
    // An area the wireframe left inline (a pure-classified call, an undeclared host's
    // callback) has no context of its own: what it reads from inside leaves through its `out`;
    // what it reads from outside stays the wire's input.
    for (const c of cuts.filter((x) => opaque(x))) {
      const inner = this.producers(ctx, this.refsIn(wire, body, [c.form], NO_CUTS), target.scope, false, new Set());
      for (const p of inner) {
        if (this.isAncestor(c.frame, p.key)) this.hop({ key: p.key }, c.frame, p.port);
        else producers.push(p);
      }
    }
    this.emit(ctx, wire, shape, producers, target);
    for (const c of cuts) {
      for (const v of this.valuesOf(c)) {
        const into = { to: { key: v.into.key, port: "out" as const }, scope: v.scope, kind: "data" as const };
        const where = isPair(v.surface)
          ? { span: scopeId(v.surface), container: v.scope.key }
          : { span: v.scope.span, container: v.scope.key, unlocated: true };
        this.split(ctx, wire, body, [v.form], this.areas(ctx, v.form, v.surface), into, false, where);
      }
    }
  }

  /** The value expressions an area's `out` reads — each its own wire inside the area — plus the
   *  hops between nested areas (a guard's on-raise branch into the guard). Loops, fans and
   *  calls get theirs from their own wireframe context: none here. */
  private valuesOf(c: Cut): AreaValue[] {
    const out: AreaValue[] = [];
    const push = (value: [unknown, unknown] | undefined, into: PlanFrame, scope: PlanFrame) => {
      if (value) out.push({ form: value[0], surface: value[1], into, scope });
    };
    const f = c.frame;
    const [w, sf] = [listItems(c.form), listItems(c.surface)];
    if (f.frame === "branch") {
      for (const [k, arm] of f.children.entries()) {
        if (arm.kind === "frame") push(armValue(c.head, c.form, c.surface, k), f, arm);
      }
    } else if (f.frame === "seq" && (c.head === "and" || c.head === "or")) {
      for (let i = 1; i < w.length; i++) push(pick(w, sf, i), f, f);
    } else if (f.frame === "seq" && (c.head === "guard" || c.head === "try")) {
      const raise = f.children.find((x): x is PlanFrame => x.kind === "frame" && x.onRaise === true);
      const handler = raise?.children[0];
      if (c.head === "guard") {
        if (w.length > 2) push(pick(w, sf, w.length - 1), f, f);
        const [wc, sc] = [partsOf(w[1]).slice(1), partsOf(sf[1]).slice(1)];
        const clauses = this.plan.byKey.get(`${f.key}/handler`);
        if (isFrame(clauses) && clauses.frame === "branch") {
          for (const [k, arm] of clauses.children.entries()) {
            if (arm.kind === "frame") push(clauseValue(wc[k], sc[k]), clauses, arm);
          }
          this.hop(clauses, raise);
        } else if (raise && isFrame(handler)) push(clauseValue(wc[0], sc[0]), raise, handler);
      } else {
        push(pick(w, sf, 1), f, f);
        const [wc, sc] = [catchOf(w), catchOf(sf)];
        if (raise && isFrame(handler) && wc.length > 1) push(pick(wc, sc, wc.length - 1), raise, handler);
      }
      this.hop(raise, f);
    }
    return out;
  }

  /** An inner area's result flows on into the area holding it. */
  private hop(from: Pick<PlanFrame, "key"> | undefined, to: PlanFrame | undefined, port: PlanPort = "out"): void {
    if (from && to) this.edges.push({ from: { key: from.key, port }, to: { key: to.key, port: "out" }, kind: "data" });
  }

  private emit(
    ctx: Context,
    wire: Wire,
    shape: WireShape,
    producers: readonly Producer[],
    target: { to: End; kind: PlanEdge["kind"] },
  ): void {
    const via = IDENTITY.test(wire.source) ? undefined : wire.source;
    for (const { key, port, control } of producers) {
      const kind = control === true ? "control" : target.kind;
      this.edges.push({ from: { key, port }, to: target.to, kind, ...(via === undefined ? {} : { via }), wire: shape });
    }
  }

  /** The wire's param refs `exprs` depend on, cut conditionals left out. */
  private refsIn(wire: Wire, body: WireBody, exprs: readonly unknown[], cuts: ReadonlySet<unknown>): WireParam[] {
    const live = liveIn(body, exprs, cuts);
    return wire.paramRefs.filter((_, i) => live.has(wire.params[i]!));
  }

  /** The program's own forms by span, for reading which wire sub-forms the plan drew. */
  private surface: Map<string, unknown> | undefined;

  private surfaceOf(span: string): unknown {
    if (!this.surface) {
      const index = new Map<string, unknown>();
      const visit = (f: unknown): void => {
        if (isPair(f)) {
          index.set(scopeId(f), f);
          for (let c: unknown = f; isPair(c); c = c.cdr) visit(c.car);
        } else for (const el of bracketItems(f) ?? []) visit(el);
      };
      for (const f of this.forms) visit(f);
      this.surface = index;
    }
    return this.surface.get(span);
  }

  /** The outermost control forms in `expr` (a wire form) that the plan draws as areas (a frame
   *  at its span — a branch, an and/or/guard/try `seq`, a loop, a fan, a call),
   *  found by walking the program form it re-prints (`surface`) alongside — the wire is the
   *  program's own expression with designated calls cut to params. A `let` the emitter re-wraps
   *  around the wire is the program's too: its body is the inner expression. */
  private areas(ctx: Context, expr: unknown, surface: unknown): Cut[] {
    const out: Cut[] = [];
    const visit = (w: unknown, sf: unknown): void => {
      if (!isPair(w) || !isPair(sf)) return;
      const head = symbolName(w.car);
      // A quoted datum is no expression; a lambda body runs elsewhere.
      if (head === "quote" || head === "lambda") return;
      if (head !== undefined && head === symbolName(sf.car)) {
        const frame = this.plan.byKey.get(ctx.path + scopeId(sf));
        if (isFrame(frame) && frame.frame !== "arm" && (frame.frame !== "branch" || CONDITIONALS.has(head))) {
          out.push({ frame, head, form: w, surface: sf });
          return;
        }
      }
      const [ws, ss] = [partsOf(w), partsOf(sf)];
      if (ws.length !== ss.length) return;
      for (const [i, x] of ws.entries()) visit(x, ss[i]);
    };
    let sf = surface;
    while (isPair(sf) && LET_FAMILY.has(symbolName(sf.car) ?? "") && !isSymbol(listItems(sf.cdr)[0])) {
      sf = listItems(sf.cdr).at(-1);
    }
    visit(expr, sf);
    return out;
  }

  private readonly wireIds = new Map<string, number>();

  /** The shape, id and text (see `WireShape`) of `exprs` of a wire into `to`. */
  private shape(
    ctx: Context,
    wire: Wire,
    body: WireBody | undefined,
    exprs: readonly unknown[],
    cuts: ReadonlySet<unknown>,
    to: End,
    at: Placement,
  ): WireShape {
    const base = `${ctx.path}${at.span}→${to.key}:${to.port}`;
    const n = this.wireIds.get(base) ?? 0;
    this.wireIds.set(base, n + 1);
    const consumer = this.plan.byKey.get(to.key);
    const operand =
      consumer?.kind === "step" && to.port.startsWith("in:")
        ? consumer.args.find((a) => a.slot === to.port.slice(3))?.source
        : undefined;
    const cut = new Map<string, string>();
    for (const [i, ref] of wire.paramRefs.entries()) {
      const node = ref.kind === "node" ? ctx.graph.nodes.at(ref.node) : undefined;
      let op: string | undefined;
      if (node?.kind === "template-ref") op = node.name;
      else if (node?.kind === "recur") op = "recur";
      else if (node && "op" in node) op = node.op;
      if (op !== undefined) cut.set(wire.params[i]!, `(${op} …)`);
    }
    return {
      id: n === 0 ? base : `${base}#${n}`,
      ...(body ? classify(body, exprs.at(-1), cuts) : { kind: "compute" as const }),
      text: operand ?? (body ? exprText(exprs, cuts, cut) : wire.source),
      ...(at.unlocated ? {} : { span: at.span }),
      ...(at.container === undefined ? {} : { container: at.container }),
    };
  }

  /** The wire's param refs its value actually depends on. */
  private liveRefs(wire: Wire, count: boolean): readonly WireParam[] {
    let live = this.liveness.get(wire.source);
    if (!this.liveness.has(wire.source)) {
      const form = this.wireForms.get(wire.source);
      live = form === undefined ? undefined : liveParams(form);
      this.liveness.set(wire.source, live);
    }
    if (!live) return wire.paramRefs;
    const refs = wire.paramRefs.filter((_, i) => live.has(wire.params[i]!));
    if (count) this.deadBindings += wire.paramRefs.length - refs.length;
    return refs;
  }

  /** The plan ports a wire's params read from. */
  private producers(
    ctx: Context,
    refs: readonly WireParam[],
    scope: PlanFrame,
    intoOwnerOut: boolean,
    seen: Set<number>,
  ): Producer[] {
    return refs.flatMap((ref) => {
      if (ref.kind === "slot") return this.slotProducer(ctx, scope, ref.name);
      // A guard's caught condition comes from whatever raised in its body: the on-raise branch
      // already draws that, no single producer does.
      if (ref.slot === "condition") return [];
      const node = ctx.graph.nodes.at(ref.node);
      return node ? this.nodeProducers(ctx, node, ref.node, scope, intoOwnerOut, seen) : [];
    });
  }

  /** A free variable: the param port of the frame binding it, else what the region's capture
   *  wire reads outside. */
  private slotProducer(ctx: Context, scope: PlanFrame, name: string): Producer[] {
    const frame = this.binder(ctx, scope, name);
    if (frame) return [{ key: frame.key, port: `in:${name}` }];
    const captured = this.captured.get(ctx.graph)?.get(name);
    if (captured) return captured;
    this.drop(
      "capture",
      `capture "${name}" in ${ctx.owner.key} not linked: no frame binds it and no capture wire supplies it`,
    );
    return [];
  }

  private nodeProducers(
    ctx: Context,
    node: WireframeNode,
    index: number,
    scope: PlanFrame,
    intoOwnerOut: boolean,
    seen: Set<number>,
  ): Producer[] {
    if (node.kind === "recur") return this.recurProducer(ctx, node.span, intoOwnerOut);
    if (node.kind === "closure") {
      // A lambda's value is the frame drawn for its body; a named procedure as a value carries
      // no step's data.
      const owner = node.template && this.closureOwner(ctx, node);
      return owner ? [{ key: owner.key, port: "out" }] : [];
    }
    if (node.kind === "template-ref") {
      const at = this.templateRef(ctx, node);
      const frame = at.call ?? at.stub;
      if (frame) return [{ key: frame.key, port: "out" }];
      // A recursion site the skeleton made a tail `recur`: its value is the loop's result.
      if (!at.recur) {
        this.drop("unmappable", `template-ref ${node.name} at ${node.span}: no plan item at ${ctx.path}${node.span}`);
      }
      return [];
    }
    const item = this.item(ctx, node);
    if (item) return [{ key: item.key, port: "out" }];
    if ((node.kind === "fan" || node.kind === "binder" || node.kind === "mux") && !seen.has(index)) {
      // A region the skeleton pruned (no steps inside) is transparent: its inputs' producers
      // flow straight through — a pruned mux's selector as a decision (`control`).
      seen.add(index);
      return ctx.graph.wires
        .filter((w) => w.consumer.node === index)
        .flatMap((w) => {
          const control = node.kind === "mux" && !SHORT_CIRCUIT.has(node.op) && w.consumer.slot.startsWith("selector");
          const ps = this.producers(ctx, this.liveRefs(w, false), scope, false, seen);
          return control ? ps.map((p) => ({ ...p, control })) : ps;
        });
    }
    this.drop("unmappable", `producer ${describe(node)}: no plan item at ${ctx.path}${node.span}`);
    return [];
  }

  /** All-tail: the recursion's value IS the loop's result. A non-tail named let reads its inner
   *  iteration's result. A `do` result clause reads a loop variable's final value (arrival:
   *  the recur node's `argK` slot), but the plan draws the result clause once, AFTER the loop
   *  frame (it runs once, not per iteration), and the frame has no port for a variable's final
   *  value — its `in:<var>` ports are what each iteration reads. Dropped and counted. */
  private recurProducer(ctx: Context, span: string, intoOwnerOut: boolean): Producer[] {
    if (intoOwnerOut || ctx.owner.tail === true) return [];
    if (ctx.binder !== "do") return [{ key: ctx.owner.key, port: "out" }];
    this.drop(
      "recur-value",
      `recur ${span}: a do result reads a loop variable's final value; ${ctx.owner.key} has no port for it, not linked`,
    );
    return [];
  }

  /** The innermost frame from `scope` out to the context owner that binds `name`. */
  private binder(ctx: Context, scope: PlanFrame, name: string): PlanFrame | undefined {
    for (let f: PlanFrame | undefined = scope; f; f = this.parent(f.key)) {
      if (f.params.includes(name)) return f;
      if (f === ctx.owner) return undefined;
    }
    return undefined;
  }

  /** What the wireframe never reached: skeleton frames it should have produced a node for and
   *  whose subtree no edge touches, and steps no wireframe node maps to. */
  private unreached(edges: readonly PlanEdge[]): void {
    const touched = new Set(edges.flatMap((e) => [e.from.key, e.to.key]));
    const visit = (frame: PlanFrame): boolean => {
      // The interior: an edge at the frame's own ports (a call whose value is read) is not one.
      let reached = false;
      for (const c of frame.children) {
        if (c.kind === "frame") reached = visit(c) || reached;
        else {
          reached = touched.has(c.key) || reached;
          if (!this.joined.has(c.key)) {
            this.unreachedSteps++;
            this.notes.add(`no dataflow for ${c.key}: arrival wireframe kept it inside a wire`);
          }
        }
      }
      const expected =
        (frame.frame === "call" && !frame.recursive) ||
        frame.frame === "par" ||
        (frame.frame === "loop" &&
          frame.host === undefined &&
          (frame.recurSpans !== undefined || frame.label === "do"));
      if (expected && !reached && !this.claimed.has(frame.key)) {
        this.notes.add(`no wireframe node for ${frame.frame} ${frame.key}; its interior has no dataflow`);
      }
      return reached || touched.has(frame.key);
    };
    visit(this.plan.root);
  }

  // ── rewrites ──

  /** An edge leaving a frame passes through its `out`, innermost first (arms belong to their
   *  branch; a recur backedge leaves its arm by definition). Then dedupe. */
  finish(): PlanEdge[] {
    const routed: PlanEdge[] = [];
    for (const edge of this.edges) {
      if (edge.kind === "recur") {
        routed.push(edge);
        continue;
      }
      const consumer = this.plan.byKey.get(edge.to.key);
      let from = edge.from;
      for (let f = this.parent(edge.from.key); f; f = this.parent(f.key)) {
        if (!consumer || f.key === edge.to.key || this.isAncestor(f, edge.to.key)) break;
        if (f.frame === "arm") continue;
        const out: End = { key: f.key, port: "out" };
        routed.push({ from, to: out, kind: "data" });
        from = out;
      }
      routed.push({ ...edge, from });
    }
    const seen = new Set<string>();
    const edges = routed.filter((e) => {
      const id = `${e.from.key}:${e.from.port}->${e.to.key}:${e.to.port}[${e.kind}]`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    this.unreached(edges);
    return edges;
  }
}

function describe(node: WireframeNode | undefined): string {
  if (!node) return "?";
  if (node.kind === "template-ref") return `template-ref ${node.name}`;
  return "op" in node ? `${node.kind} ${node.op}` : node.kind;
}

/** `plan` with `edges` from arrival's wireframe, joined by span, and the join's counters and
 *  losses appended to `diagnostics`. Never throws. */
export async function attachDataflow(plan: Plan, input: DataflowInput): Promise<Plan> {
  let program: WireframeProgram;
  try {
    program = buildWireframe(input.forms, wireframeOptions(input));
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    return {
      ...plan,
      edges: [],
      dataflow: { status: "unavailable", reason: `${err.name}: ${err.message}`, missing: 0 },
      diagnostics: [
        ...plan.diagnostics,
        `dataflow unavailable — ${err.name}: ${err.message} (arrival wireframe; upstream fix pending)`,
      ],
    };
  }
  const join = new Join(plan, program, input.symbols, await readWires(program), input.forms);
  join.run();
  const edges = join.finish();
  const total = [...join.dropped.values()].reduce((a, b) => a + b, 0);
  const reasons = [...join.dropped].map(([reason, n]) => `${reason} ${n}`).join(", ");
  const dropped = reasons ? `dropped ${total} (${reasons})` : `dropped ${total}`;
  const missing = total + join.unreachedSteps;
  return {
    ...plan,
    edges,
    dataflow: { status: missing > 0 ? "partial" : "complete", missing },
    diagnostics: [
      ...plan.diagnostics,
      `dataflow: ${join.wires} wires, ${edges.length} edges, ${dropped}, dead-binding ${join.deadBindings}, ${join.unreachedSteps} steps without a node`,
      ...join.notes,
    ],
  };
}
