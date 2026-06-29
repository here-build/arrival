// capability-rosetta-symbol.test.ts — the SECOND lower() path: a rosetta SymbolDef.
//
// The equality pilot (equality.ts) is native-only, so it exercises only the `kind:"native"`
// arm of EnvCapability.lower(). This file proves the `kind:"rosetta"` arm end-to-end:
//   declare (symbol.rosetta) → put in an EnvCapability → lower() → apply() → call the bound verb,
// asserting BOTH halves of the contract:
//   1. the CODEC MEMBRANE — decode scheme→JS, run impl, encode JS→scheme (+ validation rejection);
//   2. the PROVENANCE MINT (the former TODO, now resolved) — the bound `run` is `__withCtx`, so the
//      evaluator appends ctx; given a ctx.currentInvocation the wrapper MARKS the point and stamps
//      the output with `pointProvenance(inv.id)` — the SAME behavior `defineRosetta` gives today.
//
// The mint is driven here by a SYNTHETIC ctx (a POJO invocation), exactly the direct-JS shape the
// real createRosettaWrapper tests use — no full evaluator needed to prove the wiring.

import { describe, expect, it } from "vitest";
import { CONSTANT_CTX } from "../../values/primitives/RunContext.js";

import { EnvCapability } from "../capability.js";
import { symbol, type RosettaSymbolDef } from "../symbol.js";
import * as z from "../scheme-zod.js";
import type { SchemeEnv } from "../scheme-env.js";
import { AString } from "../../values/primitives/AString.js";
import { AExact } from "../../values/primitives/AExact.js";
import { AInexact } from "../../values/primitives/AInexact.js";
import { AValue } from "../../values/primitives/AValue.js";

type WithCtxFn = ((...a: unknown[]) => unknown) & { __withCtx?: boolean };

/** A SchemeEnv that records every `set` binding (native + rosetta SymbolDefs route through set). */
function recordingEnv(): { env: SchemeEnv; verbs: Record<string, WithCtxFn> } {
  const verbs: Record<string, WithCtxFn> = {};
  const env = {
    set: (name: string, value: unknown) => void (verbs[name] = value as WithCtxFn),
    get: () => undefined,
    defineRosetta: () => undefined,
    inherit: () => env,
    registerResolver: () => undefined,
    list: () => [],
    allBoundNames: () => [],
  } as unknown as SchemeEnv;
  return { env, verbs };
}

/** A synthetic EvalContext carrying a provenance-point invocation (the shape the wrapper reads). */
function ctxWithInvocation(id: number): {
  ctx: { env: unknown; currentInvocation: { id: number; isProvenancePoint: boolean; markProvenancePoint(): void } };
  marked: () => boolean;
} {
  let didMark = false;
  const ctx = {
    env: {},
    currentInvocation: {
      id,
      isProvenancePoint: false,
      markProvenancePoint() {
        didMark = true;
        this.isProvenancePoint = true;
      },
    },
  };
  return { ctx, marked: () => didMark };
}

async function wireRosetta(def: RosettaSymbolDef): Promise<WithCtxFn> {
  const cap = new EnvCapability("test/rosetta", { symbols: { verb: def } });
  const { env, verbs } = recordingEnv();
  await cap.lower({}).apply(env, undefined as never);
  return verbs.verb;
}

describe("EnvCapability.lower() — the rosetta SymbolDef arm", () => {
  it("binds the run wrapper (tagged __withCtx) via set, not defineRosetta", async () => {
    const def = symbol.rosetta`strlen: length of a string`({ input: [z.string], output: [z.number] }, (s) => s.length);
    const verb = await wireRosetta(def);
    expect(typeof verb).toBe("function");
    expect(verb.__withCtx).toBe(true); // the evaluator will append ctx
  });

  it("decodes scheme→JS, runs impl, encodes JS→scheme through the bound verb", async () => {
    const def = symbol.rosetta`strlen: length of a string`({ input: [z.string], output: [z.number] }, (s) => s.length);
    const verb = await wireRosetta(def);
    // No ctx (a direct/test call) — proves the codec membrane in isolation.
    const out = await verb(new AString(CONSTANT_CTX, "hello"));
    expect(out).toBeInstanceOf(AInexact); // z.number encode → inexact
    expect((out as AInexact).real).toBe(5);
  });

  it("rejects a bad arg via the input codec (errors-as-doors) through the bound verb", async () => {
    const def = symbol.rosetta`strlen: length of a string`({ input: [z.string], output: [z.number] }, (s) => s.length);
    const verb = await wireRosetta(def);
    // A SchemeExact is not a SchemeString → the z.string codec's instanceof guard doors.
    await expect(verb(new AExact(CONSTANT_CTX, 3n))).rejects.toThrow();
  });

  it("MINTS provenance off ctx.currentInvocation — marks the point + stamps the output", async () => {
    const def = symbol.rosetta`strlen: length of a string`({ input: [z.string], output: [z.number] }, (s) => s.length);
    const verb = await wireRosetta(def);

    const { ctx, marked } = ctxWithInvocation(42);
    // The evaluator appends ctx as the trailing arg for a __withCtx fn — replicate that here.
    const out = (await verb(new AString(CONSTANT_CTX, "hello"), ctx)) as AInexact;

    expect(out).toBeInstanceOf(AInexact);
    expect(out.real).toBe(5);
    // THE MINT: the output carries pointProvenance(42), and the invocation was marked a point.
    expect([...out.provenance]).toEqual([42]);
    expect(marked()).toBe(true);
    expect(ctx.currentInvocation.isProvenancePoint).toBe(true);
  });

  it("DEEP-STAMPS a structured (list) output — every element carries the minted origin", async () => {
    // A rosetta returning a JS array → a scheme list (Pair-chain). The mint must reach every
    // element (spec §5.3: element-only lineage), exactly like createRosettaWrapper's jsToScheme stamp.
    const def = symbol.rosetta`split: chars of a string`(
      { input: [z.string], output: [z.array(z.string)] },
      (s) => [...s],
    );
    const verb = await wireRosetta(def);

    const { ctx } = ctxWithInvocation(7);
    const out = (await verb(new AString(CONSTANT_CTX, "ab"), ctx)) as AValue;
    // Walk the spine: every reachable AValue must carry {7}.
    const seen: number[][] = [];
    const walk = (v: unknown): void => {
      if (v instanceof AValue) {
        seen.push([...v.provenance]);
        const anyV = v as unknown as { car?: unknown; cdr?: unknown };
        if ("car" in anyV) {
          walk(anyV.car);
          walk(anyV.cdr);
        }
      }
    };
    walk(out);
    // At least the spine + leaves were visited, and every visited AValue carries the minted point.
    expect(seen.length).toBeGreaterThan(0);
    for (const p of seen) expect(p).toEqual([7]);
  });

  it("WITHOUT a ctx invocation, forwards the inputs' provenance (mint is ctx-gated, not unconditional)", async () => {
    const def = symbol.rosetta`echo: identity string`({ input: [z.string], output: [z.string] }, (s) => s);
    const verb = await wireRosetta(def);

    // An input string carrying a known origin; no ctx → resultProvenance falls back to the input union.
    const tagged = new AString(CONSTANT_CTX, "x", new Set([99]));
    const out = (await verb(tagged)) as AString;
    expect(out.toJs()).toBe("x");
    expect([...out.provenance]).toEqual([99]); // forwarded, not minted
  });

  it("invocation-`this`: a `function` impl reads run-state lazily off `this` (abortSignal / aborted)", async () => {
    // A ctx-coupled verb declares a `function` impl (NOT an arrow) and reads the run's abort
    // state off the lazy invocation-`this`. The wrapper builds that `this` from the captured ctx.
    type InvThis = { aborted: boolean; abortSignal: AbortSignal | undefined; invocation: unknown };
    const def = symbol.rosetta`probe: report the run's abort state`(
      { input: [z.string], output: [z.string] },
      function (this: InvThis, s: string) {
        // `this.abortSignal` is the ctx's signal; `this.aborted` is its `.aborted` (false here).
        const tag = this.abortSignal ? (this.aborted ? "aborted" : "live") : "no-signal";
        return `${s}:${tag}`;
      },
    );
    const verb = await wireRosetta(def);

    // ctx carrying a (not-yet-aborted) AbortSignal — the shape the evaluator appends.
    const ac = new AbortController();
    const ctx = { env: {}, signal: ac.signal };
    const out = (await verb(new AString(CONSTANT_CTX, "x"), ctx)) as AString;
    expect(out.toJs()).toBe("x:live"); // signal present, not aborted

    // After abort, the SAME getter reads the now-aborted signal (lazy — read on access).
    ac.abort();
    const out2 = (await verb(new AString(CONSTANT_CTX, "y"), ctx)) as AString;
    expect(out2.toJs()).toBe("y:aborted");
  });

  it("invocation-`this`: a pure ARROW impl is unaffected — `this` is ignored, run behavior byte-identical", async () => {
    // The 50+ pure verbs are arrows: they ignore `this` entirely, so `impl.call(invCtx, …)` is
    // exactly `impl(…)`. Proven both WITH a ctx (signal present) and direct-JS (no ctx).
    const def = symbol.rosetta`strlen: length of a string`({ input: [z.string], output: [z.number] }, (s) => s.length);
    const verb = await wireRosetta(def);

    // direct-JS (no ctx → invCtx getters tolerate undefined; the arrow never looks)
    const direct = (await verb(new AString(CONSTANT_CTX, "hello"))) as AInexact;
    expect(direct.real).toBe(5);

    // with a ctx carrying an aborted signal — a pure arrow STILL ignores it (no early-out, same value)
    const ac = new AbortController();
    ac.abort();
    const withCtx = (await verb(new AString(CONSTANT_CTX, "world"), { env: {}, signal: ac.signal })) as AInexact;
    expect(withCtx.real).toBe(5);
  });

  it("pure: true FORWARDS input provenance even WITH a ctx invocation (transform, not source — never mints)", async () => {
    // The contrast to the mint test above: SAME ctx.currentInvocation(42) + SAME tagged input {99},
    // but `pure: true` makes it a TRANSFORM — the output carries the FORWARDED input union {99},
    // NOT pointProvenance(42), and the invocation is NOT marked a point. (Minting here would
    // fabricate a fresh origin — the seal-laundering class of bug `pure` exists to prevent.)
    const def = symbol.rosetta`echo: identity string`(
      { input: [z.string], output: [z.string], pure: true },
      (s) => s,
    );
    const verb = await wireRosetta(def);

    const { ctx, marked } = ctxWithInvocation(42);
    const tagged = new AString(CONSTANT_CTX, "x", new Set([99]));
    const out = (await verb(tagged, ctx)) as AString;
    expect(out.toJs()).toBe("x");
    expect([...out.provenance]).toEqual([99]); // FORWARDED (pure), not minted(42)
    expect(marked()).toBe(false); // a pure rosetta never marks the invocation a point
    expect(ctx.currentInvocation.isProvenancePoint).toBe(false);
  });
});
