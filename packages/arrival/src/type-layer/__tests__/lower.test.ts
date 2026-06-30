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

describe("lower — scheme → TS emitter", () => {
  const ts1 = (src: string) => lower(src).ts;

  it("application keeps the head + scheme arg order", () => {
    expect(ts1("(foo a b)")).toBe("foo(a, b)");
  });

  it("a non-identifier head routes through the `_` namespace under its escaped, dotted name", () => {
    expect(ts1("(+ a b)")).toBe("_.$plus$(a, b)");
    expect(ts1("(string-append a b)")).toBe("_.string$dash$append(a, b)");
  });

  it("kwargs: a `:keyword value` run groups into [\":keyword\", value] pairs (the ObjectToKwargs shape)", () => {
    expect(ts1('(create_user :name "Ada")')).toBe('create_user([":name", "Ada"])');
    expect(ts1('(create_user :name "Ada" :mode "fast")')).toBe('create_user([":name", "Ada"], [":mode", "fast"])');
  });

  it("kwargs: a positional arg before keywords stays positional", () => {
    expect(ts1("(f x :a 1)")).toBe('f(x, [":a", 1])');
  });

  it("kwargs: a bare keyword with no value lowers to a length-1 tuple (the all-or-nothing ban)", () => {
    expect(ts1("(create_user :name)")).toBe('create_user([":name"])');
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

describe("lower — integration: lowered call ∩ harvested prelude", () => {
  // get-route takes a proper list (z.pair | z.nil → List) + a string; set-timer takes a number.
  const getRoute = symbol.rosetta`get-route: route between stops`(
    { input: [z.union([z.pair, z.nil]), z.string], output: [z.string] },
    () => "",
  );
  const setTimer = symbol.native`set-timer: start a timer`({ input: [z.number], output: [z.void()] }, () => undefined);
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
