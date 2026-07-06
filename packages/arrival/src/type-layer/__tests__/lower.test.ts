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
  it("application keeps the head + scheme arg order", () => {
    expect(ts1("(foo a b)")).toBe("foo(a, b)");
  });

  it("a non-identifier head routes through the `_` namespace under its escaped, dotted name", () => {
    expect(ts1("(+ a b)")).toBe("_.$plus$(a, b)");
    expect(ts1("(string-append a b)")).toBe("_.string$dash$append(a, b)");
  });

  it("kwargs: a `:keyword value` run flips into a real object literal `{ key: value }`", () => {
    expect(ts1('(create_user :name "Ada")')).toBe('create_user({ name: "Ada" })');
    expect(ts1('(create_user :name "Ada" :mode "fast")')).toBe('create_user({ name: "Ada", mode: "fast" })');
  });

  it("kwargs: leading positional args stay positional; keywords fold into a trailing object", () => {
    expect(ts1("(f x :a 1)")).toBe("f(x, { a: 1 })");
  });

  it("kwargs: a bare keyword with no value lowers to `{ key: undefined }` (the property type bites)", () => {
    expect(ts1("(create_user :name)")).toBe("create_user({ name: undefined })");
  });

  it("car / cdr are functional carrier globals, not field reads", () => {
    expect(ts1("(car x)")).toBe("car(x)");
    expect(ts1("(cdr x)")).toBe("cdr(x)");
  });

  it("list / cons / quoted lists lower to the carrier constructors", () => {
    expect(ts1("(list a b)")).toBe("list(a, b)");
    expect(ts1("(cons a b)")).toBe("cons(a, b)");
    expect(ts1("'(a b c)")).toBe("list(a, b, c)");
    expect(ts1("'()")).toBe("list()");
  });

  it("a vector literal lowers to a native TS array", () => {
    expect(ts1("#(a b c)")).toBe("[a, b, c]");
    expect(ts1("(foo #(1 2 3))")).toBe("foo([1, 2, 3])");
  });

  it("dict → object literal; keyword head → field read", () => {
    expect(ts1('(dict :name "a" :age 30)')).toBe('{ name: "a", age: 30 }');
    expect(ts1("(:key obj)")).toBe('obj["key"]');
  });

  it("lambda → an arrow", () => {
    expect(ts1("(lambda (x y) (+ x y))")).toBe("((x, y) => _.$plus$(x, y))");
  });

  it("atoms: strings, numbers, booleans", () => {
    expect(ts1('"hi"')).toBe('"hi"');
    expect(ts1("42")).toBe("42");
    expect(ts1("-5")).toBe("-5");
    expect(ts1("#t")).toBe("true");
    expect(ts1("#f")).toBe("false");
  });

  it("multiple top-level forms become `;\\n`-separated statements", () => {
    expect(ts1("(foo 1) (bar 2)")).toBe("foo(1);\nbar(2)");
  });
});

describe("lower — quoted data recurses (the false-positive killer)", () => {
  it("a quoted NESTED list recurses as quoted data, never an application", () => {
    expect(ts1('\'(("a" 1))')).toBe('list(list("a", 1))');
  });

  it("a flat quoted list is unchanged", () => {
    expect(ts1("'(1 2 3)")).toBe("list(1, 2, 3)");
  });

  it("a dotted quoted pair lowers to cons", () => {
    expect(ts1("'((k . v))")).toBe("list(cons(k, v))");
  });

  it("deep nesting recurses at every level", () => {
    expect(ts1("'((1 (2 3)) 4)")).toBe("list(list(1, list(2, 3)), 4)");
  });

  it("a multi-element dotted list folds right through the proper elements", () => {
    expect(ts1("'(a b . c)")).toBe("cons(a, cons(b, c))");
  });
});

describe("lower — quasiquote degrades to quoted data, unquote stays live", () => {
  it("a quasiquoted list with no unquote lowers exactly like a quote", () => {
    expect(ts1("`(a b c)")).toBe("list(a, b, c)");
  });

  it("an (unquote e) node inside emits the LIVE expression, not further-quoted data", () => {
    expect(ts1("`(a ,b c)")).toBe("list(a, b, c)");
  });

  it("unquote-splicing also emits the live expression", () => {
    expect(ts1("`(a ,@b c)")).toBe("list(a, b, c)");
  });

  it("a nested quasiquoted list still recurses as quoted data", () => {
    expect(ts1("`((a ,b) c)")).toBe("list(list(a, b), c)");
  });

  it("a stray unquote outside a quasiquote stays inert (degrades to the live inner expr)", () => {
    expect(ts1(",b")).toBe("b");
  });
});

describe("lower — top-level define lowers to a const statement", () => {
  it("(define x e) → const x = e", () => {
    expect(ts1("(define x 5)")).toBe("const x = 5");
  });

  it("(define (f a b) body) → const f = (a: any, b: any) => body", () => {
    expect(ts1("(define (add2 a b) (+ a b))")).toBe("const add2 = (a: any, b: any) => _.$plus$(a, b)");
  });

  it("a multi-form function body folds to a comma sequence, mirroring emitLambda", () => {
    expect(ts1("(define (f x) (foo x) (bar x))")).toBe("const f = (x: any) => (foo(x), bar(x))");
  });

  it("a zero-arg function define", () => {
    expect(ts1("(define (f) 1)")).toBe("const f = () => 1");
  });

  it("(define x) with no value lowers to undefined", () => {
    expect(ts1("(define x)")).toBe("const x = undefined");
  });

  it("multiple top-level defines are separate const statements", () => {
    expect(ts1("(define x 1) (define y 2)")).toBe("const x = 1;\nconst y = 2");
  });

  it("a NESTED define (inside a lambda body) keeps the prior application-call lowering", () => {
    expect(ts1("(lambda () (define x 1) x)")).toBe("(() => (define(x, 1), x))");
  });

  it("integration: a defined helper's arity mismatch actually type-checks against real params", () => {
    const errors = compileErrors(`${lower("(define (add2 a b) a) (add2 1)").ts}\n`);
    expect(errors.length).toBeGreaterThan(0); // TS2554 — too few arguments
  });
});

describe("lower — s.* combinators (TS reserved-word forms)", () => {
  it("if → s.if(c, a, b) / s.if(c, a)", () => {
    expect(ts1("(if #t 1 2)")).toBe("s.if(true, 1, 2)");
    expect(ts1("(if #t 1)")).toBe("s.if(true, 1)");
  });

  it("let → s.let(v1, v2, (a, b) => body)", () => {
    expect(ts1("(let ((a 1) (b 2)) (+ a b))")).toBe("s.let(1, 2, (a, b) => _.$plus$(a, b))");
  });

  it("named let → s.namedLet(v, (loop, i) => body)", () => {
    expect(ts1("(let loop ((i 0)) (loop i))")).toBe("s.namedLet(0, (loop, i) => loop(i))");
  });

  it("let* → nested s.let calls (sequential scoping)", () => {
    expect(ts1("(let* ((a 1) (b a)) b)")).toBe("s.let(1, (a) => s.let(a, (b) => b))");
  });

  it("letrec / letrec* → the same flat emission as let (advisory fidelity)", () => {
    expect(ts1("(letrec ((a 1)) a)")).toBe("s.let(1, (a) => a)");
    expect(ts1("(letrec* ((a 1)) a)")).toBe("s.let(1, (a) => a)");
  });

  it("cond → s.cond([test, e], …, [true, d]) — else becomes true", () => {
    expect(ts1("(cond (#t 1) (else 2))")).toBe("s.cond([true, 1], [true, 2])");
  });

  it("do / case → parse-safety only", () => {
    expect(ts1("(do 1 2)")).toBe("s.do(1, 2)");
    expect(ts1("(case x (1 2))")).toBe("s.case(x, _.$1$(2))"); // parse-safety only — shape is incidental
  });

  it("a reserved word in ARGUMENT/value position routes through `_`, never prints bare", () => {
    expect(ts1("(f for)")).toBe("f(_.for)");
    expect(ts1("(f class new return)")).toBe("f(_.class, _.new, _.return)");
  });

  it("integration: (if ...) type-checks and narrows through the carrier `s` namespace", () => {
    const errors = compileErrors(`${carrierVocabularyText}\n${lower("(if #t 1 2)").ts}\n`);
    expect(errors).toEqual([]);
    const narrowed: string = "const _x: number = s.if(true, 1, 2);";
    expect(compileErrors(`${carrierVocabularyText}\n${narrowed}\n`)).toEqual([]);
  });

  it("integration: (let ((a 1)) a) type-checks and infers the bound type", () => {
    const errors = compileErrors(`${carrierVocabularyText}\nconst _x: number = ${lower("(let ((a 1)) a)").ts};\n`);
    expect(errors).toEqual([]);
  });

  it("integration: (cond (#t 1) (else 2)) type-checks", () => {
    const errors = compileErrors(
      `${carrierVocabularyText}\nconst _x: number = ${lower("(cond (#t 1) (else 2))").ts};\n`,
    );
    expect(errors).toEqual([]);
  });
});

describe("lower — integration: lowered call ∩ harvested prelude", () => {
  // get-route takes a proper list (z.pair | z.nil → List) + a string; set-timer takes a number.
  const getRoute = symbol.rosetta`get-route: route between stops`(
    { input: [z.union([z.pair, z.nil]), z.string], output: [z.string] },
    () => "",
  );
  const setTimer = symbol.native`set-timer: start a timer`(
    { input: [z.number], output: [z.undefinedResult] },
    () => undefined,
  );
  const entries = [
    ["get_route", getRoute],
    ["set_timer", setTimer],
  ] as const;

  const compileLowered = (scheme: string): string[] => {
    const { prelude } = assembleHarvestedPrelude(entries);
    return compileErrors(`${prelude}\n${lower(scheme).ts}\n`);
  };

  it("a VALID lowered call type-checks clean against the harvest", () => {
    expect(compileLowered('(set_timer 600)\n(get_route \'("A" "B") "fast")')).toEqual([]);
  });

  it("a vector where a list is expected BITES", () => {
    expect(compileLowered('(get_route #(1 2 3) "fast")').length).toBeGreaterThan(0);
  });

  it("a string where a number is expected BITES", () => {
    expect(compileLowered('(set_timer "ten")').length).toBeGreaterThan(0);
  });
});

describe("lower — per-statement span-map (additive)", () => {
  it("preserves `{ ts }` verbatim", () => {
    expect(lower("(set_timer 600)").ts).toBe("set_timer(600)");
  });

  it("single statement: one entry, tsRange slices the whole output, schemeSpan covers the form", () => {
    const { ts, statements } = lower("(set_timer 600)");
    expect(statements).toHaveLength(1);
    expect(ts.slice(statements[0]!.tsRange[0], statements[0]!.tsRange[1])).toBe(ts);
    expect(statements[0]!.schemeSpan).toEqual([0, 15]);
  });

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

  it("fuses `#(…)` into one statement covering the `#` mark + the list", () => {
    const { statements } = lower("#(1 2 3)");
    expect(statements).toHaveLength(1);
    expect(statements[0]!.schemeSpan).toEqual([0, 8]);
  });
});
