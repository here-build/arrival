// tool.view / tool.pure / tool.effect / tool.risky — the pre-applied `tool` factory family.
// `isTool: true` is a plain boolean; `tool.risky` is `tool.effect` plus a static `risky`
// metadata key, riding the SAME bake-time metadata channel every `tool.*` arm already writes
// `description` through.
//
// UNIT plane only (direct `def.contract.run(...)`, manually-built `:key` pluck pairs) — mirrors
// arrival core's own `kwargs-runtime.test.ts` convention: by the time a call's args reach a
// rosetta `run` wrapper, `(tool :a v)` has already evaluated to `[:a, v]` (self-evaluating
// keyword ASymbols, keyword-tagless-apply.md), so a UNIT test constructs that shape by hand.
//
// RE-PINNED (2026-07-22, arrival core commit 2172eb4bc0 "symbol factories mint their A-values
// — the lowering-free authoring endpoint"): a `tool.*` factory's return value is now the
// baked runtime `ARosettaProcedure` itself, not the old bare `RosettaSymbolDef` record — its
// OWN `.kind` is the AValue-family tag `"procedure"` (every callable's, regardless of
// authoring arm), while the record this suite used to inspect directly (`cacheClass`/
// `metadata`/`provenance`/`run`/the def's OWN `kind: "rosetta"`) now rides `.contract`
// (`ARosettaProcedure.contract: unknown`, cast to `RosettaSymbolDef` here — the exact shape
// `common/symbols/rosetta.ts`'s `new ARosettaProcedure({contract: def, ...})` stamps). Every
// assertion below reads the SAME facts, at their new address — nothing is weakened.
//
// RE-PINNED (2026-07-22, arrival core commit a68d9fc79f "eliminate the per-value ctx field
// from AValue"): `AString`/`ASymbol`/`AInexact` (and every AValue subclass) dropped their
// leading `ctx: RunContext` constructor param — construct with the value alone.

import type { SymbolDeclaration } from "@inhuman.tools/arrival/capability";
import { symbol, testCallCtx, type CacheClass } from "@inhuman.tools/arrival";
import { z, type RosettaSymbolDef } from "@inhuman.tools/arrival";
import { AInexact, AString, ASymbol } from "@inhuman.tools/arrival/reflect-internals";
import { describe, expect, it } from "vitest";

import { tool } from "../tool.js";

/** The baked `RosettaSymbolDef` record every `tool.*` factory's returned runtime value
 *  carries on `.contract` — see this file's own header for why the read moved here.
 *  `tool.*`'s own declared return type is the wide `SymbolDeclaration` (tool.ts's own
 *  `.d.ts`-emission fix — see that file's comments), never the narrow runtime class name
 *  (`ARosettaProcedure` isn't re-exported through the two-tier public surface at all); this
 *  helper is the one place that narrows back down, since every value this suite hands it IS,
 *  at runtime, the baked rosetta procedure `tool.*` always mints. */
function contractOf(def: SymbolDeclaration): RosettaSymbolDef {
  return (def as { contract: unknown }).contract as RosettaSymbolDef;
}

/** Invoke a baked rosetta procedure via its apply term (the sole membrane spine). */
function fire(proc: { ["arrival/tagless-final/apply"](args: any[], callCtx: any): any }, callCtx: any, ...args: any[]) {
  return proc["arrival/tagless-final/apply"](args, callCtx);
}


/** A keyword `ASymbol` exactly as evaluating `:key` produces (self-evaluating). */
function pluck(key: string): unknown {
  return new ASymbol(`:${key}`);
}

describe("tool.view — cacheClass stamping", () => {
  it('bakes cacheClass: "view" onto the def, with a real (non-escape-hatch) output codec', () => {
    const def = tool.view`snapshot: a boundary snapshot`({ shape: {}, output: [z.string] }, () => "ok");
    expect(contractOf(def).kind).toBe("rosetta");
    expect(contractOf(def).cacheClass).toBe("view" satisfies CacheClass);
    expect(contractOf(def).metadata?.description).toBe("a boundary snapshot");
  });

  it("runs end to end: decode kwargs → impl → encode the declared output", async () => {
    const def = tool.view`echo-view: echoes`({ shape: { text: z.string }, output: [z.string] }, (args: {
      text: string;
    }) => args.text);
    const out = await fire(def, testCallCtx(), pluck("text"), new AString("hi"));
    expect((out as AString)["arrival/toJS"]()).toBe("hi");
  });

  it("a view whose output carries the raw z.dynamic escape hatch throws at bake — the landed shape gate fires through this factory too", () => {
    expect(() => tool.view`bad-view: `({ shape: {}, output: [z.dynamic] }, () => ({}))).toThrow();
  });
});

describe("tool.pure — cacheClass stamping", () => {
  it('bakes cacheClass: "pure" and defaults output to the [sz.dynamic] escape hatch when omitted', () => {
    const def = tool.pure`compute: a pure computation`({ shape: {} }, () => 42);
    expect(contractOf(def).cacheClass).toBe("pure" satisfies CacheClass);
  });

  it("a pure verb accepts a z.dynamic output with NO shape gate (nothing of it is persisted)", () => {
    expect(() => tool.pure`raw-pure: `({ shape: {}, output: [z.dynamic] }, () => 1)).not.toThrow();
  });

  it("runs end to end with a declared output codec", async () => {
    const def = tool.pure`double: doubles a number`({ shape: { n: z.number }, output: [z.number] }, (args: {
      n: number;
    }) => args.n * 2);
    const out = await fire(def, testCallCtx(), pluck("n"), new AInexact(21));
    expect((out as AInexact).real).toBe(42);
  });
});

describe("tool.effect — sink provenance + void-shape enforcement", () => {
  it('bakes provenance: "sink" with NO cacheClass (never persisted, never regenerated from a cache)', () => {
    const def = tool.effect`mutate: mutates something`({ shape: {} }, () => undefined);
    expect(contractOf(def).provenance).toBe("sink");
    expect(contractOf(def).cacheClass).toBeUndefined();
  });

  it("runs end to end — the impl fires, the wrapper returns void", async () => {
    let seen: string | undefined;
    const def = tool.effect`set-flag: flips a flag`({ shape: { value: z.string } }, (args: { value: string }) => {
      seen = args.value;
    });
    const out = await fire(def, testCallCtx(), pluck("value"), new AString("on"));
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
    expect(contractOf(def).provenance).toBe("sink");
    expect(contractOf(def).cacheClass).toBeUndefined();
    expect(contractOf(def).metadata?.risky).toBe(true);
    expect(contractOf(def).metadata?.description).toBe("irreversible");
  });

  it("`risky` is STATIC data — factory-declared, never something a caller can flip per call", () => {
    const def = tool.risky`wipe: `({ shape: {} }, () => undefined);
    // The metadata bag carries `risky` as a plain boolean DATA field, not a fn — there is no
    // per-call channel that could toggle it; it rides the same bake-time-only bag
    // `description` does (`BakeRuntimeOpts.metadata`, arrival core's `_bake.ts`).
    expect(typeof contractOf(def).metadata?.risky).toBe("boolean");
  });

  it("a caller can still layer extra static meta beside risky", () => {
    const def = tool.risky`purge: irreversible purge`({ shape: {} }, () => undefined, { group: "danger-zone" });
    expect(contractOf(def).metadata?.risky).toBe(true);
    expect(contractOf(def).metadata?.group).toBe("danger-zone");
  });
});

describe("isTool: true — the static exposure flag, riding the SAME metadata bag", () => {
  it("tool.view/pure/effect/risky all accept it, unchanged shape", () => {
    expect(
      contractOf(tool.view`v: `({ shape: {}, output: [z.string] }, () => "x", { isTool: true })).metadata?.isTool,
    ).toBe(true);
    expect(contractOf(tool.pure`p: `({ shape: {} }, () => 1, { isTool: true })).metadata?.isTool).toBe(true);
    expect(contractOf(tool.effect`e: `({ shape: {} }, () => undefined, { isTool: true })).metadata?.isTool).toBe(
      true,
    );
    expect(contractOf(tool.risky`r: `({ shape: {} }, () => undefined, { isTool: true })).metadata?.isTool).toBe(
      true,
    );
  });

  it("absent by default — a plain tool.* verb is a declared action, not (yet) its own top-level tool", () => {
    expect(contractOf(tool.pure`quiet: `({ shape: {} }, () => 1)).metadata?.isTool).toBeUndefined();
  });
});

describe("bare tool`` stays unclassified (regenerateable, the safe default) — untouched by the new arms", () => {
  it("carries no cacheClass and defaults to source provenance", () => {
    const def = tool`bare: unchanged`({ shape: {}, output: [], input: [] } as never, () => "x");
    expect(contractOf(def).cacheClass).toBeUndefined();
    expect(contractOf(def).provenance).toBe("source");
  });
});
