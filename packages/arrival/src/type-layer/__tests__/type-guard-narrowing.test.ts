// Dual type-guard harvest — control-flow narrowing pins.
// type: fields are inline dedent`…` on the packs; this suite re-states the critical
// dual shapes for checker inference (not importing shared constants).
import { describe, expect, it } from "vitest";
import ts from "typescript";
import dedent from "dedent";
import { signatureOf } from "../schema-to-ts.js";
import equality from "../../env/r7rs/equality.js";
import vectors from "../../env/r7rs/vectors.js";
import { symbol } from "../../common/symbol.js";
import { contractOf } from "../../common/capability.js";
import { harvestContracts } from "../../__tests__/_symbols-harvest.js";
import * as z from "../../common/scheme-zod.js";

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

const LIST_DUAL = dedent`
  {
    (x: unknown): x is List<unknown>;
    <T>(x: T): x is Extract<T, List<any>>;
  }
`;
const PAIR_DUAL = dedent`
  {
    (x: unknown): x is Pair<unknown, unknown>;
    <T>(x: T): x is Extract<T, Pair<any, any>>;
  }
`;
const VECTOR_DUAL = dedent`
  {
    (x: unknown): x is readonly unknown[];
    <T>(x: T): x is Extract<T, readonly any[]>;
  }
`;

const AMBIENT = `
declare const LIST_BRAND: unique symbol;
interface Cons<out T> { readonly [LIST_BRAND]: T; }
type List<T> = Cons<T> | null;
interface Pair<out H, out T> { readonly car: H; readonly cdr: T; }
`;

function narrowedType(opts: { guardSig: string; inputType: string }): string {
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

describe("harvested list?/pair?/vector? signatures are dual guards (inline dedent)", () => {
  it("list?", () => {
    const def = harvestContracts(equality.spec.symbols)["list?"];
    expect(norm(signatureOf(def))).toBe(norm(LIST_DUAL));
  });
  it("pair?", () => {
    const def = harvestContracts(equality.spec.symbols)["pair?"];
    expect(norm(signatureOf(def))).toBe(norm(PAIR_DUAL));
  });
  it("vector?", () => {
    const def = harvestContracts(vectors.spec.symbols)["vector?"];
    expect(norm(signatureOf(def))).toBe(norm(VECTOR_DUAL));
  });
});

describe("dual guard control-flow narrowing (lens-critical)", () => {
  it("list?: unknown → List<unknown>", () => {
    const t = narrowedType({ guardSig: LIST_DUAL, inputType: "unknown" });
    expect(t).toMatch(/List<unknown>|Cons<unknown>\s*\|\s*null/);
  });

  it("list?: string | List<number> keeps List<number>", () => {
    const t = narrowedType({
      guardSig: LIST_DUAL,
      inputType: "string | List<number>",
    });
    expect(t).toMatch(/number/);
    expect(t).not.toMatch(/string/);
    expect(t).not.toBe("List<unknown>");
  });

  it("list?: List<string> | number keeps List<string>", () => {
    const t = narrowedType({
      guardSig: LIST_DUAL,
      inputType: "List<string> | number",
    });
    expect(t).toMatch(/string/);
    expect(t).not.toMatch(/number/);
  });

  it("vector?: string | readonly number[] keeps number[]", () => {
    const t = narrowedType({
      guardSig: VECTOR_DUAL,
      inputType: "string | readonly number[]",
    });
    expect(t).toMatch(/number/);
    expect(t).not.toMatch(/string/);
  });

  it("pair?: string | Pair<number, boolean> keeps Pair", () => {
    const t = narrowedType({
      guardSig: PAIR_DUAL,
      inputType: "string | Pair<number, boolean>",
    });
    expect(t).toMatch(/number/);
    expect(t).toMatch(/boolean/);
    expect(t).not.toMatch(/string/);
  });

  it("signatureOf passes dual type: through unchanged", () => {
    const def = symbol.native`list?: pin`(
      { input: [z.value], output: [z.boolean], type: LIST_DUAL },
      () => true,
    );
    expect(norm(signatureOf(contractOf(def)!))).toBe(norm(LIST_DUAL));
  });
});
