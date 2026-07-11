// EnvCapability — prove `this.configuration` / `this.resources` infer AND run.
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { EnvCapability } from "../capability.js";
import { port, type Resource } from "../resources.js";
import type { SchemeEnv } from "../scheme-env.js";
import { schemeToJsUntyped } from "../../rosetta.js";
import { testCallCtx, type CallCtx } from "../../values/primitives/CallCtx.js";

interface Echo {
  echo(s: string): string;
}
let echoSpawns = 0;
let echoReleases = 0;
const echoResource: Resource<Echo> = {
  kind: "echo",
  acquire: async () => {
    echoSpawns++;
    return port({ echo: (s: string) => `[${s}]` }, () => void echoReleases++);
  },
};

// THE inline declaration: no annotation on `this` anywhere below.
// NOTE (B4 audit, 2026-07-09; updated 2026-07-11 — defineRosetta hard-delete):
// `symbols.describe` below is deliberately a BARE method (the legacy `SymbolDeclaration`
// authoring shape, capability.ts's `isSymbolSpec`/`bindRosetta` arm) — it's the only path
// today that binds `this` to the per-env `Activation` (config + resources), which is
// exactly what this suite proves. Not stale debt: this arm is confirmed load-bearing
// (McpEnvCapability's whole authoring model + every live downstream consumer) and is NOT
// scheduled to retire by the reverse-membrane migration (B1-B3) — see the ledger's
// "defineRosetta legacy arm authoring form" row (gate: McpEnvCapability annotation-lifting).
// What DID retire (2026-07-11) is the public `Environment.defineRosetta` method itself —
// `capability.ts` now wires this arm through the internal `bindRosetta` (Environment.ts),
// which still runs every bound verb through `createRosettaWrapper` exactly as before, so
// `verbs.describe` below is the real rosetta-wrapped procedure (a scheme-calling-convention
// async fn expecting a `CallCtx` receiver), not the raw activation-bound method — see
// `recordingEnv`'s doc and the `invoke` helper.
const net = new EnvCapability("net", {
  configuration: { context: z.enum(["browser", "node", "bun"]), retries: z.number().default(3) },
  resources: { sock: echoResource },
  symbols: {
    // SYNC in resource access: the env accessor pre-spawned `sock` before this ran.
    describe(msg: string) {
      // INFERENCE PROOF: these would not type-check if ThisType/zod weren't wired.
      const ctx: "browser" | "node" | "bun" = this.configuration.context;
      const retries: number = this.configuration.retries;
      const sock = this.resources.sock.live; // Echo, inferred, SYNC (pre-spawned)
      return `${ctx}/${retries}:${sock.echo(msg)}`;
    },
  },
});

/** A minimal SchemeEnv that records every `set` binding — the legacy arm's landing door
 *  now that `bindRosetta` (Environment.ts) wires it via `env.set(name, wrapper)` rather
 *  than a per-env-overridable `defineRosetta` method. `verbs[name]` is therefore the REAL
 *  rosetta-wrapped procedure (`createRosettaWrapper`'s output) — a scheme-calling-convention
 *  async fn expecting a `CallCtx` receiver — not the raw activation-bound `sym.fn`; see
 *  `invoke` below for the calling idiom. The scope-shaping verbs (registerResolver / list /
 *  allBoundNames) are not exercised by these tests, so they throw LOUD rather than silently
 *  mis-record — mirroring `captureSymbols`'s recorder. */
function recordingEnv(): { env: SchemeEnv; verbs: Record<string, (this: CallCtx, ...a: unknown[]) => unknown> } {
  const verbs: Record<string, (this: CallCtx, ...a: unknown[]) => unknown> = {};
  const unrecordable = (verb: string) => new Error(`recordingEnv: ${verb} is not recordable`);
  const env: SchemeEnv = {
    set: (name, value) => void (verbs[name] = value as (this: CallCtx, ...a: unknown[]) => unknown),
    get: () => undefined,
    inherit: () => env,
    registerResolver: () => {
      throw unrecordable("registerResolver");
    },
    list: () => {
      throw unrecordable("list");
    },
    allBoundNames: () => {
      throw unrecordable("allBoundNames");
    },
  };
  return { env, verbs };
}

/** Invoke a recorded verb the way the real evaluator does post-bind: through a `CallCtx`
 *  receiver, with the rosetta-wrapped result unwrapped back to a plain JS value
 *  (`createRosettaWrapper` boxes the return via `jsToScheme` — see rosetta.ts). Args here
 *  are plain JS scalars, which cross the membrane unchanged (schemeToJs's bare-scalar
 *  passthrough), so no `jsToScheme` wrap is needed on the way in. */
async function invoke(verb: (this: CallCtx, ...a: unknown[]) => unknown, ...args: unknown[]): Promise<unknown> {
  return schemeToJsUntyped(await verb.call(testCallCtx(), ...args));
}

describe("EnvCapability", () => {
  // INVARIANT: resources are pre-spawned lazily — wiring a method does not spawn; first touch does.
  // INVARIANT: a resource is spawned only once across repeated touches (single-flight cache).
  it("pre-spawns resources on first symbol touch; methods read .live synchronously", async () => {
    echoSpawns = 0;
    const { env, verbs } = recordingEnv();
    await net.lower({ config: { context: "node" } }).apply(env, undefined as never);
    expect(echoSpawns).toBe(0); // lazy: wiring the method did NOT spawn

    expect(await invoke(verbs.describe, "hi")).toBe("node/3:[hi]"); // first touch → spawn → .live works
    expect(echoSpawns).toBe(1);

    expect(await invoke(verbs.describe, "yo")).toBe("node/3:[yo]"); // second touch → single-flight, no re-spawn
    expect(echoSpawns).toBe(1);
  });

  // INVARIANT: windDown() releases live resources while keeping the verb wiring intact.
  // INVARIANT: a touch after windDown() re-spawns the resource on demand (pause, not destroy).
  // INVARIANT: resume() after windDown+re-touch is idempotent against an already-live resource cell.
  it("wind-down releases resources; resume re-spawns (pause, not destroy)", async () => {
    echoSpawns = 0;
    echoReleases = 0;
    const { env, verbs } = recordingEnv();
    const pack = net.lower({ config: { context: "node" } });
    await pack.apply(env, undefined as never);

    await invoke(verbs.describe, "a"); // first touch → spawn
    expect(echoSpawns).toBe(1);
    expect(echoReleases).toBe(0);

    await pack.windDown(); // pause → release, keep wiring
    expect(echoReleases).toBe(1);

    await invoke(verbs.describe, "b"); // touch after pause → re-spawn (on-demand resume)
    expect(echoSpawns).toBe(2);
    expect(await invoke(verbs.describe, "b")).toBe("node/3:[b]");

    await pack.resume(); // eager re-acquire is idempotent vs. the live cell
    expect(echoSpawns).toBe(2); // already live → no extra spawn
  });

  // INVARIANT: lower() validates capability config through zod, throwing on an invalid enum value.
  it("validates config through zod at lower() — bad enum throws", () => {
    expect(() => net.lower({ config: { context: "deno" as never } })).toThrow();
  });

  // INVARIANT: a method-less prelude-only capability requires an evalScheme function, rejecting with
  // "no evalScheme" when absent.
  it("a method-less, prelude capability needs evalScheme", async () => {
    const cap = new EnvCapability("p", { prelude: "(define x 1)" });
    const evalScheme = vi.fn(async () => undefined);
    const { env } = recordingEnv();
    await cap.lower({ evalScheme }).apply(env, undefined as never);
    expect(evalScheme).toHaveBeenCalledWith(env, "(define x 1)");
    await expect(cap.lower({}).apply(env, undefined as never)).rejects.toThrow("no evalScheme");
  });
});
