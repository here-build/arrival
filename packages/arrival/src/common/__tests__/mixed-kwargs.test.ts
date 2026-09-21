// mixed-kwargs — positional head + record inputRest is one law.
// Type-layer emitCallArgs already lowers `(f x :a 1)` → `f(x, { a: 1 })`.
// Runtime must match: impl arity `[...Head, kwargs]`.

import { beforeAll, describe, expect, it } from "vitest";
import type { ResolvingAmbient } from "../../env/AmbientRuntime.js";
import { execStateOverFrame as execState } from "../../eval/generator-exec.js";
import { applyCapability, freshEnv } from "../../__tests__/_fresh-env.js";
import { AString } from "../../values/primitives/AString.js";
import { AExact } from "../../values/primitives/AExact.js";
import { ABool } from "../../values/primitives/ABool.js";
import { ASymbol } from "../../values/primitives/ASymbol.js";
import { symbol } from "../../symbol/index.js";
import { testCallCtx } from "../../run/CallCtx.js";
import * as z from "../scheme-zod/index.js";
import { EnvCapability } from "../capability.js";

function pluck(key: string): unknown {
  return new ASymbol(`:${key}`);
}

function fire(proc: { ["arrival/tagless-final/apply"](args: any[], callCtx: any): any }, callCtx: any, ...args: any[]) {
  return proc["arrival/tagless-final/apply"](args, callCtx);
}

function jsOf(value: unknown): unknown {
  return (value as AString)["arrival/toJS"]();
}

describe("mixed kwargs — UNIT (rosetta)", () => {
  it("pure kwargs still lands as one object", async () => {
    const def = symbol.rosetta`greet: kwargs greeting`(
      { input: [], inputRest: { a: z.string, b: z.number.optional() }, output: [z.string] },
      (args) => `${args.a}:${args.b}`,
    );
    const out = await fire(def, testCallCtx(), pluck("a"), new AString("Ada"), pluck("b"), new AExact(5));
    expect(jsOf(out)).toBe("Ada:5");
  });

  it("required positional + optional kwargs: (tool p) and (tool p :offset 1)", async () => {
    const seen: unknown[] = [];
    const def = symbol.rosetta`read: mixed read`(
      { input: [z.string], inputRest: { offset: z.number.optional() }, output: [z.string] },
      (path, opts) => {
        seen.push([path, opts]);
        return `${path}:${opts.offset}`;
      },
    );
    expect(jsOf(await fire(def, testCallCtx(), new AString("p")))).toBe("p:undefined");
    expect(jsOf(await fire(def, testCallCtx(), new AString("p"), pluck("offset"), new AExact(1)))).toBe("p:1");
    expect(seen).toEqual([
      ["p", { offset: undefined }],
      ["p", { offset: 1 }],
    ]);
  });

  it("two required positionals + kwargs", async () => {
    const def = symbol.rosetta`write: mixed write`(
      {
        input: [z.string, z.string],
        inputRest: { overwriteExisting: z.boolean.optional() },
        output: [z.string],
      },
      (path, content, opts) => `${path}:${content}:${opts.overwriteExisting}`,
    );
    const out = await fire(
      def,
      testCallCtx(),
      new AString("/a"),
      new AString("hi"),
      pluck("overwriteExisting"),
      new ABool(true),
    );
    expect(jsOf(out)).toBe("/a:hi:true");
  });

  it("keyword before the required positional is rejected", async () => {
    const def = symbol.rosetta`read: mixed read`(
      { input: [z.string], inputRest: { offset: z.number.optional() }, output: [z.string] },
      (path, opts) => `${path}:${opts.offset}`,
    );
    await expect(fire(def, testCallCtx(), pluck("offset"), new AExact(1))).rejects.toThrow();
  });

  it("trailing keywords fold into an optional last dict (no inputRest)", async () => {
    const seen: unknown[] = [];
    const def = symbol.rosetta`mcp-call: optional last dict`(
      {
        input: [z.string, z.string, z.object({ q: z.string.optional() }).optional()],
        output: [z.string],
      },
      (connection, tool, args) => {
        seen.push([connection, tool, args]);
        return `${connection}:${tool}:${args?.q}`;
      },
    );
    expect(
      jsOf(
        await fire(
          def,
          testCallCtx(),
          new AString("mail"),
          new AString("search"),
          pluck("q"),
          new AString("inbox"),
        ),
      ),
    ).toBe("mail:search:inbox");
    expect(seen[0]).toEqual(["mail", "search", { q: "inbox" }]);
  });

  it("optional positional omitted then kwargs", async () => {
    const seen: unknown[] = [];
    const def = symbol.rosetta`ask: mixed ask`(
      {
        input: [z.string, z.dynamic.optional()],
        inputRest: { readonly: z.boolean.optional() },
        output: [z.string],
      },
      (message, schema, rest) => {
        seen.push([message, schema, rest]);
        return `${message}:${schema}:${rest.readonly}`;
      },
    );
    const out = await fire(def, testCallCtx(), new AString("msg"), pluck("readonly"), new ABool(true));
    expect(jsOf(out)).toBe("msg:undefined:true");
    expect(seen[0]).toEqual(["msg", undefined, { readonly: true }]);
  });
});

describe("mixed kwargs — UNIT (native)", () => {
  it("same split: scheme head, decoded kwargs bag", async () => {
    const seen: unknown[] = [];
    const def = symbol.native`read: mixed native`(
      { input: [z.string], inputRest: { offset: z.number.optional() }, output: [z.string] },
      (path, opts) => {
        seen.push([path, opts]);
        return new AString(`${String(path)}:${opts.offset}`);
      },
    );
    const out = await fire(def, testCallCtx(), new AString("p"), pluck("offset"), new AExact(1));
    expect(jsOf(out)).toBe("p:1");
    expect(seen[0]?.[1]).toEqual({ offset: 1 });
    expect(seen[0]?.[0]).toBeInstanceOf(AString);
  });
});

describe("mixed kwargs — INTEGRATION", () => {
  let env: ResolvingAmbient;
  beforeAll(async () => {
    env = await freshEnv();
    const read = symbol.rosetta`mixed-read: mixed read`(
      { input: [z.string], inputRest: { offset: z.number.optional() }, output: [z.string] },
      (path, opts) => `${path}:${opts.offset}`,
    );
    const greet = symbol.rosetta`kw-greet: kwargs greeting`(
      { input: [], inputRest: { a: z.string, b: z.number.optional() }, output: [z.string] },
      (args) => `${args.a}:${args.b}`,
    );
    await applyCapability(env, [
      EnvCapability.define("test/mixed-kwargs", { symbols: () => ({ "mixed-read": read, "kw-greet": greet }) }),
    ]);
  });

  it("(mixed-read \"p\") and (mixed-read \"p\" :offset 1)", async () => {
    expect(jsOf((await execState(`(mixed-read "p")`, { env })).values[0])).toBe("p:undefined");
    expect(jsOf((await execState(`(mixed-read "p" :offset 1)`, { env })).values[0])).toBe("p:1");
  });

  it("pure kwargs regression: (kw-greet :a \"Ada\" :b 5)", async () => {
    expect(jsOf((await execState(`(kw-greet :a "Ada" :b 5)`, { env })).values[0])).toBe("Ada:5");
  });

  it("exec: trailing keywords fold into an optional last dict (no inputRest)", async () => {
    const mcpEnv = await freshEnv();
    const call = symbol.rosetta`mcp-call: optional last dict`(
      {
        input: [z.string, z.string, z.object({ q: z.string.optional() }).optional()],
        output: [z.string],
      },
      (connection, tool, args) => `${connection}:${tool}:${args?.q}`,
    );
    await applyCapability(mcpEnv, [EnvCapability.define("test/mcp-fold", { symbols: () => ({ "mcp-call": call }) })]);
    expect(jsOf((await execState(`(mcp-call "mail" "search" :q "inbox")`, { env: mcpEnv })).values[0])).toBe(
      "mail:search:inbox",
    );
  });

  it("variadic Zod inputRest is still a tuple rest, not kwargs", async () => {
    const plusEnv = await freshEnv();
    const plus = symbol.rosetta`plus: variadic rest`(
      { input: [z.number, z.number], inputRest: z.number, output: [z.number] },
      (a, b, ...rest: number[]) => rest.reduce((n, x) => n + x, a + b),
    );
    await applyCapability(plusEnv, [EnvCapability.define("test/variadic-rest", { symbols: () => ({ plus }) })]);
    expect(jsOf((await execState(`(plus 1 2 3 4)`, { env: plusEnv })).values[0])).toBe(10);
  });
});
