// manifestDigest — an IDENTITY-only digest: sessionId + statement index + hash of (effect
// list, decoded args). Pure unit tests — no interpreter, no session — the interpreter-backed
// end-to-end scenarios live in confirm-burst.test.ts.

import { describe, expect, it } from "vitest";

import { buildInvocationSource, manifestDigest } from "../confirm-manifest.js";

describe("manifestDigest — manifest IDENTITY only (§7.1)", () => {
  const entriesA = [{ verbName: "create-widget", decodedArgs: [{ name: "a" }] }];
  const entriesB = [{ verbName: "create-widget", decodedArgs: [{ name: "b" }] }];

  it("is stable for the same sessionId/statementIndex/entries", () => {
    expect(manifestDigest("s1", 0, entriesA)).toBe(manifestDigest("s1", 0, entriesA));
  });

  it("differs when the decoded args differ", () => {
    expect(manifestDigest("s1", 0, entriesA)).not.toBe(manifestDigest("s1", 0, entriesB));
  });

  it("differs when the sessionId differs (same statementIndex/entries)", () => {
    expect(manifestDigest("s1", 0, entriesA)).not.toBe(manifestDigest("s2", 0, entriesA));
  });

  it("differs when the statementIndex differs (same sessionId/entries)", () => {
    expect(manifestDigest("s1", 0, entriesA)).not.toBe(manifestDigest("s1", 1, entriesA));
  });

  it("differs when the effect count differs, even with identical individual entries", () => {
    expect(manifestDigest("s1", 0, entriesA)).not.toBe(manifestDigest("s1", 0, [...entriesA, ...entriesA]));
  });

  it("falls back to a coarser (verb-name-only) digest rather than throwing on non-JSON args", () => {
    const withFn = [{ verbName: "x", decodedArgs: [{ cb: () => 1 }] }];
    expect(() => manifestDigest("s1", 0, withFn)).not.toThrow();
  });
});

describe("buildInvocationSource — the row's own minimal re-runnable program (§5)", () => {
  it("re-derives a plain 0-arg call", () => {
    expect(buildInvocationSource("wipe", [])).toBe("(wipe)");
  });
});
