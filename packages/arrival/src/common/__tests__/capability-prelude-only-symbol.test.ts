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
import { ANativeProcedure, ARosettaProcedure } from "../../values/primitives/ACallable.js";
import type { PackContext } from "../kernel.js";
import { symbol } from "../symbol.js";
import * as z from "../scheme-zod.js";
import type { SchemeEnv } from "../scheme-env.js";
import type { PreludeBindTarget } from "../kernel.js";
import { ResolvingEnvironment } from "../../Environment.js";
import { AString } from "../../values/primitives/AString.js";
import { CallCtx } from "../symbols/_bake.js";

type WithCtxFn<Args extends [...unknown[]] = [...unknown[]], Result extends unknown = unknown> = (
  this: CallCtx,
  ...args: Args
) => Result;

/** A REAL recording runtime env (hermetic-Environment ruling: capability apply narrows to
 *  the concrete `Environment`; the JS-side write surface is retired). `verbs` is a read
 *  facade over the frame's own storage record, tagged so a test can tell WHICH scope a
 *  verb landed in (the runtime env vs. the prelude overlay). */
function recordingEnv(tag: string): { env: ResolvingEnvironment; verbs: Record<string, unknown>; tag: string } {
  const env = new ResolvingEnvironment(`prelude-only-${tag}`, {}, null);
  const verbs = new Proxy({} as Record<string, unknown>, { get: (_t, name) => env.__env__[name as string] });
  return { env, verbs, tag };
}

/** The OVERLAY is deliberately still a synthetic `{ set }` recorder — `PreludeBindTarget`
 *  is the kernel's Map-shim shape (the `.set`-only bind face), NOT an env; the hermetic
 *  cut removed `set` from envs, not from the shim contract. */
function recordingOverlay(): { overlay: PreludeBindTarget; verbs: Record<string, unknown> } {
  const verbs: Record<string, unknown> = {};
  return { overlay: { set: (name, value) => void (verbs[name] = value) }, verbs };
}

describe("EnvCapability.lower().apply() — routing preludeOnly symbols onto ctx.preludeScope", () => {
  // INVARIANT: a preludeOnly rosetta binds onto ctx.preludeScope, not onto the runtime env.
  it("a preludeOnly rosetta binds onto ctx.preludeScope, NOT onto the runtime env", async () => {
    const def = symbol.rosetta`prelude-only/verb: only visible while a prelude evaluates`(
      { input: [z.string], output: [z.string], preludeOnly: true },
      (s) => s,
    );
    const cap = new EnvCapability("test/prelude-only", { symbols: { "prelude-only/verb": def } });
    const { env: runtimeEnv, verbs: runtimeVerbs } = recordingEnv("runtime");
    const { overlay, verbs: overlayVerbs } = recordingOverlay();
    const ctx: PackContext<SchemeEnv> = { onDispose: () => undefined, order: [], preludeScope: overlay };

    await cap.lower({}).apply(runtimeEnv, ctx);

    expect(runtimeVerbs["prelude-only/verb"]).toBeUndefined(); // NOT on the runtime env
    const bound = overlayVerbs["prelude-only/verb"];
    expect(bound).toBeInstanceOf(ARosettaProcedure); // binder-cut bind shape (§9 option (c)); // IS on the overlay, same bind form (a real callable)
  });

  // INVARIANT: an ordinary (non-preludeOnly) rosetta binds onto the runtime env, unaffected by preludeOnly wiring.
  it("an ORDINARY (non-preludeOnly) rosetta binds onto the runtime env as before — no regression", async () => {
    const def = symbol.rosetta`ordinary/verb: a normal runtime verb`(
      { input: [z.string], output: [z.string] },
      (s) => s,
    );
    const cap = new EnvCapability("test/ordinary", { symbols: { "ordinary/verb": def } });
    const { env: runtimeEnv, verbs: runtimeVerbs } = recordingEnv("runtime");
    const { overlay, verbs: overlayVerbs } = recordingOverlay();
    const ctx: PackContext<SchemeEnv> = { onDispose: () => undefined, order: [], preludeScope: overlay };

    await cap.lower({}).apply(runtimeEnv, ctx);

    expect(runtimeVerbs["ordinary/verb"]).toBeInstanceOf(ARosettaProcedure); // binder-cut bind shape
    expect(overlayVerbs["ordinary/verb"]).toBeUndefined();
  });

  // INVARIANT: a preludeOnly symbol with no ctx.preludeScope present falls back to binding on env (no silent drop).
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

    expect(runtimeVerbs["prelude-only/no-overlay"]).toBeInstanceOf(ARosettaProcedure); // binder-cut bind shape
  });

  // INVARIANT: a preludeOnly native symbol also routes onto ctx.preludeScope, kind-agnostic (native and
  // rosetta share the routing rule).
  it("a preludeOnly NATIVE symbol also routes onto ctx.preludeScope (kind-agnostic)", async () => {
    const def = symbol.native`prelude-only/native-verb: native prelude-only op`(
      { input: [z.string], output: [z.string], preludeOnly: true },
      (s) => s,
    );
    const cap = new EnvCapability("test/prelude-only-native", { symbols: { "prelude-only/native-verb": def } });
    const { env: runtimeEnv, verbs: runtimeVerbs } = recordingEnv("runtime");
    const { overlay, verbs: overlayVerbs } = recordingOverlay();
    const ctx: PackContext<SchemeEnv> = { onDispose: () => undefined, order: [], preludeScope: overlay };

    await cap.lower({}).apply(runtimeEnv, ctx);

    expect(runtimeVerbs["prelude-only/native-verb"]).toBeUndefined();
    // A native binds as a first-class ANativeProcedure (callable-as-value) now, not a bare fn —
    // still routed onto the overlay preludeScope, the invariant this test pins.
    expect(overlayVerbs["prelude-only/native-verb"]).toBeInstanceOf(ANativeProcedure);
  });
});
