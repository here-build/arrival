import type { CallCtx } from "../../run/CallCtx.js";
import { describe, expect, it } from "vitest";

import { EnvCapability } from "../../common/capability.js";
import { exec } from "../../eval/generator-exec.js";

const hof = EnvCapability.define("test/js-callback-arity", {
  symbols: (symbol, z) => ({
    "js-map": symbol.rosetta`js-map: Array.prototype.map over a scheme lambda`(
      { input: [z.list(z.number), z.procedure(z.number, z.number)], output: [z.list(z.number)] },
      async function (this: CallCtx, arr: number[], fn: (...a: unknown[]) => unknown) {
        return (await Promise.all(arr.map(fn as (...a: unknown[]) => Promise<unknown>))) as number[];
      },
    ),
    "js-call0": symbol.rosetta`js-call0: calls the callback with no arguments`(
      { input: [z.procedure(z.number, z.number)], output: [z.number] },
      async function (this: CallCtx, fn: (...a: unknown[]) => unknown) {
        return (await fn()) as number;
      },
    ),
  }),
});

const run = (src: string) => exec(src, { capabilities: [hof] });

describe("JS-style host callbacks vs the lambda arity door", () => {
  it("a 1-param lambda works under Array#map (value,index,array trimmed to arity.max)", async () => {
    expect(await run("(js-map (list 1 2 3) (lambda (x) (* x 10)))")).toEqual([[10, 20, 30]]);
  });
  it("a 2-param lambda receives (value, index)", async () => {
    expect(await run("(js-map (list 5 6 7) (lambda (x i) (+ x i)))")).toEqual([[5, 7, 9]]);
  });
  it("too FEW args from JS still hits the arity door", async () => {
    await expect(run("(js-call0 (lambda (x) x))")).rejects.toThrow(/argument/);
  });
});
