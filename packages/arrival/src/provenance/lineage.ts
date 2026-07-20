/**
 * CARRIER CORE — the lineage data model + STATIC chunk classifier.
 * The pre-execution lens face in the static plane: docs/STATIC-PLANE.md §THE FOUR READERS 4.4
 * (PROVENANCE.md owns the runtime stamp/trace/replay — cross-link, don't duplicate).
 *
 * Provenance is a static lineage TREE (pipe / merge / fan / mux), minted only at
 * Rosetta crossings, with the SHAPE derivable from the parsed AST BEFORE execution
 * (operand-arity over non-literal operands). Runtime only stamps Rosetta leaf-ids
 * into the skeleton's slots. One tree answers both the teleological full-cone
 * (seal: walk to every leaf) and the minimal demand-cone (e.g. a count, which
 * prunes a length-preserving fan).
 *
 * `classify`/`fullCone`/`countCone`/`fieldCone`/`fieldResolve`/`stepKey`/`PathStep`/
 * `LineageNode` are exported from the package barrel and consumed cross-package by
 * the arrival-chain field-pin shadow (`lineage-field-shadow-corpus.test.ts`),
 * which asserts the static carrier reproduces the live runtime field pins;
 * lineage-shadow.ts wires the full-cone shadow in-package. Operates on real AST
 * nodes (Pair / SchemeSymbol from the reader); classify() runs no evaluation.
 *
 * SPECIAL FORMS. `if`/`cond`/`let`/`let*`/`letrec`/`begin`/`and`/`or`/`lambda` are
 * dispatched DIRECTLY from `SPECIAL_FORMS` (eval/evaluator.ts) — never macro-
 * expanded — so classify() handles the surface Pairs:
 *   - `if`   → mux(selector=test, arms=[then, else?])
 *   - `cond` → mux over clauses (else is an arm; a `=>` clause threads the test
 *     cone into its arm)
 *   - `let` / `let*` / `letrec` → TRANSPARENT: the body is classified with each
 *     bound symbol's leaf-slot SUBSTITUTED by classify(its RHS) — equals the
 *     inlined form. `let*`/`letrec` thread substitutions left-to-right; a named
 *     let is recursive and stays opaque.
 *   - `begin` → pass-through of the LAST expression
 *   - `and` / `or` → selector-free value-select: cone = union of operand cones,
 *     NO predicate-taint (a static over-approximation of the short-circuit; the
 *     runtime stays sequential short-circuit, never parallel-or)
 *   - `lambda` literal → contributes NO provenance at its definition site
 *
 * The `mux` cone is FORWARD-COMPAT ONLY: it is the conservative selector ∪
 * arms (the taken arm is unknowable statically) — the classifier voice of the one
 * conservative-narrowing law (OVER-ATTRIBUTE THE CONE, every widening keeps the
 * reported origin a SUPERSET of the true one: docs/STATIC-PLANE.md §CONSERVATIVE
 * NARROWING); the byte-identical control-flow
 * "why" (predicate-taint, failed-clause non-leak) stays eager-sourced via the
 * evaluator's control-flow wrappers — we owe the *shape*, not a runtime taken-arm
 * protocol.
 *
 * classify() runs on SURFACE reader Pairs whose special forms never enter the
 * fl-interop tagless algebra, so a Const-applicative reinterpretation (Applicative
 * = static structure, Monad = runtime, Build-Systems-à-la-Carte style) would first
 * need a full surface→tagless compiler duplicating the evaluator's special-form
 * dispatch — strictly more code than matching Pairs directly. That trade flips only
 * once per-op ADJOINT rules exist in that algebra: `walk()` is already the backward
 * pass, so the missing piece is the adjoint table, not a mode.
 */
import { is_pair } from "../values/value-guards.js";
import { ASymbol } from "../values/primitives/ASymbol.js";
import { APair } from "../values/primitives/APair.js";
import type { SchemeValue } from "../values/types.js";

/** Exhaustiveness guard for `LineageNode.kind` switches. The `never` parameter makes
 *  "added a node kind, forgot a walker arm" a COMPILE error (the new kind no longer
 *  narrows to `never` at the default arm); the throw covers the impossible runtime
 *  path. Internal to the carrier package (not re-exported from index.ts). Shared by the
 *  walkers here and in the sibling shadow/auto-binding modules so they stay in lock-step
 *  with the union by construction. */
export function assertNever(x: never): never {
  throw new Error(`unhandled LineageNode kind: ${JSON.stringify(x)}`);
}

/** A CANONICAL member-read step — the *where* of where-provenance. The field node
 *  is normalized to ONE of these regardless of the surface accessor syntax
 *  (`(:foo x)` / `(@ x :foo)` / `(car x)` / `(vector-ref x i)`), so a lineage
 *  chunk's `uneval` targets minimal scheme with no polyglot sugar; re-sugaring is
 *  an optional later display layer, not the carrier's concern. The carrier is the
 *  SOLE home of the dropped key — `(:field x)` forwards the producer's point; the
 *  runtime field-point carries no key.
 *
 *  The keyword/positional CONFLATION into one flat union is intentional: the
 *  distinction that MATTERS (keyword wins a chain, positionals are transparent)
 *  is resolved at classify time by ABSORPTION (keyword-priority) and
 *  surfaced by `stepKey`, not carried in this type. */
export type PathStep =
  | { readonly field: string } // a named key — (:foo x) / (@ x :foo): step = {field:"foo"}
  | { readonly car: true } // the head of a pair — (car x)
  | { readonly index: number }; // a positional index — (vector-ref x i) / (list-ref x i), i a LITERAL int

/** A node of the static lineage skeleton. `slot`/`op` names are filled with the
 *  actual provenance set at runtime (the leaf-stamping step). */
export type LineageNode =
  | { readonly kind: "literal" } // self-evaluating datum / lambda literal — never carries provenance
  | { readonly kind: "leaf"; readonly slot: string } // variable ref — runtime fills from its binding
  | { readonly kind: "source"; readonly op: string } // a Rosetta-in mint (infer/fetch/db-read/…)
  | { readonly kind: "pipe"; readonly op: string; readonly child: LineageNode } // ≤1 prov input → pass-through
  | { readonly kind: "merge"; readonly op: string; readonly children: readonly LineageNode[] } // ≥2 → fan-in
  // A WHERE-PROVENANCE lens step: a canonical member-read (`step`) focused on
  // `child`. walk() descends the focused child ONLY — siblings are pruned
  // STRUCTURALLY (never built as branches), so the hole-placement and the
  // addressing are the same act. The static form of trace.ts's runtime field-point.
  // `op` records the surface head for the viz / debug.
  | { readonly kind: "field"; readonly op: string; readonly step: PathStep; readonly child: LineageNode }
  // map/filter: a uniform per-element pipe template. `lengthPreserving` (map=true,
  // filter=false) gates the count-cone prune — see walk()/countCone. `template`
  // (present iff the fan function is a lambda) carries the per-element body — the
  // z-stack axis preserved PARAMETRIC so a field projected through a fan composes
  // without unrolling (the fan×lens product). It is a carrier-/viz-shaping
  // structure, NOT a cone contributor: walk() never descends it (the
  // source+introduces over-approximation already bounds the per-element cone), so
  // fullCone/countCone stay byte-identical to a template-less fan.
  | {
      readonly kind: "fan";
      readonly op: string;
      readonly introduces: boolean;
      readonly lengthPreserving: boolean;
      readonly source: LineageNode;
      readonly template?: LineageNode;
    }
  // if/cond — a value-SELECT over arms gated by a selector (the test cone). The
  // static cone is selector ∪ arms (conservative; the taken arm is a runtime fact).
  | { readonly kind: "mux"; readonly op: string; readonly selector: LineageNode; readonly arms: readonly LineageNode[] }
  | { readonly kind: "opaque"; readonly op: string; readonly children: readonly LineageNode[] } // black-box: holistic
  // GRAPH-LAYER target for the declaration-role `sink` lowering ("a sink is a port
  // with no egress wire"): an effect/output port. `children` are what fed it —
  // their cone still matters (I1 confinement reads it), but nothing derives FROM a
  // sink upward, so it contributes no leaf/mint of its own. Reachable via the
  // declaration-driven classifier (a declared `sink` role lowers here —
  // classifyWith's role dispatch); no live declaration uses the role yet (_bake.ts),
  // so the arm is exercised by classify() but not yet by any real symbol.
  | { readonly kind: "sink"; readonly op: string; readonly children: readonly LineageNode[] }
  // GRAPH-LAYER target for the `transparent` lowering ("a membrane crossing that
  // neither mints nor stamps"): a pure pass-through port. Single-child, cone-
  // identical to `pipe` — kept as its own kind because crossing a membrane is a
  // distinct FACT from a same-world pure op, even though today's cone walk treats it
  // the same. Same reachability status as `sink` above.
  | { readonly kind: "transparent"; readonly op: string; readonly child: LineageNode }
  // GRAPH-LAYER target for the "binders" designated-node category. `cycles` marks
  // whether THIS binder introduces a back-edge — the declaration-role `loop` lowers
  // 1:1 to `binder{cycles: true}`, and named-let/`do` build this shape directly
  // (`classifyLet`'s named-let branch, `classifyDo`) rather than falling to
  // `opaque`. `cycles: false` stays the future home for a NON-recursive binder shape
  // no form builds yet. `children` covers bindings + body as a flat conservative-
  // barrier array (walk()'s shared merge/opaque/sink/binder case) — real backedge
  // TOPOLOGY (per-iteration attribution) is future work, not this landing's; this
  // shape is the `cycles` marker the spec names, not yet the graph.
  | { readonly kind: "binder"; readonly op: string; readonly cycles: boolean; readonly children: readonly LineageNode[] }; // designated binding node; real topology pending

/** The declared-role vocabulary, restated here as a LOCAL literal union (not imported
 *  from `common/symbols/_bake.ts`'s `ProvenanceRole`) so this module stays
 *  dependency-light (value-guards + primitives only, no `common/` coupling, no cycle
 *  risk) — the two enumerate the SAME spec vocabulary and must stay in lock-step. */
export type DeclaredRole = "pipe" | "fan" | "source" | "sink" | "transparent" | "loop" | "opaque";

/**
 * Static classification of operators, READ FROM THE DECLARATION — never guessed from
 * the op's name or duck-read off an ad-hoc property (heuristic classification via
 * `isRosettaIn`/`.fanout` stamped on bound functions for duck-reading is explicitly
 * excluded). `roleOf` is the ONE read: a
 * production classifier answers it from the env-bound callable's `.provenanceRole`
 * (`provenance/lineage-classifier-from-env.ts`) or an equivalent declaration registry —
 * `undefined` means "no declared role" (unbound name, a plain user-defined Scheme
 * lambda, or an unmodeled special-form head — see the file header's `case`/`while`/
 * `quasiquote` note), which classify() treats identically to an explicit `"pipe"`.
 */
export interface Classifier {
  roleOf(op: string): DeclaredRole | undefined;
}

function opName(x: unknown): string {
  const v = (x as { valueOf?: () => unknown })?.valueOf?.();
  return typeof v === "string" || typeof v === "symbol" ? String(v) : String(x);
}

/**
 * A curated SUBSET of the evaluator's special forms — exactly the forms `classify()`
 * models BY SHAPE (the switch in classifyWith below). These resolve to `Macro`
 * instances in the live env — dispatched from SPECIAL_FORMS, not macro expansion —
 * so a consumer that skips "macro heads" (e.g. the shadow assert) must EXCLUDE
 * these: classify handles them, they are in scope, not opaque macros. `quote`/
 * `lambda` produce a literal but are still "handled".
 *
 * NOT exhaustive over SPECIAL_FORMS: forms classify does not model (case /
 * while / quasiquote / …) fall through to the application path and are mis-modeled
 * by shape — safe only because the shadow skips them as macro-heads. Keep this set
 * and the switch in classifyWith in lock-step (a head here without a switch arm
 * over-asserts; a switch arm without an entry here over-skips).
 *
 * `do` is in this set: an iterative loop classifies as `binder{cycles:true}` — the
 * same shape a named `let` gets (see `classifyLet`'s named-let branch) — via
 * `classifyDo` below, rather than the mis-modeled-by-shape application fallthrough. */
export const CLASSIFIED_SPECIAL_FORMS: ReadonlySet<string> = new Set([
  "if",
  "cond",
  "let",
  "let*",
  "letrec",
  "letrec*",
  "begin",
  "when",
  "unless",
  "and",
  "or",
  "lambda",
  "quote",
  "do",
]);

/** Surface-form heads dispatched by SPECIAL_FORMS, recognised by name. */
const isSym = (x: unknown, name: string): boolean => x instanceof ASymbol && opName(x) === name;

/** A datum that is neither a variable (SchemeSymbol) nor an application (Pair). */
function isLiteral(x: unknown): boolean {
  return !(x instanceof ASymbol) && !(x instanceof APair);
}

// APair's car/cdr are typed `unknown` (structurally heterogeneous), so the
// spine-walk carries `unknown` and each node is narrowed by guard before use.
// `SchemeValue` would over-claim a union membership the reader never promises
// at the slot.
function operands(app: APair<any, any>): unknown[] {
  const out: unknown[] = [];
  let n: unknown = app.cdr;
  while (n instanceof APair) {
    out.push(n.car);
    n = n.cdr;
  }
  return out;
}

const isProvBearing = (n: LineageNode): boolean => n.kind !== "literal";

/** A LITERAL integer datum's value (`(vector-ref x 1)` → `1`), else null. The
 *  index must be a self-evaluating exact integer; a variable index (`(vector-ref
 *  x n)`) leaves the form a plain op (no static field — the key isn't known). */
function literalIndex(x: unknown): number | null {
  if (x instanceof ASymbol || x instanceof APair) return null;
  const v = (x as { valueOf?: () => unknown })?.valueOf?.();
  return typeof v === "number" && Number.isInteger(v) ? v : null;
}

/**
 * Recognize a member-read across its SURFACE syntaxes and return the CANONICAL
 * step + the projected argument expression — else null. Mirrors
 * `provenance/trace.ts`'s `accessorField` for the keyword head, generalized to the four accessor
 * shapes consumers pin:
 *   - `(:foo x)`        keyword head — a SchemeSymbol `__name__` ":foo" (len>1) → {field:"foo"}
 *   - `(@ x :foo)`      the get term (env/polyglot @) — key is the 2nd operand (`:foo` symbol or "foo" string)
 *   - `(car x)`         pair head → {car:true}
 *   - `(vector-ref x i)` / `(list-ref x i)` with a LITERAL int i → {index:i}
 * The emitted node is uniform regardless of which surface produced it; the
 * no-lookahead property the sampler relies on lives at this canonical level.
 */
function memberRead(head: unknown, args: unknown[]): { step: PathStep; argExpr: unknown } | null {
  if (!(head instanceof ASymbol)) return null;
  const name = opName(head);

  // (:foo x) — keyword accessor. Head is `:foo`; a bare `:` (no field) is not one.
  if (name.length > 1 && name.startsWith(":") && args.length >= 1) {
    return { step: { field: name.slice(1) }, argExpr: args[0] };
  }

  // (@ x :foo) / (@ x "foo") — membrane member-read; same canonical step. The key
  // is the SECOND operand: a `:foo` keyword symbol, a "foo" string, or a literal int.
  if (name === "@" && args.length >= 2) {
    const key = args[1];
    const keyName = key instanceof ASymbol ? opName(key) : null;
    if (keyName !== null && keyName.length > 1 && keyName.startsWith(":")) {
      return { step: { field: keyName.slice(1) }, argExpr: args[0] };
    }
    if (!(key instanceof ASymbol) && !(key instanceof APair)) {
      const kv = (key as { valueOf?: () => unknown })?.valueOf?.();
      if (typeof kv === "string") return { step: { field: kv }, argExpr: args[0] };
      const ki = literalIndex(key);
      if (ki !== null) return { step: { index: ki }, argExpr: args[0] };
    }
    return null; // computed key (`(@ x k)`) — not a static field
  }

  // (car x) — the head of a pair.
  if (name === "car" && args.length >= 1) return { step: { car: true }, argExpr: args[0] };

  // (vector-ref x i) / (list-ref x i) — a positional index, i a LITERAL integer.
  if ((name === "vector-ref" || name === "list-ref") && args.length >= 2) {
    const i = literalIndex(args[1]);
    if (i !== null) return { step: { index: i }, argExpr: args[0] };
  }

  return null;
}

/** Pull the parameter symbols out of a lambda's formal list — `(it)` → ["it"],
 *  `(a b)` → ["a","b"]. A variadic/rest tail (`(a . r)`, or a bare symbol formal)
 *  is ignored for binding (the element flows in via the leading positionals only).*/
function lambdaParams(formals: unknown): string[] {
  const out: string[] = [];
  let n: unknown = formals;
  while (n instanceof APair) {
    if (n.car instanceof ASymbol) out.push(opName(n.car));
    n = n.cdr;
  }
  return out;
}

/**
 * Build a fan's per-element TEMPLATE when its function is a `(lambda (p…) body)`:
 * classify the body with each param bound to an ELEMENT leaf (`leaf{slot: p}`), so
 * a field projected inside the body nests under the fan (the fan×lens parametric
 * path). Returns undefined for a bare function symbol / non-lambda — those keep the
 * template-less fan. The template is a viz-/carrier-shaping structure; walk() never
 * descends it (cone neutrality).
 */
function classifyFanTemplate(fn: unknown, c: Classifier, subst: Subst): LineageNode | undefined {
  if (!(fn instanceof APair) || !isSym(fn.car, "lambda")) return undefined;
  const afterKw = fn.cdr;
  if (!(afterKw instanceof APair)) return undefined;
  const params = lambdaParams(afterKw.car);
  const bodyForms = afterKw.cdr; // (body…) — classify the LAST (begin pass-through)
  // The element binds the params as leaves; the surrounding subst still applies to
  // free vars captured from the enclosing scope (e.g. an outer `let`-bound source).
  const extended = new Map(subst);
  for (const p of params) extended.set(p, { kind: "leaf", slot: p });
  return classifyBegin(bodyForms, c, extended);
}

/** The pipe-vs-merge arity cut, shared by pure ops and synthetic combinations
 *  (cond's selector, a `=>` arm). Drop empties, FORWARD a singleton (pipe), UNION ≥2
 *  (merge). `op` tags the synthetic node with the form/op that combines the children.
 *
 *  Differs from `unionProvenance` (AValue.ts): this counts NODES (static,
 *  pre-binding), that cuts on distinct SET identity at runtime. Two operands that
 *  resolve to the SAME provenance set still count as 2 here → `merge`, where the
 *  runtime would singleton-forward → pipe. `fullCone` is unaffected (union of equal
 *  sets is that set), but the spurious `merge` makes `fieldCone` hit the M2
 *  demand-barrier (walk()'s merge/opaque case) CONSERVATIVELY where the runtime
 *  forwards through — sound, since the barrier over-approximates, never under. */
function combine(op: string, nodes: readonly LineageNode[]): LineageNode {
  const bearing = nodes.filter(isProvBearing);
  if (bearing.length === 0) return { kind: "literal" };
  if (bearing.length === 1) return { kind: "pipe", op, child: bearing[0] };
  return { kind: "merge", op, children: bearing };
}

/** Substitution carried through `let`-family transparency: a bound symbol's
 *  leaf-slot resolves to classify(its RHS), making `(let ((x e)) … x …)` equal
 *  the inlined `… e …`. Exported for the wireframe builder
 *  (`provenance/wireframe/builder.ts`), which threads its OWN let-walk's
 *  substitutions into `classify` when asking selector-cone reachability — so
 *  `(let ((y (src))) (if y …))` classifies the selector `y` as the source it is
 *  bound to, exactly the inlined-form equality this map already encodes. */
export type Subst = ReadonlyMap<string, LineageNode>;
const NO_SUBST: Subst = new Map();

/**
 * Build the lineage skeleton from a parsed AST — STATIC, no evaluation. The
 * pipe-vs-merge cut is just the count of provenance-bearing (non-literal)
 * operands: ≤1 → pipe (pass-through), ≥2 → merge (the tree branches). Special
 * forms (if, cond, let-family, begin, and, or, lambda) are handled by shape —
 * see the file header.
 *
 * `subst` (optional) seeds the let-transparency substitution from OUTSIDE — the
 * wireframe builder classifies a mux SELECTOR in the binding context its own
 * walk accumulated (the same map `classifyLet` builds internally); every existing
 * caller's two-argument shape is unchanged.
 */
export function classify(ast: SchemeValue, c: Classifier, subst: Subst = NO_SUBST): LineageNode {
  return classifyWith(ast, c, subst);
}

function classifyWith(ast: unknown, c: Classifier, subst: Subst): LineageNode {
  if (isLiteral(ast)) return { kind: "literal" };
  if (ast instanceof ASymbol) {
    const slot = opName(ast);
    return subst.get(slot) ?? { kind: "leaf", slot };
  }

  const head = (ast as APair<any, any>).car;

  // ── Special forms (dispatched directly by the evaluator; surface Pairs) ──
  if (head instanceof ASymbol) {
    const form = opName(head);
    const rest = (ast as APair<any, any>).cdr;
    switch (form) {
      case "if":
        return classifyIf(rest, c, subst);
      case "cond":
        return classifyCond(rest, c, subst);
      case "let":
      case "let*":
      case "letrec":
      case "letrec*":
        return classifyLet(rest, c, subst, form !== "let");
      case "begin":
        return classifyBegin(rest, c, subst);
      case "when": // (when test body…) ≡ (if test (begin body…))
      case "unless": // (unless test body…) ≡ (if (not test) (begin body…))
        return classifyGuardedBody(rest, c, subst, form);
      case "and":
      case "or":
        // Value-select over operands, NO predicate-taint. The result is one of
        // the operands (or #t/#f), so the cone is the union of operand cones.
        return combine(
          form,
          operands(ast as APair<any, any>).map((a) => classifyWith(a, c, subst)),
        );
      case "lambda":
        // A lambda literal is a value that carries no provenance at its
        // definition site (the body's lineage is realised only when applied).
        return { kind: "literal" };
      case "quote":
        return { kind: "literal" }; // (quote datum) is a self-evaluating constant
      case "do":
        return classifyDo(rest, c, subst);
      default:
        break; // not a special form → fall through to application
    }
  }

  // application: (op . args). A computed operator `((f a) b)` stringifies via
  // opName — a step-2+ HOF hole (tracked in lineage-assumptions A21).
  const op = opName(head);
  const args = operands(ast as APair<any, any>);

  // ── WHERE-PROVENANCE: a member-read, NORMALIZED to a canonical field node ──
  // Recognized across all its surface syntaxes (keyword/`@`/`car`/`vector-ref`);
  // the EMITTED node is uniform regardless (the `uneval` targets minimal scheme,
  // so the chunk is one canonical primitive shape). Placed before the
  // source/fan/opaque cuts so a projection head is never mis-read as a
  // pure op. cdr/cadr/rest stay PIPES (a sound over-approximation — consumers only
  // ever pin keyword/car/index fields).
  const projected = memberRead(head, args);
  if (projected !== null) {
    const child = classifyWith(projected.argExpr, c, subst);
    // ABSORPTION: a field directly under another field is a deeper pluck within
    // the SAME producer pin — keep base + ONE step, do NOT compose nested keys into a
    // path. KEYWORD-PRIORITY: the runtime accessor that ROUTES the forward branch
    // (`accessorField`, provenance/trace.ts) recognizes ONLY keyword heads and is
    // BLIND to the positional `car`/`index` steps, so a keyword anywhere in the chain
    // wins over a transparent positional step. This keeps the carrier — now the sole home
    // of the key — pinning `(:verdict (car x))` → {field:"verdict"} (NOT {car}).
    if (child.kind === "field") {
      const innerIsKeyword = "field" in child.step;
      const outerIsKeyword = "field" in projected.step;
      if (innerIsKeyword) return child; // inner keyword wins (innermost pin)
      if (outerIsKeyword) return { kind: "field", op, step: projected.step, child }; // keyword over a transparent positional child
      return child; // positional over positional — no keyword to pin, keep the innermost
    }
    return { kind: "field", op, step: projected.step, child };
  }

  // ── DECLARATION-DRIVEN DISPATCH — the ONE read is `c.roleOf(op)`; no name list,
  // no duck-read off a bound function's ad-hoc property. `undefined` (unbound / a
  // plain user lambda / an unmodeled special-form head) falls through with
  // `"pipe"` to the same default as an explicit pipe declaration — see
  // `Classifier`'s doc. ──
  const role = c.roleOf(op);

  if (role === "source") return { kind: "source", op }; // provenance is BORN here

  if (role === "fan") {
    // (map f xs) / (filter p xs) — f introduces provenance iff IT is itself
    // declared a source. `lengthPreserving` distinguishes map (true) from filter
    // (false) for the count-cone prune in walk().
    const fn = args[0];
    const fanOp = opName(fn);
    const lengthPreserving = op === "map" || op === "vector-map";
    // FAN×LENS: when the function is a lambda, classify its body with each param
    // bound to an ELEMENT leaf, nesting the per-element template under the fan. A
    // field projected inside the body (`(:bar it)`) then becomes a field node
    // UNDER the fan template — the z-stack axis stays parametric, so a
    // field-in-fan composes with a field-over-fan WITHOUT unrolling. A bare
    // function symbol (`(map infer xs)`) builds NO template — same as a
    // template-less fan.
    const template = classifyFanTemplate(fn, c, subst);
    return {
      kind: "fan",
      op: fanOp,
      introduces: c.roleOf(fanOp) === "source",
      lengthPreserving,
      source: classifyWith(args[1], c, subst),
      ...(template !== undefined ? { template } : {}),
    };
  }

  if (role === "sink") {
    // "a sink is a port with no egress wire" — an effect/output port. Its
    // operands still matter (I1 confinement reads their cone), but nothing derives
    // FROM a sink upward, so it contributes no leaf/mint of its own (mirrors opaque's
    // children-array shape, walk()'s shared barrier treatment).
    const children = args.map((a) => classifyWith(a, c, subst)).filter(isProvBearing);
    return { kind: "sink", op, children };
  }

  if (role === "transparent") {
    // "a membrane crossing that neither mints nor stamps" — cone-identical to a
    // pipe's single-child forward (walk()'s `transparent`/`pipe` share arm), but a
    // DISTINCT graph fact (a real membrane crossing happened here). Combine operands
    // exactly like a pure op would (the pipe-vs-merge arity cut), then tag the result
    // as a genuine crossing rather than silently reusing the `pipe` kind.
    const combined = combine(op, args.map((a) => classifyWith(a, c, subst)));
    return isProvBearing(combined) ? { kind: "transparent", op, child: combined } : combined;
  }

  if (role === "loop") {
    // A declared-loop OP (not yet exercised by any real declaration — see
    // common/symbols/_bake.ts's ProvenanceRole doc; `do`/named-let below are the
    // special-form route to the same graph shape) lowers to the same
    // `binder{cycles:true}` shape the declared `loop` role names.
    const children = args.map((a) => classifyWith(a, c, subst)).filter(isProvBearing);
    return { kind: "binder", op, cycles: true, children };
  }

  if (role === "opaque") {
    const children = args.map((a) => classifyWith(a, c, subst)).filter(isProvBearing);
    return { kind: "opaque", op, children };
  }

  // role === "pipe" or undefined (no declared role — an unbound name, a plain
  // user-defined Scheme lambda, or an unmodeled special-form head): the
  // pure-application default. Classify operands, keep the provenance-bearing
  // ones, cut by arity.
  return combine(
    op,
    args.map((a) => classifyWith(a, c, subst)),
  );
}

/** `(if test then else?)` → mux(selector=test, arms=[then, else?]). */
function classifyIf(rest: unknown, c: Classifier, subst: Subst): LineageNode {
  if (!(rest instanceof APair)) return { kind: "literal" };
  const test = rest.car;
  const afterTest = rest.cdr;
  const then_ = afterTest instanceof APair ? afterTest.car : undefined;
  const elseRest = afterTest instanceof APair ? afterTest.cdr : undefined;
  const else_ = elseRest instanceof APair ? elseRest.car : undefined;
  const arms = [then_, else_].filter((a) => a !== undefined).map((a) => classifyWith(a, c, subst));
  return { kind: "mux", op: "if", selector: classifyWith(test, c, subst), arms };
}

/** `(when/unless test body…)` ≡ a one-armed `if` over `(begin body…)`. */
function classifyGuardedBody(rest: unknown, c: Classifier, subst: Subst, op: string): LineageNode {
  if (!(rest instanceof APair)) return { kind: "literal" };
  const test = rest.car;
  const body = classifyBegin(rest.cdr, c, subst);
  return { kind: "mux", op, selector: classifyWith(test, c, subst), arms: [body] };
}

/**
 * `(cond clause…)` → a mux whose selector is the union of all clause tests and
 * whose arms are the clause bodies. An `else` clause is a plain arm. A `=>`
 * clause `(test => proc)` threads the test cone into its arm (the arm value is
 * `(proc test)`). The static cone is selector ∪ arms (conservative — the
 * matched-clause-only "why" stays eager per DR3).
 */
function classifyCond(rest: unknown, c: Classifier, subst: Subst): LineageNode {
  const tests: LineageNode[] = [];
  const arms: LineageNode[] = [];
  let node: unknown = rest;
  while (node instanceof APair) {
    const clause = node.car;
    node = node.cdr;
    if (!(clause instanceof APair)) continue;
    const test = clause.car;
    const body = clause.cdr;

    if (isSym(test, "else")) {
      arms.push(classifyBegin(body, c, subst)); // else: no selector, the body is the value
      continue;
    }

    const testNode = classifyWith(test, c, subst);
    tests.push(testNode);

    if (body instanceof APair && isSym(body.car, "=>")) {
      // (test => proc): arm value is (proc test) — proc's operand cone unioned
      // with the test cone (the test value flows into the arm).
      const procRest = body.cdr;
      const procNode =
        procRest instanceof APair ? classifyWith(procRest.car, c, subst) : ({ kind: "literal" } as LineageNode);
      arms.push(combine("=>", [procNode, testNode]));
    } else if (body instanceof APair) {
      arms.push(classifyBegin(body, c, subst)); // normal clause body
    } else {
      arms.push(testNode); // `(test)` with no body returns the test value itself
    }
  }
  return { kind: "mux", op: "cond", selector: combine("cond", tests), arms };
}

/**
 * `(let ((x e)…) body…)` and friends — TRANSPARENT. Classify the body under a
 * substitution mapping each bound symbol to classify(its RHS); the result equals
 * the inlined form. `let*`/`letrec` (sequential=true) thread substitutions
 * left-to-right (later RHSs see earlier bindings). A *named* let is recursive —
 * not transparently inlineable — so it classifies as a `binder{cycles:true}` over
 * its RHSs + body, the same shape `classifyDo` builds for `do` (a named recursive
 * loop is a recognized STRUCTURE, not a black box; `laws/provenance-roles.law.test.ts`
 * pins this).
 */
function classifyLet(rest: unknown, c: Classifier, subst: Subst, sequential: boolean): LineageNode {
  if (!(rest instanceof APair)) return { kind: "literal" };

  // Named let: (let name (bindings) body…) — recursion ⇒ a cyclic binder (not
  // transparently inlineable, but a genuine loop shape, not opaque).
  if (rest.car instanceof ASymbol) {
    const afterName = rest.cdr;
    if (!(afterName instanceof APair)) return { kind: "literal" };
    const rhss = letBindingValues(afterName.car).map((v) => classifyWith(v, c, subst));
    const body = classifyBegin(afterName.cdr, c, subst);
    return { kind: "binder", op: "named-let", cycles: true, children: [...rhss, body].filter(isProvBearing) };
  }

  const bindings = rest.car;
  const body = rest.cdr;

  // Build the substitution: leaf-slot ← classify(RHS). `let` classifies every
  // RHS in the OUTER subst (parallel); `let*`/`letrec` extend as they go.
  const extended = new Map(subst);
  let bindNode: unknown = bindings;
  while (bindNode instanceof APair) {
    const binding = bindNode.car;
    bindNode = bindNode.cdr;
    if (!(binding instanceof APair) || !(binding.car instanceof ASymbol)) continue;
    const name = opName(binding.car);
    const rhsExpr = binding.cdr instanceof APair ? binding.cdr.car : undefined;
    const rhsSubst = sequential ? extended : subst; // let* sees prior bindings; let does not
    const rhsNode = rhsExpr === undefined ? ({ kind: "literal" } as LineageNode) : classifyWith(rhsExpr, c, rhsSubst);
    extended.set(name, rhsNode);
  }

  return classifyBegin(body, c, extended);
}

/** Pull the RHS expressions out of a `let` binding list (named-let helper). */
function letBindingValues(bindings: unknown): unknown[] {
  const out: unknown[] = [];
  let n: unknown = bindings;
  while (n instanceof APair) {
    const b = n.car;
    if (b instanceof APair && b.cdr instanceof APair) out.push(b.cdr.car);
    n = n.cdr;
  }
  return out;
}

/**
 * `(do ((var init step) …) (test result…) body…)` — an ITERATIVE loop whose `step`
 * expressions read the PRIOR iteration's bound vars (a genuine back-edge), so it
 * classifies as `binder{cycles:true}` — the same shape a named `let` gets.
 * CONSERVATIVE BARRIER, same rationale as named-let/merge/opaque (walk()'s shared
 * barrier case): classify every init/step/test/result/body sub-expression and
 * union them as children — no attempt at per-iteration attribution (real backedge
 * topology is future work, not this).
 *
 * Walks the RAW surface pairs directly (mirrors `letBindingValues`), NOT the
 * evaluator's `normalizeBindings`/`normalizeClause` (evaluator.ts) — those live in
 * the eval layer and additionally accept a bracket-clause surface
 * (`[i 0 (+ i 1)]`) this static walk does not special-case; a bracket-vector test
 * clause or binding list is a known gap (same category as the file header's
 * `case`/`while`/`quasiquote`, untested by any corpus today).
 */
function classifyDo(rest: unknown, c: Classifier, subst: Subst): LineageNode {
  if (!(rest instanceof APair)) return { kind: "literal" };
  const children: LineageNode[] = [];

  // ((var init step?) …) — classify every init/step expression present.
  let bindNode: unknown = rest.car;
  while (bindNode instanceof APair) {
    const binding = bindNode.car;
    bindNode = bindNode.cdr;
    if (!(binding instanceof APair)) continue;
    let exprNode: unknown = binding.cdr; // skip the var name itself
    while (exprNode instanceof APair) {
      children.push(classifyWith(exprNode.car, c, subst));
      exprNode = exprNode.cdr;
    }
  }

  // (test result…) body… — the test/result clause, then the per-iteration commands.
  const afterBindings = rest.cdr;
  if (afterBindings instanceof APair) {
    let clauseNode: unknown = afterBindings.car;
    while (clauseNode instanceof APair) {
      children.push(classifyWith(clauseNode.car, c, subst));
      clauseNode = clauseNode.cdr;
    }
    let bodyNode: unknown = afterBindings.cdr;
    while (bodyNode instanceof APair) {
      children.push(classifyWith(bodyNode.car, c, subst));
      bodyNode = bodyNode.cdr;
    }
  }

  return { kind: "binder", op: "do", cycles: true, children: children.filter(isProvBearing) };
}

/** `(begin e…)` — pass-through of the LAST expression (earlier values dropped). */
function classifyBegin(body: unknown, c: Classifier, subst: Subst): LineageNode {
  let last: unknown;
  let n: unknown = body;
  while (n instanceof APair) {
    last = n.car;
    n = n.cdr;
  }
  return last === undefined ? { kind: "literal" } : classifyWith(last, c, subst);
}

/** Runtime bindings: a slot/source name → the provenance ids it carries. */
export type Bindings = Record<string, readonly number[]>;

/** The ONE parameterized backward fold (folds the former `walk` cone-walk and
 *  `walkField` demand-walk into a single recursion, per the file's "one interpreter").
 *  Two orthogonal knobs:
 *   - `countOnly` — a cardinality observation prunes the length-preserving fan transform.
 *   - `demand`    — DEMAND-AS-PROJECTION: only the matching field of the value
 *     is observed; a non-matching `field` node is a pruned sibling. The two never combine
 *     in practice (demand mode runs with countOnly false), but both are carried verbatim. */
function walk(n: LineageNode, b: Bindings, out: Set<number>, opts: { countOnly?: boolean; demand?: PathStep }): void {
  switch (n.kind) {
    case "literal":
      return;
    case "leaf":
      (b[n.slot] ?? []).forEach((x) => out.add(x));
      return;
    case "source":
      (b[n.op] ?? []).forEach((x) => out.add(x));
      return;
    case "pipe":
    case "transparent":
      // `transparent` mints/stamps nothing — cone-identical to `pipe`'s single-
      // child forward. Reachable via a declared `transparent` role (see
      // classifyWith's role dispatch); no declaration uses it yet (_bake.ts), but
      // the arm is exercised structurally by classify() now, not merely type-target.
      walk(n.child, b, out, opts); // a pure pipe adds nothing of its own; preserves both knobs
      return;
    case "field":
      if (opts.demand) {
        // DEMAND mode: follow this projection IFF it is the field we demand. On a
        // match the demand is SATISFIED — descend the child with the FULL cone
        // ({}), since the demanded value IS this projection's whole lineage. On a
        // miss this node is a pruned SIBLING (the lens complement) — add nothing.
        if (sameStep(n.step, opts.demand)) walk(n.child, b, out, {});
        return;
      }
      // CONE mode: descend the FOCUSED child only — siblings were pruned STRUCTURALLY
      // at classify time, so there is no ⊥ to propagate. fullCone stays NEUTRAL vs a
      // plain pipe classification of a member-read (a field over x yields x's cone).
      // The where-provenance KEY rides the node for the consumer queries; it does not
      // change the set walk.
      walk(n.child, b, out, opts);
      return;
    case "merge":
    case "opaque":
    case "sink":
    case "binder":
      // All four are DEMAND BARRIERS — walk each child with the demand
      // DROPPED (full cone), keeping countOnly — for DISTINCT reasons:
      //   - merge: a fan-in to a FRESH value (`(+ a b)`, a constructed dict). A field
      //     demand CANNOT be statically attributed to one child (no genesis labels
      //     yet); the merge itself IS the producer, not its children. Re-projecting
      //     `:foo` into each child would wrongly ask "which inputs feed child.:foo".
      //   - opaque: barrier'd for CONSERVATISM, not genesis — a membrane/foreign call
      //     is opaque to whether/how the demanded field survives it, so every child's
      //     full cone is taken. Do not narrow this: there is no visible structure to
      //     justify it, so it would be unsound.
      // `sink`/`binder` share the same children-array shape and the same conservative
      // barrier is sound for both: a sink's children are what fed it (barrier, since
      // nothing derives further from a sink anyway); a binder's children are
      // bindings+body, a flat array with no real backedge topology yet (future work).
      //
      // TERMINATION over `binder{cycles:true}` (`laws/provenance-roles.law.test.ts`
      // pins this): `cycles` is a SEMANTIC marker on the loop's runtime behavior, not
      // a structural back-reference in this tree. classify() only ever builds a
      // `LineageNode` by finite structural recursion DOWNWARD over a finite parsed
      // AST (classifyLet's named-let branch, classifyDo above) — it never expands a
      // call site into its callee's body, so no `LineageNode` object can reach
      // itself through `.children`/`.child`. `binder.children` is exactly as acyclic
      // as `merge.children`/`opaque.children` today; this walk terminates by the
      // SAME structural induction as every other kind, with no visit-set needed. A
      // visit-set guard becomes the honest minimal form ONLY once a binder gets REAL
      // backedge topology (a graph, not a tree) — do not add one here pre-emptively;
      // it would guard against a cycle this layer cannot produce.
      for (const ch of n.children) walk(ch, b, out, opts.demand ? { countOnly: opts.countOnly } : opts);
      return;
    case "mux":
      // Static over-approximation: the value is the selector-gated choice of one arm,
      // so the cone is selector ∪ every arm (the taken arm is unknowable statically).
      // Both knobs survive: a field demand crosses a conditional into BOTH arms — a
      // correct over-approximation, NOT a barrier (unlike a merge, an arm IS the
      // value, not an input to a fresh genesis).
      walk(n.selector, b, out, opts);
      n.arms.forEach((arm) => walk(arm, b, out, opts));
      return;
    case "fan":
      // The value depends on the per-element transform; for a LENGTH-PRESERVING fan
      // (map) the COUNT does not, so a count-query prunes it — same tree, two
      // answers. A FILTER is length-CHANGING (count depends on the predicate), so
      // it is NOT pruned. In demand mode countOnly is false, so the prune never fires.
      walk(n.source, b, out, opts);
      if (opts.countOnly && n.lengthPreserving) return; // map: prune the per-element transform
      if (n.introduces) (b[n.op] ?? []).forEach((x) => out.add(x));
      return;
    default:
      // A new LineageNode kind added without a walker arm fails to compile here (it no
      // longer narrows to `never`) — converting a silent under-cone into a build error.
      assertNever(n);
  }
}

/** Teleological "provenance everything": every source the value derives from. */
export function fullCone(n: LineageNode, b: Bindings): number[] {
  const out = new Set<number>();
  walk(n, b, out, {});
  return [...out].sort((a, z) => a - z);
}

/** Minimal demand-cone for a cardinality observation (a count): prunes the
 *  length-preserving transforms a count cannot depend on. */
export function countCone(n: LineageNode, b: Bindings): number[] {
  const out = new Set<number>();
  walk(n, b, out, { countOnly: true });
  return [...out].sort((a, z) => a - z);
}

/** Two `PathStep`s address the same member. */
export function sameStep(a: PathStep, z: PathStep): boolean {
  if ("field" in a) return "field" in z && a.field === z.field;
  if ("car" in a) return "car" in z;
  return "index" in z && a.index === z.index;
}

/**
 * DEMAND-AS-PROJECTION: the cone needed when only ONE field of the value
 * is demanded. A field node is followed IFF its step matches the demand; a
 * NON-matching field node is a pruned SIBLING (contributes nothing — the lens
 * complement as set-difference). Every other node propagates the same field
 * demand toward where the value is produced.
 *
 * This is `walk` parameterized by projection: explicit-optic machinery
 * (profunctor lenses) collapses to this single parameter because arrival has
 * ONE interpreter — the multi-interpreter uniformity a profunctor buys isn't needed.
 */
export function fieldCone(n: LineageNode, b: Bindings, step: PathStep): number[] {
  const out = new Set<number>();
  walk(n, b, out, { demand: step });
  return [...out].sort((a, z) => a - z);
}

/** The CARRIER's canonical plucked key of a `PathStep` — the NAMED location only.
 *  A named member (`(:verdict x)` / `(@ x :verdict)` / `(@ x "verdict")`) → its bare
 *  name string, the form the runtime accessor (`accessorField`) recognizes — the
 *  carrier is the SOLE place that key is pinned. POSITIONAL access FORWARDS (no
 *  key): `car` AND `index` both → `null`. By design (named-pin / positional-forward)
 *  the carrier tracks producer + *named* location, not the specific access type or
 *  exact position — the index stays in the tree (z-stack/fan axis, read via
 *  `.step`) but never becomes a `:fields` key. */
export function stepKey(step: PathStep): string | null {
  if ("field" in step) return step.field;
  return null; // positional (car / index) — forwarded, no plucked key
}

/** What a field-projection chain bottoms out at, in the shape the two JOIN consumers
 *  read:
 *   - `base` — the source-leaf ids the value derives from (the producer points). The
 *     carrier's static analogue of the sift seal's `resolveReadIds` (slice.ts):
 *     walk to the BASE producer, key discarded. Computed as `fullCone` of the field
 *     node's focused CHILD (the source the projection reads).
 *   - `key` — the INNERMOST projected step (ABSORPTION), surfaced on the dag's
 *     point-edge as `FlowGraphEdge.fields`. `classify` already returns the inner field
 *     unchanged for a field-under-field, so a nested `(:a (:b x))` keeps just `:b` —
 *     base + ONE innermost key, no composed path.
 *
 *  For a NON-field node (plain source/pipe/merge — not a member-read) there is no
 *  projected key: `key = null`, `base = fullCone(node)` (the producer set, no pin). */
export interface FieldResolution {
  readonly base: number[];
  readonly key: string | null; // named field-name or forwarded; never a positional index
}

export function fieldResolve(n: LineageNode, b: Bindings): FieldResolution {
  if (n.kind === "field") {
    // base = the source the projection reads (its focused child's full cone — the
    // siblings were pruned structurally at classify time, so this is the producer set);
    // key = this node's step, which absorption already collapsed to the innermost.
    return { base: fullCone(n.child, b), key: stepKey(n.step) };
  }
  // Not a member-read: the whole value's cone is the base, with no projected key.
  return { base: fullCone(n, b), key: null };
}

/**
 * OPAQUE QUARANTINE — the MACHINERY. `opaque` is a citizen, not an error: it is a
 * quarantined escape hatch, and a corpus count of it is a shrink-only drift alarm.
 * Counts every `opaque` node in a classified tree, exhaustively — a POPULATION
 * count, not a reachability walk (unlike `walk()`/`fullCone`, this visits fan
 * templates and every branch, since the alarm cares how many opaque escape hatches
 * exist, not which are cone-reachable from a given binding). A future corpus-level
 * caller sums this over many `classify()` results to produce a baseline — that
 * baseline shifts as span propagation changes what counts as opaque, and is NOT
 * pinned here; this function is only the counted walk itself.
 */
export function countOpaqueNodes(n: LineageNode): number {
  switch (n.kind) {
    case "literal":
    case "leaf":
    case "source":
      return 0;
    case "pipe":
    case "transparent":
    case "field":
      return countOpaqueNodes(n.child);
    case "fan":
      return countOpaqueNodes(n.source) + (n.template ? countOpaqueNodes(n.template) : 0);
    case "mux":
      return countOpaqueNodes(n.selector) + n.arms.reduce((sum, arm) => sum + countOpaqueNodes(arm), 0);
    case "merge":
    case "sink":
    case "binder":
      return n.children.reduce((sum, ch) => sum + countOpaqueNodes(ch), 0);
    case "opaque":
      return 1 + n.children.reduce((sum, ch) => sum + countOpaqueNodes(ch), 0);
    default:
      // Same exhaustiveness contract as walk(): a new LineageNode kind without a
      // count arm fails to compile here rather than silently under-counting.
      assertNever(n);
  }
}
