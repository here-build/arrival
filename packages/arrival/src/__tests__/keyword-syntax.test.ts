import { CONSTANT_CTX } from "../values/primitives/RunContext.js";
/**
 * Test whether LIPS supports :keyword syntax
 */

import { describe, expect, it } from "vitest";
import { exec, execState } from "../eval/generator-exec.js";
import { inferenceEnv } from "../inference-env.js";
import { jsToScheme, schemeToJs } from "../rosetta.js";

async function execOne(expr: string, env = inferenceEnv): Promise<any> {
  const results = await exec(expr, { env });
  return results[0];
}

// execState (COMPLEX tier): the two callers below assert box discipline directly
// (`.car`, `.constructor.name` — RULINGS.md R1) — `exec`'s plain-JS exit would
// hand back an array/`null` with no such shape.
async function execOneBoxed(expr: string, env = inferenceEnv): Promise<any> {
  const { values } = await execState(expr, { env });
  return values[0];
}

// Three vacuous exploratory blocks DELETED here (2026-07-08 test-invariant-atlas sweep,
// [P16] docs/test-invariant-atlas/verdicts/values.md, docs/test-suite-v2/REMOVAL-MANIFEST.md
// §A keyword-syntax.test.ts row): "should test if bare :keyword works" (both-outcomes-pass,
// `expect(true).toBe(true)` regardless of the actual result), "should test if quoted
// ':keyword works" (fully vacuous — try-branch asserted nothing meaningful, catch-branch
// asserted nothing at all), and "should test what Claude's actual query needs" (console.log
// only, zero assertions in either branch — cannot ever fail). The real accessor cases below
// (keyword-as-getter, quotations, keyword-extractor map/filter, missing-key) survive as the
// load-bearing coverage; a move to a `laws/accessor.law.test.ts` table is deferred (the v2
// `laws/` dir is out of this sweep's scope) — left in place here per the manifest's fallback
// ("else leave in place and note").
describe("LIPS Keyword Syntax Investigation", () => {
  it("should test if bare :keyword works as getter", async () => {
    const result = await execOne(
      "(:pasword obj)",
      inferenceEnv.inherit("keyword-test", {
        obj: jsToScheme(CONSTANT_CTX, { pasword: "swordfish" }),
      }),
    );
    expect(result.toString()).toBe("swordfish"); // Just log, don't fail
  });

  it("should test quotations", async () => {
    const result = await execOneBoxed(
      `(list |24|)`,
      inferenceEnv.inherit("quotation-test", {
        "24": jsToScheme(CONSTANT_CTX, "unqouted"),
      }),
    );

    expect(result.car.toString()).toEqual("unqouted");
  });

  it("should support keywords with map", async () => {
    const users = [
      { id: "1", name: "Alice" },
      { id: "2", name: "Bob" },
      { id: "3", name: "Charlie" },
    ];
    // Scheme map expects pair chains, not JS arrays
    inferenceEnv.set("users", jsToScheme(CONSTANT_CTX, users));

    expect(schemeToJs(await execOne(`(map :name users)`))).toEqual(["Alice", "Bob", "Charlie"]);
  });

  it("should support keywords in filter predicates", async () => {
    const items = [
      { active: true, name: "Item 1" },
      { active: false, name: "Item 2" },
      { active: true, name: "Item 3" },
    ];
    // Scheme filter expects pair chains, not JS arrays
    inferenceEnv.set("items", jsToScheme(CONSTANT_CTX, items));

    // Filter using keyword extractor
    const filtered = schemeToJs(await execOne(`(filter :active items)`));

    expect(filtered).toHaveLength(2);
    expect(filtered[0].name).toBe("Item 1");
    expect(filtered[1].name).toBe("Item 3");
  });

  it("should handle missing keys gracefully", async () => {
    const obj = { name: "test" };
    inferenceEnv.set("obj", jsToScheme(CONSTANT_CTX, obj));

    const result = await execOneBoxed(`(:missing obj)`);
    expect(result.constructor.name).toBe("ANil");
  });
});
