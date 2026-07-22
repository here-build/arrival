/**
 * The Contract.emit registry harvest (registry-emit.md §Test plan rows 1-3c/6/7/11/12,
 * adapted to this wave's scope): rows off a REAL assembled env, the dry-harvest poison
 * discipline for builder-form capabilities, and the Law-N witness-registry gate.
 * Kernel-seed car/cdr rows, cxr synthesis, and the Law-W await probe arrive with the
 * symbol-rules wave (they need Residual constructors).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EnvCapability } from "@inhuman.tools/arrival/capability";
import type { EmitRule } from "@inhuman.tools/arrival/emit";
import { symbol, withContractFields } from "@inhuman.tools/arrival/symbol";

import { openOracleSession, type OracleSession } from "../registry/greenfield-session.js";
import { emitRegistryOf } from "../registry/index.js";

describe("emitRegistryOf over the real oracle ambient", () => {
  let session: OracleSession;

  beforeAll(async () => {
    session = await openOracleSession();
  }, 60_000);

  afterAll(async () => {
    await session.dispose();
  }, 30_000);

  it("harvests rows for capability-declared symbols without arming anything", () => {
    // The session's InferFn stub THROWS on any invocation — a clean harvest is the
    // proof that neither resources nor impls were touched (test-plan row 2).
    const registry = emitRegistryOf(session.ambient);
    expect(registry.names.size).toBeGreaterThan(50);
    for (const name of [
      "infer",
      "infer/chat",
      "infer/chat/system",
      "infer/chat/user",
      "infer/chat/assistant",
      "pair?",
    ]) {
      expect(registry.lookup(name), name).toBeDefined();
    }
    const infer = registry.lookup("infer");
    expect(infer).toMatchObject({
      symbol: "infer",
      capability: "arrival/infer",
      kind: "rosetta",
      provenance: "source",
      cacheClass: "pure",
      refPolicy: "shim", // no authored policy anywhere yet — the resolved default
    });
    expect(infer?.type).toContain("prompt");
    // R2 relocation (arrival-mercury constitution §9): `infer`'s Contract now carries
    // its own `emit` rule (llm-plane-arrival-env/src/infer.ts's `inferEmitRule`,
    // moved off this package's phase1 table) — this is the ambient PROOF that
    // `arrival/infer` resolves through the real harvest at all (unlike scheme/srfi-1,
    // never a held row here). `infer/chat/system` is `kind: "define"` (a
    // `symbol.define` procedure, not `rosetta`) — its `emit` is carried by the
    // declaration-site SPREAD idiom (`symbol.define`'s factory does not thread a
    // Contract's `emit` through on its own; see infer.ts's own note), proven equally
    // reachable here.
    expect(infer?.emit).toBeDefined();
    expect(registry.lookup("infer/chat/system")).toMatchObject({ kind: "define" });
    expect(registry.lookup("infer/chat/system")?.emit).toBeDefined();
  });

  it("ambient harvest and bare-roster harvest BOTH succeed — no builder-form capability remains in the DAG", () => {
    // The Stage-6 cleanup migrated every capability in the real oracle DAG off the
    // builder-form `symbols` (config now reaches impls via `this.configuration` at
    // dispatch), so a bare-roster harvest no longer trips the phantom activation's
    // static-rules poison — there is nothing activation-dependent left to resolve.
    // The poison-door mechanism itself stays covered by the synthetic fixtures in
    // the "dry-harvest of builder-form capabilities" describe below (it still
    // defends against type-erased/out-of-repo specs handing the harvest a builder).
    expect(() => emitRegistryOf(session.ambient)).not.toThrow();
    expect(() => emitRegistryOf(session.ambient.capabilities)).not.toThrow();
  });

  it("is deterministic across two harvests of the same roster", () => {
    const a = emitRegistryOf(session.ambient);
    const b = emitRegistryOf(session.ambient);
    expect([...a.names].sort()).toEqual([...b.names].sort());
    expect(a.lookup("infer")).toEqual(b.lookup("infer"));
  });

  it("Law N gate is wired and green over the real env (null?/pair? carry narrows, self-witnessed)", () => {
    // emitRegistryOf runs assertNarrowsWitnessed internally — reaching here without a
    // throw IS the green claim; the red paths are pinned synthetically below.
    // `null?`/`pair?` moved their `narrows` declaration onto their own Contracts in
    // the Phase-2 relocation (foundations/arrival/arrival/src/env/r7rs/equality.ts) —
    // today's only two narrows-flagged rows in the real env, each self-witnessed (its
    // own runtime behavior PROVES the narrowing). Every OTHER harvested symbol still
    // carries none — this loop stays a tight assertion, not a vacuous one.
    const registry = emitRegistryOf(session.ambient);
    const KNOWN_NARROWS: Readonly<Record<string, { readonly witness: string }>> = {
      "null?": { witness: "null?" },
      "pair?": { witness: "pair?" },
    };
    for (const name of registry.names) {
      expect(registry.lookup(name)?.narrows, name).toEqual(KNOWN_NARROWS[name]);
    }
  });
});

describe("dry-harvest of builder-form capabilities (the static-rules discipline)", () => {
  it("invokes the builder against the phantom activation and harvests its rows", () => {
    const cap = new EnvCapability("test/builder", {
      symbols: ({ configuration }) => {
        void configuration; // reference capture only — the sanctioned shape
        return { probe: symbol.taglessGuard`probe: test predicate` };
      },
    });
    const registry = emitRegistryOf([cap]);
    expect(registry.lookup("probe")).toMatchObject({ capability: "test/builder", kind: "tagless-guard" });
  });

  it("throws the teaching error when a builder reads a configuration VALUE at top level", () => {
    const cap = new EnvCapability("test/poison-config", {
      symbols: ({ configuration }) => (configuration.flag ? { a: symbol.taglessGuard`a: t` } : {}),
    });
    expect(() => emitRegistryOf([cap])).toThrow(/configuration\.flag[\s\S]*outside an impl body/);
  });

  it("allows a builder that only CAPTURES a resource Ref at top level", () => {
    const cap = new EnvCapability("test/ref-capture", {
      symbols: ({ resources }) => {
        const ref = resources.foo; // capture only — structurally the `{ configuration }` destructure
        void ref;
        return { ok: symbol.taglessGuard`ok: t` };
      },
    });
    expect(emitRegistryOf([cap]).lookup("ok")).toBeDefined();
  });

  it("throws when a builder DEREFERENCES a resource via .get() at top level", () => {
    const cap = new EnvCapability("test/ref-deref-get", {
      symbols: ({ resources }) => {
        void resources.foo.get();
        return {};
      },
    });
    expect(() => emitRegistryOf([cap])).toThrow(/resources\.foo\.get\(\)[\s\S]*outside an impl body/);
  });

  it("throws when a builder DEREFERENCES a resource via .live at top level", () => {
    const cap = new EnvCapability("test/ref-deref-live", {
      symbols: ({ resources }) => {
        void resources.foo.live;
        return {};
      },
    });
    expect(() => emitRegistryOf([cap])).toThrow(/resources\.foo\.live[\s\S]*outside an impl body/);
  });

  it("invokes a shared builder exactly once — per instance, across harvests (WeakMap memo)", () => {
    let invocations = 0;
    const shared = new EnvCapability("test/shared-dep", {
      symbols: () => {
        invocations += 1;
        return { s: symbol.taglessGuard`s: shared` };
      },
    });
    const a = EnvCapability.define("test/diamond-a", { deps: [shared], symbols: () => ({}) });
    const b = EnvCapability.define("test/diamond-b", { deps: [shared], symbols: () => ({}) });
    emitRegistryOf([a, b]); // diamond: the seen-set dedups within one walk
    emitRegistryOf([a, b]); // the WeakMap dedups across walks
    expect(invocations).toBe(1);
  });
});

describe("row shape and precedence", () => {
  it("resolves refPolicy's default, carries authored emit/narrows/refPolicy off a Contract", () => {
    const rule: EmitRule = { call: (args) => args[0] };
    const cap = EnvCapability.define("test/fields", {
      symbols: (sym, z) => ({
        plain: sym.native`plain: identity`({ input: [z.value], output: [z.value] }, (x) => x),
        ruled: sym.native`ruled: identity with a rule`(
          {
            input: [z.value],
            output: [z.value],
            emit: rule,
            refPolicy: "eta",
            narrows: { witness: "plain" },
          },
          (x) => x,
        ),
      }),
    });
    const registry = emitRegistryOf([cap]);
    expect(registry.lookup("plain")).toMatchObject({ kind: "native", refPolicy: "shim" });
    expect(registry.lookup("plain")?.emit).toBeUndefined();
    const ruled = registry.lookup("ruled");
    expect(ruled).toMatchObject({ refPolicy: "eta", narrows: { witness: "plain" } });
    expect(ruled?.emit).toBe(rule); // carried by REFERENCE, never cloned
  });

  it("carries narrows stamped directly onto a contract-less tagless-guard def (self-witnessing)", () => {
    const cap = EnvCapability.define("test/self-witness", {
      symbols: (sym) => ({
        "my-pred?": withContractFields(sym.taglessGuard`my-pred?: test predicate`, {
          narrows: { witness: "my-pred?" },
        }),
      }),
    });
    const row = emitRegistryOf([cap]).lookup("my-pred?");
    expect(row?.narrows).toEqual({ witness: "my-pred?" });
  });

  it("harvests door rows with the teaching reason (never an emit)", () => {
    const cap = EnvCapability.define("test/doors", {
      symbols: (sym) => ({ "call/cc": sym.notImplemented`call/cc: prohibited-dynamics — arrival is immutable` }),
    });
    const row = emitRegistryOf([cap]).lookup("call/cc");
    expect(row).toMatchObject({
      kind: "door",
      doorReason: "prohibited-dynamics — arrival is immutable",
      refPolicy: "shim",
    });
    expect(row?.emit).toBeUndefined();
  });

  it("harvests a namespaced verb under its own explicit name (symbolPrefix retired — a subject-scoped pack spells the namespace into each verb's own name directly)", () => {
    const cap = EnvCapability.define("test/prefixed", {
      symbols: (sym) => ({ "proc/list": sym.taglessGuard`proc/list: t` }),
    });
    const registry = emitRegistryOf([cap]);
    expect(registry.lookup("list")).toBeUndefined();
    expect(registry.lookup("proc/list")).toMatchObject({ symbol: "proc/list", capability: "test/prefixed" });
  });

  it("dep-declared names lose to the dependent's own (deps-first, last-write-wins)", () => {
    const dep = EnvCapability.define("test/dep", {
      symbols: (sym) => ({ x: sym.taglessGuard`x: dep version` }),
    });
    const self = EnvCapability.define("test/self", {
      deps: [dep],
      symbols: (sym) => ({ x: sym.taglessGuard`x: self version` }),
    });
    const registry = emitRegistryOf([dep, self]);
    expect(registry.lookup("x")?.capability).toBe("test/self");
  });

  it("skips alias + the legacy {fn} record; a symbol.value def harvests as a contract-less row", () => {
    // The untagged `{ value }` and bare-fn arms are RETIRED from SymbolDeclaration — data
    // constants author as `symbol.value` (a baked kind: harvests a row, but with no
    // emit/contract fields to carry); the `{ fn }` record survives for the postponed MCP
    // surface and stays kind-less, so the harvest still skips it.
    const cap = new EnvCapability("test/legacy", {
      symbols: {
        boxed: symbol.value`boxed: data constant`(42),
        wrapped: { fn: () => 42 },
        aka: symbol.alias`real-name`,
        real: symbol.taglessGuard`real: t`,
      },
    });
    const registry = emitRegistryOf([cap]);
    expect(registry.lookup("boxed")?.kind).toBe("value");
    expect(registry.lookup("boxed")?.emit).toBeUndefined();
    expect(registry.lookup("wrapped")).toBeUndefined();
    expect(registry.lookup("aka")).toBeUndefined();
    expect(registry.lookup("real")).toBeDefined();
  });
});

describe("Law N — the witness-registry red build", () => {
  it("throws when a narrows row names a witness absent from the harvested set", () => {
    const cap = EnvCapability.define("test/bad-witness", {
      symbols: (sym) => ({
        "my-pred?": withContractFields(sym.taglessGuard`my-pred?: test predicate`, {
          narrows: { witness: "never-declared-anywhere" },
        }),
      }),
    });
    expect(() => emitRegistryOf([cap])).toThrow(/Law N[\s\S]*"my-pred\?"[\s\S]*"never-declared-anywhere"/);
  });

  it("passes when the witness is declared by ANOTHER capability in the same assembly", () => {
    const witnessCap = EnvCapability.define("test/witness-owner", {
      symbols: (sym) => ({ "pair-proof": sym.taglessGuard`pair-proof: t` }),
    });
    const narrowsCap = EnvCapability.define("test/narrows-owner", {
      symbols: (sym) => ({
        "my-pred?": withContractFields(sym.taglessGuard`my-pred?: t`, { narrows: { witness: "pair-proof" } }),
      }),
    });
    const registry = emitRegistryOf([witnessCap, narrowsCap]);
    expect(registry.lookup("my-pred?")?.narrows).toEqual({ witness: "pair-proof" });
  });
});
