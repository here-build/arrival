// statement-facts.test — pins `analyzeStatement`'s exact output for every field, incl. the
// false-positive fixes a real parse gives for free (a trigger word inside a string literal or a
// comment) and the bracket-binding surfaces (docs/reference/bracket-bindings.md). The
// `localBindings` cases mirror scope-confusion.test.ts's `describe("scanLocalBindings
// (scope-scan.ts)"...)` block byte-for-byte (that block is this module's ground truth for
// what scope-scan.ts currently derives) plus the bracket-binding additions this task asked for.
//
// This file tests ONLY `analyzeStatement` — statement-facts.ts is not wired into any call site
// yet (see the module header), so there is nothing else to exercise.

import { describe, expect, it } from "vitest";

import { analyzeStatement } from "../statement-facts.js";

describe("analyzeStatement — isDefine / definedName", () => {
  it("a variable define: definedName is the bound name", () => {
    const facts = analyzeStatement("(define x 5)");
    expect(facts.isDefine).toBe(true);
    expect(facts.definedName).toBe("x");
  });

  it("a function define: definedName is `f`, never the `(f a b)` head", () => {
    const facts = analyzeStatement("(define (f a b) (+ a b))");
    expect(facts.isDefine).toBe(true);
    expect(facts.definedName).toBe("f");
  });

  it("a function define with zero params still yields the function name", () => {
    const facts = analyzeStatement("(define (g) 1)");
    expect(facts.isDefine).toBe(true);
    expect(facts.definedName).toBe("g");
  });

  it("a non-define statement: isDefine false, definedName undefined", () => {
    const facts = analyzeStatement("(+ 1 2)");
    expect(facts.isDefine).toBe(false);
    expect(facts.definedName).toBeUndefined();
  });

  it("a tool-valued define (RHS is an arbitrary call) still yields just the bound name", () => {
    const facts = analyzeStatement('(define p (shop_price :item "widget"))');
    expect(facts.isDefine).toBe(true);
    expect(facts.definedName).toBe("p");
  });

  it("malformed: a nameless `(define)` is still shaped like a define, but has no name", () => {
    const facts = analyzeStatement("(define)");
    expect(facts.isDefine).toBe(true);
    expect(facts.definedName).toBeUndefined();
  });

  it("malformed: `(define () body)` — an empty function-head list has no extractable name", () => {
    const facts = analyzeStatement("(define () body)");
    expect(facts.isDefine).toBe(true);
    expect(facts.definedName).toBeUndefined();
  });

  it("a statement whose OWN top level is a `let` containing a nested define is NOT itself a define", () => {
    // isDefine/definedName look only at the statement's own top-level form (forms[0]) — a
    // nested define inside a let body surfaces through `localBindings`, not through this pair.
    const facts = analyzeStatement("(let ((y 1)) (define z 2) z)");
    expect(facts.isDefine).toBe(false);
    expect(facts.definedName).toBeUndefined();
  });
});

describe("analyzeStatement — usesCollectionOps / usesStringOps: the trigger families", () => {
  it("map / filter / reduce / fold-left / fold-right / filterv / mapv / fold each trigger collection", () => {
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
      expect(analyzeStatement(src).usesCollectionOps).toBe(true);
      expect(analyzeStatement(src).usesStringOps).toBe(false);
    }
  });

  it("string-* and substring each trigger the string family", () => {
    expect(analyzeStatement('(string-upcase "hi")').usesStringOps).toBe(true);
    expect(analyzeStatement("(substring s 0 2)").usesStringOps).toBe(true);
    expect(analyzeStatement('(string-upcase "hi")').usesCollectionOps).toBe(false);
  });

  it("a neutral statement triggers neither family", () => {
    const facts = analyzeStatement("(+ 1 2)");
    expect(facts.usesCollectionOps).toBe(false);
    expect(facts.usesStringOps).toBe(false);
  });

  it("both families can trigger together in one statement", () => {
    const facts = analyzeStatement("(map string-upcase lst)");
    expect(facts.usesCollectionOps).toBe(true);
    expect(facts.usesStringOps).toBe(true);
  });

  it("boundary check: a symbol merely CONTAINING the trigger word as a substring does not match", () => {
    // Mirrors competence.ts's own BEFORE/AFTER boundary rationale (`\bmap\b` would itself
    // misfire on `my-map-thing` the other way) — an exact-atom-text check reproduces the same
    // non-match without needing the boundary lookaround at all.
    expect(analyzeStatement("(my-map-thing)").usesCollectionOps).toBe(false);
    expect(analyzeStatement("(a-substring-ish 1)").usesStringOps).toBe(false);
  });

  it("FALSE-POSITIVE FIX: a trigger word inside a STRING LITERAL does not count", () => {
    // The old regex (competence.ts scanSuccess) scans raw source text with no notion of string
    // context, so `(define x "map")` would have false-positived. A real parse marks "map" here
    // `str: true` — never walked as a symbol atom.
    const facts = analyzeStatement('(define x "map")');
    expect(facts.usesCollectionOps).toBe(false);
  });

  it("FALSE-POSITIVE FIX: a trigger word inside a COMMENT does not count", () => {
    // competence.ts's own file header documents this as a DELIBERATE non-goal for the old
    // regex ("over-flagging is the safe direction... a comment mention is NOT excluded"). A
    // real parse excludes it for free — comments are trivia, never a Node this module walks.
    // Trailing-comment shape (matching what splitTopLevel actually produces for a statement
    // followed by a same-line comment before the next statement starts).
    const facts = analyzeStatement("(+ 1 2) ;; use map here");
    expect(facts.usesCollectionOps).toBe(false);
  });

  it("NOT a fix: a trigger word used as QUOTED DATA still counts (like-for-like, not a redesign)", () => {
    // The old regex has no notion of quoting either — this module's brief is a like-for-like
    // extraction plus exactly the two named false-positive fixes above, nothing broader.
    const facts = analyzeStatement("'(map 1 2)");
    expect(facts.usesCollectionOps).toBe(true);
  });
});

describe("analyzeStatement — localBindings: parity with scanLocalBindings (scope-scan.ts)", () => {
  // Ground truth: scope-confusion.test.ts's `describe("scanLocalBindings (scope-scan.ts)"...)`.
  it("let binding names", () => {
    expect(analyzeStatement("(let ((z 5)) z)").localBindings).toEqual(["z"]);
  });

  it("let* / letrec / letrec* bindings", () => {
    expect(
      [...analyzeStatement("(let* ((a 1) (b 2)) (+ a b))").localBindings].toSorted((a, b) => a.localeCompare(b)),
    ).toEqual(["a", "b"]);
    expect(
      [...analyzeStatement("(letrec ((f (lambda (n) n))) (f 1))").localBindings].toSorted((a, b) => a.localeCompare(b)),
    ).toEqual(["f", "n"]);
  });

  it("named let — the loop name is itself a local binding", () => {
    expect(
      [...analyzeStatement("(let loop ((i 0)) (if (< i 5) (loop (+ i 1)) i))").localBindings].toSorted((a, b) =>
        a.localeCompare(b),
      ),
    ).toEqual(["i", "loop"]);
  });

  it("lambda parameters, including the variadic single-symbol form", () => {
    expect(
      [...analyzeStatement("(lambda (x y) (+ x y))").localBindings].toSorted((a, b) => a.localeCompare(b)),
    ).toEqual(["x", "y"]);
    expect(analyzeStatement("(lambda args args)").localBindings).toEqual(["args"]);
  });

  it("a NESTED define (inside a let/lambda body) is local; a TOP-LEVEL define is not", () => {
    expect(
      [...analyzeStatement("(let ((y 1)) (define z 2) z)").localBindings].toSorted((a, b) => a.localeCompare(b)),
    ).toEqual(["y", "z"]);
    expect(analyzeStatement("(define a (car 5))").localBindings).toEqual([]);
    expect(analyzeStatement("(define f (lambda (x) (+ x 1)))").localBindings).toEqual(["x"]);
  });
});

describe("analyzeStatement — localBindings: bracket-binding forms (docs/reference/bracket-bindings.md)", () => {
  describe("R2a whole-list (Clojure surface): a flat bracket vector directly in the bindings slot", () => {
    it("let: [a 1 b 2]", () => {
      expect(
        [...analyzeStatement("(let [a 1 b 2] (+ a b))").localBindings].toSorted((a, b) => a.localeCompare(b)),
      ).toEqual(["a", "b"]);
    });

    it("let*: [a 1 b 2]", () => {
      expect(
        [...analyzeStatement("(let* [a 1 b 2] (+ a b))").localBindings].toSorted((a, b) => a.localeCompare(b)),
      ).toEqual(["a", "b"]);
    });

    it("letrec: a single-pair whole-list [f 1]", () => {
      expect(analyzeStatement("(letrec [f 1] f)").localBindings).toEqual(["f"]);
    });

    it("named let, whole-list form: (let loop [i 0] ...)", () => {
      expect([...analyzeStatement("(let loop [i 0] i)").localBindings].toSorted((a, b) => a.localeCompare(b))).toEqual([
        "i",
        "loop",
      ]);
    });

    it("named let, whole-list form, recursive body", () => {
      expect(
        [...analyzeStatement("(let loop [i 0] (if (= i 3) i (loop (+ i 1))))").localBindings].toSorted((a, b) =>
          a.localeCompare(b),
        ),
      ).toEqual(["i", "loop"]);
    });
  });

  describe("R2b per-element (Racket surface): a list whose elements are bracket pairs", () => {
    it("let: ([a 1] [b 2])", () => {
      expect(
        [...analyzeStatement("(let ([a 1] [b 2]) (+ a b))").localBindings].toSorted((a, b) => a.localeCompare(b)),
      ).toEqual(["a", "b"]);
    });

    it("let*: ([a 1] [b 2])", () => {
      expect(
        [...analyzeStatement("(let* ([a 1] [b 2]) (+ a b))").localBindings].toSorted((a, b) => a.localeCompare(b)),
      ).toEqual(["a", "b"]);
    });

    it("letrec: ([f (lambda () 1)]) — a per-element binding whose value is itself a lambda", () => {
      expect(analyzeStatement("(letrec ([f (lambda () 1)]) (f))").localBindings).toEqual(["f"]);
    });

    it("letrec*: ([a 1] [b 2])", () => {
      expect(
        [...analyzeStatement("(letrec* ([a 1] [b 2]) b)").localBindings].toSorted((a, b) => a.localeCompare(b)),
      ).toEqual(["a", "b"]);
    });

    it("named let, per-element form: (let loop ([i 0]) ...)", () => {
      expect(
        [...analyzeStatement("(let loop ([i 0]) i)").localBindings].toSorted((a, b) => a.localeCompare(b)),
      ).toEqual(["i", "loop"]);
    });
  });

  describe("R2c mixing: paren pairs and bracket vectors together in one bindings list", () => {
    it("([a 1] (b 2)) — each element judged independently", () => {
      expect(
        [...analyzeStatement("(let ([a 1] (b 2)) (+ a b))").localBindings].toSorted((a, b) => a.localeCompare(b)),
      ).toEqual(["a", "b"]);
    });
  });

  describe("scope boundary: `do` is NOT covered (matches scope-scan.ts's current LET_FORMS, not an expansion)", () => {
    it("a do-loop's own step variable is invisible to localBindings, same as the current scanner", () => {
      const facts = analyzeStatement("(do ((i 0 (+ i 1))) (= i 3) i)");
      expect(facts.localBindings).not.toContain("i");
    });
  });

  describe("preserved existing gap: a nested FUNCTION-form define's own params are not captured", () => {
    it("(define (g x) ...) nested in a let body: `g` is captured, `x` is not — mirrors scope-scan.ts today", () => {
      // scope-scan.ts's current token walk only calls its param-collecting helper for an
      // explicit `lambda`; a nested `(define (g x) ...)` only ever extracts the function NAME
      // via its depth>1 define branch, never descending into `(g x)` for `x` (its head is just
      // the plain identifier "g", not a recognized keyword, so no branch fires for its
      // children). This is a like-for-like extraction, not a redesign — the same asymmetry
      // reproduces here for the same structural reason.
      const facts = analyzeStatement("(let ((y 1)) (define (g x) (+ x y)) (g 1))");
      expect([...facts.localBindings].toSorted((a, b) => a.localeCompare(b))).toEqual(["g", "y"]);
      expect(facts.localBindings).not.toContain("x");
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
  it("a quoted classic-pairs let-shape still populates localBindings", () => {
    expect(analyzeStatement("'(let ((a 1)) a)").localBindings).toEqual(["a"]);
  });

  it("a quoted Racket per-element bracket-binding shape still populates localBindings", () => {
    expect(
      [...analyzeStatement("'(let ([a 1] [b 2]) (+ a b))").localBindings].toSorted((a, b) => a.localeCompare(b)),
    ).toEqual(["a", "b"]);
  });

  it("a quoted Clojure whole-list bracket-binding shape still populates localBindings", () => {
    expect(
      [...analyzeStatement("'(let [a 1 b 2] (+ a b))").localBindings].toSorted((a, b) => a.localeCompare(b)),
    ).toEqual(["a", "b"]);
  });

  it("a quasiquoted let-shape (data outer, live inner) also populates localBindings", () => {
    expect(analyzeStatement("`(let ((a 1)) ,b)").localBindings).toEqual(["a"]);
  });
});

describe("analyzeStatement — trigger-word-as-local-name confusion (adversarial — confuse the scanner)", () => {
  // A trigger-family word used as the NAME of a local binding (never called as a function)
  // still flags usesCollectionOps/usesStringOps — `walk`'s atom check matches on TEXT alone,
  // with no notion of call-position vs. binding-position. The OLD regex (competence.ts) is
  // exactly as position-blind (a boundary-anchored text match can't distinguish "map" the
  // function from "map" the variable name either) — like-for-like, not a new false positive.
  it("binding a local variable NAMED `map` still flags usesCollectionOps", () => {
    const facts = analyzeStatement("(let ((map 5)) map)");
    expect(facts.usesCollectionOps).toBe(true);
    expect(facts.localBindings).toEqual(["map"]);
  });

  it("a lambda PARAMETER named `substring` still flags usesStringOps", () => {
    const facts = analyzeStatement("(lambda (substring) substring)");
    expect(facts.usesStringOps).toBe(true);
    expect(facts.localBindings).toEqual(["substring"]);
  });

  it("a bare quoted trigger-family SYMBOL (not a call) still flags its family", () => {
    // `'map` parses to `(quote map)` — an atom child of quote, not the already-pinned nested-
    // list-call shape (`'(map 1 2)`) — a genuinely different code path through `walk`.
    expect(analyzeStatement("'map").usesCollectionOps).toBe(true);
    expect(analyzeStatement("'substring").usesStringOps).toBe(true);
  });
});

describe("analyzeStatement — localBindings: FIXED — a Clojure whole-list binding with a COMPOUND value", () => {
  // ★ This WAS a real, pre-existing limitation (verified empirically identical in scope-scan.ts's
  // `scanLocalBindings`, the token-walk scanner this module will eventually replace — so NOT a
  // regression introduced by this extraction, and left unfixed THERE on purpose: the fix belongs
  // in this module, its designated successor). It is now FIXED HERE.
  //
  // THE OLD BUG: `collectLetBindingNames`'s discriminator was `items.every(isAtom)` — it required
  // EVERY element of the bindings slot, names AND VALUES alike, to be a bare atom before treating
  // the slot as a Clojure whole-list. The instant ANY value was compound (a call, a lambda, a
  // nested let), `.every` failed for the WHOLE slot, mis-routing it to the per-element branch —
  // which only extracts a name from elements that are THEMSELVES lists — silently DROPPING every
  // real bare-atom name and instead pulling the compound value's own HEAD as a spurious name.
  // `(let [x 1 y (+ x 1)] ...)` — computing one binding from a prior one — is an ordinary,
  // mainstream Clojure idiom, not a contrived input.
  //
  // THE FIX: the discriminator now tests the SHAPE of the slot's FIRST element only —
  // `isAtom(items[0])`. A binding NAME is by grammar always a bare symbol (R2a: a symbol at every
  // even/name position), so it alone tells the two surfaces apart; every VALUE shape is now
  // irrelevant. Applied in lockstep to `walkLetBindingValues`, so names and values are still split
  // the same way (the two functions must never disagree about the name/value cut).
  it("one compound-valued binding among several: BOTH real names captured, no phantom value-head", () => {
    const facts = analyzeStatement("(let [a 1 b (+ 1 2)] (+ a b))");
    // was ["+"] — a,b silently dropped and the value's head "+" spuriously added; now the real names.
    expect([...facts.localBindings].toSorted((a, b) => a.localeCompare(b))).toEqual(["a", "b"]);
  });

  it("a single Clojure binding whose value is a lambda: the real name AND the lambda's own param", () => {
    const facts = analyzeStatement("(let [f (lambda (n) n)] (f 1))");
    // `f` (the whole-list binding) + `n` (the lambda param, reached by `walkLetBindingValues`
    // recursing into the value position) — now identical to the per-element analog
    // `(letrec ((f (lambda (n) n))) ...)` above. Was ["lambda"] (f dropped, value-head "lambda"
    // spuriously added).
    expect([...facts.localBindings].toSorted((a, b) => a.localeCompare(b))).toEqual(["f", "n"]);
  });

  it("control: a single Clojure binding with an ATOMIC value was always correct and still is", () => {
    expect(analyzeStatement("(letrec [f 1] f)").localBindings).toEqual(["f"]);
  });
});

describe("analyzeStatement — malformed-input robustness (adversarial — never throw on a shape it can't parse)", () => {
  it("an odd-length Clojure whole-list (a dangling name with no value) extracts every even-index atom, never throws", () => {
    // [a 1 b] — 3 elements; "b" sits at index 2 (even), so it's treated as a second name even
    // though its "value" is missing — over-collection, the documented safe direction (a name
    // flagged local that turns out to be something else costs nothing; under-collection
    // silently drops a real teaching opportunity).
    expect(() => analyzeStatement("(let [a 1 b] a)")).not.toThrow();
    expect([...analyzeStatement("(let [a 1 b] a)").localBindings].toSorted((a, b) => a.localeCompare(b))).toEqual([
      "a",
      "b",
    ]);
  });

  it("a named-let with a missing bindings slot entirely does not throw — only the loop name itself is collected", () => {
    expect(() => analyzeStatement("(let loop)")).not.toThrow();
    expect(analyzeStatement("(let loop)").localBindings).toEqual(["loop"]);
  });

  it("a bare `(let)` with no name, no bindings, no body does not throw — collects nothing", () => {
    expect(() => analyzeStatement("(let)")).not.toThrow();
    expect(analyzeStatement("(let)").localBindings).toEqual([]);
  });
});

describe("analyzeStatement — deep nesting across mixed bracket surfaces (positive, cross-surface)", () => {
  it("a Racket-per-element OUTER let containing a Clojure-whole-list INNER let* — both surfaces collected together", () => {
    const facts = analyzeStatement("(let ([a 1]) (let* [b 2 c 3] (+ a b c)))");
    expect([...facts.localBindings].toSorted((a, b) => a.localeCompare(b))).toEqual(["a", "b", "c"]);
  });
});

describe("analyzeStatement — robustness", () => {
  it("empty source returns empty/false facts rather than throwing", () => {
    expect(analyzeStatement("")).toEqual({
      isDefine: false,
      definedName: undefined,
      usesCollectionOps: false,
      usesStringOps: false,
      localBindings: [],
    });
  });

  it("a comment-only source (never produced by splitTopLevel today, handled defensively) is empty facts", () => {
    expect(analyzeStatement(";; just a comment").localBindings).toEqual([]);
    expect(analyzeStatement(";; just a comment").isDefine).toBe(false);
  });

  it("a trailing same-line comment (the actual shape splitTopLevel produces) parses through cleanly", () => {
    const facts = analyzeStatement("(define x 5) ;; note");
    expect(facts.isDefine).toBe(true);
    expect(facts.definedName).toBe("x");
  });

  it("a genuinely malformed (unbalanced) statement propagates a throw, it is not swallowed", () => {
    expect(() => analyzeStatement("(define x")).toThrow();
  });
});

describe("analyzeStatement — localBindings: FIXED — a binding NAMED a scope keyword no longer corrupts its VALUE", () => {
  // ★ This WAS a distinct bug class (never pinned before this session), now FIXED. `walk` used
  // to blanket-recurse into EVERY child unconditionally — `for (const child of items)
  // walk(child, depth + 1, acc)` — including a let-binding's own `(name value)` PAIR, with no
  // notion that a pair's tail is a VALUE, not a fresh form. When a binding's NAME happened to be
  // a scope-introducing keyword (let / let* / letrec / letrec* / lambda / define), the pair
  // `(keyword value)` got re-read as if it were that keyword's own binding form, and the VALUE
  // was mis-captured as a spurious binding name (a number, a bare symbol, or — worst — an entire
  // extra parameter list if the value was itself a list).
  //
  // THE FIX: `walk`'s LET_FORMS branch now recurses into binding VALUES (`walkLetBindingValues`)
  // and body forms EXPLICITLY, then returns — it no longer falls through to the generic blanket
  // recursion over the whole form's `items` (which was what re-walked the raw bindings-list
  // container, and with it, each raw pair, as if each were a freestanding form). The real
  // binding name (the keyword itself, correctly identified as a name by `collectLetBindingNames`,
  // untouched by this fix) is still captured; only the phantom extracted-from-the-value name is
  // gone.
  it("name `let`, atomic value: only the real name `let` is captured — the value `5` is not", () => {
    const facts = analyzeStatement("(let ((let 5)) let)");
    expect(facts.localBindings).toEqual(["let"]);
  });

  it("name `let`, SYMBOL value: only `let` is captured — the value `foo` no longer leaks in (it could have collided with a real variable)", () => {
    const facts = analyzeStatement("(let ((let foo)) let)");
    expect(facts.localBindings).toEqual(["let"]);
  });

  it("name `lambda`, LIST value: only `lambda` is captured — `(p q)` is no longer re-read as a param list", () => {
    const facts = analyzeStatement("(let ((lambda (p q))) x)");
    expect(facts.localBindings).toEqual(["lambda"]);
  });

  it("name `define`, atomic value: only `define` is captured — the depth>1 define branch no longer fires on the value", () => {
    const facts = analyzeStatement("(let ((define 5)) x)");
    expect(facts.localBindings).toEqual(["define"]);
  });

  it("the fix holds on the Racket per-element bracket surface too", () => {
    const facts = analyzeStatement("(let ([let 5]) let)");
    expect(facts.localBindings).toEqual(["let"]);
  });

  it("CONTROL: a NON-keyword binding name was always clean (isolates the fix to scope-keyword names exactly)", () => {
    expect(analyzeStatement("(let ((f foo)) f)").localBindings).toEqual(["f"]);
  });

  it("CONTROL: a normal binding whose value is a PROPER let-expression still finds both real names", () => {
    // `(x (let ((y 1)) y))` — the inner let's bindings slot IS walked (via walkLetBindingValues
    // recursing into the value position, which calls plain `walk` on the nested let expression —
    // that nested `walk` call correctly re-enters the LET_FORMS branch on its own terms).
    expect(
      [...analyzeStatement("(let ((x (let ((y 1)) y))) x)").localBindings].toSorted((a, b) => a.localeCompare(b)),
    ).toEqual(["x", "y"]);
  });

  it("a lambda genuinely nested inside a binding's VALUE is still found — values are still walked, just not as raw pairs", () => {
    // Regression guard for the fix itself: `walkLetBindingValues` must still recurse into
    // values (to catch a real nested lambda's params/trigger-words there) — it only stops
    // re-walking the (name value) PAIR as if the pair itself were a dispatchable form.
    expect(
      [...analyzeStatement("(let ((f (lambda (n) n))) (f 1))").localBindings].toSorted((a, b) => a.localeCompare(b)),
    ).toEqual(["f", "n"]);
  });
});

describe("analyzeStatement — localBindings: NEW BUG — a dotted-tail rest-arg marker is mis-captured (adversarial)", () => {
  // ★ NEW BUG (distinct root cause again: collectParamNames, not the recursion). `parseSexprs`
  // (arrival-sweet) is NOT arrival's real reader — it does not build improper lists. It reads the
  // rest-arg dot `.` in `(lambda (a . b) …)` as an ordinary WORD atom `{atom: "."}` sitting flat
  // in the params list `[a, ".", b]`. UPDATE: FIXED — collectParamNames now explicitly skips an
  // atom whose text is exactly `.`, matching the type-layer's own `lambdaParams` convention
  // (arrival's real lowering already skips this exact marker for this exact reason).
  it("single rest-arg: `.` is no longer captured — only the real names a and b", () => {
    const facts = analyzeStatement("(lambda (a . b) b)");
    expect([...facts.localBindings].toSorted((a, b) => a.localeCompare(b))).toEqual(["a", "b"]);
  });

  it("multiple fixed params before the rest: every real name, no phantom `.`", () => {
    expect(
      [...analyzeStatement("(lambda (a b . rest) rest)").localBindings].toSorted((a, b) => a.localeCompare(b)),
    ).toEqual(["a", "b", "rest"]);
  });

  it("CONTROL: the single-symbol variadic form has no dot, so nothing changes", () => {
    expect(analyzeStatement("(lambda args args)").localBindings).toEqual(["args"]);
  });
});

describe("analyzeStatement — localBindings: FIXED — a whole-list binding whose value is a nested let-EXPRESSION", () => {
  // ★ Same ROOT CAUSE as the "FIXED — Clojure whole-list ... COMPOUND value" block above, in a
  // starker form: the compound value is itself a nested `let`, whose HEAD `let` was the phantom
  // name the old `every(isAtom)` discriminator pulled while dropping the real name `a`. The
  // first-element shape discriminator (`isAtom(items[0])`) fixes it identically — and now the
  // whole-list surface AGREES with the per-element and paren-pairs surfaces (both below), which
  // always handled this same value correctly because their first element was already a list.
  it("a nested let-EXPRESSION as a whole-list value: real names `a` AND `b` both captured", () => {
    const facts = analyzeStatement("(let [a (let [b 1] b)] a)");
    // `a` (the outer whole-list binding) + `b` (the inner let, reached via the value position).
    // Was ["let"] — a dropped, the inner form's head "let" spuriously added.
    expect([...facts.localBindings].toSorted((a, b) => a.localeCompare(b))).toEqual(["a", "b"]);
  });

  it("the identical value on the Racket PER-ELEMENT surface agrees (it was always correct)", () => {
    expect(
      [...analyzeStatement("(let ([a (let [b 1] b)]) a)").localBindings].toSorted((a, b) => a.localeCompare(b)),
    ).toEqual(["a", "b"]);
  });

  it("the identical value on the classic PAREN-PAIRS surface agrees too (always correct)", () => {
    expect(
      [...analyzeStatement("(let ((a (let ((b 1)) b))) a)").localBindings].toSorted((a, b) => a.localeCompare(b)),
    ).toEqual(["a", "b"]);
  });
});

describe("analyzeStatement — localBindings: shape-discriminator regression guards (lock in the fix's boundary)", () => {
  // ★ These pin the exact edges of the first-element shape discriminator (`isAtom(items[0])`) so a
  // future "tightening" — back to every-element atomicity, or narrowing the first-element test from
  // `isAtom` to `isWord` — fails loudly here instead of silently regressing the compound-value fix.
  it("ALL values compound: every real name captured, zero value-heads leak (the strongest form of the fix)", () => {
    // Under the old `every(isAtom)` test this returned the two VALUE heads ["f","g"]; the
    // first-element discriminator reads the slot as whole-list from `a` alone, then takes names at
    // the even indices regardless of how many values are compound.
    expect(
      [...analyzeStatement("(let [a (f 1) b (g 2)] (+ a b))").localBindings].toSorted((a, b) => a.localeCompare(b)),
    ).toEqual(["a", "b"]);
  });

  it("malformed STRING literal in the first name slot still routes to whole-list; a later real name survives", () => {
    // The discriminator is `isAtom` (a string literal IS an atom), deliberately NOT `isWord` — so a
    // malformed `"foo"` in name position keeps the slot on the whole-list surface, and the real name
    // `b` two slots later is still collected (the `"foo"` itself is refused by the name-extraction's
    // own `isWord` guard). Narrowing the discriminator to `isWord` would misroute this to per-element
    // and drop `b` — this guard forbids that regression. Matches the OLD `every(isAtom)` behavior on
    // this shape exactly (["b"]); the fix is value-shape-only, it did not move the string-name edge.
    expect(analyzeStatement('(let ["foo" 1 b 2] b)').localBindings).toEqual(["b"]);
  });

  it("a bare-atom-first slot with a compound value reads as whole-list even in paren form (parseSexprs erases brackets)", () => {
    // `(let (a (b 2)) body)` — parseSexprs does not preserve the bracket/paren distinction, so the
    // surface is judged purely by shape: first element `a` is a bare atom → whole-list binding `a`
    // to the compound value `(b 2)`. (The OLD `every(isAtom)` test misread this as a per-element
    // pair and captured the value's head `b` instead — the same bug class as the whole-list gap,
    // now consistent across surfaces. Over-collection stays the safe direction either way.)
    expect(analyzeStatement("(let (a (b 2)) body)").localBindings).toEqual(["a"]);
  });
});

describe("analyzeStatement — keyword-accessor atoms do NOT false-trigger the families (adversarial — WORKS CORRECTLY)", () => {
  // This dialect's `:key` field-accessor reads (via parseSexprs) as a single WORD atom whose text
  // INCLUDES the colon — `:map` is the atom `":map"`, not `"map"`. So `COLLECTION_SYMBOLS.has`
  // (which holds "map", not ":map") and `STRING_TRIGGER` (`^substring$`, which `:substring`
  // cannot match with its leading colon) both correctly miss it. This is not just "doesn't
  // crash" — it is the RIGHT answer: a `:map` accessor is field access, semantically unrelated to
  // the collection `map` op, so NOT flagging usesCollectionOps is correct behaviour, not luck.
  it("`(:map obj)` — the keyword accessor does not flag usesCollectionOps", () => {
    const facts = analyzeStatement("(:map obj)");
    expect(facts.usesCollectionOps).toBe(false);
    expect(facts.localBindings).toEqual([]);
  });

  it("`(:substring s 0 2)` — the keyword accessor does not flag usesStringOps", () => {
    expect(analyzeStatement("(:substring s 0 2)").usesStringOps).toBe(false);
  });

  it("CONTRAST: the bare `(map f l)` op still flags, confirming the miss above is the colon, not a broken check", () => {
    expect(analyzeStatement("(map f l)").usesCollectionOps).toBe(true);
  });

  it("a keyword used as a BINDING NAME is captured verbatim (colon included) and still does not trigger the family", () => {
    const facts = analyzeStatement("(let ((:map 5)) :map)");
    expect(facts.localBindings).toEqual([":map"]);
    expect(facts.usesCollectionOps).toBe(false);
  });
});

describe("analyzeStatement — precondition violation: MORE than one top-level form (adversarial — robustness)", () => {
  // `analyzeStatement`'s doc states `source` is expected to be EXACTLY one top-level form. When a
  // caller violates that (splitTopLevel never does today, but a direct caller could), the module
  // does not throw — but it produces a fact-set that is internally INCONSISTENT across the two
  // field groups: `isDefine`/`definedName` read ONLY `forms[0]` (via defineShapeOf(root)), while
  // `usesCollectionOps`/`usesStringOps`/`localBindings` fold over ALL parsed forms (the
  // `for (const form of forms) walk(...)` loop). So a fact bundle can describe form[0]'s
  // define-ness while its op/binding flags come from a SIBLING statement. Pinned so the boundary
  // behavior is visible; the fix (if ever wanted) is to enforce the one-form precondition at the
  // seam, not to change these derivations.
  it("define first, map second: the bundle claims `define x` AND usesCollectionOps — but x's own form uses no map", () => {
    const facts = analyzeStatement("(define x 1)\n(map f lst)");
    expect(facts.isDefine).toBe(true);
    expect(facts.definedName).toBe("x");
    expect(facts.usesCollectionOps).toBe(true); // from the SECOND form, not the define
    expect(facts.localBindings).toEqual([]);
  });

  it("map first, define second: the second form's define-ness is invisible (only forms[0] is read)", () => {
    const facts = analyzeStatement("(map f lst)\n(define x 1)");
    expect(facts.isDefine).toBe(false); // forms[0] is the map call, not the define
    expect(facts.definedName).toBeUndefined();
    expect(facts.usesCollectionOps).toBe(true);
  });

  it("two defines: only the FIRST surfaces through isDefine/definedName; the second is silently invisible", () => {
    const facts = analyzeStatement("(define x 1)\n(define y 2)");
    expect(facts.isDefine).toBe(true);
    expect(facts.definedName).toBe("x"); // "y" never appears anywhere in the facts
  });

  it("two lets: localBindings DOES fold across both forms (unlike isDefine), collecting a and b together", () => {
    const facts = analyzeStatement("(let ((a 1)) a)\n(let ((b 2)) b)");
    expect([...facts.localBindings].toSorted((a, b) => a.localeCompare(b))).toEqual(["a", "b"]);
    expect(facts.isDefine).toBe(false);
  });
});

describe("analyzeStatement — localBindings: shadowing the same name across nested scopes (adversarial — WORKS CORRECTLY)", () => {
  // The same name bound in two nested scopes is expected/fine: `localBindings` is a Set, so the
  // duplicate collapses to one entry. Confirmed and pinned explicitly rather than left implicit —
  // a future change to the accumulator (e.g. an array) would silently regress this.
  it("a let inside a let, both binding `x`, collapses to a single `x`", () => {
    expect(analyzeStatement("(let ((x 1)) (let ((x 2)) x))").localBindings).toEqual(["x"]);
  });

  it("a lambda param shadowed by an inner let of the same name also collapses to one entry", () => {
    expect(analyzeStatement("(lambda (v) (let ((v 2)) v))").localBindings).toEqual(["v"]);
  });
});
