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
// make-list's output (now z.pair|z.nil), nth's index (now z.schemeNumber), and list->array's
// output (now z.array(z.value) — Array.isArray refinement).
import { describe, expect, it } from "vitest";
import listsPack from "../lists.js";
import dedent from "dedent";
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
import { signatureOf } from "../../../type-layer/schema-to-ts.js";
import type { AEntity } from "../../../common/symbol.js";
import { APair } from "../../../values/primitives/APair.js";
import { ANil, nil } from "../../../values/primitives/ANil.js";
import { AExact } from "../../../values/primitives/AExact.js";
import { AString } from "../../../values/primitives/AString.js";
import { CONSTANT_CTX } from "../../../values/primitives/RunContext.js";
import { schemeFalse } from "../../../values/primitives/ABool.js";
import type { SchemeValue } from "../../../values/types.js";

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

const exact = (n: number): AExact => new AExact(CONSTANT_CTX, n);
const str = (s: string): AString => new AString(CONSTANT_CTX, s);
// Adversarial fixture: `properList` deliberately builds pair-chains over non-SchemeValue
// elements too (raw JS numbers/functions — see call sites below) to probe zod schema
// REJECTION under this file's own precision fixes. `fromArray`'s `T extends SchemeValue`
// constraint targets genuine callers; construction itself never dereferences element
// shape, only the zod schemas under test do — the cast documents that mismatch.
const properList = (...items: unknown[]) => APair.fromArray(CONSTANT_CTX, items as SchemeValue[]);
const fn = (..._args: unknown[]): boolean => false;

describe("scheme/lists Contract precision — genuinely REFINED schemas reject wrongly-shaped values (were z.unknown(), now zod-validated)", () => {
  // INVARIANT: make-list's output must be a proper list (pair or nil); fill stays
  // representation-blind, k must be a scheme number
  it("make-list: output is now z.union([z.pair, z.nil]) (a proper list) — a raw non-list value used to slip through the old z.unknown()", () => {
    const def = nativeDef("make-list");
    expect(def.out.safeParse([nil]).success).toBe(true);
    // REBASELINE (fe2c848ee7, 2026-07-08): z.pair is now cons(value, value), a real codec that
    // validates car/cdr recursively via z.value (isSchemeValue) — a raw JS `false` element (as
    // this row originally used) no longer parses; boxed `schemeFalse` is the honest scheme value.
    expect(def.out.safeParse([properList(schemeFalse, schemeFalse)]).success).toBe(true);
    expect(def.out.safeParse(["not-a-list"]).success).toBe(false); // was true before the fix
    expect(def.out.safeParse([42]).success).toBe(false); // was true before the fix
    // fill (2nd input) stays permissive (z.value — genuinely "any scheme value", no
    // narrower domain makes sense for a fill value): still accepts anything.
    expect(def.in.safeParse([exact(3)]).success).toBe(true); // fill omitted (optional)
    expect(def.in.safeParse([exact(3), str("x")]).success).toBe(true);
    expect(def.in.safeParse(["not-a-scheme-number"]).success).toBe(false); // k must be schemeNumber
  });

  // INVARIANT: nth's index must be a real scheme number; obj deliberately stays
  // representation-blind (array|pair polymorphism)
  it("nth: index is now z.schemeNumber — a raw JS number/string used to slip through the old z.unknown()", () => {
    const def = nativeDef("nth");
    expect(def.in.safeParse([exact(0), properList(1, 2, 3)]).success).toBe(true);
    expect(def.in.safeParse([0, properList(1, 2, 3)]).success).toBe(false); // raw JS number, was true before the fix
    expect(def.in.safeParse(["0", properList(1, 2, 3)]).success).toBe(false); // raw JS string, was true before the fix
    // REBASELINE: the uniform-scheme-zod-vocabulary migration (docs/working-proposals/
    // uniform-scheme-zod-vocabulary.md) retired z.unknown() from this env layer entirely —
    // scheme-zod.ts's v2 doesn't even re-export it (see srfi-95.ts's own note: "z.value is the
    // typed replacement for z.unknown() at exactly this kind of native scheme-value slot"). So
    // obj is z.value (isSchemeValue: instanceof AValue or a function), NOT genuinely host-blind
    // — a raw JS array is now a KNOWN, acknowledged harvest-precision gap (nth's runtime `else
    // if (Array.isArray(obj))` branch still works fine; the ZOD SCHEMA just doesn't model that
    // domain member — Contract.type's own author-asserted signature `<T>(index: number, list:
    // T[]): T | null` already documents the real intent, independent of this schema).
    expect(def.in.safeParse([exact(0), [1, 2, 3]]).success).toBe(false); // raw JS array, genuinely rejected by z.value
  });

  // @ledger: list->array phantom symbol — test targets a never-bound scheme name
  // GAP (src/__tests__/ledger/index.law.test.ts GAPS table, id above): repo-wide grep confirms
  // no pack (r7rs, srfi, or the legacy env/lists.ts) has ever bound a scheme symbol literally
  // named "list->array" — R7RS itself has no such builtin (only vector->list/list->vector).
  // `list->array` is purely an internal error-message LABEL (`to_array("list->array")`, this
  // file's lists.ts / strings.ts) for the pack-local `listToArray` helper, never an exported
  // native def. This row predates the LIPS-legacy dissolution sweep (the sibling
  // "append/reverse: untouched" test in this file documents array->list's own dissolution) —
  // it.fails, not it.todo: there's no live plan to ADD a bound "list->array" symbol; this row
  // just needs retiring/redirecting once someone owns the sunset-suite cleanup pass.
  it.fails("list->array: output is now z.array(z.value) — a non-array used to slip through the old z.unknown()", () => {
    const def = nativeDef("list->array");
    expect(def.out.safeParse([[exact(1), exact(2)]]).success).toBe(true);
    expect(def.out.safeParse([[]]).success).toBe(true); // empty array is a valid array
    expect(def.out.safeParse(["not-an-array"]).success).toBe(false); // was true before the fix
    expect(def.out.safeParse([properList(1, 2)]).success).toBe(false); // a Pair is not an array, was true before
  });

  // INVERTED (docs/design-history/halfbaked-existence-review.md, VERDICT KILL): output was
  // pinned z.value ONLY because a still-filling collection's Tier-2 speculation could hand back
  // a live AHalfBaked carrier instead of a settled number — the carrier is gone, so the
  // permissive schema was never really "genuinely representation-blind," it was a residue of a
  // dead feature. Now a genuine zod refinement: a raw non-number no longer slips through.
  it("length: output narrows z.value → z.schemeNumber — the HalfBaked carrier return died with AHalfBaked itself, so length always returns a settled AExact/AInexact", () => {
    const def = nativeDef("length");
    expect(def.in.safeParse([properList(1, 2)]).success).toBe(true);
    expect(def.out.safeParse([exact(2)]).success).toBe(true);
    expect(def.out.safeParse(["not-a-number"]).success).toBe(false); // was true before the fix (z.value)
    expect(def.out.safeParse([{ garbage: true }]).success).toBe(false); // was true before the fix (z.value)
  });
});

describe("scheme/lists Contract precision — STATIC-only fixes (documented, not runtime-provable — see lists.test-d.ts for the real proof)", () => {
  // REBASELINE: z.value (isSchemeValue) DOES carry a real refinement — `instanceof AValue ||
  // typeof === "function"` (common/scheme-zod.ts) — it is not z.unknown()'s alias. A raw JS
  // string/number genuinely fails it; this row's original "still true" premise was never
  // actually true under isSchemeValue (verified against v1's own union-of-boxed-types `value`
  // too — see git history). What the fix DID change is the STATIC decoded type (unknown →
  // SchemeValue); the runtime domain was always "any BOXED scheme value," not "any raw value."
  // INVARIANT: cons's car/cdr accept any scheme value at runtime unchanged — the fix is
  // static-only
  it("cons: car/cdr accept any BOXED scheme value; a raw non-scheme value is genuinely rejected (z.value = isSchemeValue, a real refinement) — the fix is the STATIC decoded type (unknown → SchemeValue), not a runtime behavior change", () => {
    const def = nativeDef("cons");
    expect(def.in.safeParse([exact(1), exact(2)]).success).toBe(true);
    expect(def.in.safeParse(["raw-js-string", 123]).success).toBe(false); // genuinely rejected — z.value refines
    expect(def.out.safeParse([new APair(CONSTANT_CTX, exact(1), nil)]).success).toBe(true);
  });

  // INVARIANT: map's head gained a real callable (z.lambda) refinement creating a genuine
  // arity floor, rest/output stay permissive
  it("map (sequence): rest/output are z.value-flavored (no refinement) — still permissive at runtime for the rest+output; the fix is the head/rest SPLIT + precise decoded types (see lists.test-d.ts). The HEAD did later gain a real z.lambda refinement (the uniform-vocabulary migration), so — unlike when this test was authored — it now DOES create a genuine arity floor.", () => {
    const def = sequenceDef("map");
    expect(def.in.safeParse([fn, properList(1, 2, 3)]).success).toBe(true);
    expect(def.in.safeParse([fn]).success).toBe(true); // 0 further lists — still legal (map over one term)
    // z.lambda's predicate is `typeof v === "function"` — a MISSING head position decodes to
    // `undefined`, which fails that check, so an empty array is now genuinely rejected (unlike
    // a bare z.custom/z.unknown head, which would have accepted it — the quirk this test
    // originally calibrated against no longer applies to map's head specifically).
    expect(def.in.safeParse([]).success).toBe(false);
  });

  // INVARIANT: list-tail / list-ref's output stays representation-blind since a
  // sublist/element can be any scheme value
  it("list-tail / list-ref: output is z.value (no refinement) — a sublist/element can legitimately be ANY scheme value (an improper-list tail, or a car that's a bare number), so z.value (not a pair|nil union) is the honest ceiling", () => {
    const tailDef = nativeDef("list-tail");
    expect(tailDef.out.safeParse([properList(1, 2)]).success).toBe(true);
    expect(tailDef.out.safeParse([exact(42)]).success).toBe(true); // an improper-list tail is a valid result

    const refDef = nativeDef("list-ref");
    expect(refDef.out.safeParse([exact(42)]).success).toBe(true); // an element is any scheme value
  });

  // INVARIANT: list-set! has been doored this session — no longer a native op at all
  // (pins implementation, not behavior)
  it("list-set!: doored this session (mutation violates value provenance) — no longer a native def to probe", () => {
    expect(symbols["list-set!"].kind).toBe("door");
  });

  // INVARIANT: list-copy's input/output were already fully precise before this audit
  it("list-copy: input/output already z.value both sides — confirmed already precise, no change needed (output can legitimately be a non-list improper tail)", () => {
    const def = nativeDef("list-copy");
    expect(def.in.safeParse([properList(1, 2)]).success).toBe(true);
    expect(def.out.safeParse([properList(1, 2)]).success).toBe(true);
  });

  // REBASELINE: the uniform-scheme-zod-vocabulary migration retired z.unknown() from this env
  // layer entirely (scheme-zod.ts v2 doesn't re-export it — see srfi-95.ts's own note: "z.value
  // is the typed replacement for z.unknown() at exactly this kind of native scheme-value slot").
  // memq/assq's obj is z.value (isSchemeValue: instanceof AValue or a function), not genuinely
  // host-blind — eq?'s raw `===` compare still works fine at RUNTIME against an unboxed operand
  // (native ops never validate), but the ZOD SCHEMA (a harvest-quality artifact) now honestly
  // narrows to "any boxed scheme value," matching every other slot this migration touched.
  // INVARIANT: memq/assq's search key stays deliberately representation-blind (eq?'s raw
  // identity compare)
  it("memq/assq: the search key (obj) is z.value — a raw non-scheme value is genuinely rejected by the schema (though eq?'s runtime `===` never actually checks it)", () => {
    expect(nativeDef("memq").in.safeParse([exact(1), properList(1, 2)]).success).toBe(true);
    expect(nativeDef("memq").in.safeParse(["anything-at-all", properList(1, 2)]).success).toBe(false);
    expect(nativeDef("assq").in.safeParse([exact(1), properList(properList(1, 2))]).success).toBe(true);
    expect(nativeDef("assq").in.safeParse(["anything-at-all", properList(properList(1, 2))]).success).toBe(false);
  });

  // Bare-value purge EXECUTED (RULINGS.md R1,
  // op-helpers.ts withInputProvenance): `z.value`'s `isSchemeValue` predicate
  // (common/scheme-zod.ts) was never actually the permissive z.unknown()-alike this row's
  // prior form assumed — it is, and remains, `instanceof AValue || typeof === "function"`,
  // so a raw JS `false`/`"anything"` was ALREADY structurally rejected by the z.value arm
  // (verified directly: `def.out.safeParse([false])` and `(["anything"])` both fail). The
  // union `[z.value, z.booleanFalse]` is a genuine strict door end to end: no arm admits an
  // unboxed scalar. No throw needed at this boundary — zod's own `safeParse` rejection IS
  // the strict door (P5); nothing here was "permissive" for a bare-value-purge fix to close.
  // INVARIANT: memv/assq/assv/member/assoc's output models "match or the boxed #f
  // sentinel", requiring a real boxed schemeFalse on the false arm
  it("memv/assq/assv/member/assoc: output is z.union([z.value, z.booleanFalse]) — a genuine strict door: a real match (boxed) or the boxed #f sentinel, nothing raw admitted by either arm", () => {
    for (const name of ["memv", "assq", "assv", "member", "assoc"]) {
      const def = nativeDef(name);
      expect(def.out.safeParse([properList(1, 2)]).success).toBe(true);
      expect(def.out.safeParse([schemeFalse]).success).toBe(true);
      // Neither arm admits a raw scalar: z.booleanFalse requires a boxed ABool, and
      // z.value's isSchemeValue requires instanceof AValue (or a callable) — a bare
      // JS `false`/string satisfies neither.
      expect(def.out.safeParse([false]).success).toBe(false);
      expect(def.out.safeParse(["anything"]).success).toBe(false);
    }
  });

  // INVARIANT: memq's output is tighter than its siblings — genuinely rejects raw JS false
  // and any non-pair value
  it("memq: output is z.union([z.pair, z.booleanFalse]) — tighter than its 5 siblings above (its success path always returns the live APair cell it matched on, never a bare value), so it genuinely rejects both a raw JS `false` and an arbitrary non-pair value", () => {
    const def = nativeDef("memq");
    expect(def.out.safeParse([properList(1, 2)]).success).toBe(true);
    expect(def.out.safeParse([schemeFalse]).success).toBe(true);
    expect(def.out.safeParse([false]).success).toBe(false); // no z.value arm here — genuinely rejected
    expect(def.out.safeParse(["anything"]).success).toBe(false);
  });

  // NOT a bare-value-purge (P4/A4) row, on inspection — retagged (was mis-filed under the
  // same marker as the row above). The compare callback's `is_false`-guarded tolerance
  // (lists.ts) exists for a BARE JS FUNCTION supplied as `compare` (`call_function`'s
  // non-callable-value branch, `fn.apply(...)`) — a Track-B (reverse-membrane/P1) concern:
  // a bare fn's return is a value-layer-only term the box interpreter can't read (P1), not a
  // scalar escaping a boxed producer inside the membrane (P4, this purge's scope). It
  // retires when B4 (legacy bare-fn arm retirement) lands, not here — A4 and B4 are
  // independent tracks of the 2026-07-09 principle-first rework. This test itself never observed the raw
  // arm at runtime (both assertions use boxed `exact(1)` operands) — static-only, as titled.
  // INVARIANT: member/assoc accept any scheme value for obj; compare's declared return
  // type is unknown, not boolean
  it("member/assoc: obj accepts any scheme value (was z.unknown(), now z.value — static-only); compare predicate's return type is now `unknown` not `boolean` (matches the file's is_false-guarded actual usage, and srfi-1.ts filter's established convention)", () => {
    for (const name of ["member", "assoc"]) {
      const def = nativeDef(name);
      expect(def.in.safeParse([exact(1), properList(1, 2)]).success).toBe(true);
      expect(def.in.safeParse([exact(1), properList(1, 2), fn]).success).toBe(true);
    }
  });
});

describe("scheme/lists Contract precision — regression guard: unaffected/already-precise siblings stay untouched", () => {
  // INVARIANT: list stays fully variadic over scheme values, unchanged
  it("list: already z.array(z.value)/[z.value] — untouched by this pass (already precise before this audit)", () => {
    const def = nativeDef("list");
    expect(def.in.safeParse([exact(1), exact(2), exact(3)]).success).toBe(true);
    expect(def.in.safeParse([]).success).toBe(true); // 0-arg list is legal
  });

  // INVARIANT: append/reverse untouched — reverse genuinely rejects a raw JS array;
  // append/list remain fully variadic
  it("append/reverse: untouched — already at their honest precision ceiling (append/list are legitimately fully-variadic-over-SchemeValue; reverse's own impl has NO array branch — pair|nil only)", () => {
    // NOTE: no bound scheme symbol named `clone` exists in this pack — `.clone()` is an
    // internal APair JS method, not an exported op (`list-copy`, tested separately above, is
    // the exported R7RS freshness-copy operation this describe block's title once conflated it with).
    expect(nativeDef("append").in.safeParse([properList(1), properList(2)]).success).toBe(true);
    // reverse's impl only handles ANil/APair (a final `else` throws) — a raw array is genuinely
    // rejected (array->list, the LIPS array-or-pair polymorphism this once contrasted with, is
    // dissolved — no longer bound in this pack).
    expect(nativeDef("reverse").in.safeParse([[1, 2, 3]]).success).toBe(false);
    expect(nativeDef("reverse").in.safeParse([properList(1, 2, 3)]).success).toBe(true);
  });

  // INVARIANT: apply/for-each already migrated to inputRest; apply's head is now a real
  // z.lambda creating a genuine arity floor
  it("apply / for-each: already migrated to inputRest this session — untouched, glanced at only as the migration's own reference examples", () => {
    const applyDef = nativeDef("apply");
    // apply's HEAD is now z.lambda (a real callable predicate, added by the uniform-vocabulary
    // migration) — three bare AExact values have no callable head, so this now genuinely rejects.
    expect(applyDef.in.safeParse([exact(1), exact(2), exact(3)]).success).toBe(false);
    expect(applyDef.in.safeParse([fn, exact(1), properList(2, 3)]).success).toBe(true);
    const forEachDef = nativeDef("for-each");
    expect(forEachDef.in.safeParse([fn, properList(1, 2)]).success).toBe(true);
    expect(forEachDef.in.safeParse([fn, "not-a-list"]).success).toBe(false); // pre-existing fix, unaffected
  });
});

describe("scheme/lists Contract precision — blanket sweep: genuinely-variadic-and-still-unconstrained ops (regression guard)", () => {
  // REBASELINE: this row's premise (z.value = "no zod refinement" — a contract built entirely
  // from z.value slots creates no arity floor and accepts raw garbage) was never actually true
  // of isSchemeValue (`instanceof AValue || typeof === "function"`, common/scheme-zod.ts) — a
  // raw string/number/plain-object genuinely fails it, verified directly:
  // `z.value.safeParse("anything")` is `false`. The uniform-vocabulary migration made this
  // refinement load-bearing everywhere (srfi-95.ts's own note: "z.value is the typed
  // replacement for z.unknown() at exactly this kind of native scheme-value slot") — so even
  // `list`/`append` (genuinely variadic over ANY scheme value at the semantic level) now reject
  // the random-JS-garbage probe below via z.value's own refinement. The empty stragglers list is
  // the honest acceptance bar now (mirrors numeric-contract-precision.test.ts's own bar) — no op
  // in this pack is BOTH-SIDES fully unconstrained against real zod validation anymore.
  // INVARIANT: every native/sequence op in the lists pack is precise except the two
  // deliberately fully-polymorphic constructors (list, append) (pins implementation, not
  // behavior)
  it("EVERY native/sequence op's Contract is precise — no straggler with BOTH sides still fully unconstrained against raw JS garbage (z.value's isSchemeValue refinement is real, not a permissive no-op)", () => {
    const stragglers: string[] = [];
    for (const [name, def] of Object.entries(symbols)) {
      if (def.kind !== "native" && def.kind !== "sequence") continue;
      const inputStillDegraded =
        def.in.safeParse([]).success && def.in.safeParse(["anything", 123, null, {}, [1, 2, 3]]).success;
      const outputStillDegraded =
        def.out.safeParse(["anything"]).success && def.out.safeParse([{ garbage: true }]).success;
      if (inputStillDegraded && outputStillDegraded) stragglers.push(name);
    }
    expect(stragglers.sort()).toEqual([]);
  });

  // INVARIANT: the lists pack exports exactly 23 symbols (deliberate drift alarm — forces
  // a reviewer to touch this test when a symbol is added/removed)
  it("sanity: the pack exports exactly 23 symbols (the scope this review must cover)", () => {
    expect(Object.keys(symbols)).toHaveLength(23);
  });
});

// "is_pair-shadow swap byte-identical" spot-checks RETIRED (2026-07-09 suite
// consolidation, G2): a helper-equivalence impl-pin bypassing the interpreter to
// prove `is_pair`/`is_nil` behave identically to `instanceof APair`/`instanceof ANil` —
// the block's own comment already named its replacement as "the untouched existing suite
// (cyclic-list-ops.test.ts, clone-identity.test.ts, r7rs-identity.test.ts)", which covers
// list-tail/list-ref/list-copy through the REAL interpreter, not a bypassed direct call.

describe("scheme/lists Contract.type overrides — the harvest signature (signatureOf) for the ops whose z.custom callable arg is UNREPRESENTABLE to the printer (it throws `Schemas of type \"custom\" cannot be represented`, degrading the WHOLE signature to the catch-all `(...args: unknown[]) => unknown`)", () => {
  // These ops carry a z.custom<callable>() in their contract (map/for-each's fn head,
  // member/assoc's optional compare). The printer degrades each to the bare
  // `(...args: unknown[]) => unknown`, throwing away the fn-first structure, the list
  // receiver type, and the void/`unknown | false` return. `Contract.type` author-asserts
  // the real shape — same trust model + same this-session convention as the sibling
  // srfi-1 `find` / srfi-95 `sort` overrides (a callable renders as
  // `(...args: unknown[]) => unknown`; a representation-AGNOSTIC receiver stays
  // `unknown` — map dispatches to Pair/Nil/Vector terms, so narrowing to a List would be false,
  // exactly sort's own documented reasoning; a genuinely list-only receiver is `Cons<unknown> |
  // null`, the same image the file's own non-degraded list ops harvest as).
  // INVARIANT: map harvests faithful List|vector dual generics (inline dedent type:)
  it("map (sequence): List|vector dual generics over element types (not R[]/unknown)", () => {
    expect(norm(signatureOf(sequenceDef("map")))).toBe(
      norm(dedent`
        {
          <T, B>(f: (x: T) => B, xs: List<T>): List<B>;
          <T, B>(f: (x: T) => B, xs: readonly T[]): readonly B[];
          <A, B, R>(f: (a: A, b: B) => R, as: List<A>, bs: List<B>): List<R>;
          <A, B, R>(f: (a: A, b: B) => R, as: readonly A[], bs: readonly B[]): readonly R[];
          <A, B, C, R>(f: (a: A, b: B, c: C) => R, as: List<A>, bs: List<B>, cs: List<C>): List<R>;
          <A, B, C, R>(f: (a: A, b: B, c: C) => R, as: readonly A[], bs: readonly B[], cs: readonly C[]): readonly R[];
        }
      `),
    );
  });
  it("for-each: list dual generics → void", () => {
    expect(norm(signatureOf(nativeDef("for-each")))).toBe(
      norm(dedent`
        {
          <T>(f: (x: T) => unknown, xs: List<T>): void;
          <A, B>(f: (a: A, b: B) => unknown, as: List<A>, bs: List<B>): void;
          <A, B, C>(f: (a: A, b: B, c: C) => unknown, as: List<A>, bs: List<B>, cs: List<C>): void;
        }
      `),
    );
  });
  // INVARIANT: member's harvested signature is obj+list+optional compare returning the
  // matched sublist or #f (pins implementation, not behavior)
  it("member: generic List search with optional compare", () => {
    expect(norm(signatureOf(nativeDef("member")))).toBe(
      norm(dedent`
        {
          <T>(obj: T, list: List<T>): List<T> | false;
          <T>(obj: T, list: List<T>, compare: (a: T, b: T) => unknown): List<T> | false;
        }
      `),
    );
  });
  it("assoc: generic alist search with optional compare", () => {
    expect(norm(signatureOf(nativeDef("assoc")))).toBe(
      norm(dedent`
        {
          <K, V>(obj: K, alist: List<[K, V]>): [K, V] | false;
          <K, V>(obj: K, alist: List<[K, V]>, compare: (a: K, b: K) => unknown): [K, V] | false;
        }
      `),
    );
  });
});
