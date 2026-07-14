/**
 * typefacts/derive — ts.Type → TypeFacts (spec §3's derivation rules) plus the
 * query-free structural derivations for Lit/Quote.
 *
 * Every claim is ONE-SIDED (spec §3: "no `false` value in the vocabulary") and
 * every derivation that cannot positively conclude omits the field — Law F needs
 * absence, never a wrong `true`.
 *
 * Union/intersection discipline (soundness by quantifier):
 *   - a UNION claims a fact iff EVERY constituent claims it (∀ — the value could
 *     be any constituent); `lengthAtLeast` takes the min.
 *   - an INTERSECTION claims a fact iff SOME constituent claims it (∃ — the value
 *     IS every constituent simultaneously, so any member's guarantee holds);
 *     `lengthAtLeast` takes the max. This is the shape `pair?`-narrowing actually
 *     produces (`List<number> & Pair<unknown, unknown>` — probe-verified).
 */
import ts from "typescript";

import { hasFacts, type TypeFacts } from "./facts.js";
import type { LitValue, QuoteDatum } from "../coreform/index.js";

const ANY_OR_UNKNOWN = ts.TypeFlags.Any | ts.TypeFlags.Unknown;

/** Depth cap for nested TypeFacts (spec §6 E8: element-of-element, i.e. nested
 *  facts exist at depths 1 and 2, none deeper). Applied uniformly to
 *  `elementFacts` AND `callable`/`paramFacts` recursion — derivation is on types,
 *  and the cap is what breaks lazy self-reference (`f: (g: typeof f) => …`). */
const DEPTH_CAP = 2;

export interface DeriveContext {
  readonly checker: ts.TypeChecker;
  /** The queried occurrence — positional anchor for `getTypeOfSymbolAtLocation`
   *  (per-occurrence discipline, spec §5). */
  readonly atNode: ts.Node;
  /** The prelude's virtual file name — the `Pair` alias declaration-identity
   *  anchor (spec §3: a name-only match would false-positive against any
   *  host-injected `.d.ts` that happens to declare its own `Pair`). */
  readonly preludeFile: string;
}

/**
 * Derive the closed fact vocabulary from a checked type at one occurrence.
 * Returns `null` iff the type itself is `any`/`unknown`/error (the Law-F hole
 * signal — E4); a `{}` result means "checked fine, vocabulary silent".
 */
export function deriveFacts(type: ts.Type, ctx: DeriveContext, depth: number): TypeFacts | null {
  if (type.flags & ANY_OR_UNKNOWN) return null;
  const { checker } = ctx;
  const facts: TypeFacts = {};

  if (scalarClaim(type, ts.TypeFlags.BooleanLike)) facts.boolean = true;

  const minLen = tupleClaim(type, checker);
  if (minLen !== null && minLen >= 1) {
    facts.nonEmptyList = true;
    facts.lengthAtLeast = minLen;
  }
  if (minLen !== null || listClaim(type, checker)) facts.list = true;
  if (pairClaim(type, ctx)) facts.pair = true;

  if (facts.list && depth < DEPTH_CAP) {
    const el = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
    if (el && !(el.flags & ANY_OR_UNKNOWN)) {
      const elementFacts = deriveFacts(el, ctx, depth + 1);
      if (elementFacts && hasFacts(elementFacts)) facts.elementFacts = elementFacts;
    }
  }

  if (depth < DEPTH_CAP) {
    const callable = callableClaim(type, ctx, depth);
    if (callable) facts.callable = callable;
  }

  if (scalarClaim(type, ts.TypeFlags.StringLike)) facts.stringy = true;
  if (scalarClaim(type, ts.TypeFlags.NumberLike)) facts.numeric = true;
  return facts;
}

/** Flag-based claim with the ∀-union / ∃-intersection walk. The direct check
 *  handles the intrinsics (`boolean` carries the Boolean flag itself). */
function scalarClaim(t: ts.Type, flag: ts.TypeFlags): boolean {
  if (t.flags & flag) return true;
  if (t.isUnion()) return t.types.length > 0 && t.types.every((m) => scalarClaim(m, flag));
  if (t.isIntersection()) return t.types.some((m) => scalarClaim(m, flag));
  return false;
}

/** Tuple fixed-prefix depth (`target.minLength` — `[T, ...T[]]` has prefix 1,
 *  `Pair<H,T>` has 2), or `null` when not provably a tuple. */
function tupleClaim(t: ts.Type, checker: ts.TypeChecker): number | null {
  if (checker.isTupleType(t)) return (t as ts.TupleTypeReference).target.minLength;
  if (t.isUnion()) {
    if (t.types.length === 0) return null;
    let min = Number.POSITIVE_INFINITY;
    for (const m of t.types) {
      const v = tupleClaim(m, checker);
      if (v === null) return null;
      min = Math.min(min, v);
    }
    return min;
  }
  if (t.isIntersection()) {
    let max: number | null = null;
    for (const m of t.types) {
      const v = tupleClaim(m, checker);
      if (v !== null) max = max === null ? v : Math.max(max, v);
    }
    return max;
  }
  return null;
}

function listClaim(t: ts.Type, checker: ts.TypeChecker): boolean {
  if (checker.isArrayLikeType(t)) return true;
  if (t.isUnion()) return t.types.length > 0 && t.types.every((m) => listClaim(m, checker));
  if (t.isIntersection()) return t.types.some((m) => listClaim(m, checker));
  return false;
}

/** Alias-symbol detection ONLY, with the declaration-identity check (spec §3 +
 *  §6 E7: `aliasSymbol` does not survive every type operation — under-fire is
 *  accepted, Law F direction; the identity check guards the OVER-fire direction). */
function pairClaim(t: ts.Type, ctx: DeriveContext): boolean {
  const alias = t.aliasSymbol;
  if (alias?.name === "Pair" && alias.declarations?.some((d) => d.getSourceFile().fileName === ctx.preludeFile)) {
    return true;
  }
  if (t.isUnion()) return t.types.length > 0 && t.types.every((m) => pairClaim(m, ctx));
  if (t.isIntersection()) return t.types.some((m) => pairClaim(m, ctx));
  return false;
}

/** Spec §3 `callable`: first call signature; `arity` absent under a rest param
 *  (⇒ no eta, per registry-emit's gating); each param's type read AT THIS
 *  LOCATION. Exported for the probe (extract.ts derives callable from a
 *  contextual/resolved-signature type through the same rules). */
export function callableClaim(
  t: ts.Type,
  ctx: DeriveContext,
  depth: number,
): NonNullable<TypeFacts["callable"]> | undefined {
  const sig = ctx.checker.getSignaturesOfType(t, ts.SignatureKind.Call)[0];
  if (!sig) return undefined;
  const rest = hasRestParameter(sig);
  const out: NonNullable<TypeFacts["callable"]> = {};
  if (!rest) out.arity = sig.parameters.length;
  const fixed = rest ? sig.parameters.slice(0, -1) : sig.parameters;
  const paramFacts: TypeFacts[] = [];
  for (const p of fixed) {
    const pt = ctx.checker.getTypeOfSymbolAtLocation(p, ctx.atNode);
    const pf = pt.flags & ANY_OR_UNKNOWN ? null : deriveFacts(pt, ctx, depth + 1);
    // Positional array — an unprovable param keeps its slot as `{}` (Law F:
    // absence of claims, not absence of the slot).
    paramFacts.push(pf ?? {});
  }
  if (paramFacts.some(hasFacts)) out.paramFacts = paramFacts;
  return out;
}

function hasRestParameter(sig: ts.Signature): boolean {
  const decl = sig.parameters.at(-1)?.valueDeclaration;
  return decl !== undefined && ts.isParameter(decl) && decl.dotDotDotToken !== undefined;
}

// ── structural derivations (spec §3 table, Lit/Quote row: "no query — facts
//    derived structurally from the literal itself; cheap, and exact by
//    construction"). Probe-verified to be STRICTLY more precise than querying:
//    the emitted `[1, 2]` widens to `number[]`, while the datum is provably a
//    2-tuple. ─────────────────────────────────────────────────────────────────

export function litFacts(v: LitValue): TypeFacts {
  switch (v.kind) {
    case "number":
      return { numeric: true };
    case "string":
      return { stringy: true };
    case "boolean":
      return { boolean: true };
    default:
      // keyword (accessor head) / classification-synthesized undefined filler —
      // nothing in the vocabulary.
      return {};
  }
}

export function quoteFacts(d: QuoteDatum, depth = 0): TypeFacts {
  switch (d.kind) {
    case "number":
      return { numeric: true };
    case "string":
      return { stringy: true };
    case "boolean":
      return { boolean: true };
    case "symbol":
      // Representation law (§2.1): symbol → interned name — the compiled world's
      // (and the virtual TS's) face is a string.
      return { stringy: true };
    case "list": {
      const facts: TypeFacts = { list: true };
      if (d.items.length >= 1) {
        facts.nonEmptyList = true;
        facts.lengthAtLeast = d.items.length;
        if (depth < DEPTH_CAP) {
          const element = d.items.map((i) => quoteFacts(i, depth + 1)).reduce(intersectStructural);
          if (hasFacts(element)) facts.elementFacts = element;
        }
      }
      return facts;
    }
  }
}

/** ∀-merge across a quoted list's items — a fact holds for the ELEMENT type only
 *  when every item claims it. Structural facts never carry `callable`. */
function intersectStructural(a: TypeFacts, b: TypeFacts): TypeFacts {
  const out: TypeFacts = {};
  if (a.boolean && b.boolean) out.boolean = true;
  if (a.nonEmptyList && b.nonEmptyList) out.nonEmptyList = true;
  if (a.lengthAtLeast !== undefined && b.lengthAtLeast !== undefined) {
    out.lengthAtLeast = Math.min(a.lengthAtLeast, b.lengthAtLeast);
  }
  if (a.list && b.list) out.list = true;
  if (a.pair && b.pair) out.pair = true;
  if (a.elementFacts && b.elementFacts) {
    const el = intersectStructural(a.elementFacts, b.elementFacts);
    if (hasFacts(el)) out.elementFacts = el;
  }
  if (a.stringy && b.stringy) out.stringy = true;
  if (a.numeric && b.numeric) out.numeric = true;
  return out;
}
