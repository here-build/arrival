/**
 * Ejection P3 3b.3 — witness for the ASSEMBLED capability base.
 *
 * `Capabilities.assembled(base)` is the default cut's explicit base (the two-frame
 * `user_env → global_env`). It is ADDITIVE — until the step-5 flip the default exec path
 * is glass, so nothing constructs it but this test. The invariant it pins (and that the
 * hygiene engine relies on at `syntax-rules.ts`: `ref === capabilities.globalRoot`): a name
 * OWNED ANYWHERE in the base chain resolves, through `refFrame`, back to the SAME stable
 * `globalRoot` sentinel. Step 4 repointed that sentinel onto the base TOP (`user_env`) and
 * widened `refFrame` to probe the whole base chain — so a native owned on the base LEAF
 * (`cons` on user_env), which the old `chainRoot.has` probe missed, now resolves too.
 */
import { describe, expect, it } from "vitest";

import { exec } from "../eval/generator-exec.js";
import { user_env, global_env } from "../env-roots.js";
import { Capabilities } from "../eval/Capabilities.js";

describe("Capabilities.assembled (3b.3 — assembled base sentinel)", () => {
  it("refFrame of any base-owned builtin === globalRoot (the stable sentinel)", async () => {
    // Force the runtime bootstrap: native value-domain clusters → global_env, the
    // `.scm` base packs → user_env. Without it the base owns nothing.
    await exec("1", { env: user_env });

    const caps = Capabilities.assembled(user_env);
    // globalRoot is the stable base sentinel — the base TOP (user_env), ONE identity for
    // any base-owned name, surviving the topology cut.
    expect(caps.globalRoot).toBe(user_env);

    // refFrame probes the WHOLE base chain and points every base-owned name back to that
    // single sentinel. A native owned on the base LEAF (`cons` on user_env) — the case the
    // old chainRoot.has probe MISSED — now resolves:
    expect(user_env.has("cons")).toBe(true);
    expect(caps.refFrame("cons")).toBe(caps.globalRoot);

    // …as does a builtin owned on the chain ROOT (global_env):
    const onRoot = global_env.list().find((n): n is string => typeof n === "string");
    expect(onRoot).toBeDefined();
    expect(caps.refFrame(onRoot!)).toBe(caps.globalRoot);

    // An unbound name has no base claim.
    expect(caps.refFrame("definitely-not-a-builtin-xyz-123")).toBeUndefined();
  });
});
