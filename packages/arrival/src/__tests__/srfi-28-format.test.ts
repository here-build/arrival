/**
 * SRFI-28 basic format strings (env/srfi/srfi-28.ts) — the string-destination subset.
 *
 * LLM agents reach for `(format ...)` from CL / SRFI-28 training data. This pack binds
 * the pure, string-returning subset honestly: SRFI-28 proper `(format fmt arg ...)`
 * plus the SRFI-48/CL `#f` destination `(format #f fmt arg ...)`. A `#t`/port
 * destination is a teaching door (no IO here). Directives: ~a ~s ~d ~% ~~.
 *
 * The pack is NOT registered globally (srfi/index.ts is single-writer / off-limits), so
 * every test ASSEMBLES the capability explicitly onto a fresh env — the EnvCapability /
 * assembleEnv idiom from env/__tests__/srfi.test.ts.
 *
 * Provenance discipline mirrors srfi-13-strings.test.ts: format is a COLLAPSING op, so
 * the fresh string carries the union of the fmt string's + every arg's lineage.
 */

import { describe, it, expect } from "vitest";
import { exec, execState, sandboxedEnv } from "../index.js";
import { assembleEnv } from "../common/kernel.js";
import { type SchemeEnv } from "../common/scheme-env.js";
import { CONSTANT_CTX } from "../values/primitives/RunContext.js";
import { AString } from "../values/primitives/AString.js";
import { AValue } from "../values/primitives/AValue.js";
import srfi28 from "../env/srfi/srfi-28.js";

const evalScheme = (e: SchemeEnv, src: string) => exec(src, { env: e as never });

const stamped = (s: string, ...points: number[]) => new AString(CONSTANT_CTX, s, new Set(points));
const sorted = (set: Set<number>) => [...set].sort((a, b) => a - b);
// A literal-only result comes back as a raw JS string; a provenanced input boxes it to
// an AString. Unwrap either shape to the plain JS value.
const js = (x: unknown) => (x instanceof AValue ? x["arrival/toJS"]() : x);

let seq = 0;
async function run(src: string, bindings: Record<string, AString> = {}): Promise<unknown> {
  const env = sandboxedEnv.inherit(`srfi-28-${seq++}`);
  await assembleEnv(env as unknown as SchemeEnv, [srfi28.lower({ evalScheme }) as never]);
  for (const [k, v] of Object.entries(bindings)) (env as unknown as { set(k: string, v: unknown): void }).set(k, v);
  const [r] = await exec(src, { env });
  return r;
}

// execState (COMPLEX tier): the provenance cells below assert box discipline
// directly (`toBeInstanceOf(AValue)`, `.provenance` — RULINGS.md R1).
async function runBoxed(src: string, bindings: Record<string, AString> = {}): Promise<unknown> {
  const env = sandboxedEnv.inherit(`srfi-28-${seq++}`);
  await assembleEnv(env as unknown as SchemeEnv, [srfi28.lower({ evalScheme }) as never]);
  for (const [k, v] of Object.entries(bindings)) (env as unknown as { set(k: string, v: unknown): void }).set(k, v);
  const [r] = (await execState(src, { env })).values;
  return r;
}

describe("format — SRFI-28 proper (format fmt arg ...)", () => {
  it("plain string with no directives is returned verbatim", async () => {
    expect(js(await run('(format "hello world")'))).toBe("hello world");
  });

  it("~a — display style", async () => {
    expect(js(await run('(format "~a" "hi")'))).toBe("hi");
    expect(js(await run('(format "n=~a" 42)'))).toBe("n=42");
    expect(js(await run('(format "~a and ~a" 1 2)'))).toBe("1 and 2");
  });

  it("~s — write style", async () => {
    expect(js(await run('(format "~s" 42)'))).toBe("42");
  });

  it("~d — decimal number", async () => {
    expect(js(await run('(format "~d" 42)'))).toBe("42");
    expect(js(await run('(format "count: ~d" 7)'))).toBe("count: 7");
  });

  it("~% — newline", async () => {
    expect(js(await run('(format "a~%b")'))).toBe("a\nb");
  });

  it("~~ — literal tilde", async () => {
    expect(js(await run('(format "100~~")'))).toBe("100~");
  });

  it("mixed directives fill in order", async () => {
    expect(js(await run('(format "~a = ~d~%" "x" 5)'))).toBe("x = 5\n");
  });
});

describe("format — ~F / ~w,dF fixed-point (SRFI-48 bounded subset)", () => {
  it("~,2f — no width, 2 decimals (the #1 CL-style habit this door completes)", async () => {
    expect(js(await run('(format "~,2f" 3.14159)'))).toBe("3.14");
  });

  it("~F alone — no width, no decimals, free-format render", async () => {
    expect(js(await run('(format "~f" 3.5)'))).toBe("3.5");
  });

  it("~w,dF — width AND decimals, left-padded with spaces", async () => {
    expect(js(await run('(format "[~8,2f]" 3.14159)'))).toBe("[    3.14]");
  });

  it("width-only (no comma, no decimals) is also accepted — free-format render, left-padded", async () => {
    expect(js(await run('(format "[~6f]" 3.5)'))).toBe("[   3.5]");
  });

  it("a genuinely unsupported SRFI-48 directive (~r, radix) still errors, listing ~F in the supported set", async () => {
    await expect(run('(format "~r" 42)')).rejects.toThrow(/unknown directive ~r/);
    await expect(run('(format "~r" 42)')).rejects.toThrow(/~F/);
  });

  it("case-insensitive: ~F and ~f behave identically", async () => {
    const upper = await run('(format "~,1F" 2.25)');
    const lower = await run('(format "~,1f" 2.25)');
    expect(js(upper)).toBe(js(lower));
  });

  it("~,2f with a non-number argument is an error, naming the directive", async () => {
    await expect(run('(format "~,2f" "not-a-number")')).rejects.toThrow(/~,2f directive expects a number/);
  });

  it("rounds via toFixed semantics", async () => {
    expect(js(await run('(format "~,0f" 2.5)'))).toBe("3");
    expect(js(await run('(format "~,2f" 1)'))).toBe("1.00");
  });
});

describe("format — ~s vs ~a on a string (quoted vs bare)", () => {
  it("~a renders a string bare, ~s renders it quoted", async () => {
    expect(js(await run('(format "~a" "hi")'))).toBe("hi");
    expect(js(await run('(format "~s" "hi")'))).toBe('"hi"');
  });

  it("~s escapes embedded quotes and backslashes (re-readable write form)", async () => {
    expect(js(await run('(format "~s" "a\\"b")'))).toBe('"a\\"b"');
  });
});

describe("format — SRFI-48/CL #f destination", () => {
  it("(format #f fmt arg ...) returns the same string as SRFI-28", async () => {
    expect(js(await run('(format #f "~a-~a" 1 2)'))).toBe("1-2");
    expect(js(await run('(format #f "plain")'))).toBe("plain");
  });

  it("#f destination with a non-string second arg is an error", async () => {
    await expect(run("(format #f 42)")).rejects.toThrow(/format string as its second argument/);
  });
});

describe("format — non-#f destinations are teaching doors (string-only, no IO)", () => {
  it("#t destination is rejected with the IO teaching message", async () => {
    await expect(run('(format #t "~a" 1)')).rejects.toThrow(/string-only/);
    await expect(run('(format #t "~a" 1)')).rejects.toThrow(/no IO surface/);
  });

  it("a non-string, non-#f, non-#t first argument (a port-like value) is rejected too", async () => {
    // A vector stands in for any non-string, non-boolean destination the model might pass.
    await expect(run('(format (vector 1 2) "~a" 1)')).rejects.toThrow(/string-only/);
  });
});

describe("format — directive and arity errors are clear", () => {
  it("unknown directive names the directive and lists the supported five", async () => {
    await expect(run('(format "~z" 1)')).rejects.toThrow(/unknown directive ~z/);
    await expect(run('(format "~z" 1)')).rejects.toThrow(/~a.*~s.*~d.*~%.*~~/);
  });

  it("dangling ~ at end of string is an error", async () => {
    await expect(run('(format "abc~")')).rejects.toThrow(/dangling ~/);
  });

  it("too few arguments for the directives", async () => {
    await expect(run('(format "~a ~a" 1)')).rejects.toThrow(/too few arguments/);
  });

  it("too many arguments for the directives", async () => {
    await expect(run('(format "~a" 1 2)')).rejects.toThrow(/too many arguments/);
  });

  it("~d with a non-number argument is an error", async () => {
    await expect(run('(format "~d" "not-a-number")')).rejects.toThrow(/~d directive expects a number/);
  });

  it("no arguments at all is an error", async () => {
    await expect(run("(format)")).rejects.toThrow(/expected a format string/);
  });
});

describe("format — provenance (collapsing op, carries the union of fmt + args)", () => {
  it("the result carries an arg's lineage", async () => {
    const r = await runBoxed('(format "hello ~a" name)', { name: stamped("Alloy", 7) });
    expect(r).toBeInstanceOf(AValue);
    expect(sorted((r as AValue).provenance as Set<number>)).toEqual([7]);
    expect(js(r)).toBe("hello Alloy");
  });

  it("the result carries the DEEP union of several stamped args", async () => {
    const r = await runBoxed('(format "~a/~a" a b)', { a: stamped("x", 3), b: stamped("y", 9) });
    expect(r).toBeInstanceOf(AValue);
    expect(sorted((r as AValue).provenance as Set<number>)).toEqual([3, 9]);
    expect(js(r)).toBe("x/y");
  });

  it("a literal-only format carries no provenance (empty-provenance AString)", async () => {
    const r = await runBoxed('(format "~a" "lit")');
    // Boxed under the Face split (taintString always returns the AString scheme face);
    // "no provenance" now means an EMPTY provenance set, not a raw unboxed string.
    expect(r).toBeInstanceOf(AValue);
    expect(((r as AValue).provenance as Set<number>).size).toBe(0);
    expect(js(r)).toBe("lit");
  });
});
