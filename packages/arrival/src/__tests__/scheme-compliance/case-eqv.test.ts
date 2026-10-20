// `case` dispatches with eqv? (R7RS §4.2.1): symbols, chars, and exact numbers match; an
// exact datum never matches an inexact key; a string/list/vector datum can never match
// under eqv? and is a taught door rather than a silently dead clause.
import { describe, expect, it } from "vitest";
import { exec } from "../../index.js";

const run = (src: string) => exec(src) as Promise<unknown[]>;
const last = async (src: string) => (await run(src)).at(-1);

describe("case equality is eqv?", () => {
  it("matches symbols", async () => {
    expect(await last("(case 'b ((a) 1) ((b c) 2) (else 3))")).toBe(2);
  });
  it("matches chars", async () => {
    expect(await last(String.raw`(case #\x ((#\y) 1) ((#\x) 2) (else 3))`)).toBe(2);
  });
  it("matches exact integers", async () => {
    expect(await last("(case (+ 1 1) ((1) 'one) ((2 3) 'few) (else 'many))")).toBe("few");
  });
  it("an exact datum does not match an inexact key", async () => {
    expect(await last("(case 2.0 ((2) 'exact) (else 'other))")).toBe("other");
  });
  it("falls through to else, or to void without it", async () => {
    expect(await last("(case 9 ((1) 'a) (else 'z))")).toBe("z");
  });
  it("a string datum is a door naming the alternatives", async () => {
    await expect(run('(case "foo" (("foo") 1) (else 2))')).rejects.toThrow(
      /`case` compares with eqv\?, which never matches a string\/list literal — use `\(cond \(\(string=\? s "foo"\)/,
    );
  });
  it("a list datum is a door", async () => {
    await expect(run("(case '(1) (((1)) 1) (else 2))")).rejects.toThrow(/compares with eqv\?/);
  });
});
