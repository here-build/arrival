/**
 * Legacy `env.defineRosetta` exercises — quarantined survivor of
 * `rosetta-environment.test.ts` (docs/test-suite-v2/REMOVAL-MANIFEST.md §A).
 *
 * The file's "LIPS → JS Conversion" / "JS → LIPS Conversion" / "Rosetta Function
 * Wrapping" describes retired 2026-07-09 (G2): their conversion round-trips are now
 * covered more rigorously by `membrane/crossing.law.test.ts`'s CROSSINGS table (every
 * value type × both directions × round-trip promise, driven off one shared table
 * instead of ad hoc per-case asserts). The one genuinely novel regression case
 * (symbol-keyed properties surviving the JS→scheme→JS round-trip) and the one
 * design-pending stub (empty list → empty array) moved into that file too.
 *
 * What's left below (`Environment.defineRosetta` + "Real-world Use Cases") does NOT
 * die with that move: B4's audit (2026-07-09) confirmed the legacy `env.defineRosetta`
 * authoring arm is still load-bearing OUTSIDE this package — `McpEnvCapability`
 * (arrival-mcp) and every real downstream consumer (inhuman/sift-submission/mcp,
 * here.build/saas/server/{mcp,arrival}, inhuman/saas/mcp) construct `SymbolDeclaration`s
 * this exact way. See `src/__tests__/ledger/index.law.test.ts`'s INVERSIONS row
 * "defineRosetta legacy arm authoring form" (gate: McpEnvCapability annotation-lifting)
 * — these rows travel with THAT migration, not this file's retirement.
 */
import invariant from "tiny-invariant";
import { describe, expect, it } from "vitest";
import { CONSTANT_CTX } from "../values/primitives/RunContext.js";
import { AString } from "../values/primitives/AString.js";
import { inferenceEnv } from "../inference-env.js";
import { jsToScheme, schemeToJs } from "../rosetta.js";
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
  // [RETAGGED 2026-07-09, B4 — was INVERTS: reverse-membrane/P1] exercises the legacy
  // `env.defineRosetta` arm — P1's own "Revealed by" line names this exact form as a JS
  // artifact living in value space without lineage, still true. Does NOT die with B1-B3
  // (landed 2026-07-09): the ledger already carries the precise gate — see
  // `src/__tests__/ledger/index.law.test.ts`'s INVERSIONS row "defineRosetta legacy arm
  // authoring form" (gate: McpEnvCapability annotation-lifting). Confirmed still undone:
  // `McpEnvCapability` (arrival-mcp/src/McpEnvCapability.ts) authors every verb as a bare fn /
  // RosettaSpec-shaped object, and every real downstream consumer (inhuman/sift-submission/
  // mcp/src/packs/*.ts, here.build/saas/server/{mcp,arrival}, inhuman/saas/mcp) constructs
  // `SymbolDeclaration`s this exact way. `capability.ts`'s own doc comment (SymbolDeclaration,
  // ~L62-78) independently confirms this arm is "load-bearing OUTSIDE it… NOT dead code."
  // Travels with the McpEnvCapability migration, not the reverse-membrane one.
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

  // [RETAGGED 2026-07-09, B4 — was INVERTS: reverse-membrane/P1] — same legacy `defineRosetta`
  // arm as the describe above (MCP CSS-filtering / stats patterns exercised here); same gate
  // (McpEnvCapability annotation-lifting, undone), not the reverse-membrane migration.
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
