/**
 * Ejection P3 3b.3 — step 1 witness for the ASSEMBLED capability base.
 *
 * `Capabilities.assembled(base)` is the default cut's explicit base (the two-frame
 * `user_env → global_env`). In step 1 it is ADDITIVE/inert — the default exec path is
 * still glass, so nothing constructs it but this test. The invariant it pins (and that
 * the hygiene engine relies on at `syntax-rules.ts`: `ref === capabilities.globalRoot`):
 * a name OWNED by the base chain root resolves, through `refFrame`, back to the SAME
 * stable `globalRoot` sentinel. Step 4 repoints `globalRoot`/`refFrame` onto the
 * `user_env` sentinel; this test re-runs there unchanged.
 */
import { describe, expect, it } from "vitest";

import { exec } from "../eval/generator-exec";
import { user_env } from "../env-roots";
import { Capabilities } from "../eval/Capabilities";

describe("Capabilities.assembled (3b.3 step 1 — additive, inert under glass)", () => {
  it("refFrame of a base-owned builtin === globalRoot (the stable base sentinel)", async () => {
    // Force the runtime bootstrap: native value-domain clusters → global_env, the
    // `.scm` base packs → user_env. Without it the base root owns nothing.
    await exec("1", { env: user_env });

    const caps = Capabilities.assembled(user_env);
    const root = caps.globalRoot; // the base chain root (global_env)
    expect(root.__parent__).toBeFalsy(); // globalRoot is the parent-less sentinel

    // Any name OWNED by the base root must point back to that same sentinel frame —
    // this is exactly the unshadowed-base-builtin identity hygiene compares against.
    // (Step 1's refFrame probes only the chain root; step 4 widens it to the whole
    // `user_env → global_env` base — at which point a user_env-owned native like `cons`
    // also resolves to this same globalRoot.)
    const owned = root.list().find((n): n is string => typeof n === "string");
    expect(owned).toBeDefined();
    expect(caps.refFrame(owned!)).toBe(caps.globalRoot);
  });
});
