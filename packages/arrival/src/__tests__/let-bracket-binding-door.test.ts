// Bracket-binding doors for the let-family (eval/evaluator.ts) — models trained on
// Racket write `(let* ([a 1] [b 2]) …)` (each binding PAIR bracketed); models trained
// on Clojure write `(let [a 1 b 2] …)` (the whole bindings LIST bracketed). Arrival's
// reader never erases bracket kind — `[…]` mints an `AVector` with `evalElements ===
// true`; `(…)` mints an `APair`; `#(…)` mints an `AVector` with `evalElements ===
// false`. Detection is `evalElements === true` at a binding-position node — no
// reader/lexer change.
//
// Racket per-pair shape fails LOUDLY today (`invalid binding` invariant) — this test
// asserts it now teaches instead. Clojure whole-list shape fails SILENTLY today (the
// per-pair `while (is_pair(bindNode))` walk never enters an AVector, so zero bindings
// get bound and the body hits a confusing downstream unbound-variable) — this test
// asserts it now doors instead of silently misbehaving.
import { describe, expect, it } from "vitest";
import { exec } from "../eval/generator-exec.js";

const doorError = async (src: string): Promise<Error & { cause?: unknown }> => {
  try {
    await exec(src);
  } catch (e) {
    return e as Error & { cause?: unknown };
  }
  throw new Error(`expected a bracket-binding door for: ${src}`);
};

const doorMessage = async (src: string): Promise<string> => (await doorError(src)).message;

/** The door's semantic code lives on `.cause.code` — `exec`/`run()` wrap every thrown
 *  error into `new ArrivalError(error.message, frames, error)`, so `.message` on the
 *  caught ArrivalError is the door text verbatim (no "EvalError:"/code prefix) and the
 *  original EvalError (carrying `.code`) survives as `.cause`. */
const doorCode = async (src: string): Promise<unknown> => {
  const error = await doorError(src);
  return (error.cause as { code?: unknown } | undefined)?.code;
};

describe("bracket-binding door — Racket per-pair habit", () => {
  it("let*: bindings are pairs, not vectors", async () => {
    const message = await doorMessage("(let* ([a 1] [b 2]) (+ a b))");
    expect(message).toMatch(/^let\* bindings are pairs, not vectors/);
    expect(message).toMatch(/\[a 1\]/);
    expect(message).toMatch(/\(a 1\)/);
    expect(await doorCode("(let* ([a 1] [b 2]) (+ a b))")).toBe("E-LET-BRACKET-BINDING");
  });

  it("let: doors and echoes the corrected binding", async () => {
    const message = await doorMessage("(let ([a 1]) a)");
    expect(message).toMatch(/^let bindings are pairs, not vectors/);
    expect(message).toMatch(/\(a 1\)/);
  });

  it("letrec: doors", async () => {
    const message = await doorMessage("(letrec ([f (lambda () 1)]) (f))");
    expect(message).toMatch(/^letrec bindings are pairs, not vectors/);
  });

  it("do: doors on a bracketed binding pair", async () => {
    const message = await doorMessage("(do ([i 0 (+ i 1)]) (= i 3) i)");
    expect(message).toMatch(/^do bindings are pairs, not vectors/);
  });

  it("named let (Racket): doors instead of silently binding zero params", async () => {
    const message = await doorMessage("(let loop ([i 0]) i)");
    expect(message).toMatch(/^named let bindings are pairs, not vectors/);
    expect(message).toMatch(/\(i 0\)/);
  });

  it("echoes the offending binding verbatim, including a nested application", async () => {
    const message = await doorMessage(
      "(let* ([lat1-r (exact->inexact (/ (* 1 pi) 180))]) lat1-r)",
    );
    expect(message).toMatch(/\(lat1-r \(exact->inexact \(\/ \(\* 1 pi\) 180\)\)\)/);
  });
});

describe("bracket-binding door — Clojure whole-list habit", () => {
  it("let: doors on the whole bracketed bindings list", async () => {
    const message = await doorMessage("(let [a 1 b 2] (+ a b))");
    expect(message).toMatch(/^let bindings must be a parenthesized list of pairs/);
    expect(message).toMatch(/\(\(a 1\) \(b 2\)\)/);
    expect(await doorCode("(let [a 1 b 2] (+ a b))")).toBe("E-LET-BRACKET-BINDINGS-LIST");
  });

  it("named let (Clojure): doors on the whole bracketed bindings list", async () => {
    const message = await doorMessage("(let loop [i 0] i)");
    expect(message).toMatch(/^named let bindings must be a parenthesized list of pairs/);
    expect(message).toMatch(/\(\(i 0\)\)/);
  });

  it("let*: doors on the whole bracketed bindings list", async () => {
    const message = await doorMessage("(let* [a 1 b 2] (+ a b))");
    expect(message).toMatch(/^let\* bindings must be a parenthesized list of pairs/);
  });

  it("letrec: doors on the whole bracketed bindings list", async () => {
    const message = await doorMessage("(letrec [f 1] f)");
    expect(message).toMatch(/^letrec bindings must be a parenthesized list of pairs/);
  });
});

describe("bracket-binding door — adversarial false-positive cases (must NOT door)", () => {
  it("a bracketed binding INIT value is legal data, not a binding", async () => {
    const [result] = await exec("(let ((a [1 2 3])) (vector-length a))");
    expect(result?.valueOf()).toBe(3);
  });

  it("a #(...) constant binding init is legal data too", async () => {
    const [result] = await exec("(let ((a #(1 2 3))) (vector-length a))");
    expect(result?.valueOf()).toBe(3);
  });

  it("a bracket literal in the BODY (not a binding position) is legal", async () => {
    const [result] = await exec("(let ((a 1)) [a])");
    expect((result as unknown as { length: number }).length).toBe(1);
  });

  it("nested lets each door independently — outer bindings evaluate before the body, so the outer door fires first", async () => {
    const message = await doorMessage("(let ([a 1]) (let* ([b 2]) (+ a b)))");
    expect(message).toMatch(/^let bindings are pairs, not vectors/);
    // The inner let* would door too (on its own [b 2]) if reached — proving the
    // outer form's own binding, not the inner one, is what's echoed here.
    expect(message).toMatch(/\(a 1\)/);
  });

  it("a quoted let form is data, never evaluated — no door", async () => {
    const [result] = await exec("'(let* ([a 1] [b 2]) (+ a b))");
    // Returned as an unevaluated datum, not thrown.
    expect(result).toBeDefined();
  });
});

describe("bracket-binding door — passthrough (unrelated malformed bindings, unchanged)", () => {
  it("a bare symbol binding still hits the generic invariant, not our door", async () => {
    const message = await doorMessage("(let ((a 1) b) a)");
    expect(message).toMatch(/let: invalid binding/);
    expect(message).not.toMatch(/E-LET-BRACKET/);
  });

  it("do-as-begin misuse still hits the generic invariant, not our door", async () => {
    // `(define x 1)` misused as `do`'s bindings clause (Racket-`begin` habit) is an
    // APair whose first element is the bare symbol `define` — not an AVector, so it
    // falls straight through to the unchanged `is_pair(binding)` invariant.
    const message = await doorMessage("(do (define x 1) (test-ok) x)");
    expect(message).toMatch(/do: invalid binding/);
    expect(message).not.toMatch(/E-LET-BRACKET/);
  });
});
