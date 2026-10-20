/**
 * LAW — a host function read off a BORROWED object is run-scoped AND receiver-bound.
 *
 * docs/membrane.md §CALLABLE-LENS "Identity, run-scoped": the cache key for a function read
 * off a borrowed object is `(run, receiver, fn)`. Three pins:
 *  1. RUN — two runs reading `obj.f` get distinct callables, each stamped with its own run's
 *     provenance (a CONSTANT_CTX mint would share one process-wide callable across runs).
 *  2. RECEIVER — `this` inside the host method is the borrowed source, so `{ n, f() { return
 *     this.n } }` answers `n` through a member read; the SAME fn on two objects is two callables.
 *  3. FROZEN — the borrowed source is frozen on first read, so a `this`-MUTATING method throws.
 * Bare-fn crossings (no owning object) keep `(run, fn)` identity — host-fn-lens.law.test.ts.
 */
import { describe, expect, it } from "vitest";
import { RunContext } from "../../run/RunContext.js";
import { jsToScheme } from "../rosetta.js";
import { AJSObject } from "../AJSObject.js";
import { AJSArray } from "../AJSArray.js";
import { ARosettaProcedure } from "../../values/primitives/ARosettaProcedure.js";
import { applyCallback } from "../../values/primitives/ACallable.js";
import { type CallCtx, testCallCtx } from "../../run/CallCtx.js";
import { AExact } from "../../values/primitives/AExact.js";
import { EnvCapability } from "../../common/capability.js";
import { execState } from "../../eval/generator-exec.js";
import { tf } from "../../values/tagless-final.js";
import type { SchemeValue } from "../../values/types.js";

const read = (o: AJSObject, key: string, run: RunContext): ARosettaProcedure => {
  const f = o[tf("get")](key, run);
  expect(f).toBeInstanceOf(ARosettaProcedure);
  return f as ARosettaProcedure;
};

describe("LAW — host fn read off a borrowed object: (run, receiver, fn) identity", () => {
  it("run A and run B reading obj.f get distinct callables, each with its own run's provenance", () => {
    const f = () => 1;
    const src = { f };
    const runA = new RunContext({});
    const runB = new RunContext({});
    const objA = new AJSObject(src, new Set([1]));
    const objB = new AJSObject(src, new Set([2]));
    const a = read(objA, "f", runA);
    const b = read(objB, "f", runB);
    expect(a).not.toBe(b);
    expect([...a.provenance]).toEqual([1]);
    expect([...b.provenance]).toEqual([2]);
  });

  it("two reads in one run are eq?", () => {
    const run = new RunContext({});
    const obj = new AJSObject({ f: () => 1 });
    expect(read(obj, "f", run)).toBe(read(obj, "f", run));
    // a second wrapper over the same source is the same (run, receiver, fn)
    expect(read(new AJSObject(obj.source as { f: () => number }), "f", run)).toBe(read(obj, "f", run));
  });

  it("the same fn on two objects is two callables (receiver is part of identity)", () => {
    const run = new RunContext({});
    const shared = function (this: { n: number }) {
      return this.n;
    };
    const a = read(new AJSObject({ n: 1, f: shared }), "f", run);
    const b = read(new AJSObject({ n: 2, f: shared }), "f", run);
    expect(a).not.toBe(b);
  });

  it("a member read binds the receiver: { n: 2, f() { return this.n } } → 2", async () => {
    const cap = EnvCapability.define("law/host-fn-lens-receiver", {
      symbols: (symbol, sz) => ({
        "get-obj": symbol.rosetta`get-obj: a borrowed object with a method`(
          { input: [], output: [sz.dynamic] },
          function (this: CallCtx) {
            return {
              n: 2,
              f(this: { n: number }) {
                return this.n;
              },
            } as unknown as SchemeValue;
          },
        ),
      }),
    });
    const { values } = await execState("((@ (get-obj) :f))", { capabilities: [cap], config: {} } as never);
    const result = values.at(-1);
    expect(result).toBeInstanceOf(AExact);
    expect((result as AExact).num).toBe(2);
  });

  it("the borrowed source is frozen on read, so a this-mutating method throws", async () => {
    const run = new RunContext({});
    const obj = new AJSObject({
      n: 1,
      bump(this: { n: number }) {
        this.n++;
        return this.n;
      },
    });
    const bump = read(obj, "bump", run);
    await expect(async () => applyCallback(bump, [], testCallCtx({ runCtx: run }))).rejects.toThrow(TypeError);
  });

  it("array elements read with no receiver; a bare-fn crossing keeps (run, fn) identity", () => {
    const run = new RunContext({});
    const f = () => 1;
    const arr = new AJSArray([f]);
    const viaElement = arr[tf("vector-ref")](0, run);
    expect(viaElement).toBeInstanceOf(ARosettaProcedure);
    expect(viaElement).toBe(jsToScheme(run, f));
  });
});
