// EnvCapability — prove `this.configuration` / `this.resources` infer AND run.
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { EnvCapability } from "../capability.js";
import { port, type Resource } from "../resources.js";
import { ResolvingAmbient, mintResolvingFrame } from "../../env/AmbientRuntime.js";
import { schemeToJsUntyped } from "../../membrane/rosetta.js";
import { testCallCtx, type CallCtx } from "../../run/CallCtx.js";

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
// NOTE (B4 audit, 2026-07-09; updated 2026-07-22 — SymbolDeclaration collapse):
// `symbols.describe` below is deliberately the legacy `{ fn }` RECORD (capability.ts's
// `isSymbolSpec`/`bindRosetta` arm) — the one path that binds `fn`'s `this` to the per-env
// `Activation` (config + resources), which is exactly what this suite proves. Not stale
// debt: this arm is confirmed load-bearing (McpEnvCapability's whole authoring model + the
// here.build discovery servers) and retires only with the postponed MCP rework. What DID
// retire (2026-07-22) is the bare-METHOD shorthand this fixture used to author — the
// `| Fn` union arm and its `ThisType<Activation>` inference channel are gone, so `fn`
// annotates its `this` explicitly now. `capability.ts` wires this arm through the internal
// `bindRosetta` (AmbientRuntime.ts) → `createRosettaWrapper`, so `verbs.describe` below is
// the real rosetta-wrapped procedure (a scheme-calling-convention async fn expecting a
// `CallCtx` receiver), not the raw activation-bound fn — see `recordingEnv`'s doc and the
// `invoke` helper.
const net = new EnvCapability("net", {
  configuration: { context: z.enum(["browser", "node", "bun"]), retries: z.number().default(3) },
  resources: { sock: echoResource },
  symbols: {
    describe: {
      // SYNC in resource access: the env accessor pre-spawned `sock` before this ran.
      fn(
        this: {
          configuration: { context: "browser" | "node" | "bun"; retries: number };
          resources: { sock: { live: Echo } };
        },
        msg: string,
      ) {
        const ctx: "browser" | "node" | "bun" = this.configuration.context;
        const retries: number = this.configuration.retries;
        const sock = this.resources.sock.live; // Echo, SYNC (pre-spawned)
        return `${ctx}/${retries}:${sock.echo(msg)}`;
      },
    },
  },
});

/** A REAL recording env (hermetic-Environment ruling: capability apply narrows to the
 *  concrete `AmbientRuntime` — a synthetic `{ set }` mock can no longer receive bindings).
 *  `verbs[name]` reads the frame's own storage record and is still the REAL
 *  rosetta-wrapped procedure (`createRosettaWrapper`'s output) — a scheme-calling-convention
 *  async fn expecting a `CallCtx` receiver — not the raw activation-bound `sym.fn`; see
 *  `invoke` below for the calling idiom. The Proxy keeps this suite's `verbs.describe`
 *  property-read idiom; the fn-shape cast is the same boundary narrow the old recorder did. */
function recordingEnv(): { env: ResolvingAmbient; verbs: Record<string, (this: CallCtx, ...a: unknown[]) => unknown> } {
  const env = mintResolvingFrame("capability-recording", {}, null);
  const verbs = new Proxy({} as Record<string, (this: CallCtx, ...a: unknown[]) => unknown>, {
    get: (_t, name) => env.__env__[name as string],
  });
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
    const cap = EnvCapability.define("p", { prelude: "(define x 1)", symbols: () => ({}) });
    const evalScheme = vi.fn(async () => undefined);
    const { env } = recordingEnv();
    await cap.lower({ evalScheme }).apply(env, undefined as never);
    expect(evalScheme).toHaveBeenCalledWith(env, "(define x 1)");
    await expect(cap.lower({}).apply(env, undefined as never)).rejects.toThrow("no evalScheme");
  });
});
