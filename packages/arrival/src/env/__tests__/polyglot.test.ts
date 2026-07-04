// polyglot pack — assemble onto a real env, then RUN the threading macros.
import { exec, sandboxedEnv } from "../../index.js";
import { assembleEnv } from "../../common/kernel.js";
import { type SchemeEnv } from "../../common/scheme-env.js";
import { describe, expect, it } from "vitest";

import polyglot from "../polyglot.js";

describe("@here.build/arrival/polyglot", () => {
  it("installs the idiom macros and they thread correctly", async () => {
    const env = sandboxedEnv.inherit("polyglot-test");
    const evalScheme = (e: SchemeEnv, src: string) => exec(src, { env: e as never });
    await assembleEnv(env as unknown as SchemeEnv, [polyglot.lower({ evalScheme })]);

    const num = async (src: string) => Number((await exec(src, { env }))[0]);
    // -> threads FIRST: (+ 5 1)=6 ; (* 6 2)=12
    expect(await num("(-> 5 (+ 1) (* 2))")).toBe(12);
    // ~> is an alias of ->
    expect(await num("(~> 5 (+ 10))")).toBe(15);
    // compose is right-to-left: (*2 (+1 5)) = 12
    expect(await num("((compose (lambda (x) (* x 2)) (lambda (x) (+ x 1))) 5)")).toBe(12);
    // pipe is left-to-right: (*2 (+1 5)) = 12
    expect(await num("((pipe (lambda (x) (+ x 1)) (lambda (x) (* x 2))) 5)")).toBe(12);
  });

  it("exports a well-formed SchemePackSpec", () => {
    expect(polyglot.name).toBe("scheme/polyglot");
    expect(polyglot.spec.prelude).toContain("define-macro (->");
  });
});

// Cross-dialect stdlib completion — famous Clojure/CL symbols implemented as REAL,
// pure bindings over primitives already bound elsewhere (map/filter/reduce/dict/@/
// @keys/…). These run against the DEFAULT assembled env (`exec` with no explicit
// env), since polyglot ships in BASE_PACKS in production — the same surface a model
// actually reaches. Sibling to env/polyglot-rich-errors/stubs.ts, which doors the
// symbols that genuinely can't be pure (IO/mutation/macro-only).
describe("@here.build/arrival/polyglot — cross-dialect stdlib completion (Bucket A)", () => {
  const str = async (src: string) => String((await exec(src))[0]);

  it("str (Clojure) — concatenates the display form of every arg", async () => {
    expect(await str('(str "a" "b")')).toBe("ab");
    expect(await str('(str "n=" 5)')).toBe("n=5");
    expect(await str("(str)")).toBe("");
  });

  it("mapcar (Common Lisp) — same arg order as R7RS map", async () => {
    expect(await str("(mapcar (lambda (x) (* x x)) (list 1 2 3))")).toBe("(1 4 9)");
  });

  it("remove-if / remove-if-not (Common Lisp) — filter with the predicate sense flipped/kept", async () => {
    expect(await str("(remove-if (lambda (x) (> x 2)) (list 1 2 3 4))")).toBe("(1 2)");
    expect(await str("(remove-if-not (lambda (x) (> x 2)) (list 1 2 3 4))")).toBe("(3 4)");
  });

  it("get-in / assoc-in / update-in (Clojure) — nested dict access, immutable rebuild", async () => {
    expect(await str('(get-in (dict "a" (dict "b" 1)) (list "a" "b"))')).toBe("1");
    // assoc-in creates missing intermediate dicts on demand
    expect(await str('(get-in (assoc-in (dict) (list "a" "b") 42) (list "a" "b"))')).toBe("42");
    expect(
      await str('(get-in (update-in (dict "a" (dict "b" 1)) (list "a" "b") (lambda (x) (+ x 1))) (list "a" "b"))'),
    ).toBe("2");
    // the original dict is untouched (immutable rebuild, not mutation)
    expect(await str('(let ((d (dict "a" 1))) (assoc-in d (list "a") 99) (:a d))')).toBe("1");
  });

  it("zipmap (Clojure) — a dict pairing keys with vals at the same position", async () => {
    expect(await str('(:a (zipmap (list "a" "b") (list 1 2)))')).toBe("1");
    expect(await str('(:b (zipmap (list "a" "b") (list 1 2)))')).toBe("2");
  });

  it("frequencies (Clojure) — a dict of element to occurrence count", async () => {
    expect(await str('(@ (frequencies (list "a" "b" "a")) "a")')).toBe("2");
    expect(await str('(@ (frequencies (list "a" "b" "a")) "b")')).toBe("1");
  });

  it("group-by (Clojure) — a dict of (f element) to the matching elements, in order", async () => {
    expect(await str('(@ (group-by (lambda (x) (if (> x 2) "big" "small")) (list 1 2 3 4)) "big")')).toBe("(3 4)");
    expect(await str('(@ (group-by (lambda (x) (if (> x 2) "big" "small")) (list 1 2 3 4)) "small")')).toBe("(1 2)");
  });

  it("partial (Clojure) — fixes leading args, returns a function of the rest", async () => {
    expect(await str("((partial + 1 2) 3)")).toBe("6");
  });

  it("juxt (Clojure) — applies every fn to the same args, collecting the results", async () => {
    expect(await str("((juxt (lambda (x) x) (lambda (x) (* x 2))) 5)")).toBe("(5 10)");
  });

  it("mapv / filterv (Clojure) — map/filter with a vector result", async () => {
    const isVector = async (src: string) => (await exec(src))[0];
    const v1 = (await isVector("(mapv (lambda (x) (* x x)) (list 1 2 3))")) as { constructor: { name: string } };
    expect(v1.constructor.name).toBe("AVector");
    expect(await str("(vector->list (mapv (lambda (x) (* x x)) (list 1 2 3)))")).toBe("(1 4 9)");
    expect(await str("(vector->list (filterv (lambda (x) (> x 1)) (list 1 2 3)))")).toBe("(2 3)");
  });

  it("conj (Clojure) — prepends onto a list (successive items land at the front), appends onto a vector", async () => {
    expect(await str("(conj (list 1 2 3) 4 5)")).toBe("(5 4 1 2 3)");
    expect(await str("(vector->list (conj (vector 1 2 3) 4))")).toBe("(1 2 3 4)");
  });

  it("into (Clojure) — pours from's elements into to via conj", async () => {
    expect(await str("(into '() (list 1 2 3))")).toBe("(3 2 1)");
    expect(await str("(vector->list (into (vector) (list 1 2 3)))")).toBe("(1 2 3)");
  });

  it("rest (Clojure) — cdr that tolerates a non-pair instead of erroring", async () => {
    expect(await str("(rest (list 1 2 3))")).toBe("(2 3)");
    expect(await str("(rest '())")).toBe("()");
  });

  it("empty? (Clojure) — #t iff the list/string/vector/dict has no elements", async () => {
    // `(if X "yes" "no")` normalizes over the boxed-ABool-vs-raw-JS-boolean
    // representation quirk (null?/pair? return boxed #t/#f; = returns a raw JS
    // boolean) — both are scheme-truthy/falsy either way, `if` doesn't care.
    const truthy = async (src: string) => str(`(if ${src} "yes" "no")`);
    expect(await truthy("(empty? '())")).toBe("yes");
    expect(await truthy("(empty? (list 1))")).toBe("no");
    expect(await truthy('(empty? "")')).toBe("yes");
    expect(await truthy('(empty? "x")')).toBe("no");
    expect(await truthy("(empty? (vector))")).toBe("yes");
    expect(await truthy("(empty? (dict))")).toBe("yes");
    expect(await truthy("(empty? (dict :a 1))")).toBe("no");
  });

  it("first / comp / flatten / curry are ALREADY bound elsewhere — not redefined here", async () => {
    expect(await str("(first (list 1 2 3))")).toBe("1"); // SRFI-1, srfi-1.ts
    expect(await str("((comp (lambda (x) (* x 2)) (lambda (x) (+ x 1))) 5)")).toBe("12"); // alias of compose, polyglot.ts
    expect(await str("(flatten '(1 (2 (3))))")).toBe("(1 2 3)"); // r7rs/lists.ts, LIPS extension
    expect(await str("((curry (lambda (a b) (+ a b)) 1) 2)")).toBe("3"); // srfi-235.ts
  });
});
