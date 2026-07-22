// Caveat-sweep finding (2026-06-11): boxed vectors/bytevectors print garbage in
// the repr path (the only user-facing stringify in the MCP bridge env) — and TWO
// divergent garbage strings: "#<vector>" top-level (static __class__) vs
// "#<SchemeVector>" (JS class name) nested in a Pair; bytevector → "#<bytevector>".
// They must render as the R7RS external representation #(...) / #u8(...). repr of
// a vector had ZERO test coverage before this.
import { describe, expect, it } from "vitest";
import { freshEnv } from "./_fresh-env.js";
import { execOverFrame as exec } from "../eval/generator-exec.js";

const env = await freshEnv();
const repr = async (form: string) => String((await exec(form, { env }) as unknown[])[0]);

describe("vector / bytevector external representation (repr)", () => {
  it.each([
    { name: "a vector prints #(...) at top level", form: `(repr (vector 1 2 3))`, expected: "#(1 2 3)" },
    {
      name: "a vector prints #(...) nested in a list (was #<SchemeVector>)",
      form: `(repr (list (vector 1 2)))`,
      expected: "(#(1 2))",
    },
    { name: "a #(...) literal reprs as #(...)", form: `(repr #(1 2 3))`, expected: "#(1 2 3)" },
    { name: "nested vectors recurse", form: `(repr (vector 1 (vector 2 3)))`, expected: "#(1 #(2 3))" },
    {
      name: "a vector of strings renders elements (repr default = unquoted)",
      form: `(repr (vector "a" "b"))`,
      expected: `#(a b)`,
    },
    { name: "an empty vector reprs as #()", form: `(repr (vector))`, expected: "#()" },
    { name: "a bytevector prints #u8(...)", form: `(repr (bytevector 1 2 255))`, expected: "#u8(1 2 255)" },
  ])("$name", async ({ form, expected }) => {
    expect(await repr(form)).toBe(expected);
  });
});
