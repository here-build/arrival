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
import { CONSTANT_CTX, makeRunContext, type RunContext } from "../../values/primitives/RunContext.js";

import { EnvCapability } from "../capability.js";
import { symbol, type RosettaSymbolDef } from "../symbol.js";
import * as z from "../scheme-zod.js";
import type { SchemeEnv } from "../scheme-env.js";
import { AString } from "../../values/primitives/AString.js";
import { AExact } from "../../values/primitives/AExact.js";
import { AInexact } from "../../values/primitives/AInexact.js";
import { AValue } from "../../values/primitives/AValue.js";
import { CallCtx, makeCallCtx } from "../symbols/_bake.js";
import type { InvocationLike } from "../../rosetta.js";

type WithCtxFn<Args extends [...unknown[]] = [...unknown[]], Result extends unknown = unknown> = (this: CallCtx, ...args: Args) => Result;

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

/** A synthetic invocation carrying a provenance-point marker (the shape the wrapper reads
 *  off `this.invocation.currentInvocation`). */
function invocationWithId(id: number): { invocation: InvocationLike; marked: () => boolean } {
  let didMark = false;
  const invocation: InvocationLike = {
    id,
    isProvenancePoint: false,
    markProvenancePoint() {
      didMark = true;
      this.isProvenancePoint = true;
    },
  };
  return { invocation, marked: () => didMark };
}

async function wireRosetta(def: RosettaSymbolDef): Promise<WithCtxFn> {
  const cap = new EnvCapability("test/rosetta", { symbols: { verb: def } });
  const { env, verbs } = recordingEnv();
  await cap.lower({}).apply(env, undefined as never);
  return verbs.verb;
}

/** Invoke a bound verb the way the REAL evaluator does: `this = CallCtx` (bare-fn dispatch is
 *  `Reflect.apply(fn, makeCallCtx(runCtx, currentInvocation), args)`), never a trailing ctx
 *  ARGUMENT — the wrapper reads `this.runCtx`/`this.invocation` directly. A bare `verb(...)`
 *  call (this test file's old convention) leaves `this` undefined and throws before even
 *  checking whether a ctx was intended. */
function invoke(
  verb: WithCtxFn,
  opts: { runCtx?: RunContext; currentInvocation?: InvocationLike } | undefined,
  ...args: unknown[]
): unknown {
  return verb.call(makeCallCtx(opts?.runCtx, opts?.currentInvocation), ...(args as never[]));
}

describe("EnvCapability.lower() — the rosetta SymbolDef arm", () => {
  it("decodes scheme→JS, runs impl, encodes JS→scheme through the bound verb", async () => {
    const def = symbol.rosetta`strlen: length of a string`({ input: [z.string], output: [z.number] }, (s) => s.length);
    const verb = await wireRosetta(def);
    // No ctx (a direct/test call) — proves the codec membrane in isolation.
    const out = await invoke(verb, undefined, new AString(CONSTANT_CTX, "hello"));
    expect(out).toBeInstanceOf(AInexact); // z.number encode → inexact
    expect((out as AInexact).real).toBe(5);
  });

  it("rejects a bad arg via the input codec (errors-as-doors) through the bound verb", async () => {
    const def = symbol.rosetta`strlen: length of a string`({ input: [z.string], output: [z.number] }, (s) => s.length);
    const verb = await wireRosetta(def);
    // A SchemeExact is not a SchemeString → the z.string codec's instanceof guard doors.
    await expect(invoke(verb, undefined, new AExact(CONSTANT_CTX, 3n))).rejects.toThrow();
  });

  it("MINTS provenance off ctx.currentInvocation — marks the point + stamps the output", async () => {
    const def = symbol.rosetta`strlen: length of a string`({ input: [z.string], output: [z.number] }, (s) => s.length);
    const verb = await wireRosetta(def);

    const { invocation, marked } = invocationWithId(42);
    const out = (await invoke(verb, { currentInvocation: invocation }, new AString(CONSTANT_CTX, "hello"))) as AInexact;

    expect(out).toBeInstanceOf(AInexact);
    expect(out.real).toBe(5);
    // THE MINT: the output carries pointProvenance(42), and the invocation was marked a point.
    expect([...out.provenance]).toEqual([42]);
    expect(marked()).toBe(true);
    expect(invocation.isProvenancePoint).toBe(true);
  });

  it("DEEP-STAMPS a structured (list) output — every element carries the minted origin", async () => {
    // A rosetta returning a JS array → a scheme list (Pair-chain). The mint must reach every
    // element (spec §5.3: element-only lineage), exactly like createRosettaWrapper's jsToScheme stamp.
    const def = symbol.rosetta`split: chars of a string`(
      { input: [z.string], output: [z.array(z.string)] },
      (s) => [...s],
    );
    const verb = await wireRosetta(def);

    const { invocation } = invocationWithId(7);
    const out = (await invoke(verb, { currentInvocation: invocation }, new AString(CONSTANT_CTX, "ab"))) as AValue;
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
    const out = (await invoke(verb, undefined, tagged)) as AString;
    expect(out["arrival/toJS"]()).toBe("x");
    expect([...out.provenance]).toEqual([99]); // forwarded, not minted
  });

  it("invocation-`this`: a `function` impl reads run-state off `this.runCtx` (signal / aborted)", async () => {
    // A ctx-coupled verb declares a `function` impl (NOT an arrow) and reads the run's abort
    // state off the flat `CallCtx` `this`. The wrapper forwards that `this` as-is.
    const def = symbol.rosetta`probe: report the run's abort state`(
      { input: [z.string], output: [z.string] },
      function (this: CallCtx, s: string) {
        // `this.runCtx.signal` is the run's signal; `.aborted` is its own `.aborted` (false here).
        const tag = this.runCtx.signal ? (this.runCtx.signal.aborted ? "aborted" : "live") : "no-signal";
        return `${s}:${tag}`;
      },
    );
    const verb = await wireRosetta(def);

    // runCtx carrying a (not-yet-aborted) AbortSignal — the shape a real exec() mints.
    const ac = new AbortController();
    const runCtx = makeRunContext({ signal: ac.signal });
    const out = (await invoke(verb, { runCtx }, new AString(CONSTANT_CTX, "x"))) as AString;
    expect(out["arrival/toJS"]()).toBe("x:live"); // signal present, not aborted

    // After abort, the SAME signal reference reads as aborted (read on access).
    ac.abort();
    const out2 = (await invoke(verb, { runCtx }, new AString(CONSTANT_CTX, "y"))) as AString;
    expect(out2["arrival/toJS"]()).toBe("y:aborted");
  });

  it("invocation-`this`: a pure ARROW impl is unaffected — `this` is ignored, run behavior byte-identical", async () => {
    // The 50+ pure verbs are arrows: they ignore `this` entirely, so `impl.call(this, …)` is
    // exactly `impl(…)`. Proven both WITH a runCtx (signal present) and direct-JS (no ctx).
    const def = symbol.rosetta`strlen: length of a string`({ input: [z.string], output: [z.number] }, (s) => s.length);
    const verb = await wireRosetta(def);

    // direct-JS (no ctx → CallCtx defaults to CONSTANT_CTX; the arrow never looks)
    const direct = (await invoke(verb, undefined, new AString(CONSTANT_CTX, "hello"))) as AInexact;
    expect(direct.real).toBe(5);

    // with a runCtx carrying an aborted signal — a pure arrow STILL ignores it (no early-out, same value)
    const ac = new AbortController();
    ac.abort();
    const withCtx = (await invoke(
      verb,
      { runCtx: makeRunContext({ signal: ac.signal }) },
      new AString(CONSTANT_CTX, "world"),
    )) as AInexact;
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

    const { invocation, marked } = invocationWithId(42);
    const tagged = new AString(CONSTANT_CTX, "x", new Set([99]));
    const out = (await invoke(verb, { currentInvocation: invocation }, tagged)) as AString;
    expect(out["arrival/toJS"]()).toBe("x");
    expect([...out.provenance]).toEqual([99]); // FORWARDED (pure), not minted(42)
    expect(marked()).toBe(false); // a pure rosetta never marks the invocation a point
    expect(invocation.isProvenancePoint).toBe(false);
  });
});
