/**
 * Ejection P3 3b.3 — witness for the ASSEMBLED capability base.
 *
 * `Capabilities.assembled(base)` is the default cut's explicit base (the two-frame
 * `user_env → global_env`). The invariant it pins (and that the hygiene engine relies on
 * at `syntax-rules.ts`: `ref === capabilities.globalRoot`): a name OWNED ANYWHERE in the
 * base chain resolves, through `refFrame`, back to the SAME stable `globalRoot` sentinel.
 * Step 4 repointed that sentinel onto the base TOP (`user_env`) and widened `refFrame` to
 * probe the whole base chain — so a native owned on the base LEAF (`cons` on user_env),
 * which the old `chainRoot.has` probe missed, now resolves too.
 *
 * ENV T3 RESTATEMENT (environment-resolution-chain.md §2 "hygiene sentinel", Frame/
 * BakedBase type split, LANDED): the sentinel is no longer the base-leaf ENV — it is the
 * sealed `CompiledResolutionChain` (BakedBase) itself, `sealResolutionChain(user_env)`'s
 * ONE memoized artifact for this base. The uniqueness guarantee this test pins is
 * UNCHANGED (one identity per baked base — every base-owned name's `refFrame` resolves to
 * the SAME `globalRoot`); only the sentinel's own identity moved from "the base's top env"
 * to "the base's sealed chain artifact" — strictly stronger (no structural chain-walk
 * needed to recover it; content-addressable per design §1).
 */
import { describe, expect, it } from "vitest";

import { exec } from "../eval/generator-exec.js";
import { user_env, global_env } from "../env-roots.js";
import { Capabilities } from "../eval/Capabilities.js";
import { sealResolutionChain } from "../eval/CompiledResolutionChain.js";

describe("Capabilities.assembled (3b.3 — assembled base sentinel)", () => {
  it("refFrame of any base-owned builtin === globalRoot (the stable sentinel)", async () => {
    // Force the runtime bootstrap: native value-domain clusters → global_env, the
    // `.scm` base packs → user_env. Without it the base owns nothing.
    await exec("1", { env: user_env });

    const caps = Capabilities.assembled(user_env);
    // globalRoot is the stable base sentinel — ENV T3: the SEALED CHAIN artifact
    // (BakedBase), not the raw base-leaf env. `sealResolutionChain` is memoized per base,
    // so this is the SAME object `Capabilities.assembled` sealed internally.
    expect(caps.globalRoot).toBe(sealResolutionChain(user_env));

    // refFrame probes the WHOLE base chain and points every base-owned name back to that
    // single sentinel. A native owned on the base LEAF (`cons` on user_env) — the case the
    // old chainRoot.has probe MISSED — now resolves too:
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
