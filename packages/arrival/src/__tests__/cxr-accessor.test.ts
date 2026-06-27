/**
 * The `c[ad]+r` pair-accessor family — kernel-unfolded car/cdr COMPOSITION.
 *
 * car/cdr are no longer bound symbols and there is no "aside" resolver: the KERNEL synthesizes
 * the WHOLE family (`env_get` → `cxrUnfold`) by composing each receiver's OWN tagless-final
 * car/cdr algebra — car/cdr are the 1-step base case, `cadr`…`caddddr` the deeper compositions.
 * So any accessor word the sweet lens fuses (`caddddr`, `caddadar`, …) evaluates, and the whole
 * family inherits the atoms' nil-tolerance (ANil reads the run's strict), provenance, and the
 * totalic "primitive does not support car" throw — no hand-maintained word list, no duplicated
 * field-access/typecheck.
 */
import { describe, expect, it } from "vitest";

import { exec } from "../eval/generator-exec";
import { global_env } from "../env-roots";
import { inferenceEnv } from "../inference-env";
import { is_nil } from "../eval/guards";
import { schemeToJs } from "../rosetta";

const evalIn = (env: typeof global_env) => async (expr: string): Promise<unknown> =>
  schemeToJs((await exec(expr, { env }))[0], {});

// element index k ≡ (car (cdr^k x)) ≡ "ca" + "d"×k + "r"
const cxrForIndex = (k: number): string => `ca${"d".repeat(k)}r`;

// Run the SAME expressions through both roots. The kernel unfold is env-independent (no per-env
// binding, no resolver), so global_env and inferenceEnv resolve the family identically. The list
// INPUTS use quote literals (`'(…)`, reader-level) rather than `(list …)` so the data needs no env
// binding either — `list` is a pack builtin (env/r7rs/lists.ts), bound on the assembled inference
// root but NOT on bare global_env; quote keeps this test isolated to the cxr unfold it targets.
for (const [label, env] of [["global_env", global_env], ["inferenceEnv", inferenceEnv]] as const) {
  describe(`c[ad]+r evaluation in ${label}`, () => {
    const run = evalIn(env);

    it("car/cdr — the 1-step base case — resolve via the kernel unfold", async () => {
      expect(await run("(car '(10 20 30))")).toBe(10);
      expect(await run("(cdr '(10 20 30))")).toEqual([20, 30]);
    });

    it("standard composites still resolve (regression)", async () => {
      expect(await run("(cadr '(10 20 30 40 50 60))")).toBe(20);
      expect(await run("(caddr '(10 20 30 40 50 60))")).toBe(30);
      expect(await run("(cadddr '(10 20 30 40 50 60))")).toBe(40);
    });

    it("deep linear accessors resolve to the right element", async () => {
      // k=4: 5 inner letters; k=5: 6 — both past the old eager loop AND the SAFE_BUILTINS slice.
      expect(await run(`(${cxrForIndex(4)} '(10 20 30 40 50 60))`)).toBe(50);
      expect(await run(`(${cxrForIndex(5)} '(10 20 30 40 50 60))`)).toBe(60);
    });

    it("mixed combos compose car/cdr correctly", async () => {
      // cdar = drop-1 of the first element
      expect(await run("(cdar '((1 2 3) 9))")).toEqual([2, 3]);
      // caadr = first of the second element
      expect(await run("(caadr '(10 (100 200) 30))")).toBe(100);
      // caddar = third of the first element: car→(1 2 3 4), cdr, cdr, car→3
      expect(await run("(caddar '((1 2 3 4) 9))")).toBe(3);
    });

    it("an accessor that walks off the end follows the run's nil-projection — tolerant ⇒ nil, strict ⇒ throw", async () => {
      // (cadr (list 1)): cdr → (), then car of () — the unified ANil nil-projection. The WHOLE
      // family now inherits the atoms' mode-gating (the old strict resolver always threw here).
      expect(is_nil((await exec("(cadr '(1))", { env }))[0])).toBe(true);
      await expect(exec("(cadr '(1))", { env, strict: true })).rejects.toThrow();
    });
  });
}
