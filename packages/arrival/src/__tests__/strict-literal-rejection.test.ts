import { describe, expect, it } from "vitest";
import { exec } from "../eval/generator-exec";
import { theVoid } from "../values/primitives/AVoid.js";
import { is_nil } from "../eval/guards";

/**
 * Strict mode is the R7RS portability CONTROL — NOT the default. The `#void`/`#null`
 * reader literals are loose-mode tolerances: a program that writes them is not portable
 * to a stock Scheme (R7RS has no readable void/null literal). Strict parse REJECTS them;
 * the loose default resolves them (to the void singleton / nil). Crucially the VALUES
 * still exist in both modes — only the non-standard readable LITERAL is gated, so this
 * is the divergence signal a user runs strict to find.
 *
 * Mirrors the loose/strict template in projection-nil-tolerance / comparison-divergence.
 * See docs/working-proposals/arrival-graal-membrane-dissolution.md.
 */
describe("strict rejects the #void/#null reader literals (portability control)", () => {
  for (const lit of ["#void", "#null"]) {
    it(`strict: \`${lit}' is rejected at parse time as non-portable`, async () => {
      await expect(exec(lit, { strict: true })).rejects.toThrow(/portable|strict/i);
    });
  }

  it("loose (default): #void resolves to the void singleton", async () => {
    const [result] = await exec("#void");
    expect(result).toBe(theVoid);
  });

  it("loose (default): #null resolves to nil", async () => {
    const [result] = await exec("#null");
    expect(is_nil(result)).toBe(true);
  });
});
