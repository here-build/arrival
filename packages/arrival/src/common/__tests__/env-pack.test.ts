// env-pack.test.ts — P0: the pure assembly core (closure/cycle/dedup/C3/apply), now exercised
// exclusively through `createRuntimeAssembler` — the ONE assembler `common/kernel.ts` still
// hosts. Design + test matrix: the env-pack capability-DAG design §11 (2026-06-13).
//
// STAGE C CUT 4 (docs/plans/stage-c-corpse-deletion.md) retired `assembleEnv` (the BOOTSTRAP
// assembler, folding an `EnvPack` DAG onto a fresh base) — bootstrap assembly is
// `env/vocabulary.ts`'s `buildVocabulary` now. `createRuntimeAssembler` SURVIVES (it applies
// host-registered `EnvPack`s onto an ALREADY-LIVE env, backing `(require/extension :name)` — a
// genuinely different, still-real operation). Every law below shares the SAME underlying core
// (`linearize`/`dag-linearize.ts`'s C3 walk, `configEqual`, `withTimeout`) `assembleEnv` used to
// call too — re-authored here as one-or-more `.require()` calls on a single assembler instance
// instead of one `assembleEnv(base, roots)` call, with byte-identical assertions.

import { afterEach, describe, expect, it } from "vitest";

import { createRuntimeAssembler, type EnvPack } from "../kernel.js";
import {
  AssembleCycleError,
  AssembleConfigConflictError,
  AssembleLinearizationError,
  AssemblePackError,
  AssemblePackTimeoutError } from "../../errors.js";

// A stub env: records the order packs applied + the symbols they set.
interface Stub {
  appliedOrder: string[];
  syms: Map<string, unknown>;
}
const stub = (): Stub => ({ appliedOrder: [], syms: new Map() });

/** A pack that records its name into the env's applied-order on apply. */
function pack(name: string, deps: EnvPack<Stub>[] = [], extra: Partial<EnvPack<Stub>> = {}): EnvPack<Stub> {
  return {
    name,
    deps,
    apply: (env) => {
      env.appliedOrder.push(name);
      env.syms.set(name, true);
    },
    ...extra };
}

afterEach(() => {
  delete process.env.ASSEMBLE_PACK_TIMEOUT_MS;
});

describe("env-pack assembly core (P0), over createRuntimeAssembler", () => {
  // INVARIANT: a linear dep chain a→b→c applies deps-first, each pack exactly once.
  it("linear chain a→b→c: applies deps-first; each once", async () => {
    const c = pack("c");
    const b = pack("b", [c]);
    const a = pack("a", [b]);
    const env = stub();
    await createRuntimeAssembler(env).require(a);
    expect(env.appliedOrder).toEqual(["c", "b", "a"]); // applied least-precedence first
  });

  // INVARIANT: a diamond dep graph linearizes via classic C3 and applies the shared root exactly
  // once.
  it("diamond d→{b,c}, b→a, c→a: C3 apply order == [a,c,b,d]; a applied once", async () => {
    const a = pack("a");
    const b = pack("b", [a]);
    const c = pack("c", [a]);
    const d = pack("d", [b, c]);
    const env = stub();
    await createRuntimeAssembler(env).require(d);
    expect(env.appliedOrder.filter((n) => n === "a")).toHaveLength(1);
    expect(env.appliedOrder).toEqual(["a", "c", "b", "d"]);
  });

  // INVARIANT: a pack reachable via 3 distinct require() calls is applied exactly once (dedup) —
  // the assembler's single-flight `applied` map persists across calls on the SAME instance.
  it("dedup via 3 require() calls to one pack: applied exactly once", async () => {
    const shared = pack("shared");
    const x = pack("x", [shared]);
    const y = pack("y", [shared]);
    const env = stub();
    const ra = createRuntimeAssembler(env);
    await ra.require(x);
    await ra.require(y);
    await ra.require(shared); // reached a 3rd way — already applied, single-flight no-op
    expect(env.appliedOrder.filter((n) => n === "shared")).toHaveLength(1);
  });

  // INVARIANT: a cycle in deps throws AssembleCycleError with the path.
  it("cycle a→b→a throws AssembleCycleError with the path", async () => {
    const a: EnvPack<Stub> = { name: "a", apply: () => {} };
    const b: EnvPack<Stub> = { name: "b", deps: [a], apply: () => {} };
    (a as { deps?: EnvPack<Stub>[] }).deps = [b]; // close the cycle
    await expect(createRuntimeAssembler(stub()).require(a)).rejects.toBeInstanceOf(AssembleCycleError);
  });

  // INVARIANT: two packs sharing a name with divergent config throw AssembleConfigConflictError.
  it("same-name divergent config throws AssembleConfigConflictError", async () => {
    const fnA = () => 1,
      fnB = () => 2;
    const mcp1 = pack("mcp", [], { config: fnA });
    const mcp2 = pack("mcp", [], { config: fnB });
    const root = pack("root", [mcp1, mcp2]);
    await expect(createRuntimeAssembler(stub()).require(root)).rejects.toBeInstanceOf(AssembleConfigConflictError);
  });

  // INVARIANT: two packs sharing a name with equal config dedup silently (no conflict).
  it("same-name EQUAL config dedups silently", async () => {
    const shared = () => 1;
    const mcp1 = pack("mcp", [], { config: shared });
    const mcp2 = pack("mcp", [], { config: shared });
    const root = pack("root", [mcp1, mcp2]);
    const env = stub();
    await createRuntimeAssembler(env).require(root);
    expect(env.appliedOrder.filter((n) => n === "mcp")).toHaveLength(1);
  });

  // INVARIANT: an async pack apply resolves before require() returns, its bindings visible
  // after.
  it("async apply (await import-shaped): env has the symbol after require() resolves", async () => {
    const slow: EnvPack<Stub> = {
      name: "slow",
      apply: async (env) => {
        await Promise.resolve();
        env.syms.set("slow/fn", 42);
      } };
    const env = stub();
    await createRuntimeAssembler(env).require(slow);
    expect(env.syms.get("slow/fn")).toBe(42);
  });

  // INVARIANT: onDispose callbacks run in LIFO order (reverse of apply order).
  it("onDispose runs LIFO (reverse of apply)", async () => {
    const log: string[] = [];
    const mk = (name: string, deps: EnvPack<Stub>[] = []): EnvPack<Stub> => ({
      name,
      deps,
      apply: (_e, ctx) => {
        ctx.onDispose(() => {
          log.push(name);
        });
      } });
    const c = mk("c");
    const b = mk("b", [c]);
    const a = mk("a", [b]);
    const ra = createRuntimeAssembler(stub());
    await ra.require(a);
    await ra.dispose();
    // applied c,b,a → disposers pushed c,b,a → LIFO runs a,b,c
    expect(log).toEqual(["a", "b", "c"]);
  });

  // INVARIANT (createRuntimeAssembler-specific — see this file's own header): a throwing pack
  // apply does NOT roll back prior successes — a live env can't cleanly "undo" a dep another
  // caller may already be relying on. The whole require() still rejects with AssemblePackError;
  // the prior pack's disposer runs only when `.dispose()` is explicitly called, same as any
  // other successfully-applied pack. (The retired BOOTSTRAP `assembleEnv` DID roll back
  // immediately on any apply failure — "no half-built env escapes" — but that law has no
  // live-env equivalent; `buildVocabulary`, its successor, has no apply/dispose phase at all —
  // it's a pure map-building walk with nothing to roll back.)
  it("a throwing apply rejects with AssemblePackError; the prior pack's success is NOT rolled back", async () => {
    const disposed: string[] = [];
    const ok: EnvPack<Stub> = {
      name: "ok",
      apply: (_e, ctx) => {
        ctx.onDispose(() => {
          disposed.push("ok");
        });
      } };
    const boom: EnvPack<Stub> = {
      name: "boom",
      deps: [ok],
      apply: () => {
        throw new Error("kaboom");
      } };
    const ra = createRuntimeAssembler(stub());
    await expect(ra.require(boom)).rejects.toBeInstanceOf(AssemblePackError);
    expect(disposed).toEqual([]); // not disposed automatically on failure
    await ra.dispose();
    expect(disposed).toEqual(["ok"]); // ok's apply already ran (registering onDispose) and is
    // NOT undone by boom's failure — only torn down when the assembler itself disposes
  });

  // INVARIANT: an apply that never resolves trips AssemblePackTimeoutError under
  // ASSEMBLE_PACK_TIMEOUT_MS (pins implementation, not behavior).
  it("apply timeout: a never-resolving apply trips AssemblePackTimeoutError", async () => {
    process.env.ASSEMBLE_PACK_TIMEOUT_MS = "40";
    const wedged: EnvPack<Stub> = { name: "wedged", apply: () => new Promise(() => {}) };
    await expect(createRuntimeAssembler(stub()).require(wedged)).rejects.toBeInstanceOf(AssemblePackTimeoutError);
  });

  it("a pack listing the same dep twice dedups (no spurious AssembleLinearizationError)", async () => {
    // Regression: dep-name dups must collapse to one C3 node, else the [deps] list has a duplicate
    // with no valid 'good head' and C3 wrongly throws. (Bug surfaced during the lint refactor.)
    const a = pack("a");
    const dupDep: EnvPack<Stub> = {
      name: "b",
      deps: [a, a],
      apply: (env) => {
        env.appliedOrder.push("b");
      } };
    const env = stub();
    await createRuntimeAssembler(env).require(dupDep);
    expect(env.appliedOrder).toEqual(["a", "b"]);
    expect(env.appliedOrder.filter((n) => n === "a")).toHaveLength(1);
  });

  // ── createRuntimeAssembler-specific laws (P4: the `(require/extension)` live-apply path) ──
  describe("createRuntimeAssembler — live-env-specific laws", () => {
    // INVARIANT: a second require() of the same pack is a no-op (applies once, idempotent).
    it("idempotent: a second require is a no-op (applies once)", async () => {
      const env = stub();
      const a = pack("a");
      const ra = createRuntimeAssembler(env);
      await ra.require(a);
      await ra.require(a);
      expect(env.appliedOrder.filter((n) => n === "a")).toHaveLength(1);
    });

    // INVARIANT: two concurrent requires of the same pack apply exactly once (single-flight).
    it("single-flight: two CONCURRENT requires of the same pack apply once", async () => {
      const env = stub();
      let applies = 0;
      const slow: EnvPack<Stub> = {
        name: "slow",
        apply: async (e) => {
          applies += 1;
          await Promise.resolve();
          e.appliedOrder.push("slow");
        } };
      const ra = createRuntimeAssembler(env);
      await Promise.all([ra.require(slow), ra.require(slow)]); // race two arms
      expect(applies).toBe(1);
    });

    // INVARIANT: a failed apply can be retried — re-require after failure applies successfully.
    it("a failed apply can be retried (FAILED → re-require applies)", async () => {
      const env = stub();
      let attempt = 0;
      const flaky: EnvPack<Stub> = {
        name: "flaky",
        apply: (e) => {
          attempt += 1;
          if (attempt === 1) throw new Error("transient");
          e.appliedOrder.push("flaky");
        } };
      const ra = createRuntimeAssembler(env);
      await expect(ra.require(flaky)).rejects.toBeInstanceOf(AssemblePackError);
      await ra.require(flaky); // retry succeeds
      expect(env.appliedOrder).toEqual(["flaky"]);
    });

    // INVARIANT: dispose() runs runtime-applied disposers in LIFO order.
    it("dispose runs runtime-applied disposers LIFO", async () => {
      const env = stub();
      const log: string[] = [];
      const mk = (name: string, deps: EnvPack<Stub>[] = []): EnvPack<Stub> => ({
        name,
        deps,
        apply: (_e, ctx) => ctx.onDispose(() => void log.push(name)) });
      const a = mk("a");
      const b = mk("b", [a]);
      const ra = createRuntimeAssembler(env);
      await ra.require(b); // applies a then b → disposers pushed a,b
      await ra.dispose();
      expect(log).toEqual(["b", "a"]); // LIFO
    });
  });

  // ── C3 SPEC-PARITY (G9): our linearization == Python's C3 on canonical cases ──
  describe("C3 spec-parity vs Python MRO", () => {
    // INVARIANT: the classic K1/K2/K3/Z diamond hierarchy linearizes identically to Python's
    // documented C3 MRO. Apply is least-precedence-first (deps first), the REVERSE of the C3
    // order itself — so the expected apply sequence here is `order.toReversed()`.
    it("the classic K1/K2/K3/Z hierarchy matches Python's documented MRO", async () => {
      // From the C3 paper / Python docs. Python MRO of Z (dropping object):
      //   Z, K1, K2, K3, D, A, B, C, E — reversed = apply order least-precedence-first.
      const A = pack("A"),
        B = pack("B"),
        C = pack("C"),
        D = pack("D"),
        E = pack("E");
      const K1 = pack("K1", [A, B, C]);
      const K2 = pack("K2", [D, B, E]);
      const K3 = pack("K3", [D, A]);
      const Z = pack("Z", [K1, K2, K3]);
      const env = stub();
      await createRuntimeAssembler(env).require(Z);
      expect(env.appliedOrder).toEqual(["E", "C", "B", "A", "D", "K3", "K2", "K1", "Z"]);
    });

    // INVARIANT: an inconsistent hierarchy Python's C3 rejects is also rejected here, via
    // AssembleLinearizationError.
    it("an inconsistent hierarchy Python REJECTS, we reject too (AssembleLinearizationError)", async () => {
      // a wants [x,y]; b wants [y,x]; c(a,b) — no consistent linearization. Python raises TypeError.
      const x = pack("x"),
        y = pack("y");
      const a = pack("a", [x, y]);
      const b = pack("b", [y, x]);
      const c = pack("c", [a, b]);
      await expect(createRuntimeAssembler(stub()).require(c)).rejects.toBeInstanceOf(AssembleLinearizationError);
    });
  });
});
