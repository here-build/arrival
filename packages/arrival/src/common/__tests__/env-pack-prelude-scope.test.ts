// env-pack-prelude-scope.test.ts — P0-generic seam for `preludeOnly:` (design doc
// docs/package-specific/arrival-scheme/prelude-only-symbols-and-composable-prompt-2026-07-02.md §1.3).
//
// The KERNEL (`assembleEnv`) stays env-agnostic — it never calls `.inherit()` or knows what a
// scheme "prelude" is. Its ONLY job for this feature is to accept an optional `preludeScope: E`
// (an opaque, caller-constructed scope) and expose it on every pack's `ctx.preludeScope` for the
// duration of assembly. The scheme-aware re-parenting trick (sandboxBase ← preludeOverlay ← R)
// lives in the CALLER (buildArrivalEnv), not here — this file only proves the generic thread.

import { describe, expect, it } from "vitest";

import { assembleEnv, type EnvPack, type PackContext } from "../kernel.js";

interface Stub {
  appliedOrder: string[];
}
const stub = (): Stub => ({ appliedOrder: [] });

describe("assembleEnv — generic preludeScope thread (env-agnostic)", () => {
  it("ctx.preludeScope is undefined when no preludeScope option is passed (no-op default)", async () => {
    const seen: (PackContext["preludeScope"] | "unset")[] = [];
    const a: EnvPack<Stub> = {
      name: "a",
      apply: (_env, ctx) => {
        seen.push(ctx.preludeScope);
      },
    };
    await assembleEnv(stub(), [a]);
    expect(seen).toEqual([undefined]);
  });

  it("threads an opaque caller-supplied preludeScope onto EVERY pack's ctx during assembly", async () => {
    const overlay = { marker: "the-overlay" };
    const seen: unknown[] = [];
    const a: EnvPack<Stub> = { name: "a", apply: (_env, ctx) => void seen.push(ctx.preludeScope) };
    const b: EnvPack<Stub> = { name: "b", deps: [a], apply: (_env, ctx) => void seen.push(ctx.preludeScope) };
    await assembleEnv(stub(), [b], { preludeScope: overlay });
    expect(seen).toEqual([overlay, overlay]);
  });
});
