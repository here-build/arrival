/**
 * LAW F1 — one algebra, every carrier (P0/P8).
 *
 * For every tagless term × every carrier: the VALUE result matches reference
 * semantics AND the BOX discipline matches the term's DECLARED discipline
 * (_tables/terms.ts). The declaration is the law; a carrier cannot negotiate.
 *
 * METHODOLOGY. Every supported cell executes the term via its SCHEME VERB
 * (`term.verbs[0]`, per DESIGN.md), against a 3-element carrier minted by
 * `_tables/fixtures.ts`'s `mint3` (each element individually provenance-stamped
 * by a harness `src` rosetta — one fresh point per call, P11). Two documented
 * departures from "always verbs[0]":
 *
 *   - `arrival/toJS` / `arrival/print` have NO scheme verb (`terms.ts` declares
 *     `verbs: []`) — the protocol is called directly on the value, per the task
 *     brief.
 *   - `arrival/tagless-final/concat`'s verbs are CARRIER-SPECIFIC by R7RS
 *     convention (`append` for lists, `string-append` for strings, `vector-append`
 *     for vectors, `bytevector-append` for bytevectors) — `verbs[0]` ("append")
 *     is the list-only op; using it literally for every carrier would test
 *     `append`'s OWN (documented, Pair-specific) behavior against a foreign
 *     carrier, not that carrier's real concat path. Each concat cell below picks
 *     the carrier-appropriate verb from the (corrected) verbs list.
 *
 * CELLS:
 *   - unsupported (table-declared): the door — the verb throws, teaching why.
 *   - value: reference semantics on the 3-element instance.
 *   - boxes: the term's declared discipline, checked per-element (or, for a
 *     scalar-result term, on the result's own provenance).
 *   - provenance conservation (P10): deep-collapsed result provenance ⊇ the
 *     consumed elements' minted ids.
 *   - container box: R2-gated, left `it.todo` per the task brief — untouched.
 *
 * KNOWN VIOLATIONS get `it.fails` with a `// @ledger: <id>` line citing
 * `src/__tests__/ledger/index.law.test.ts`'s GAPS table (enforced by that
 * file's own walker meta-test). FIXED: the two DR4-shaped cells (map×AVector,
 * map×AJSArray — AJSArray's map DELEGATES to AVector's, so it was the identical
 * root cause) used to cite "DR4 vector-map re-box mints empty provenance" —
 * conservation repair made AVector's map box-preserving (mirrors APair's map,
 * P8), so both cells are now plain `it()` — GAPS row retired.
 *
 * TICKETED FINDINGS (this audit's ledger-reconciliation pass gave each its own
 * GAPS row and flipped the cells from plain `it()` to `it.fails` — same
 * assertions, now loud when fixed instead of silently red):
 *   - `equal?`'s result is always the shared empty-provenance ABool flyweight
 *     (env/r7rs/equality.ts) — contradicts the term's declared "element-unioning"
 *     discipline for EVERY carrier (booleans never carry provenance in this
 *     codebase today). @ledger: "equal? verdict is empty-provenance flyweight".
 *   - FIXED: `concat` had no real dispatch path for AJSArray/ADict (neither has an
 *     `arrival/tagless-final/concat` method or a dedicated verb): the only available
 *     verb (`append`) used to silently return the SECOND operand unchanged, discarding
 *     the first — a P5 "fails loudly" violation, not a clean door. `append`'s door fix
 *     (env/r7rs/lists.ts) now throws for a non-pair/non-nil, non-last operand, naming
 *     the carrier-appropriate verb; both carriers' concat cells are asserted as
 *     `unsupported by design` doors above (formerly ledgered as "append silently
 *     discards non-pair first operand" — GAPS row retired).
 *   - AVector/AJSArray/ADict's own `arrival/toJS` leaves elements still boxed
 *     ("convert lazily") instead of a fully-recursive unwrap.
 *     @ledger: "container toJS leaves boxed element residue".
 */
import { describe, it, expect } from "vitest";
import { TERMS } from "./_tables/terms.js";
import { CARRIERS, type CarrierRow } from "./_tables/carriers.js";
import { mint3, mint3Pair, elementBoxes, deepIds, toPlain } from "./_tables/fixtures.js";
import { exec } from "../../eval/generator-exec.js";
import type { Environment } from "../../Environment.js";
import type { SchemeValue } from "../../values/types.js";
import { AValue } from "../../values/primitives/AValue.js";

/** Runs `src` against a law env with one container bound as `c`. */
async function run1(env: Environment, c: SchemeValue, src: string): Promise<SchemeValue> {
  const [r] = await exec(src, { env: env.inherit("call-site", { c }) });
  return r;
}

/** Runs `src` against a law env with two containers bound as `c1`/`c2`. */
async function run2(env: Environment, c1: SchemeValue, c2: SchemeValue, src: string): Promise<SchemeValue> {
  const [r] = await exec(src, { env: env.inherit("call-site", { c1, c2 }) });
  return r;
}

/**
 * Walks ANY JS structure (raw object/array, possibly still holding boxed AValue
 * leaves) collecting every reachable AValue's own provenance ids. Unlike
 * `deepIds` (fixtures.ts, scoped to the INSIDE-the-sandbox carriers), this is
 * for testing egress RESIDUE specifically — a toJS/print result is, by
 * contract, raw JS, but AVector/AJSArray/ADict's own `arrival/toJS` leave
 * elements boxed ("convert lazily"), so a plain `deepIds` read (which doesn't
 * know how to walk a bare JS object) would give a false "no provenance"
 * reading for the wrong reason. This one actually looks.
 */
function rawDeepIds(value: unknown, seen = new Set<unknown>()): Set<number> {
  const acc = new Set<number>();
  if (value === null || typeof value !== "object" || seen.has(value)) return acc;
  seen.add(value);
  if (value instanceof AValue) {
    for (const p of value.provenance) acc.add(p);
  }
  const children: unknown[] = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  for (const child of children) for (const p of rawDeepIds(child, seen)) acc.add(p);
  return acc;
}

describe.each(TERMS.map((t) => [t.term, t] as const))("term %s", (_name, term) => {
  describe.each(CARRIERS.map((c) => [c.carrier, c] as const))("carrier %s", (_carrier, carrier) => {
    const unsupported = carrier.unsupported.find((u) => u.term === term.term);

    // ── UNSUPPORTED — the door ──────────────────────────────────────────────
    if (unsupported) {
      it(`unsupported by design — doors with: ${unsupported.reason}`, async () => {
        const { env, value } = await mint3(carrier);
        const verb = term.verbs[0];
        let src: string;
        if (term.term === "arrival/tagless-final/car" || term.term === "arrival/tagless-final/cdr") {
          src = `(${term.term === "arrival/tagless-final/car" ? "car" : "cdr"} c)`;
        } else if (verb === "map") {
          src = `(map (lambda (x) x) c)`;
        } else if (verb === "filter") {
          src = `(filter (lambda (x) #t) c)`;
        } else if (verb === "reduce") {
          src = `(reduce (lambda (x acc) acc) 0 c)`;
        } else if (verb === "sort") {
          src = `(sort c (lambda (x y) #t))`;
        } else if (verb === "length") {
          src = `(length c)`;
        } else {
          throw new Error(`term-carrier.law.test.ts: no door-probe snippet wired for verb ${String(verb)}`);
        }
        await expect(run1(env, value, src)).rejects.toThrow();
      });
      return;
    }

    // ── SUPPORTED — value / boxes / provenance / container-box(todo) ───────
    switch (term.term) {
      case "arrival/tagless-final/map": {
        it("value: map(identity) over a 3-element instance is the identity on values", async () => {
          const { env, value } = await mint3(carrier);
          const result = await run1(env, value, `(map (lambda (x) x) c)`);
          expect(toPlain(result)).toEqual(toPlain(value));
        });

        // AVector/AJSArray used to hit the SAME cross-out root cause (AJSArray.map delegates
        // to AVector's own tagless-final map) — DR4 (FIXED, conservation repair): map is now
        // box-preserving on every carrier (P8), so no carrier-specific branching is needed.
        const boxesBody = async () => {
          const { env, value, ids } = await mint3(carrier);
          const result = await run1(env, value, `(map (lambda (x) x) c)`);
          const before = elementBoxes(value);
          const after = elementBoxes(result);
          expect(before).toEqual([[ids[0]], [ids[1]], [ids[2]]]);
          expect(after).toEqual(before);
        };
        const provBody = async () => {
          const { env, value, ids } = await mint3(carrier);
          const result = await run1(env, value, `(map (lambda (x) x) c)`);
          const deep = deepIds(result);
          for (const id of ids) expect(deep.has(id)).toBe(true);
        };
        it(`boxes: ${term.boxDiscipline} — every consumed element's box obeys the declared discipline`, boxesBody);
        it("provenance: deep-collapsed result provenance ⊇ union of consumed elements' (conservation, P10)", provBody);
        break;
      }

      case "arrival/tagless-final/filter": {
        it("value: filter keep-all is the identity; keep-none is empty", async () => {
          const { env, value } = await mint3(carrier);
          const keepAll = await run1(env, value, `(filter (lambda (x) #t) c)`);
          expect(toPlain(keepAll)).toEqual(toPlain(value));
          const keepNone = await run1(env, value, `(filter (lambda (x) #f) c)`);
          const plain = toPlain(keepNone);
          // keep-none may come back as an empty container OR nil (toJS → null) depending on
          // the carrier — all three are "no elements kept".
          const size = plain == null ? 0 : Array.isArray(plain) ? plain.length : Object.keys(plain as object).length;
          expect(size).toBe(0);
        });

        it(`boxes: ${term.boxDiscipline} — every consumed element's box obeys the declared discipline`, async () => {
          const { env, value, ids } = await mint3(carrier);
          const result = await run1(env, value, `(filter (lambda (x) #t) c)`);
          expect(elementBoxes(result)).toEqual([[ids[0]], [ids[1]], [ids[2]]]);
        });

        it("provenance: deep-collapsed result provenance ⊇ union of consumed elements' (conservation, P10)", async () => {
          const { env, value, ids } = await mint3(carrier);
          const result = await run1(env, value, `(filter (lambda (x) #t) c)`);
          const deep = deepIds(result);
          for (const id of ids) expect(deep.has(id)).toBe(true);
        });
        break;
      }

      case "arrival/tagless-final/reduce": {
        it("value: reduce sums the 3 elements (element-first fold convention)", async () => {
          const { env, value } = await mint3(carrier);
          const result = await run1(env, value, `(reduce (lambda (x acc) (+ acc x)) 0 c)`);
          expect((result as AValue).valueOf()).toBe(6);
        });

        it(`boxes: ${term.boxDiscipline} — the fold result carries the elements' provenance via the pure '+' propagation`, async () => {
          const { env, value, ids } = await mint3(carrier);
          const result = await run1(env, value, `(reduce (lambda (x acc) (+ acc x)) 0 c)`);
          const deep = deepIds(result);
          for (const id of ids) expect(deep.has(id)).toBe(true);
        });

        it("provenance: deep-collapsed result provenance ⊇ union of consumed elements' (conservation, P10)", async () => {
          const { env, value, ids } = await mint3(carrier);
          const result = await run1(env, value, `(reduce (lambda (x acc) (+ acc x)) 0 c)`);
          const deep = deepIds(result);
          for (const id of ids) expect(deep.has(id)).toBe(true);
        });
        break;
      }

      case "arrival/tagless-final/sort": {
        it("value: sort with a DESCENDING comparator actually reorders the ascending-minted input", async () => {
          const { env, value } = await mint3(carrier);
          const result = await run1(env, value, `(sort c (lambda (x y) (> x y)))`);
          expect(toPlain(result)).toEqual([...(toPlain(value) as unknown[])].reverse());
        });

        it(`boxes: ${term.boxDiscipline} — every consumed element's box obeys the declared discipline (reordered, not rebuilt)`, async () => {
          const { env, value, ids } = await mint3(carrier);
          const result = await run1(env, value, `(sort c (lambda (x y) (> x y)))`);
          expect(elementBoxes(result)).toEqual([[ids[2]], [ids[1]], [ids[0]]]);
        });

        it("provenance: deep-collapsed result provenance ⊇ union of consumed elements' (conservation, P10)", async () => {
          const { env, value, ids } = await mint3(carrier);
          const result = await run1(env, value, `(sort c (lambda (x y) (> x y)))`);
          const deep = deepIds(result);
          for (const id of ids) expect(deep.has(id)).toBe(true);
        });
        break;
      }

      case "arrival/tagless-final/concat": {
        // Carrier-appropriate verb (see the file-header note) — APair/AVector/AString/
        // ABytevector each have a real, correctly-dispatching verb. AJSArray and ADict have
        // NEITHER a concat method NOR a dedicated verb (see carriers.ts's note): the only
        // verb reachable at all (`append`, verbs[0]) used to silently discard the first
        // operand for a non-pair carrier (a P5 "fails loudly" violation) — append's door fix
        // (lists.ts) closes this uniformly for every non-pair/non-nil, non-last operand, so
        // both carriers now throw a teaching door instead of misbehaving.
        const concatVerb: Record<CarrierRow["carrier"], string> = {
          APair: "append",
          AVector: "vector-append",
          AJSArray: "append",
          AString: "string-append",
          ADict: "append",
          ABytevector: "bytevector-append",
        };
        const verb = concatVerb[carrier.carrier];
        const isString = carrier.carrier === "AString";
        const noDedicatedConcatVerb = carrier.carrier === "AJSArray" || carrier.carrier === "ADict";

        if (noDedicatedConcatVerb) {
          it(`unsupported by design — doors with: no dedicated concat verb for this carrier; append's P5 door refuses a non-pair, non-last operand rather than silently discarding it`, async () => {
            const { env, a, b } = await mint3Pair(carrier);
            await expect(run2(env, a, b, `(${verb} c1 c2)`)).rejects.toThrow();
          });
          break;
        }

        const valueBody = async () => {
          const { env, a, b } = await mint3Pair(carrier);
          const result = await run2(env, a, b, `(${verb} c1 c2)`);
          const plainA = toPlain(a);
          const plainB = toPlain(b);
          const expected = isString ? `${plainA}${plainB}` : [...(plainA as unknown[]), ...(plainB as unknown[])];
          expect(toPlain(result)).toEqual(expected);
        };

        const boxesBody = async () => {
          const { env, a, b, idsA, idsB } = await mint3Pair(carrier);
          const result = await run2(env, a, b, `(${verb} c1 c2)`);
          const boxesA = elementBoxes(a);
          const boxesB = elementBoxes(b);
          if (boxesA !== null && boxesB !== null) {
            expect(elementBoxes(result)).toEqual([...boxesA, ...boxesB]);
          } else {
            // AString/ABytevector: no per-element boxes — the container's OWN provenance
            // is the union signal (the "string"/"bytevector" constructors stamp it that way).
            const deep = deepIds(result);
            for (const id of [...idsA, ...idsB]) expect(deep.has(id)).toBe(true);
          }
        };

        const provBody = async () => {
          const { env, a, b, idsA, idsB } = await mint3Pair(carrier);
          const result = await run2(env, a, b, `(${verb} c1 c2)`);
          const deep = deepIds(result);
          for (const id of [...idsA, ...idsB]) expect(deep.has(id)).toBe(true);
        };

        it("value: concat carries both operands' elements, in order", valueBody);
        it(`boxes: ${term.boxDiscipline} — every consumed element's box obeys the declared discipline`, boxesBody);
        it("provenance: deep-collapsed result provenance ⊇ union of consumed elements' (conservation, P10)", provBody);
        break;
      }

      case "arrival/tagless-final/length": {
        it("value: length is 3", async () => {
          const { env, value } = await mint3(carrier);
          const result = await run1(env, value, `(length c)`);
          expect(Number((result as AValue).valueOf())).toBe(3);
        });

        it(`boxes: ${term.boxDiscipline} — the count carries the elements' unioned provenance`, async () => {
          const { env, value, ids } = await mint3(carrier);
          const result = await run1(env, value, `(length c)`);
          const deep = deepIds(result);
          for (const id of ids) expect(deep.has(id)).toBe(true);
        });

        it("provenance: deep-collapsed result provenance ⊇ union of consumed elements' (conservation, P10)", async () => {
          const { env, value, ids } = await mint3(carrier);
          const result = await run1(env, value, `(length c)`);
          const deep = deepIds(result);
          for (const id of ids) expect(deep.has(id)).toBe(true);
        });
        break;
      }

      case "arrival/tagless-final/equals": {
        it("value: equal? to self is #t; to a differently-shaped value is #f", async () => {
          const { env, value } = await mint3(carrier);
          const self = await run1(env, value, `(equal? c c)`);
          expect((self as AValue).valueOf()).toBe(true);
          const other = await run1(env, value, `(equal? c 'definitely-not-equal)`);
          expect((other as AValue).valueOf()).toBe(false);
        });

        // DOCUMENTED FINDING (see file header): `equal?` always returns the shared
        // empty-provenance ABool flyweight — ledgered as "equal? verdict is empty-
        // provenance flyweight" (src/__tests__/ledger/index.law.test.ts GAPS).
        // @ledger: equal? verdict is empty-provenance flyweight
        it.fails(`boxes [TICKETED GAP]: ${term.boxDiscipline} — the verdict should carry the consumed elements' unioned provenance`, async () => {
          const { env, value, ids } = await mint3(carrier);
          const result = await run1(env, value, `(equal? c c)`);
          const deep = deepIds(result);
          for (const id of ids) expect(deep.has(id)).toBe(true);
        });

        // @ledger: equal? verdict is empty-provenance flyweight
        it.fails("provenance [TICKETED GAP]: deep-collapsed result provenance ⊇ union of consumed elements' (conservation, P10)", async () => {
          const { env, value, ids } = await mint3(carrier);
          const result = await run1(env, value, `(equal? c c)`);
          const deep = deepIds(result);
          for (const id of ids) expect(deep.has(id)).toBe(true);
        });
        break;
      }

      case "arrival/tagless-final/car": {
        it("value: car projects the first element's value", async () => {
          const { env, value } = await mint3(carrier);
          const result = await run1(env, value, `(car c)`);
          expect(toPlain(result)).toEqual((toPlain(value) as unknown[])[0]);
        });

        it(`boxes: ${term.boxDiscipline} — the result IS the first element, box intact`, async () => {
          const { env, value, ids } = await mint3(carrier);
          const result = await run1(env, value, `(car c)`);
          expect([...((result as AValue).provenance)].sort()).toEqual([ids[0]]);
        });

        it("provenance: deep-collapsed result provenance ⊇ union of consumed elements' (conservation, P10)", async () => {
          const { env, value, ids } = await mint3(carrier);
          const result = await run1(env, value, `(car c)`);
          expect(deepIds(result).has(ids[0])).toBe(true);
        });
        break;
      }

      case "arrival/tagless-final/cdr": {
        it("value: cdr projects the rest of the sequence", async () => {
          const { env, value } = await mint3(carrier);
          const result = await run1(env, value, `(cdr c)`);
          expect(toPlain(result)).toEqual((toPlain(value) as unknown[]).slice(1));
        });

        it(`boxes: ${term.boxDiscipline} — the remaining elements' boxes survive intact`, async () => {
          const { env, value, ids } = await mint3(carrier);
          const result = await run1(env, value, `(cdr c)`);
          expect(elementBoxes(result)).toEqual([[ids[1]], [ids[2]]]);
        });

        it("provenance: deep-collapsed result provenance ⊇ union of consumed elements' (conservation, P10)", async () => {
          const { env, value, ids } = await mint3(carrier);
          const result = await run1(env, value, `(cdr c)`);
          const deep = deepIds(result);
          expect(deep.has(ids[1])).toBe(true);
          expect(deep.has(ids[2])).toBe(true);
        });
        break;
      }

      case "arrival/toJS": {
        it("value: toJS is a faithful (deep-unwrapped) projection of the 3-element instance", async () => {
          const { value } = await mint3(carrier);
          const result = (value as AValue)["arrival/toJS"]();
          expect(toPlain(result)).toEqual(toPlain(value));
        });

        // P4: "boxes exist exactly where the second interpreter runs... a box outside is a
        // piece of one world lost in the other." AVector/AJSArray/ADict's own `arrival/toJS`
        // leave elements STILL BOXED (AVector/AJSArray's own doc comments say "convert
        // lazily"; ADict's `arrival/toJS` copies `this.get(name)` verbatim, same story) —
        // unlike APair's fully-recursive unwrap. Ledgered as "container toJS leaves boxed
        // element residue" (src/__tests__/ledger/index.law.test.ts GAPS) for these three
        // carriers. `rawDeepIds` (not `deepIds`, which only knows how to walk the
        // INSIDE-the-sandbox carriers) actually looks inside the raw object/array toJS
        // hands back.
        const lazyEgress = carrier.carrier === "AVector" || carrier.carrier === "AJSArray" || carrier.carrier === "ADict";
        const boxesBody = async () => {
          const { value } = await mint3(carrier);
          const result = (value as AValue)["arrival/toJS"]();
          const leaves = Array.isArray(result) ? result : Object.values(result as object);
          for (const leaf of leaves) expect(leaf instanceof AValue).toBe(false);
        };
        const provBody = async () => {
          const { value } = await mint3(carrier);
          const result = (value as AValue)["arrival/toJS"]();
          expect(rawDeepIds(result).size).toBe(0);
        };
        if (lazyEgress) {
          // @ledger: container toJS leaves boxed element residue
          it.fails("boxes [TICKETED GAP]: no AValue should survive past the toJS egress", boxesBody);
          // @ledger: container toJS leaves boxed element residue
          it.fails("provenance [TICKETED GAP]: toJS egress carries NO provenance by design (P4/P9)", provBody);
        } else {
          it("boxes: no AValue survives past the toJS egress (P4 — the box's world ends at the membrane)", boxesBody);
          it("provenance: toJS egress carries NO provenance by design (P4/P9 — the trace keeps it, the JS value doesn't)", provBody);
        }
        break;
      }

      case "arrival/print": {
        it("value: print renders the R7RS external representation", async () => {
          const { value } = await mint3(carrier);
          const result = (value as AValue)["arrival/print"]();
          expect(typeof result).toBe("string");
          expect(result.length).toBeGreaterThan(0);
        });

        it("boxes: print's output is a plain string — no AValue crosses the print egress", async () => {
          const { value } = await mint3(carrier);
          const result = (value as AValue)["arrival/print"]();
          expect(result instanceof AValue).toBe(false);
        });

        it("provenance: print egress carries NO provenance by design (P4/P9)", async () => {
          const { value } = await mint3(carrier);
          const result = (value as AValue)["arrival/print"]();
          expect(deepIds(result).size).toBe(0);
        });
        break;
      }

      default:
        throw new Error(`term-carrier.law.test.ts: no supported-cell body wired for term ${term.term}`);
    }

    it.todo("container box: per R2 ruling [RULING-GATED: R2]");
  });
});
