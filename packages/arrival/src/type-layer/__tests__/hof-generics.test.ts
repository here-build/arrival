// Faithful generic HOF harvest (map/filter/reduce/…) — inference pins.
//
// Harvest signatures live in common/hof-sig.ts and are wired as `type:` on the
// r7rs/srfi packs. This suite typechecks dual List|vector overloads with the
// real TypeScript checker (same discipline as type-guard-narrowing.test.ts).
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { signatureOf } from "../schema-to-ts.js";
import {
  FILTER_HOF,
  FIND_HOF,
  FOR_EACH_HOF,
  MAP_HOF,
  REDUCE_HOF,
  STRING_MAP_HOF,
  TAKE_WHILE_HOF,
  VECTOR_MAP_HOF,
} from "../../common/hof-sig.js";
import lists from "../../env/r7rs/lists.js";
import vectors from "../../env/r7rs/vectors.js";
import strings from "../../env/r7rs/strings.js";
import srfi1 from "../../env/srfi/srfi-1.js";

const AMBIENT = `
declare const LIST_BRAND: unique symbol;
interface Cons<out T> { readonly [LIST_BRAND]: T; }
type List<T> = Cons<T> | null;
`;

function inferCall(opts: {
  hofSig: string;
  call: string; // e.g. `map((n: number) => String(n), xs)`
  bindings?: string; // declare const xs: List<number>;
}): string {
  const source = [
    AMBIENT,
    `declare const map: ${opts.hofSig};`,
    // alias common names so call can use map/filter/reduce freely
    `declare const filter: ${opts.hofSig};`,
    `declare const reduce: ${opts.hofSig};`,
    `declare const find: ${opts.hofSig};`,
    `declare const takeWhile: ${opts.hofSig};`,
    `declare const vectorMap: ${opts.hofSig};`,
    `declare const stringMap: ${opts.hofSig};`,
    opts.bindings ?? "",
    `const __r = ${opts.call};`,
    `type __R = typeof __r;`,
  ].join("\n");

  const file = "/virtual/hof-infer.ts";
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

  const prog = ts.createProgram(
    [file],
    { strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, noUnusedLocals: false },
    host,
  );
  const sf = prog.getSourceFile(file);
  if (!sf) throw new Error("missing virtual source");
  const checker = prog.getTypeChecker();

  let result: string | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === "__R") {
      result = checker.typeToString(
        checker.getTypeFromTypeNode(node.type),
        node,
        ts.TypeFormatFlags.NoTruncation,
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  const diags = ts
    .getPreEmitDiagnostics(prog)
    .filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (diags.length) {
    const msgs = diags.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")).join("; ");
    throw new Error(`infer failed for ${opts.call}: ${msgs}`);
  }
  if (result === undefined) throw new Error("no __R");
  return result;
}

/** Infer with a single bind of `fn` to the HOF signature (correct for each test). */
function infer(hofSig: string, bindings: string, call: string): string {
  const source = [
    AMBIENT,
    `declare const fn: ${hofSig};`,
    bindings,
    `const __r = ${call};`,
    `type __R = typeof __r;`,
  ].join("\n");

  const file = "/virtual/hof-infer2.ts";
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

  const prog = ts.createProgram(
    [file],
    { strict: true, noEmit: true, target: ts.ScriptTarget.ES2022 },
    host,
  );
  const sf = prog.getSourceFile(file)!;
  const checker = prog.getTypeChecker();
  let result: string | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === "__R") {
      result = checker.typeToString(
        checker.getTypeFromTypeNode(node.type),
        node,
        ts.TypeFormatFlags.NoTruncation,
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  const diags = ts
    .getPreEmitDiagnostics(prog)
    .filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (diags.length) {
    const msgs = diags.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")).join("; ");
    throw new Error(`infer failed: ${msgs}\n${source}`);
  }
  if (!result) throw new Error("no __R");
  return result;
}

describe("harvested HOF signatures are faithful generics", () => {
  it("map harvest is MAP_HOF", () => {
    expect(signatureOf((lists.spec.symbols as any).map)).toBe(MAP_HOF);
  });
  it("for-each harvest is FOR_EACH_HOF", () => {
    expect(signatureOf((lists.spec.symbols as any)["for-each"])).toBe(FOR_EACH_HOF);
  });
  it("filter harvest is FILTER_HOF", () => {
    expect(signatureOf((srfi1.spec.symbols as any).filter)).toBe(FILTER_HOF);
  });
  it("reduce harvest is REDUCE_HOF", () => {
    expect(signatureOf((srfi1.spec.symbols as any).reduce)).toBe(REDUCE_HOF);
  });
  it("find harvest is FIND_HOF", () => {
    expect(signatureOf((srfi1.spec.symbols as any).find)).toBe(FIND_HOF);
  });
  it("vector-map harvest is VECTOR_MAP_HOF", () => {
    expect(signatureOf((vectors.spec.symbols as any)["vector-map"])).toBe(VECTOR_MAP_HOF);
  });
  it("string-map harvest is STRING_MAP_HOF", () => {
    expect(signatureOf((strings.spec.symbols as any)["string-map"])).toBe(STRING_MAP_HOF);
  });
  it("take-while harvest is TAKE_WHILE_HOF", () => {
    expect(signatureOf((srfi1.spec.symbols as any)["take-while"])).toBe(TAKE_WHILE_HOF);
  });
});

describe("HOF generic inference (List|vector dual)", () => {
  it("map list: List<number> → List<string>", () => {
    const t = infer(
      MAP_HOF,
      "declare const xs: List<number>;",
      "fn((n) => String(n), xs)",
    );
    expect(t).toMatch(/List<string>|Cons<string>/);
  });

  it("map vector: readonly number[] → readonly string[]", () => {
    const t = infer(
      MAP_HOF,
      "declare const xs: readonly number[];",
      "fn((n) => String(n), xs)",
    );
    expect(t).toMatch(/string/);
    expect(t).toMatch(/readonly|\[\]/);
  });

  it("map two lists zips element types", () => {
    const t = infer(
      MAP_HOF,
      "declare const as: List<number>; declare const bs: List<string>;",
      "fn((n, s) => n + s.length, as, bs)",
    );
    expect(t).toMatch(/List<number>|Cons<number>/);
  });

  it("filter type-guard keeps refined element", () => {
    const t = infer(
      FILTER_HOF,
      "declare const xs: List<number>;",
      "fn((n: number): n is 0 | 1 => n === 0 || n === 1, xs)",
    );
    expect(t).toMatch(/0|1/);
  });

  it("filter boolean pred keeps T", () => {
    const t = infer(
      FILTER_HOF,
      "declare const xs: List<number>;",
      "fn((n) => n > 0, xs)",
    );
    expect(t).toMatch(/List<number>|Cons<number>/);
  });

  it("reduce accumulates to init type", () => {
    const t = infer(
      REDUCE_HOF,
      "declare const xs: List<number>;",
      "fn((el, acc) => acc + el, 0, xs)",
    );
    expect(t).toBe("number");
  });

  it("find type-guard → S | null", () => {
    const t = infer(
      FIND_HOF,
      "declare const xs: List<number>;",
      "fn((n: number): n is 2 => n === 2, xs)",
    );
    expect(t).toMatch(/2/);
    expect(t).toMatch(/null/);
  });

  it("vector-map maps element type", () => {
    const t = infer(
      VECTOR_MAP_HOF,
      "declare const v: readonly boolean[];",
      "fn((b) => (b ? 1 : 0), v)",
    );
    expect(t).toMatch(/0|1|number/);
  });

  it("string-map stays string", () => {
    const t = infer(
      STRING_MAP_HOF,
      'declare const s: string;',
      "fn((c) => c.toUpperCase(), s)",
    );
    expect(t).toBe("string");
  });
});
