// R9 — bracket CLAUSE positions (addendum to the bracket-bindings requirements doc,
// committed `2cf8e47eac`). The CLAUSE positions of `cond`, `case`, and `do`'s test-result
// clause additionally accept an evalElements vector, elementwise ≡ the
// parenthesized clause — `(cond [(> x 1) "a"] [else "b"])`,
// `(case k [(1 2) "low"] [else "hi"])`, `(do (…) [(= i n) acc] …)`.
//
// `cond`/`case`/`do` are evaluator SPECIAL FORMS (src/eval/evaluator.ts's
// evalCond/evalCase/evalDo), not syntax-rules prelude macros — consumption
// lands right there via `normalizeClause`, the CLAUSE-position sibling of the
// R2/R3 let-family `normalizeBindings`. Same normalize-once-before-the-walk
// shape, so R9's equivalence to the paren image is structural.
//
// Purely a Racket surface (Clojure's `cond` is flat, no clause grouping) — no
// dialect conflict, no door needed for the non-intersection claim itself.
//
// Executable spec: `spec/corpus/bracket-clauses-{read,eval}.jsonl` (via
// `spec-corpus.test.ts`) — this file is the narrative/behavioral companion,
// not a duplicate of the corpus.
import { describe, expect, it } from "vitest";
import { exec } from "../eval/generator-exec.js";

const doorError = async (src: string): Promise<Error & { cause?: unknown }> => {
  try {
    await exec(src);
  } catch (e) {
    return e as Error & { cause?: unknown };
  }
  throw new Error(`expected a bracket-clause door for: ${src}`);
};

const doorMessage = async (src: string): Promise<string> => (await doorError(src)).message;

/** The door's semantic code lives on `.cause.code` — see the identical helper
 *  in `let-bracket-binding-door.test.ts` for the `exec`/`ArrivalError` wrapping
 *  this relies on. */
const doorCode = async (src: string): Promise<unknown> => {
  const error = await doorError(src);
  return (error.cause as { code?: unknown } | undefined)?.code;
};

/** Evaluates both the bracket-clause SOURCE and its hand-written parenthesized
 *  IMAGE, asserting the results are equal — R9's equivalence law, exercised
 *  directly rather than merely asserted in prose. */
const assertEquivalent = async (bracketSrc: string, parenSrc: string): Promise<unknown> => {
  const [bracketResult] = await exec(bracketSrc);
  const [parenResult] = await exec(parenSrc);
  const bracketValue = bracketResult?.valueOf();
  const parenValue = parenResult?.valueOf();
  expect(bracketValue).toEqual(parenValue);
  return bracketValue;
};

describe("bracket clauses — cond (R9)", () => {
  it("bracket test clause consumes, equal to the paren image", async () => {
    const value = await assertEquivalent('(cond [(> 2 1) "a"] [else "b"])', '(cond ((> 2 1) "a") (else "b"))');
    expect(value).toBe("a");
  });

  it("bracket else clause consumes", async () => {
    const value = await assertEquivalent('(cond [#f "a"] [else "b"])', '(cond (#f "a") (else "b"))');
    expect(value).toBe("b");
  });

  it("bracket => clause consumes", async () => {
    const value = await assertEquivalent(
      "(cond [(+ 1 2) => (lambda (x) (* x 10))])",
      "(cond ((+ 1 2) => (lambda (x) (* x 10))))",
    );
    expect(value).toBe(30);
  });

  it("falls through to a later bracket clause when earlier tests are false", async () => {
    const value = await assertEquivalent("(cond [#f 1] [#f 2] [#t 3])", "(cond (#f 1) (#f 2) (#t 3))");
    expect(value).toBe(3);
  });

  it("no clause matches — returns void, same as the paren form", async () => {
    const [bracketResult] = await exec("(cond [#f 1])");
    const [parenResult] = await exec("(cond (#f 1))");
    expect(bracketResult).toEqual(parenResult);
  });

  it("mixing bracket and paren clauses in one cond", async () => {
    const value = await assertEquivalent("(cond [#f 1] (#t 2))", "(cond (#f 1) (#t 2))");
    expect(value).toBe(2);
  });

  it("nested: a bracket clause's body containing bracket let bindings (R9 + R2 compose)", async () => {
    const value = await assertEquivalent("(cond [#t (let [a 1] a)])", "(cond (#t (let ((a 1)) a)))");
    expect(value).toBe(1);
  });
});

describe("bracket clauses — case (R9)", () => {
  it("bracket clause with a parenthesized datum-list head consumes, equal to the paren image", async () => {
    const value = await assertEquivalent(
      '(case 1 [(1 2) "low"] [else "hi"])',
      '(case 1 ((1 2) "low") (else "hi"))',
    );
    expect(value).toBe("low");
  });

  it("bracket else clause consumes", async () => {
    const value = await assertEquivalent(
      '(case 99 [(1 2) "low"] [else "hi"])',
      '(case 99 ((1 2) "low") (else "hi"))',
    );
    expect(value).toBe("hi");
  });

  it("bracket => clause consumes", async () => {
    const value = await assertEquivalent(
      "(case 2 [(1 2) => (lambda (x) (* x 100))] [else 0])",
      "(case 2 ((1 2) => (lambda (x) (* x 100))) (else 0))",
    );
    expect(value).toBe(200);
  });

  it("no datum matches, no else — returns void, same as the paren form", async () => {
    const [bracketResult] = await exec('(case 99 [(1 2) "low"])');
    const [parenResult] = await exec('(case 99 ((1 2) "low"))');
    expect(bracketResult).toEqual(parenResult);
  });

  it("the datum-list head stays a LIST — R9's own invariant — and matches correctly", async () => {
    const value = await assertEquivalent(
      '(case (quote b) [(a b c) "letter"] [else "other"])',
      '(case (quote b) ((a b c) "letter") (else "other"))',
    );
    expect(value).toBe("letter");
  });
});

describe("bracket clauses — do's test clause (R9)", () => {
  it("bracket test clause consumes, equal to the paren image", async () => {
    const value = await assertEquivalent(
      "(do ((i 0 (+ i 1))) [(= i 3) i])",
      "(do ((i 0 (+ i 1))) ((= i 3) i))",
    );
    expect(value).toBe(3);
  });

  it("bracket test clause with multiple result expressions consumes", async () => {
    const value = await assertEquivalent(
      "(do ((i 0 (+ i 1)) (acc 0 (+ acc i))) [(= i 3) i acc])",
      "(do ((i 0 (+ i 1)) (acc 0 (+ acc i))) ((= i 3) i acc))",
    );
    expect(value).toBe(3);
  });

  it("do's binding brackets (R2) and its test-clause bracket (R9) compose", async () => {
    const value = await assertEquivalent("(do ([i 0 (+ i 1)]) [(= i 3) i])", "(do ((i 0 (+ i 1))) ((= i 3) i))");
    expect(value).toBe(3);
  });
});

describe("bracket clauses — R9 doors: E-COND-BRACKET-CLAUSE (empty clause)", () => {
  it("cond: empty bracket clause doors", async () => {
    const message = await doorMessage("(cond [])");
    expect(message).toMatch(/^cond clause \[\] is empty/);
    expect(await doorCode("(cond [])")).toBe("E-COND-BRACKET-CLAUSE");
  });

  it("case: empty bracket clause doors", async () => {
    const message = await doorMessage("(case 1 [])");
    expect(message).toMatch(/^case clause \[\] is empty/);
    expect(await doorCode("(case 1 [])")).toBe("E-COND-BRACKET-CLAUSE");
  });

  it("do: empty bracket test clause doors", async () => {
    const message = await doorMessage("(do ((i 0)) [])");
    expect(message).toMatch(/^do clause \[\] is empty/);
    expect(await doorCode("(do ((i 0)) [])")).toBe("E-COND-BRACKET-CLAUSE");
  });
});

describe("bracket clauses — R9 doors: E-CASE-BRACKET-DATUM-LIST (vector datum head)", () => {
  it("case: a bracket-vector datum-list head doors with its own text", async () => {
    const message = await doorMessage('(case 1 [[1 2] "low"])');
    expect(message).toMatch(/datum list \[1 2\] is a vector/);
    expect(message).toMatch(/\(1 2\)/);
    expect(await doorCode('(case 1 [[1 2] "low"])')).toBe("E-CASE-BRACKET-DATUM-LIST");
  });

  it("a #(...) constant-vector datum head (evalElements=false) is NOT R9's door — generic invariant fires, unchanged", async () => {
    const message = await doorMessage('(case 1 (#(1 2) "low"))');
    expect(message).toMatch(/case: expected list of datums/);
    expect(message).not.toMatch(/E-CASE-BRACKET-DATUM-LIST/);
  });
});

describe("bracket clauses — R5 negatives (still hold: `[…]` as a VALUE stays a vector)", () => {
  it("a bracket vector used as a cond TEST EXPRESSION (not a clause wrapper) stays a vector value", async () => {
    const [result] = await exec("(cond ([1 2 3] => vector-length))");
    expect(result?.valueOf()).toBe(3);
  });

  it("a bracket vector in a clause's BODY position is legal data, not consumed as a clause", async () => {
    const [result] = await exec("(cond [#t (vector-length [1 2 3])])");
    expect(result?.valueOf()).toBe(3);
  });

  it("a quoted cond form's bracket clause is inert data — a plain vector datum, unconsumed", async () => {
    const [result] = await exec("(quote (cond [#t 1]))");
    expect(result).toBeDefined();
  });

  it("a #(...) constant clause sitting in cond's clause position is NEVER consumed — unchanged generic invariant fires", async () => {
    const message = await doorMessage("(cond #(#t 1))");
    expect(message).not.toMatch(/E-COND-BRACKET/);
  });
});

describe("bracket clauses — passthrough (unrelated malformed clauses, unchanged)", () => {
  it("a bare symbol clause still hits the generic invariant, not a bracket door", async () => {
    const message = await doorMessage("(cond (#f 1) else)");
    expect(message).toMatch(/cond: invalid clause/);
    expect(message).not.toMatch(/E-COND-BRACKET/);
  });

  it("case with a bare (non-pair, non-else) clause still hits the generic invariant", async () => {
    const message = await doorMessage("(case 1 else)");
    expect(message).toMatch(/case: invalid clause/);
    expect(message).not.toMatch(/E-COND-BRACKET/);
  });
});
