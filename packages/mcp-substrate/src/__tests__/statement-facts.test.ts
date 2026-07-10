// statement-facts.test — pins `analyzeStatement`'s exact output for every field, incl. the
// false-positive fixes a real parse gives for free (a trigger word inside a string literal or a
// comment) and the bracket-binding surfaces (spec: arrival's `src/eval/evaluator.ts`
// bracket-binding section). The
// `localBindings` cases mirror scope-confusion.test.ts's `describe("scanLocalBindings
// (scope-scan.ts)"...)` block byte-for-byte (that block is this module's ground truth for
// what scope-scan.ts currently derives) plus the bracket-binding additions this task asked for.
//
// This file tests ONLY `analyzeStatement` — statement-facts.ts is not wired into any call site
// yet (see the module header), so there is nothing else to exercise.
//
// REWORKED (2026-07-06): `analyzeStatement` now takes an ALREADY-PARSED `SchemeValue` (arrival's
// real reader output), not source text. The `facts()` helper below is the ONE parse per test —
// real `parse()` from `@here.build/arrival`, the same reader that executes model code. Every
// existing SOURCE STRING and asserted FACT VALUE below is unchanged from the pre-migration
// version of this file, except: (a) every test is now `async` and calls `await facts(src)`,
// always assigned to a local before its fields are read (never `(await facts(src)).field` inline
// — `unicorn/no-await-expression-member`); (b) the "unbalanced input" test now asserts the throw
// happens in `parse()` (the real syntax gate), not inside `analyzeStatement` itself; (c) the
// "MORE than one top-level form" describe block is REMOVED — see its replacement comment below.

import { parse } from "@here.build/arrival";
import { describe, expect, it } from "vitest";

import { analyzeStatement, type StatementFacts } from "../statement-facts.js";

async function facts(src: string): Promise<StatementFacts> {
  const forms = await parse(src);
  return analyzeStatement(forms[0]);
}

const sorted = (names: readonly string[]): string[] => [...names].toSorted((a, b) => a.localeCompare(b));

describe("analyzeStatement — isDefine / definedName", () => {
  it("a variable define: definedName is the bound name", async () => {
    const f = await facts("(define x 5)");
    expect(f.isDefine).toBe(true);
    expect(f.definedName).toBe("x");
  });

  it("a function define: definedName is `f`, never the `(f a b)` head", async () => {
    const f = await facts("(define (f a b) (+ a b))");
    expect(f.isDefine).toBe(true);
    expect(f.definedName).toBe("f");
  });

  it("a function define with zero params still yields the function name", async () => {
    const f = await facts("(define (g) 1)");
    expect(f.isDefine).toBe(true);
    expect(f.definedName).toBe("g");
  });

  it("a non-define statement: isDefine false, definedName undefined", async () => {
    const f = await facts("(+ 1 2)");
    expect(f.isDefine).toBe(false);
    expect(f.definedName).toBeUndefined();
  });

  it("a tool-valued define (RHS is an arbitrary call) still yields just the bound name", async () => {
    const f = await facts('(define p (shop_price :item "widget"))');
    expect(f.isDefine).toBe(true);
    expect(f.definedName).toBe("p");
  });

  it("malformed: a nameless `(define)` is still shaped like a define, but has no name", async () => {
    const f = await facts("(define)");
    expect(f.isDefine).toBe(true);
    expect(f.definedName).toBeUndefined();
  });

  it("malformed: `(define () body)` — an empty function-head list has no extractable name", async () => {
    const f = await facts("(define () body)");
    expect(f.isDefine).toBe(true);
    expect(f.definedName).toBeUndefined();
  });

  it("a statement whose OWN top level is a `let` containing a nested define is NOT itself a define", async () => {
    // isDefine/definedName look only at the statement's own top-level form — a nested define
    // inside a let body surfaces through `localBindings`, not through this pair.
    const f = await facts("(let ((y 1)) (define z 2) z)");
    expect(f.isDefine).toBe(false);
    expect(f.definedName).toBeUndefined();
  });
});

describe("analyzeStatement — usesCollectionOps / usesStringOps: the trigger families", () => {
  it("map / filter / reduce / fold-left / fold-right / filterv / mapv / fold each trigger collection", async () => {
    for (const src of [
      "(map f lst)",
      "(filter pred lst)",
      "(reduce f init lst)",
      "(fold-left f init lst)",
      "(fold-right f init lst)",
      "(filterv pred v)",
      "(mapv f v)",
      "(fold f init lst)", // not currently bound, kept per competence.ts's own note
    ]) {
      const f = await facts(src);
      expect(f.usesCollectionOps).toBe(true);
      expect(f.usesStringOps).toBe(false);
    }
  });

  it("string-* and substring each trigger the string family", async () => {
    const upcase = await facts('(string-upcase "hi")');
    expect(upcase.usesStringOps).toBe(true);
    expect(upcase.usesCollectionOps).toBe(false);
    const substring = await facts("(substring s 0 2)");
    expect(substring.usesStringOps).toBe(true);
  });

  it("a neutral statement triggers neither family", async () => {
    const f = await facts("(+ 1 2)");
    expect(f.usesCollectionOps).toBe(false);
    expect(f.usesStringOps).toBe(false);
  });

  it("both families can trigger together in one statement", async () => {
    const f = await facts("(map string-upcase lst)");
    expect(f.usesCollectionOps).toBe(true);
    expect(f.usesStringOps).toBe(true);
  });

  it("boundary check: a symbol merely CONTAINING the trigger word as a substring does not match", async () => {
    // Mirrors competence.ts's own BEFORE/AFTER boundary rationale (`\bmap\b` would itself
    // misfire on `my-map-thing` the other way) — an exact-atom-text check reproduces the same
    // non-match without needing the boundary lookaround at all.
    const mapThing = await facts("(my-map-thing)");
    expect(mapThing.usesCollectionOps).toBe(false);
    const substringIsh = await facts("(a-substring-ish 1)");
    expect(substringIsh.usesStringOps).toBe(false);
  });

  it("FALSE-POSITIVE FIX: a trigger word inside a STRING LITERAL does not count", async () => {
    // The old regex (competence.ts scanSuccess) scans raw source text with no notion of string
    // context, so `(define x "map")` would have false-positived. A real parse builds an `AString`
    // here — never walked as a symbol atom.
    const f = await facts('(define x "map")');
    expect(f.usesCollectionOps).toBe(false);
  });

  it("FALSE-POSITIVE FIX: a trigger word inside a COMMENT does not count", async () => {
    // competence.ts's own file header documents this as a DELIBERATE non-goal for the old
    // regex ("over-flagging is the safe direction... a comment mention is NOT excluded"). A
    // real parse excludes it for free — comments are trivia, never materialized as a
    // `SchemeValue` at all.
    const f = await facts("(+ 1 2) ;; use map here");
    expect(f.usesCollectionOps).toBe(false);
  });

  it("NOT a fix: a trigger word used as QUOTED DATA still counts (like-for-like, not a redesign)", async () => {
    // The old regex has no notion of quoting either — this module's brief is a like-for-like
    // extraction plus exactly the two named false-positive fixes above, nothing broader.
    const f = await facts("'(map 1 2)");
    expect(f.usesCollectionOps).toBe(true);
  });
});

describe("analyzeStatement — localBindings: parity with scanLocalBindings (scope-scan.ts)", () => {
  // Ground truth: scope-confusion.test.ts's `describe("scanLocalBindings (scope-scan.ts)"...)`.
  it("let binding names", async () => {
    const f = await facts("(let ((z 5)) z)");
    expect(f.localBindings).toEqual(["z"]);
  });

  it("let* / letrec / letrec* bindings", async () => {
    const letStar = await facts("(let* ((a 1) (b 2)) (+ a b))");
    expect(sorted(letStar.localBindings)).toEqual(["a", "b"]);
    const letrec = await facts("(letrec ((f (lambda (n) n))) (f 1))");
    expect(sorted(letrec.localBindings)).toEqual(["f", "n"]);
  });

  it("named let — the loop name is itself a local binding", async () => {
    const f = await facts("(let loop ((i 0)) (if (< i 5) (loop (+ i 1)) i))");
    expect(sorted(f.localBindings)).toEqual(["i", "loop"]);
  });

  it("lambda parameters, including the variadic single-symbol form", async () => {
    const fixed = await facts("(lambda (x y) (+ x y))");
    expect(sorted(fixed.localBindings)).toEqual(["x", "y"]);
    const variadic = await facts("(lambda args args)");
    expect(variadic.localBindings).toEqual(["args"]);
  });

  it("a NESTED define (inside a let/lambda body) is local; a TOP-LEVEL define is not", async () => {
    const nested = await facts("(let ((y 1)) (define z 2) z)");
    expect(sorted(nested.localBindings)).toEqual(["y", "z"]);
    const topLevel = await facts("(define a (car 5))");
    expect(topLevel.localBindings).toEqual([]);
    const lambdaValued = await facts("(define f (lambda (x) (+ x 1)))");
    expect(lambdaValued.localBindings).toEqual(["x"]);
  });
});

describe("analyzeStatement — localBindings: bracket-binding forms", () => {
  describe("R2a whole-list (Clojure surface): a flat bracket vector directly in the bindings slot", () => {
    it("let: [a 1 b 2]", async () => {
      const f = await facts("(let [a 1 b 2] (+ a b))");
      expect(sorted(f.localBindings)).toEqual(["a", "b"]);
    });

    it("let*: [a 1 b 2]", async () => {
      const f = await facts("(let* [a 1 b 2] (+ a b))");
      expect(sorted(f.localBindings)).toEqual(["a", "b"]);
    });

    it("letrec: a single-pair whole-list [f 1]", async () => {
      const f = await facts("(letrec [f 1] f)");
      expect(f.localBindings).toEqual(["f"]);
    });

    it("named let, whole-list form: (let loop [i 0] ...)", async () => {
      const f = await facts("(let loop [i 0] i)");
      expect(sorted(f.localBindings)).toEqual(["i", "loop"]);
    });

    it("named let, whole-list form, recursive body", async () => {
      const f = await facts("(let loop [i 0] (if (= i 3) i (loop (+ i 1))))");
      expect(sorted(f.localBindings)).toEqual(["i", "loop"]);
    });
  });

  describe("R2b per-element (Racket surface): a list whose elements are bracket pairs", () => {
    it("let: ([a 1] [b 2])", async () => {
      const f = await facts("(let ([a 1] [b 2]) (+ a b))");
      expect(sorted(f.localBindings)).toEqual(["a", "b"]);
    });

    it("let*: ([a 1] [b 2])", async () => {
      const f = await facts("(let* ([a 1] [b 2]) (+ a b))");
      expect(sorted(f.localBindings)).toEqual(["a", "b"]);
    });

    it("letrec: ([f (lambda () 1)]) — a per-element binding whose value is itself a lambda", async () => {
      const f = await facts("(letrec ([f (lambda () 1)]) (f))");
      expect(f.localBindings).toEqual(["f"]);
    });

    it("letrec*: ([a 1] [b 2])", async () => {
      const f = await facts("(letrec* ([a 1] [b 2]) b)");
      expect(sorted(f.localBindings)).toEqual(["a", "b"]);
    });

    it("named let, per-element form: (let loop ([i 0]) ...)", async () => {
      const f = await facts("(let loop ([i 0]) i)");
      expect(sorted(f.localBindings)).toEqual(["i", "loop"]);
    });
  });

  describe("R2c mixing: paren pairs and bracket vectors together in one bindings list", () => {
    it("([a 1] (b 2)) — each element judged independently", async () => {
      const f = await facts("(let ([a 1] (b 2)) (+ a b))");
      expect(sorted(f.localBindings)).toEqual(["a", "b"]);
    });
  });

  describe("scope boundary: `do` is NOT covered (matches scope-scan.ts's current LET_FORMS, not an expansion)", () => {
    it("a do-loop's own step variable is invisible to localBindings, same as the current scanner", async () => {
      const f = await facts("(do ((i 0 (+ i 1))) (= i 3) i)");
      expect(f.localBindings).not.toContain("i");
    });
  });

  describe("preserved existing gap: a nested FUNCTION-form define's own params are not captured", () => {
    it("(define (g x) ...) nested in a let body: `g` is captured, `x` is not — mirrors scope-scan.ts today", async () => {
      // scope-scan.ts's current token walk only calls its param-collecting helper for an
      // explicit `lambda`; a nested `(define (g x) ...)` only ever extracts the function NAME
      // via its depth>1 define branch, never descending into `(g x)` for `x` (its head is just
      // the plain identifier "g", not a recognized keyword, so no branch fires for its
      // children). This is a like-for-like extraction, not a redesign — the same asymmetry
      // reproduces here for the same structural reason.
      const f = await facts("(let ((y 1)) (define (g x) (+ x y)) (g 1))");
      expect(sorted(f.localBindings)).toEqual(["g", "y"]);
      expect(f.localBindings).not.toContain("x");
    });
  });
});

describe("analyzeStatement — localBindings: quote/data-transparency (adversarial — confuse the scanner)", () => {
  // The SAME unconditional-recursion property already pinned for usesCollectionOps ("NOT a fix:
  // a trigger word used as QUOTED DATA still counts", above) applies identically to
  // localBindings: `walk` has no concept of "am I inside a quote" and neither did the OLD
  // scope-scan.ts token-walker (a quote prefix `'` is just a token neither scanner special-
  // cases). A quoted let-SHAPE — pure inert data, never evaluated as a real binding form —
  // still populates localBindings across every bracket surface. Documented, like-for-like,
  // not a new regression; not fixed here.
  it("a quoted classic-pairs let-shape still populates localBindings", async () => {
    const f = await facts("'(let ((a 1)) a)");
    expect(f.localBindings).toEqual(["a"]);
  });

  it("a quoted Racket per-element bracket-binding shape still populates localBindings", async () => {
    const f = await facts("'(let ([a 1] [b 2]) (+ a b))");
    expect(sorted(f.localBindings)).toEqual(["a", "b"]);
  });

  it("a quoted Clojure whole-list bracket-binding shape still populates localBindings", async () => {
    const f = await facts("'(let [a 1 b 2] (+ a b))");
    expect(sorted(f.localBindings)).toEqual(["a", "b"]);
  });

  it("a quasiquoted let-shape (data outer, live inner) also populates localBindings", async () => {
    const f = await facts("`(let ((a 1)) ,b)");
    expect(f.localBindings).toEqual(["a"]);
  });
});

describe("analyzeStatement — trigger-word-as-local-name confusion (adversarial — confuse the scanner)", () => {
  // A trigger-family word used as the NAME of a local binding (never called as a function)
  // still flags usesCollectionOps/usesStringOps — `walk`'s atom check matches on TEXT alone,
  // with no notion of call-position vs. binding-position. The OLD regex (competence.ts) is
  // exactly as position-blind (a boundary-anchored text match can't distinguish "map" the
  // function from "map" the variable name either) — like-for-like, not a new false positive.
  it("binding a local variable NAMED `map` still flags usesCollectionOps", async () => {
    const f = await facts("(let ((map 5)) map)");
    expect(f.usesCollectionOps).toBe(true);
    expect(f.localBindings).toEqual(["map"]);
  });

  it("a lambda PARAMETER named `substring` still flags usesStringOps", async () => {
    const f = await facts("(lambda (substring) substring)");
    expect(f.usesStringOps).toBe(true);
    expect(f.localBindings).toEqual(["substring"]);
  });

  it("a bare quoted trigger-family SYMBOL (not a call) still flags its family", async () => {
    // `'map` parses to `(quote map)` — an atom child of quote, not the already-pinned nested-
    // list-call shape (`'(map 1 2)`) — a genuinely different code path through `walk`.
    const map = await facts("'map");
    expect(map.usesCollectionOps).toBe(true);
    const substring = await facts("'substring");
    expect(substring.usesStringOps).toBe(true);
  });
});

describe("analyzeStatement — localBindings: FIXED — a Clojure whole-list binding with a COMPOUND value", () => {
  // ★ This WAS a real, pre-existing limitation (verified empirically identical in scope-scan.ts's
  // `scanLocalBindings`, the token-walk scanner this module replaces — so NOT a regression
  // introduced by this extraction, and left unfixed THERE on purpose: the fix belongs in this
  // module, its designated successor). It is now FIXED HERE.
  //
  // THE OLD BUG: the discriminator required EVERY element of the bindings slot, names AND
  // VALUES alike, to be atomic before treating the slot as a Clojure whole-list. The instant ANY
  // value was compound (a call, a lambda, a nested let), that test failed for the WHOLE slot,
  // mis-routing it to the per-element branch — which only extracts a name from elements that
  // are THEMSELVES structural — silently DROPPING every real bare-atom name and instead pulling
  // the compound value's own HEAD as a spurious name. `(let [x 1 y (+ x 1)] ...)` — computing
  // one binding from a prior one — is an ordinary, mainstream Clojure idiom, not a contrived
  // input.
  //
  // THE FIX: the discriminator now tests the SHAPE of the slot's FIRST element only — atomish vs.
  // structural. A binding NAME is by grammar always a bare symbol (R2a: a symbol at every
  // even/name position), so it alone tells the two surfaces apart — every VALUE shape is now
  // irrelevant. Applied in lockstep to `walkLetBindingValues`, so names and values are still
  // split the same way (the two functions must never disagree about the name/value cut).
  it("one compound-valued binding among several: BOTH real names captured, no phantom value-head", async () => {
    const f = await facts("(let [a 1 b (+ 1 2)] (+ a b))");
    // was ["+"] — a,b silently dropped and the value's head "+" spuriously added; now the real names.
    expect(sorted(f.localBindings)).toEqual(["a", "b"]);
  });

  it("a single Clojure binding whose value is a lambda: the real name AND the lambda's own param", async () => {
    const f = await facts("(let [f (lambda (n) n)] (f 1))");
    // `f` (the whole-list binding) + `n` (the lambda param, reached by `walkLetBindingValues`
    // recursing into the value position) — now identical to the per-element analog
    // `(letrec ((f (lambda (n) n))) ...)` above. Was ["lambda"] (f dropped, value-head "lambda"
    // spuriously added).
    expect(sorted(f.localBindings)).toEqual(["f", "n"]);
  });

  it("control: a single Clojure binding with an ATOMIC value was always correct and still is", async () => {
    const f = await facts("(letrec [f 1] f)");
    expect(f.localBindings).toEqual(["f"]);
  });
});

describe("analyzeStatement — malformed-input robustness (adversarial — never throw on a shape it can't parse)", () => {
  it("an odd-length Clojure whole-list (a dangling name with no value) extracts every even-index atom, never throws", async () => {
    // [a 1 b] — 3 elements; "b" sits at index 2 (even), so it's treated as a second name even
    // though its "value" is missing — over-collection, the documented safe direction (a name
    // flagged local that turns out to be something else costs nothing; under-collection
    // silently drops a real teaching opportunity).
    await expect(facts("(let [a 1 b] a)")).resolves.not.toThrow();
    const f = await facts("(let [a 1 b] a)");
    expect(sorted(f.localBindings)).toEqual(["a", "b"]);
  });

  it("a named-let with a missing bindings slot entirely does not throw — only the loop name itself is collected", async () => {
    await expect(facts("(let loop)")).resolves.not.toThrow();
    const f = await facts("(let loop)");
    expect(f.localBindings).toEqual(["loop"]);
  });

  it("a bare `(let)` with no name, no bindings, no body does not throw — collects nothing", async () => {
    await expect(facts("(let)")).resolves.not.toThrow();
    const f = await facts("(let)");
    expect(f.localBindings).toEqual([]);
  });
});

describe("analyzeStatement — deep nesting across mixed bracket surfaces (positive, cross-surface)", () => {
  it("a Racket-per-element OUTER let containing a Clojure-whole-list INNER let* — both surfaces collected together", async () => {
    const f = await facts("(let ([a 1]) (let* [b 2 c 3] (+ a b c)))");
    expect(sorted(f.localBindings)).toEqual(["a", "b", "c"]);
  });
});

describe("analyzeStatement — robustness", () => {
  it("empty source returns empty/false facts rather than throwing", async () => {
    // `parse("")` yields zero forms; `analyzeStatement(undefined)` returns EMPTY_FACTS (Point 1's
    // signature explicitly accepts `undefined` for exactly this case).
    const f = await facts("");
    expect(f).toEqual({
      isDefine: false,
      definedName: undefined,
      usesCollectionOps: false,
      usesStringOps: false,
      localBindings: [],
    });
  });

  it("a comment-only source is empty facts", async () => {
    const f = await facts(";; just a comment");
    expect(f.localBindings).toEqual([]);
    expect(f.isDefine).toBe(false);
  });

  it("a trailing same-line comment (the actual shape splitTopLevel produces) parses through cleanly", async () => {
    const f = await facts("(define x 5) ;; note");
    expect(f.isDefine).toBe(true);
    expect(f.definedName).toBe("x");
  });

  it("a genuinely malformed (unbalanced) statement's throw now happens in the real `parse()` syntax gate, not inside analyzeStatement", async () => {
    // Production shape: runner.ts's syntax gate (`await parse(expr)`) rejects unbalanced input
    // before any statement reaches `analyzeStatement` at all — analyzeStatement itself never
    // parses, so it has nothing left to throw on.
    await expect(facts("(define x")).rejects.toThrow();
  });
});

describe("analyzeStatement — localBindings: FIXED — a binding NAMED a scope keyword no longer corrupts its VALUE", () => {
  // ★ This WAS a distinct bug class, now FIXED. The generic walk used to blanket-recurse into
  // EVERY child unconditionally — including a let-binding's own `(name value)` PAIR, with no
  // notion that a pair's tail is a VALUE, not a fresh form. When a binding's NAME happened to be
  // a scope-introducing keyword (let / let* / letrec / letrec* / lambda / define), the pair
  // `(keyword value)` got re-read as if it were that keyword's own binding form, and the VALUE
  // was mis-captured as a spurious binding name (a number, a bare symbol, or — worst — an entire
  // extra parameter list if the value was itself a list).
  //
  // THE FIX: `walk`'s LET_FORMS branch now recurses into binding VALUES (`walkLetBindingValues`)
  // and body forms EXPLICITLY, then returns — it no longer falls through to a blanket recursion
  // over the raw bindings-list container. The real binding name (the keyword itself, correctly
  // identified as a name by `collectLetBindingNames`, untouched by this fix) is still captured;
  // only the phantom extracted-from-the-value name is gone.
  it("name `let`, atomic value: only the real name `let` is captured — the value `5` is not", async () => {
    const f = await facts("(let ((let 5)) let)");
    expect(f.localBindings).toEqual(["let"]);
  });

  it("name `let`, SYMBOL value: only `let` is captured — the value `foo` no longer leaks in (it could have collided with a real variable)", async () => {
    const f = await facts("(let ((let foo)) let)");
    expect(f.localBindings).toEqual(["let"]);
  });

  it("name `lambda`, LIST value: only `lambda` is captured — `(p q)` is no longer re-read as a param list", async () => {
    const f = await facts("(let ((lambda (p q))) x)");
    expect(f.localBindings).toEqual(["lambda"]);
  });

  it("name `define`, atomic value: only `define` is captured — the depth>1 define branch no longer fires on the value", async () => {
    const f = await facts("(let ((define 5)) x)");
    expect(f.localBindings).toEqual(["define"]);
  });

  it("the fix holds on the Racket per-element bracket surface too", async () => {
    const f = await facts("(let ([let 5]) let)");
    expect(f.localBindings).toEqual(["let"]);
  });

  it("CONTROL: a NON-keyword binding name was always clean (isolates the fix to scope-keyword names exactly)", async () => {
    const f = await facts("(let ((f foo)) f)");
    expect(f.localBindings).toEqual(["f"]);
  });

  it("CONTROL: a normal binding whose value is a PROPER let-expression still finds both real names", async () => {
    // `(x (let ((y 1)) y))` — the inner let's bindings slot IS walked (via walkLetBindingValues
    // recursing into the value position, which calls plain `walk` on the nested let expression —
    // that nested `walk` call correctly re-enters the LET_FORMS branch on its own terms).
    const f = await facts("(let ((x (let ((y 1)) y))) x)");
    expect(sorted(f.localBindings)).toEqual(["x", "y"]);
  });

  it("a lambda genuinely nested inside a binding's VALUE is still found — values are still walked, just not as raw pairs", async () => {
    // Regression guard for the fix itself: `walkLetBindingValues` must still recurse into
    // values (to catch a real nested lambda's params/trigger-words there) — it only stops
    // re-walking the (name value) PAIR as if the pair itself were a dispatchable form.
    const f = await facts("(let ((f (lambda (n) n))) (f 1))");
    expect(sorted(f.localBindings)).toEqual(["f", "n"]);
  });
});

describe("analyzeStatement — localBindings: a dotted-tail rest-arg is captured (real reader has no literal `.` atom)", () => {
  // Unlike the old, retired spike parser, which reads the rest-arg dot `.` in
  // `(lambda (a . b) …)` as an ordinary WORD atom sitting flat in the params list, the REAL
  // reader parses a dotted param list directly to an IMPROPER cons spine — `(a . b)` is
  // `APair(a, ASymbol(b))`, with no intervening "." atom at all. `spineItems`' dotted-tail
  // return is exactly the rest-arg name, collected from ANY position, not just this special case.
  it("single rest-arg: only the real names a and b, never a phantom `.`", async () => {
    const f = await facts("(lambda (a . b) b)");
    expect(sorted(f.localBindings)).toEqual(["a", "b"]);
  });

  it("multiple fixed params before the rest: every real name, no phantom `.`", async () => {
    const f = await facts("(lambda (a b . rest) rest)");
    expect(sorted(f.localBindings)).toEqual(["a", "b", "rest"]);
  });

  it("CONTROL: the single-symbol variadic form has no dot, so nothing changes", async () => {
    const f = await facts("(lambda args args)");
    expect(f.localBindings).toEqual(["args"]);
  });
});

describe("analyzeStatement — localBindings: FIXED — a whole-list binding whose value is a nested let-EXPRESSION", () => {
  // ★ Same ROOT CAUSE as the "FIXED — Clojure whole-list ... COMPOUND value" block above, in a
  // starker form: the compound value is itself a nested `let`, whose HEAD `let` was the phantom
  // name the old every-element-atomic discriminator pulled while dropping the real name `a`. The
  // first-element shape discriminator fixes it identically — and now the whole-list surface
  // AGREES with the per-element and paren-pairs surfaces (both below), which always handled this
  // same value correctly because their first element was already structural.
  it("a nested let-EXPRESSION as a whole-list value: real names `a` AND `b` both captured", async () => {
    const f = await facts("(let [a (let [b 1] b)] a)");
    // `a` (the outer whole-list binding) + `b` (the inner let, reached via the value position).
    // Was ["let"] — a dropped, the inner form's head "let" spuriously added.
    expect(sorted(f.localBindings)).toEqual(["a", "b"]);
  });

  it("the identical value on the Racket PER-ELEMENT surface agrees (it was always correct)", async () => {
    const f = await facts("(let ([a (let [b 1] b)]) a)");
    expect(sorted(f.localBindings)).toEqual(["a", "b"]);
  });

  it("the identical value on the classic PAREN-PAIRS surface agrees too (always correct)", async () => {
    const f = await facts("(let ((a (let ((b 1)) b))) a)");
    expect(sorted(f.localBindings)).toEqual(["a", "b"]);
  });
});

describe("analyzeStatement — localBindings: shape-discriminator regression guards (lock in the fix's boundary)", () => {
  // ★ These pin the exact edges of the first-element shape discriminator (atomish vs. structural)
  // so a future "tightening" — back to every-element atomicity, or narrowing the first-element
  // test to exclude a string literal — fails loudly here instead of silently regressing the
  // compound-value fix.
  it("ALL values compound: every real name captured, zero value-heads leak (the strongest form of the fix)", async () => {
    // Under the old every-element-atomic test this returned the two VALUE heads ["f","g"]; the
    // first-element discriminator reads the slot as whole-list from `a` alone, then takes names
    // at the even indices regardless of how many values are compound.
    const f = await facts("(let [a (f 1) b (g 2)] (+ a b))");
    expect(sorted(f.localBindings)).toEqual(["a", "b"]);
  });

  it("malformed STRING literal in the first name slot still routes to whole-list; a later real name survives", async () => {
    // The discriminator is "structural or not" — an `AString` is NOT structural (see module
    // header), so a malformed `"foo"` in name position keeps the slot on the whole-list surface,
    // and the real name `b` two slots later is still collected (the `"foo"` itself is refused by
    // the name-extraction's own symbol-only guard). Narrowing the discriminator to "must be a
    // symbol" would misroute this to per-element and drop `b` — this guard forbids that
    // regression. Matches the OLD every-element-atomic behavior on this shape exactly (["b"]);
    // the fix is value-shape-only, it did not move the string-name edge.
    const f = await facts('(let ["foo" 1 b 2] b)');
    expect(f.localBindings).toEqual(["b"]);
  });

  it("a bare-atom-first slot with a compound value reads as whole-list even in paren form (the real reader has no bracket/paren distinction at this level)", async () => {
    // `(let (a (b 2)) body)` — first element `a` is a bare atom → whole-list binding `a` to the
    // compound value `(b 2)`. (The OLD every-element-atomic test misread this as a per-element
    // pair and captured the value's head `b` instead — the same bug class as the whole-list gap,
    // now consistent across surfaces. Over-collection stays the safe direction either way.)
    const f = await facts("(let (a (b 2)) body)");
    expect(f.localBindings).toEqual(["a"]);
  });
});

describe("analyzeStatement — keyword-accessor atoms do NOT false-trigger the families (adversarial — WORKS CORRECTLY)", () => {
  // This dialect's `:key` field-accessor reads (via the real reader) as a single SYMBOL whose
  // name INCLUDES the colon — `:map` is the symbol named `":map"`, not `"map"`. So
  // `COLLECTION_SYMBOLS.has` (which holds "map", not ":map") and `STRING_TRIGGER`
  // (`^substring$`, which `:substring` cannot match with its leading colon) both correctly miss
  // it. This is not just "doesn't crash" — it is the RIGHT answer: a `:map` accessor is field
  // access, semantically unrelated to the collection `map` op, so NOT flagging usesCollectionOps
  // is correct behaviour, not luck.
  it("`(:map obj)` — the keyword accessor does not flag usesCollectionOps", async () => {
    const f = await facts("(:map obj)");
    expect(f.usesCollectionOps).toBe(false);
    expect(f.localBindings).toEqual([]);
  });

  it("`(:substring s 0 2)` — the keyword accessor does not flag usesStringOps", async () => {
    const f = await facts("(:substring s 0 2)");
    expect(f.usesStringOps).toBe(false);
  });

  it("CONTRAST: the bare `(map f l)` op still flags, confirming the miss above is the colon, not a broken check", async () => {
    const f = await facts("(map f l)");
    expect(f.usesCollectionOps).toBe(true);
  });

  it("a keyword used as a BINDING NAME is captured verbatim (colon included) and still does not trigger the family", async () => {
    const f = await facts("(let ((:map 5)) :map)");
    expect(f.localBindings).toEqual([":map"]);
    expect(f.usesCollectionOps).toBe(false);
  });
});

// The former "precondition violation: MORE than one top-level form" describe block is REMOVED
// (not ported) — per the resolved design decision (statement-facts.ts module header, and the
// migration task that authored this rework): `analyzeStatement` now takes exactly ONE form, no
// array/multi-form overload. Every one of those four tests existed ONLY to pin the old
// multi-form-string contract's cross-form leakage (isDefine/definedName reading forms[0] while
// usesCollectionOps/usesStringOps/localBindings folded over every form in a multi-statement
// source string) — a scenario that cannot arise once the function's input is a single form.
// None had a real single-form equivalent worth preserving: they were testing an artifact of the
// old array-fold contract, not a property of statement analysis itself.

describe("analyzeStatement — localBindings: shadowing the same name across nested scopes (adversarial — WORKS CORRECTLY)", () => {
  // The same name bound in two nested scopes is expected/fine: `localBindings` is a Set, so the
  // duplicate collapses to one entry. Confirmed and pinned explicitly rather than left implicit —
  // a future change to the accumulator (e.g. an array) would silently regress this.
  it("a let inside a let, both binding `x`, collapses to a single `x`", async () => {
    const f = await facts("(let ((x 1)) (let ((x 2)) x))");
    expect(f.localBindings).toEqual(["x"]);
  });

  it("a lambda param shadowed by an inner let of the same name also collapses to one entry", async () => {
    const f = await facts("(lambda (v) (let ((v 2)) v))");
    expect(f.localBindings).toEqual(["v"]);
  });
});

describe("analyzeStatement — cycle safety: a genuinely circular form (R7RS datum labels) never hangs", () => {
  // `#0=(a . #0#)` is a REAL, re-entrant cons cell (arrival's Parser.ts resolves `#0#` to the
  // very pair being built — `pair.cdr === pair` by object identity, not merely "marked circular
  // for the printer"). A naive recursive `walk` would loop forever descending into `.cdr`
  // forever. `walk`'s own `seen` guard (module header) must catch this and return promptly with
  // SOME sane facts rather than hanging or throwing a stack overflow.
  it("a self-referential dotted pair does not hang and returns sane (non-crashing) facts", async () => {
    const forms = await parse("(define x '#0=(a . #0#))");
    const f = analyzeStatement(forms[0]);
    expect(f.isDefine).toBe(true);
    expect(f.definedName).toBe("x");
  });

  it("a circular list used AS a let bindings-slot spine does not hang", async () => {
    // Pathological, but must not hang: `#0=(a 1 . #0#)` fed as a whole-list bindings vector-like
    // spine. `spineItems`' own local cycle guard (distinct from `walk`'s node memo) must
    // terminate this walk too.
    const forms = await parse("(let #0=(a 1 . #0#) a)");
    expect(() => analyzeStatement(forms[0])).not.toThrow();
  });
});
