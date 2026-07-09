/**
 * Q8a (PROVENANCE-PLAN.md wave 5) — THE WIREFRAME BUILDER CORE. `classify()`
 * generalized whole-program (execution-plan-wireframe.md §2, AS AMENDED by
 * docs/PROVENANCE.md §1): build the PROSPECTIVE template graph over a program's
 * top-level defines + main expression.
 *
 * THE CUT-AND-CLOSE ALGORITHM. Walk each surface expression; every DESIGNATED
 * subterm (§1: a membrane-crossing port, a PORT-COUPLED mux, a fan instantiation
 * point, a binder, a call to a port-reaching define) becomes a NODE; the maximal
 * pure residue around the cuts is ONE WIRE — `unevalWire` closes it into a
 * lambda-lifted arrival lambda whose params are exactly its ingress (cut node
 * egresses + env-supplied slots), with wire-locality enforced at emission. This is
 * §1's collapse rule operationally: "maximal pure connected subgraphs fold to one
 * wire. Ports break segments by definition, so a wire body structurally contains
 * no source, sink, or port-coupled mux — wire purity is by construction."
 *
 * SELECTOR-CONE REACHABILITY IS OWNED HERE (plan Q8a amendment 1): Q3's classifier
 * supplies DECLARATIONS only; whether a mux stays a node is builder analysis. A mux
 * is port-coupled iff its selector's backward cone reaches a port. Computed as
 * `reachesPort(classify(selector, reachClassifier, subst))` where
 *   - `subst` is the builder's own let-walk substitution (the same map
 *     `classifyLet` builds internally, threaded in via classify's Q8a param) — so
 *     `(let ((y (src))) (if y …))` couples through the binding;
 *   - `classify`'s `field` arm descends the FOCUSED child only (siblings pruned
 *     structurally) — `walk()`'s field-arm demand pattern, EXTENDED to selector
 *     reachability rather than rebuilt (amendment 1's instruction): a selector
 *     `(:flag (src))` couples, `(:flag cfg)` over a plain slot does not;
 *   - `reachClassifier` additionally lowers PORT-REACHING DEFINE names to `opaque`
 *     (reachesPort's conservative arm), closing the transitive gap the prelude
 *     partition's fixpoint closed one layer down: `(if (helper x) …)` couples when
 *     `helper` wraps a fetch.
 * A pure-selector mux collapses INTO its wire (§1 A2): its decision is a
 * deterministic function of frozen ingress, rederived by γ — the wire's params are
 * its full FV set, BOTH arms' ingress included (the m3 precision trade; do not
 * "fix" by re-recording).
 *
 * I5 EXTERIOR COLLAPSE (§3): a fan is a REGION HOST and presents as ONE node from
 * the enclosing graph; the callback body's own wireframe is the region's private
 * `template` interior (replayed on demand), never spliced into G. No region
 * field-ports exist (I5 LIMIT: field-demand at a region boundary answers by
 * REPLAY, not by records).
 *
 * LOOP WIREFRAMING (Q8a′, PROVENANCE-PLAN.md wave 6; `wireframe/loops.ts`):
 *   - binder{cycles} nodes (named-let / do) get a REAL private interior — the
 *     loop body's own `GraphBuilder` (Q8a's I5 pattern), never spliced into the
 *     enclosing graph. A call to the loop's own name (named-let) or the step
 *     expressions (`do`) are the BACKEDGE (a `recur` node) — they feed the
 *     NEXT iteration's `params`, never a value escaping the loop; the binder
 *     node's OWN ingress wires carry only the INITIAL values. A port inside a
 *     loop body wireframes through the interior exactly like any other cut.
 *     `buildNamedLetBinder`/`buildDoBinder`/`addRecur` below; `wireframe/
 *     loops.ts` supplies `do`'s pure binding-shape parser + a visited-set-
 *     guarded reachability walk (V4's termination discipline). A declared-
 *     `loop`-role op with no known recursive shape (dead code today) gets an
 *     empty interior — no recursive structure to invent.
 *   - A local closure (`letrec`-bound lambda) wrapping a port under-designates a
 *     mux whose selector calls it (classify never expands call sites into callee
 *     bodies): the port itself is still cut to a node, so replay stays sound (the
 *     abstract cone includes its ingress); designation precision re-audits at Q9's
 *     agreement corpus.
 *   - A sink cut in non-tail `begin` position leaves the wire a sequencing
 *     reference to the sink node (D6 territory) — tolerated, not modeled.
 *   - Hash/path keying is Q8b.
 *
 * STRUCT-FACT WIRES (Q8c, PROVENANCE-PLAN.md wave 7; docs/PROVENANCE.md §2 R2 + A5,
 * §6 demand lattice): `factTagOf` below tags an `emitWire` output whose ENTIRE closed
 * body is a single structural-fact read — `(length p)` / `(vector-length p)` /
 * `(string-length p)`, unshadowed, never a wireframe-material call, resolving to the
 * hermetic BASE primitive — mirroring the values-layer TERM name (P8: ONE term,
 * `arrival/tagless-final/length`, for all three surface spellings) rather than a
 * per-surface-verb vocabulary. Per A5: "struct-fact wires are value wires carrying a
 * fact TAG, not a second edge species" — NO new node kind, NO new wire species; the
 * tag lives on `Wire.fact` (types.ts) and is additive (an untagged wire is byte-
 * identical to before this landing). The count-demand CONSUMER of the tag —
 * `reachableNodesForDemand`'s `"count"` grade, routing through fact wires only and
 * never an element wire — lives in `wireframe/loops.ts`.
 */
import type { SchemeValue } from "../../values/types.js";
import { APair } from "../../values/primitives/APair.js";
import { ASymbol } from "../../values/primitives/ASymbol.js";
import { classify, type Classifier, type LineageNode, type Subst } from "../../values/lineage.js";
import type { CallbackRoles } from "../../common/symbols/_bake.js";
import { classifyProgramPrelude, buildPreludeSource, reachesPort } from "../prelude.js";
import { defineNameOf } from "../slice.js";
import { scopeId } from "../scope-id.js";
import { unevalWire } from "../uneval.js";
import { parseDoBindings, parseDoClause } from "./loops.js";
import type {
  DefineTemplate,
  Wire,
  WireConsumer,
  WireFact,
  WireFrame,
  WireFrameEntry,
  WireframeGraph,
  WireframeNode,
  WireframeProgram,
} from "./types.js";

/** Q8c (§2 R2 + A5) — the DECLARED-TERM vocabulary of surface ops whose contract reads
 *  ONLY a container's structural fact, never its element union. Mirrors
 *  `values/__tests__/laws/_tables/terms.ts`'s `arrival/tagless-final/length` verbs
 *  EXACTLY (`length`/`vector-length`/`string-length` — ONE term, P8) — every spelling
 *  here tags the SAME `verb: "length"` (`factTagOf` below), never a per-spelling tag. */
const FACT_VERBS: ReadonlySet<string> = new Set(["length", "vector-length", "string-length"]);

export interface WireframeBuildOptions {
  /** Q3's declaration-driven classifier — the ONE role read (`.provenanceRole`). */
  readonly classifier: Classifier;
  /** Is this name resolvable in the hermetic BASE env (natives, macros, base
   *  packs)? Production derives it from the sealed base chain; tests use a set. */
  readonly isBaseName: (name: string) => boolean;
  /** Q4's contract-extracted callback roles for a host verb, when available —
   *  stamped onto fan nodes as data (never consulted for designation here). */
  readonly callbackRolesOf?: (op: string) => CallbackRoles | undefined;
}

/** Shared, immutable per-program context every GraphBuilder reads. */
interface BuildCtx {
  readonly classifier: Classifier;
  /** `classifier` widened for REACHABILITY: a port-reaching define name lowers to
   *  `opaque` (reachesPort's conservative arm) — the transitive coupling read. */
  readonly reachClassifier: Classifier;
  readonly preludeNames: ReadonlySet<string>;
  readonly materialNames: ReadonlySet<string>;
  readonly isBaseName: (name: string) => boolean;
  readonly callbackRolesOf?: (op: string) => CallbackRoles | undefined;
}

/** The walk's lexical context: `subst` feeds classify-based selector reachability
 *  (let transparency); `frames` are the let-family wrappers `unevalWire` re-wraps. */
interface WalkEnv {
  readonly subst: Subst;
  readonly frames: readonly WireFrame[];
  /** The CURRENT (innermost) loop's recur name, when walking inside a binder's
   *  `interior` graph; `undefined` outside any loop body (Q8a′, §1: "loop
   *  variables wired from the body's recur-position egress"). A call to this
   *  name is the BACKEDGE — intercepted in `walkForCuts` before the normal
   *  materialNames/role dispatch, never falling through as an ordinary
   *  application. Does NOT cross an I5 region boundary (a fan's own `template`
   *  interior starts a fresh env with no `recur` — see `buildFan`). */
  readonly recur?: { readonly name: string };
}

// ── local surface helpers (lineage.ts keeps its own private copies; same shapes) ──

function opName(x: unknown): string {
  const v = (x as { valueOf?: () => unknown })?.valueOf?.();
  return typeof v === "string" || typeof v === "symbol" ? String(v) : String(x);
}

function operands(app: APair<SchemeValue, SchemeValue>): unknown[] {
  const out: unknown[] = [];
  let n: unknown = app.cdr;
  while (n instanceof APair) {
    out.push(n.car);
    n = n.cdr;
  }
  return out;
}

/** Formal names of a lambda formals list (positional symbols; a variadic/dotted
 *  tail symbol is included — it binds too). */
function lambdaParams(formals: unknown): string[] {
  const out: string[] = [];
  let n: unknown = formals;
  while (n instanceof APair) {
    if (n.car instanceof ASymbol) out.push(opName(n.car));
    n = n.cdr;
  }
  if (n instanceof ASymbol) out.push(opName(n));
  return out;
}

const LEAF = (slot: string): LineageNode => ({ kind: "leaf", slot });

/** The empty wireframe graph — used for a declared-`loop`-role op with no known
 *  recursive shape (dead code today; see the `role === "loop"` arm below). */
const EMPTY_GRAPH: WireframeGraph = { nodes: [], wires: [], egress: null };

/** `(let ((a e)…) …)` binding entries as {name, rhs} pairs. */
function letEntries(bindings: unknown): WireFrameEntry[] {
  const out: WireFrameEntry[] = [];
  let n: unknown = bindings;
  while (n instanceof APair) {
    const b = n.car;
    if (b instanceof APair && b.car instanceof ASymbol) {
      out.push({ name: opName(b.car), rhs: b.cdr instanceof APair ? b.cdr.car : undefined });
    }
    n = n.cdr;
  }
  return out;
}

/** Elements of a proper pair chain. */
function chainOf(n: unknown): unknown[] {
  const out: unknown[] = [];
  let cur: unknown = n;
  while (cur instanceof APair) {
    out.push(cur.car);
    cur = cur.cdr;
  }
  return out;
}

/** One graph under construction (the main program, a define template, or a fan
 *  region's interior — each region interior is its OWN GraphBuilder: I5's collapse
 *  is structural, interior nodes cannot leak into the enclosing graph). */
class GraphBuilder {
  private readonly nodes: WireframeNode[] = [];
  private readonly wires: Wire[] = [];
  /** Designated surface subterm → node id, shared across this graph's emissions
   *  (a cut made while walking a let RHS is visible to every wire wrapped in that
   *  frame). */
  private readonly cuts = new Map<unknown, number>();
  private egress: number | null = null;

  constructor(private readonly bctx: BuildCtx) {}

  finish(): WireframeGraph {
    return { nodes: this.nodes, wires: this.wires, egress: this.egress };
  }

  private addNode(node: WireframeNode): number {
    this.nodes.push(node);
    return this.nodes.length - 1;
  }

  /** Walk a top-level form whose VALUE is dropped — designated nodes (and their
   *  ingress wires) still land; the pure residue emits no wire (dead by D6's
   *  root-binder sequencing, which is prospective-only). */
  walkDropped(expr: unknown, env: WalkEnv): void {
    this.walkForCuts(expr, env);
  }

  /** Wireframe the graph's VALUE expression: an out-port node + the egress wire.
   *  A form that IS entirely a sink keeps `egress` null (§2: a sink is a port with
   *  no egress wire — nothing flows onward). */
  emitEgress(expr: unknown, env: WalkEnv): void {
    this.walkForCuts(expr, env);
    const cutId = this.cuts.get(expr);
    if (cutId !== undefined && this.nodes[cutId].kind === "sink") return;
    const out = this.addNode({ kind: "port", direction: "out", span: scopeId(expr) });
    this.egress = out;
    this.emitWire(expr, { node: out, slot: "out" }, env);
  }

  /** Close the maximal pure residue of `expr` into ONE wire feeding `consumer`. */
  private emitWire(expr: unknown, consumer: WireConsumer, env: WalkEnv): void {
    this.walkForCuts(expr, env);
    const emitted = unevalWire({
      expr,
      frames: env.frames,
      cuts: this.cuts,
      preludeNames: this.bctx.preludeNames,
      materialNames: this.bctx.materialNames,
      isBaseName: this.bctx.isBaseName,
    });
    const fact = this.factTagOf(expr, env);
    this.wires.push({ ...emitted, consumer, ...(fact !== undefined ? { fact } : {}) });
  }

  /** Q8c (§2 A5) — tag a wire whose ENTIRE closed body is a single structural-fact
   *  read: `(length p)` / `(vector-length p)` / `(string-length p)`. Guards, in the
   *  same teaching order `unevalWire`'s free-variable partition uses:
   *   - `env.subst.has(op)` — a LOCAL binding shadows the name (a let/lambda param
   *     literally called `length`); never tag a shadowed call.
   *   - `materialNames.has(op)` — a port-reaching top-level define named `length`
   *     is wireframe MATERIAL (cut to a template-ref node by `walkForCuts` before
   *     `emitWire` ever sees this `expr` as call material) — never the base primitive.
   *   - `!isBaseName(op)` — anything not resolving to the hermetic base env (a plain
   *     unbound/user name shaped like a base op) is not the DECLARED term.
   *  Deliberately narrow to the TOP-LEVEL application only — `(+ 1 (length xs))` is
   *  NOT tagged (its wire computes more than the fact) — so the tag's promise stays
   *  exact for `loops.ts`'s count-demand router. */
  private factTagOf(expr: unknown, env: WalkEnv): WireFact | undefined {
    if (!(expr instanceof APair) || !(expr.car instanceof ASymbol)) return undefined;
    const op = opName(expr.car);
    if (env.subst.has(op) || !FACT_VERBS.has(op)) return undefined;
    if (this.bctx.materialNames.has(op) || !this.bctx.isBaseName(op)) return undefined;
    if (operands(expr as APair<SchemeValue, SchemeValue>).length !== 1) return undefined;
    return { kind: "fact", verb: "length" };
  }

  /** Selector-cone reachability (Q8a amendment 1) — see the file header. */
  private selectorReachesPort(selector: unknown, env: WalkEnv): boolean {
    return reachesPort(classify(selector as SchemeValue, this.bctx.reachClassifier, env.subst));
  }

  // ── the designation walk ────────────────────────────────────────────────────

  /** Find and BUILD every designated subterm under `expr` (registering it in
   *  `cuts`); descend nothing already cut. Pure residue is left in place for the
   *  enclosing `emitWire` to close. */
  private walkForCuts(expr: unknown, env: WalkEnv): void {
    if (this.cuts.has(expr)) return;
    if (!(expr instanceof APair)) return; // literals & bare symbols are wire material

    const head = expr.car;
    if (head instanceof ASymbol) {
      const form = opName(head);
      if (!env.subst.has(form)) {
        switch (form) {
          case "quote":
            return; // datum space — no designation inside
          case "quasiquote":
            this.walkQuasi(expr.cdr instanceof APair ? expr.cdr.car : undefined, 1, env);
            return;
          case "if":
          case "when":
          case "unless": {
            const rest = expr.cdr;
            if (!(rest instanceof APair)) return;
            const test = rest.car;
            if (this.selectorReachesPort(test, env)) {
              this.cuts.set(expr, this.buildMux(expr, rest, form, env));
              return;
            }
            // Pure-selector mux — collapses INTO the wire (§1 A2); keep walking for
            // designated subterms in selector/arms (they cut out of the wire).
            this.walkForCuts(test, env);
            for (const arm of chainOf(rest.cdr)) this.walkForCuts(arm, env);
            return;
          }
          case "cond": {
            const clauses = chainOf(expr.cdr).filter((c): c is APair<SchemeValue, SchemeValue> => c instanceof APair);
            const coupled = clauses.some(
              (c) => !(c.car instanceof ASymbol && opName(c.car) === "else") && this.selectorReachesPort(c.car, env),
            );
            if (coupled) {
              this.cuts.set(expr, this.buildCondMux(expr, clauses, env));
              return;
            }
            for (const clause of clauses) {
              if (!(clause.car instanceof ASymbol && opName(clause.car) === "else")) this.walkForCuts(clause.car, env);
              for (const bodyForm of chainOf(clause.cdr)) {
                if (bodyForm instanceof ASymbol && opName(bodyForm) === "=>") continue;
                this.walkForCuts(bodyForm, env);
              }
            }
            return;
          }
          case "let":
          case "let*":
          case "letrec":
          case "letrec*":
            this.walkLet(expr, form as "let" | "let*" | "letrec" | "letrec*", env);
            return;
          case "do":
            // Iterative loop — designated binder{cycles}, Q8a′: a real backedge-
            // wired interior (the step expressions are the backedge).
            this.cuts.set(expr, this.buildDoBinder(expr, env));
            return;
          case "begin":
          case "and":
          case "or":
            for (const sub of chainOf(expr.cdr)) this.walkForCuts(sub, env);
            return;
          case "lambda": {
            const rest = expr.cdr;
            if (!(rest instanceof APair)) return;
            const extended = new Map(env.subst);
            for (const p of lambdaParams(rest.car)) extended.set(p, LEAF(p));
            const inner: WalkEnv = { subst: extended, frames: env.frames, recur: env.recur };
            for (const bodyForm of chainOf(rest.cdr)) this.walkForCuts(bodyForm, inner);
            return;
          }
          case "define": {
            // Interior define (rare in wire space) — walk its value/body forms.
            const rest = expr.cdr;
            if (!(rest instanceof APair)) return;
            const extended = new Map(env.subst);
            if (rest.car instanceof APair) for (const p of lambdaParams(rest.car.cdr)) extended.set(p, LEAF(p));
            const inner: WalkEnv = { subst: extended, frames: env.frames, recur: env.recur };
            for (const bodyForm of chainOf(rest.cdr)) this.walkForCuts(bodyForm, inner);
            return;
          }
          default:
            break; // not a modeled special form — application path below
        }
      }
    }

    // ── application: (op . args) ──
    if (head instanceof APair) {
      // Computed operator — walk it and the args; no designation for the call itself
      // (classify's A21 HOF hole; conservative wire material).
      this.walkForCuts(head, env);
      for (const a of operands(expr)) this.walkForCuts(a, env);
      return;
    }
    if (!(head instanceof ASymbol)) {
      for (const a of operands(expr)) this.walkForCuts(a, env);
      return;
    }

    const op = opName(head);
    if (!env.subst.has(op)) {
      // Q8a′ — a call to the ENCLOSING loop's own recur name: the BACKEDGE, never
      // a port-reaching define/role dispatch. Checked first (shadowing is already
      // handled by the `env.subst.has(op)` guard above).
      if (env.recur !== undefined && op === env.recur.name) {
        this.cuts.set(expr, this.buildArgNode({ kind: "recur", span: scopeId(expr) }, expr, env));
        return;
      }
      // A call to a port-reaching top-level define — its call sites reference its
      // template subgraph (§1).
      if (this.bctx.materialNames.has(op)) {
        this.cuts.set(expr, this.buildArgNode({ kind: "template-ref", name: op, span: scopeId(expr) }, expr, env));
        return;
      }
      const role = this.bctx.classifier.roleOf(op);
      switch (role) {
        case "source":
        case "sink":
        case "transparent":
        case "opaque":
          this.cuts.set(expr, this.buildArgNode({ kind: role, op, span: scopeId(expr) }, expr, env));
          return;
        case "fan":
          this.cuts.set(expr, this.buildFan(expr, op, env));
          return;
        case "loop": {
          // A declared-`loop` op with no known recursive shape (dead code
          // today — no live declaration uses this role, values/lineage.ts's
          // DeclaredRole doc): designate the node with an EMPTY interior;
          // operands wire as ordinary ingress (buildArgNode's path) — inventing
          // iteration semantics for a combinator with none observed is not this
          // landing's job (named-let/do, which DO have known shapes, get real
          // interiors via buildNamedLetBinder/buildDoBinder above).
          const id = this.buildArgNode(
            { kind: "binder", op, span: scopeId(expr), cycles: true, params: [], interior: EMPTY_GRAPH },
            expr,
            env,
          );
          this.cuts.set(expr, id);
          return;
        }
        default:
          break; // pipe / undefined — pure application, wire material
      }
    }
    for (const a of operands(expr)) this.walkForCuts(a, env);
  }

  /** Quasiquote space: only `unquote`/`unquote-splicing` bodies re-enter expression
   *  space (depth-counted, mirroring free-vars.ts's walkQuasi). */
  private walkQuasi(n: unknown, depth: number, env: WalkEnv): void {
    if (!(n instanceof APair)) return;
    if (n.car instanceof ASymbol) {
      const hn = opName(n.car);
      if (hn === "unquote" || hn === "unquote-splicing") {
        const arg = n.cdr instanceof APair ? n.cdr.car : undefined;
        if (depth === 1) this.walkForCuts(arg, env);
        else this.walkQuasi(arg, depth - 1, env);
        return;
      }
      if (hn === "quasiquote") {
        this.walkQuasi(n.cdr instanceof APair ? n.cdr.car : undefined, depth + 1, env);
        return;
      }
    }
    let cur: unknown = n;
    while (cur instanceof APair) {
      this.walkQuasi(cur.car, depth, env);
      cur = cur.cdr;
    }
  }

  /** let-family: TRANSPARENT to designation (mirrors `classifyLet`) — walk RHSs,
   *  thread the substitution per kind, extend the frame stack for the body. A named
   *  let is a recursive binder → designated, with a REAL backedge-wired interior
   *  (Q8a′, `buildNamedLetBinder`). */
  private walkLet(expr: APair<SchemeValue, SchemeValue>, kind: "let" | "let*" | "letrec" | "letrec*", env: WalkEnv): void {
    const rest = expr.cdr;
    if (!(rest instanceof APair)) return;
    if (rest.car instanceof ASymbol) {
      // named let — binder{cycles:true}, Q8a′: a real backedge-wired interior.
      this.cuts.set(expr, this.buildNamedLetBinder(expr, rest, env));
      return;
    }
    const entries = letEntries(rest.car);
    const sequential = kind !== "let";
    const extended = new Map(env.subst);
    const partial: WireFrameEntry[] = [];
    for (const entry of entries) {
      // Walk the RHS for designated subterms. A sequential form's later RHS sits
      // under the earlier entries (frame + subst); a parallel let's RHSs see the
      // outer scope only.
      const rhsEnv: WalkEnv = sequential
        ? { subst: extended, frames: [...env.frames, { kind, entries: [...partial] }], recur: env.recur }
        : env;
      this.walkForCuts(entry.rhs, rhsEnv);
      const rhsSubst = sequential ? extended : env.subst;
      const rhsNode: LineageNode =
        entry.rhs === undefined
          ? { kind: "literal" }
          : classify(entry.rhs as SchemeValue, this.bctx.reachClassifier, rhsSubst);
      extended.set(entry.name, rhsNode);
      partial.push(entry);
    }
    const bodyEnv: WalkEnv = { subst: extended, frames: [...env.frames, { kind, entries }], recur: env.recur };
    for (const bodyForm of chainOf(rest.cdr)) this.walkForCuts(bodyForm, bodyEnv);
  }

  // ── node constructors ───────────────────────────────────────────────────────

  /** A port/opaque/template-ref node: every operand becomes an ingress wire. */
  private buildArgNode(node: WireframeNode, expr: APair<SchemeValue, SchemeValue>, env: WalkEnv): number {
    const id = this.addNode(node);
    operands(expr).forEach((a, i) => this.emitWire(a, { node: id, slot: `arg${i}` }, env));
    return id;
  }

  /** A PORT-COUPLED mux (if/when/unless): selector wire + one wire per arm. */
  private buildMux(
    expr: APair<SchemeValue, SchemeValue>,
    rest: APair<SchemeValue, SchemeValue>,
    form: string,
    env: WalkEnv,
  ): number {
    const test = rest.car;
    // if: arms = [then, else?]; when/unless: the body's VALUE is its last form
    // (earlier forms walk value-dropped).
    const bodyForms = chainOf(rest.cdr);
    const arms = form === "if" ? bodyForms : bodyForms.length > 0 ? [bodyForms[bodyForms.length - 1]] : [];
    if (form !== "if") for (const dropped of bodyForms.slice(0, -1)) this.walkForCuts(dropped, env);
    const id = this.addNode({ kind: "mux", op: form, span: scopeId(expr), arms: arms.length });
    this.emitWire(test, { node: id, slot: "selector" }, env);
    arms.forEach((arm, k) => this.emitWire(arm, { node: id, slot: `arm${k}` }, env));
    return id;
  }

  /** A PORT-COUPLED cond: one selector wire per non-else test, one wire per arm. */
  private buildCondMux(
    expr: APair<SchemeValue, SchemeValue>,
    clauses: readonly APair<SchemeValue, SchemeValue>[],
    env: WalkEnv,
  ): number {
    const id = this.addNode({ kind: "mux", op: "cond", span: scopeId(expr), arms: clauses.length });
    let sel = 0;
    clauses.forEach((clause, k) => {
      const isElse = clause.car instanceof ASymbol && opName(clause.car) === "else";
      if (!isElse) this.emitWire(clause.car, { node: id, slot: `selector${sel++}` }, env);
      const body = chainOf(clause.cdr).filter((f) => !(f instanceof ASymbol && opName(f) === "=>"));
      // Arm value: the last body form; a `(test)` clause's value is the test itself.
      // (A `=>` clause's receiver is approximated as the arm — its applied-to-test
      // threading is classifyCond's `combine("=>")`, deferred here.)
      const arm = body.length > 0 ? body[body.length - 1] : clause.car;
      for (const dropped of body.slice(0, -1)) this.walkForCuts(dropped, env);
      this.emitWire(arm, { node: id, slot: `arm${k}` }, env);
    });
    return id;
  }

  /** A fan instantiation point = region host (I5: ONE node from G; the callback
   *  body's wireframe is the region's PRIVATE template interior). */
  private buildFan(expr: APair<SchemeValue, SchemeValue>, op: string, env: WalkEnv): number {
    const args = operands(expr);
    const fn = args[0];
    // Mirrors lineage.ts's fan arm: map/vector-map preserve length; filter does not.
    const lengthPreserving = op === "map" || op === "vector-map";
    let template: WireframeGraph | undefined;
    let elementParams: string[] | undefined;
    let fnOp: string | undefined;
    if (fn instanceof APair && fn.car instanceof ASymbol && opName(fn.car) === "lambda" && fn.cdr instanceof APair) {
      const params = lambdaParams(fn.cdr.car);
      const interior = new GraphBuilder(this.bctx);
      const intSubst = new Map(env.subst);
      for (const p of params) intSubst.set(p, LEAF(p));
      // frames: [] — a template wire's slot params beyond `elementParams` are
      // region CAPTURES by name (sealed at region open, I2); an enclosing let
      // binding is a capture from the region's view, never an inlined frame.
      const intEnv: WalkEnv = { subst: intSubst, frames: [] };
      const bodyForms = chainOf(fn.cdr.cdr);
      for (const dropped of bodyForms.slice(0, -1)) interior.walkDropped(dropped, intEnv);
      if (bodyForms.length > 0) interior.emitEgress(bodyForms[bodyForms.length - 1], intEnv);
      template = interior.finish();
      elementParams = params;
    } else if (fn instanceof ASymbol) {
      fnOp = opName(fn);
    } else if (fn !== undefined) {
      this.walkForCuts(fn, env); // computed callback — designated subterms still land
    }
    const roles = this.bctx.callbackRolesOf?.(op);
    const id = this.addNode({
      kind: "fan",
      op,
      span: scopeId(expr),
      lengthPreserving,
      ...(template !== undefined ? { template } : {}),
      ...(elementParams !== undefined ? { elementParams } : {}),
      ...(fnOp !== undefined ? { fnOp } : {}),
      ...(roles !== undefined ? { callbackRoles: roles } : {}),
    });
    // The fanned container(s): (map f xs) → slot "source"; (map f xs ys) → +"source1".
    args.slice(1).forEach((a, i) => this.emitWire(a, { node: id, slot: i === 0 ? "source" : `source${i}` }, env));
    return id;
  }

  /** Named let → `binder{cycles}` with a REAL interior (Q8a′, §1: "loop
   *  variables wired from the body's recur-position egress back to the
   *  binder's params"). `(let loop ((v init)…) body…)`: the body wireframes
   *  as the loop's own PRIVATE graph (Q8a's I5 pattern — its own
   *  `GraphBuilder`, never spliced into `this`), `v…` bound as per-iteration
   *  LEAF slots (extending the OUTER subst, exactly like `buildFan`'s
   *  `intSubst` — a captured outer binding must stay visible for selector-
   *  cone reachability, e.g. a captured threshold that's itself a source);
   *  a call to `loop` anywhere in the body is the BACKEDGE (a `recur` node,
   *  intercepted in `walkForCuts`), never a value escaping the loop. The
   *  INIT values are ORDINARY ingress wires from the OUTER scope — a named
   *  let's bindings, like a plain let's, evaluate in the enclosing scope. */
  private buildNamedLetBinder(
    expr: APair<SchemeValue, SchemeValue>,
    rest: APair<SchemeValue, SchemeValue>,
    env: WalkEnv,
  ): number {
    const loopName = opName(rest.car);
    const afterName = rest.cdr;
    const entries = afterName instanceof APair ? letEntries(afterName.car) : [];
    const bodyForms = afterName instanceof APair ? chainOf(afterName.cdr) : [];
    const params = entries.map((e) => e.name);

    const interior = new GraphBuilder(this.bctx);
    const intSubst = new Map(env.subst);
    for (const p of params) intSubst.set(p, LEAF(p));
    const intEnv: WalkEnv = { subst: intSubst, frames: [], recur: { name: loopName } };
    for (const dropped of bodyForms.slice(0, -1)) interior.walkDropped(dropped, intEnv);
    if (bodyForms.length > 0) interior.emitEgress(bodyForms[bodyForms.length - 1], intEnv);

    const id = this.addNode({
      kind: "binder",
      op: "named-let",
      span: scopeId(expr),
      cycles: true,
      params,
      interior: interior.finish(),
    });
    entries.forEach((e, i) => this.emitWire(e.rhs, { node: id, slot: `arg${i}` }, env));
    return id;
  }

  /** `do` → `binder{cycles}` with a REAL interior (Q8a′). `(do ((var init
   *  step?)…) (test result…) body…)`: `var…` bound as per-iteration LEAF
   *  slots (extending the outer subst, same rationale as named-let above);
   *  `body…` walks value-dropped (side effects only — its ports still land,
   *  §1 D6-style); `test` likewise value-dropped: its ports still land (I1
   *  confinement reads their cone regardless), though no wire consumes a
   *  VALUE from it — `do` isn't shaped as an `if`, so no mux models the
   *  continue/stop choice here. Accepted precision LIMIT, not a correctness
   *  gap: the plan's hard-gate concern is a template referent existing
   *  before emission, not the continue/stop decision's runtime-recordability
   *  (that is exactly the kind of precision Q9's agreement corpus re-audits).
   *  The step expressions are the BACKEDGE (one `recur` node — R7RS: an
   *  omitted step defaults to the var's own current binding, carried over
   *  unchanged; `parseDoBindings` already encodes that default). `result…`
   *  is the TERMINAL egress — the value(s) when the loop stops.
   *
   *  Q9 finding 4 fix: `result…`'s occurrences of a loop variable name the
   *  SAME identifier the step clause rebinds every iteration — R7RS reads
   *  `result…` in a scope where the vars are bound to their LATEST value,
   *  i.e. whatever the backedge (the `recur` node below) fed them. Named-let
   *  gets this for free because its tail position IS the literal recursive
   *  call — the cut-and-close walk designates that call a `recur` NODE, and
   *  ordinary reachability walks through it. `do` has no such syntactic call
   *  in result position to intercept, so the equivalent wiring is synthesized
   *  here: `result…` walks under an EXTRA synthetic `let` frame that rebinds
   *  every loop variable to one shared cut sentinel pre-registered straight
   *  to the `recur` node's id — mirroring `unevalWire`'s own let-frame
   *  rewrap, so e.g. the egress wire reads `(let ((acc in0)) acc)` with
   *  `in0` a NODE paramRef into `recur`, putting everything the step
   *  expressions reach back in the result's cone. `body…`/`test` are
   *  UNCHANGED (still plain per-iteration LEAF slots) — only the result
   *  clause's variable scope changes. */
  private buildDoBinder(expr: APair<SchemeValue, SchemeValue>, env: WalkEnv): number {
    const rest = expr.cdr;
    const bindings = rest instanceof APair ? parseDoBindings(rest.car) : [];
    const afterBindings = rest instanceof APair ? rest.cdr : undefined;
    const clause = afterBindings instanceof APair ? parseDoClause(afterBindings.car) : parseDoClause(undefined);
    const bodyForms = afterBindings instanceof APair ? chainOf(afterBindings.cdr) : [];
    const params = bindings.map((b) => b.name);

    const interior = new GraphBuilder(this.bctx);
    const intSubst = new Map(env.subst);
    for (const p of params) intSubst.set(p, LEAF(p));
    const intEnv: WalkEnv = { subst: intSubst, frames: [] };
    for (const cmd of bodyForms) interior.walkDropped(cmd, intEnv);
    if (clause.test !== undefined) interior.walkDropped(clause.test, intEnv);
    const recurId = interior.addRecur(
      scopeId(expr),
      bindings.map((b) => b.step),
      intEnv,
    );
    if (clause.resultForms.length > 0) {
      const recurSentinel: unknown = {};
      interior.cuts.set(recurSentinel, recurId);
      const resultFrame: WireFrame = {
        kind: "let",
        entries: bindings.map((b): WireFrameEntry => ({ name: b.name, rhs: recurSentinel })),
      };
      const resultEnv: WalkEnv = { subst: intSubst, frames: [resultFrame] };
      for (const dropped of clause.resultForms.slice(0, -1)) interior.walkDropped(dropped, resultEnv);
      interior.emitEgress(clause.resultForms[clause.resultForms.length - 1], resultEnv);
    }

    const id = this.addNode({
      kind: "binder",
      op: "do",
      span: scopeId(expr),
      cycles: true,
      params,
      interior: interior.finish(),
    });
    bindings.forEach((b, i) => this.emitWire(b.init, { node: id, slot: `arg${i}` }, env));
    return id;
  }

  /** The loop's BACKEDGE (Q8a′): a `recur` node whose ingress wires
   *  (`arg0..argN`, positional with the ENCLOSING binder's `params`) are the
   *  next-iteration values — never `this.egress` (a recur never escapes the
   *  loop). `do`'s recur has no syntactic call site (unlike named-let's
   *  `(loop args…)`, intercepted in `walkForCuts`), so `buildDoBinder` calls
   *  this directly with the step expressions. */
  private addRecur(span: string, args: readonly unknown[], env: WalkEnv): number {
    const id = this.addNode({ kind: "recur", span });
    args.forEach((a, i) => this.emitWire(a, { node: id, slot: `arg${i}` }, env));
    return id;
  }
}

/** Extract a wireframe-material define's formals + body forms. Handles
 *  `(define (name . formals) body…)` and `(define name (lambda formals body…))`;
 *  a value define with a non-lambda RHS is a zero-param template over its RHS. */
function defineShape(form: APair<SchemeValue, SchemeValue>): { params: string[]; bodyForms: unknown[] } {
  const rest = form.cdr;
  if (!(rest instanceof APair)) return { params: [], bodyForms: [] }; // malformed — defineNameOf-guarded upstream
  const target = rest.car;
  if (target instanceof APair) return { params: lambdaParams(target.cdr), bodyForms: chainOf(rest.cdr) };
  const rhs = rest.cdr instanceof APair ? rest.cdr.car : undefined;
  if (rhs instanceof APair && rhs.car instanceof ASymbol && opName(rhs.car) === "lambda" && rhs.cdr instanceof APair) {
    return { params: lambdaParams(rhs.cdr.car), bodyForms: chainOf(rhs.cdr.cdr) };
  }
  return { params: [], bodyForms: rhs === undefined ? [] : [rhs] };
}

/**
 * Build the whole-program prospective layer (§1): partition top-level defines via
 * Q7's prelude classifier, wireframe each PORT-REACHING define into a named
 * template, and wireframe the main (non-define) forms — the last one's value flows
 * to the out-port; earlier ones walk value-dropped (their ports still land).
 */
export function buildWireframe(forms: readonly SchemeValue[], opts: WireframeBuildOptions): WireframeProgram {
  const membership = classifyProgramPrelude(forms, opts.classifier);
  const preludeSource = buildPreludeSource(forms, membership);
  const bctx: BuildCtx = {
    classifier: opts.classifier,
    reachClassifier: {
      roleOf: (op) => (membership.wireframe.has(op) ? "opaque" : opts.classifier.roleOf(op)),
    },
    preludeNames: membership.pure,
    materialNames: membership.wireframe,
    isBaseName: opts.isBaseName,
    ...(opts.callbackRolesOf !== undefined ? { callbackRolesOf: opts.callbackRolesOf } : {}),
  };

  const templates = new Map<string, DefineTemplate>();
  for (const form of forms) {
    const name = defineNameOf(form);
    if (name === null || !membership.wireframe.has(name) || !(form instanceof APair)) continue;
    const { params, bodyForms } = defineShape(form);
    const g = new GraphBuilder(bctx);
    const subst = new Map<string, LineageNode>(params.map((p) => [p, LEAF(p)]));
    const env: WalkEnv = { subst, frames: [] };
    for (const dropped of bodyForms.slice(0, -1)) g.walkDropped(dropped, env);
    if (bodyForms.length > 0) g.emitEgress(bodyForms[bodyForms.length - 1], env);
    templates.set(name, { params, graph: g.finish() });
  }

  const mainForms = forms.filter((f) => defineNameOf(f) === null);
  const main = new GraphBuilder(bctx);
  const rootEnv: WalkEnv = { subst: new Map(), frames: [] };
  mainForms.forEach((form, i) => {
    if (i < mainForms.length - 1) main.walkDropped(form, rootEnv);
    else main.emitEgress(form, rootEnv);
  });

  return {
    prelude: { names: membership.pure, source: preludeSource },
    membership,
    templates,
    main: main.finish(),
  };
}
