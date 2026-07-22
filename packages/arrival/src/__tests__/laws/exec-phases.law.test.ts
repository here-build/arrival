/**
 * LAW — the exec PHASE PRODUCTS (exec-phases-and-dynamic-metadata.md Part III).
 * `exec` = the literal composition of the phases; these rows pin:
 *
 *   • the §3.3 OWNERSHIP TABLE, row by row (phase 5 — dispose exactly what the call
 *     assembled): per-call `{ capabilities }` teardown at run end INCLUDING throw
 *     paths (the fixed dispose-drop site #4 — the pinned behavior change, leak →
 *     teardown); caller-owned `{ ambient }` never disposed by exec; the realm default
 *     never disposed at all; glass carries no product.
 *   • AMBIENT REUSE — assemble once, run many: scope ⊥ ambient (defines ride the scope, not
 *     the ambient). STAGE 2 (docs/execution.md §HERMETIC): a baked verb's resources no longer
 *     warm across runs just because the AMBIENT was reused — they're keyed by RunContext, so
 *     warmth follows a REPL's RunContext continuity (`ExecOptions.runCtx`) instead; two runs
 *     on one reused ambient with no shared runCtx spawn independently (per-run isolation).
 *   • PARSE-ONCE-RUN-MANY — one `ParsedProgram`, N runs, same results; the reader
 *     mode is a stamped program identity fact.
 *   • VALIDATION WITHOUT EXECUTION — phases 1+2+2.5, zero side effects fired.
 */
import { describe, expect, it } from "vitest";
import { mintFrame } from "../../env/AmbientRuntime.js";

import { EnvCapability } from "../../common/capability.js";
import type { Resource } from "../../common/resources.js";
import * as z from "../../common/scheme-zod.js";
import { symbol } from "../../common/symbol.js";
import { LexicalScope } from "../../eval/LexicalScope.js";
import { parseProgram, validateAgainstAmbient } from "../../eval/exec-phases.js";
import { assembleAmbient, exec, execState } from "../../eval/generator-exec.js";
import { user_env } from "../../env/env-roots.js";
import { makeRunContext } from "../../run/RunContext.js";
import { disposeRunContext } from "../../run/run-lifecycle.js";

/** A spy-instrumented port: counts acquisitions + teardowns. */
function spyResource(): { resource: Resource<{ tag: string }>; counts: { acquired: number; disposed: number } } {
  const counts = { acquired: 0, disposed: 0 };
  return {
    counts,
    resource: {
      kind: "law/spy-port",
      async acquire() {
        counts.acquired += 1;
        return {
          tag: "live",
          [Symbol.asyncDispose]: async () => {
            counts.disposed += 1;
          },
        };
      },
    },
  };
}

/** A capability owning ONE spy port + a verb that touches it (spawning it). */
function spyCapability() {
  const { resource, counts } = spyResource();
  const capability = new EnvCapability("law/exec-phases-spy", {
    resources: { port: resource },
    symbols: {
      // A plain verb — the capability owns a cell, so the binder's `ensureSpawned`
      // middleware spawns the port on first call (the designed first-touch gate).
      "spy/touch": symbol.rosetta`spy/touch: read the spy port's tag`({ input: [], output: [z.string] }, () => "touched"),
    },
  });
  return { capability, counts };
}

describe("ownership table (§3.3) — phase 5 disposes exactly what the call assembled", () => {
  it("per-call { capabilities }: resource teardown fires at run end (drop site #4 fixed)", async () => {
    const { capability, counts } = spyCapability();
    const [out] = await exec(`(spy/touch)`, { capabilities: [capability] });
    expect(out).toBe("touched");
    expect(counts.acquired).toBe(1); // the verb's first touch spawned it
    expect(counts.disposed).toBe(1); // exec OWNED the assembly — wind-down fired in finally
  });

  it("per-call { capabilities }: teardown fires on the THROW path too", async () => {
    const { capability, counts } = spyCapability();
    await expect(exec(`(spy/touch) (car 1)`, { capabilities: [capability] })).rejects.toThrow();
    expect(counts.acquired).toBe(1);
    expect(counts.disposed).toBe(1); // finally — teardown on every exit, not just success
  });

  it("caller-owned { ambient }: exec never disposes; ambient.dispose() is the caller's, idempotent", async () => {
    const { capability, counts } = spyCapability();
    const ambient = await assembleAmbient({ capabilities: [capability] });
    // STAGE 2 (docs/execution.md §HERMETIC): a capability's resources are now keyed by
    // RunContext, not by ambient — warm reuse across passes follows RunContext continuity
    // (a REPL's ONE session), not merely "the ambient was reused." Threading the SAME runCtx
    // through both calls is the designed REPL idiom (`ExecOptions.runCtx`).
    const runCtx = makeRunContext({});
    const [a] = await exec(`(spy/touch)`, { ambient, runCtx });
    const [b] = await exec(`(spy/touch)`, { ambient, runCtx });
    expect([a, b]).toEqual(["touched", "touched"]);
    expect(counts.acquired).toBe(1); // warm reuse — spawned once, shared across passes of ONE RunContext
    expect(counts.disposed).toBe(0); // exec did NOT dispose a caller-owned ambient NOR a caller-supplied runCtx
    await ambient.dispose();
    expect(counts.disposed).toBe(0); // STAGE 2: resource lifetime rides the RunContext, not the ambient —
    // disposing the ambient alone no longer tears a baked verb's resources down.
    await ambient.dispose();
    expect(counts.disposed).toBe(0); // still untouched — idempotent no-op for THIS resource
    await disposeRunContext(runCtx); // the caller's own deliberate session end
    expect(counts.disposed).toBe(1);
    await disposeRunContext(runCtx);
    expect(counts.disposed).toBe(1); // single-flight — idempotent
    // `await using` support: both the ambient AND a `makeRunContext()`-minted RunContext are
    // AsyncDisposable by construction.
    expect(typeof ambient[Symbol.asyncDispose]).toBe("function");
    expect(typeof runCtx[Symbol.asyncDispose]).toBe("function");
  });

  it("two SEPARATE exec() calls on a reused ambient, with NO runCtx continuity, spawn TWICE — Stage 2's per-run isolation", async () => {
    const { capability, counts } = spyCapability();
    const ambient = await assembleAmbient({ capabilities: [capability] });
    const [a] = await exec(`(spy/touch)`, { ambient }); // mints + disposes its OWN runCtx
    const [b] = await exec(`(spy/touch)`, { ambient }); // a SECOND, unrelated runCtx
    expect([a, b]).toEqual(["touched", "touched"]);
    expect(counts.acquired).toBe(2); // no shared RunContext ⇒ no shared resource
    expect(counts.disposed).toBe(2); // each call's self-minted runCtx tore its own spawn down
    await ambient.dispose();
  });

  it("the realm default: ExecState.ambient present; dispose() is a documented no-op", async () => {
    const first = await execState(`(+ 1 2)`);
    expect(first.ambient).toBeDefined();
    await first.ambient!.dispose(); // realm-scoped by design — must NOT tear the base down
    const [stillWorks] = await exec(`(+ 20 22)`);
    expect(stillWorks).toBe(42);
    // The realm memo: two default runs share ONE ambient identity.
    const second = await execState(`(+ 1 1)`);
    expect(second.ambient).toBe(first.ambient);
  });

  it("glass { env }: no phase product — ExecState.ambient is absent (§3.4)", async () => {
    const state = await execState(`(+ 1 2)`, { env: mintFrame(user_env, "law/glass") });
    expect(state.ambient).toBeUndefined();
  });
});

describe("ambient reuse — assemble once, run many (§3.5)", () => {
  it("scope ⊥ ambient: defines ride the scope; fresh scopes on one ambient stay isolated", async () => {
    const { capability } = spyCapability();
    const ambient = await assembleAmbient({ capabilities: [capability] });
    try {
      const a = LexicalScope.fresh("law/session-a");
      await exec(`(define x 41)`, { ambient, scope: a });
      const [cont] = await exec(`(+ x 1)`, { ambient, scope: a }); // same scope — REPL continuity
      expect(cont).toBe(42);
      const b = LexicalScope.fresh("law/session-b");
      await expect(exec(`x`, { ambient, scope: b })).rejects.toThrow(/x/); // other scope — unbound
    } finally {
      await ambient.dispose();
    }
  });

  it("ambient.heapBudget is POLICY (the default), the per-run option wins (§3.1)", async () => {
    const ambient = await assembleAmbient({ heapBudget: 100 });
    const big = `'(${Array.from({ length: 500 }, (_, i) => i).join(" ")})`;
    try {
      // The ambient default bounds the run: a sequence-op pass over 500 elements trips
      // the 100-cell policy (the same charge point heap-budget-sequence-ops.test.ts pins).
      await expect(exec(`(map (lambda (x) x) ${big})`, { ambient })).rejects.toThrow(/heap budget exceeded/);
      // The per-run option WINS over the ambient policy.
      const [ok] = await exec<[number]>(`(length (map (lambda (x) x) ${big}))`, {
        ambient,
        heapBudget: 1_000_000,
      });
      expect(ok).toBe(500);
    } finally {
      await ambient.dispose();
    }
  });
});

describe("parse-once-run-many (§3.5)", () => {
  it("one ParsedProgram, N runs — the designed idiom (code argument ignored)", async () => {
    const program = await parseProgram(`(+ 1 2) (* 3 4)`);
    expect(program.strict).toBe(false); // reader mode — a stamped identity fact
    expect(program.forms).toHaveLength(2);
    const first = await exec(``, { program });
    const second = await exec(`(this is ignored)`, { program });
    expect(first).toEqual([3, 12]);
    expect(second).toEqual([3, 12]);
  });
});

describe("validation without execution (§3.5) — phases 1+2+2.5, stop", () => {
  it("diagnostics computed against the ambient's sealed chain; nothing runs", async () => {
    const { capability, counts } = spyCapability();
    const ambient = await assembleAmbient({ capabilities: [capability] });
    try {
      const program = await parseProgram(`(spy/touch) (definitely-not-bound-anywhere 1)`);
      const diagnostics = validateAgainstAmbient(program, ambient, LexicalScope.fresh());
      expect(diagnostics.some((d) => d.severity === "error")).toBe(true); // the unbound ref reported
      expect(diagnostics.some((d) => d.message.includes("definitely-not-bound-anywhere"))).toBe(true);
      expect(counts.acquired).toBe(0); // ZERO side effects fired — no eval, no resource touch
    } finally {
      await ambient.dispose();
    }
  });
});
