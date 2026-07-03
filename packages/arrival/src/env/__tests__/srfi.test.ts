// Unified SRFI palette — assemble each capability onto a real env and run one verb.
import { exec, sandboxedEnv } from "../../index.js";
import { assembleEnv } from "../../common/kernel.js";
import { type SchemeEnv } from "../../common/scheme-env.js";
import { describe, expect, it } from "vitest";

import { allSrfi, srfi1, srfi13, srfi26, srfi43, srfi128, srfi189, srfi2, srfi8, srfi235 } from "../srfi/index.js";

const evalScheme = (e: SchemeEnv, src: string) => exec(src, { env: e as never });

/** Assemble one capability onto a fresh env; return a `(num src)` runner. */
async function withCap(cap: { lower: (o: { evalScheme: typeof evalScheme }) => unknown }, name: string) {
  const env = sandboxedEnv.inherit(name);
  await assembleEnv(env as unknown as SchemeEnv, [cap.lower({ evalScheme }) as never]);
  return async (src: string) => Number((await exec(src, { env }))[0]);
}

describe("@here.build/arrival/srfi", () => {
  it("SRFI-1 list library", async () => {
    const num = await withCap(srfi1, "s1");
    expect(await num("(length+ (list 1 2 3 4))")).toBe(4);
  });
  it("SRFI-13 string library", async () => {
    const num = await withCap(srfi13, "s13");
    expect(await num('(string-index "abc" #\\b)')).toBe(1);
  });
  it("SRFI-43 vectors", async () => {
    const num = await withCap(srfi43, "s43");
    expect(await num("(vector-count odd? (vector 1 2 3 4 5))")).toBe(3);
  });
  it("SRFI-189 Maybe/Either", async () => {
    const num = await withCap(srfi189, "s189");
    expect(await num("(maybe-ref (just 7))")).toBe(7);
  });
  it("SRFI-128 comparators", async () => {
    const num = await withCap(srfi128, "s128");
    expect(await num("(if (=? (make-default-comparator) 1 1) 1 0)")).toBe(1);
  });
  it("SRFI-26 cut/cute", async () => {
    const num = await withCap(srfi26, "s26");
    expect(await num("((cut + 1 <>) 5)")).toBe(6);
  });
  it("SRFI-8 receive (define-syntax — may not survive the sandbox)", async () => {
    const num = await withCap(srfi8, "s8");
    expect(await num("(receive (a b) (values 1 2) (+ a b))")).toBe(3);
  });
  it("SRFI-2 and-let* (define-syntax — may not survive the sandbox)", async () => {
    const num = await withCap(srfi2, "s2");
    expect(await num("(and-let* ((x 5)) (+ x 1))")).toBe(6);
  });

  it("SRFI-235 combinators (constantly / always alias)", async () => {
    const num = await withCap(srfi235, "s235");
    expect(await num("((constantly 7) 1 2 3)")).toBe(7);
    expect(await num("((always 7) 1 2 3)")).toBe(7);
  });

  it("allSrfi exposes the whole set", () => {
    expect(allSrfi).toHaveLength(13);
    expect(allSrfi.map((c) => c.name)).toContain("scheme/srfi-1");
    expect(allSrfi.map((c) => c.name)).toContain("scheme/srfi-13");
    expect(allSrfi.map((c) => c.name)).toContain("scheme/srfi-95");
    expect(allSrfi.map((c) => c.name)).toContain("scheme/srfi-235");
  });
});

// SRFI-1 positional head accessors (first … tenth), added to srfi-1.ts. `last` /
// `last-pair` already lived in the pack, so they are exercised here only for
// completeness (1-element + improper/dotted list) — the new symbols are first…tenth.
// Assembles srfi-1 EXPLICITLY (the accessors are not registered globally this round).
describe("@here.build/arrival/srfi-1 — positional accessors", () => {
  async function accEnv() {
    const env = sandboxedEnv.inherit(`s1acc-${Math.random().toString(36).slice(2)}`);
    await assembleEnv(env as unknown as SchemeEnv, [srfi1.lower({ evalScheme }) as never]);
    const num = async (src: string) => Number((await exec(src, { env }))[0]);
    const raw = (src: string) => exec(src, { env });
    return { num, raw };
  }

  it("first … tenth pick the nth element of a proper list", async () => {
    const { num } = await accEnv();
    const xs = "(list 10 20 30 40 50 60 70 80 90 100)";
    expect(await num(`(first ${xs})`)).toBe(10);
    expect(await num(`(second ${xs})`)).toBe(20);
    expect(await num(`(third ${xs})`)).toBe(30);
    expect(await num(`(fourth ${xs})`)).toBe(40);
    expect(await num(`(fifth ${xs})`)).toBe(50);
    expect(await num(`(sixth ${xs})`)).toBe(60);
    expect(await num(`(seventh ${xs})`)).toBe(70);
    expect(await num(`(eighth ${xs})`)).toBe(80);
    expect(await num(`(ninth ${xs})`)).toBe(90);
    // exact boundary — tenth of a 10-element list is the last element.
    expect(await num(`(tenth ${xs})`)).toBe(100);
  });

  it("errors when the list is too short for the requested position", async () => {
    const { raw } = await accEnv();
    await expect(raw("(third (list 1 2))")).rejects.toThrow(/third: list has fewer than 3/);
    await expect(raw("(tenth (list 1 2 3 4 5 6 7 8 9))")).rejects.toThrow(/tenth: list has fewer than 10/);
    await expect(raw("(first '())")).rejects.toThrow(/first: list has no elements/);
  });

  it("returns the element AS-IS (nested structure preserved, no re-stamp)", async () => {
    const { num } = await accEnv();
    // second element is itself a list; taking its car proves it was returned intact.
    expect(await num("(car (second (list 1 (list 7 8) 3)))")).toBe(7);
  });

  it("last / last-pair on a 1-element list", async () => {
    const { num } = await accEnv();
    expect(await num("(last (list 42))")).toBe(42);
    expect(await num("(car (last-pair (list 42)))")).toBe(42);
    // the last pair's cdr of a proper 1-element list is the empty list.
    expect(await num("(if (null? (cdr (last-pair (list 42)))) 1 0)")).toBe(1);
  });

  it("last / last-pair on an improper (dotted) list — SRFI-1 semantics", async () => {
    const { num } = await accEnv();
    // last-pair of (1 2 . 3) is (2 . 3); last is its car.
    expect(await num("(last (cons 1 (cons 2 3)))")).toBe(2);
    expect(await num("(car (last-pair (cons 1 (cons 2 3))))")).toBe(2);
    expect(await num("(cdr (last-pair (cons 1 (cons 2 3))))")).toBe(3);
  });
});
