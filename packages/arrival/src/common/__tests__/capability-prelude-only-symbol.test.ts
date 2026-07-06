// capability-prelude-only-symbol.test.ts — EnvCapability.lower().apply() routes a
// `preludeOnly` SymbolDef onto `ctx.preludeScope` instead of `env`, using the SAME bind
// form (native → `env.set(verb, impl)`; rosetta → `env.set(verb, gatedRun)`), just a
// different target scope. Design doc §1.3/§4 step 3.
//
// This is the CAPABILITY-LEVEL unit proof (isolated — no real Environment/inherit chain,
// no assembleEnv): a bare EnvCapability with one preludeOnly rosetta whose bind target we can
// distinguish because `ctx.preludeScope` is a SEPARATE recording env from the runtime env.

import { describe, expect, it } from "vitest";

import { EnvCapability } from "../capability.js";
import { ANativeProcedure } from "../../values/primitives/ACallable.js";
import type { PackContext } from "../kernel.js";
import { symbol } from "../symbol.js";
import * as z from "../scheme-zod.js";
import type { SchemeEnv } from "../scheme-env.js";
import { AString } from "../../values/primitives/AString.js";
import { ImplInvocationCtx } from "../symbols/_bake.js";

type WithCtxFn<Args extends [...unknown[]] = [...unknown[]], Result extends unknown = unknown> = (
  this: ImplInvocationCtx,
  ...args: Args
) => Result;

/** A SchemeEnv that records every `set` binding, tagged so a test can tell WHICH scope a
 *  verb landed in (the runtime env vs. the prelude overlay). */
function recordingEnv(tag: string): { env: SchemeEnv; verbs: Record<string, unknown>; tag: string } {
  const verbs: Record<string, unknown> = {};
  const env = {
    set: (name: string, value: unknown) => void (verbs[name] = value),
    get: (name: string) => verbs[name],
    defineRosetta: () => undefined,
    inherit: () => env,
    registerResolver: () => undefined,
    list: () => Object.keys(verbs),
    allBoundNames: () => Object.keys(verbs),
  } as unknown as SchemeEnv;
  return { env, verbs, tag };
}

describe("EnvCapability.lower().apply() — routing preludeOnly symbols onto ctx.preludeScope", () => {
  it("a preludeOnly rosetta binds onto ctx.preludeScope, NOT onto the runtime env", async () => {
    const def = symbol.rosetta`prelude-only/verb: only visible while a prelude evaluates`(
      { input: [z.string], output: [z.string], preludeOnly: true },
      (s) => s,
    );
    const cap = new EnvCapability("test/prelude-only", { symbols: { "prelude-only/verb": def } });
    const { env: runtimeEnv, verbs: runtimeVerbs } = recordingEnv("runtime");
    const { env: overlay, verbs: overlayVerbs } = recordingEnv("overlay");
    const ctx: PackContext<SchemeEnv> = { onDispose: () => undefined, order: [], preludeScope: overlay };

    await cap.lower({}).apply(runtimeEnv, ctx);

    expect(runtimeVerbs["prelude-only/verb"]).toBeUndefined(); // NOT on the runtime env
    const bound = overlayVerbs["prelude-only/verb"] as WithCtxFn;
    expect(typeof bound).toBe("function"); // IS on the overlay, same bind form (a real callable)
  });

  it("an ORDINARY (non-preludeOnly) rosetta binds onto the runtime env as before — no regression", async () => {
    const def = symbol.rosetta`ordinary/verb: a normal runtime verb`(
      { input: [z.string], output: [z.string] },
      (s) => s,
    );
    const cap = new EnvCapability("test/ordinary", { symbols: { "ordinary/verb": def } });
    const { env: runtimeEnv, verbs: runtimeVerbs } = recordingEnv("runtime");
    const { env: overlay, verbs: overlayVerbs } = recordingEnv("overlay");
    const ctx: PackContext<SchemeEnv> = { onDispose: () => undefined, order: [], preludeScope: overlay };

    await cap.lower({}).apply(runtimeEnv, ctx);

    expect(typeof runtimeVerbs["ordinary/verb"]).toBe("function");
    expect(overlayVerbs["ordinary/verb"]).toBeUndefined();
  });

  it("a preludeOnly symbol with NO ctx.preludeScope present falls back to binding on env (no silent drop)", async () => {
    // If a capability declares preludeOnly but is applied OUTSIDE an assembly that wires an
    // overlay (e.g. a bare direct apply in a test/tool), the symbol must still land somewhere
    // observable rather than vanishing — bind onto env is the documented fallback.
    const def = symbol.rosetta`prelude-only/no-overlay: fallback when no overlay is wired`(
      { input: [z.string], output: [z.string], preludeOnly: true },
      (s) => s,
    );
    const cap = new EnvCapability("test/prelude-only-no-overlay", { symbols: { "prelude-only/no-overlay": def } });
    const { env: runtimeEnv, verbs: runtimeVerbs } = recordingEnv("runtime");

    await cap.lower({}).apply(runtimeEnv, { onDispose: () => undefined, order: [] });

    expect(typeof runtimeVerbs["prelude-only/no-overlay"]).toBe("function");
  });

  it("a preludeOnly NATIVE symbol also routes onto ctx.preludeScope (kind-agnostic)", async () => {
    const def = symbol.native`prelude-only/native-verb: native prelude-only op`(
      { input: [z.string], output: [z.string], preludeOnly: true },
      (s) => s,
    );
    const cap = new EnvCapability("test/prelude-only-native", { symbols: { "prelude-only/native-verb": def } });
    const { env: runtimeEnv, verbs: runtimeVerbs } = recordingEnv("runtime");
    const { env: overlay, verbs: overlayVerbs } = recordingEnv("overlay");
    const ctx: PackContext<SchemeEnv> = { onDispose: () => undefined, order: [], preludeScope: overlay };

    await cap.lower({}).apply(runtimeEnv, ctx);

    expect(runtimeVerbs["prelude-only/native-verb"]).toBeUndefined();
    // A native binds as a first-class ANativeProcedure (callable-as-value) now, not a bare fn —
    // still routed onto the overlay preludeScope, the invariant this test pins.
    expect(overlayVerbs["prelude-only/native-verb"]).toBeInstanceOf(ANativeProcedure);
  });
});
