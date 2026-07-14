/**
 * typefacts — extractFacts over the checked virtual TS (typefacts-extraction.md;
 * constitution §3.3/§5.3). Real tsc (6.0.2) against the REAL lens prelude
 * assembly (`getPreludeFiles()` — never a vendored copy), per program.
 *
 * ── The instantiated-signature probe: VERDICT (Gate-3-relevant) ──────────────
 * The constitution's one named unverified extraction assumption — "does tsc
 * deliver the instantiated signature for a symbol in argument position?" —
 * VERIFIES, empirically, on today's emitter output (probe run 2026-07-14,
 * tsc 6.0.2, this prelude): for `(map car xs)` the virtual TS is
 * `__arr.map(car, xs)` with `car` a FREE identifier (value-position lowering,
 * spec §4's flagged unowned prerequisite, has NOT landed), and STILL
 * `checker.getContextualType(car)` returns `(a: number) => unknown` — the slot's
 * expected type, param side instantiated from `xs`'s element type; the secondary
 * `getResolvedSignature` probe agrees. Contextual typing is positional, not
 * resolution-dependent, so the missing lowering costs only the identifier's OWN
 * type (any ⇒ no base facts), never the slot's demand — which is exactly what
 * eta consumes ("what the slot demands, not what the symbol offers", §4.1).
 * The `callable` tests below are therefore LIVE assertions, not skips.
 *
 * What stays documented-unavailable: the spec §4 obligation-1 golden variant
 * where paramFacts carry `nonEmptyList` — that needs a TUPLE-typed list flowing
 * into the HOF, and no current list-constructor leaf returns tuples
 * (`list<T>(...xs: T[]): List<T>`; quote lowers to a widened array literal).
 * Obligation 2's dependency note covers this: the probe is correct, the clean
 * case fires once tuple leaves land. Law F covers the interim.
 */
import { describe, expect, it } from "vitest";

import type { ClassifyResult, CoreForm, Quote, Span } from "../coreform/index.js";
import { extractFacts } from "../typefacts/index.js";

/** The six is-typed lens guards (mirrors type-emit.test.ts — the registry
 *  harvest supplies this set at integration; tests pass it explicitly). */
const NARROWS: ReadonlySet<string> = new Set(["null?", "pair?", "string?", "number?", "boolean?", "array?", "list?"]);

// ── tiny classified-tree helpers (test-local; the extraction owns no public walker) ──

function allNodes(classified: ClassifyResult): CoreForm[] {
  const out: CoreForm[] = [];
  const visit = (n: CoreForm): void => {
    out.push(n);
    switch (n.kind) {
      case "Define":
        visit(n.value);
        if (n.overridableType) visit(n.overridableType);
        break;
      case "DefineFn":
      case "Lambda":
        n.body.forEach(visit);
        break;
      case "If":
        visit(n.cond);
        visit(n.then);
        visit(n.else);
        break;
      case "And":
      case "Or":
        n.args.forEach(visit);
        break;
      case "Let":
      case "NamedLet":
        for (const b of n.bindings) visit(b.init);
        n.body.forEach(visit);
        break;
      case "Begin":
        n.body.forEach(visit);
        break;
      case "App":
        visit(n.fn);
        n.positionalArgs.forEach(visit);
        for (const kw of n.kwargs) visit(kw.value);
        break;
      case "Dict":
        for (const e of n.entries) visit(e.value);
        break;
      default:
        break;
    }
  };
  classified.forms.forEach(visit);
  return out;
}

/** Span of the `occurrence`-th (0-based) appearance of `text` in `src`. */
function spanOf(src: string, text: string, occurrence = 0): Span {
  let i = -1;
  for (let k = 0; k <= occurrence; k++) {
    i = src.indexOf(text, i + 1);
    if (i < 0) throw new Error(`spanOf: "${text}" occurrence ${occurrence} not found`);
  }
  return [i, i + text.length];
}

function nodeAt<K extends CoreForm["kind"]>(
  classified: ClassifyResult,
  kind: K,
  span: Span,
): Extract<CoreForm, { kind: K }> {
  const hits = allNodes(classified).filter(
    (n): n is Extract<CoreForm, { kind: K }> => n.kind === kind && n.span[0] === span[0] && n.span[1] === span[1],
  );
  expect(hits.length, `expected exactly one ${kind} at [${span[0]}, ${span[1]})`).toBe(1);
  return hits[0]!;
}

// ── boolean — the highest-stakes fact (§8 item 3) ─────────────────────────────

describe("extractFacts: boolean fact", () => {
  it("derives boolean on a comparison-typed condition — through the __scmTruth wrap", () => {
    const src = `(define b (if (= 1 2) "y" "n"))`;
    const r = extractFacts(src, { narrowsMembers: NARROWS }); // `=` is NOT narrows-flagged → wrapped
    expect(r.virtualTs).toContain("__scmTruth("); // precondition: this row exercises the wrapped path
    const cond = nodeAt(r.classified!, "App", spanOf(src, "(= 1 2)"));
    expect(r.facts.get(cond.id)).toEqual({ boolean: true });
    expect(r.holes.has(cond.id)).toBe(false);
  });

  it("NO boolean fact on an unknown-typed condition — the wrapper's own boolean return never leaks in", () => {
    // `(begin)` emits `(undefined as unknown)` → x: unknown. The condition wraps
    // as `__scmTruth(x)` whose CALL is boolean-typed — deriving from the wrapper
    // instead of the inner expression would false-positive `boolean` here and
    // reintroduce the §5.1 live bug. The exact-span join resolves to the inner
    // `x` (the wrapper records no span of its own).
    const src = `(define x (begin))\n(if x 'a 'b)`;
    const r = extractFacts(src);
    const cond = nodeAt(r.classified!, "Ref", spanOf(src, "x", 1));
    expect(r.facts.has(cond.id)).toBe(false);
    expect(r.holes.get(cond.id)).toBe("any-or-unknown");
  });

  it("a native (unwrapped) narrowing condition still carries boolean on the App row", () => {
    const src = `(define xs (list 1 2 3))\n(define r (if (pair? xs) 1 2))`;
    const r = extractFacts(src, { narrowsMembers: NARROWS });
    expect(r.virtualTs).not.toContain("__scmTruth"); // the grammar fired
    const cond = nodeAt(r.classified!, "App", spanOf(src, "(pair? xs)"));
    expect(r.facts.get(cond.id)?.boolean).toBe(true);
  });
});

// ── flow-sensitivity — per-occurrence extraction (§5; constitution §5.3) ──────

describe("extractFacts: flow-sensitive narrowing (the pair? row)", () => {
  const src = `(define xs (list 1 2 3))\n(define r (if (pair? xs) xs xs))`;
  const r = extractFacts(src, { narrowsMembers: NARROWS });
  // occurrences of `xs` in line 2: 1 = inside (pair? xs), 2 = then-arm, 3 = else-arm
  const condArg = nodeAt(r.classified!, "Ref", spanOf(src, "xs", 1));
  const thenArm = nodeAt(r.classified!, "Ref", spanOf(src, "xs", 2));
  const elseArm = nodeAt(r.classified!, "Ref", spanOf(src, "xs", 3));

  it("the then-arm occurrence carries the narrowed proof: nonEmptyList + pair", () => {
    // tsc narrows List<number> by `v is Pair<unknown>` to the INTERSECTION
    // List<number> & Pair<unknown, unknown> — the Pair member is a real 2-tuple
    // (minLength 2), and intersections claim by ∃.
    const f = r.facts.get(thenArm.id);
    expect(f?.nonEmptyList).toBe(true);
    expect(f?.lengthAtLeast).toBe(2);
    expect(f?.list).toBe(true);
    expect(f?.pair).toBe(true); // alias-symbol + declaration-identity (E7's over-fire guard)
    expect(f?.elementFacts).toEqual({ numeric: true }); // number & unknown = number
  });

  it("the SAME binding outside the narrowed arm has no non-emptiness proof", () => {
    for (const occurrence of [condArg, elseArm]) {
      const f = r.facts.get(occurrence.id);
      expect(f?.list).toBe(true);
      expect(f?.nonEmptyList).toBeUndefined();
      expect(f?.pair).toBeUndefined();
      expect(f?.elementFacts).toEqual({ numeric: true });
    }
  });
});

// ── callable — the instantiated-signature probe (§4; LIVE, see header) ───────

describe("extractFacts: callable facts at a HOF use site", () => {
  it("a FREE builtin name in argument position gets the slot's instantiated signature", () => {
    const src = `(define xs (list 1 2 3))\n(define r (map car xs))`;
    const r = extractFacts(src, { narrowsMembers: NARROWS });
    const car = nodeAt(r.classified!, "Ref", spanOf(src, "car"));
    // Own type is `any` (unresolved identifier — value-position lowering not
    // landed), so the ONLY facts are the probe's: the slot demands
    // `(a: number) => unknown`, instantiated against xs's element type.
    expect(r.facts.get(car.id)).toEqual({ callable: { arity: 1, paramFacts: [{ numeric: true }] } });
    expect(r.holes.has(car.id)).toBe(false);
  });

  it("a user-defined fn in argument position: instantiated slot facts win over the declared (n: any) => …", () => {
    const src = `(define xs (list 1 2 3))\n(define (add1 n) (+ n 1))\n(define r (map add1 xs))`;
    const r = extractFacts(src);
    const use = nodeAt(r.classified!, "Ref", spanOf(src, "add1", 1));
    const f = r.facts.get(use.id);
    expect(f?.callable?.arity).toBe(1);
    expect(f?.callable?.paramFacts).toEqual([{ numeric: true }]); // contextual, not the implicit-any param
  });

  it("probe-miss: an argument under an any-typed callee holes as probe-miss, never guesses", () => {
    const src = `(define r (g h))`; // g and h both free
    const r = extractFacts(src);
    const h = nodeAt(r.classified!, "Ref", spanOf(src, "h"));
    expect(r.facts.has(h.id)).toBe(false);
    expect(r.holes.get(h.id)).toBe("probe-miss");
  });
});

// ── Law F rows — every failure class is absence, never a wrong fact ──────────

describe("extractFacts: Law F holes", () => {
  it("an implicit-any lambda param occurrence yields no facts (any-or-unknown)", () => {
    const src = `(define (f q) (if q 1 2))`;
    const r = extractFacts(src);
    const q = nodeAt(r.classified!, "Ref", spanOf(src, "q", 1));
    expect(r.facts.has(q.id)).toBe(false);
    expect(r.holes.get(q.id)).toBe("any-or-unknown");
  });

  it("a free identifier in value position holes as any-or-unknown", () => {
    const src = `(define x free-name)`;
    const r = extractFacts(src);
    const ref = nodeAt(r.classified!, "Ref", spanOf(src, "free-name"));
    expect(r.facts.has(ref.id)).toBe(false);
    expect(r.holes.get(ref.id)).toBe("any-or-unknown");
  });

  it("whole-program parse failure: empty tables, parseFailure flag, no throw (E3)", () => {
    const r = extractFacts("(((");
    expect(r.parseFailure).toBe(true);
    expect(r.classified).toBeNull();
    expect(r.facts.size).toBe(0);
    expect(r.holes.size).toBe(0);
  });

  it("a (require …) directive drops silently — no queried nodes inside, no hole pollution", () => {
    const src = `(require "lib/util.scm")\n(define x 1)`;
    const r = extractFacts(src);
    expect(r.holes.size).toBe(0);
    const one = nodeAt(r.classified!, "Lit", spanOf(src, "1", 0));
    expect(r.facts.get(one.id)).toEqual({ numeric: true });
  });

  it("a proven type the vocabulary is silent about: no fact, no hole", () => {
    const src = `(define row (dict :a 1))\n(define r (if row 1 2))`;
    const r = extractFacts(src);
    const cond = nodeAt(r.classified!, "Ref", spanOf(src, "row", 1));
    expect(r.facts.has(cond.id)).toBe(false); // { a: number } — checked fine, nothing to claim
    expect(r.holes.has(cond.id)).toBe(false);
  });
});

// ── the span→NodeId join's ownership guard ────────────────────────────────────

describe("extractFacts: inherited-span ownership (the desugar-mint guard)", () => {
  it("a desugar-minted inner App inherits the outer span and must NOT inherit its facts", () => {
    // `(-> 5 (add1) (add1))` desugars to `(add1 (add1 5))`: the OUTER App carries
    // the thread form's span (withSpan), the INNER App is minted spanless and
    // classify gives it the nearest enclosing real span — the SAME span. The
    // mapping belongs to the outermost carrier (min NodeId); attaching the outer
    // call's type to the inner node would be wrong-and-confident.
    const src = `(define (add1 n) (+ n 1))\n(define r (-> 5 (add1) (add1)))`;
    const r = extractFacts(src);
    const span = spanOf(src, "(-> 5 (add1) (add1))");
    const apps = allNodes(r.classified!).filter(
      (n) => n.kind === "App" && n.span[0] === span[0] && n.span[1] === span[1],
    );
    expect(apps.length).toBe(2); // the collision this guard exists for
    const [outer, inner] = [...apps].sort((a, b) => a.id - b.id); // pre-order ids: outer first
    expect((outer as { positionalArgs: readonly CoreForm[] }).positionalArgs[0]!.id).toBe(inner!.id);
    expect(r.facts.get(outer!.id)).toEqual({ numeric: true }); // add1 returns number
    expect(r.facts.has(inner!.id)).toBe(false);
    expect(r.holes.get(inner!.id)).toBe("unmapped-span");
  });
});

// ── structural rows — Lit/Quote, exact by construction (§3 table) ─────────────

describe("extractFacts: structural derivation (no query)", () => {
  it("a numeric literal condition is numeric, never boolean — Law T's guard direction", () => {
    const src = `(if 0 'a 'b)`;
    const r = extractFacts(src);
    const zero = nodeAt(r.classified!, "Lit", spanOf(src, "0"));
    expect(r.facts.get(zero.id)).toEqual({ numeric: true });
  });

  it("a quoted list is a proven non-empty tuple — STRICTLY more precise than the widened emission", () => {
    // The emitted `[1, 2]` type-checks as number[]; the datum itself proves
    // length 2. Structural wins (probe-verified).
    const src = `(define p '(1 2))`;
    const r = extractFacts(src);
    const q = allNodes(r.classified!).find((n): n is Quote => n.kind === "Quote");
    expect(q).toBeDefined();
    expect(r.facts.get(q!.id)).toEqual({
      list: true,
      nonEmptyList: true,
      lengthAtLeast: 2,
      elementFacts: { numeric: true },
    });
  });

  it("a quoted symbol is stringy (representation law: symbol → interned name)", () => {
    const src = `(define s 'foo)`;
    const r = extractFacts(src);
    const q = allNodes(r.classified!).find((n): n is Quote => n.kind === "Quote");
    expect(r.facts.get(q!.id)).toEqual({ stringy: true });
  });
});

// ── per-occurrence + determinism plumbing ─────────────────────────────────────

describe("extractFacts: envelope", () => {
  it("accepts { source, classified } and keys the table into THAT classification", () => {
    const src = `(define xs (list 1 2 3))\n(define r (if (pair? xs) xs xs))`;
    const first = extractFacts(src, { narrowsMembers: NARROWS });
    const again = extractFacts({ source: src, classified: first.classified! }, { narrowsMembers: NARROWS });
    expect(again.classified).toBe(first.classified);
    const thenArm = nodeAt(first.classified!, "Ref", spanOf(src, "xs", 2));
    expect(again.facts.get(thenArm.id)).toEqual(first.facts.get(thenArm.id));
  });

  it("same source ⇒ identical fact tables (spec §7 determinism)", () => {
    const src = `(define xs (list 1 2 3))\n(define r (if (pair? xs) (car xs) 0))\n(define m (map car xs))`;
    const serialize = (x: ReturnType<typeof extractFacts>): string =>
      JSON.stringify([...x.facts.entries()].map(([id, f]) => [id, f]).concat([...x.holes.entries()] as never));
    const a = extractFacts(src, { narrowsMembers: NARROWS });
    const b = extractFacts(src, { narrowsMembers: NARROWS });
    expect(a.classified).not.toBe(b.classified); // ids re-minted per classify()…
    expect(serialize(a)).toBe(serialize(b)); // …but the tables are byte-identical
  });

  it("the guarded car row: the ARGUMENT occurrence carries the proof Law A consumes", () => {
    // The composition the whole design exists for: guard proves, use-site reads
    // the proof. Law A keys residual selection on ARGUMENT facts — and the xs
    // occurrence inside `(car xs)` carries nonEmptyList. The App's own result
    // row honestly holes today: `car<T>(xs: List<T>): T` against the narrowed
    // intersection `List<number> & Pair<unknown, unknown>` unifies T with the
    // Pair member's `unknown` (no non-empty overload on the current leaf — the
    // spec §4 obligation-2 types-track dependency). Law F direction: absent,
    // never wrong — and non-blocking, because rules never gate on result types.
    const src = `(define xs (list 1 2 3))\n(define r (if (pair? xs) (car xs) 0))`;
    const r = extractFacts(src, { narrowsMembers: NARROWS });
    const xsArg = nodeAt(r.classified!, "Ref", spanOf(src, "xs", 2));
    expect(r.facts.get(xsArg.id)?.nonEmptyList).toBe(true);
    expect(r.facts.get(xsArg.id)?.pair).toBe(true);
    const carApp = nodeAt(r.classified!, "App", spanOf(src, "(car xs)"));
    expect(r.facts.has(carApp.id)).toBe(false);
    expect(r.holes.get(carApp.id)).toBe("any-or-unknown"); // pinned: today's leaf, honest hole
  });
});
