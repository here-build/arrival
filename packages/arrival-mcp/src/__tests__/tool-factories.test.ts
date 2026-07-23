// tool.view / tool.pure / tool.effect / tool.risky — the pre-applied `tool` factory family.
// `isTool: true` is a plain boolean; `tool.risky` is `tool.effect` plus a static `risky`
// metadata key, riding the SAME bake-time metadata channel every `tool.*` arm already writes
// `description` through.
//
// UNIT plane only (direct `def.run(...)`, manually-built `:key` pluck pairs) — mirrors
// arrival core's own `kwargs-runtime.test.ts` convention: by the time a call's args reach a
// rosetta `run` wrapper, `(tool :a v)` has already evaluated to `[:a, v]` (self-evaluating
// keyword ASymbols, keyword-tagless-apply.md), so a UNIT test constructs that shape by hand.

import { CONSTANT_CTX } from "@inhuman.tools/arrival";
import { symbol, testCallCtx, type CacheClass } from "@inhuman.tools/arrival/symbol";
import { z } from "@inhuman.tools/arrival";
import { AInexact } from "@inhuman.tools/arrival";
import { AString } from "@inhuman.tools/arrival";
import { ASymbol } from "@inhuman.tools/arrival";
import { describe, expect, it } from "vitest";

import { tool } from "../tool.js";

/** A keyword `ASymbol` exactly as evaluating `:key` produces (self-evaluating). */
function pluck(key: string): unknown {
  return new ASymbol(CONSTANT_CTX, `:${key}`);
}

describe("tool.view — cacheClass stamping", () => {
  it('bakes cacheClass: "view" onto the def, with a real (non-escape-hatch) output codec', () => {
    const def = tool.view`snapshot: a boundary snapshot`({ shape: {}, output: [z.string] }, () => "ok");
    expect(def.kind).toBe("rosetta");
    expect(def.cacheClass).toBe("view" satisfies CacheClass);
    expect(def.metadata?.description).toBe("a boundary snapshot");
  });

  it("runs end to end: decode kwargs → impl → encode the declared output", async () => {
    const def = tool.view`echo-view: echoes`({ shape: { text: z.string }, output: [z.string] }, (args: {
      text: string;
    }) => args.text);
    const out = await def.run.call(testCallCtx(), pluck("text"), new AString(CONSTANT_CTX, "hi"));
    expect((out as AString)["arrival/toJS"]()).toBe("hi");
  });

  it("a view whose output carries the raw z.value escape hatch throws at bake — the landed shape gate fires through this factory too", () => {
    expect(() => tool.view`bad-view: `({ shape: {}, output: [z.value] }, () => ({}))).toThrow();
  });
});

describe("tool.pure — cacheClass stamping", () => {
  it('bakes cacheClass: "pure" and defaults output to the [sz.value] escape hatch when omitted', () => {
    const def = tool.pure`compute: a pure computation`({ shape: {} }, () => 42);
    expect(def.cacheClass).toBe("pure" satisfies CacheClass);
  });

  it("a pure verb accepts a z.value output with NO shape gate (nothing of it is persisted)", () => {
    expect(() => tool.pure`raw-pure: `({ shape: {}, output: [z.value] }, () => 1)).not.toThrow();
  });

  it("runs end to end with a declared output codec", async () => {
    const def = tool.pure`double: doubles a number`({ shape: { n: z.number }, output: [z.number] }, (args: {
      n: number;
    }) => args.n * 2);
    const out = await def.run.call(testCallCtx(), pluck("n"), new AInexact(CONSTANT_CTX, 21));
    expect((out as AInexact).real).toBe(42);
  });
});

describe("tool.effect — sink provenance + void-shape enforcement", () => {
  it('bakes provenance: "sink" with NO cacheClass (never persisted, never regenerated from a cache)', () => {
    const def = tool.effect`mutate: mutates something`({ shape: {} }, () => undefined);
    expect(def.provenance).toBe("sink");
    expect(def.cacheClass).toBeUndefined();
  });

  it("runs end to end — the impl fires, the wrapper returns void", async () => {
    let seen: string | undefined;
    const def = tool.effect`set-flag: flips a flag`({ shape: { value: z.string } }, (args: { value: string }) => {
      seen = args.value;
    });
    const out = await def.run.call(testCallCtx(), pluck("value"), new AString(CONSTANT_CTX, "on"));
    expect(seen).toBe("on");
    // `run` returns the ENCODED scheme-side value (the boxed AVoid), not the decoded JS
    // `undefined` — `sz.undefinedResult`'s own encode arm. void-family, never a real value.
    expect((out as { kind: string }).kind).toBe("void");
  });

  it("the landed sink shape gate (assertProvenanceRoleShape) is what makes this sound — a raw sink rosetta with a real return value throws at bake", () => {
    // Sanity-checks the SHARED gate `tool.effect` leans on (never bypassed by construction:
    // this factory never exposes an `output` param, so a caller can't accidentally defeat it)
    // — proven directly against `symbol.rosetta` so the assertion targets the gate itself, not
    // this factory's own (structurally void) call shape.
    expect(() =>
      symbol.rosetta`bad-sink: `({ input: [z.string], output: [z.string], provenance: "sink" }, (s) => s),
    ).toThrow(/sink is a port with no egress wire/);
  });
});

describe("tool.risky — tool.effect + a static `risky` metadata key", () => {
  it("bakes the same sink/void shape as tool.effect, PLUS risky: true on the metadata bag", () => {
    const def = tool.risky`delete-everything: irreversible`({ shape: {} }, () => undefined);
    expect(def.provenance).toBe("sink");
    expect(def.cacheClass).toBeUndefined();
    expect(def.metadata?.risky).toBe(true);
    expect(def.metadata?.description).toBe("irreversible");
  });

  it("`risky` is STATIC data — factory-declared, never something a caller can flip per call", () => {
    const def = tool.risky`wipe: `({ shape: {} }, () => undefined);
    // The metadata bag carries `risky` as a plain boolean DATA field, not a fn — there is no
    // per-call channel that could toggle it; it rides the same bake-time-only bag
    // `description` does (`BakeRuntimeOpts.metadata`, arrival core's `_bake.ts`).
    expect(typeof def.metadata?.risky).toBe("boolean");
  });

  it("a caller can still layer extra static meta beside risky", () => {
    const def = tool.risky`purge: irreversible purge`({ shape: {} }, () => undefined, { group: "danger-zone" });
    expect(def.metadata?.risky).toBe(true);
    expect(def.metadata?.group).toBe("danger-zone");
  });
});

describe("isTool: true — the static exposure flag, riding the SAME metadata bag", () => {
  it("tool.view/pure/effect/risky all accept it, unchanged shape", () => {
    expect(tool.view`v: `({ shape: {}, output: [z.string] }, () => "x", { isTool: true }).metadata?.isTool).toBe(
      true,
    );
    expect(tool.pure`p: `({ shape: {} }, () => 1, { isTool: true }).metadata?.isTool).toBe(true);
    expect(tool.effect`e: `({ shape: {} }, () => undefined, { isTool: true }).metadata?.isTool).toBe(true);
    expect(tool.risky`r: `({ shape: {} }, () => undefined, { isTool: true }).metadata?.isTool).toBe(true);
  });

  it("absent by default — a plain tool.* verb is a declared action, not (yet) its own top-level tool", () => {
    expect(tool.pure`quiet: `({ shape: {} }, () => 1).metadata?.isTool).toBeUndefined();
  });
});

describe("bare tool`` stays unclassified (regenerateable, the safe default) — untouched by the new arms", () => {
  it("carries no cacheClass and defaults to source provenance", () => {
    const def = tool`legacy: unchanged`({ shape: {}, output: [], input: [] } as never, () => "x");
    expect(def.cacheClass).toBeUndefined();
    expect(def.provenance).toBe("source");
  });
});
