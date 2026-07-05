// lists-contract-precision.test.ts — RUNTIME proof that the scheme/lists precision fixes
// actually land on the REAL exported ops — not a synthetic mirror (see the sibling
// `lists.test-d.ts` for the type-level mechanism proofs, which must stay synthetic because
// `NativeSymbolDef.in`/`.out` erase `I`/`O` on any real export — see symbol.test-d.ts's
// "apply's own declared shape" note). Mirrors numeric-contract-precision.test.ts /
// bytevectors-contract-precision.test.ts's established pattern: a schema's PRECISION is only
// observable at runtime (zod's own `safeParse`) — native/sequence ops never run this
// validation during evaluation (see lists.ts's own module doc comment), so this is a
// HARVEST/type-surface proof, not a behavior change. The behavior-unchanged proof is the
// full existing suite (including src/__tests__/cyclic-list-ops.test.ts, clone-identity.test.ts,
// r7rs-identity.test.ts, which exercise these ops end-to-end through the interpreter) run
// byte-identical before/after (see the report).
//
// ★ CALIBRATION NOTE (same one contract-precision-fixes.test.ts's header flags): `z.value`
// (`z.custom<SchemeValue>()`) carries NO refinement — it accepts literally anything at
// runtime, byte-identical to `z.unknown()`. So a `z.unknown() → z.value` fix is a STATIC-ONLY
// precision improvement (the `.d.ts` harvest surface), with NO observable `.safeParse`
// difference — for THOSE fixes (cons, map, list-tail/list-ref/list-set!'s obj, memq-family's
// output-or-false, member/assoc's obj+compare) the real proof lives in the type-level
// `lists.test-d.ts` file, and this file only documents (not "proves a reject") the
// still-permissive runtime behavior where relevant. This file's assertions focus on the
// SUBSET of fixes that gained a genuine zod REFINEMENT (instanceof / Array.isArray /
// fixed-arity) and therefore reject a wrongly-shaped value the old `z.unknown()` accepted:
// make-list's output (now z.pair|z.nil), nth's index (now z.schemeNumber), list->array's
// output (now z.array(z.value) — Array.isArray refinement), tree->array's output (now
// z.array(...) too), and flatten's output (now a z.pair|z.nil|z.array(z.unknown()) union).
import { describe, expect, it } from "vitest";
import listsPack from "../lists.js";
import { signatureOf } from "../../../type-layer/schema-to-ts.js";
import type { AEntity } from "../../../common/symbol.js";
import { APair } from "../../../values/primitives/APair.js";
import { ANil, nil } from "../../../values/primitives/ANil.js";
import { AExact } from "../../../values/primitives/AExact.js";
import { AString } from "../../../values/primitives/AString.js";
import { CONSTANT_CTX } from "../../../values/primitives/RunContext.js";

const symbols = listsPack.spec.symbols as Record<string, AEntity>;

function nativeDef(name: string) {
  const def = symbols[name];
  if (def === undefined) throw new Error(`lists pack: no symbol named ${name}`);
  if (def.kind !== "native") throw new Error(`lists pack: ${name} is not a native def (got ${def.kind})`);
  return def;
}

function sequenceDef(name: string) {
  const def = symbols[name];
  if (def === undefined) throw new Error(`lists pack: no symbol named ${name}`);
  if (def.kind !== "sequence") throw new Error(`lists pack: ${name} is not a sequence def (got ${def.kind})`);
  return def;
}

const exact = (n: bigint | number): AExact => new AExact(CONSTANT_CTX, typeof n === "bigint" ? n : BigInt(n));
const str = (s: string): AString => new AString(CONSTANT_CTX, s);
const properList = (...items: unknown[]) => APair.fromArray(CONSTANT_CTX, items);
const fn = (..._args: unknown[]): boolean => false;

describe("scheme/lists Contract precision — genuinely REFINED schemas reject wrongly-shaped values (were z.unknown(), now zod-validated)", () => {
  it("make-list: output is now z.union([z.pair, z.nil]) (a proper list) — a raw non-list value used to slip through the old z.unknown()", () => {
    const def = nativeDef("make-list");
    expect(def.out.safeParse([nil]).success).toBe(true);
    expect(def.out.safeParse([properList(false, false)]).success).toBe(true);
    expect(def.out.safeParse(["not-a-list"]).success).toBe(false); // was true before the fix
    expect(def.out.safeParse([42]).success).toBe(false); // was true before the fix
    // fill (2nd input) stays permissive (z.value — genuinely "any scheme value", no
    // narrower domain makes sense for a fill value): still accepts anything.
    expect(def.in.safeParse([exact(3)]).success).toBe(true); // fill omitted (optional)
    expect(def.in.safeParse([exact(3), str("x")]).success).toBe(true);
    expect(def.in.safeParse(["not-a-scheme-number"]).success).toBe(false); // k must be schemeNumber
  });

  it("nth: index is now z.schemeNumber — a raw JS number/string used to slip through the old z.unknown()", () => {
    const def = nativeDef("nth");
    expect(def.in.safeParse([exact(0), properList(1, 2, 3)]).success).toBe(true);
    expect(def.in.safeParse([0, properList(1, 2, 3)]).success).toBe(false); // raw JS number, was true before the fix
    expect(def.in.safeParse(["0", properList(1, 2, 3)]).success).toBe(false); // raw JS string, was true before the fix
    // obj (2nd arg) stays z.unknown() BY DESIGN — nth is LIPS-polymorphic over array|pair,
    // and the array branch (`obj[idx]`) can return genuinely arbitrary host data (matches
    // `reverse`'s own established precedent in this file) — not a straggler, a deliberate
    // representation-blind domain.
    expect(def.in.safeParse([exact(0), [1, 2, 3]]).success).toBe(true); // raw JS array, deliberately still accepted
  });

  it("list->array: output is now z.array(z.value) — a non-array used to slip through the old z.unknown()", () => {
    const def = nativeDef("list->array");
    expect(def.out.safeParse([[exact(1), exact(2)]]).success).toBe(true);
    expect(def.out.safeParse([[]]).success).toBe(true); // empty array is a valid array
    expect(def.out.safeParse(["not-an-array"]).success).toBe(false); // was true before the fix
    expect(def.out.safeParse([properList(1, 2)]).success).toBe(false); // a Pair is not an array, was true before
  });

  it("tree->array: output is now z.array(...) (NestedArray element schema) — a non-array used to slip through the old z.unknown()", () => {
    const def = nativeDef("tree->array");
    expect(def.out.safeParse([[exact(1), [exact(2), exact(3)]]]).success).toBe(true);
    expect(def.out.safeParse(["not-an-array"]).success).toBe(false); // was true before the fix
  });

  it("flatten: output is now z.union([z.pair, z.nil, z.array(z.unknown())]) — a bare scalar used to slip through the old z.unknown()", () => {
    const def = nativeDef("flatten");
    expect(def.out.safeParse([properList(1, 2, 3)]).success).toBe(true);
    expect(def.out.safeParse([nil]).success).toBe(true);
    expect(def.out.safeParse([[exact(1), exact(2)]]).success).toBe(true); // `.flatten()`'s unknown[] arm
    expect(def.out.safeParse(["not-a-list-or-array"]).success).toBe(false); // was true before the fix
    expect(def.out.safeParse([42]).success).toBe(false); // was true before the fix
  });
});

describe("scheme/lists Contract precision — STATIC-only fixes (z.value carries no refinement; documented, not runtime-provable — see lists.test-d.ts for the real proof)", () => {
  it("cons: car/cdr accept any scheme value AND still accept a raw non-scheme value (z.value has no refinement) — the fix is the STATIC decoded type (unknown → SchemeValue), not a runtime behavior change", () => {
    const def = nativeDef("cons");
    expect(def.in.safeParse([exact(1), exact(2)]).success).toBe(true);
    expect(def.in.safeParse(["raw-js-string", 123]).success).toBe(true); // still true — z.value has no refinement
    expect(def.out.safeParse([new APair(CONSTANT_CTX, exact(1), nil)]).success).toBe(true);
  });

  it("map (sequence): head/rest/output are z.value-flavored (no refinement) — still permissive at runtime; the fix is the head/rest SPLIT + precise decoded types (see lists.test-d.ts)", () => {
    const def = sequenceDef("map");
    expect(def.in.safeParse([fn, properList(1, 2, 3)]).success).toBe(true);
    expect(def.in.safeParse([fn]).success).toBe(true); // 0 further lists — still legal (map over one term)
    // A z.tuple(fixed, rest) whose fixed head has NO refinement (a bare z.custom/z.unknown)
    // does NOT create an arity floor: zod treats a missing tuple position as `undefined`,
    // which an unrefined schema happily accepts (calibrated against the real zod 4.3.6
    // behavior — same quirk contract-precision-fixes.test.ts's header note documents).
    expect(def.in.safeParse([]).success).toBe(true);
  });

  it("list-tail / list-ref: output is z.value (no refinement) — a sublist/element can legitimately be ANY scheme value (an improper-list tail, or a car that's a bare number), so z.value (not a pair|nil union) is the honest ceiling", () => {
    const tailDef = nativeDef("list-tail");
    expect(tailDef.out.safeParse([properList(1, 2)]).success).toBe(true);
    expect(tailDef.out.safeParse([exact(42)]).success).toBe(true); // an improper-list tail is a valid result

    const refDef = nativeDef("list-ref");
    expect(refDef.out.safeParse([exact(42)]).success).toBe(true); // an element is any scheme value
  });

  it("list-set!: obj (3rd arg, the stored value) accepts any scheme value — was z.unknown(), now z.value (static-only, no refinement)", () => {
    const def = nativeDef("list-set!");
    expect(def.in.safeParse([properList(1, 2), exact(0), exact(99)]).success).toBe(true);
  });

  it("list-copy: input/output already z.value both sides — confirmed already precise, no change needed (output can legitimately be a non-list improper tail)", () => {
    const def = nativeDef("list-copy");
    expect(def.in.safeParse([properList(1, 2)]).success).toBe(true);
    expect(def.out.safeParse([properList(1, 2)]).success).toBe(true);
  });

  it("memq/assq: the search key (obj) stays z.unknown() BY DESIGN — eq?'s raw `===` identity compare is the canonical genuinely-representation-blind case scheme-zod.ts itself names", () => {
    expect(nativeDef("memq").in.safeParse(["anything-at-all", properList(1, 2)]).success).toBe(true);
    expect(nativeDef("assq").in.safeParse(["anything-at-all", properList(properList(1, 2))]).success).toBe(true);
  });

  it("memq/memv/assq/assv/member/assoc: output is now z.union([z.value, z.literal(false)]) — documents the REAL 'match or raw false sentinel' domain (both arms are still permissive at runtime: z.value has no refinement, and `false` is a real literal check — but the union as a whole still accepts anything, since the z.value arm alone succeeds unconditionally)", () => {
    for (const name of ["memq", "memv", "assq", "assv", "member", "assoc"]) {
      const def = nativeDef(name);
      expect(def.out.safeParse([properList(1, 2)]).success).toBe(true);
      expect(def.out.safeParse([false]).success).toBe(true);
      // Still permissive — z.value has no refinement, so this is NOT a reject-proof (unlike
      // the refined-schema tests above); the domain claim is verified at the TYPE level.
      expect(def.out.safeParse(["anything"]).success).toBe(true);
    }
  });

  it("member/assoc: obj accepts any scheme value (was z.unknown(), now z.value — static-only); compare predicate's return type is now `unknown` not `boolean` (matches the file's is_false-guarded actual usage, and srfi-1.ts filter's established convention)", () => {
    for (const name of ["member", "assoc"]) {
      const def = nativeDef(name);
      expect(def.in.safeParse([exact(1), properList(1, 2)]).success).toBe(true);
      expect(def.in.safeParse([exact(1), properList(1, 2), fn]).success).toBe(true);
    }
  });
});

describe("scheme/lists Contract precision — regression guard: unaffected/already-precise siblings stay untouched", () => {
  it("list: already z.array(z.value)/[z.value] — untouched by this pass (already precise before this audit)", () => {
    const def = nativeDef("list");
    expect(def.in.safeParse([exact(1), exact(2), exact(3)]).success).toBe(true);
    expect(def.in.safeParse([]).success).toBe(true); // 0-arg list is legal
  });

  it("length: already z.value/z.value — output MUST stay z.value (not narrowed to z.schemeNumber), because a still-filling collection's Tier-2 speculation returns an AHalfBaked, not an AExact/AInexact", () => {
    const def = nativeDef("length");
    expect(def.in.safeParse([properList(1, 2)]).success).toBe(true);
    expect(def.out.safeParse([exact(2)]).success).toBe(true);
  });

  it("append/clone/reverse/array->list: untouched — already at their honest precision ceiling (append/list are legitimately fully-variadic-over-SchemeValue; reverse/nth's array branch and array->list's borrowed-array input are genuinely representation-blind LIPS polymorphism)", () => {
    expect(nativeDef("append").in.safeParse([properList(1), properList(2)]).success).toBe(true);
    expect(nativeDef("clone").in.safeParse([properList(1)]).success).toBe(true);
    expect(nativeDef("reverse").in.safeParse([[1, 2, 3]]).success).toBe(true); // raw array, deliberately still accepted
    expect(nativeDef("array->list").in.safeParse([[1, 2, 3]]).success).toBe(true); // borrowed raw array
  });

  it("apply / for-each: already migrated to inputRest this session — untouched, glanced at only as the migration's own reference examples", () => {
    const applyDef = nativeDef("apply");
    expect(applyDef.in.safeParse([exact(1), exact(2), exact(3)]).success).toBe(true);
    const forEachDef = nativeDef("for-each");
    expect(forEachDef.in.safeParse([fn, properList(1, 2)]).success).toBe(true);
    expect(forEachDef.in.safeParse([fn, "not-a-list"]).success).toBe(false); // pre-existing fix, unaffected
  });
});

describe("scheme/lists Contract precision — blanket sweep: genuinely-variadic-and-still-unconstrained ops (regression guard)", () => {
  it("EVERY native/sequence op's Contract is precise, EXCEPT the four deliberately fully-polymorphic ops (list, append, apply, map) — a straggler here is an op whose EVERY element schema carries zero zod refinement, on both `.in` and `.out`", () => {
    // Mirrors numeric-contract-precision.test.ts's blanket sweep exactly, with ONE difference:
    // that sweep's baseline bug was uniform (every op flattened to z.array(z.unknown())), so its
    // acceptance bar is an empty stragglers list. lists.ts's bug was NEVER uniform (it's always
    // had a mix of fixed-tuple and variadic ops, and some z.unknown()/z.value uses are
    // load-bearing representation-blindness, not bugs) — a FIXED-arity contract whose element
    // schema itself carries a real zod refinement (instanceof/Array.isArray/z.literal — e.g.
    // for-each's now-z.union([pair,nil]) rest) genuinely rejects the random-content probe below,
    // so it is excluded regardless of arity shape. What DOES satisfy both probes: a contract
    // built ENTIRELY from no-refinement identity schemas (z.value / a bare z.custom callable) —
    // calibrated empirically against zod 4.3.6 (see the header note + the "map" test above): such
    // a schema creates no arity floor either (a missing tuple position parses as `undefined`,
    // which an unrefined schema accepts), so `safeParse([])` and `safeParse([garbage,...])` BOTH
    // succeed regardless of the op's real (fixed vs variadic) arity. Four ops in this file are
    // genuinely, by design, built entirely from such schemas: `list`/`append` (R7RS variadic
    // constructors over arbitrary scheme values) and `apply`/`map` (call an arbitrary procedure
    // over arbitrary scheme-value args/sequences — the "callable + z.value..." shape has no
    // refinement to give, by the nature of what these ops do). None of the four is a straggler
    // this audit should tighten further — every OTHER slot in the file that COULD carry a real
    // schema (a number, a list, a bytevector, a symbol, …) already does.
    const stragglers: string[] = [];
    for (const [name, def] of Object.entries(symbols)) {
      if (def.kind !== "native" && def.kind !== "sequence") continue;
      const inputStillDegraded =
        def.in.safeParse([]).success && def.in.safeParse(["anything", 123, null, {}, [1, 2, 3]]).success;
      const outputStillDegraded =
        def.out.safeParse(["anything"]).success && def.out.safeParse([{ garbage: true }]).success;
      if (inputStillDegraded && outputStillDegraded) stragglers.push(name);
    }
    expect(stragglers.sort()).toEqual(["append", "apply", "list", "map"]);
  });

  it("sanity: the pack exports exactly 28 symbols (the scope this review must cover)", () => {
    expect(Object.keys(symbols)).toHaveLength(28);
  });
});

describe("scheme/lists Contract precision — behavior spot-checks: is_pair-shadow swap (raw instanceof → the file's own SchemeValue-narrowing helper) is byte-identical at runtime", () => {
  // list-tail/list-ref/list-copy's bodies swap `x instanceof APair`/`x instanceof ANil` for the
  // file-local `is_pair`/`is_nil` shadow helpers SOLELY so `.car`/`.cdr` narrow to SchemeValue
  // (letting the tightened z.value OUTPUT typecheck) — is_pair/is_nil are themselves exactly
  // `o instanceof APair`/`o instanceof ANil` (value-guards.ts), so this is a proven no-op at
  // runtime. These spot-checks call the real bound impls directly (bypassing the interpreter)
  // to additionally confirm end-to-end — the interpreter-level proof is the untouched existing
  // suite (cyclic-list-ops.test.ts, clone-identity.test.ts, r7rs-identity.test.ts).
  it("list-tail behaves identically: walks k cdrs by reference, 0 steps returns the list itself", () => {
    const impl = nativeDef("list-tail").impl as (list: unknown, k: unknown) => unknown;
    const list = properList(exact(1), exact(2), exact(3)) as APair;
    expect(impl(list, exact(0))).toBe(list);
    expect(impl(list, exact(1))).toBe(list.cdr); // the (2 3) tail, by reference
    expect(impl(list, exact(3))).toBe(nil); // walked off the end of a proper list
  });

  it("list-ref behaves identically: returns the k-th car", () => {
    const impl = nativeDef("list-ref").impl as (list: unknown, k: unknown) => unknown;
    const list = properList(exact(10), exact(20), exact(30));
    expect((impl(list, exact(0)) as AExact).num).toBe(10n);
    expect((impl(list, exact(1)) as AExact).num).toBe(20n);
    expect((impl(list, exact(2)) as AExact).num).toBe(30n);
  });

  it("list-copy behaves identically: fresh spine, same elements, ANil-clone-aware (not === nil)", () => {
    const impl = nativeDef("list-copy").impl as (list: unknown) => unknown;
    const list = properList(exact(1), exact(2));
    const copy = impl(list) as APair;
    expect(copy).not.toBe(list);
    expect(copy.car).toBe((list as APair).car);
    expect(copy instanceof APair).toBe(true);
    // nil (the canonical singleton) still copies to the shared `nil`, not a clone.
    expect(impl(nil)).toBe(nil);
  });
});

describe("scheme/lists Contract.type overrides — the harvest signature (signatureOf) for the ops whose z.custom callable arg is UNREPRESENTABLE to the printer (it throws `Schemas of type \"custom\" cannot be represented`, degrading the WHOLE signature to the catch-all `(...args: unknown[]) => unknown`)", () => {
  // These five ops carry a z.custom<callable>() in their contract (map/for-each's fn head,
  // member/assoc's optional compare, tree->array's NestedArray output). The printer degrades
  // each to the bare `(...args: unknown[]) => unknown`, throwing away the fn-first structure,
  // the list receiver type, the void/`unknown | false` return, and (tree->array) the array
  // output + arity. `Contract.type` author-asserts the real shape — same trust model + same
  // this-session convention as the sibling srfi-1 `find` / srfi-95 `sort` overrides (a callable
  // renders as `(...args: unknown[]) => unknown`; a representation-AGNOSTIC receiver stays
  // `unknown` — map dispatches to Pair/Nil/Vector terms, so narrowing to a List would be false,
  // exactly sort's own documented reasoning; a genuinely list-only receiver is `Cons<unknown> |
  // null`, the same image the file's own non-degraded list ops harvest as).
  it("map (sequence): fn-first + representation-agnostic sequence rest — receiver/return stay `unknown` (dispatches to Pair/Nil/Vector, like sort), not narrowed to a List", () => {
    expect(signatureOf(sequenceDef("map"))).toBe("(fn: (...args: unknown[]) => unknown, ...lists: unknown[]) => unknown");
  });
  it("for-each: fn-first over list-only rest (its schema is z.union([pair,nil]), unlike map) → void", () => {
    expect(signatureOf(nativeDef("for-each"))).toBe(
      "(fn: (...args: unknown[]) => unknown, ...lists: (Cons<unknown> | null)[]) => void",
    );
  });
  it("member: obj + list + optional binary compare → matched sublist or #f (restores what the degraded `(...args: unknown[]) => unknown` lost)", () => {
    expect(signatureOf(nativeDef("member"))).toBe(
      "(obj: unknown, list: Cons<unknown> | null, compare?: (a: unknown, b: unknown) => unknown) => unknown | false",
    );
  });
  it("assoc: obj + alist + optional binary compare → matched entry or #f", () => {
    expect(signatureOf(nativeDef("assoc"))).toBe(
      "(obj: unknown, alist: Cons<unknown> | null, compare?: (a: unknown, b: unknown) => unknown) => unknown | false",
    );
  });
  it("tree->array: single tree arg → a nested JS array (the z.array(z.custom<NestedArray>()) output was unrepresentable, degrading arity + output)", () => {
    expect(signatureOf(nativeDef("tree->array"))).toBe("(tree: unknown) => unknown[]");
  });
});
