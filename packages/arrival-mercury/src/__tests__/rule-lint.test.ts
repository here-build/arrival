/**
 * RULE-LINT — Law C's boundary, mechanically enforced (constitution §5.2 Law C /
 * §9 Phase 2: "PEEPHOLES land at Phase-2 opening... with a rule-lint that emit
 * rules never inspect parent CoreForm"). Two independent layers:
 *
 *  1. TYPE-LEVEL: `EmitCtx` itself (foundations/arrival/arrival/src/emit/
 *     emit-rule.ts) carries no parent/ancestor/node-graph-shaped field — the
 *     surface a COMPLIANT rule (no `any`/cast escape) could even ATTEMPT to read
 *     from is, by construction, parent-free. Pinned two ways: (a) a forbidden-
 *     name extraction that only typechecks if it resolves to `never`; (b) a
 *     `Required<EmitCtx<R>>` object literal, which forces this file to enumerate
 *     every field EmitCtx has — so a new field (parent-shaped or not) fails THIS
 *     file's own `tsc --strict` pass until reviewed here, never silently.
 *  2. RUNTIME: every `phase1Rules` emit rule (car/cdr/filter/infer-scalar/
 *     infer-chat-scalar — filter stays table-resident, see below; the scalar pair are
 *     peephole-only synthetic dispatch heads that never had a Contract to move to),
 *     plus the EIGHTEEN fully-RELOCATED Contract rules (`=`/`quotient`/`modulo` in
 *     foundations/arrival/arrival/src/env/r7rs/numeric.ts Wave 1; `+`/`-`/`*`/`/`
 *     joining them there, `cons` in .../lists.ts, and `not`/`null?`/`pair?` in
 *     .../equality.ts, Wave 2; `map`/`apply` joining `cons` in .../lists.ts, Wave 3;
 *     the infer family's five real symbols joining
 *     `@inhuman.tools/llm-plane-arrival-env`'s `src/infer.ts` Contracts, R2 — all
 *     moved off this table per rules/phase1.ts's own relocation note), is executed —
 *     across a spread of arities, so every `exactly()`-gated branch gets a turn —
 *     against a Proxy-wrapped ctx that records every property GET. Every recorded key
 *     must be in the documented-safe set: this catches a hypothetical
 *     `(ctx as any).parentOf(...)` escape a pure type-level check cannot (a cast
 *     bypasses `tsc`, never a runtime property read) — "cheap but real" per the
 *     mission's own framing. **`filter` is the one exception (Wave 3)**: its Contract
 *     (foundations/arrival/arrival/src/env/srfi/srfi-1.ts) ALSO carries an `emit`
 *     rule, but `scheme/srfi-1` is invisible to the oracle's harvest (phase1.ts's own
 *     relocation note has the full account), so it is checked here through the FIRST
 *     sweep (`phase1Rules`), not the second (the real harvest).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { EmitCtx } from "@here.build/arrival/emit";

import { cleanupOracleScratch, emitRegistryOf, openOracleSession, phase1Rules, type OracleSession } from "../index.js";
import { Binding, Lit, RuntimeRef, type R } from "../residual/types.js";

// ── 1a. type-level: EmitCtx's OWN surface carries no parent/ancestor field ───────────

type ForbiddenCtxKeys =
  | "parent"
  | "parentOf"
  | "parentNode"
  | "parentId"
  | "ancestor"
  | "ancestors"
  | "getParent"
  | "enclosing"
  | "siblingOf";

/** Every key EmitCtx exposes that ALSO matches a forbidden, node-graph-shaped
 *  name. Resolves to `never` today (EmitCtx's real field set — argFacts,
 *  selfFacts, config, originHint, fresh, runtime, door — shares nothing with
 *  the forbidden list); the type alias below only typechecks in that case. */
type ForbiddenKeysPresentOnEmitCtx = Extract<keyof EmitCtx, ForbiddenCtxKeys>;

/** A type-level-only assertion, ZERO runtime footprint (no value, nothing to
 *  erase incorrectly): `AssertNever`'s constraint (`T extends never`) is only
 *  satisfiable when its argument IS `never`. A future EmitCtx field named e.g.
 *  `parentOf` breaks the `_typeLevelNoParentField` alias below at
 *  `tsc --strict` time — "Type ... does not satisfy the constraint 'never'" —
 *  not silently. (An earlier draft tried a `declare const` + value assignment
 *  for this; `declare const` has no runtime binding at all, so referencing it
 *  as a value threw `ReferenceError` the moment this file was imported — a
 *  type-only construct must stay 100% type-only.) */
type AssertNever<T extends never> = T;
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- type-level assertion only, never referenced as a value
type _typeLevelNoParentField = AssertNever<ForbiddenKeysPresentOnEmitCtx>;

// ── 1b. canary: the hand-maintained safe-key list below matches EmitCtx's OWN
//        full field set — see this file's header for why `Required<>` forces it.

const KNOWN_SAFE_CTX_KEYS: ReadonlySet<PropertyKey> = new Set([
  "argFacts",
  "selfFacts",
  "config",
  "originHint",
  "fresh",
  "runtime",
  "door",
]);

// ── 2. runtime: a Proxy ctx that records every property access ──────────────────────

function probeCtx(accessed: Set<PropertyKey>, over: Partial<EmitCtx<R>> = {}): EmitCtx<R> {
  const base: EmitCtx<R> = {
    argFacts: [],
    config: { register: "run" },
    fresh: (hint) => Binding(hint),
    runtime: (symbol) => RuntimeRef(symbol),
    door: (reason) => {
      throw new Error(reason);
    },
    ...over,
  };
  return new Proxy(base, {
    get(target, prop, receiver) {
      accessed.add(prop);
      return Reflect.get(target, prop, receiver);
    },
  });
}

/** Run `rule.call` across a spread of arities (an `exactly()`-gated rule only
 *  runs its real body at ITS OWN arity — probing several catches every branch
 *  cheaply, with no per-rule arity table to hand-maintain). Thrown errors
 *  (arity doors, deliberate refusals) are expected noise: this sweep is ONLY
 *  about which `ctx` properties got READ, never about whether the call
 *  completed or what it returned. */
function accessedCtxKeysAcrossArities(rule: { call(args: readonly R[], ctx: EmitCtx<R>): R }): Set<PropertyKey> {
  const accessed = new Set<PropertyKey>();
  for (let n = 0; n <= 4; n++) {
    const args: R[] = Array.from({ length: n }, (_, i) => Lit(i));
    const ctx = probeCtx(accessed);
    try {
      rule.call(args, ctx);
    } catch {
      /* arity doors / deliberate refusals — not under test here */
    }
  }
  return accessed;
}

function expectOnlySafeKeys(accessed: ReadonlySet<PropertyKey>, label: string): void {
  for (const key of accessed) {
    expect(KNOWN_SAFE_CTX_KEYS.has(key), `${label} read ctx.${String(key)}, outside the documented-safe EmitCtx surface`).toBe(
      true,
    );
  }
}

describe("rule-lint — Law C's boundary: no emit rule inspects parent CoreForm", () => {
  it("EmitCtx's full field set matches the documented-safe key list (Required<> canary — see header 1b)", () => {
    const full: Required<EmitCtx<R>> = {
      argFacts: [],
      selfFacts: {},
      config: { register: "run" },
      originHint: undefined,
      fresh: () => Binding("tmp"),
      runtime: (s) => RuntimeRef(s),
      door: (r) => {
        throw new Error(r);
      },
    };
    expect(Object.keys(full).sort()).toEqual([...KNOWN_SAFE_CTX_KEYS].sort());
  });

  it("every phase1Rules emit rule only reads the documented EmitCtx surface", () => {
    let checked = 0;
    for (const [name, entry] of Object.entries(phase1Rules)) {
      if (entry.emit === undefined) continue;
      checked++;
      const accessed = accessedCtxKeysAcrossArities(entry.emit);
      expectOnlySafeKeys(accessed, `phase1Rules["${name}"]`);
    }
    // A sweep over an accidentally-empty table would pass vacuously — assert it
    // actually exercised a non-trivial number of rules (today's table: car/cdr/filter
    // + infer/scalar/infer/chat/scalar carry an `emit`, five rows; `every`/`any` are
    // registry-presence-only, no rule. The real infer family left this wave, R2 —
    // see the module comment above). The bound stays well below today's count
    // deliberately — a future wave could still shrink this table (e.g. if the
    // srfi-1/ambient gap closes and filter's row can finally go), and a bound pinned
    // to the exact count would need touching every wave for no safety gain.
    expect(checked).toBeGreaterThan(2);
  });

  it("car's .ref (the R5c eta-expansion method) only reads the documented EmitCtx surface", () => {
    // `.ref` is a DIFFERENT surface than `.call` (the sweeps above never invoke it —
    // `accessedCtxKeysAcrossArities` calls `rule.call`, not `rule.ref`) — this
    // dedicated check closes that gap now that car's row carries one (R5c).
    const rule = phase1Rules.car!.emit!;
    expect(rule.ref, "car should carry a .ref method since its refPolicy is \"eta\" (R5c)").toBeDefined();
    const accessed = new Set<PropertyKey>();
    // Across every branch `.ref` can take: no selfFacts at all; selfFacts present
    // but no callable claim; a callable claim with the wrong arity (mismatch ⇒
    // shim); and the real eta-firing shape (arity 1, with/without paramFacts).
    const selfFactsVariants: readonly (EmitCtx<R>["selfFacts"] | undefined)[] = [
      undefined,
      {},
      { callable: { arity: 2 } },
      { callable: { arity: 1 } },
      { callable: { arity: 1, paramFacts: [{ list: true }] } },
    ];
    for (const selfFacts of selfFactsVariants) {
      const ctx = probeCtx(accessed, { selfFacts });
      try {
        rule.ref!(ctx);
      } catch {
        /* not under test here — only which ctx keys got read */
      }
    }
    expectOnlySafeKeys(accessed, `phase1Rules["car"].emit.ref`);
    // Non-vacuous: `.ref` must actually have touched `selfFacts` (its whole point)
    // and `fresh`/`runtime` (the eta-fires / shim-falls-back branches respectively).
    expect(accessed.has("selfFacts")).toBe(true);
    expect(accessed.has("fresh")).toBe(true);
    expect(accessed.has("runtime")).toBe(true);
  });

  it("car's .ref actually eta-expands when a matching callable fact is proven, and shims otherwise (behavioral, not just ctx-key safety)", () => {
    const ref = phase1Rules.car!.emit!.ref!;
    // No proof ⇒ the exact same shim shape the walker's own rung-3 fallback builds.
    expect(ref(probeCtx(new Set(), { selfFacts: undefined }))).toEqual(RuntimeRef("car"));
    expect(ref(probeCtx(new Set(), { selfFacts: {} }))).toEqual(RuntimeRef("car"));
    // A proven but MISMATCHED arity ⇒ still the shim (car is fixed-arity 1; an
    // eta-expansion against the wrong arity would be dishonest, not just ugly).
    expect(ref(probeCtx(new Set(), { selfFacts: { callable: { arity: 2 } } }))).toEqual(RuntimeRef("car"));
    // A proven arity-1 signature ⇒ the eta-expanded arrow, structurally
    // `(fresh) => fresh[0]` (LEGIBILITY's destructuring/singularization passes are
    // NOT wired at this bare-rule layer — those fire later, in the full pipeline;
    // gate3's first-class-car-hof.golden.ts pins the post-LEGIBILITY shape).
    const eta = ref(probeCtx(new Set(), { selfFacts: { callable: { arity: 1 } } }));
    expect(eta.t).toBe("Arrow");
  });

  it("the eighteen fully-RELOCATED Contract rules (=, quotient, modulo, +, -, *, /, cons, not, null?, pair?, map, apply, infer, infer/chat, infer/chat/system, infer/chat/user, infer/chat/assistant) only read the documented EmitCtx surface", async () => {
    const session = await openOracleSession();
    try {
      const registry = emitRegistryOf(session.ambient);
      // Wave 1 (=, quotient, modulo — numeric.ts) + Wave 2 (+, -, *, / — numeric.ts;
      // cons — lists.ts; not, null?, pair? — equality.ts) + Wave 3 (map, apply —
      // lists.ts) + R2 (infer, infer/chat, infer/chat/system, infer/chat/user,
      // infer/chat/assistant — llm-plane-arrival-env's src/infer.ts). Eighteen names,
      // eighteen symbols FULLY relocated across four waves so far. `filter` (also
      // grown a Contract emit rule, Wave 3) is DELIBERATELY excluded from this list —
      // its Contract lives on `scheme/srfi-1`, which the oracle's harvest cannot see,
      // so `registry.lookup("filter")?.emit` is `undefined` here by design; its
      // EmitCtx-surface proof runs through `phase1Rules` in the sweep above instead
      // (the table row is the only reachable copy today — see phase1.ts's own
      // relocation note). `infer/chat/system`/`user`/`assistant` are `kind: "define"`
      // rows (unlike every other name in this list) — proof this sweep is genuinely
      // kind-agnostic, not accidentally native/rosetta-only.
      for (const name of [
        "=",
        "quotient",
        "modulo",
        "+",
        "-",
        "*",
        "/",
        "cons",
        "not",
        "null?",
        "pair?",
        "map",
        "apply",
        "infer",
        "infer/chat",
        "infer/chat/system",
        "infer/chat/user",
        "infer/chat/assistant",
      ]) {
        const rule = registry.lookup(name)?.emit;
        expect(rule, `expected a relocated emit rule for "${name}" on its own Contract — has it moved again?`).toBeDefined();
        const accessed = accessedCtxKeysAcrossArities(rule!);
        expectOnlySafeKeys(accessed, `the relocated "${name}" Contract rule`);
      }
    } finally {
      await session.dispose();
      cleanupOracleScratch();
    }
  }, 60_000);
});
