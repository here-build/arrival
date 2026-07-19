// One-Number Rework (RATIO, crash-on-overflow) — W0 RED-FIRST test file.
//
// Pins docs/design-history/arrival-one-number-rework.md v2.1 §0 (invariants) and
// §2 (target design) at the SCHEME surface. Every row named in the plan's §3 W0 list
// becomes one assertion here (the §0.6 pinned-behaviors list is folded into the "box
// identity" describe block below — same rows, same meaning).
//
// Harness: `run()` mirrors boolean-landmine-regression.test.ts's helper — execState
// (COMPLEX tier) plus the boxed result's OWN `.toString()` — deliberately NOT `exec()`'s
// plain-JS exit. Reason: `exec()` goes through `toJS`, and per the plan's own "egress
// divides" law (§2.0), `toJS(1/3)` is the divided float `0.333…` for EITHER an exact
// rational OR a genuinely inexact division — the JS face collapses exactly the
// distinction this file exists to pin. Printing the BOX itself ("1/3" vs
// "0.3333333333333333") is the one channel that keeps exactness visible (AExact and
// AInexact already print differently: an integer-valued inexact gets a trailing ".0",
// a rational exact prints "num/denom"). The one deliberate exception is the `toJS`-face
// row itself, which exists to pin the membrane's divide-on-egress behavior — it uses
// `exec()` on purpose.
//
// Rows commented "RED until the atom lands" are EXPECTED to fail on HEAD — this file
// pins the plan's TARGET semantics before W2 (the representation atom) lands, per the
// TDD discipline the plan's W0 package calls for. Every other row is an ALREADY-TRUE
// pin: a regression guard proving present behavior (which the num/denom bigint→number
// port must not accidentally break) survives the rework.
import { describe, expect, it } from "vitest";
import { exec, execState } from "../eval/generator-exec.js";
import { ParseError } from "../errors.js";

async function run(src: string): Promise<string> {
  const { values: r } = await execState(src, {});
  const x = r[r.length - 1] as { toString(): string } | undefined;
  return String(x?.toString?.() ?? x);
}

describe("ratio construction — AExact is a genuine (num, denom) rational", () => {
  it("(/ 1 3) constructs an exact rational, printed 1/3 (not coerced to inexact)", async () => {
    expect(await run("(/ 1 3)")).toBe("1/3");
  });

  it("(exact? (/ 1 3)) is #t — non-integral exact division stays exact", async () => {
    expect(await run("(exact? (/ 1 3))")).toBe("#t");
  });

  it("(+ 1/3 1/3 1/3) sums to exact 1 (cross-multiply add, not float accumulation)", async () => {
    expect(await run("(+ 1/3 1/3 1/3)")).toBe("1");
  });

  it("(numerator (/ 6 4)) is 3 (reduced form 3/2)", async () => {
    expect(await run("(numerator (/ 6 4))")).toBe("3");
  });

  it("(denominator (/ 6 4)) is 2 (reduced form 3/2)", async () => {
    expect(await run("(denominator (/ 6 4))")).toBe("2");
  });

  // Egress DIVIDES (§2.0: "toJS(1/3) = 0.333…", the projection∘borrow law — same as
  // nil-as-array): the ONE row that deliberately uses `exec()` (the plain-JS membrane
  // exit) instead of `run()`, because it tests THAT collapse rather than resisting it.
  it("exec()'s JS face of (/ 1 3) is the divided float, not a rational object", async () => {
    const [r] = await exec("(/ 1 3)");
    expect(r).toBeCloseTo(1 / 3, 15);
  });
});

describe("overflow-throws — exact results whose components leave safe-integer range THROW", () => {
  // Both operands are individually safe — 9007199254740991 IS Number.MAX_SAFE_INTEGER,
  // itself a safe integer — deliberately NOT the plan's own literal example
  // `(+ 9007199254740992 1)`, whose first operand (2^53) already exceeds
  // Number.MAX_SAFE_INTEGER on its own and would conflate this row with the separate
  // "over-safe source LITERAL" row below. Safe operands + unsafe RESULT isolates the
  // arithmetic-overflow guarantee from the parser's literal gate.
  it("(+ 9007199254740991 1) rejects — exact addition overflowing 2^53 THROWS, never silently widens", async () => {
    // RED until the atom lands: today AExact is bigint-backed (no magnitude ceiling),
    // so this computes silently to a correct-but-unbounded exact bigint — no throw.
    await expect(run("(+ 9007199254740991 1)")).rejects.toThrow(/exact overflow/i);
  });

  it("(* 94906266 94906266) rejects — exact multiplication overflowing 2^53 THROWS", async () => {
    // RED until the atom lands (same reason: unbounded bigint today). 94906266 is
    // safe on its own (~9.5e7); its square (9007199326062756) exceeds
    // Number.MAX_SAFE_INTEGER (9007199254740991) — confirmed by direct computation.
    await expect(run("(* 94906266 94906266)")).rejects.toThrow(/exact overflow/i);
  });

  it("(* 94906266 94906266 94906266) rejects — per-step overflow check in a variadic fold", async () => {
    // RED until the atom lands. The plan's own W0 example (§3): a 3-arg `*` fold must
    // catch the overflow at whichever step first leaves safe range, not just at the
    // final accumulated result.
    await expect(run("(* 94906266 94906266 94906266)")).rejects.toThrow(/exact overflow/i);
  });

  it("an over-safe source LITERAL (2^53+1) is a ParseError, not a silently-huge exact", async () => {
    // RED until the atom lands: today's reader has no magnitude ceiling
    // (utils/parsing.ts's parseBigInt has no isSafeInteger gate), so this parses fine
    // into an unbounded exact bigint and evaluates without complaint.
    await expect(run("9007199254740993")).rejects.toBeInstanceOf(ParseError);
  });
});

describe("encode-edge exactness law — codec encode must not re-derive exactness from value shape", () => {
  // All four rows RED until the atom lands: `looseNumber`/`looseAnyNumber`/`z.bigint`'s
  // `encode` currently keys off `Number.isSafeInteger(result)` alone — an
  // integer-valued RESULT mints AExact regardless of whether either OPERAND was
  // inexact (common/scheme-zod.ts's encode arms). The fix (plan §2.2) threads
  // `wantExact` from the coerced operands' boxes instead of re-deriving it.
  it("(exact? (floor 2.5)) is #f — floor of an inexact stays inexact", async () => {
    expect(await run("(exact? (floor 2.5))")).toBe("#f");
  });

  it("(exact? (quotient 7.0 2)) is #f — quotient with an inexact operand stays inexact", async () => {
    expect(await run("(exact? (quotient 7.0 2))")).toBe("#f");
  });

  it("(exact? (gcd 4.0 6)) is #f — gcd with an inexact operand stays inexact", async () => {
    expect(await run("(exact? (gcd 4.0 6))")).toBe("#f");
  });

  it("(exact? (abs -0.0)) is #f — abs of an inexact stays inexact", async () => {
    expect(await run("(exact? (abs -0.0))")).toBe("#f");
  });
});

describe("box identity — exact and inexact are different boxes at equal numeric value", () => {
  it("(= 1 1.0) is #t — numeric equality crosses the exactness boundary", async () => {
    expect(await run("(= 1 1.0)")).toBe("#t");
  });

  it("(eqv? 1 1.0) is #f — eqv? is representation-typed, exact never eqv? inexact", async () => {
    expect(await run("(eqv? 1 1.0)")).toBe("#f");
  });

  it("(equal? 1 1.0) is #f — structural equality honors the same exactness boundary", async () => {
    expect(await run("(equal? 1 1.0)")).toBe("#f");
  });

  it("(eqv? 0.0 -0.0) is #f — inexact zero keeps its sign under eqv? (Object.is)", async () => {
    expect(await run("(eqv? 0.0 -0.0)")).toBe("#f");
  });

  it("(eqv? +nan.0 +nan.0) is #t — NaN is eqv?-reflexive (Object.is, not ===)", async () => {
    expect(await run("(eqv? +nan.0 +nan.0)")).toBe("#t");
  });

  it('exact -0 is unconstructible — (* -1 0) prints bare "0", never "-0"', async () => {
    // A forward-looking regression guard, not a currently-fragile behavior: bigint
    // has no -0 today, so this is an "accidental" green. Post-rework, AExact's `num`
    // field is a raw JS `number`, which CAN hold -0 unless the constructor normalizes
    // it away (plan §0.6: `x === 0 ? 0 : x`) — this row is the one that goes RED if
    // that normalization is ever forgotten during the port.
    expect(await run("(* -1 0)")).toBe("0");
  });
});

describe("division — exact zero divisor errors; integer-only ops require denom = 1", () => {
  it("(/ 1 0) rejects — exact division by exact zero errors (R7RS), not ∞", async () => {
    await expect(run("(/ 1 0)")).rejects.toThrow(/division by zero/i);
  });

  it("(/ 4 2) reduces to exact 2", async () => {
    expect(await run("(/ 4 2)")).toBe("2");
  });

  it("(quotient (/ 3 2) 1) rejects — quotient doors on a non-integer (denom ≠ 1) operand", async () => {
    // RED until the atom lands: today's message is "quotient: argument 0 type
    // mismatch" (z.bigint's CodecFidelityError swallowed into a generic mismatch by
    // numeric.ts's decodeArg) — it never mentions "integer". Target: quotient routes
    // through the same `toInteger` helper remainder/modulo/floor-quotient already use,
    // whose door message IS "quotient: not an integer".
    await expect(run("(quotient (/ 3 2) 1)")).rejects.toThrow(/integer/i);
  });
});

describe("parsing — string->number / reader agree on exactness", () => {
  it('(string->number "1e2") is inexact 100.0 — exponent notation never mints exact', async () => {
    // RED until the atom lands: parse_float's exponent arm (utils/parsing.ts:178,
    // `is_int(value) && Number.isSafeInteger(value) && /e\+?\d/i.test(...)`) currently
    // mints AExact whenever the float happens to round-trip to a safe integer —
    // printed bare "100", not "100.0".
    expect(await run('(string->number "1e2")')).toBe("100.0");
  });

  it('(string->number "10/2") reduces to exact 5', async () => {
    expect(await run('(string->number "10/2")')).toBe("5");
  });

  it('(string->number "1/3") parses as the exact rational 1/3', async () => {
    expect(await run('(string->number "1/3")')).toBe("1/3");
  });
});

describe("transcendental silence — inexact-by-spec-class, no warning, no error", () => {
  it("(exact? (sqrt 2)) is #f — sqrt of a non-perfect-square mints inexact silently", async () => {
    expect(await run("(exact? (sqrt 2))")).toBe("#f");
  });
});

describe("sort stability — mixed exact/inexact of equal value sorts without crashing", () => {
  it("(sort '(1 1.0 2 2.0) >) is a well-defined, stable descending order", async () => {
    // `sort` is receiver-FIRST in this codebase (env/srfi/srfi-95.ts: "(sort seq
    // less?)"), unlike the SRFI-95 paper convention — the sequence is arg 0, the
    // comparator arg 1. `>` as the `less?` comparator means "a precedes b iff a>b" —
    // a descending sort. `deriveSortCompare` (op-helpers.ts) feeds the verdict to
    // `Array.prototype.sort`, spec-guaranteed stable since ES2019, so the two
    // equal-valued exact/inexact pairs keep their ORIGINAL relative order: 2 before
    // 2.0, 1 before 1.0.
    expect(await run("(sort '(1 1.0 2 2.0) >)")).toBe("(2 2.0 1 1.0)");
  });
});
