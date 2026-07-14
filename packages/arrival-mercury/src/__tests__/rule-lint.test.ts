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
 *  2. RUNTIME: every `phase1Rules` emit rule, plus the eight RELOCATED Contract rules
 *     (`=`/`quotient`/`modulo` in foundations/arrival/arrival/src/env/r7rs/numeric.ts
 *     Wave 1; `+`/`-`/`*`/`/` joining them there, `cons` in .../lists.ts, and
 *     `not`/`null?`/`pair?` in .../equality.ts, Wave 2 — all moved off this table per
 *     rules/phase1.ts's own relocation note), is executed — across a spread of
 *     arities, so every `exactly()`-gated branch gets a turn — against a Proxy-wrapped
 *     ctx that records every property GET. Every recorded key must be in the
 *     documented-safe set: this catches a hypothetical `(ctx as any).parentOf(...)`
 *     escape a pure type-level check cannot (a cast bypasses `tsc`, never a runtime
 *     property read) — "cheap but real" per the mission's own framing.
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

function probeCtx(accessed: Set<PropertyKey>): EmitCtx<R> {
  const base: EmitCtx<R> = {
    argFacts: [],
    config: { register: "run" },
    fresh: (hint) => Binding(hint),
    runtime: (symbol) => RuntimeRef(symbol),
    door: (reason) => {
      throw new Error(reason);
    },
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
    // actually exercised a non-trivial number of rules (today's table: ~14 rows, ~12
    // carry an `emit`; `every`/`any` are registry-presence-only, no rule). The bound
    // stays well below today's count deliberately — each future relocation wave
    // shrinks this table further, and a bound pinned to the exact count would need
    // touching every wave for no safety gain.
    expect(checked).toBeGreaterThan(8);
  });

  it("the eight RELOCATED Contract rules (=, quotient, modulo, +, -, *, /, cons, not, null?, pair?) only read the documented EmitCtx surface", async () => {
    const session = await openOracleSession();
    try {
      const registry = emitRegistryOf(session.ambient);
      // Wave 1 (=, quotient, modulo — numeric.ts) + Wave 2 (+, -, *, / — numeric.ts;
      // cons — lists.ts; not, null?, pair? — equality.ts). Eleven names, eight
      // symbols moved so far across the two waves (= counts once).
      for (const name of ["=", "quotient", "modulo", "+", "-", "*", "/", "cons", "not", "null?", "pair?"]) {
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
