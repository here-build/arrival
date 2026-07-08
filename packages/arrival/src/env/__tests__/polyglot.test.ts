// polyglot pack — assemble onto a real env, then RUN the threading macros.
import { execState, sandboxedEnv, type ExecOptions } from "../../index.js";
import { assembleEnv } from "../../common/kernel.js";
import { type SchemeEnv } from "../../common/scheme-env.js";
import { describe, expect, it } from "vitest";

import polyglot from "../polyglot.js";

// This whole file stringifies the BOXED result's Scheme print form (list "(1 4 9)")
// and checks box discipline directly (`.constructor.name === "AVector"`) — a
// boxed-state concern (RULINGS.md R1), not the SIMPLE tier's plain-JS exit. Local
// `exec` shadows the barrel export with the COMPLEX tier (execState) so every call
// site below is unchanged and still reads the boxed SchemeValue[] it always did.
async function exec(code: string, options?: ExecOptions) {
  return (await execState(code, options)).values.slice();
}

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

  it("first / comp / curry are ALREADY bound elsewhere — not redefined here", async () => {
    expect(await str("(first (list 1 2 3))")).toBe("1"); // SRFI-1, srfi-1.ts
    expect(await str("((comp (lambda (x) (* x 2)) (lambda (x) (+ x 1))) 5)")).toBe("12"); // alias of compose, polyglot.ts
    expect(await str("((curry (lambda (a b) (+ a b)) 1) 2)")).toBe("3"); // srfi-235.ts
  });
});

// dict accessor family (Racket's dict library) — grain-completion: MCP-Atlas
// trajectory autopsy found models reaching for `dict-ref` on a dict-shaped tool
// result and getting stranded (Unbound variable). These are dict-SPECIFIC (guard
// the dict shape, unlike @'s origin-agnostic read) real bindings, not stubs.
describe("@here.build/arrival/polyglot — dict accessor family (Bucket A)", () => {
  const str = async (src: string) => String((await exec(src))[0]);
  const raw = (src: string) => exec(src);

  it("dict-ref — reads by keyword, symbol, or string key, identically", async () => {
    expect(await str('(dict-ref (dict :a 1) :a)')).toBe("1");
    expect(await str("(dict-ref (dict \"a\" 1) 'a)")).toBe("1");
    expect(await str('(dict-ref (dict "a" 1) "a")')).toBe("1");
  });

  it("dict-ref — optional default, nil when missing and no default (same convention as get-in)", async () => {
    expect(await str('(dict-ref (dict :a 1) :b 99)')).toBe("99");
    const missing = await raw('(dict-ref (dict :a 1) :b)');
    expect(missing[0]).toEqual((await raw("'()"))[0]);
  });

  it("dict-ref — nested dicts", async () => {
    expect(await str('(dict-ref (dict-ref (dict :a (dict :b 2)) :a) :b)')).toBe("2");
  });

  it("dict-ref — errors with a door (fact + why + action) on a non-dict", async () => {
    await expect(raw('(dict-ref (list 1 2) :a)')).rejects.toThrow(
      /dict-ref: expected a dict .* got a pair\/list.*use @ for an origin-agnostic read/,
    );
    await expect(raw('(dict-ref "x" :a)')).rejects.toThrow(/dict-ref: expected a dict .* got a string/);
  });

  it("dict-has-key? — #t iff key resolves, #f when missing", async () => {
    const truthy = async (src: string) => str(`(if ${src} "yes" "no")`);
    expect(await truthy("(dict-has-key? (dict :a 1) :a)")).toBe("yes");
    expect(await truthy("(dict-has-key? (dict :a 1) :b)")).toBe("no");
  });

  it("dict-keys / dict-values — proper scheme lists, composable with map/filter", async () => {
    expect(await str('(length (dict-keys (dict :a 1 :b 2)))')).toBe("2");
    // dict-keys elements are raw JS strings lifted via array->list (same representation
    // as @keys elsewhere in this pack) — they print unquoted inside a list, same quirk
    // as any other raw-string-in-pair-spine value in this runtime.
    expect(await str('(map (lambda (k) k) (dict-keys (dict :a 1)))')).toBe("(a)");
    expect(await str("(dict-values (dict :a 1))")).toBe("(1)");
  });

  it("dict-count — the number of keys", async () => {
    expect(await str("(dict-count (dict :a 1 :b 2 :c 3))")).toBe("3");
    expect(await str("(dict-count (dict))")).toBe("0");
  });

  it("dict->alist / alist->dict — round trip through an alist of (key . value) pairs", async () => {
    expect(await str('(cdr (assoc "a" (dict->alist (dict :a 1))))')).toBe("1");
    expect(await str('(dict-ref (alist->dict (list (cons "a" 1) (cons "b" 2))) :b)')).toBe("2");
  });

  it("dict-set — an immutability DOOR, not a function (a 'set' verb in an immutable env is a silent-mutation trap)", async () => {
    await expect(raw('(dict-set (dict :a 1) :a 2)')).rejects.toThrow(
      /dict-set is not provided — dicts are immutable here.*assoc-in.*original d is unchanged/s,
    );
  });

  it("dict-update — an immutability DOOR pointing at update-in", async () => {
    await expect(raw('(dict-update (dict :a 1) :a (lambda (x) (+ x 1)))')).rejects.toThrow(
      /dict-update is not provided — dicts are immutable here.*update-in.*original d is unchanged/s,
    );
  });

  it("assoc-ref (Guile) — an alias of dict-ref, same key handling and default convention", async () => {
    expect(await str('(assoc-ref (dict :a 1) :a)')).toBe("1");
    expect(await str('(assoc-ref (dict :a 1) :b 42)')).toBe("42");
  });
});
