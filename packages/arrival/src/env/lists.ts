/**
 * List ops — the R7RS § 6.4 pairs-and-lists cluster (the list constructors,
 * accessors, mutators, copy, and the search functions: memq/memv/assq/assv/
 * member/assoc), carved
 * VERBATIM out of \`wrappedOps\` in \`../bridge.ts\`. These are behavior-preserving
 * copies of the interpreter's hot-path list builtins; the implementations —
 * including their inline comments — are otherwise identical to the source. The
 * only change from the bridge originals is that cross-cutting helpers come
 * from their own leaf modules rather than being referenced as bridge locals:
 * \`withInputProvenance\` from \`../op-helpers.js\`; \`eqv\` (the canonical R7RS
 * \`eqv?\`, shared by \`eq?\`) and \`structuralEqual\` from \`../structural-equal.js\`;
 * the value-type classes (\`Pair\`/\`isCircularList\`, \`Nil\`/\`nil\`) from their own
 * leaf modules; and \`is_false\` from \`../guards.js\`. \`TypeError\`
 * carries its \`.invariant\` assertion via the side-effect import below. The
 * c[ad]+r accessor family is intentionally NOT declared here — those are served
 * by a resolver, not by \`wrappedOps\`.
 *
 * MIGRATED to the \`symbol.native\` API: each op declares a SCHEME-IDENTITY zod
 * contract (no codec, no validation — "zod for types purely") and an impl bound
 * raw exactly as the old \`{ value }\` form. List args are typed \`Pair | Nil\` (the
 * proper-list domain; the defensive improper-list passthrough is robustness, not
 * the declared domain), indices are the \`schemeNumber\` tower, the searched object
 * and copied/returned cells are representation-blind (\`z.unknown()\`), and the
 * optional user comparator is the types-only \`z.custom\` binary predicate. Bodies
 * are reproduced byte-for-byte.
 */

// Installs the global \`TypeError.invariant\` assertion helper used by the
// list-bounds and circular-list guards below (side-effect import).
import "@here.build/error-invariant";
import { CONSTANT_CTX } from "../values/primitives/RunContext.js";

import * as z from "./scheme-zod.js";
import { symbol } from "./symbol.js";
import { withInputProvenance } from "../values/op-helpers.js";
import { isCircularList, APair } from "../values/primitives/APair.js";
import { eqv, structuralEqual } from "../values/structural-equal.js";
import { ANil, nil } from "../values/primitives/ANil.js";
import { is_false } from "../eval/guards.js";
import { EnvCapability } from "./capability.js";

export default new EnvCapability("scheme/lists", {
  symbols: {
    // R7RS 6.4 Pairs and lists
    "make-list": symbol.native`make-list: build a list of k copies of fill (default #f)`(
      { input: [z.schemeNumber, z.unknown().optional()], output: [z.unknown()] },
      (k: unknown, fill?: unknown): unknown => {
        const count = typeof k === "number" ? k : (k as { valueOf(): number }).valueOf();
        const value = fill === undefined ? false : fill;
        let result: unknown = nil;
        for (let i = 0; i < count; i++) {
          result = new APair(CONSTANT_CTX, value, result);
        }
        // Stamp the head Pair only — internal cons cells share the same lineage
        // by definition; downstream traversal reads provenance off whichever pair
        // is bound. Parallel to lips.ts \`cons\` which only stamps the produced cell.
        return withInputProvenance(fill === undefined ? [k] : [k, fill], result);
      },
    ),

    "list-tail": symbol.native`list-tail: the sublist obtained by dropping the first k elements`(
      { input: [z.union([z.pair, z.nil]), z.schemeNumber], output: [z.unknown()] },
      (list: unknown, k: unknown): unknown => {
        const count = typeof k === "number" ? k : (k as { valueOf(): number }).valueOf();
        let current = list;
        for (let i = 0; i < count; i++) {
          TypeError.invariant(current instanceof APair, `list-tail: list too short`);
          current = current.cdr;
        }
        return current;
      },
    ),

    "list-ref": symbol.native`list-ref: the element at index k`(
      { input: [z.union([z.pair, z.nil]), z.schemeNumber], output: [z.unknown()] },
      (list: unknown, k: unknown): unknown => {
        const count = typeof k === "number" ? k : (k as { valueOf(): number }).valueOf();
        let current = list;
        for (let i = 0; i < count; i++) {
          TypeError.invariant(current instanceof APair, `list-ref: list too short`);
          current = current.cdr;
        }
        TypeError.invariant(current instanceof APair, `list-ref: index out of bounds`);
        return current.car;
      },
    ),

    "list-set!": symbol.native`list-set!: store obj at index k (mutates the spine)`(
      { input: [z.union([z.pair, z.nil]), z.schemeNumber, z.unknown()], output: [z.void()] },
      (list: unknown, k: unknown, obj: unknown): void => {
        const count = typeof k === "number" ? k : (k as { valueOf(): number }).valueOf();
        let current = list;
        for (let i = 0; i < count; i++) {
          TypeError.invariant(current instanceof APair, `list-set!: list too short`);
          current = current.cdr;
        }
        TypeError.invariant(current instanceof APair, `list-set!: index out of bounds`);
        current.car = obj;
      },
    ),

    "list-copy": symbol.native`list-copy: a fresh copy of the list spine (R7RS freshness)`(
      { input: [z.union([z.pair, z.nil])], output: [z.unknown()] },
      (list: unknown): unknown => {
        // \`=== nil\` would miss Nil clones (singletons minted via withProvenance by
        // the evaluator's control-flow provenance pass). A clone bypassed the
        // guard, fell to the \`!(instanceof Pair)\` improper-list branch on the next
        // line, and aliased the input by reference — violating R7RS list-copy's
        // fresh-allocation contract. \`instanceof Nil\` keeps the freshness story
        // intact for both the singleton and any clones.
        if (list instanceof ANil) return nil;
        if (!(list instanceof APair)) return list;
        TypeError.invariant(!isCircularList(list), "list-copy: circular list");
        // Deep copy the spine of the list
        const copy = (lst: unknown): unknown => {
          // Same clone-aware check at the recursion base: a Nil clone in the cdr
          // would otherwise be preserved as an improper-list tail.
          if (lst instanceof ANil) return nil;
          if (!(lst instanceof APair)) return lst; // improper list tail
          return new APair(CONSTANT_CTX, lst.car, copy(lst.cdr));
        };
        // Copy is a fresh allocation but semantically the same lineage as \`list\`.
        return withInputProvenance([list], copy(list));
      },
    ),

    // R7RS 6.4 List searching functions
    memq: symbol.native`memq: first sublist whose car is eq? to obj, else #f`(
      { input: [z.unknown(), z.union([z.pair, z.nil])], output: [z.unknown()] },
      (obj: unknown, list: unknown): unknown => {
        let current = list;
        TypeError.invariant(!isCircularList(list), "memq: circular list");
        while (current instanceof APair) {
          // eq? comparison (object identity)
          if (current.car === obj) return current;
          current = current.cdr;
        }
        return false;
      },
    ),

    memv: symbol.native`memv: first sublist whose car is eqv? to obj, else #f`(
      { input: [z.unknown(), z.union([z.pair, z.nil])], output: [z.unknown()] },
      (obj: unknown, list: unknown): unknown => {
        let current = list;
        TypeError.invariant(!isCircularList(list), "memv: circular list");
        while (current instanceof APair) {
          if (eqv(current.car, obj)) return current;
          current = current.cdr;
        }
        return false;
      },
    ),

    assq: symbol.native`assq: first alist entry whose car is eq? to obj, else #f`(
      { input: [z.unknown(), z.union([z.pair, z.nil])], output: [z.unknown()] },
      (obj: unknown, alist: unknown): unknown => {
        let current = alist;
        TypeError.invariant(!isCircularList(alist), "assq: circular list");
        while (current instanceof APair) {
          const pair = current.car;
          if (pair instanceof APair && pair.car === obj) return pair;
          current = current.cdr;
        }
        return false;
      },
    ),

    assv: symbol.native`assv: first alist entry whose car is eqv? to obj, else #f`(
      { input: [z.unknown(), z.union([z.pair, z.nil])], output: [z.unknown()] },
      (obj: unknown, alist: unknown): unknown => {
        let current = alist;
        TypeError.invariant(!isCircularList(alist), "assv: circular list");
        while (current instanceof APair) {
          const pair = current.car;
          if (pair instanceof APair && eqv(pair.car, obj)) return pair;
          current = current.cdr;
        }
        return false;
      },
    ),

    // member uses equal? (deep structural equality)
    member: symbol.native`member: first sublist whose car is equal? to obj (or per compare), else #f`(
      {
        input: [z.unknown(), z.union([z.pair, z.nil]), z.custom<(a: unknown, b: unknown) => boolean>().optional()],
        output: [z.unknown()],
      },
      (obj: unknown, list: unknown, compare?: (a: unknown, b: unknown) => boolean): unknown => {
        const cmp = compare || ((a: unknown, b: unknown) => structuralEqual(a, b));
        let current = list;
        TypeError.invariant(!isCircularList(list), "member: circular list");
        while (current instanceof APair) {
          // \`cmp\` may be a user-supplied Scheme predicate whose result is a boxed
          // SchemeBool post-L1 (a truthy JS object); route through is_false.
          if (!is_false(cmp(obj, current.car))) return current;
          current = current.cdr;
        }
        return false;
      },
    ),

    // assoc uses equal? (deep structural equality)
    assoc: symbol.native`assoc: first alist entry whose car is equal? to obj (or per compare), else #f`(
      {
        input: [z.unknown(), z.union([z.pair, z.nil]), z.custom<(a: unknown, b: unknown) => boolean>().optional()],
        output: [z.unknown()],
      },
      (obj: unknown, alist: unknown, compare?: (a: unknown, b: unknown) => boolean): unknown => {
        const cmp = compare || ((a: unknown, b: unknown) => structuralEqual(a, b));
        let current = alist;
        TypeError.invariant(!isCircularList(alist), "assoc: circular list");
        while (current instanceof APair) {
          const pair = current.car;
          // \`cmp\` may be a user-supplied Scheme predicate → boxed SchemeBool post-L1.
          if (pair instanceof APair && !is_false(cmp(obj, pair.car))) return pair;
          current = current.cdr;
        }
        return false;
      },
    ),
  },
});
