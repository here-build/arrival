/**
 * Residual algebra + ts.factory renderer — gate tests (residual-renderer.md §6,
 * constitution §3.4). Boolean pass/fail; every golden was verified against the pinned
 * typescript@6.0.2 printer (4-space indent, LF, trailing newline — prettier runs
 * downstream and is NOT part of this seam).
 */
import { describe, expect, it } from "vitest";

import { render, ResidualRenderError } from "../residual/render.js";
import type { CompilationUnit, Decl, R, TsType } from "../residual/types.js";
import {
  Annotated,
  ArrayLit,
  ArrayPattern,
  Arrow,
  Assign,
  Await,
  Bin,
  Binding,
  Block,
  Call,
  Comment,
  Cond,
  Const,
  ConstDecl,
  Continue,
  DeclComment,
  Export,
  FnDecl,
  ForOf,
  If,
  Import,
  ImportType,
  Index,
  Let,
  Lit,
  Member,
  Method,
  New,
  ObjectLit,
  Ref,
  RestBinding,
  Return,
  RuntimeRef,
  Spread,
  Template,
  Throw,
  Un,
  While,
} from "../residual/types.js";

const one = (node: R) => render({ decls: [], body: [node] });
const decl = (d: Decl) => render({ decls: [d], body: [] });

const x = Binding("x");
const y = Binding("y");
const a = Binding("a");
const b = Binding("b");
const n = Binding("n");
const o = Binding("o");
const d = Binding("d");
const e = Binding("e");
const t = Binding("t");
const p = Binding("p");
const f = Binding("f");
const xs = Binding("xs");
const foo = Binding("Foo");
const rest = Binding("rest");
const first = Binding("first");
const second = Binding("second");

const numberT: TsType = { k: "prim", name: "number" };
const stringT: TsType = { k: "prim", name: "string" };
const promiseOf = (arg: TsType): TsType => ({ k: "ref", name: "Promise", args: [arg] });

describe("every R constructor renders", () => {
  const rows: readonly (readonly [string, R, string])[] = [
    ["Ref", Ref(x), "x;\n"],
    ["RuntimeRef", RuntimeRef("runtimeCar"), "runtimeCar;\n"],
    ["Lit string", Lit("s"), '"s";\n'],
    ["Lit number", Lit(5), "5;\n"],
    ["Lit negative number (prefix-minus routing)", Lit(-5), "-5;\n"],
    ["Lit bigint", Lit(42n), "42n;\n"],
    ["Lit negative bigint (prefix-minus routing)", Lit(-42n), "-42n;\n"],
    ["Lit true", Lit(true), "true;\n"],
    ["Lit false", Lit(false), "false;\n"],
    ["Lit null", Lit(null), "null;\n"],
    ["Lit undefined", Lit(undefined), "undefined;\n"],
    ["Template", Template(["a", "b", "c"], [Ref(x), Ref(y)]), "`a${x}b${y}c`;\n"],
    ["Template zero-expr", Template(["hi"], []), "`hi`;\n"],
    ["Call (with Spread arg)", Call(Ref(f), [Lit(1), Spread(Ref(xs))]), "f(1, ...xs);\n"],
    ["New (args always present)", New(Ref(foo), []), "new Foo();\n"],
    ["Method", Method(Ref(xs), "slice", [Lit(1)]), "xs.slice(1);\n"],
    ["Index", Index(Ref(xs), Lit(0)), "xs[0];\n"],
    ["Member", Member(Ref(o), "f"), "o.f;\n"],
    ["Member kebab-case fallback", Member(Ref(d), "max-words"), 'd["max-words"];\n'],
    ["Bin", Bin("+", Lit(1), Lit(2)), "1 + 2;\n"],
    ["Un !", Un("!", Ref(x)), "!x;\n"],
    ["Un typeof (own factory call)", Un("typeof", Ref(x)), "typeof x;\n"],
    ["Un void (own factory call)", Un("void", Lit(0)), "void 0;\n"],
    ["Cond", Cond(Ref(t), Ref(a), Ref(b)), "t ? a : b;\n"],
    ["Arrow", Arrow([x], Bin("*", Ref(x), Lit(2))), "x => x * 2;\n"],
    ["ArrayLit (with Spread element)", ArrayLit([Ref(x), Spread(Ref(xs))]), "[x, ...xs];\n"],
    [
      "ObjectLit (ident key, kebab key, spread entry)",
      ObjectLit([
        { kind: "prop", key: "a", value: Lit(1) },
        { kind: "prop", key: "max-words", value: Lit(5) },
        { kind: "spread", value: Ref(o) },
      ]),
      '({ a: 1, "max-words": 5, ...o });\n',
    ],
    ["Await (module top level is TLA-legal)", Await(Ref(p)), "await p;\n"],
    ["Block at statement position (bare block)", Block([Call(Ref(f), [])]), "{\n    f();\n}\n"],
    ["Const", Const(x, Lit(5)), "const x = 5;\n"],
    ["Let", Let(x, Lit(5)), "let x = 5;\n"],
    ["Assign simple", Assign(a, Lit(1)), "a = 1;\n"],
    [
      "Assign tuple — TCO simultaneous reassign (ArrayLiteral LHS, not a binding pattern)",
      Assign(ArrayPattern([a, b]), ArrayLit([Ref(x), Ref(y)])),
      "[a, b] = [x, y];\n",
    ],
    ["While + Continue", While(Lit(true), Block([Continue()])), "while (true) {\n    continue;\n}\n"],
    [
      "If — the statement-position TCO branch (then/else blocks)",
      If(Ref(t), Block([Assign(a, Lit(1)), Continue()]), Block([Return(Ref(a))])),
      "if (t) {\n    a = 1;\n    continue;\n}\nelse {\n    return a;\n}\n",
    ],
    [
      "If — else-if chain (else may be another If)",
      If(Ref(t), Block([Return(Lit(1))]), If(Ref(p), Block([Return(Lit(2))]))),
      "if (t) {\n    return 1;\n}\nelse if (p) {\n    return 2;\n}\n",
    ],
    ["If — no else", If(Ref(t), Block([Return(Lit(1))])), "if (t) {\n    return 1;\n}\n"],
    [
      "ForOf",
      ForOf(n, Ref(xs), Block([Method(RuntimeRef("console"), "log", [Ref(n)])])),
      "for (const n of xs) {\n    console.log(n);\n}\n",
    ],
    ["Throw", Throw(Ref(e)), "throw e;\n"],
    ["Comment (leading block comment)", Comment(" note ", Call(Ref(f), [])), "/* note */\nf();\n"],
    [
      "Annotated(Arrow, ty) — arrow return type, one factory call",
      Annotated(Arrow([{ pattern: x, type: numberT }], Ref(x)), promiseOf(stringT)),
      "(x: number): Promise<string> => x;\n",
    ],
    ["Annotated as Const init — variable type", Const(n, Annotated(Lit(5), numberT)), "const n: number = 5;\n"],
  ];

  it.each(rows.map(([name, node, expected]) => ({ name, node, expected })))("$name", ({ node, expected }) => {
    expect(one(node)).toBe(expected);
  });

  it("Return renders (inside a function body)", () => {
    expect(one(Arrow([], Block([Return(Lit(1))])))).toBe("() => {\n    return 1;\n};\n");
    expect(one(Arrow([], Block([Return()])))).toBe("() => {\n    return;\n};\n");
  });
});

describe("every Decl constructor renders", () => {
  const rows: readonly (readonly [string, Decl, string])[] = [
    ["FnDecl", FnDecl(Binding("take"), [xs], Block([Return(Ref(xs))])), "function take(xs) {\n    return xs;\n}\n"],
    [
      "FnDecl async + returnType",
      FnDecl(Binding("go"), [], Block([Return(Await(Ref(p)))]), {
        async: true,
        returnType: promiseOf({ k: "prim", name: "void" }),
      }),
      "async function go(): Promise<void> {\n    return await p;\n}\n",
    ],
    ["ConstDecl (own type field)", ConstDecl(n, Lit(5), numberT), "const n: number = 5;\n"],
    ["Import (aliased + plain)", Import([{ imported: "a", local: "b" }, { imported: "c" }], "m"), 'import { a as b, c } from "m";\n'],
    [
      "ImportType — real type-only clause, no string smuggling",
      ImportType([{ imported: "ModelMessage" }], "ai"),
      'import type { ModelMessage } from "ai";\n',
    ],
    ["Export", Export(["a", "b"]), "export { a, b };\n"],
    [
      "DeclComment — leading block comment on the declaration",
      DeclComment(" doc ", FnDecl(Binding("take"), [xs], Block([Return(Ref(xs))]))),
      "/* doc */\nfunction take(xs) {\n    return xs;\n}\n",
    ],
  ];

  it.each(rows.map(([name, node, expected]) => ({ name, node, expected })))("$name", ({ node, expected }) => {
    expect(decl(node)).toBe(expected);
  });
});

describe("expression/statement duality — Block, one dispatch", () => {
  it("Block as Arrow.body renders as a literal block (no IIFE)", () => {
    expect(one(Arrow([], Block([Return(Lit(1))])))).toBe("() => {\n    return 1;\n};\n");
  });

  it("Block at statement position renders as a bare block", () => {
    expect(one(Block([Call(Ref(f), [])]))).toBe("{\n    f();\n}\n");
  });

  it("Block in expression position (Call arg) renders as a sync IIFE", () => {
    expect(one(Call(Ref(f), [Block([Return(Lit(1))])]))).toBe("f((() => {\n    return 1;\n})());\n");
  });

  it("Block containing Await in expression position renders as an async IIFE, awaited inline", () => {
    const unit = Const(x, Block([Return(Await(Call(Ref(f), [])))]));
    expect(one(unit)).toBe("const x = await (async () => {\n    return await f();\n})();\n");
  });
});

describe("parenthesization is factory-structural", () => {
  it("nested Cond in a Bin arm", () => {
    expect(one(Bin("+", Cond(Lit(2), Ref(a), Ref(b)), Lit(1)))).toBe("(2 ? a : b) + 1;\n");
  });

  it("Arrow in Call callee (immediate lambda)", () => {
    expect(one(Call(Arrow([x], Bin("*", Ref(x), Lit(2))), [Lit(3)]))).toBe("(x => x * 2)(3);\n");
  });

  it("Bin precedence, both operand sides", () => {
    expect(one(Bin("*", Bin("+", Ref(a), Ref(b)), Ref(x)))).toBe("(a + b) * x;\n");
    expect(one(Bin("-", Ref(a), Bin("-", Ref(b), Ref(x))))).toBe("a - (b - x);\n");
  });

  it("New with mandatory args prints safe before a Member", () => {
    expect(one(Member(New(Ref(foo), []), "bar"))).toBe("new Foo().bar;\n");
  });

  it("(await x).f", () => {
    expect(one(Member(Await(Ref(x)), "f"))).toBe("(await x).f;\n");
  });

  it("Await nested under Member — no nesting-position restriction on Await", () => {
    expect(one(Member(Await(Call(Ref(f), [])), "text"))).toBe("(await f()).text;\n");
  });

  it("object literal at statement position is wrapped", () => {
    expect(one(ObjectLit([{ kind: "prop", key: "a", value: Lit(1) }]))).toBe("({ a: 1 });\n");
  });

  it("arrow object-literal concise body is wrapped", () => {
    expect(one(Arrow([x], ObjectLit([{ kind: "prop", key: "a", value: Lit(1) }])))).toBe("x => ({ a: 1 });\n");
  });
});

describe("patterns and params", () => {
  it("ArrayPattern param (destructureTuple shape)", () => {
    expect(one(Arrow([ArrayPattern([first, second])], Ref(second)))).toBe("([first, second]) => second;\n");
  });

  it("RestBinding as last param", () => {
    expect(one(Arrow([x, RestBinding(rest)], Ref(rest)))).toBe("(x, ...rest) => rest;\n");
  });

  it("ArrayPattern with trailing RestBinding in binding position (Const)", () => {
    expect(one(Const(ArrayPattern([first, RestBinding(rest)]), Ref(xs)))).toBe("const [first, ...rest] = xs;\n");
  });

  it("bare Pattern and explicit Param produce identical trees for the untyped case", () => {
    expect(one(Arrow([x], Ref(x)))).toBe(one(Arrow([{ pattern: x }], Ref(x))));
  });

  it("typed Param annotates the slot", () => {
    expect(one(Arrow([{ pattern: x, type: numberT }], Ref(x)))).toBe("(x: number) => x;\n");
  });

  it("RestBinding not in last param position throws", () => {
    expect(() => one(Arrow([RestBinding(rest), x], Ref(x)))).toThrow(ResidualRenderError);
  });

  it("RestBinding not last inside an ArrayPattern throws", () => {
    expect(() => one(Const(ArrayPattern([RestBinding(rest), first]), Ref(xs)))).toThrow(ResidualRenderError);
  });
});

describe("comments", () => {
  it("Comment renders as a leading block comment with trailing newline", () => {
    expect(one(Comment(" note ", Call(Ref(f), [])))).toBe("/* note */\nf();\n");
  });

  it("Comment leading the last statement of a Block stays attached (relocation hazard)", () => {
    expect(one(Block([Call(Ref(f), []), Comment(" tail ", Call(Ref(o), []))]))).toBe(
      "{\n    f();\n    /* tail */\n    o();\n}\n",
    );
  });

  it("adjacent Comment-wrapped statements do not bleed", () => {
    expect(one(Block([Comment(" one ", Call(Ref(f), [])), Comment(" two ", Call(Ref(o), []))]))).toBe(
      "{\n    /* one */\n    f();\n    /* two */\n    o();\n}\n",
    );
  });
});

describe("renderer assertions fail loudly, never miscompile", () => {
  it("Await under a sync Arrow throws", () => {
    expect(() => one(Arrow([], Block([Return(Await(Ref(p)))])))).toThrow(ResidualRenderError);
    expect(() => one(Arrow([], Block([Return(Await(Ref(p)))])))).toThrow(/Await under a non-async function boundary/);
  });

  it("Block-with-Await IIFE synthesis under a sync Arrow throws", () => {
    expect(() => one(Arrow([], Call(Ref(f), [Block([Await(Ref(p))])])))).toThrow(
      /Block containing Await reached expression position under a non-async function boundary/,
    );
  });

  it("the same tree under an async Arrow renders", () => {
    expect(one(Arrow([], Block([Return(Await(Ref(p)))]), true))).toBe("async () => {\n    return await p;\n};\n");
  });

  it("an inner sync Arrow re-establishes the boundary even inside an async one", () => {
    expect(() => one(Arrow([], Block([Return(Arrow([], Block([Return(Await(Ref(p)))])))]), true))).toThrow(
      ResidualRenderError,
    );
  });

  it("Template arity violation throws", () => {
    expect(() => one(Template(["a"], [Ref(x)]))).toThrow(/Template arity/);
  });

  it("Spread outside ArrayLit/Call/New args throws", () => {
    expect(() => one(Bin("+", Spread(Ref(xs)), Lit(1)))).toThrow(/Spread is legal only/);
  });

  it("Annotated in a non-declaration, non-Arrow position throws", () => {
    expect(() => one(Call(Ref(f), [Annotated(Lit(5), numberT)]))).toThrow(/Annotated has exactly two legal shapes/);
  });

  it("statement-only nodes in expression position throw", () => {
    expect(() => one(Call(Ref(f), [Continue()]))).toThrow(/statement-only node Continue in expression position/);
    expect(() => one(Call(Ref(f), [Return(Lit(1))]))).toThrow(/statement-only node Return/);
    expect(() => one(Call(Ref(f), [While(Lit(true), Block([]))]))).toThrow(/statement-only node While/);
    expect(() => one(Call(Ref(f), [Throw(Ref(e))]))).toThrow(/statement-only node Throw/);
    expect(() => one(Call(Ref(f), [If(Ref(t), Block([]))]))).toThrow(/statement-only node If/);
  });

  it("If.else must be a Block or a chained If", () => {
    expect(() => one(If(Ref(t), Block([]), Lit(1)))).toThrow(/If\.else must be a Block or a chained If/);
  });
});

describe("composed program golden", () => {
  it("Const + Arrow + Method chain + ForOf", () => {
    const result = Binding("result");
    const isBig = Binding("isBig");
    const unit: CompilationUnit = {
      decls: [],
      body: [
        Const(
          result,
          Method(Method(Ref(xs), "map", [Arrow([x], Bin("*", Ref(x), Lit(2)))]), "filter", [Ref(isBig)]),
        ),
        ForOf(n, Ref(result), Block([Method(RuntimeRef("console"), "log", [Ref(n)])])),
      ],
    };
    const expected =
      "const result = xs.map(x => x * 2).filter(isBig);\n" +
      "for (const n of result) {\n" +
      "    console.log(n);\n" +
      "}\n";
    expect(render(unit)).toBe(expected);
    // §4.7 determinism: same unit, fresh printer → same bytes.
    expect(render(unit)).toBe(expected);
  });

  it("decls render before body, in given order", () => {
    const unit: CompilationUnit = {
      decls: [Import([{ imported: "generateText" }], "ai"), ConstDecl(n, Lit(5))],
      body: [Call(Ref(f), [Ref(n)])],
    };
    expect(render(unit)).toBe('import { generateText } from "ai";\nconst n = 5;\nf(n);\n');
  });
});
