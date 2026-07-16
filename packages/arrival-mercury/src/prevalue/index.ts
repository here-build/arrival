/**
 * STATIC PREVALUATION — a three-valued constant evaluator over CoreForm's
 * `if`/`and`/`or` (docs/working-proposals/arrival-mercury/dnf-prevaluation-
 * evidence.md; gate3-human-grade-rulings.md's R-G6, "not a sidecar re-ruling").
 * Ported in SPIRIT, not code, from here.build's `analyzeExprSemantics` (the
 * evidence memo's §3/§6: "a generic three-valued expression-semantics
 * evaluator... needing re-derivation only at the syntax-dispatch layer"): the
 * same three-valued short-circuit table (literal / and / or / if), re-derived
 * over Scheme forms instead of `ts.SyntaxKind`. What does NOT transfer (per
 * the evidence memo §6): cascade ordering, variant scope-pruning, SAT — this
 * package has no variant space, so none of that has an analog here.
 *
 * SCHEME TRUTHINESS, not JS truthiness — the whole point R-G6's worked
 * examples name explicitly: ONLY `#f` is false. `0`, `""`, `'()`, and every
 * other literal value is TRUE. Getting this backwards would silently invert
 * `(if 0 "a" "b")` from `"a"` (correct) to `"b"` (a JS-truthy bug) — see
 * `truthy-zero-then`/`truthy-empty-string`/`truthy-empty-list` in
 * `__tests__/corpus/`, the dedicated regression rows for exactly this class
 * of mistake.
 *
 * WHY `if`/`and`/`or` NEED NO SHADOW GUARD (unlike `../peepholes/`'s
 * `car`/`infer` idioms): those idioms key on ordinary REGISTRY SYMBOLS — an
 * `App` whose head a program can locally rebind (`(let ((car identity)) …)`),
 * so `idiomDecisionAt` carries a whole-program shadow census
 * (`programShadowsPeepholeNames`) to stay sound. `if`/`and`/`or` are SPECIAL
 * FORMS `classify()` itself recognizes structurally, from the raw head atom,
 * before any scope exists at all (`coreform/classify.ts`'s `classifyList`
 * switch) — a Scheme program cannot shadow them; `(if …)` unconditionally
 * classifies to an `If` CoreForm node no matter what `if` is locally bound
 * to. So `prevalueDecisionAt` is a PURE function of its own subtree — no
 * `shadowed`/`mintId`/`recurse` dependency set the way `IdiomDeps`
 * (`../peepholes/index.ts`) needs.
 *
 * SCOPE (R-G6: "start minimal"): literals, quoted data, and `if`/`and`/`or`
 * built from already-provable parts. Comparisons, `not` (an ordinary
 * registry-symbol `App`, not a special form — folding it would need the
 * SAME shadow-guard machinery `../peepholes/` carries, for a case none of
 * this wave's worked examples need), and any registry-function's return
 * value (`(list)`, `(pair? x)`, …) are honestly "unknown" — folding those
 * would need type/registry-semantic reasoning this evaluator deliberately
 * doesn't carry. Noted as follow-up, not silently dropped.
 */
import type { And, CoreForm, If, Or } from "../coreform/types.js";

export type Prevalue = "true" | "false" | "unknown";

/**
 * The pure three-valued judgment (never mutates, never throws): `"true"`/
 * `"false"` iff `node`'s VALUE is provably, unconditionally that Scheme
 * truth-direction; `"unknown"` otherwise — the safe default (Law F:
 * absence of proof is not evidence of falsity — fold ONLY provable
 * constants, never a maybe). Recursive over the handful of shapes whose
 * value needs zero runtime information to know: a literal, a quoted datum,
 * and `if`/`and`/`or` built from already-provable parts. Everything else
 * (`App`, `Ref`, `Let`, `Lambda`, `Begin`, `Dict`, …) is `"unknown"` — this
 * function never consults the registry, type facts, or scope; it can be
 * incomplete, never wrong.
 */
export function prevalue(node: CoreForm): Prevalue {
  switch (node.kind) {
    case "Lit":
      if (node.value.kind === "boolean") return node.value.value ? "true" : "false";
      // A bare `:kw` reaching expression position is already a
      // malformed-source case `lowerLit` doors on its own — not a real
      // truth value either way; stay honestly unknown rather than guess.
      if (node.value.kind === "keyword") return "unknown";
      return "true"; // number / string / undefined — only #f is false
    case "Quote":
      // Quoting a self-evaluating literal doesn't change its value: '#f IS
      // #f. Every other datum — including '() (the classic Lisp gotcha
      // Scheme resolves the OTHER way: the empty list is truthy) — is true.
      return node.datum.kind === "boolean" && !node.datum.value ? "false" : "true";
    case "If": {
      const c = prevalue(node.cond);
      if (c === "true") return prevalue(node.then);
      if (c === "false") return prevalue(node.else);
      return "unknown";
    }
    case "And": {
      let last: Prevalue = "true"; // (and) → #t — the identity element
      for (const a of node.args) {
        const v = prevalue(a);
        if (v === "false") return "false"; // short-circuits — provably false
        if (v === "unknown") return "unknown"; // can't see past a live unknown
        last = v; // "true" — and keeps evaluating
      }
      return last; // every operand proved true — value is the last one's
    }
    case "Or": {
      let last: Prevalue = "false"; // (or) → #f — the identity element
      for (const a of node.args) {
        const v = prevalue(a);
        if (v === "true") return "true"; // short-circuits — provably true
        if (v === "unknown") return "unknown";
        last = v; // "false" — or keeps evaluating
      }
      return last;
    }
    default:
      return "unknown";
  }
}

/**
 * Scan `args` left to right for `kind`'s fold: `stopOn` is the prevalue that
 * SHORT-CIRCUITS the chain (everything strictly after it is unreachable —
 * dead code, dropped whole); `dropOn` is the prevalue that is provably
 * INERT mid-chain (contributes nothing — safe to drop, since anything
 * `prevalue` tags `"true"`/`"false"` is, by construction, built only from
 * literals/quotes/and/or/if of those, hence side-effect-free) PROVIDED a
 * LATER operand still exists to carry the chain forward — the final
 * operand is never dropped for inertness alone (and/or's own "value is the
 * last operand" rule needs it to remain, and an empty `kept` would be a
 * lie: some value must survive). Returns `undefined` when nothing changed
 * — the walker's "decline the optimization" signal, matching
 * `../peepholes/`'s own idiom-decision convention.
 *
 * TERMINATES: `changed` is set only when an operand is actually dropped or
 * a tail actually truncated, so a fold strictly shrinks the arg count;
 * `kept.length >= 1` always holds when `changed` is true (the final index,
 * if ever reached, is unconditionally pushed — via the `stopOn` break or by
 * falling through the loop's last iteration untouched).
 */
function foldChainArgs(args: readonly CoreForm[], stopOn: Prevalue, dropOn: Prevalue): readonly CoreForm[] | undefined {
  const kept: CoreForm[] = [];
  let changed = false;
  const lastIndex = args.length - 1;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const pv = prevalue(arg);
    if (pv === stopOn) {
      kept.push(arg);
      if (i < lastIndex) changed = true; // a nonempty tail is now unreachable
      break;
    }
    if (pv === dropOn && i < lastIndex) {
      changed = true; // provably inert, and a later operand still carries the chain
      continue;
    }
    kept.push(arg);
  }
  return changed ? kept : undefined;
}

/**
 * `sm.prevalueOf`'s underlying decision (`../model/model.ts`) — the WALKER
 * consults it inline at the top of every `If`/`And`/`Or` it lowers
 * (`../walker/walk.ts`'s `lowerExpr`, and `tailLoopForm`'s own `If` arm,
 * which does not route through `lowerExpr`), exactly where `sm.idiomAt` is
 * consulted at the top of `lowerApp` (E2's own precedent — see that view's
 * doc in model.ts). Returns a REPLACEMENT node to lower INSTEAD of `node`
 * (the caller recurses through its own lowering entry point — a folded
 * `If`/`And`/`Or` may itself be further-foldable, exactly like `idiomAt`'s
 * own `if (idiom !== undefined) return lowerApp(idiom)` re-entry), or
 * `undefined` to decline (lower `node` normally — declining is always
 * safe, never wrong, per Law F).
 *
 * Id discipline (matching `../peepholes/infer.ts`'s own two cases): an
 * `If` fold or a single-survivor `And`/`Or` fold returns an EXISTING
 * sub-node verbatim — no identity question to answer, it is simply "the
 * live branch," a real node with its own id/span/facts already. A
 * multi-survivor `And`/`Or` trim (`{...node, args: kept}`) REUSES the
 * original id/span — "still the same and/or, just fewer operands," exactly
 * `cacheKeyElideAt`'s own precedent, not a fresh mint: nothing here fuses
 * two nodes into one the way scalar-fold does, so there is no "no single
 * node honestly owns this identity" question either.
 */
export function prevalueDecisionAt(node: If | And | Or): CoreForm | undefined {
  if (node.kind === "If") {
    const c = prevalue(node.cond);
    if (c === "true") return node.then;
    if (c === "false") return node.else;
    return undefined;
  }
  const stopOn: Prevalue = node.kind === "And" ? "false" : "true";
  const dropOn: Prevalue = node.kind === "And" ? "true" : "false";
  const kept = foldChainArgs(node.args, stopOn, dropOn);
  if (kept === undefined) return undefined;
  // foldChainArgs never returns an empty array (see its own doc) —
  // `changed=true` implies `kept.length >= 1`.
  return kept.length === 1 ? kept[0]! : { ...node, args: kept };
}
