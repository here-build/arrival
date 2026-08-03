/**
 * `EnvCapability`-authored rosetta verbs on real-world-shaped JS data (arrays of
 * records, nested dicts, chained calls) — membrane round-trips beyond the scalar
 * codec proofs in `capability-rosetta-symbol.test.ts`.
 *
 * Authoring form: `symbol.rosetta` + capability apply. Verbs bind as
 * `ARosettaProcedure` instances (never bare async functions), so CallCtx is always
 * constructed by the apply term — no Reflect.apply misuse vector to defend.
 *
 * Public `AmbientRuntime.defineRosetta` is gone (see env-privatization-pins).
 * Forbidden bare `{ fn }` authoring remains a separate open migration for external
 * packs (ledger GAPS: "forbidden bare-fn authoring form").
 */
import invariant from "tiny-invariant";
import { describe, expect, it } from "vitest";
import { CONSTANT_CTX } from "../../run/RunContext.js";
import { AString } from "../../values/primitives/AString.js";
import { inferenceEnv } from "../../env/inference-env.js";
import { jsToScheme, schemeToJs, schemeToJsUntyped } from "../rosetta.js";
import { execOverFrame } from "../../eval/generator-exec.js";
import { testCallCtx } from "../../symbol/index.js";
import { EnvCapability } from "../../common/capability.js";
import { applyCapability } from "../../__tests__/_fresh-env.js";
import { ARosettaProcedure } from "../../values/primitives/ARosettaProcedure.js";
import { withDynamicCallSite } from "../../eval/dynamic-call-site.js";
import { tf } from "../../values/tagless-final.js";
import type { SchemeValue } from "../../values/types.js";

// Helper to unwrap exec results
async function execOne(expr: string): Promise<any> {
  const results = await execOverFrame(expr, { env: inferenceEnv });
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
  return withDynamicCallSite(undefined, () => verb[tf("apply")](args as SchemeValue[], testCallCtx()));
}

describe("Rosetta AmbientRuntime (capability-authored)", () => {
  describe("EnvCapability-bound rosetta verbs", () => {
    // INVARIANT: a capability-bound rosetta verb extends the environment with a callable
    // usable from scheme source.
    it("should extend environment with Rosetta functions", async () => {
      await applyCapability(inferenceEnv, [
        EnvCapability.define("test/double-all", {
        symbols: (symbol, z) => ({
          "double-all": symbol.rosetta`double-all: doubles every element of a numeric list`(
            { input: [z.list(z.number)], output: [z.list(z.number)] },
            (numbers) => numbers.map((x) => x * 2),
          ) }) }),
        ]);

      const result = await execOne(`
        (double-all (list 1 2 3 4 5))
      `);

      console.log("AmbientRuntime Rosetta result:", result);

      const jsResult = schemeToJs(result, {});
      expect(jsResult).toEqual([2, 4, 6, 8, 10]);
    });

    // INVARIANT: multiple capability-bound rosetta verbs can be chained/composed from scheme source
    it("should handle multiple Rosetta functions", async () => {
      await applyCapability(inferenceEnv, [
        EnvCapability.define("test/multi-rosetta", {
        symbols: (symbol, z) => ({
          "sum-array": symbol.rosetta`sum-array: sums a numeric list`(
            { input: [z.list(z.number)], output: [z.number] },
            (numbers) => numbers.reduce((a, b) => a + b, 0),
          ),
          "filter-evens": symbol.rosetta`filter-evens: keeps the even elements of a numeric list`(
            { input: [z.list(z.number)], output: [z.list(z.number)] },
            (numbers) => numbers.filter((x) => x % 2 === 0),
          ) }) }),
        ]);

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
      // `z.dynamic` (the rosetta escape hatch: "impl receives/returns raw scheme value,
      // does its own schemeToJs/jsToScheme" — scheme-zod.ts's own doc) and the impl
      // does the conversion inline. Manual `jsToScheme` on the way out is for TYPES
      // only (a bare JS array isn't a `SchemeValue`); `run()`'s final jsToScheme over
      // an already-boxed empty-provenance value is an identity no-op.
      await applyCapability(inferenceEnv, [
        EnvCapability.define("test/extract-values", {
        symbols: (symbol, z) => ({
          "extract-values": symbol.rosetta`extract-values: plucks .value off every element`(
            { input: [z.dynamic], output: [z.dynamic] },
            (rawObjects) => {
              const objects = schemeToJsUntyped(rawObjects) as Array<{ value: unknown }>;
              return jsToScheme(
                CONSTANT_CTX,
                objects.map((obj) => obj.value),
              );
            },
          ) }) }),
        ]);

      // Create test data (inject via jsToScheme rather than constructing pairs by hand)
      const testData = [
        { name: "first", value: 10 },
        { name: "second", value: 20 },
        { name: "third", value: 30 },
      ];

      // Convert to scheme and call function
      const schemeData = jsToScheme(CONSTANT_CTX, testData, {});
      const verb = inferenceEnv.get("extract-values");
      invariant(isRosettaVerb(verb), "extract-values must resolve to a bound rosetta verb");
      const result = await invoke(verb, schemeData);

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
      await applyCapability(inferenceEnv, [
        EnvCapability.define("test/filter-by-css-property", {
        symbols: (symbol, z) => ({
          "filter-by-css-property":
            symbol.rosetta`filter-by-css-property: filters nodes whose style[property] === value`(
              { input: [z.dynamic, z.string, z.string], output: [z.dynamic] },
              (rawNodes, property, value) => {
                const nodes = schemeToJsUntyped(rawNodes) as Array<{ style?: Record<string, string> }>;
                return jsToScheme(
                  CONSTANT_CTX,
                  nodes.filter((node) => node.style && node.style[property] === value),
                );
              },
            ) }) }),
        ]);

      // Create test node data
      const testNodes = [
        { name: "div1", style: { overflow: "hidden", color: "red" } },
        { name: "div2", style: { overflow: "visible", color: "blue" } },
        { name: "div3", style: { overflow: "hidden", color: "green" } },
        { name: "span1", style: { display: "block" } },
      ];

      // Convert to scheme and filter
      const schemeNodes = jsToScheme(CONSTANT_CTX, testNodes, {});
      const verb = inferenceEnv.get("filter-by-css-property");
      invariant(isRosettaVerb(verb), "filter-by-css-property must resolve to a bound rosetta verb");
      // The string args cross the membrane as real scheme values — the `z.string`
      // codec decodes them the same way a scheme-level call would.
      const result = await invoke(verb, schemeNodes, new AString("overflow"), new AString("hidden"));

      console.log("CSS filtering result:", result);

      const jsResult = schemeToJs(result as SchemeValue, {}) as Array<{ name: string }>;
      expect(jsResult).toHaveLength(2);
      expect(jsResult[0].name).toBe("div1");
      expect(jsResult[1].name).toBe("div3");
    });

    // INVARIANT: a rosetta verb can aggregate scheme-converted JS objects into a stats object
    // that round-trips correctly
    it("should create CSS statistics like the MCP server needs", async () => {
      await applyCapability(inferenceEnv, [
        EnvCapability.define("test/css-property-stats", {
        symbols: (symbol, z) => ({
          "css-property-stats": symbol.rosetta`css-property-stats: aggregates node style property:value counts`(
            { input: [z.dynamic], output: [z.dynamic] },
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
          ) }) }),
        ]);

      const testNodes = [
        { style: { overflow: "hidden", display: "block" } },
        { style: { overflow: "visible", display: "block" } },
        { style: { overflow: "hidden", display: "flex" } },
      ];

      const schemeNodes = jsToScheme(CONSTANT_CTX, testNodes, {});
      const verb = inferenceEnv.get("css-property-stats");
      invariant(isRosettaVerb(verb), "css-property-stats must resolve to a bound rosetta verb");
      const result = await invoke(verb, schemeNodes);

      console.log("CSS stats result:", result);

      const jsResult = schemeToJs(result as SchemeValue, {}) as Record<string, number>;
      expect(jsResult["overflow:hidden"]).toBe(2);
      expect(jsResult["overflow:visible"]).toBe(1);
      expect(jsResult["display:block"]).toBe(2);
      expect(jsResult["display:flex"]).toBe(1);
    });
  });
});
