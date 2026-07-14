/**
 * LEGIBILITY leg 1 — implicit destruction (constitution §3.5; the STRUCTURAL
 * version of mercury's string-regex `destructureTuple`, ported to the Residual
 * tree — see ../walker/names.ts's own header for the naming-ladder half of this
 * relocation, and ../legibility/names.ts for the singularization half). An Arrow
 * parameter used ONLY through car/cdr-composed positional access rewrites to an
 * `ArrayPattern`, positionally named:
 *
 *   (lambda (pair) (+ (car pair) (car (cdr pair))))
 *     → walk (car/cdr rules)   → pair => pair[0] + pair.slice(1)[0]
 *     → destructure            → ([first, second]) => first + second
 *
 * THE constitution's own worked example (§3.5) spells the second access as
 * `(cadr pair)` — semantically identical to `(car (cdr pair))`, which is the form
 * THIS slice's registered rules actually produce (the generative `cadr`/`caddr`/…
 * composition rung is future work — registry/harvest.ts's own comment: "lands
 * with the kernel-seed rows in the symbol-rules wave", not a bound symbol yet).
 * `cdrOffsetOf` below resolves either spelling to the same position, so the
 * destructured OUTPUT is identical regardless of which the source used — this
 * leg is a residual-shape transform, source-syntax-blind, and forward-compatible
 * with `cadr` landing as a direct `Index(xs, Lit(1))` rule later (offset 0
 * composing with outer index 1 — the same code path, no leg change needed).
 *
 * Occurrence discipline: identity-based (the parameter's `Binding` OBJECT, never
 * its name text) — a nested closure capturing the param is still eligible
 * (immutability: capture-by-value ≡ capture-by-reference, §2.2), and a
 * same-named variable in a sibling or nested scope (a DIFFERENT Binding object)
 * can never false-match. A single "whole-value" use of the parameter ANYWHERE —
 * mercury's own rule, ported — disqualifies the WHOLE parameter; destructure
 * never fires partially.
 */
import { childrenOf, collectBoundNames, mapChildren, mintReadable, substituteBy } from "./tree.js";
import type { Binding, CompilationUnit, Decl, Param, R } from "../residual/types.js";
import { ArrayPattern } from "../residual/types.js";

const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];
const ordinalName = (k: number): string => ORDINALS[k] ?? `item${k + 1}`;

/** `n` as a non-negative integer numeric literal's value, or `undefined`. */
function asNonNegIntLit(n: R): number | undefined {
  return n.t === "Lit" && n.value.k === "number" && Number.isInteger(n.value.value) && n.value.value >= 0
    ? n.value.value
    : undefined;
}

/**
 * `expr` as a chain of `cdr`-rule `.slice(k)` calls bottoming out at `Ref(param)`
 * — the accumulated offset if so, else `undefined`. Handles `car`'s direct
 * `Index(param, Lit(k))` (offset 0, composing with the outer index below) AND the
 * `car`-of-`cdr` spelling (`Index(Method(param, "slice", [Lit(j)]), Lit(0))`,
 * offset `j`), generalizing to arbitrary cxr depth by construction (recursive —
 * `caddr` would be a two-deep `.slice` chain, handled the same way).
 */
function cdrOffsetOf(expr: R, param: Binding): number | undefined {
  if (expr.t === "Ref" && expr.binding === param) return 0;
  if (expr.t === "Method" && expr.name === "slice" && expr.args.length === 1) {
    const k = asNonNegIntLit(expr.args[0]!);
    if (k === undefined) return undefined;
    const inner = cdrOffsetOf(expr.recv, param);
    return inner === undefined ? undefined : inner + k;
  }
  return undefined;
}

interface DestructureAnalysis {
  /** Qualifying `Index` node (by object identity) → its resolved tuple position. */
  readonly positions: ReadonlyMap<R, number>;
  readonly maxIndex: number;
}

/** Walk `body`, looking for occurrences of `param`. Returns `null` when the
 *  parameter is never index-accessed at all, or is used WHOLE anywhere (a single
 *  stray occurrence disqualifies the whole parameter — mercury's own rule). */
function analyzeParam(body: R, param: Binding): DestructureAnalysis | null {
  let stray = false;
  const positions = new Map<R, number>();
  let maxIndex = -1;

  const visit = (n: R): void => {
    if (stray) return;
    if (n.t === "Index") {
      const k = asNonNegIntLit(n.index);
      if (k !== undefined) {
        const offset = cdrOffsetOf(n.recv, param);
        if (offset !== undefined) {
          const pos = offset + k;
          positions.set(n, pos);
          maxIndex = Math.max(maxIndex, pos);
          return; // fully accounted for — do not also flag the buried Ref as stray
        }
      }
    }
    if (n.t === "Ref" && n.binding === param) {
      stray = true;
      return;
    }
    for (const c of childrenOf(n)) visit(c);
  };
  visit(body);

  if (stray || positions.size === 0) return null;
  return { positions, maxIndex };
}

/** Destructure every ELIGIBLE parameter against `body` (a param list may have
 *  several eligible params; each is analyzed and rewritten independently — they
 *  are distinct Binding objects, so one parameter's rewrite can never touch
 *  another's occurrences). Shared by both param-carrying shapes this algebra
 *  has: an `Arrow` (body may be a bare expression) and a top-level `FnDecl`
 *  (body is always a `Block`) — a top-level `(define (f params…) body…)`
 *  compiles straight to `FnDecl` (walk.ts's top-level dispatch), never wrapped
 *  in an Arrow, so `FnDecl.params`/`.body` need the SAME treatment; an INTERNAL
 *  (non-top-level) define compiles to `Const(name, Arrow(...))` instead, which
 *  the `Arrow` case below already covers. */
function destructureAgainst<B extends R>(
  params: readonly Param[],
  body: B,
  taken: Set<string>,
): { params: readonly Param[]; body: B } {
  let curParams = params;
  let curBody: R = body;
  for (let i = 0; i < curParams.length; i++) {
    const p = curParams[i]!;
    if (p.pattern.t !== "Binding") continue; // already an ArrayPattern/RestBinding — skip
    const analysis = analyzeParam(curBody, p.pattern);
    if (analysis === null) continue;
    const slotNames = analysis.maxIndex === 0 ? ["head"] : Array.from({ length: analysis.maxIndex + 1 }, (_v, k) => ordinalName(k));
    const slots = slotNames.map((name) => mintReadable(name, taken));
    curBody = substituteBy(curBody, (n) => {
      const pos = analysis.positions.get(n);
      return pos === undefined ? undefined : { t: "Ref" as const, binding: slots[pos]! };
    });
    curParams = curParams.map((q, j) => (j === i ? { pattern: ArrayPattern(slots) } : q));
  }
  // Runtime-safe: `substituteBy`/`mapChildren` never change a node's `t` discriminant
  // (mapBlockChildren preserves "Block"; a bare expression's root is never itself a
  // qualifying Index, since `positions` only ever holds nested Index nodes) — `curBody`
  // is still shaped like `B` even though the generic plumbing types it as `R`.
  return { params: curParams, body: curBody as B };
}

function destructureArrow(arrow: Extract<R, { t: "Arrow" }>, taken: Set<string>): Extract<R, { t: "Arrow" }> {
  const { params, body } = destructureAgainst(arrow.params, arrow.body, taken);
  return { ...arrow, params, body };
}

function rewriteNode(n: R, taken: Set<string>): R {
  const recursed = mapChildren(n, (child) => rewriteNode(child, taken));
  return recursed.t === "Arrow" ? destructureArrow(recursed, taken) : recursed;
}

function rewriteDecl(d: Decl, taken: Set<string>): Decl {
  switch (d.t) {
    case "FnDecl": {
      const bodyWithNestedArrowsDone = { ...d.body, stmts: d.body.stmts.map((s) => rewriteNode(s, taken)) };
      const { params, body } = destructureAgainst(d.params, bodyWithNestedArrowsDone, taken);
      return { ...d, params, body };
    }
    case "ConstDecl":
      return { ...d, init: rewriteNode(d.init, taken) };
    case "DeclComment":
      return { ...d, decl: rewriteDecl(d.decl, taken) };
    case "Import":
    case "ImportType":
    case "Export":
      return d;
  }
}

/** The whole-unit entry point. Pure: never mutates `unit`. */
export function destructureParams(unit: CompilationUnit): CompilationUnit {
  const taken = collectBoundNames(unit);
  return {
    decls: unit.decls.map((d) => rewriteDecl(d, taken)),
    body: unit.body.map((s) => rewriteNode(s, taken)),
  };
}
