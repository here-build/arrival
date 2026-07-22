// callctx-activation-dispatch.test.ts — Stage 1b (docs/execution.md §CALLCTX): a baked
// native/rosetta/tagless(-guard)/sequence verb's `this.configuration`/`this.resources` now
// ALSO reach it through the `CallCtx` a REAL evaluator dispatch builds, not only through the
// legacy outer-closure/builder-form channel (`common/capability.ts`'s `SymbolsSpec` builder
// arm) `capability.test.ts` already covers.
//
// This is a PARALLEL channel, additive: it proves `common/capability.ts`'s bind loop
// associates a bound proc with its own capability's activation (`associateActivation`,
// `run/CallCtx.ts`), and that `eval/evaluator.ts`'s dispatch sites thread the resolved
// callable VALUE into `makeCallCtx` so the enrichment lands on `this` — exercised through
// REAL scheme source via `exec()` (the actual `evaluatePair` dispatch path), not a synthetic
// direct-apply that would bypass the wiring under test entirely.
import { describe, expect, it } from "vitest";

import { z } from "zod";

import { EnvCapability } from "../capability.js";
import { symbol } from "../symbol.js";
import * as sz from "../scheme-zod.js";
import { port, type Resource } from "../resources.js";
import { exec } from "../../eval/generator-exec.js";
import { freshEnv } from "../../__tests__/_fresh-env.js";
import type { CallCtx } from "../../run/CallCtx.js";
import { makeRunContext } from "../../run/RunContext.js";

interface Shout {
  up(s: string): string;
}
let shoutSpawns = 0;
const shoutResource: Resource<Shout> = {
  kind: "shout",
  acquire: async () => {
    shoutSpawns++;
    return port({ up: (s: string) => s.toUpperCase() }, () => undefined);
  },
};

// A BAKED rosetta verb (the target authoring form — no `ThisType`/builder closure anywhere):
// its impl reads `this.configuration`/`this.resources` off the flat `CallCtx` itself. Before
// Stage 1b this was DEAD on a baked def (the hazards ledger's "baked rosetta `this` is
// CallCtx, not the activation" rule) — Stage 1b makes it live, additively.
const greeter = new EnvCapability("test/greeter-activation", {
  configuration: { tag: z.string() },
  resources: { shout: shoutResource },
  symbols: {
    greet: symbol.rosetta`greet: tag + shout the message, reading this call's activation off CallCtx`(
      { input: [sz.string], output: [sz.string] },
      // 1d: `this.resources.<key>` is read via async `.get()` (lazy per-cell spawn). `this.
      // configuration` stays synchronous (per-assembly, carried on the association).
      async function (this: CallCtx, s: string): Promise<string> {
        const cfg = this.configuration as { tag: string } | undefined;
        const res = this.resources as { shout: { get(): Promise<Shout> } } | undefined;
        if (cfg === undefined || res === undefined) return `NO-ACTIVATION:${s}`;
        return `${cfg.tag}:${(await res.shout.get()).up(s)}`;
      },
    ),
  },
});

describe("CallCtx activation dispatch (Stage 1b)", () => {
  // INVARIANT: a real evaluator dispatch (a scheme call, not a synthetic direct-apply)
  // enriches the CallCtx it builds with the resolved verb's own capability activation, so a
  // baked impl reads `this.configuration.<key>` — the NEW this-channel, not the legacy
  // outer-closure/builder form.
  it("threads a capability's `configuration` onto `this` at real evaluator dispatch", async () => {
    const env = await freshEnv();
    await greeter.lower({ config: { tag: "hi" } }).apply(env, undefined as never);

    const [out] = await exec('(greet "yo")', { env });
    expect(out).toBe("hi:YO");
  });

  // INVARIANT (STAGE 2, docs/execution.md §HERMETIC): `this.resources.<key>.live` is populated
  // from a cell keyed by RunContext, not by ambient/env — reused (single-flight, no re-spawn)
  // across passes that SHARE a RunContext (a REPL's one session, `ExecOptions.runCtx`), fresh
  // for a DIFFERENT one. Two bare `exec()` calls with no runCtx passthrough each mint (and
  // dispose) their OWN RunContext, so they get their OWN spawn — see the sibling `it` below for
  // that per-run-isolation half.
  it("threads a capability's `resources` onto `this` — same cell, same spawn-once lifecycle ACROSS PASSES SHARING ONE RunContext", async () => {
    shoutSpawns = 0;
    const env = await freshEnv();
    await greeter.lower({ config: { tag: "ok" } }).apply(env, undefined as never);

    const runCtx = makeRunContext({});
    const [first] = await exec('(greet "a")', { env, runCtx });
    const [second] = await exec('(greet "b")', { env, runCtx });
    expect(first).toBe("ok:A");
    expect(second).toBe("ok:B");
    expect(shoutSpawns).toBe(1); // single-flight — dispatch reads the SAME cell, no re-spawn
  });

  // INVARIANT (STAGE 2): the per-run isolation half — no shared RunContext means no shared
  // resource. Each bare `exec()` call here mints (and disposes) its own RunContext, so the
  // capability's `shout` resource spawns independently for each.
  it("gives a FRESH resource per RunContext when passes don't share one", async () => {
    shoutSpawns = 0;
    const env = await freshEnv();
    await greeter.lower({ config: { tag: "solo" } }).apply(env, undefined as never);

    const [first] = await exec('(greet "a")', { env });
    const [second] = await exec('(greet "b")', { env });
    expect(first).toBe("solo:A");
    expect(second).toBe("solo:B");
    expect(shoutSpawns).toBe(2); // two independent RunContexts ⇒ two independent spawns
  });

  // INVARIANT: additive — a callable with NO associated activation (e.g. a base-pack native
  // with no capability config/resources) dispatches exactly as before; `this.configuration`/
  // `this.resources` are simply absent, never a crash or a stub value.
  it("is additive: a callable with no associated activation dispatches unaffected", async () => {
    const env = await freshEnv();
    const [out] = await exec('(string-length "hello")', { env });
    expect(out).toBe(5);
  });
});
