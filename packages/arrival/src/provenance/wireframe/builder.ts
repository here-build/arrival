/**
 * Whole-program prospective wireframe — `classify` generalized over top-level
 * defines + main expression.
 *
 * CUT-AND-CLOSE. Designated subterms (membrane ports, port-coupled muxes, fan
 * instantiation, binders, port-reaching define calls) become NODES; maximal pure
 * residue becomes ONE wire via `unevalWire` (params = ingress). Wire purity is by
 * construction — ports break segments; a wire body has no source/sink/port-mux.
 *
 * SELECTOR-CONE (owned here; classifier supplies roles only). Mux is port-coupled
 * iff `reachesPort(classify(selector, reachClassifier, subst))`:
 *   - `subst` = builder let-walk (couples through bindings)
 *   - field arm descends focused child only (`(:flag (src))` couples; plain slot does not)
 *   - port-reaching defines lower to `opaque` (transitive coupling)
 * Pure-selector mux collapses into its wire ONLY when its arms are cut-free (γ resolves a
 * wire's node params eagerly — an arm with a port / template-ref would be demanded even when
 * untaken: unrecorded or non-terminating); both arms' FV still ingress (precision trade —
 * do not "fix" by re-recording). `cond`/`case` and short-circuit `and`/`or` follow the same
 * rule (`case` lowers to cond-style `selector{k}` tests; `and`/`or` to selector = first operand,
 * arm = the rest).
 *
 * VALUE DEFINES (`(define plan (src-a 1))`): not templates — walked in main as a growing
 * `let*` frame, pruned per wire to the entries it reaches. SURFACE: bracket bindings/clauses
 * and `[…]`/`{…}` literals are evaluated forms (`../surface.js`); bare role names are cut per
 * OCCURRENCE (operand cell), not per interned symbol.
 *
 * I5: fan is one region host in G; callback wireframe is private `template`
 * (replayed on demand). Field-demand at region boundary → replay, not records.
 *
 * LOOPS (`loops.ts`): binder{cycles} get private GraphBuilder interiors. named-let
 * self-call / do steps are BACKEDGE `recur` (next-iteration params; binder ingress
 * = initials only). Declared loop-role with no recursive shape → empty interior.
 * letrec-bound closure under-designates call-site mux (classify never expands
 * callees); port still cut so replay cone is sound.
 *
 * STRUCT-FACT: `factTagOf` tags whole-body `(length|vector-length|string-length p)`
 * as one term `length` on `Wire.fact` — not a second edge species. Count-demand
 * routes through fact wires only (`reachableNodesForDemand` in loops.ts).
 *
 * CLOSURE NODES (P17). Every callable VALUE that reaches wire space and is not a prelude/base
 * name is a `closure` node: a lambda literal (private `template` interior, I5), a material
 * define used as a value (`ref: define`), or a bare port-role name used as a value
 * (`ref: port`). Free lexical variables of an interior (closure / fan / loop) are CAPTURES:
 * one `capture:<name>` wire each in the ENCLOSING graph, emitted DEFERRED in `finish()` so a
 * letrec sibling is already a cut (soundness: a capture wire never inlines a lambda's source).
 * A cut-free (pure) lambda stays wire material, like a pure-selector mux. Alias chasing is a
 * graph edge: `(let ((g src-a)) (g 1))` — `g`'s wire consumes the `closure{ref:port}` node.
 * Calls stay wire material (γ applies the value); `(helper …)` → template-ref and `(loop …)`
 * → recur are the only syntactic call cuts.
 *
 * SITE TOTALITY. Every bare-name cut is keyed by the cons CELL holding the occurrence. LIMIT:
 * `[…]`/`{…}` literal elements and bracket binding entries have no cell — a bare role name
 * there is keyed by its interned symbol (duplicates in ONE graph share a node).
 */
import type { SchemeValue } from "../../values/types.js";
import { APair } from "../../values/primitives/APair.js";
import { ASymbol } from "../../values/primitives/ASymbol.js";
import { schemeFalse, schemeTrue } from "../../values/primitives/ABool.js";
import { nil } from "../../values/primitives/ANil.js";
import { EMPTY_PROVENANCE } from "../../values/primitives/AValue.js";
import { classify, type Classifier, type LineageNode, type Subst } from "../lineage.js";
import type { CallbackRoles } from "../../common/symbols/_bake.js";
import { classifyProgramPrelude, buildPreludeSource, reachesPort } from "../prelude.js";
import { defineNameOf, referencedSymbols } from "../slice.js";
import { scopeId } from "../scope-id.js";
import { unevalWire } from "../uneval.js";
import { freeVars } from "./free-vars.js";
import { bindingEntries, clauseElements, literalElements } from "../surface.js";
import { hashGraph } from "./hash.js";
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

/** Structural-fact surface ops → one term `length` (not per-spelling tags). */
const FACT_VERBS: ReadonlySet<string> = new Set(["length", "vector-length", "string-length"]);

export interface WireframeBuildOptions {
  /** Declaration-driven role read (`.provenanceRole`). */
  readonly classifier: Classifier;
  /** Resolvable in hermetic base env? Production: sealed base chain; tests: a set. */
  readonly isBaseName: (name: string) => boolean;
  /** Host-verb callback roles — stamped on fan nodes, not used for designation. */
  readonly callbackRolesOf?: (op: string) => CallbackRoles | undefined;
}

interface BuildCtx {
  readonly classifier: Classifier;
  /** Port-reaching defines → opaque for transitive selector coupling. */
  readonly reachClassifier: Classifier;
  readonly preludeNames: ReadonlySet<string>;
  readonly materialNames: ReadonlySet<string>;
  /** Formals of each material FUNCTION define (a `closure{ref:define}` node's `params`). */
  readonly defineParams: ReadonlyMap<string, readonly string[]>;
  readonly isBaseName: (name: string) => boolean;
  /** Collected across every builder: lambda body list (pair identity) → closure site (emission). */
  readonly closureSites: Map<object, { templateHash: string; rootOrdinal: number }>;
  readonly callbackRolesOf?: (op: string) => CallbackRoles | undefined;
}

/** Lexical walk context: subst (let transparency) + frames for unevalWire rewrap. */
interface WalkEnv {
  readonly subst: Subst;
  readonly frames: readonly WireFrame[];
  /** Innermost loop's recur name; a call is BACKEDGE. Fresh env (no recur) inside fan templates. */
  readonly recur?: { readonly name: string };
}

// Local surface helpers (lineage keeps private copies of the same shapes).

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

/** Lambda formals including dotted rest. */
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

/** One element position of a form: the value, the cons cell HOLDING it, and the form it sits
 *  under. A bare-name cut is keyed by the cell (unique per parent + operand index) — the
 *  interned symbol itself cannot distinguish occurrences. */
interface Site {
  readonly value: unknown;
  readonly cell: APair<SchemeValue, SchemeValue>;
  readonly parent: unknown;
}

/** A synthetic site for a position with no real cons cell of its own (a synthesized form, a
 *  bracket clause part, a top-level form). Its fresh cell is never found inside any wire body, so
 *  it only matters for a wire whose ENTIRE body is the held value (`exprCell`). */
const holder = (value: unknown, parent: unknown): Site => ({
  value,
  cell: new APair(value as SchemeValue, nil),
  parent,
});

/** Lambda formals split into positional params and the dotted/bare rest formal. */
function lambdaFormals(formals: unknown): { params: string[]; rest?: string } {
  const params: string[] = [];
  let n: unknown = formals;
  while (n instanceof APair) {
    if (n.car instanceof ASymbol) params.push(opName(n.car));
    n = n.cdr;
  }
  return n instanceof ASymbol ? { params, rest: opName(n) } : { params };
}

/** Free lexical variables of a private interior graph: slot params that are not its own formals,
 *  first-encounter order. Nested interiors already resolved their captures to wires IN `graph`. */
function captureNames(graph: WireframeGraph, formals: readonly string[]): string[] {
  const bound = new Set(formals);
  const out = new Set<string>();
  for (const w of graph.wires) {
    for (const ref of w.paramRefs) if (ref.kind === "slot" && !bound.has(ref.name)) out.add(ref.name);
  }
  return [...out];
}

/** Sites of a pair chain starting at `list` (e.g. an application's `cdr`), under `parent`. */
function sitesOf(parent: unknown, list: unknown): Site[] {
  const out: Site[] = [];
  let cur: unknown = list;
  while (cur instanceof APair) {
    out.push({ value: cur.car, cell: cur, parent });
    cur = cur.cdr;
  }
  return out;
}

const LEAF = (slot: string): LineageNode => ({ kind: "leaf", slot });

/** Empty interior for declared-loop role with no known recursive shape. */
const EMPTY_GRAPH: WireframeGraph = { nodes: [], wires: [], egress: null };

/** One let-family binding with the site of its RHS (null for bracket entries — no cons cell). */
interface LetEntry {
  readonly name: string;
  readonly rhs: unknown;
  readonly site: Site | null;
}

/** Let-family binding list, bracket surfaces included (`normalizeBindings`' twin). */
function letEntries(bindings: unknown, parent: unknown): LetEntry[] {
  return bindingEntries(bindings).map((b) => {
    const cell = b.cells?.[0];
    return {
      name: b.name,
      rhs: b.rest[0],
      site: cell instanceof APair ? { value: b.rest[0], cell, parent } : null,
    };
  });
}

const frameEntry = (e: LetEntry): WireFrameEntry => ({
  name: e.name,
  rhs: e.rhs,
  ...(e.site === null ? {} : { cell: e.site.cell }),
});

/** Synthetic proper list from parts (selector/arm expressions the surface never spelled). */
function listOf(...items: unknown[]): unknown {
  let out: unknown = nil;
  for (let i = items.length - 1; i >= 0; i--) out = new APair(items[i] as SchemeValue, out as SchemeValue);
  return out;
}
const sym = (name: string): ASymbol => new ASymbol(name);

/** One `case` clause: datum list (or `else`), body forms. */
interface CaseClause {
  readonly datums: unknown;
  readonly isElse: boolean;
  readonly body: readonly unknown[];
  readonly bodySites: readonly Site[];
}

/** One `cond` clause as test + body forms (bracket clauses read like paren ones). */
interface CondClause {
  readonly test: unknown;
  readonly testSite: Site;
  readonly isElse: boolean;
  /** `(test => proc)`: `body` is `[proc]` and the arm is `(proc test)`. */
  readonly arrow: boolean;
  readonly body: readonly unknown[];
  readonly bodySites: readonly Site[];
}

function chainOf(n: unknown): unknown[] {
  const out: unknown[] = [];
  let cur: unknown = n;
  while (cur instanceof APair) {
    out.push(cur.car);
    cur = cur.cdr;
  }
  return out;
}

/** One graph under construction. Region interiors own a separate GraphBuilder (I5). */
class GraphBuilder {
  private readonly nodes: WireframeNode[] = [];
  private readonly wires: Wire[] = [];
  /** Surface subterm → node id (shared across wires in this graph). */
  private readonly cuts = new Map<unknown, number>();
  /** Bare-name cuts per OCCURRENCE: operand cons cell → node id (W-7). */
  private readonly occurrenceCuts = new Map<unknown, number>();
  /** Cut → node INPUT slot it denotes (`do` result clause: loop var K = recur `argK`). */
  private readonly cutSlots = new Map<unknown, string>();
  /** Synthetic selector forms (`(case KEY …)` per-clause tests) that must NOT re-mux. */
  private readonly noMux = new WeakSet<object>();
  /** Lambda forms whose interior built cut-free: they stay wire material (like a pure mux). */
  private readonly pureLambdas = new WeakSet<object>();
  /** Bracket clauses have no cons cells: one stable synthetic site list per clause object. */
  private readonly synthClauseSites = new WeakMap<object, Site[]>();
  /** Closure/fan/binder captures awaiting their `capture:<name>` wires — flushed in `finish()`
   *  so every sibling (letrec) is already a cut when the capture's lexical frame is written. */
  private readonly pendingCaptures: { node: number; names: readonly string[]; env: WalkEnv; span: string }[] = [];
  private egress: number | null = null;
  /** Main-only: the growing top-level frame of material VALUE defines (W-P2). Re-wrapped
   *  around each wire PRUNED to the entries that wire actually needs (transitively). */
  rootFrame?: WireFrame;

  constructor(private readonly bctx: BuildCtx) {}

  finish(): WireframeGraph {
    for (const p of this.pendingCaptures.splice(0)) {
      for (const name of p.names) {
        const symbol = sym(name);
        this.emitWire(
          symbol,
          { node: p.node, slot: `capture:${name}` },
          p.env,
          holder(symbol, symbol),
          `${p.span}#capture:${name}`,
        );
      }
    }
    return { nodes: this.nodes, wires: this.wires, egress: this.egress };
  }

  private addNode(node: WireframeNode): number {
    this.nodes.push(node);
    return this.nodes.length - 1;
  }

  /** Designated nodes land; pure residue emits no wire (value-dropped form). */
  walkDropped(site: Site, env: WalkEnv): void {
    this.walkForCuts(site.value, env, site);
  }

  /** Value expression → out-port + egress wire. Pure sink leaves egress null. */
  emitEgress(site: Site, env: WalkEnv, span?: string): void {
    const expr = site.value;
    this.walkForCuts(expr, env, site);
    const cutId = this.cuts.get(expr);
    if (cutId !== undefined && this.nodes[cutId].kind === "sink") return;
    const out = this.addNode({ kind: "port", direction: "out", span: span ?? scopeId(expr) });
    this.egress = out;
    this.emitWire(expr, { node: out, slot: "out" }, env, site, span);
  }

  /**
   * A body: leading/inline internal defines become ONE `letrec*` frame (R7RS body scope — every
   * define visible everywhere in the body, so a closure's capture of a sibling resolves), the
   * remaining forms walk under it; the last is the egress (or value-dropped).
   */
  walkBody(sites: readonly Site[], env: WalkEnv, tail: "egress" | "dropped", span?: string): void {
    const { env: bodyEnv, forms } = this.enterBody(sites, env);
    for (const f of forms.slice(0, -1)) this.walkDropped(f, bodyEnv);
    const last = forms.at(-1);
    if (last === undefined) return;
    if (tail === "egress") this.emitEgress(last, bodyEnv, span);
    else this.walkDropped(last, bodyEnv);
  }

  private enterBody(sites: readonly Site[], env: WalkEnv): { env: WalkEnv; forms: Site[] } {
    const defs: { name: string; rhs: unknown; site: Site }[] = [];
    const forms: Site[] = [];
    for (const s of sites) {
      const d = this.internalDefine(s.value, env);
      if (d === undefined) forms.push(s);
      else defs.push(d);
    }
    if (defs.length === 0) return { env, forms };
    const subst = new Map(env.subst);
    for (const d of defs) subst.set(d.name, LEAF(d.name));
    const frame: WireFrame = {
      kind: "letrec*",
      entries: defs.map((d) => ({ name: d.name, rhs: d.rhs, cell: d.site.cell })),
    };
    const defEnv: WalkEnv = { subst, frames: [...env.frames, frame], recur: env.recur };
    for (const d of defs) {
      this.walkForCuts(d.rhs, defEnv, d.site);
      subst.set(d.name, classify(d.rhs as SchemeValue, this.bctx.reachClassifier, subst));
    }
    return { env: defEnv, forms };
  }

  /** `(define (g x) …)` / `(define g rhs)` as a body-level binding: function forms become the
   *  equivalent `(lambda (x) …)` (letrec* RHS), so the lambda is cut to a closure like any other. */
  private internalDefine(form: unknown, env: WalkEnv): { name: string; rhs: unknown; site: Site } | undefined {
    if (!(form instanceof APair) || !(form.car instanceof ASymbol) || opName(form.car) !== "define") return undefined;
    if (env.subst.has("define")) return undefined;
    const rest = form.cdr;
    if (!(rest instanceof APair)) return undefined;
    const target = rest.car;
    if (target instanceof APair && target.car instanceof ASymbol) {
      const lam = new APair(sym("lambda"), new APair(target.cdr, rest.cdr), EMPTY_PROVENANCE, form.location);
      return { name: opName(target.car), rhs: lam, site: holder(lam, form) };
    }
    if (target instanceof ASymbol && rest.cdr instanceof APair) {
      return { name: opName(target), rhs: rest.cdr.car, site: { value: rest.cdr.car, cell: rest.cdr, parent: form } };
    }
    return undefined;
  }

  private emitWire(expr: unknown, consumer: WireConsumer, env: WalkEnv, site: Site, span?: string): void {
    this.walkForCuts(expr, env, site);
    // A body with no span of its own (a bare symbol/literal operand) takes its parent form's.
    const wireSpan = span ?? (expr instanceof APair ? undefined : scopeId(site.parent));
    const emitted = unevalWire({
      expr,
      ...(wireSpan === undefined ? {} : { span: wireSpan }),
      cutSlots: this.cutSlots,
      occurrenceCuts: this.occurrenceCuts,
      exprCell: site.cell,
      frames: this.pruneRootFrame(expr, env.frames, site),
      cuts: this.cuts,
      preludeNames: this.bctx.preludeNames,
      materialNames: this.bctx.materialNames,
      isBaseName: this.bctx.isBaseName,
    });
    const fact = this.factTagOf(expr, env);
    this.wires.push({
      ...emitted,
      consumer,
      // eslint-disable-next-line unicorn/no-negated-condition -- omit fact when the expr has none
      ...(fact !== undefined ? { fact } : {}),
    });
  }

  /**
   * Drop root-frame entries (material value defines) the wire does not reach: a wire that
   * never names `plan` must not inherit `plan`'s port as ingress (over-attribution), and
   * entries are kept transitively (a kept entry's RHS may name an earlier one — `let*`).
   */
  private pruneRootFrame(expr: unknown, frames: readonly WireFrame[], site?: Site): readonly WireFrame[] {
    const root = this.rootFrame;
    if (root === undefined || !frames.includes(root)) return frames;
    const opts = { cuts: this.cuts, occurrenceCuts: this.occurrenceCuts };
    const need = freeVars(expr, { ...opts, formCell: site?.cell });
    for (const f of frames) {
      if (f === root) continue;
      for (const en of f.entries) for (const n of freeVars(en.rhs, { ...opts, formCell: en.cell })) need.add(n);
    }
    const kept: WireFrameEntry[] = [];
    for (let i = root.entries.length - 1; i >= 0; i--) {
      const en = root.entries[i];
      if (!need.has(en.name)) continue;
      need.delete(en.name);
      for (const n of freeVars(en.rhs, { ...opts, formCell: en.cell })) need.add(n);
      kept.unshift(en);
    }
    return frames.map((f) => (f === root ? { kind: root.kind, entries: kept } : f)).filter((f) => f.entries.length > 0);
  }

  /**
   * Tag whole-body structural-fact reads only. Guards (match unevalWire FV order):
   * local shadow / material define / non-base name → never tag.
   * Nested `(+ 1 (length xs))` not tagged — keeps count-demand routing exact.
   */
  private factTagOf(expr: unknown, env: WalkEnv): WireFact | undefined {
    if (!(expr instanceof APair) || !(expr.car instanceof ASymbol)) return undefined;
    const op = opName(expr.car);
    if (env.subst.has(op) || !FACT_VERBS.has(op)) return undefined;
    if (this.bctx.materialNames.has(op) || !this.bctx.isBaseName(op)) return undefined;
    if (operands(expr as APair<SchemeValue, SchemeValue>).length !== 1) return undefined;
    return { kind: "fact", verb: "length" };
  }

  /** Did walking land a VALUE-producing node since `before`? A `recur` is a loop backedge, not
   *  a value γ could demand (loop interiors replay via playback), so it does not force a mux. */
  private cutsSince(before: number): boolean {
    return this.nodes.slice(before).some((n) => n.kind !== "recur");
  }

  private selectorReachesPort(selector: unknown, env: WalkEnv): boolean {
    return reachesPort(classify(selector as SchemeValue, this.bctx.reachClassifier, env.subst));
  }

  /** Element sites of a `cond`/`case`/`guard` clause: real cells for a paren clause, one stable
   *  synthetic list per bracket clause. */
  private clauseSites(raw: unknown): Site[] | undefined {
    if (raw instanceof APair) return sitesOf(raw, raw);
    if (raw === null || typeof raw !== "object") return undefined;
    const cached = this.synthClauseSites.get(raw);
    if (cached !== undefined) return cached;
    const els = clauseElements(raw);
    if (els === undefined) return undefined;
    const out = els.map((v) => holder(v, raw));
    this.synthClauseSites.set(raw, out);
    return out;
  }

  private condClausesOf(rest: unknown): CondClause[] {
    const out: CondClause[] = [];
    for (const raw of chainOf(rest)) {
      const sites = this.clauseSites(raw);
      if (sites === undefined || sites.length === 0) continue;
      const arrow = sites[1]?.value instanceof ASymbol && opName(sites[1].value) === "=>";
      const bodySites = arrow ? sites.slice(2, 3) : sites.slice(1);
      out.push({
        test: sites[0].value,
        testSite: sites[0],
        isElse: sites[0].value instanceof ASymbol && opName(sites[0].value) === "else",
        arrow,
        body: bodySites.map((x) => x.value),
        bodySites,
      });
    }
    return out;
  }

  private caseClausesOf(rest: unknown): CaseClause[] {
    const out: CaseClause[] = [];
    for (const raw of chainOf(rest)) {
      const sites = this.clauseSites(raw);
      if (sites === undefined || sites.length === 0) continue;
      const bodySites = sites.slice(1);
      out.push({
        datums: sites[0].value,
        isElse: sites[0].value instanceof ASymbol && opName(sites[0].value) === "else",
        body: bodySites.map((x) => x.value),
        bodySites,
      });
    }
    return out;
  }

  // ── designation walk ───────────────────────────────────────────────────────

  /** Build every designated subterm under `expr`; pure residue left for emitWire. `site` is the
   *  cons cell position holding `expr` — null only where no cell exists (`[…]`/`{…}` elements). */
  private walkForCuts(expr: unknown, env: WalkEnv, site: Site | null): void {
    if (this.cuts.has(expr)) return;
    if (site !== null && this.occurrenceCuts.has(site.cell)) return;
    // A bare name used as a VALUE: a material define / port-role name becomes a `closure` node at
    // the OCCURRENCE (a function value; applying it is the crossing). A loop name escaping as a
    // value degrades to `opaque` (LIMIT: loops are binders, not closures).
    if (expr instanceof ASymbol) {
      const name = opName(expr);
      if (env.subst.has(name)) return;
      const span = scopeId(site?.parent ?? expr);
      let node: WireframeNode | undefined;
      if (env.recur !== undefined && env.recur.name === name) {
        node = { kind: "opaque", op: name, span };
      } else if (this.bctx.materialNames.has(name)) {
        node = {
          kind: "closure",
          span,
          params: this.bctx.defineParams.get(name) ?? [],
          captures: [],
          ref: { kind: "define", name },
        };
      } else {
        const role = this.bctx.classifier.roleOf(name);
        if (role !== undefined && role !== "pipe") {
          node = { kind: "closure", span, params: [], captures: [], ref: { kind: "port", op: name, role } };
        }
      }
      if (node === undefined) return;
      const id = this.addNode(node);
      if (site === null) this.cuts.set(expr, id);
      else this.occurrenceCuts.set(site.cell, id);
      return;
    }
    if (!(expr instanceof APair)) {
      // `[…]` / `{…}` literals are EVALUATED — a port inside is a port (not quoted data).
      for (const el of literalElements(expr) ?? []) this.walkForCuts(el, env, null);
      return;
    }

    const head = expr.car;
    if (head instanceof ASymbol) {
      const form = opName(head);
      if (!env.subst.has(form)) {
        switch (form) {
          case "quote":
            return;
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
            // Pure-selector mux collapses into its wire ONLY when no arm contains a cut: γ
            // resolves a wire's node params eagerly, so a cut inside an untaken arm (a port, or
            // a recursive template-ref) would be demanded anyway — unrecorded (sentinel) or
            // non-terminating. Arms with cuts stay lazy as a mux.
            this.walkForCuts(test, env, { value: test, cell: rest, parent: expr });
            const before = this.nodes.length;
            for (const arm of sitesOf(expr, rest.cdr)) this.walkForCuts(arm.value, env, arm);
            if (this.cutsSince(before)) this.cuts.set(expr, this.buildMux(expr, rest, form, env));
            return;
          }
          case "cond": {
            const clauses = this.condClausesOf(expr.cdr);
            const coupled = clauses.some((c) => !c.isElse && this.selectorReachesPort(c.test, env));
            if (coupled) {
              this.cuts.set(expr, this.buildCondMux(expr, clauses, env));
              return;
            }
            // Pure selectors: collapse only when no clause body contains a cut (see `if`).
            for (const clause of clauses) if (!clause.isElse) this.walkForCuts(clause.test, env, clause.testSite);
            const before = this.nodes.length;
            for (const clause of clauses) for (const b of clause.bodySites) this.walkForCuts(b.value, env, b);
            if (this.cutsSince(before)) this.cuts.set(expr, this.buildCondMux(expr, clauses, env));
            return;
          }
          case "let":
          case "let*":
          case "letrec":
          case "letrec*":
            this.walkLet(expr, form as "let" | "let*" | "letrec" | "letrec*", env);
            return;
          case "do":
            this.cuts.set(expr, this.buildDoBinder(expr, env));
            return;
          case "guard": {
            // (guard (var clause…) body…): var is a LEAF inside the clauses only; the body runs in
            // the outer scope. With a designated subterm anywhere inside, the form is a `guard`
            // NODE (body eagerly demanded OUTSIDE a guard could never be caught); otherwise γ
            // evaluates the pure form natively as wire material.
            if (!this.mentionsDesignated(expr.cdr, env)) return;
            this.cuts.set(expr, this.buildGuard(expr, env));
            return;
          }
          case "try": {
            if (!this.mentionsDesignated(expr.cdr, env)) return;
            this.cuts.set(expr, this.buildTry(expr, env));
            return;
          }
          case "and":
          case "or": {
            // Short-circuit: a later operand runs only if the earlier ones allow. When a
            // non-last operand reaches a port, folding all operands into one wire would make
            // γ demand every port; stay lazy as a mux (selector = first operand, arm = the rest).
            const sites = sitesOf(expr, expr.cdr);
            if (sites.length > 1 && sites.slice(0, -1).some((o) => this.selectorReachesPort(o.value, env))) {
              this.cuts.set(expr, this.buildAndOrMux(expr, form, sites, env));
              return;
            }
            // Pure prefix: collapse only when no later operand contains a cut (see `if`).
            if (sites.length > 0) this.walkForCuts(sites[0].value, env, sites[0]);
            const before = this.nodes.length;
            for (const sub of sites.slice(1)) this.walkForCuts(sub.value, env, sub);
            if (sites.length > 1 && this.cutsSince(before)) {
              this.cuts.set(expr, this.buildAndOrMux(expr, form, sites, env));
            }
            return;
          }
          case "case": {
            const rest = expr.cdr;
            if (!(rest instanceof APair)) return;
            const key = rest.car;
            const keySite: Site = { value: key, cell: rest, parent: expr };
            const clauses = this.caseClausesOf(rest.cdr);
            if (!this.noMux.has(expr) && this.selectorReachesPort(key, env)) {
              this.cuts.set(expr, this.buildCaseMux(expr, keySite, clauses, env));
              return;
            }
            // Pure key: collapses into the wire unless a clause body holds a cut (see `if`).
            // Datum lists are DATA — never walked.
            this.walkForCuts(key, env, keySite);
            const before = this.nodes.length;
            for (const clause of clauses) for (const b of clause.bodySites) this.walkForCuts(b.value, env, b);
            if (!this.noMux.has(expr) && this.cutsSince(before)) {
              this.cuts.set(expr, this.buildCaseMux(expr, keySite, clauses, env));
            }
            return;
          }
          case "begin":
            for (const sub of sitesOf(expr, expr.cdr)) this.walkForCuts(sub.value, env, sub);
            return;
          case "lambda": {
            if (!(expr.cdr instanceof APair) || this.pureLambdas.has(expr)) return;
            const id = this.buildClosure(expr, expr.cdr, env);
            if (id === undefined) this.pureLambdas.add(expr);
            else this.cuts.set(expr, id);
            return;
          }
          case "define": {
            const rest = expr.cdr;
            if (!(rest instanceof APair)) return;
            const extended = new Map(env.subst);
            if (rest.car instanceof APair) for (const p of lambdaParams(rest.car.cdr)) extended.set(p, LEAF(p));
            const inner: WalkEnv = { subst: extended, frames: env.frames, recur: env.recur };
            for (const b of sitesOf(expr, rest.cdr)) this.walkForCuts(b.value, inner, b);
            return;
          }
          default:
            break;
        }
      }
    }

    if (head instanceof APair) {
      // Computed operator — walk head+args; call itself is wire material (HOF hole).
      this.walkForCuts(head, env, { value: head, cell: expr, parent: expr });
      for (const a of sitesOf(expr, expr.cdr)) this.walkForCuts(a.value, env, a);
      return;
    }
    if (!(head instanceof ASymbol)) {
      for (const a of sitesOf(expr, expr.cdr)) this.walkForCuts(a.value, env, a);
      return;
    }

    const op = opName(head);
    if (!env.subst.has(op)) {
      if (env.recur !== undefined && op === env.recur.name) {
        this.cuts.set(expr, this.buildArgNode({ kind: "recur", span: scopeId(expr) }, expr, env));
        return;
      }
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
          // No known recursive shape → empty interior; named-let/do get real ones.
          const id = this.buildArgNode(
            { kind: "binder", op, span: scopeId(expr), cycles: true, params: [], interior: EMPTY_GRAPH, captures: [] },
            expr,
            env,
          );
          this.cuts.set(expr, id);
          return;
        }
        default:
          break;
      }
    }
    for (const a of sitesOf(expr, expr.cdr)) this.walkForCuts(a.value, env, a);
  }

  /** Does `form` NAME anything designated (material define, non-pipe role, the loop name)?
   *  Structural over-approximation (shadowing ignored): a guard node around cut-free code is
   *  harmless, a collapsed guard around a port is unsound. */
  private mentionsDesignated(form: unknown, env: WalkEnv): boolean {
    for (const name of referencedSymbols(form)) {
      if (env.subst.has(name)) continue;
      if (this.bctx.materialNames.has(name) || env.recur?.name === name) return true;
      const role = this.bctx.classifier.roleOf(name);
      if (role !== undefined && role !== "pipe") return true;
    }
    return false;
  }

  /** Clause env: the condition variable resolves to THIS guard's caught condition — a sentinel
   *  cut with slot `condition`, exactly `buildDoBinder`'s result-clause mechanism. */
  private conditionEnv(id: number, varName: string, env: WalkEnv): WalkEnv {
    const sentinel: unknown = {};
    this.cuts.set(sentinel, id);
    this.cutSlots.set(sentinel, "condition");
    const subst = new Map(env.subst);
    subst.set(varName, LEAF(varName));
    return {
      subst,
      frames: [...env.frames, { kind: "let", entries: [{ name: varName, rhs: sentinel }] }],
      recur: env.recur,
    };
  }

  /** `(guard (e clause…) body…)` → guard node: `body` wire, then `selector{k}`/`arm{k}` per clause
   *  (else arm last, no selector), `=>` arm = `(proc e)`. */
  private buildGuard(expr: APair<SchemeValue, SchemeValue>, env: WalkEnv): number {
    const rest = expr.cdr as APair<SchemeValue, SchemeValue>;
    const spec = rest.car;
    const varName = spec instanceof APair && spec.car instanceof ASymbol ? opName(spec.car) : "__condition";
    const clauses = spec instanceof APair ? this.condClausesOf(spec.cdr) : [];
    const id = this.addNode({
      kind: "guard",
      op: "guard",
      span: scopeId(expr),
      var: varName,
      clauses: clauses.length,
      hasFinally: false,
    });
    const bodyExpr = new APair(sym("begin"), rest.cdr, EMPTY_PROVENANCE, expr.location);
    this.emitWire(bodyExpr, { node: id, slot: "body" }, env, holder(bodyExpr, expr));
    this.emitClauses(id, clauses, this.conditionEnv(id, varName, env), expr, varName);
    return id;
  }

  private emitClauses(
    id: number,
    clauses: readonly CondClause[],
    clauseEnv: WalkEnv,
    expr: APair<SchemeValue, SchemeValue>,
    varName: string,
  ): void {
    let sel = 0;
    clauses.forEach((clause, k) => {
      if (!clause.isElse)
        this.emitWire(clause.test, { node: id, slot: `selector${sel++}` }, clauseEnv, clause.testSite);
      for (const dropped of clause.arrow ? [] : clause.bodySites.slice(0, -1)) {
        this.walkForCuts(dropped.value, clauseEnv, dropped);
      }
      const armSite = clause.arrow
        ? holder(listOf(clause.body[0], sym(varName)), expr)
        : (clause.bodySites.at(-1) ?? clause.testSite);
      this.emitWire(armSite.value, { node: id, slot: `arm${k}` }, clauseEnv, armSite);
    });
  }

  /** `(try body (catch (e) handler…) (finally f…))` lowers to the same node: one `#t` clause whose
   *  arm is the handler body; `finally` forms are value-dropped walks (their ports still land). */
  private buildTry(expr: APair<SchemeValue, SchemeValue>, env: WalkEnv): number {
    const rest = expr.cdr as APair<SchemeValue, SchemeValue>;
    const parts = sitesOf(expr, rest);
    const isMarker = (s: Site, name: string): s is Site & { value: APair<SchemeValue, SchemeValue> } =>
      s.value instanceof APair && s.value.car instanceof ASymbol && opName(s.value.car) === name;
    const catchSite = parts.find((s) => isMarker(s, "catch"));
    const finallySites = parts.filter((s) => isMarker(s, "finally"));
    const catchForm = catchSite?.value as APair<SchemeValue, SchemeValue> | undefined;
    const catchRest = catchForm?.cdr instanceof APair ? catchForm.cdr : undefined;
    const varSpec = catchRest?.car;
    const varName = varSpec instanceof APair && varSpec.car instanceof ASymbol ? opName(varSpec.car) : "__condition";
    const handlers = catchRest === undefined ? [] : sitesOf(catchForm, catchRest.cdr);
    const id = this.addNode({
      kind: "guard",
      op: "try",
      span: scopeId(expr),
      var: varName,
      clauses: catchForm === undefined ? 0 : 1,
      hasFinally: finallySites.length > 0,
    });
    // body = every form before the first catch/finally marker
    const bodySites = parts.filter((s) => !isMarker(s, "catch") && !isMarker(s, "finally"));
    const bodyForm = new APair(
      sym("begin"),
      listOf(...bodySites.map((x) => x.value)) as SchemeValue,
      EMPTY_PROVENANCE,
      expr.location,
    );
    this.emitWire(bodyForm, { node: id, slot: "body" }, env, holder(bodyForm, expr));
    if (catchForm !== undefined) {
      const clauseEnv = this.conditionEnv(id, varName, env);
      for (const dropped of handlers.slice(0, -1)) this.walkForCuts(dropped.value, clauseEnv, dropped);
      const armSite = handlers.at(-1) ?? holder(schemeFalse, expr);
      this.emitWire(schemeTrue, { node: id, slot: "selector0" }, clauseEnv, holder(schemeTrue, expr));
      this.emitWire(armSite.value, { node: id, slot: "arm0" }, clauseEnv, armSite);
    }
    for (const f of finallySites) {
      const fc = f.value.cdr;
      for (const dropped of fc instanceof APair ? sitesOf(f.value, fc) : []) this.walkDropped(dropped, env);
    }
    return id;
  }

  /**
   * A lambda literal → `closure` node with a PRIVATE interior (I5). Non-formal names the interior
   * reads are CAPTURES (the interior is built with `frames: []`); their wires land in `finish()`.
   * Returns undefined for a cut-free (pure) lambda — it stays wire material.
   */
  private buildClosure(
    expr: APair<SchemeValue, SchemeValue>,
    rest: APair<SchemeValue, SchemeValue>,
    env: WalkEnv,
  ): number | undefined {
    const { params, rest: restName } = lambdaFormals(rest.car);
    const formals = restName === undefined ? params : [...params, restName];
    const interior = new GraphBuilder(this.bctx);
    const intSubst = new Map(env.subst);
    for (const p of formals) intSubst.set(p, LEAF(p));
    const intEnv: WalkEnv = { subst: intSubst, frames: [] };
    interior.walkBody(sitesOf(expr, rest.cdr), intEnv, "egress");
    const template = interior.finish();
    if (template.nodes.every((n) => n.kind === "port")) return undefined;
    const names = captureNames(template, formals);
    const span = scopeId(expr);
    const id = this.addNode({
      kind: "closure",
      span,
      params,
      ...(restName === undefined ? {} : { rest: restName }),
      template,
      captures: names,
    });
    this.pendingCaptures.push({ node: id, names, env, span });
    this.bctx.closureSites.set(rest.cdr, { templateHash: hashGraph(template), rootOrdinal: id });
    return id;
  }

  /** Quasiquote: only unquote bodies re-enter expression space (depth-counted). */
  private walkQuasi(n: unknown, depth: number, env: WalkEnv): void {
    if (!(n instanceof APair)) return;
    if (n.car instanceof ASymbol) {
      const hn = opName(n.car);
      if (hn === "unquote" || hn === "unquote-splicing") {
        const arg = n.cdr instanceof APair ? n.cdr.car : undefined;
        if (depth === 1)
          this.walkForCuts(arg, env, n.cdr instanceof APair ? { value: arg, cell: n.cdr, parent: n } : null);
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

  /** Let-family transparent to designation; named let → binder with interior. */
  private walkLet(
    expr: APair<SchemeValue, SchemeValue>,
    kind: "let" | "let*" | "letrec" | "letrec*",
    env: WalkEnv,
  ): void {
    const rest = expr.cdr;
    if (!(rest instanceof APair)) return;
    if (rest.car instanceof ASymbol) {
      this.cuts.set(expr, this.buildNamedLetBinder(expr, rest, env));
      return;
    }
    const entries = letEntries(rest.car, expr);
    const sequential = kind !== "let";
    const recursive = kind === "letrec" || kind === "letrec*";
    const extended = new Map(env.subst);
    // letrec scoping (R7RS): every name is bound in every RHS — the FULL frame, not the growing
    // one — so a closure's capture of itself / a later sibling resolves to its own cut.
    if (recursive) for (const entry of entries) extended.set(entry.name, LEAF(entry.name));
    const fullFrame: WireFrame = { kind, entries: entries.map(frameEntry) };
    const partial: WireFrameEntry[] = [];
    for (const entry of entries) {
      const rhsEnv: WalkEnv = recursive
        ? { subst: extended, frames: [...env.frames, fullFrame], recur: env.recur }
        : sequential
          ? { subst: extended, frames: [...env.frames, { kind, entries: [...partial] }], recur: env.recur }
          : env;
      if (entry.rhs !== undefined) this.walkForCuts(entry.rhs, rhsEnv, entry.site);
      const rhsSubst = sequential ? extended : env.subst;
      const rhsNode: LineageNode =
        entry.rhs === undefined
          ? { kind: "literal" }
          : classify(entry.rhs as SchemeValue, this.bctx.reachClassifier, rhsSubst);
      extended.set(entry.name, rhsNode);
      partial.push(frameEntry(entry));
    }
    const bodyEnv: WalkEnv = { subst: extended, frames: [...env.frames, fullFrame], recur: env.recur };
    for (const b of sitesOf(expr, rest.cdr)) this.walkForCuts(b.value, bodyEnv, b);
  }

  // ── node constructors ──────────────────────────────────────────────────────

  private buildArgNode(node: WireframeNode, expr: APair<SchemeValue, SchemeValue>, env: WalkEnv): number {
    const id = this.addNode(node);
    sitesOf(expr, expr.cdr).forEach((a, i) => this.emitWire(a.value, { node: id, slot: `arg${i}` }, env, a));
    return id;
  }

  private buildMux(
    expr: APair<SchemeValue, SchemeValue>,
    rest: APair<SchemeValue, SchemeValue>,
    form: string,
    env: WalkEnv,
  ): number {
    const testSite: Site = { value: rest.car, cell: rest, parent: expr };
    // if: [then, else?]; when/unless: last body form is value.
    const bodySites = sitesOf(expr, rest.cdr);
    const arms = form === "if" ? bodySites : bodySites.length > 0 ? [bodySites[bodySites.length - 1]] : [];
    if (form !== "if") for (const dropped of bodySites.slice(0, -1)) this.walkForCuts(dropped.value, env, dropped);
    const id = this.addNode({ kind: "mux", op: form, span: scopeId(expr), arms: arms.length });
    this.emitWire(testSite.value, { node: id, slot: "selector" }, env, testSite);
    arms.forEach((arm, k) => this.emitWire(arm.value, { node: id, slot: `arm${k}` }, env, arm));
    return id;
  }

  private buildCondMux(expr: APair<SchemeValue, SchemeValue>, clauses: readonly CondClause[], env: WalkEnv): number {
    const id = this.addNode({ kind: "mux", op: "cond", span: scopeId(expr), arms: clauses.length });
    let sel = 0;
    clauses.forEach((clause, k) => {
      if (!clause.isElse) this.emitWire(clause.test, { node: id, slot: `selector${sel++}` }, env, clause.testSite);
      // Last body form is arm; bare `(test)` returns test; `(test => proc)` is `(proc test)`
      // (the test's cuts are shared nodes, so the receiver's dependency on the test value is wired).
      const armSite: Site = clause.arrow
        ? holder(listOf(clause.body[0], clause.test), expr)
        : clause.bodySites.length > 0
          ? clause.bodySites[clause.bodySites.length - 1]
          : clause.testSite;
      for (const dropped of clause.arrow ? [] : clause.bodySites.slice(0, -1)) {
        this.walkForCuts(dropped.value, env, dropped);
      }
      this.emitWire(armSite.value, { node: id, slot: `arm${k}` }, env, armSite);
    });
    return id;
  }

  /** `and`/`or` with a port-reaching non-last operand: selector = first operand, ONE arm = the
   *  rest (a synthetic `(and rest…)` — itself a mux if it still has a port-reaching non-last
   *  operand). Short-circuit fallthrough yields the SELECTOR's own value (replay: muxArmFor
   *  null + `muxFallthrough`), not void. */
  private buildAndOrMux(
    expr: APair<SchemeValue, SchemeValue>,
    form: string,
    sites: readonly Site[],
    env: WalkEnv,
  ): number {
    const [first, ...rest] = sites;
    const id = this.addNode({ kind: "mux", op: form, span: scopeId(expr), arms: 1 });
    this.emitWire(first.value, { node: id, slot: "selector" }, env, first);
    const armSite = rest.length === 1 ? rest[0] : undefined;
    const armExpr =
      armSite === undefined ? new APair(expr.car, rest[0].cell, EMPTY_PROVENANCE, expr.location) : armSite.value; // (and rest…), span of the original
    this.emitWire(armExpr, { node: id, slot: "arm0" }, env, armSite ?? holder(armExpr, expr));
    return id;
  }

  /** `case` with a port-reaching key: cond-style mux. One `selector{k}` per non-else clause =
   *  `(case KEY ((datums…) #t) (else #f))` (the evaluator's own datum matching, KEY shared so its
   *  cuts are the same nodes); arm k = the clause's last body form. */
  private buildCaseMux(
    expr: APair<SchemeValue, SchemeValue>,
    keySite: Site,
    clauses: readonly CaseClause[],
    env: WalkEnv,
  ): number {
    const key = keySite.value;
    const id = this.addNode({ kind: "mux", op: "case", span: scopeId(expr), arms: clauses.length });
    let sel = 0;
    clauses.forEach((clause, k) => {
      if (!clause.isElse) {
        const test = listOf(sym("case"), key, listOf(clause.datums, schemeTrue), listOf(sym("else"), schemeFalse));
        this.noMux.add(test as object);
        this.emitWire(test, { node: id, slot: `selector${sel++}` }, env, holder(test, expr));
      }
      const hasArrow = clause.body[0] instanceof ASymbol && opName(clause.body[0]) === "=>";
      const bodySites = hasArrow ? [] : clause.bodySites;
      for (const dropped of bodySites.slice(0, -1)) this.walkForCuts(dropped.value, env, dropped);
      // `(clause => proc)` ≡ `(proc KEY)`; an empty body is the unspecified value.
      const armSite: Site = hasArrow
        ? holder(listOf(clause.body[1], key), expr)
        : (bodySites.at(-1) ?? holder(listOf(sym("if"), schemeFalse, schemeFalse), expr));
      this.emitWire(armSite.value, { node: id, slot: `arm${k}` }, env, armSite);
    });
    return id;
  }

  /** True when a fan callback symbol resolves BY NAME in the hermetic env (prelude / base). */
  private isByName(fn: ASymbol, env: WalkEnv): boolean {
    const name = opName(fn);
    if (env.subst.has(name) || this.bctx.materialNames.has(name)) return false;
    const role = this.bctx.classifier.roleOf(name);
    if (role !== undefined && role !== "pipe") return false;
    return this.bctx.preludeNames.has(name) || this.bctx.isBaseName(name);
  }

  /** Fan = I5 region host; lambda body → private template interior. A callback that is not a
   *  lambda literal or a by-name op (material define, port name, variable, computed) is a `fn`
   *  WIRE — a closure value, not a smuggled name. */
  private buildFan(expr: APair<SchemeValue, SchemeValue>, op: string, env: WalkEnv): number {
    const argSites = sitesOf(expr, expr.cdr);
    const fnSite = argSites[0];
    const fn = fnSite?.value;
    const lengthPreserving = op === "map" || op === "vector-map";
    let template: WireframeGraph | undefined;
    let elementParams: string[] | undefined;
    let fnOp: string | undefined;
    let fnWire = false;
    let siteKey: object | undefined;
    if (fn instanceof APair && fn.car instanceof ASymbol && opName(fn.car) === "lambda" && fn.cdr instanceof APair) {
      const params = lambdaParams(fn.cdr.car);
      const interior = new GraphBuilder(this.bctx);
      const intSubst = new Map(env.subst);
      for (const p of params) intSubst.set(p, LEAF(p));
      // frames: [] — non-element slots are region captures (I2), supplied by `capture:` wires.
      const intEnv: WalkEnv = { subst: intSubst, frames: [] };
      interior.walkBody(sitesOf(fn, fn.cdr.cdr), intEnv, "egress");
      template = interior.finish();
      elementParams = params;
      siteKey = fn.cdr.cdr;
    } else if (fn instanceof ASymbol && this.isByName(fn, env)) {
      fnOp = opName(fn);
    } else if (fn !== undefined) {
      fnWire = true;
    }
    const captures = template !== undefined && elementParams !== undefined ? captureNames(template, elementParams) : [];
    const roles = this.bctx.callbackRolesOf?.(op);
    const span = scopeId(expr);
    const id = this.addNode({
      kind: "fan",
      op,
      span,
      lengthPreserving,
      // eslint-disable-next-line unicorn/no-negated-condition -- omit template when the fan has none
      ...(template !== undefined ? { template } : {}),
      // eslint-disable-next-line unicorn/no-negated-condition -- omit elementParams when undeclared
      ...(elementParams !== undefined ? { elementParams } : {}),
      // eslint-disable-next-line unicorn/no-negated-condition -- omit fnOp when the callback is not a named op
      ...(fnOp !== undefined ? { fnOp } : {}),
      captures,
      // eslint-disable-next-line unicorn/no-negated-condition -- omit callbackRoles when the classifier has none
      ...(roles !== undefined ? { callbackRoles: roles } : {}),
    });
    // The fan's lambda literal is a closure site like any other: each element's call is a TRACK at
    // `[…enclosing, r_fan, k]`, so a recorded crossing is addressed by (fan, element), not by when it ran.
    if (template !== undefined && siteKey !== undefined) {
      this.bctx.closureSites.set(siteKey, { templateHash: hashGraph(template), rootOrdinal: id });
    }
    argSites
      .slice(1)
      .forEach((a, i) => this.emitWire(a.value, { node: id, slot: i === 0 ? "source" : `source${i}` }, env, a));
    if (fnWire && fnSite !== undefined) this.emitWire(fn, { node: id, slot: "fn" }, env, fnSite);
    if (captures.length > 0) this.pendingCaptures.push({ node: id, names: captures, env, span });
    return id;
  }

  /**
   * Named let → binder{cycles} with private interior. Loop vars = LEAF slots
   * extending outer subst (selector reachability sees captures). Self-call =
   * recur backedge; init wires are outer-scope ingress; free outer names are CAPTURES.
   */
  private buildNamedLetBinder(
    expr: APair<SchemeValue, SchemeValue>,
    rest: APair<SchemeValue, SchemeValue>,
    env: WalkEnv,
  ): number {
    const loopName = opName(rest.car);
    const afterName = rest.cdr;
    const entries = afterName instanceof APair ? letEntries(afterName.car, expr) : [];
    const params = entries.map((e) => e.name);

    const interior = new GraphBuilder(this.bctx);
    const intSubst = new Map(env.subst);
    for (const p of params) intSubst.set(p, LEAF(p));
    const intEnv: WalkEnv = { subst: intSubst, frames: [], recur: { name: loopName } };
    if (afterName instanceof APair) interior.walkBody(sitesOf(afterName, afterName.cdr), intEnv, "egress");

    const interiorGraph = interior.finish();
    const captures = captureNames(interiorGraph, params);
    const span = scopeId(expr);
    const id = this.addNode({
      kind: "binder",
      op: "named-let",
      span,
      cycles: true,
      params,
      interior: interiorGraph,
      captures,
    });
    entries.forEach((e, i) => this.emitWire(e.rhs, { node: id, slot: `arg${i}` }, env, e.site ?? holder(e.rhs, expr)));
    if (captures.length > 0) this.pendingCaptures.push({ node: id, names: captures, env, span });
    return id;
  }

  /**
   * `do` → binder{cycles}. Body/test value-dropped (ports still land); no mux
   * for continue/stop (precision LIMIT — agreement corpus). Steps = backedge
   * recur (R7RS omitted step = identity; parseDoBindings encodes default).
   * result… is terminal egress under synthetic let rebinding loop vars to the
   * recur cut (R7RS latest-value scope; named-let gets this from syntactic
   * self-call).
   */
  private buildDoBinder(expr: APair<SchemeValue, SchemeValue>, env: WalkEnv): number {
    const rest = expr.cdr;
    const bindings = rest instanceof APair ? parseDoBindings(rest.car) : [];
    const afterBindings = rest instanceof APair ? rest.cdr : undefined;
    const clause = afterBindings instanceof APair ? parseDoClause(afterBindings.car) : parseDoClause(undefined);
    const bodySites = afterBindings instanceof APair ? sitesOf(afterBindings, afterBindings.cdr) : [];
    const params = bindings.map((b) => b.name);

    const interior = new GraphBuilder(this.bctx);
    const intSubst = new Map(env.subst);
    for (const p of params) intSubst.set(p, LEAF(p));
    const intEnv: WalkEnv = { subst: intSubst, frames: [] };
    for (const cmd of bodySites) interior.walkDropped(cmd, intEnv);
    if (clause.test !== undefined) interior.walkDropped(holder(clause.test, expr), intEnv);
    const recurId = interior.addRecur(
      scopeId(expr),
      bindings.map((b) => b.step),
      intEnv,
      expr,
    );
    if (clause.resultForms.length > 0) {
      // One sentinel PER loop var, each cut to the recur node at that var's own slot, so the
      // result wire gets distinct params (`argK` = loop var K's next value) — not one shared
      // param for every var. R7RS latest-value scope.
      const resultFrame: WireFrame = {
        kind: "let",
        entries: bindings.map((b, k): WireFrameEntry => {
          const sentinel: unknown = {};
          interior.cuts.set(sentinel, recurId);
          interior.cutSlots.set(sentinel, `arg${k}`);
          return { name: b.name, rhs: sentinel };
        }),
      };
      const resultEnv: WalkEnv = { subst: intSubst, frames: [resultFrame] };
      const doSpan = scopeId(expr);
      const resultSites = clause.resultForms.map((f) => holder(f, expr));
      for (const dropped of resultSites.slice(0, -1)) interior.walkDropped(dropped, resultEnv);
      interior.emitEgress(resultSites[resultSites.length - 1], resultEnv, doSpan);
    }

    const interiorGraph = interior.finish();
    const captures = captureNames(interiorGraph, params);
    const span = scopeId(expr);
    const id = this.addNode({
      kind: "binder",
      op: "do",
      span,
      cycles: true,
      params,
      interior: interiorGraph,
      captures,
    });
    bindings.forEach((b, i) => this.emitWire(b.init, { node: id, slot: `arg${i}` }, env, holder(b.init, expr)));
    if (captures.length > 0) this.pendingCaptures.push({ node: id, names: captures, env, span });
    return id;
  }

  /** Backedge: next-iteration args; never escapes as graph egress. */
  private addRecur(span: string, args: readonly unknown[], env: WalkEnv, parent: unknown): number {
    const id = this.addNode({ kind: "recur", span });
    args.forEach((a, i) => this.emitWire(a, { node: id, slot: `arg${i}` }, env, holder(a, parent)));
    return id;
  }
}

/** Function-form define (`(define (f x) …)` / `(define f (lambda …))`) → a callable TEMPLATE;
 *  anything else (`(define plan (src-a 1))`) is a VALUE define — it has no call sites, so a
 *  zero-param template would be a lie (W-P2): its RHS is walked in main as a growing frame. */
function isFunctionDefine(form: APair<SchemeValue, SchemeValue>): boolean {
  const rest = form.cdr;
  if (!(rest instanceof APair)) return false;
  if (rest.car instanceof APair) return true;
  const rhs = rest.cdr instanceof APair ? rest.cdr.car : undefined;
  return rhs instanceof APair && rhs.car instanceof ASymbol && opName(rhs.car) === "lambda" && rhs.cdr instanceof APair;
}

/** Formals + body SITES of a wireframe-material FUNCTION define (function form or lambda RHS). */
function defineShape(form: APair<SchemeValue, SchemeValue>): { params: string[]; bodySites: Site[] } {
  const rest = form.cdr;
  if (!(rest instanceof APair)) return { params: [], bodySites: [] };
  const target = rest.car;
  if (target instanceof APair) return { params: lambdaParams(target.cdr), bodySites: sitesOf(form, rest.cdr) };
  const rhs = rest.cdr instanceof APair ? rest.cdr.car : undefined;
  if (rhs instanceof APair && rhs.car instanceof ASymbol && opName(rhs.car) === "lambda" && rhs.cdr instanceof APair) {
    return { params: lambdaParams(rhs.cdr.car), bodySites: sitesOf(rhs, rhs.cdr.cdr) };
  }
  return { params: [], bodySites: rest.cdr instanceof APair ? [{ value: rhs, cell: rest.cdr, parent: form }] : [] };
}

/**
 * Whole-program prospective layer: prelude partition, port-reaching FUNCTION defines →
 * named templates, port-reaching VALUE defines → a growing top-level frame walked in main
 * (program order), main forms (last non-define → egress; earlier value-dropped).
 */
export function buildWireframe(forms: readonly SchemeValue[], opts: WireframeBuildOptions): WireframeProgram {
  const membership = classifyProgramPrelude(forms, opts.classifier);
  const preludeSource = buildPreludeSource(forms, membership);
  // Value defines are not callable templates: excluded from `materialNames` (the
  // template-ref / capture-refusal set) so their names are ordinary lexical ingress.
  const valueDefineNames = new Set<string>();
  for (const form of forms) {
    const name = defineNameOf(form);
    if (name !== null && membership.wireframe.has(name) && form instanceof APair && !isFunctionDefine(form)) {
      valueDefineNames.add(name);
    }
  }
  const templateNames = new Set([...membership.wireframe].filter((n) => !valueDefineNames.has(n)));
  const defineParams = new Map<string, readonly string[]>();
  for (const form of forms) {
    const name = defineNameOf(form);
    if (name !== null && templateNames.has(name) && form instanceof APair && isFunctionDefine(form)) {
      defineParams.set(name, defineShape(form).params);
    }
  }
  const bctx: BuildCtx = {
    classifier: opts.classifier,
    reachClassifier: {
      roleOf: (op) => (membership.wireframe.has(op) ? "opaque" : opts.classifier.roleOf(op)),
    },
    preludeNames: membership.pure,
    materialNames: templateNames,
    defineParams,
    closureSites: new Map(),
    isBaseName: opts.isBaseName,
    // eslint-disable-next-line unicorn/no-negated-condition -- omit callbackRolesOf when the caller did not supply it
    ...(opts.callbackRolesOf !== undefined ? { callbackRolesOf: opts.callbackRolesOf } : {}),
  };

  const templates = new Map<string, DefineTemplate>();
  for (const form of forms) {
    const name = defineNameOf(form);
    if (name === null || !templateNames.has(name) || !(form instanceof APair) || !isFunctionDefine(form)) continue;
    const { params, bodySites } = defineShape(form);
    const g = new GraphBuilder(bctx);
    const subst = new Map<string, LineageNode>(params.map((p) => [p, LEAF(p)]));
    const env: WalkEnv = { subst, frames: [] };
    g.walkBody(bodySites, env, "egress");
    templates.set(name, { params, graph: g.finish() });
  }

  const main = new GraphBuilder(bctx);
  const rootEntries: WireFrameEntry[] = [];
  const rootFrame: WireFrame = { kind: "let*", entries: rootEntries };
  main.rootFrame = rootFrame;
  const rootSubst = new Map<string, LineageNode>();
  const rootEnv: WalkEnv = { subst: rootSubst, frames: [rootFrame] };
  const lastMain = forms.findLastIndex((f) => defineNameOf(f) === null);
  forms.forEach((form, i) => {
    const name = defineNameOf(form);
    if (name !== null) {
      if (!valueDefineNames.has(name) || !(form instanceof APair)) return; // pure → prelude; function → template
      const rest = form.cdr instanceof APair ? form.cdr : undefined;
      const rhsCell = rest?.cdr instanceof APair ? rest.cdr : undefined;
      const rhs = rhsCell?.car;
      if (rhs !== undefined && rhsCell !== undefined) {
        main.walkDropped({ value: rhs, cell: rhsCell, parent: form }, rootEnv);
      }
      rootSubst.set(
        name,
        rhs === undefined ? { kind: "literal" } : classify(rhs as SchemeValue, bctx.reachClassifier, rootSubst),
      );
      rootEntries.push({ name, rhs, ...(rhsCell === undefined ? {} : { cell: rhsCell }) });
      return;
    }
    const formSite = holder(form, form);
    if (i < lastMain) main.walkDropped(formSite, rootEnv);
    else main.emitEgress(formSite, rootEnv);
  });

  return {
    prelude: { names: membership.pure, source: preludeSource },
    membership,
    templates,
    main: main.finish(),
    closureSites: bctx.closureSites,
  };
}
