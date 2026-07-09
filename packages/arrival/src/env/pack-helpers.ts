// Shared env-layer helpers for capability packs.
//
// Pack isolation forbids a PACK importing another PACK (the intra-set dependency
// rule) — it does not forbid packs sharing a non-pack env-layer module, exactly as
// they all share `common/capability.ts` and `values/op-helpers.ts`. This module is
// that door for helpers that used to be copy-pasted per pack: `to_array` lived as
// three byte-equivalent copies (r7rs/lists, r7rs/strings, srfi/srfi-13) with the
// duplication justified by "pack isolation forbids a cross-pack import" — true,
// but the fix was a shared non-pack home, not triplication.

import invariant from "tiny-invariant";
import { APair, isCircularList } from "../values/primitives/APair.js";
import { ANil } from "../values/primitives/ANil.js";
import { ctxOf } from "../values/primitives/AValue.js";
import { ArrivalError } from "../eval/evaluator.js";
import { heapBudgetMessage } from "../heap-budget.js";
import type { SchemeValue } from "../values/types.js";

/** Proper-list → element array, with the per-element heap-meter charge at the
 *  collection choke (meter off the OPERAND's ctx — a run-built list carries the
 *  run's RunContext; a quoted literal carries CONSTANT_CTX → no meter, and is
 *  parse-bounded anyway). Doors: circular and improper lists are errors, named
 *  per-op. NOT the same as `[...pair]` — the iterator FOLDS an improper tail in
 *  (toJS's one-way projection rule); this helper REJECTS it (the list-op domain). */
export function to_array(name: string): (list: SchemeValue) => SchemeValue[] {
  return function (list: SchemeValue): SchemeValue[] {
    if (list instanceof ANil) {
      return [];
    }
    // Wide `SchemeValue` param: isCircularList only accepts a Pair, so narrow here;
    // a non-Pair non-Nil reaches the loop's own improper-list invariant below.
    invariant(!(list instanceof APair && isCircularList(list)), `${name}: can't convert a circular list`);
    const meter = ctxOf(list).heapMeter;
    const result: SchemeValue[] = [];
    let node: unknown = list;
    while (true) {
      if (node instanceof APair) {
        if (node.have_cycles("cdr")) {
          break;
        }
        result.push(node.car);
        if (meter !== undefined && ++meter.used > meter.max) {
          throw new ArrivalError(heapBudgetMessage(meter.max), []);
        }
        node = node.cdr;
      } else {
        invariant(node instanceof ANil, `${name}: can't convert improper list`);
        break;
      }
    }
    return result;
  };
}
