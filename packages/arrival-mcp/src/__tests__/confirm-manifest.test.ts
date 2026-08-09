// manifestDigest — an IDENTITY-only digest: sessionId + statement index + hash of (effect
// list, decoded args). Pure unit tests — no interpreter, no session — the interpreter-backed
// end-to-end scenarios live in confirm-burst.test.ts.

import { describe, expect, it } from "vitest";
import type { EffectEntry } from "@inhuman.tools/arrival/host-internals";

import { buildConfirmManifest, buildInvocationSource, manifestDigest } from "../confirm-manifest.js";

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

// Phase 4 / T2 — surface EffectEntry.resourcePaths on ManifestRow when path E was stamped.
describe("buildConfirmManifest — Phase 4 resourcePaths on rows", () => {
  it("copies resourcePaths onto the row when present; omits when absent", () => {
    const withPaths: EffectEntry = {
      index: 0,
      verbName: "upsert!",
      decodedArgs: [{ id: "1" }],
      resourcePaths: [["db", "projects", "1"]],
    };
    const without: EffectEntry = {
      index: 1,
      verbName: "ping!",
      decodedArgs: [],
    };
    const manifest = buildConfirmManifest({
      sessionId: "s1",
      statementIndex: 0,
      entries: [withPaths, without],
      isRisky: () => false,
    });
    expect(manifest.rows[0].resourcePaths).toEqual([["db", "projects", "1"]]);
    expect(manifest.rows[1].resourcePaths).toBeUndefined();
  });
});
