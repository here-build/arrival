/**
 * Host-language non-existence guard.
 *
 * The host-language verbs a block list once fenced (eval / load / set-obj! / …)
 * no longer exist at all — the host-language sweep deleted them at the source —
 * so this suite pins their NON-EXISTENCE rather than a filter's coverage. A
 * regression re-introducing any of them turns these red.
 *
 * (Was "sandbox unification": it also locked `createSandbox`/`PURE_SCHEME_BINDINGS`
 * to the `inferenceEnv` surface. That dual-path projection apparatus is gone —
 * there is ONE construction path now — so only the verbs-unbound half remains.)
 */

import { describe, expect, it, beforeAll } from "vitest";
import { initBridge } from "../index.js";
import { inferenceEnv } from "../inference-env.js";

// The host-language verbs the sweep deleted at the source. The old
// FORBIDDEN_IN_SANDBOX block list fenced them per-env; now they simply do not
// exist anywhere, which is what this suite pins — a regression re-introducing
// any of them turns these red.
const HOST_LANGUAGE_VERBS = ["eval", "load", "set-obj!", "set-special!", "new", "instanceof"] as const;

beforeAll(async () => {
  await initBridge();
  await import("../index.js");
});

describe("host-language verbs are non-existent", () => {
  // INVARIANT: every host-language verb (eval/load/set-obj!/set-special!/new/instanceof) is genuinely Unbound in the inference env
  it("every host-language verb is genuinely Unbound in the inference env", () => {
    for (const verb of HOST_LANGUAGE_VERBS) {
      const value = inferenceEnv.get(verb, { throwError: false });
      expect(value, `'${verb}' must NOT be bound`).toBeUndefined();
    }
  });

  // INVARIANT: no host-language verb appears as a key on the env's own surface (pins implementation, not behavior)
  it("no host-language verb appears in the env's own surface", () => {
    const names = new Set(Object.keys(inferenceEnv.__env__));
    for (const verb of HOST_LANGUAGE_VERBS) {
      expect(names.has(verb), `'${verb}' must not appear in the surface`).toBe(false);
    }
  });
});
