/**
 * read-set soundness — the #74 adversarial gate (2026-07-17).
 *
 * THE CHANGE this suite gates: `ExtractCtx.memo`/`riskProbes` (src/extract/
 * index.ts) upgraded from a 1-BIT "was `reducing` ever consulted" flag to a
 * READ-SET — which `reducing`-membership checks a Bound's extraction actually
 * performed, and what each one observed (`RiskProbe.reads`, `MemoEntry.reads`,
 * `readSetMatches`). The 1-bit rule was SOUND but needlessly conservative: any
 * consultation of `reducing`'s content — hit OR miss — poisoned the whole
 * cache entry, so a Bound whose extraction merely passed THROUGH a call that
 * happened to check `reducing` (without ever being on a genuinely cyclic
 * path) was never cached at all. The read-set is the borrowed SAC/Adapton
 * shape (Acar et al.): cache the CONDITION under which the result is valid,
 * not just its absence, and validate that condition — not just "was it ever
 * touched" — at every future reference point.
 *
 * THE RISK this suite exists to refuse: upgrading a cache from "never share
 * anything context-dependent" to "share when the recorded context matches"
 * is exactly the kind of change that could accidentally serve a cached
 * result to a reference point whose ambient `ctx.reducing` DISAGREES with
 * what produced it — silently laundering a clean (const) attribution into an
 * opaque-requiring site, or vice versa. Every row below builds a Bound whose
 * correct answer genuinely DIFFERS depending on the reducing-context of the
 * reference point, and asserts BOTH answers land where they belong — never
 * swapped, never shared across the divergence.
 *
 * Row 1 is THE pinned soundness row: `ExtractCtx.riskProbes`'s own worked
 * counterexample (index.ts), verbatim — the doc comment's argument made
 * executable. Rows 2-4 generalize the same property to three more call
 * shapes (mutual recursion, a `map`-desugared Fan wrapper, and three-way
 * nesting) so the read-set's soundness isn't pinned only for self-recursion.
 */
import { describe, expect, it } from "vitest";

import { classify } from "../../coreform/index.js";
import { desugar } from "../../front/desugar.js";
import { parseSexprs } from "../../front/parse.js";
import { extractProgram } from "../../extract/index.js";
import { defaultRegistry } from "../../extract/arm-containers.js";
import type { StaticProv } from "../../model/static-prov.js";
import { matches, type ProvPattern } from "./fixture-corpus.js";

const run = (src: string): StaticProv => extractProgram(classify(desugar(parseSexprs(src))).forms, defaultRegistry);

const CLEAN_CONST: ProvPattern = { kind: "const" };
const cyclicOpaque: ProvPattern = { kind: "opaque", reason: "cyclic-binding" };

describe("read-set soundness — row 1, THE pinned counterexample (ExtractCtx.riskProbes's own doc, verbatim)", () => {
  // (define (idf x) x) (define shared (idf 42)) (define (f n) (if (= n 0)
  // (idf shared) (f (- n 1)))) — `shared` resolved directly must extract
  // cleanly (a ConstProv); resolved from inside `f`'s body — where `idf` is
  // ALREADY mid-reduction for the OUTER `(idf shared)` call — must opaque on
  // the INNER `(idf 42)` betaReduce. A 1-bit rule refuses to cache EITHER
  // (both consult `reducing`); the read-set must tell them apart instead.
  const SOURCE = `
(define (idf x) x)
(define shared (idf 42))
(define (f n) (if (= n 0) (idf shared) (f (- n 1))))
(list shared (f 0))
`;

  it("the direct reference to `shared` extracts CLEAN — a bare ConstProv, no opaque anywhere", () => {
    const prov = run(SOURCE);
    if (prov.kind !== "build") throw new Error("expected build");
    expect(matches(prov.parts[0]!.prov, CLEAN_CONST)).toBe(true);
  });

  it("the reference to `shared` from inside `f` (via `(idf shared)`) opaques — cyclic-binding, NOT the clean const", () => {
    const prov = run(SOURCE);
    if (prov.kind !== "build") throw new Error("expected build");
    const fCall = prov.parts[1]!.prov;
    expect(fCall.kind).toBe("choice");
    if (fCall.kind !== "choice") throw new Error("expected choice");
    // alts[0] = the `(idf shared)` base branch; alts[1] = `f`'s own
    // ordinary self-recursion (a second, unrelated cyclic-binding).
    expect(matches(fCall.alts[0]!, cyclicOpaque)).toBe(true);
    expect(matches(fCall.alts[1]!, cyclicOpaque)).toBe(true);
  });

  it("NO LAUNDERING: the two resolutions of the SAME `shared` Bound never share a value — the clean const is not the same node as the opaque, in either direction", () => {
    const prov = run(SOURCE);
    if (prov.kind !== "build") throw new Error("expected build");
    const direct = prov.parts[0]!.prov;
    const fCall = prov.parts[1]!.prov;
    if (fCall.kind !== "choice") throw new Error("expected choice");
    const nested = fCall.alts[0]!;
    expect(direct.kind).toBe("const");
    expect(nested.kind).toBe("opaque");
    expect(direct).not.toBe(nested); // distinct objects, distinct kinds — never swapped
  });

  it("ORDER-INDEPENDENT: reversing which reference point is extracted first (nested before direct) produces the SAME two correct answers", () => {
    // The memo write happens on whichever reference point is extracted
    // FIRST; a sound design must not let that accident of evaluation order
    // determine correctness — the read-set must be validated (and, on a
    // mismatch, re-derived) regardless of which context wrote the cache.
    const reversed = `
(define (idf x) x)
(define shared (idf 42))
(define (f n) (if (= n 0) (idf shared) (f (- n 1))))
(list (f 0) shared)
`;
    const prov = run(reversed);
    if (prov.kind !== "build") throw new Error("expected build");
    const fCall = prov.parts[0]!.prov;
    const direct = prov.parts[1]!.prov;
    expect(matches(direct, CLEAN_CONST)).toBe(true);
    expect(fCall.kind).toBe("choice");
    if (fCall.kind !== "choice") throw new Error("expected choice");
    expect(matches(fCall.alts[0]!, cyclicOpaque)).toBe(true);
  });
});

describe("read-set soundness — row 2, mutual recursion (p calls q, not self-recursion; a longer defer chain val→x→y)", () => {
  // (define (p x) (q x)) (define (q y) y) (define val (q 7)) — `val` resolved
  // directly is clean; resolved from `loop`'s base branch via `(p val)` —
  // where `q` is ALREADY mid-reduction (p forwards straight into q, and val's
  // OWN definition also calls q) — must opaque. Generalizes row 1's mechanism
  // from self-recursion to a two-function mutual chain plus an extra
  // Ref-to-Ref defer hop (val's value flows through p's param `x` before
  // q's param `y` ever sees it).
  const SOURCE = `
(define (p x) (q x))
(define (q y) y)
(define val (q 7))
(define (loop n) (if (= n 0) (p val) (loop (- n 1))))
(list val (loop 0))
`;

  it("the direct reference to `val` extracts CLEAN", () => {
    const prov = run(SOURCE);
    if (prov.kind !== "build") throw new Error("expected build");
    expect(matches(prov.parts[0]!.prov, CLEAN_CONST)).toBe(true);
  });

  it("the reference to `val` from inside loop→p→q opaques — never the cached clean const", () => {
    const prov = run(SOURCE);
    if (prov.kind !== "build") throw new Error("expected build");
    const loopCall = prov.parts[1]!.prov;
    expect(loopCall.kind).toBe("choice");
    if (loopCall.kind !== "choice") throw new Error("expected choice");
    expect(matches(loopCall.alts[0]!, cyclicOpaque)).toBe(true); // (p val)
    expect(matches(loopCall.alts[1]!, cyclicOpaque)).toBe(true); // loop's own recursion
  });
});

describe("read-set soundness — row 3, a map/buildFan wrapper as the outer reducing context", () => {
  // `probe` is invoked as a `map` FAN target (buildFan's own `ctx.reducing.
  // has(target)` check, not betaReduce's), and its body re-enters `idf` —
  // the same idf/shared divergence as row 1, but reached through the fourth
  // markRead call site (buildFan, arm-containers.ts) instead of an ordinary
  // recursive DefineFn.
  const SOURCE = `
(define (idf x) x)
(define shared (idf 42))
(define (probe el) (idf shared))
(list shared (map probe (list 1 2 3)))
`;

  it("the direct reference to `shared` extracts CLEAN", () => {
    const prov = run(SOURCE);
    if (prov.kind !== "build") throw new Error("expected build");
    expect(matches(prov.parts[0]!.prov, CLEAN_CONST)).toBe(true);
  });

  it("the reference to `shared` from inside the fan body (`probe`) opaques — never the cached clean const", () => {
    const prov = run(SOURCE);
    if (prov.kind !== "build") throw new Error("expected build");
    const fan = prov.parts[1]!.prov;
    expect(fan.kind).toBe("fan");
    if (fan.kind !== "fan") throw new Error("expected fan");
    expect(matches(fan.body, cyclicOpaque)).toBe(true);
  });
});

describe("read-set soundness — row 4, three-way divergence (direct, once-nested, twice-nested)", () => {
  // `g` calls `f` calls `idf`; `shared` is referenced from THREE distinct
  // reducing-contexts (direct: `reducing={}`; via `f`: `reducing⊇{f,idf}`;
  // via `g`→`f`: `reducing⊇{g,f,idf}`). The two nested contexts both observe
  // `idf` reducing (they must both opaque, and MAY legitimately share that
  // opaque with each other — that would be a correct, GEPA-style share, not
  // a forge), but NEITHER may ever serve the direct context's clean const.
  const SOURCE = `
(define (idf x) x)
(define shared (idf 42))
(define (f n) (if (= n 0) (idf shared) (f (- n 1))))
(define (g n) (if (= n 0) (f 0) (g (- n 1))))
(list shared (f 0) (g 0))
`;

  it("the direct reference to `shared` extracts CLEAN", () => {
    const prov = run(SOURCE);
    if (prov.kind !== "build") throw new Error("expected build");
    expect(matches(prov.parts[0]!.prov, CLEAN_CONST)).toBe(true);
  });

  it("both the once-nested (f) and twice-nested (g→f) references opaque — never the cached clean const", () => {
    const prov = run(SOURCE);
    if (prov.kind !== "build") throw new Error("expected build");

    const fCall = prov.parts[1]!.prov;
    expect(fCall.kind).toBe("choice");
    if (fCall.kind !== "choice") throw new Error("expected choice");
    expect(matches(fCall.alts[0]!, cyclicOpaque)).toBe(true);

    const gCall = prov.parts[2]!.prov;
    expect(gCall.kind).toBe("choice");
    if (gCall.kind !== "choice") throw new Error("expected choice");
    const nestedFCall = gCall.alts[0]!; // g's base branch is `(f 0)`
    expect(nestedFCall.kind).toBe("choice");
    if (nestedFCall.kind !== "choice") throw new Error("expected choice");
    expect(matches(nestedFCall.alts[0]!, cyclicOpaque)).toBe(true);
  });
});
