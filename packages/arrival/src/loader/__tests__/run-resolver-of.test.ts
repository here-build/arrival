import { describe, expect, it } from "vitest";
import { LexicalScope } from "../../eval/LexicalScope.js";
import { Resolver } from "../../eval/Resolver.js";
import { RunResolverUnreachableError } from "../../errors.js";
import { testCallCtx } from "../../run/CallCtx.js";
import { runResolverOf } from "../loader.js";

describe("runResolverOf", () => {
  it("returns this.resolver", () => {
    const resolver = new Resolver(LexicalScope.fresh("run-resolver-of").env);
    expect(runResolverOf(testCallCtx({ resolver }), "require")).toBe(resolver);
  });

  it("throws RunResolverUnreachableError when CallCtx has no resolver", () => {
    expect(() => runResolverOf(testCallCtx(), "require")).toThrow(RunResolverUnreachableError);
  });
});
