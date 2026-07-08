/**
 * Granular per-site coverage of the `=== nil` identity-equality meta-bug.
 *
 * Background — what the bug is and why it matters
 * -----------------------------------------------
 * `Nil` extends `AValue`, and AValue.withProvenance(p) returns a FRESH instance
 * (see types.ts:87 — `withProvenance(p) { return new Nil(p); }`). Every
 * Scheme-side codepath that touches a `Nil` value through the provenance
 * machinery (most notably `restrictControlFlowProvenance` at evaluator.ts:627,
 * plus the rosetta wrapper at rosetta.ts:217-223) can mint a `Nil` instance
 * that is OBSERVABLY identical to `nil` (same class, same `toJs() === null`,
 * same `toString() === "()"`) but FAILS `=== nil` because it is a different
 * heap object.
 *
 * `is_nil` (now `value-guards.ts:46`, re-exported by `eval/guards.ts`) was
 * FIXED to use `instanceof ANil` (see the doc comment at value-guards.ts:34-45).
 * The sites enumerated below were once left on `=== nil`; each is a place
 * where a Nil clone could slip through with the wrong answer. As of
 * 2026-07-08 every cited site below has been re-verified against current
 * source (see the per-`describe` notes) — most are already fixed, so this
 * file now doubles as the regression suite proving the fix holds rather than
 * a live bug catalogue. The one remaining open gap (`rosetta.ts:70`) stays
 * `it.fails`. The original 14-site war-story ledger lives at
 * `docs/archaeology/nil-clone-sweep.md`.
 *
 * Test shape
 * ----------
 * One test per site. Each `it.fails` block:
 *   - quotes the file:line of the bug source,
 *   - mints a nil clone via `nil.withProvenance(new Set([42]))`,
 *   - exercises ONLY the path gated by that `=== nil` check,
 *   - asserts the value `is_nil`-equivalent and behavior-equivalent should produce.
 *
 * When a fix lands, removing `.failing` flips the test green; the test file
 * doubles as the migration acceptance suite.
 */

import { describe, expect, it } from "vitest";
import { CONSTANT_CTX } from "../values/primitives/RunContext.js";
import { hasMember, isSchemeValue, readMember, toJS } from "../membrane.js";
import { schemeToJs } from "../rosetta.js";
import listsCap from "../env/r7rs/lists.js";
import type { EnvCapability } from "../common/capability.js";
import { APair } from "../values/primitives/APair.js";
import { ANil, nil } from "../values/primitives/ANil.js";
import { tf } from "../values/tagless-final.js";
import { AExact } from "../values/primitives/AExact.js";

// A nil clone carrying non-empty provenance — exactly what
// `restrictControlFlowProvenance` (evaluator.ts:627) hands back when an `if`
// arm resolves to nil while the predicate carries provenance. Same shape the
// rosetta wrapper mints for AValue results (rosetta.ts:217-223).
const cloneNil = (origin = 42) => nil.withProvenance(new Set<number>([origin]));

// Source op fns FROM THE CAPABILITY's inlined `symbols` (the bare *_OPS map was
// inlined into the constructor; the capability default export is the single
// declaration site). These packs are all the record form of `spec.symbols`.
const opsOf = (cap: EnvCapability): Record<string, (...a: any[]) => any> =>
  Object.fromEntries(
    // Migrated packs expose `symbol.native` defs (`{ kind: "native", impl }`); the legacy
    // `{ value }` form is the fallback for any entry not yet on the symbol.* API. A symbol
    // whose def is neither (a rosetta `{ fn }`, a `door`, etc.) carries no bare op fn — it
    // is not an "op" in the sense these tests exercise, so it is filtered out, leaving a
    // record of genuine callables (no `undefined` slips into the result type).
    Object.entries(cap.spec.symbols as Record<string, { impl?: unknown; value?: unknown }>)
      .map(([k, v]) => [k, v.impl ?? v.value] as const)
      .filter((entry): entry is [string, (...a: any[]) => any] => typeof entry[1] === "function"),
  );
const LIST_OPS = opsOf(listsCap);

// Sanity check: confirm the witness has the right shape before any sites
// are exercised. If this breaks, every test below is meaningless.
describe("nil-clone witness sanity (NOT a bug — guards the test fixture)", () => {
  it("clone is an instance of Nil", () => {
    expect(cloneNil()).toBeInstanceOf(ANil);
  });
  it("clone is_nil-true (guards.ts uses instanceof — the FIXED path)", () => {
    expect(cloneNil() instanceof ANil).toBe(true);
  });
  it("clone is NOT === nil (heap-distinct from the singleton)", () => {
    expect(cloneNil() === nil).toBe(false);
  });
  it("clone carries the supplied provenance", () => {
    expect([...cloneNil(7).provenance]).toEqual([7]);
  });
  it("clone serializes the same as nil", () => {
    expect(cloneNil()["arrival/toJS"]()).toBe(null);
    expect(cloneNil().toString()).toBe("()");
  });
});

// =========================================================================
// membrane.ts — 2 sites
// =========================================================================

describe("membrane.ts — `=== nil` identity-equality sites", () => {
  // FIXED (verified against current source, 2026-07-08): `isSchemeValue`
  // (membrane.ts:139) no longer special-cases nil at all — it dispatches on
  // `value instanceof AValue` (a Nil clone IS an AValue) plus the few
  // explicit non-AValue control-form arms (R3, RULINGS.md). A Nil clone
  // recognizes correctly with no `=== nil` short-circuit in the path.
  it("isSchemeValue(nil-clone) — is true (membrane.ts:139, instanceof AValue dispatch)", () => {
    expect(isSchemeValue(cloneNil())).toBe(true);
  });

  // FIXED (verified against current source, 2026-07-08): `toJS(value)`
  // (membrane.ts:240) has no `=== nil` special case at all — it calls
  // `value["arrival/toJS"]()` unconditionally for any `isSchemeValue`. Nil's
  // own `arrival/toJS` implementation returns `null` regardless of whether
  // the instance is the singleton or a provenance-bearing clone.
  it("toJS(nil-clone) — is null (membrane.ts:240, full protocol dispatch)", () => {
    expect(toJS(cloneNil())).toBe(null);
  });
});

// =========================================================================
// rosetta.ts — 2 sites
// =========================================================================

describe("rosetta.ts — `=== nil` identity-equality sites", () => {
  // rosetta.ts:70 — `schemeToJs(value)` short-circuits `value == null || value === nil`
  // by returning the value as-is. A Nil clone fails BOTH checks (it is not
  // nullish, and not === nil), so control falls through the function body.
  // It is not a SchemeExact/SchemeInexact/SchemeJSObject/AJSArray/
  // SchemeBool/SchemeString/Pair/plain-object — so the final `return value`
  // (line 156) hands back the Nil instance. JS-side consumers expecting
  // `null` (the contract that `value === nil` is supposed to give them) see
  // a Nil object instead.
  it.fails("schemeToJs(nil-clone) — should return null/undefined (rosetta.ts:70)", () => {
    // The current `schemeToJs(nil)` returns `nil` itself (note: this branch
    // actually returns `value` not `null` — it is the `== null` branch's
    // shared exit). Whatever the singleton returns, the clone must match.
    const singletonResult = schemeToJs(nil);
    expect(schemeToJs(cloneNil())).toEqual(singletonResult);
  });

  // rosetta.ts:130 — Inside the Pair-spine recursion, the tail is converted
  // via `schemeToJs(value.cdr)`; the branch `else if (tail === nil)` decides
  // whether to return `[head]` (proper-list terminator) vs `[head, tail]`
  // (dotted-pair). A Pair whose cdr is a Nil clone takes the dotted-pair
  // branch and returns `[head, Nil{}]` instead of `[head]`. Reproducible
  // by handing a Pair-with-nil-clone-cdr to schemeToJs.
  it("schemeToJs(Pair(1, nil-clone)) — proper list, not dotted (rosetta.ts:130)", () => {
    // Note: schemeToJs first recurses into `cdr`, so the inner `=== nil` at
    // line 70 also fires false for the clone. The `tail === nil` check at
    // line 130 then sees the Nil clone again (not coerced) and dispatches
    // to the dotted-pair branch. Expected: a proper list [1].
    const p = new APair(CONSTANT_CTX, new AExact(CONSTANT_CTX, 1n), cloneNil());
    expect(schemeToJs(p)).toEqual([1]);
  });
});

// =========================================================================
// bridge.ts — 3 sites
// =========================================================================

describe("list-copy (env/r7rs/lists.ts, formerly bridge.ts) — `=== nil` identity-equality sites", () => {
  // FIXED (verified against current source, 2026-07-08): `bridge.ts` no
  // longer contains `list-copy` at all (down to 137 lines); the op lives in
  // `env/r7rs/lists.ts`. R7RS `list-copy` must return a FRESH allocation
  // distinct from its input. The top-level guard (lists.ts:450) is
  // `if (list instanceof ANil) return nil` — catches both the singleton AND
  // any provenance-bearing clone, so a clone input no longer mis-routes
  // through the improper-list branch and alias the input by reference.
  it("list-copy(nil-clone) — does NOT alias the input by reference (env/r7rs/lists.ts:450)", () => {
    const listCopy = LIST_OPS["list-copy"] as (l: unknown) => unknown;
    const input = cloneNil();
    const result = listCopy(input) as unknown;
    // R7RS contract: result must be distinct from input.
    expect(result === input).toBe(false);
  });

  // FIXED (verified against current source, 2026-07-08): the recursive
  // `copy(lst)` helper's base case (lists.ts:455) is likewise
  // `if (lst instanceof ANil) return nil` — a Pair whose cdr is a Nil clone
  // terminates the recursion correctly and normalizes to the canonical `nil`
  // instead of preserving the clone as an aliased tail reference.
  it("list-copy(Pair(1, nil-clone)) — tail does NOT alias the input's tail (env/r7rs/lists.ts:455)", () => {
    const listCopy = LIST_OPS["list-copy"] as (l: unknown) => unknown;
    const cdrClone = cloneNil();
    const input = new APair(CONSTANT_CTX, new AExact(CONSTANT_CTX, 1n), cdrClone);
    const result = listCopy(input);
    expect(result).toBeInstanceOf(APair);
    // The cdr should be the canonical singleton, never the input's exact reference.
    expect((result as APair<any, any>).cdr === cdrClone).toBe(false);
  });

});

// =========================================================================
// fantasy-land-lips.ts no longer exists — the algebra lives directly on
// APair (src/values/primitives/APair.ts, the `arrival/tagless-final/*` term
// methods)
// =========================================================================

describe("APair.ts tagless-final map/filter/reduce/traverse (formerly fantasy-land-lips.ts) — `=== nil` identity-equality sites", () => {
  // The algebra terms live directly on APair (declared in the class body,
  // `arrival/tagless-final/map` etc.). For unit-level granularity we exercise
  // the recursion through a Pair whose cdr is a nil-clone — every term walks
  // `node instanceof APair` and stops the walk there.

  // FIXED (verified against current source, 2026-07-08): `arrival/tagless-final/map`
  // (APair.ts, "Functor" section) walks `while (node instanceof APair)` — a
  // Nil clone is NOT an APair (it's ANil), so the walk terminates correctly
  // regardless of which provenance the clone carries; no phantom `undefined`
  // element is ever produced.
  it("mapPair(f, Pair(1, nil-clone)) — produces (1) only, fn called once (APair.ts arrival/tagless-final/map)", async () => {
    // mapPair is not exported; invoke via the FL protocol installed on Pair.prototype.
    const calls: unknown[] = [];
    const p = new APair(CONSTANT_CTX, new AExact(CONSTANT_CTX, 1n), cloneNil());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await p[tf("map")]((x) => {
      calls.push(x);
      // `x` (`APairAsListValue<AExact, ANil>`) is itself always a `SchemeValue`, which is
      // exactly what the map callback's honest signature now asks for — no cast needed.
      return x;
    });
    expect(calls.map((v) => (v as AExact).valueOf())).toEqual([1]);
    expect(result).toBeInstanceOf(APair);
    expect((result as APair<any, any>).cdr instanceof ANil).toBe(true);
  });

  // FIXED (verified against current source, 2026-07-08): `arrival/tagless-final/filter`
  // (APair.ts, "Filterable" section) uses the same `while (node instanceof APair)`
  // walk — a Nil clone in tail position ends the walk cleanly, no phantom
  // predicate invocation.
  it("filterPair(_, Pair(1, nil-clone)) — predicate called once (APair.ts arrival/tagless-final/filter)", async () => {    let predCalls = 0;
    const p = new APair(CONSTANT_CTX, new AExact(CONSTANT_CTX, 1n), cloneNil());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await p[tf("filter")](() => {
      predCalls++;
      return true;
    });
    expect(predCalls).toBe(1);
  });

  // FIXED (verified against current source, 2026-07-08): `arrival/tagless-final/reduce`
  // (APair.ts) walks `while (node instanceof APair)` — a Nil-clone tail ends
  // the fold cleanly, `fn` is called exactly once per genuine element, never
  // with a phantom `undefined`.
  it("reducePair(f, init, Pair(1, nil-clone)) — f called once (APair.ts arrival/tagless-final/reduce)", async () => {    const collected: unknown[] = [];
    const p = new APair(CONSTANT_CTX, new AExact(CONSTANT_CTX, 1n), cloneNil());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    // arrival/tagless-final/reduce is element-FIRST: fn(element, acc).
    await p[tf("reduce")]((v: unknown, acc: unknown[]) => {
      collected.push(v);
      return [...(acc as unknown[]), v];
    }, [] as unknown[]);
    expect(collected.map((v) => (v as AExact).valueOf())).toEqual([1]);
  });

  // FIXED + REWRITTEN (2026-07-08): `traversePair` (APair.ts, the free
  // function backing `arrival/tagless-final/traverse`) terminates correctly
  // at a Nil clone via its own `while (node instanceof APair)` collection
  // loop. The FORMER assertion here (`ofCalls.length === 1`) was a stale
  // artifact of the pre-fix broken-termination shape, not the algorithm's
  // actual invariant — `of` is called ONCE for the `nil` base-case seed
  // (`acc = of(nil)`) and ONCE MORE per leaf-mode head wrap
  // (`of(new APair(ctx, mappedCar, acc))`, since no element here implements
  // `ap`), so a 1-element list produces exactly 2 `of` calls: the base case
  // first (right-fold, innermost first), then the single leaf wrap.
  it("traversePair(of, f, Pair(1, nil-clone)) — of called once for the nil base case + once per leaf wrap (APair.ts traversePair)", () => {
    const ofCalls: unknown[] = [];
    const of = (v: unknown) => {
      ofCalls.push(v);
      return v;
    };
    const p = new APair(CONSTANT_CTX, new AExact(CONSTANT_CTX, 1n), cloneNil());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    p[tf("traverse")](of, (x: unknown) => x);
    expect(ofCalls.length).toBe(2);
    expect(ofCalls[0] instanceof ANil).toBe(true);
  });
});

// =========================================================================
// sandbox-env.ts no longer exists — the `@`/`@?` accessors are membrane.ts's
// readMember/hasMember
// =========================================================================

describe("membrane.ts readMember/hasMember (formerly sandbox-env.ts) — `=== nil` identity-equality sites", () => {
  // FIXED (verified against current source, 2026-07-08): `readMember`
  // (membrane.ts:269) guards with `if (rawKey == null || rawKey instanceof ANil) return nil`
  // — a Nil clone is caught by the `instanceof` arm, so it never falls
  // through to `String(rawKey)` and a spurious `"()"` key lookup.
  it("'@' obj nil-clone — returns nil, not String(Nil) lookup (membrane.ts:269 readMember)", () => {
    // The `@` accessor IS membrane's `readMember` (the polyglot capability binds it
    // verbatim); invoke it directly rather than through an async-assembled env.
    const accessor = readMember as (obj: unknown, key: unknown) => unknown;
    const result = accessor({ "()": "PHANTOM" }, cloneNil());
    // A nil-key access should be nil (not the phantom value at key "()").
    expect(result instanceof ANil).toBe(true);
  });

  // FIXED (verified against current source, 2026-07-08): `hasMember`
  // (membrane.ts:312) has the identical `instanceof ANil` guard.
  it("'@?' obj nil-clone — returns false, not has(\"()\") (membrane.ts:312 hasMember)", () => {
    const accessor = hasMember as (obj: unknown, key: unknown) => boolean;
    const result = accessor({ "()": "PHANTOM" }, cloneNil());
    expect(result).toBe(false);
  });
});

// The META war-story ledger (the original 14-site count + narrative) moved to
// docs/archaeology/nil-clone-sweep.md (2026-07-08 test-invariant-atlas sweep,
// docs/test-suite-v2/REMOVAL-MANIFEST.md) — `expect(sites.length).toBe(14)`
// tested nothing observable and belongs in docs, not as a test assertion.
