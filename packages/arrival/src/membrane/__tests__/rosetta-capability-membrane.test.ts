/**
 * `EnvCapability`-authored rosetta verbs, exercised through the same real-world data
 * shapes `rosetta-environment.test.ts` used to pin against the legacy
 * `AmbientRuntime.defineRosetta` authoring form (retired in the 2026-07-09 suite
 * consolidation). Migrated 2026-07-11 off `env.defineRosetta` directly, in favor of
 * `symbol.rosetta` + `new EnvCapability(...).lower({}).apply(env, …)` — the target
 * authoring form every capability in the arrival packages now uses (the SAME
 * membrane/wrapper spine `common/symbols/rosetta.ts`'s `run()` builds, proven end-to-end
 * in `common/__tests__/capability-rosetta-symbol.test.ts`).
 *
 * This file's OWN survivors after that migration:
 *   - "AmbientRuntime.defineRosetta" / "Real-world Use Cases" — membrane round-trips over
 *     real-world-shaped JS data (arrays of records, nested style dicts, chained calls)
 *     that `capability-rosetta-symbol.test.ts`'s scalar-typed codec proofs don't cover.
 *     These pin GENERIC membrane behavior (schemeToJs/impl/jsToScheme round-tripping),
 *     which is authoring-form-agnostic — they survive as capability-authored pins.
 *   - "createRosettaWrapper — mandatory `this: CallCtx`" — DELETED (not migrated). Both
 *     rows exercised a JS-level misuse vector SPECIFIC to `defineRosetta`'s own binding
 *     shape: the legacy wrapper is bound in env as a BARE async function, so a caller
 *     could `Reflect.apply(wrapper, <bad receiver>, …)` and the wrapper had to defend
 *     itself at runtime. Under `EnvCapability`, a rosetta verb binds as an
 *     `ARosettaProcedure` INSTANCE (never a bare function) invoked only through the
 *     `arrival/tagless-final/apply` term, which the binder (`capability.ts`'s rosetta
 *     case) ALWAYS calls with a correctly-constructed `CallCtx`
 *     (`rosettaCtx(runCtx)`/`makeCallCtx`) — there is no bare closure left to
 *     `Reflect.apply` a bad receiver onto. The misuse vector is eliminated
 *     STRUCTURALLY (wrong states impossible), not defended against at runtime, so the
 *     two "throws on bad receiver" pins have nothing left to express against the new
 *     binding shape and are removed rather than translated.
 *
 * The legacy `SymbolDeclaration`/`{fn,...}` AUTHORING SHAPE itself (McpEnvCapability's
 * whole authoring model, and every downstream consumer still using it — `capability.ts`'s
 * own doc: "load-bearing OUTSIDE it") stays production code. That authoring shape's
 * migration is a SEPARATE, still-open one (`src/__tests__/ledger/index.law.test.ts`'s
 * GAPS row "defineRosetta legacy arm authoring form", gated on McpEnvCapability's
 * annotation-lifting) — this file only stops CALLING the legacy arm directly from
 * arrival core's own tests.
 *
 * UPDATE (2026-07-11, defineRosetta hard-delete): what did NOT survive is the public
 * `AmbientRuntime.defineRosetta` METHOD the legacy arm used to call — it's retired from both
 * the concrete class and the `SchemeEnv` contract. `capability.ts`'s legacy arm now wires
 * through `bindRosetta`, a module-internal function in `AmbientRuntime.ts` (not barrel-
 * exported, not part of `SchemeEnv`) that does the exact same wrapping/binding the old
 * method's body did. The authoring SHAPE is unchanged; only the method NAME/visibility is.
 */
import invariant from "tiny-invariant";
import { describe, expect, it } from "vitest";
import { CONSTANT_CTX } from "../../run/RunContext.js";
import { AString } from "../../values/primitives/AString.js";
import { inferenceEnv } from "../../inference-env.js";
import { jsToScheme, schemeToJs, schemeToJsUntyped } from "../rosetta.js";
import { exec } from "../../eval/generator-exec.js";
import { symbol } from "../../common/symbol.js";
import { EnvCapability } from "../../common/capability.js";
import * as z from "../../common/scheme-zod.js";
import { ARosettaProcedure } from "../../values/primitives/ACallable.js";
import { withDynamicCallSite } from "../../eval/dynamic-call-site.js";
import { tf } from "../../values/tagless-final.js";
import type { SchemeValue } from "../../values/types.js";

// Helper to unwrap exec results
async function execOne(expr: string): Promise<any> {
  const results = await exec(expr, { env: inferenceEnv });
  return results[0];
}

/** A bound value narrows to a callable rosetta verb — the honest shape of what
 *  `EnvCapability`'s rosetta case binds (an `ARosettaProcedure` instance, never a bare
 *  function — see this file's header for why that closes off the old
 *  `Reflect.apply`-a-bad-receiver misuse vector entirely). */
function isRosettaVerb(value: unknown): value is ARosettaProcedure {
  return value instanceof ARosettaProcedure;
}

/** Invoke a bound rosetta verb the way a JS caller (not scheme source) does post-
 *  binder-cut: through its `arrival/tagless-final/apply` term, under the ambient
 *  dynamic call site (empty here — a direct/test call, no evaluator invocation) — same
 *  pattern `capability-rosetta-symbol.test.ts`'s own `invoke` helper uses. */
function invoke(verb: ARosettaProcedure, ...args: unknown[]): unknown {
  return withDynamicCallSite(undefined, () => verb[tf("apply")](args as SchemeValue[], CONSTANT_CTX));
}

describe("Rosetta AmbientRuntime (capability-authored)", () => {
  describe("EnvCapability-bound rosetta verbs", () => {
    // INVARIANT: a capability-bound rosetta verb extends the environment with a callable
    // usable from scheme source.
    it("should extend environment with Rosetta functions", async () => {
      const doubleAll = symbol.rosetta`double-all: doubles every element of a numeric list`(
        { input: [z.list(z.number)], output: [z.list(z.number)] },
        (numbers) => numbers.map((x) => x * 2),
      );
      await new EnvCapability("test/double-all", { symbols: { "double-all": doubleAll } })
        .lower({})
        .apply(inferenceEnv, undefined as never);

      const result = await execOne(`
        (double-all (list 1 2 3 4 5))
      `);

      console.log("AmbientRuntime Rosetta result:", result);

      const jsResult = schemeToJs(result, {});
      expect(jsResult).toEqual([2, 4, 6, 8, 10]);
    });

    // INVARIANT: multiple capability-bound rosetta verbs can be chained/composed from scheme source
    it("should handle multiple Rosetta functions", async () => {
      const sumArray = symbol.rosetta`sum-array: sums a numeric list`(
        { input: [z.list(z.number)], output: [z.number] },
        (numbers) => numbers.reduce((a, b) => a + b, 0),
      );
      const filterEvens = symbol.rosetta`filter-evens: keeps the even elements of a numeric list`(
        { input: [z.list(z.number)], output: [z.list(z.number)] },
        (numbers) => numbers.filter((x) => x % 2 === 0),
      );
      await new EnvCapability("test/multi-rosetta", {
        symbols: { "sum-array": sumArray, "filter-evens": filterEvens },
      })
        .lower({})
        .apply(inferenceEnv, undefined as never);

      const result = await execOne(`
        (sum-array (filter-evens (list 1 2 3 4 5 6 7 8)))
      `);

      console.log("Chained Rosetta result:", result);

      // Should sum the even numbers: 2 + 4 + 6 + 8 = 20
      const jsResult = schemeToJs(result, {});
      expect(jsResult).toBe(20);
    });

    it("should work with complex data structures", async () => {
      // Arbitrary-shaped JS data (records with a `.value` field) — both slots stay
      // `z.value` (the rosetta escape hatch: "impl receives/returns raw scheme value,
      // does its own schemeToJs/jsToScheme" — scheme-zod.ts's own doc) and the impl
      // does the conversion inline, exactly what the legacy `defineRosetta` wrapper
      // did automatically for every call. The manual `jsToScheme` wrap on the way out
      // is for TYPES only (a bare JS array isn't a `SchemeValue`) — `run()`'s own
      // final `jsToScheme(..., resultProvenance)` call over an ALREADY-boxed value at
      // matching (empty) provenance is an identity no-op, so this changes nothing at
      // runtime vs. handing back the raw array the way the legacy fn did.
      const extractValues = symbol.rosetta`extract-values: plucks .value off every element`(
        { input: [z.value], output: [z.value] },
        (rawObjects) => {
          const objects = schemeToJsUntyped(rawObjects) as Array<{ value: unknown }>;
          return jsToScheme(CONSTANT_CTX, objects.map((obj) => obj.value));
        },
      );
      await new EnvCapability("test/extract-values", { symbols: { "extract-values": extractValues } })
        .lower({})
        .apply(inferenceEnv, undefined as never);

      // Create test data (this is tricky in LIPS, so we'll inject it)
      const testData = [
        { name: "first", value: 10 },
        { name: "second", value: 20 },
        { name: "third", value: 30 },
      ];

      // Convert to LIPS and call function
      const lipsData = jsToScheme(CONSTANT_CTX, testData, {});
      const verb = inferenceEnv.get("extract-values");
      invariant(isRosettaVerb(verb), "extract-values must resolve to a bound rosetta verb");
      const result = await invoke(verb, lipsData);

      console.log("Complex data result:", result);

      const jsResult = schemeToJs(result as SchemeValue, {});
      expect(jsResult).toEqual([10, 20, 30]);
    });
  });

  describe("Real-world Use Cases", () => {
    // INVARIANT: a rosetta verb receiving scheme-converted JS objects can filter on a nested
    // style property and results round-trip correctly
    it("should handle the MCP CSS filtering pattern", async () => {
      // This simulates the exact pattern we need for MCP
      const filterByCssProperty = symbol.rosetta`filter-by-css-property: filters nodes whose style[property] === value`(
        { input: [z.value, z.string, z.string], output: [z.value] },
        (rawNodes, property, value) => {
          const nodes = schemeToJsUntyped(rawNodes) as Array<{ style?: Record<string, string> }>;
          return jsToScheme(
            CONSTANT_CTX,
            nodes.filter((node) => node.style && node.style[property] === value),
          );
        },
      );
      await new EnvCapability("test/filter-by-css-property", {
        symbols: { "filter-by-css-property": filterByCssProperty },
      })
        .lower({})
        .apply(inferenceEnv, undefined as never);

      // Create test node data
      const testNodes = [
        { name: "div1", style: { overflow: "hidden", color: "red" } },
        { name: "div2", style: { overflow: "visible", color: "blue" } },
        { name: "div3", style: { overflow: "hidden", color: "green" } },
        { name: "span1", style: { display: "block" } },
      ];

      // Convert to LIPS and filter
      const lipsNodes = jsToScheme(CONSTANT_CTX, testNodes, {});
      const verb = inferenceEnv.get("filter-by-css-property");
      invariant(isRosettaVerb(verb), "filter-by-css-property must resolve to a bound rosetta verb");
      // The string args cross the membrane as real scheme values — the `z.string`
      // codec decodes them the same way a scheme-level call would.
      const result = await invoke(
        verb,
        lipsNodes,
        new AString(CONSTANT_CTX, "overflow"),
        new AString(CONSTANT_CTX, "hidden"),
      );

      console.log("CSS filtering result:", result);

      const jsResult = schemeToJs(result as SchemeValue, {});
      expect(jsResult).toHaveLength(2);
      expect(jsResult[0].name).toBe("div1");
      expect(jsResult[1].name).toBe("div3");
    });

    // INVARIANT: a rosetta verb can aggregate scheme-converted JS objects into a stats object
    // that round-trips correctly
    it("should create CSS statistics like the MCP server needs", async () => {
      const cssPropertyStats = symbol.rosetta`css-property-stats: aggregates node style property:value counts`(
        { input: [z.value], output: [z.value] },
        (rawNodes) => {
          const nodes = schemeToJsUntyped(rawNodes) as Array<{ style?: Record<string, string> }>;
          const stats: Record<string, number> = {};
          nodes.forEach((node) => {
            if (node.style) {
              Object.entries(node.style).forEach(([prop, value]) => {
                const key = `${prop}:${value}`;
                stats[key] = (stats[key] || 0) + 1;
              });
            }
          });
          return jsToScheme(CONSTANT_CTX, stats);
        },
      );
      await new EnvCapability("test/css-property-stats", { symbols: { "css-property-stats": cssPropertyStats } })
        .lower({})
        .apply(inferenceEnv, undefined as never);

      const testNodes = [
        { style: { overflow: "hidden", display: "block" } },
        { style: { overflow: "visible", display: "block" } },
        { style: { overflow: "hidden", display: "flex" } },
      ];

      const lipsNodes = jsToScheme(CONSTANT_CTX, testNodes, {});
      const verb = inferenceEnv.get("css-property-stats");
      invariant(isRosettaVerb(verb), "css-property-stats must resolve to a bound rosetta verb");
      const result = await invoke(verb, lipsNodes);

      console.log("CSS stats result:", result);

      const jsResult = schemeToJs(result as SchemeValue, {});
      expect(jsResult["overflow:hidden"]).toBe(2);
      expect(jsResult["overflow:visible"]).toBe(1);
      expect(jsResult["display:block"]).toBe(2);
      expect(jsResult["display:flex"]).toBe(1);
    });
  });
});
