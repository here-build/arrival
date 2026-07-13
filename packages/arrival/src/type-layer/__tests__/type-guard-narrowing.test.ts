// Dual type-guard harvest — control-flow narrowing pins.
//
// list?/pair?/vector? (and sibling ? predicates) harvest as dual call signatures:
//   { (x: unknown): x is Container;
//     <T>(x: T): x is Extract<T, ContainerAny>; }
// so unknown → Container and string | List<number> → List<number> (element kept).
//
// Uses the real harvested signatures from the r7rs packs + the same TypeScript
// checker the lens uses (not a hand-rolled dual string).
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { signatureOf } from "../schema-to-ts.js";
import {
  LIST_TYPE_GUARD,
  PAIR_TYPE_GUARD,
  VECTOR_TYPE_GUARD,
  dualTypeGuard,
} from "../../common/type-guard-sig.js";
import equality from "../../env/r7rs/equality.js";
import vectors from "../../env/r7rs/vectors.js";
import { symbol } from "../../common/symbol.js";
import * as z from "../../common/scheme-zod.js";

/** Minimal carrier ambient — full carriers-text pulls lib collisions (`length`, …). */
const AMBIENT = `
declare const LIST_BRAND: unique symbol;
interface Cons<out T> { readonly [LIST_BRAND]: T; }
type List<T> = Cons<T> | null;
interface Pair<out H, out T> { readonly car: H; readonly cdr: T; }
`;

/** Compile a probe and return type-string of `typeof narrowed` after `if (guard(x))`. */
function narrowedType(opts: {
  guardSig: string;
  inputType: string;
}): string {
  const source = [
    AMBIENT,
    `declare const guard: ${opts.guardSig};`,
    `declare const x: ${opts.inputType};`,
    `if (guard(x)) { type __N = typeof x; }`,
  ].join("\n");

  const file = "/virtual/guard-narrow.ts";
  const host = ts.createCompilerHost({ strict: true, noEmit: true });
  const origGetSourceFile = host.getSourceFile.bind(host);
  const origFileExists = host.fileExists.bind(host);
  const origReadFile = host.readFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    if (fileName === file) {
      return ts.createSourceFile(file, source, languageVersion, true, ts.ScriptKind.TS);
    }
    return origGetSourceFile(fileName, languageVersion, onError, shouldCreate);
  };
  host.fileExists = (f) => f === file || origFileExists(f);
  host.readFile = (f) => (f === file ? source : origReadFile(f));

  const prog = ts.createProgram([file], { strict: true, noEmit: true, target: ts.ScriptTarget.ES2022 }, host);
  const sf = prog.getSourceFile(file);
  if (!sf) throw new Error("virtual source missing");
  const checker = prog.getTypeChecker();

  let result: string | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === "__N") {
      result = checker.typeToString(
        checker.getTypeFromTypeNode(node.type),
        node,
        ts.TypeFormatFlags.NoTruncation,
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  const diags = ts.getPreEmitDiagnostics(prog).filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (diags.length) {
    const msgs = diags.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")).join("; ");
    throw new Error(`probe failed for input ${opts.inputType}: ${msgs}`);
  }
  if (result === undefined) throw new Error("did not find __N");
  return result;
}

describe("dualTypeGuard string shape", () => {
  it("builds dual call signatures with free Extract arm", () => {
    expect(dualTypeGuard("List<unknown>", "List<any>")).toBe(
      "{ (x: unknown): x is List<unknown>; <T>(x: T): x is Extract<T, List<any>>; }",
    );
    expect(LIST_TYPE_GUARD).toContain("Extract<T, List<any>>");
    expect(PAIR_TYPE_GUARD).toContain("Pair<any, any>");
    expect(VECTOR_TYPE_GUARD).toContain("readonly any[]");
  });
});

describe("harvested list?/pair?/vector? signatures are dual guards", () => {
  it("list? harvest matches LIST_TYPE_GUARD", () => {
    const def = (equality.spec.symbols as Record<string, { type?: string }>)["list?"];
    expect(signatureOf(def as never)).toBe(LIST_TYPE_GUARD);
  });
  it("pair? harvest matches PAIR_TYPE_GUARD", () => {
    const def = (equality.spec.symbols as Record<string, { type?: string }>)["pair?"];
    expect(signatureOf(def as never)).toBe(PAIR_TYPE_GUARD);
  });
  it("vector? harvest matches VECTOR_TYPE_GUARD", () => {
    const def = (vectors.spec.symbols as Record<string, { type?: string }>)["vector?"];
    expect(signatureOf(def as never)).toBe(VECTOR_TYPE_GUARD);
  });
});

describe("dual guard control-flow narrowing (lens-critical)", () => {
  it("list?: unknown → List<unknown>", () => {
    const t = narrowedType({ guardSig: LIST_TYPE_GUARD, inputType: "unknown" });
    expect(t).toMatch(/List<unknown>|Cons<unknown>\s*\|\s*null/);
  });

  it("list?: string | List<number> keeps List<number> (element preserved)", () => {
    const t = narrowedType({
      guardSig: LIST_TYPE_GUARD,
      inputType: "string | List<number>",
    });
    // Accept Cons<number>|null or List<number>
    expect(t).toMatch(/number/);
    expect(t).not.toMatch(/string/);
    expect(t).not.toBe("List<unknown>");
  });

  it("list?: List<string> | number keeps List<string>", () => {
    const t = narrowedType({
      guardSig: LIST_TYPE_GUARD,
      inputType: "List<string> | number",
    });
    expect(t).toMatch(/string/);
    expect(t).not.toMatch(/number/);
  });

  it("vector?: string | readonly number[] keeps readonly number[]", () => {
    const t = narrowedType({
      guardSig: VECTOR_TYPE_GUARD,
      inputType: "string | readonly number[]",
    });
    expect(t).toMatch(/number/);
    expect(t).not.toMatch(/string/);
  });

  it("pair?: string | Pair<number, boolean> keeps Pair<number, boolean>", () => {
    const t = narrowedType({
      guardSig: PAIR_TYPE_GUARD,
      inputType: "string | Pair<number, boolean>",
    });
    expect(t).toMatch(/number/);
    expect(t).toMatch(/boolean/);
    expect(t).not.toMatch(/string/);
  });

  it("monomorphic (x: unknown) => x is List<unknown> is WEAKER than dual on pure unknown (still List) but dual is required for Extract path", () => {
    // Document the dual's unknown arm still works (not Extract-only never).
    const mono = narrowedType({
      guardSig: "(x: unknown) => x is List<unknown>",
      inputType: "unknown",
    });
    const dual = narrowedType({
      guardSig: LIST_TYPE_GUARD,
      inputType: "unknown",
    });
    expect(mono).toMatch(/List|Cons/);
    expect(dual).toMatch(/List|Cons/);
  });

  it("signatureOf passes dual type: through unchanged", () => {
    const def = symbol.native`list?: pin`(
      { input: [z.value], output: [z.boolean], type: LIST_TYPE_GUARD },
      () => true,
    );
    expect(signatureOf(def)).toBe(LIST_TYPE_GUARD);
  });
});
