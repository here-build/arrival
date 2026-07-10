// lower — the scheme → TS lowering. Two proofs:
//   (a) UNIT: the emitted TS string for each lowering rule (application/operator/carrier
//       lists/vector/dict/keyword/lambda/atoms/multi-form).
//   (b) INTEGRATION: harvest a prelude from real tool defs, lower a scheme call against it,
//       and prove a VALID call type-checks clean while a WRONG one (a vector where a list
//       is expected; a string where a number is) BITES. Reuses the in-memory `compileErrors`
//       tsc pattern from prelude.test.ts.
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

import * as z from "../../common/scheme-zod.js";
import { symbol } from "../../common/symbol.js";
import { lower } from "../lower.js";
import { assembleHarvestedPrelude } from "../prelude.js";
import { theVoid } from "../../values/primitives/AVoid.js";

/** Type-check `source` as one in-memory file; return the diagnostic messages (empty = clean). */
function compileErrors(source: string): string[] {
  const fileName = "/_virtual.ts";
  const options: ts.CompilerOptions = {
    strict: true,
    target: ts.ScriptTarget.ES2022,
    lib: ["lib.es2022.d.ts"],
    noEmit: true,
    skipLibCheck: true,
  };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, lang, onError, shouldCreate) =>
    name === fileName ? ts.createSourceFile(name, source, lang, true) : getSourceFile(name, lang, onError, shouldCreate);
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (name) => name === fileName || fileExists(name);
  const readFile = host.readFile.bind(host);
  host.readFile = (name) => (name === fileName ? source : readFile(name));
  const program = ts.createProgram([fileName], options, host);
  return ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

const ts1 = (src: string) => lower(src).ts;

/** The bare carrier vocabulary (carriers.ts, including the `s` namespace) as ambient TS —
 *  no harvested tool entries, just the `assembleHarvestedPrelude([]).prelude`'s carrier text. */
const carrierVocabularyText = assembleHarvestedPrelude([]).prelude;

describe("lower — scheme → TS emitter", () => {
  // INVARIANT: application forms keep the head and scheme argument order when lowered.
  it("application keeps the head + scheme arg order", () => {
    expect(ts1("(foo a b)")).toBe("foo(a, b)");
  });

  // INVARIANT: a non-identifier head (e.g. `+`, `string-append`) routes through the escaped
  // `_` namespace member.
  it("a non-identifier head routes through the `_` namespace under its escaped, dotted name", () => {
    expect(ts1("(+ a b)")).toBe("_.$plus$(a, b)");
    expect(ts1("(string-append a b)")).toBe("_.string$dash$append(a, b)");
  });

  // INVARIANT: a `:keyword value` run lowers into a trailing object-literal argument `{ key: value }`.
  it("kwargs: a `:keyword value` run flips into a real object literal `{ key: value }`", () => {
    expect(ts1('(create_user :name "Ada")')).toBe('create_user({ name: "Ada" })');
    expect(ts1('(create_user :name "Ada" :mode "fast")')).toBe('create_user({ name: "Ada", mode: "fast" })');
  });

  // INVARIANT: leading positional args stay positional; trailing keywords fold into one object argument.
  it("kwargs: leading positional args stay positional; keywords fold into a trailing object", () => {
    expect(ts1("(f x :a 1)")).toBe("f(x, { a: 1 })");
  });

  // INVARIANT: a bare keyword with no value lowers to `{ key: undefined }`.
  it("kwargs: a bare keyword with no value lowers to `{ key: undefined }` (the property type bites)", () => {
    expect(ts1("(create_user :name)")).toBe("create_user({ name: undefined })");
  });

  // INVARIANT: car/cdr lower to functional carrier-global calls, not field reads.
  it("car / cdr are functional carrier globals, not field reads", () => {
    expect(ts1("(car x)")).toBe("car(x)");
    expect(ts1("(cdr x)")).toBe("cdr(x)");
  });

  // INVARIANT: list/cons/quoted-list forms lower to the carrier constructors.
  it("list / cons / quoted lists lower to the carrier constructors", () => {
    expect(ts1("(list a b)")).toBe("list(a, b)");
    expect(ts1("(cons a b)")).toBe("cons(a, b)");
    expect(ts1("'(a b c)")).toBe("list(a, b, c)");
    expect(ts1("'()")).toBe("list()");
  });

  // INVARIANT: a vector literal `#(...)` lowers to a native TS array literal.
  it("a vector literal lowers to a native TS array", () => {
    expect(ts1("#(a b c)")).toBe("[a, b, c]");
    expect(ts1("(foo #(1 2 3))")).toBe("foo([1, 2, 3])");
  });

  // INVARIANT: `(dict ...)` lowers to an object literal; a keyword-headed read `(:key obj)`
  // lowers to a bracket field access.
  it("dict → object literal; keyword head → field read", () => {
    expect(ts1('(dict :name "a" :age 30)')).toBe('{ name: "a", age: 30 }');
    expect(ts1("(:key obj)")).toBe('obj["key"]');
  });

  // INVARIANT: a lambda lowers to a TS arrow function.
  it("lambda → an arrow", () => {
    expect(ts1("(lambda (x y) (+ x y))")).toBe("((x, y) => _.$plus$(x, y))");
  });

  // INVARIANT: string/number/boolean atoms lower to their literal TS forms.
  it("atoms: strings, numbers, booleans", () => {
    expect(ts1('"hi"')).toBe('"hi"');
    expect(ts1("42")).toBe("42");
    expect(ts1("-5")).toBe("-5");
    expect(ts1("#t")).toBe("true");
    expect(ts1("#f")).toBe("false");
  });

  // INVARIANT: multiple top-level forms lower to `;\n`-separated statements.
  it("multiple top-level forms become `;\\n`-separated statements", () => {
    expect(ts1("(foo 1) (bar 2)")).toBe("foo(1);\nbar(2)");
  });
});

describe("lower — quoted data recurses (the false-positive killer)", () => {
  // INVARIANT: a quoted nested list recurses as quoted data at every level, never mistaken
  // for an application.
  it("a quoted NESTED list recurses as quoted data, never an application", () => {
    expect(ts1('\'(("a" 1))')).toBe('list(list("a", 1))');
  });

  // INVARIANT: a flat quoted list lowers unchanged to `list(...)`.
  it("a flat quoted list is unchanged", () => {
    expect(ts1("'(1 2 3)")).toBe("list(1, 2, 3)");
  });

  // INVARIANT: a dotted quoted pair lowers to `cons(...)`.
  it("a dotted quoted pair lowers to cons", () => {
    expect(ts1("'((k . v))")).toBe("list(cons(k, v))");
  });

  // INVARIANT: deep nesting recurses correctly at every level.
  it("deep nesting recurses at every level", () => {
    expect(ts1("'((1 (2 3)) 4)")).toBe("list(list(1, list(2, 3)), 4)");
  });

  // INVARIANT: a multi-element dotted list folds right through the proper elements into
  // nested cons calls.
  it("a multi-element dotted list folds right through the proper elements", () => {
    expect(ts1("'(a b . c)")).toBe("cons(a, cons(b, c))");
  });
});

describe("lower — quasiquote degrades to quoted data, unquote stays live", () => {
  // INVARIANT: a quasiquoted list with no unquote lowers exactly like an ordinary quote.
  it("a quasiquoted list with no unquote lowers exactly like a quote", () => {
    expect(ts1("`(a b c)")).toBe("list(a, b, c)");
  });

  // INVARIANT: an (unquote e) node inside a quasiquote emits the live expression, not
  // further-quoted data.
  it("an (unquote e) node inside emits the LIVE expression, not further-quoted data", () => {
    expect(ts1("`(a ,b c)")).toBe("list(a, b, c)");
  });

  // INVARIANT: unquote-splicing also emits the live expression.
  it("unquote-splicing also emits the live expression", () => {
    expect(ts1("`(a ,@b c)")).toBe("list(a, b, c)");
  });

  // INVARIANT: a nested quasiquoted list still recurses as quoted data.
  it("a nested quasiquoted list still recurses as quoted data", () => {
    expect(ts1("`((a ,b) c)")).toBe("list(list(a, b), c)");
  });

  // INVARIANT: a stray unquote outside a quasiquote degrades to the live inner expression.
  it("a stray unquote outside a quasiquote stays inert (degrades to the live inner expr)", () => {
    expect(ts1(",b")).toBe("b");
  });
});

describe("lower — top-level define lowers to a const statement", () => {
  // INVARIANT: `(define x e)` lowers to `const x = e`.
  it("(define x e) → const x = e", () => {
    expect(ts1("(define x 5)")).toBe("const x = 5");
  });

  // INVARIANT: `(define (f a b) body)` lowers to a const-bound arrow function with
  // `any`-typed params.
  it("(define (f a b) body) → const f = (a: any, b: any) => body", () => {
    expect(ts1("(define (add2 a b) (+ a b))")).toBe("const add2 = (a: any, b: any) => _.$plus$(a, b)");
  });

  // INVARIANT: a multi-form function body folds to a comma sequence expression.
  it("a multi-form function body folds to a comma sequence, mirroring emitLambda", () => {
    expect(ts1("(define (f x) (foo x) (bar x))")).toBe("const f = (x: any) => (foo(x), bar(x))");
  });

  // INVARIANT: a zero-arg function define lowers to a zero-arg arrow.
  it("a zero-arg function define", () => {
    expect(ts1("(define (f) 1)")).toBe("const f = () => 1");
  });

  // INVARIANT: `(define x)` with no value lowers to `const x = undefined`.
  it("(define x) with no value lowers to undefined", () => {
    expect(ts1("(define x)")).toBe("const x = undefined");
  });

  // INVARIANT: multiple top-level defines lower to separate const statements.
  it("multiple top-level defines are separate const statements", () => {
    expect(ts1("(define x 1) (define y 2)")).toBe("const x = 1;\nconst y = 2");
  });

  // INVARIANT: a nested define inside a lambda body still uses the application-call
  // lowering (not a separate const form).
  it("a NESTED define (inside a lambda body) keeps the prior application-call lowering", () => {
    expect(ts1("(lambda () (define x 1) x)")).toBe("(() => (define(x, 1), x))");
  });

  // INVARIANT: a defined helper's real arity mismatch is caught by tsc against its real
  // parameter types (TS2554).
  it("integration: a defined helper's arity mismatch actually type-checks against real params", () => {
    const errors = compileErrors(`${lower("(define (add2 a b) a) (add2 1)").ts}\n`);
    expect(errors.length).toBeGreaterThan(0); // TS2554 — too few arguments
  });
});

describe("lower — s.* combinators (TS reserved-word forms)", () => {
  // INVARIANT: if lowers to `s.if(cond, then[, else])`.
  it("if → s.if(c, a, b) / s.if(c, a)", () => {
    expect(ts1("(if #t 1 2)")).toBe("s.if(true, 1, 2)");
    expect(ts1("(if #t 1)")).toBe("s.if(true, 1)");
  });

  // INVARIANT: let lowers to `s.let(v1, v2, (a,b) => body)`.
  it("let → s.let(v1, v2, (a, b) => body)", () => {
    expect(ts1("(let ((a 1) (b 2)) (+ a b))")).toBe("s.let(1, 2, (a, b) => _.$plus$(a, b))");
  });

  // INVARIANT: named let lowers to `s.namedLet(v, (loop, i) => body)`.
  it("named let → s.namedLet(v, (loop, i) => body)", () => {
    expect(ts1("(let loop ((i 0)) (loop i))")).toBe("s.namedLet(0, (loop, i) => loop(i))");
  });

  // INVARIANT: let* lowers to nested s.let calls preserving sequential scoping.
  it("let* → nested s.let calls (sequential scoping)", () => {
    expect(ts1("(let* ((a 1) (b a)) b)")).toBe("s.let(1, (a) => s.let(a, (b) => b))");
  });

  // INVARIANT: letrec/letrec* lower identically to let (advisory fidelity, not distinguished).
  it("letrec / letrec* → the same flat emission as let (advisory fidelity)", () => {
    expect(ts1("(letrec ((a 1)) a)")).toBe("s.let(1, (a) => a)");
    expect(ts1("(letrec* ((a 1)) a)")).toBe("s.let(1, (a) => a)");
  });

  // INVARIANT: cond lowers to `s.cond([test, e], …)` with else rewritten to a literal true test.
  it("cond → s.cond([test, e], …, [true, d]) — else becomes true", () => {
    expect(ts1("(cond (#t 1) (else 2))")).toBe("s.cond([true, 1], [true, 2])");
  });

  // INVARIANT: do/case lower to parse-safety-only `s.do`/`s.case` calls with incidental shape.
  it("do / case → parse-safety only", () => {
    expect(ts1("(do 1 2)")).toBe("s.do(1, 2)");
    expect(ts1("(case x (1 2))")).toBe("s.case(x, _.$1$(2))"); // parse-safety only — shape is incidental
  });

  // INVARIANT: a reserved word in argument/value position always routes through the `_`
  // namespace, never printed bare.
  it("a reserved word in ARGUMENT/value position routes through `_`, never prints bare", () => {
    expect(ts1("(f for)")).toBe("f(_.for)");
    expect(ts1("(f class new return)")).toBe("f(_.class, _.new, _.return)");
  });

  // INVARIANT: a lowered `if` type-checks and narrows correctly through the carrier `s` namespace.
  it("integration: (if ...) type-checks and narrows through the carrier `s` namespace", () => {
    const errors = compileErrors(`${carrierVocabularyText}\n${lower("(if #t 1 2)").ts}\n`);
    expect(errors).toEqual([]);
    const narrowed: string = "const _x: number = s.if(true, 1, 2);";
    expect(compileErrors(`${carrierVocabularyText}\n${narrowed}\n`)).toEqual([]);
  });

  // INVARIANT: a lowered `let` type-checks and infers the bound variable's type correctly.
  it("integration: (let ((a 1)) a) type-checks and infers the bound type", () => {
    const errors = compileErrors(`${carrierVocabularyText}\nconst _x: number = ${lower("(let ((a 1)) a)").ts};\n`);
    expect(errors).toEqual([]);
  });

  // INVARIANT: a lowered `cond` type-checks correctly.
  it("integration: (cond (#t 1) (else 2)) type-checks", () => {
    const errors = compileErrors(
      `${carrierVocabularyText}\nconst _x: number = ${lower("(cond (#t 1) (else 2))").ts};\n`,
    );
    expect(errors).toEqual([]);
  });
});

describe("lower — integration: lowered call ∩ harvested prelude", () => {
  // get-route takes a proper list (z.list() → List<unknown>) + a string; set-timer takes a
  // number. REBASELINE (fe2c848ee7, 2026-07-08): z.pair is now cons(value, value) — a real
  // dotted-pair codec (prints Pair<Car,Cdr>), not the list-shaped `Cons<unknown>` it used to
  // alias — z.union([z.pair, z.nil]) no longer means "a proper list." z.list() is the actual
  // proper-list constructor (prints List<unknown> via the named-generic pre-check).
  const getRoute = symbol.rosetta`get-route: route between stops`(
    { input: [z.list(), z.string], output: [z.string] },
    () => "",
  );
  const setTimer = symbol.native`set-timer: start a timer`(
    { input: [z.number], output: [z.undefinedResult] },
    // `symbol.native` runs in SCHEME space — z.undefinedResult decodes to `AVoid`, so the
    // impl returns the boxed `theVoid` singleton, never a raw JS `undefined` (matches every
    // production z.undefinedResult native, e.g. env/r7rs/strings.ts's string-for-each).
    () => theVoid,
  );
  const entries = [
    ["get_route", getRoute],
    ["set_timer", setTimer],
  ] as const;

  const compileLowered = (scheme: string): string[] => {
    const { prelude } = assembleHarvestedPrelude(entries);
    return compileErrors(`${prelude}\n${lower(scheme).ts}\n`);
  };

  // INVARIANT: a valid lowered call (list-typed arg matching a real proper-list literal)
  // type-checks clean against the harvested prelude.
  it("a VALID lowered call type-checks clean against the harvest", () => {
    expect(compileLowered('(set_timer 600)\n(get_route \'("A" "B") "fast")')).toEqual([]);
  });

  // INVARIANT: a vector literal where a list-typed slot is expected is rejected by tsc.
  it("a vector where a list is expected BITES", () => {
    expect(compileLowered('(get_route #(1 2 3) "fast")').length).toBeGreaterThan(0);
  });

  // INVARIANT: a string where a number-typed slot is expected is rejected by tsc.
  it("a string where a number is expected BITES", () => {
    expect(compileLowered('(set_timer "ten")').length).toBeGreaterThan(0);
  });
});

describe("lower — per-statement span-map (additive)", () => {
  // INVARIANT: lower() preserves the `{ ts }` emitted string verbatim.
  it("preserves `{ ts }` verbatim", () => {
    expect(lower("(set_timer 600)").ts).toBe("set_timer(600)");
  });

  // INVARIANT: a single-statement program's tsRange slices the whole output and its
  // schemeSpan covers the whole source form.
  it("single statement: one entry, tsRange slices the whole output, schemeSpan covers the form", () => {
    const { ts, statements } = lower("(set_timer 600)");
    expect(statements).toHaveLength(1);
    expect(ts.slice(statements[0]!.tsRange[0], statements[0]!.tsRange[1])).toBe(ts);
    expect(statements[0]!.schemeSpan).toEqual([0, 15]);
  });

  // INVARIANT: a multi-statement program's per-statement tsRange/schemeSpan each slice
  // exactly their own fragment/source form.
  it("multi statement: each tsRange slices its lowered fragment; each schemeSpan slices its source form", () => {
    const scheme = "(set_timer 1) (set_timer 2)";
    const { ts, statements } = lower(scheme);
    expect(statements).toHaveLength(2);
    expect(ts.slice(statements[0]!.tsRange[0], statements[0]!.tsRange[1])).toBe("set_timer(1)");
    expect(ts.slice(statements[1]!.tsRange[0], statements[1]!.tsRange[1])).toBe("set_timer(2)");
    for (const s of statements) {
      expect(scheme.slice(s.schemeSpan[0], s.schemeSpan[1]).trim()).toMatch(/^\(set_timer \d\)$/);
    }
  });

  // INVARIANT: a `#(...)` vector literal fuses into one statement span covering the `#`
  // mark plus the list.
  it("fuses `#(…)` into one statement covering the `#` mark + the list", () => {
    const { statements } = lower("#(1 2 3)");
    expect(statements).toHaveLength(1);
    expect(statements[0]!.schemeSpan).toEqual([0, 8]);
  });
});
