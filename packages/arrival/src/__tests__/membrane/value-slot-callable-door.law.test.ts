/**
 * LAW — the z.value-callable door (Ruling A).
 *
 * The hole this closes: a `z.value` slot is the declared raw escape hatch — its decode
 * performs NO transform, so an impl receiving a raw callable through it does its OWN
 * schemeToJs/applyCallback marshaling, possibly AFTER its own first `await`. By then
 * `withRegionScope`'s synchronous save/restore (region-scope.ts) has already reverted the
 * ambient scope, so a reverse call minted from that stale marshal binds `DETACHED_SCOPE`/
 * `CONSTANT_CTX` instead of the live run — reopening the burst-bypass hole the region-scope
 * gate (see `region.law.test.ts`'s "BURST-BYPASS CLOSED" row) exists to close. `z.procedure`
 * is safe because its wrapper is minted SYNCHRONOUSLY at decode, under the live scope.
 *
 * The fix (common/symbols/rosetta.ts's `buildValueSlotCheck` / `assertNotBareCallableInValueSlot`):
 * make the unsafe shape UNAUTHORED — a callable landing in a bare top-level `z.value` slot
 * throws a teaching door instead of silently marshaling under a scope that may already be gone.
 */
import { describe, expect, it } from "vitest";
import * as z from "../../common/scheme-zod.js";
import { symbol } from "../../common/symbol.js";
import { EnvCapability } from "../../common/capability.js";
import { exec } from "../../eval/generator-exec.js";
import type { CallCtx } from "../../values/primitives/CallCtx.js";

describe("the z.value-callable door", () => {
  it("a bare z.value slot receiving a lambda throws the teaching door, steering to z.procedure", async () => {
    const cap = new EnvCapability("test/value-slot-callable-door", {
      symbols: {
        "echo-value": symbol.rosetta`echo-value: hands its raw z.value arg back untouched`(
          { input: [z.value], output: [z.value] },
          function (this: CallCtx, v: unknown) {
            return v;
          },
        ),
      },
    });

    await expect(exec("(echo-value (lambda (x) x))", { capabilities: [cap] })).rejects.toThrow(
      /a callable argument crossed a z\.value slot/,
    );
    await expect(exec("(echo-value (lambda (x) x))", { capabilities: [cap] })).rejects.toThrow(/z\.procedure/);
  });

  it("the SAME verb called with a non-callable value works — the door is callable-specific, not a value ban", async () => {
    const cap = new EnvCapability("test/value-slot-non-callable-ok", {
      symbols: {
        "echo-value": symbol.rosetta`echo-value: hands its raw z.value arg back untouched`(
          { input: [z.value], output: [z.value] },
          function (this: CallCtx, v: unknown) {
            return v;
          },
        ),
      },
    });

    const [result] = await exec("(echo-value 42)", { capabilities: [cap] });
    expect(Number(result)).toBe(42);
  });

  it("a z.procedure slot with a lambda works — the correct door is unaffected", async () => {
    let called = false;
    const cap = new EnvCapability("test/procedure-slot-lambda-ok", {
      symbols: {
        "call-it": symbol.rosetta`call-it: invokes the procedure arg once`(
          { input: [z.procedure()], output: [z.undefinedResult] },
          async function (this: CallCtx, fn: (...args: unknown[]) => unknown) {
            await fn(41);
            called = true;
            return undefined;
          },
        ),
      },
    });

    await exec("(call-it (lambda (x) (+ x 1)))", { capabilities: [cap] });
    expect(called).toBe(true);
  });

  it("a kwargs z.value field receiving a lambda also throws the door, naming the keyword", async () => {
    const cap = new EnvCapability("test/value-slot-kwargs-door", {
      symbols: {
        "echo-kwargs": symbol.rosetta`echo-kwargs: hands its raw kwargs value back untouched`(
          { input: [], inputRest: { v: z.value }, output: [z.value] },
          function (this: CallCtx, args: { v: unknown }) {
            return args.v;
          },
        ),
      },
    });

    await expect(exec("(echo-kwargs :v (lambda (x) x))", { capabilities: [cap] })).rejects.toThrow(
      /a callable argument crossed a z\.value slot \(keyword argument :v\)/,
    );
  });

  it("a kwargs z.value field receiving a non-callable value still works", async () => {
    const cap = new EnvCapability("test/value-slot-kwargs-ok", {
      symbols: {
        "echo-kwargs": symbol.rosetta`echo-kwargs: hands its raw kwargs value back untouched`(
          { input: [], inputRest: { v: z.value }, output: [z.value] },
          function (this: CallCtx, args: { v: unknown }) {
            return args.v;
          },
        ),
      },
    });

    const [result] = await exec('(echo-kwargs :v "hello")', { capabilities: [cap] });
    expect(result).toBe("hello");
  });
});
