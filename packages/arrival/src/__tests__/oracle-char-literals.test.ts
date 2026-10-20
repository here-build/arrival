// oracle-char-literals.test.ts — `#\x` is ONE atom to the oracle, exactly as the reader takes it.
// A char literal's payload (`(`, `)`, `"`, `;`) is data, never structure, in BOTH the structural
// scan (oracle/scanner.ts) and the Σ scope walk (oracle/sigma.ts).
import { describe, expect, it } from "vitest";
import { ANativeProcedure } from "../values/primitives/ANativeProcedure.js";
import { AmbientRuntime } from "../env/AmbientRuntime.js";
import { makeOracle } from "../oracle/index.js";
import { scan } from "../oracle/scanner.js";

describe("oracle scan — character literals", () => {
  it.each([
    [String.raw`(f #\(`, 1],
    [String.raw`(f #\) 1`, 1],
    [String.raw`(f #\()`, 0],
    [String.raw`(f #\) 1)`, 0],
    [String.raw`(f #\space #\a)`, 0],
  ])("depth of %j is %i and never over-closed", (src, depth) => {
    const r = scan(src);
    expect(r.depth).toBe(depth);
    expect(r.overClosed).toBe(false);
  });

  it(String.raw`#\" does not open a string`, () => {
    const r = scan(String.raw`(f #\" 1`);
    expect(r.inString).toBe(false);
    expect(r.depth).toBe(1);
  });

  it(String.raw`#\; does not open a comment`, () => {
    const r = scan(String.raw`(f #\; 1`);
    expect(r.inComment).toBe(false);
    expect(r.depth).toBe(1);
  });

  it(String.raw`a trailing #\ (truncated) is mid-token, not a throw`, () => {
    expect(scan("(f #\\").midToken).toBe(true);
  });

  it("a prefix with a paren char literal is closeable/feasible at the right depth", () => {
    const o = makeOracle();
    expect(o.analyze(String.raw`(f #\)))`).overClosed).toBe(true);
    expect(o.analyze(String.raw`(f #\) 1)`).overClosed).toBe(false);
    expect(o.feasible(String.raw`(f #\) 1`)).toBe(true);
    expect(o.feasible(String.raw`(f #\)))`)).toBe(false);
  });
});

describe("oracle Σ scope walk — character literals", () => {
  const fn = new ANativeProcedure({
    name: "id",
    arity: { min: 0, max: null },
    contract: undefined,
    impl: (args) => args[0] as never,
  });
  const oracle = makeOracle(AmbientRuntime.root("t", { f: fn }));

  it("a `)` char literal does not pop the lambda frame, so its parameter stays in scope", () => {
    const valid = oracle.analyze(String.raw`(lambda (a) (f #\) `).validSymbols();
    expect(valid!.has("a")).toBe(true);
  });

  it("a `(` char literal does not open a phantom frame that hides later binders", () => {
    const valid = oracle.analyze(String.raw`(lambda (a #\( b) (f `).validSymbols();
    expect(valid!.has("a")).toBe(true);
    expect(valid!.has("b")).toBe(true);
  });
});
