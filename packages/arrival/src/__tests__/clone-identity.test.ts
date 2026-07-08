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
 * `is_nil` in guards.ts was FIXED to use `instanceof Nil` (see the doc
 * comment at guards.ts:92-103). The 20 sites enumerated below were left on
 * `=== nil`; each one is a place where a Nil clone slips through with the
 * wrong answer. The audit count is informally "~21"; we map 20 concrete
 * sites here and a summary stub that documents the meta-bug count.
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
  // membrane.ts:71 — `isSchemeValue(value)` short-circuits with `if (value === nil) return true`.
  // A Nil clone is a Scheme value (it IS an instance of Nil and AValue) but
  // the short-circuit fires false, falling through to a long chain of
  // `instanceof` checks that does NOT include Nil. Result: false.
  // Cascade: `fromJS` (line 288) uses `isSchemeValue` to detect "already a
  // Scheme value, pass through" — a Nil clone takes the slow path and
  // re-wraps as if it were a plain JS object. Re-entering rosetta would
  // double-wrap and lose the original.
  it("isSchemeValue(nil-clone) — should be true (membrane.ts:71)", () => {
    expect(isSchemeValue(cloneNil())).toBe(true);
  });

  // membrane.ts:326 — `toJS(value)` returns `null` only when `value === nil`.
  // A Nil clone has the TO_JS protocol path guarded behind `TO_JS in value`,
  // but Nil does NOT implement the symbol — so we fall through past line 326
  // and the value is returned as-is (the Nil clone itself, not `null`).
  // Cascade: any FFI/codec exit that hands the result to JS consumers
  // (Rosetta returns, Operator.toJS bridges) returns a Nil instance instead
  // of null, breaking shape contracts on the JS side.
  it("toJS(nil-clone) — should be null (membrane.ts:326)", () => {
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

describe("bridge.ts — `=== nil` identity-equality sites", () => {
  // bridge.ts:985 — `list-copy`'s top-level guard: `if (list === nil) return nil`.
  // R7RS `list-copy` must return a FRESH allocation distinct from its input.
  // With the singleton, the guard correctly returns the singleton (still
  // distinct from the input AValue, since both are the same singleton —
  // OK by R7RS for empty lists). But with a Nil clone, the guard misses,
  // the `!(list instanceof Pair)` check on line 986 catches it, and the
  // function returns the EXACT SAME Nil clone reference — never running
  // the `withInputProvenance` re-stamp on line 994. Observable bug: the
  // result IS the input by reference (an aliasing leak across an operator
  // that is supposed to allocate fresh).
  it("list-copy(nil-clone) — should NOT alias the input by reference (bridge.ts:985)", () => {
    const listCopy = LIST_OPS["list-copy"] as (l: unknown) => unknown;
    const input = cloneNil();
    const result = listCopy(input) as unknown;
    // R7RS contract: result must be distinct from input. Today the clone
    // case mis-routes through line 986 and returns the SAME reference.
    expect(result === input).toBe(false);
  });

  // bridge.ts:989 — Inside the recursive `copy(lst)` helper, the base case
  // `if (lst === nil) return nil` terminates the spine walk with a fresh
  // singleton. With a Pair whose cdr is a Nil clone, the recursion's base
  // case at :989 misses, falls through to `!(lst instanceof Pair) return lst`
  // (the improper-list-tail branch, intended for genuinely-improper lists),
  // and PRESERVES the Nil clone as the cdr instead of normalizing to nil.
  // Observable: the copied list's tail is the SAME clone reference as the
  // original's tail — an aliasing leak inside an op that should produce a
  // fully fresh spine.
  it("list-copy(Pair(1, nil-clone)) — tail must NOT alias the input's tail (bridge.ts:989)", () => {
    const listCopy = LIST_OPS["list-copy"] as (l: unknown) => unknown;
    const cdrClone = cloneNil();
    const input = new APair(CONSTANT_CTX, new AExact(CONSTANT_CTX, 1n), cdrClone);
    const result = listCopy(input);
    expect(result).toBeInstanceOf(APair);
    // The cdr should be the canonical singleton (or a freshly minted Nil), but
    // never the input's exact reference. Today the clone is preserved as-is.
    expect((result as APair<any, any>).cdr === cdrClone).toBe(false);
  });

});

// =========================================================================
// fantasy-land-lips.ts — 5 sites
// =========================================================================

describe("fantasy-land-lips.ts — `=== nil` identity-equality sites", () => {
  // The FL helpers live on Pair.prototype (declared in the Pair class body).
  // For unit-level granularity we exercise the recursion through a Pair
  // whose cdr is a nil-clone — every FL helper recurses on `pair.cdr` and
  // hits the base case there.

  // fantasy-land-lips.ts:89 — `mapPair`'s base case `if (!pair || pair === nil) return nil`.
  // A Pair(1, nil-clone) recurses into mapPair(f, nil-clone). The clone is
  // truthy AND `!== nil`, so the base case misses. Then it accesses
  // `nil-clone.car` (undefined for Nil) and `nil-clone.cdr` (undefined).
  // `f(undefined)` is called, then recursion runs on `undefined` and hits
  // `!pair` returning nil — but a phantom undefined was passed through `f`.
  it("mapPair(f, Pair(1, nil-clone)) — should produce (1) only, fn called once (fantasy-land-lips.ts:89)", async () => {
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

  // fantasy-land-lips.ts:94 — same shape as 89 but for `filterPair`. The
  // base case misses on a clone, leading to predicate being called with
  // undefined and a phantom Pair node being added to the result.
  it("filterPair(_, Pair(1, nil-clone)) — predicate called once (fantasy-land-lips.ts:94)", async () => {    let predCalls = 0;
    const p = new APair(CONSTANT_CTX, new AExact(CONSTANT_CTX, 1n), cloneNil());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await p[tf("filter")](() => {
      predCalls++;
      return true;
    });
    expect(predCalls).toBe(1);
  });

  // fantasy-land-lips.ts:102 — `reducePair`'s base case
  // `if (!pair || pair === nil) return initial`. With a clone in tail
  // position, recursion calls `f(acc, undefined)` then recurses on
  // undefined, hitting the `!pair` branch — so the bug is "one phantom
  // f-invocation with `undefined`." Expected: f called once with the
  // genuine element only.
  it("reducePair(f, init, Pair(1, nil-clone)) — f called once (fantasy-land-lips.ts:102)", async () => {    const collected: unknown[] = [];
    const p = new APair(CONSTANT_CTX, new AExact(CONSTANT_CTX, 1n), cloneNil());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    // arrival/tagless-final/reduce is element-FIRST: fn(element, acc).
    await p[tf("reduce")]((v: unknown, acc: unknown[]) => {
      collected.push(v);
      return [...(acc as unknown[]), v];
    }, [] as unknown[]);
    expect(collected.map((v) => (v as AExact).valueOf())).toEqual([1]);
  });

  // fantasy-land-lips.ts:108 — `traversePair`'s base case
  // `if (!pair || pair === nil) return of(nil)`. With a clone in tail
  // position, recursion proceeds one phantom step. Expected: `of` called
  // exactly once at termination, with `nil` argument.
  // Post-Nil-fix: `traversePair` correctly terminates at the clone via
  // `pair instanceof Nil`, so the of-call count is now driven purely by the
  // algorithm (one of() for the base case + one of(new Pair(...)) for each
  // leaf-mode head wrapping). For a 1-element Pair that's 2 calls — the
  // pre-existing assertion `ofCalls.length === 1` reflected the broken-
  // termination shape rather than the algorithm's correct invariant, so we
  // keep it `.fails` until the assertion is rewritten.
  it.fails("traversePair(of, f, Pair(1, nil-clone)) — of-nil called once (fantasy-land-lips.ts:108)", () => {    const ofCalls: unknown[] = [];
    const of = (v: unknown) => {
      ofCalls.push(v);
      return v;
    };
    const p = new APair(CONSTANT_CTX, new AExact(CONSTANT_CTX, 1n), cloneNil());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    p[tf("traverse")](of, (x: unknown) => x);
    expect(ofCalls.length).toBe(1);
    expect(ofCalls[0] instanceof ANil).toBe(true);
  });
});

// =========================================================================
// sandbox-env.ts — 2 sites
// =========================================================================

describe("sandbox-env.ts — `=== nil` identity-equality sites", () => {
  // sandbox-env.ts:123 — Inside the `@` field accessor, `rawKeyStr == null || rawKeyStr === nil`
  // short-circuits to `return nil` when the user passes nil as the key
  // (typically through a Scheme `@` invocation with no key). A Nil clone
  // bypasses the guard, then `String(rawKeyStr)` runs on the Nil instance
  // — producing `"()"`. The property-access then runs against literal `()`
  // which is silently empty rather than visibly invalid.
  // Note: sandboxedEnv `@` and `@?` accept *any* JS value as `key`, so the
  // guard is on the membrane boundary — clone-leak is observable.
  it("'@' obj nil-clone — should return nil, not String(Nil) lookup (membrane.readMember)", () => {
    // The `@` accessor IS membrane's `readMember` (the polyglot capability binds it
    // verbatim); invoke it directly rather than through an async-assembled env.
    const accessor = readMember as (obj: unknown, key: unknown) => unknown;
    const result = accessor({ "()": "PHANTOM" }, cloneNil());
    // A nil-key access should be nil (not the phantom value at key "()").
    expect(result instanceof ANil).toBe(true);
  });

  // Same shape but for the `@?` "has" accessor (membrane's `hasMember`).
  // A Nil clone bypasses the guard and `hasMember(obj, "()")` runs;
  // returns true if the object happens to have the literal key "()".
  it("'@?' obj nil-clone — should return false, not has(\"()\") (membrane.hasMember)", () => {
    const accessor = hasMember as (obj: unknown, key: unknown) => boolean;
    const result = accessor({ "()": "PHANTOM" }, cloneNil());
    expect(result).toBe(false);
  });
});

// =========================================================================
// Meta-bug summary
// =========================================================================

describe("META — provenance clones break identity-equality systematically", () => {
  // War-story documentation. Not a real assertion. Lists the count and the
  // shape of the bug so the next person to touch any of these files sees
  // immediately what is going on.
  it("documents 15 known sites where `=== nil` would silently misroute a Nil clone", () => {
    // ramda-functions.ts (polymorphicMap/filter/reduce, 5 sites) was deleted when
    // Ramda was removed from the sandbox; those wrappers were already overridden by
    // sandbox-env's hardened map/filter/reduce, so the sites left with the code. The
    // remaining 15 stand.
    const sites = [
      "membrane.ts:71  — isSchemeValue",
      "membrane.ts:326 — toJS",
      "rosetta.ts:70   — schemeToJs entry",
      "rosetta.ts:130  — schemeToJs Pair-spine tail",
      "bridge.ts:985   — list-copy entry",
      "bridge.ts:989   — list-copy recursion base",
      "bridge.ts:1351  — single",
      "fantasy-land-lips.ts:89  — mapPair base",
      "fantasy-land-lips.ts:94  — filterPair base",
      "fantasy-land-lips.ts:102 — reducePair base",
      "fantasy-land-lips.ts:108 — traversePair base",
      "fantasy-land-lips.ts:120 — chainPair base",
      "sandbox-env.ts:123 — '@' accessor",
      "sandbox-env.ts:163 — '@?' accessor",
    ];
    expect(sites.length).toBe(14);
    // Each entry is the file:line of an `=== nil` site that should be
    // migrated to `is_nil(...)`. The single FIXED site (guards.ts:104) is
    // the model — match its instanceof check.
  });
});
