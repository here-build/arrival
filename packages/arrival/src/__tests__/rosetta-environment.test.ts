import { CONSTANT_CTX } from "../values/primitives/RunContext.js";
import { AString } from "../values/primitives/AString.js";
/**
 * Test Rosetta Environment - seamless LIPS ↔ JS interop
 */

import invariant from "tiny-invariant";
import { describe, expect, it } from "vitest";
import { inferenceEnv } from "../inference-env.js";
import { createRosettaWrapper, jsToScheme, schemeToJs } from "../rosetta.js";
import { makeCallCtx } from "../common/symbols/_bake.js";
import { exec } from "../eval/generator-exec.js";

// Helper to unwrap exec results
async function execOne(expr: string): Promise<any> {
  const results = await exec(expr, { env: inferenceEnv });
  return results[0];
}

// `Environment.get` returns the wide `EnvironmentValue` union, which now carries
// several distinct callable shapes (AProcedure + two builtin signatures). A bare
// `typeof === "function"` narrows to that union-of-functions, which TS refuses to
// invoke (incompatible call signatures). This guard collapses a hit to ONE coherent
// callable signature — the honest shape of a rosetta wrapper (variadic args in).
function isCallable(value: unknown): value is (...args: any[]) => unknown {
  return typeof value === "function";
}

describe("Rosetta Environment", () => {
  describe("LIPS → JS Conversion", () => {
    it("should convert LIPS numbers to JS numbers", async () => {
      const lipsNumber = await execOne("42");
      const jsNumber = schemeToJs(lipsNumber, {});

      console.log("LIPS number:", lipsNumber);
      console.log("JS number:", jsNumber);

      expect(jsNumber).toBe(42);
      expect(typeof jsNumber).toBe("number");
    });

    it("should convert LIPS lists to JS arrays", async () => {
      const lipsList = await execOne("(list 1 2 3 4)");
      const jsArray = schemeToJs(lipsList, {});

      console.log("LIPS list:", lipsList);
      console.log("JS array:", jsArray);

      expect(Array.isArray(jsArray)).toBe(true);
      expect(jsArray).toEqual([1, 2, 3, 4]);
    });

    it("should preserve symbol-keyed properties across the JS→LIPS→JS round-trip", () => {
      // Regression: `Object.entries` in schemeToJs dropped symbol keys, so opaque/private
      // backing data on objects crossing the membrane was silently lost. String keys must
      // be unchanged; symbol-keyed slots must survive.
      const SECRET = Symbol("secret");
      const original: Record<string | symbol, unknown> = { visible: 1 };
      original[SECRET] = [4, 5, 6];

      const roundTripped = schemeToJs(jsToScheme(CONSTANT_CTX, original, {}), {}) as Record<string | symbol, unknown>;

      expect(roundTripped.visible).toBe(1); // string key unchanged
      expect(roundTripped[SECRET]).toEqual([4, 5, 6]); // symbol key survives
    });

    // this one is tricky and will probably require deep rewrite of runtime.
    // what needs to be done to introduce second instance of nil that will be "representing empty array"
    // to preserve metadata on reverse conversion
    //
    // [STALE-LABEL] (2026-07-08 test-invariant-atlas sweep, [P15]
    // docs/test-invariant-atlas/verdicts/membrane.md): this is a fully-bodied test with real
    // assertions, marked `it.skip` — outside the suite's declared three-state truth table
    // (green/`it.fails`/`it.todo`). The atlas itself classifies this as `[todo]` even though
    // the code said `skip`; promoted to `it.todo` to match (vitest's `it.todo` also accepts
    // a body, unlike `it.skip` it signals "designed, not yet buildable" rather than "disabled").
    it.todo("should convert empty LIPS list to empty JS array", async () => {
      const emptyList = await execOne("(list)");
      const jsArray = schemeToJs(emptyList, {});

      console.log("Empty LIPS list:", emptyList);
      console.log("Empty JS array:", jsArray);

      expect(jsArray).toEqual([]);
    });

    it("should convert nested LIPS lists", async () => {
      const nestedList = await execOne("(list (list 1 2) (list 3 4))");
      const jsArray = schemeToJs(nestedList, {});

      console.log("Nested LIPS list:", nestedList);
      console.log("Nested JS array:", jsArray);

      expect(jsArray).toEqual([
        [1, 2],
        [3, 4],
      ]);
    });

    it("should handle mixed data types", async () => {
      // Note: Using quote to prevent evaluation of symbols
      const mixedList = await execOne(`(list 42 "hello" #t)`);
      const jsArray = schemeToJs(mixedList, {});

      console.log("Mixed LIPS list:", mixedList);
      console.log("Mixed JS array:", jsArray);

      expect(jsArray[0]).toBe(42);
      expect(typeof jsArray[1]).toBe("string");
      expect(jsArray[2]).toBe(true);
    });
  });

  describe("JS → LIPS Conversion", () => {
    it("should convert JS arrays to borrowed vectors (AJSArray), not lists", () => {
      const jsArray = [1, 2, 3, 4];
      const vec = jsToScheme(CONSTANT_CTX, jsArray, {});

      // A JS array IS an R7RS vector → a borrowed AJSArray (the old array→list coercion is gone).
      expect(vec.constructor.name).toBe("AJSArray");

      // schemeToJs still casts the vector back to a JS array (JS's single sequence type).
      const backToJs = schemeToJs(vec, {});
      expect(backToJs).toEqual(jsArray);
    });

    it("should convert an empty JS array to an empty vector (AJSArray), not nil", () => {
      const emptyArray: any[] = [];
      const vec = jsToScheme(CONSTANT_CTX, emptyArray, {});

      // An empty array is the empty VECTOR now (not the empty list / nil).
      expect(vec.constructor.name).toBe("AJSArray");
      expect((vec as { length: number }).length).toBe(0);
    });

    it("should convert nested JS arrays", () => {
      const nestedArray = [
        [1, 2],
        [3, 4],
      ];
      const lipsList = jsToScheme(CONSTANT_CTX, nestedArray, {});

      console.log("Nested JS array:", nestedArray);
      console.log("Nested LIPS list:", lipsList);

      // Convert back to verify
      const backToJs = schemeToJs(lipsList, {});
      expect(backToJs).toEqual(nestedArray);
    });

    it("should handle JS objects", () => {
      const jsObject = { name: "test", value: 42, items: [1, 2, 3] };
      const lipsObject = jsToScheme(CONSTANT_CTX, jsObject, {});

      console.log("JS object:", jsObject);
      console.log("LIPS object:", lipsObject);

      // Option C (2026-05-28): plain JS objects now wrap as SchemeJSObject —
      // entries box lazily through `.get(key)` carrying the wrapper's
      // provenance. Round-trip via `schemeToJs` reads `.source` and unwraps.
      expect(lipsObject.constructor.name).toBe("AJSObject");
      expect(lipsObject.get("name").valueOf()).toBe("test");
      expect(lipsObject.get("value").valueOf()).toBe(42);
      expect(lipsObject.get("items").constructor.name).toBe("AJSArray"); // array field → borrowed vector

      // Convert back to verify
      const backToJs = schemeToJs(lipsObject, {});
      expect(backToJs).toEqual(jsObject);
    });
  });

  describe("Rosetta Function Wrapping", () => {
    it("should wrap JS functions for automatic conversion", async () => {
      // Define a simple JS function
      const jsFunction = (numbers: number[]) => numbers.map((x) => x * 2);

      // Create Rosetta wrapper
      const rosettaFunction = createRosettaWrapper({ fn: jsFunction, options: {} });

      // Test with LIPS list
      const lipsList = await execOne("(list 1 2 3 4)");
      const result = await rosettaFunction.call(makeCallCtx(), lipsList);

      console.log("Original LIPS list:", lipsList);
      console.log("Rosetta result:", result);

      // The JS-array result crosses back as a borrowed vector (AJSArray); schemeToJs casts it
      // to a JS array.
      expect(result.constructor.name).toBe("AJSArray");
      const jsResult = schemeToJs(result, {});
      expect(jsResult).toEqual([2, 4, 6, 8]);
    });

    it("should handle complex JS operations", async () => {
      // Define a complex JS function (filtering and statistics)
      const analyzeNumbers = (numbers: number[]) => ({
        total: numbers.length,
        sum: numbers.reduce((a, b) => a + b, 0),
        evens: numbers.filter((x) => x % 2 === 0),
        odds: numbers.filter((x) => x % 2 === 1),
      });

      const rosettaAnalyze = createRosettaWrapper({ fn: analyzeNumbers, options: {} });

      // Test with LIPS list
      const lipsList = await execOne("(list 1 2 3 4 5 6)");
      const result = await rosettaAnalyze.call(makeCallCtx(), lipsList);

      console.log("Analysis result:", result);

      // Convert back to JS to verify
      const jsResult = schemeToJs(result, {});
      expect(jsResult.total).toBe(6);
      expect(jsResult.sum).toBe(21);
      expect(jsResult.evens).toEqual([2, 4, 6]);
      expect(jsResult.odds).toEqual([1, 3, 5]);
    });
  });

  // [INVERTS: reverse-membrane/P1] (docs/test-invariant-atlas/verdicts/membrane.md): exercises
  // the legacy `env.defineRosetta` arm — P1's own "Revealed by" line names this exact form
  // ("env.defineRosetta's legacy form") as a JS artifact living in value space without
  // lineage. Travels with the reverse-membrane migration; not a permanent contract.
  describe("Environment.defineRosetta", () => {
    it("should extend environment with Rosetta functions", async () => {
      // Define a Rosetta function in the environment
      inferenceEnv.defineRosetta("double-all", {
        fn: (numbers: number[]) => numbers.map((x) => x * 2),
      });

      // Test calling it from LIPS
      const result = await execOne(`
        (double-all (list 1 2 3 4 5))
      `);

      console.log("Environment Rosetta result:", result);

      // Should return LIPS list with doubled values
      const jsResult = schemeToJs(result, {});
      expect(jsResult).toEqual([2, 4, 6, 8, 10]);
    });

    it("should handle multiple Rosetta functions", async () => {
      // Define multiple functions
      inferenceEnv.defineRosetta("sum-array", {
        fn: (numbers: number[]) => numbers.reduce((a, b) => a + b, 0),
      });

      inferenceEnv.defineRosetta("filter-evens", {
        fn: (numbers: number[]) => numbers.filter((x) => x % 2 === 0),
      });

      // Test chaining them
      const result = await execOne(`
        (sum-array (filter-evens (list 1 2 3 4 5 6 7 8)))
      `);

      console.log("Chained Rosetta result:", result);

      // Should sum the even numbers: 2 + 4 + 6 + 8 = 20
      const jsResult = schemeToJs(result, {});
      expect(jsResult).toBe(20);
    });

    it("should work with complex data structures", async () => {
      // Define a function that works with objects
      inferenceEnv.defineRosetta("extract-values", {
        fn: (objects: any[]) => objects.map((obj) => obj.value),
      });

      // Create test data (this is tricky in LIPS, so we'll inject it)
      const testData = [
        { name: "first", value: 10 },
        { name: "second", value: 20 },
        { name: "third", value: 30 },
      ];

      // Convert to LIPS and call function
      const lipsData = jsToScheme(CONSTANT_CTX, testData, {});
      const rosettaFn = inferenceEnv.get("extract-values");
      invariant(isCallable(rosettaFn), "extract-values must resolve to a callable rosetta wrapper");
      const result = await rosettaFn.call(makeCallCtx(), lipsData);

      console.log("Complex data result:", result);

      const jsResult = schemeToJs(result, {});
      expect(jsResult).toEqual([10, 20, 30]);
    });
  });

  // [INVERTS: reverse-membrane/P1] — same legacy `defineRosetta` arm as the describe above
  // (MCP CSS-filtering / stats patterns exercised here); travels with the same transitional
  // tag rather than reading as a permanent contract.
  describe("Real-world Use Cases", () => {
    it("should handle the MCP CSS filtering pattern", async () => {
      // This simulates the exact pattern we need for MCP
      inferenceEnv.defineRosetta("filter-by-css-property", {
        fn: (nodes: any[], property: string, value: string) => {
          return nodes.filter((node) => node.style && node.style[property] === value);
        },
      });

      // Create test node data
      const testNodes = [
        { name: "div1", style: { overflow: "hidden", color: "red" } },
        { name: "div2", style: { overflow: "visible", color: "blue" } },
        { name: "div3", style: { overflow: "hidden", color: "green" } },
        { name: "span1", style: { display: "block" } },
      ];

      // Convert to LIPS and filter
      const lipsNodes = jsToScheme(CONSTANT_CTX, testNodes, {});
      const filterFn = inferenceEnv.get("filter-by-css-property");
      invariant(isCallable(filterFn), "filter-by-css-property must resolve to a callable rosetta wrapper");
      // Args cross the membrane as Scheme values: the wrapper runs schemeToJs on each
      // before invoking the underlying fn, so the property/value strings are boxed AStrings.
      const result = await filterFn.call(
        makeCallCtx(),
        lipsNodes,
        new AString(CONSTANT_CTX, "overflow"),
        new AString(CONSTANT_CTX, "hidden"),
      );

      console.log("CSS filtering result:", result);

      const jsResult = schemeToJs(result, {});
      expect(jsResult).toHaveLength(2);
      expect(jsResult[0].name).toBe("div1");
      expect(jsResult[1].name).toBe("div3");
    });

    it("should create CSS statistics like the MCP server needs", async () => {
      inferenceEnv.defineRosetta("css-property-stats", {
        fn: (nodes: any[]) => {
          const stats: Record<string, number> = {};
          nodes.forEach((node) => {
            if (node.style) {
              Object.entries(node.style).forEach(([prop, value]) => {
                const key = `${prop}:${value}`;
                stats[key] = (stats[key] || 0) + 1;
              });
            }
          });
          return stats;
        },
      });

      const testNodes = [
        { style: { overflow: "hidden", display: "block" } },
        { style: { overflow: "visible", display: "block" } },
        { style: { overflow: "hidden", display: "flex" } },
      ];

      const lipsNodes = jsToScheme(CONSTANT_CTX, testNodes, {});
      const statsFn = inferenceEnv.get("css-property-stats");
      invariant(isCallable(statsFn), "css-property-stats must resolve to a callable rosetta wrapper");
      const result = await statsFn.call(makeCallCtx(), lipsNodes);

      console.log("CSS stats result:", result);

      const jsResult = schemeToJs(result, {});
      expect(jsResult["overflow:hidden"]).toBe(2);
      expect(jsResult["overflow:visible"]).toBe(1);
      expect(jsResult["display:block"]).toBe(2);
      expect(jsResult["display:flex"]).toBe(1);
    });
  });
});
