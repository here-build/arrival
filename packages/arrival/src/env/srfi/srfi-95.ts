// SRFI-95 — sorting. Scheme-bootstrap capability.
//
// `(sort seq less?)` is receiver-FIRST (the sequence is arg 0), unlike the receiver-LAST
// tagless ops (map/filter place the collection last). So sort can't be a pure
// `symbol.tagless` (whose convention is "the last operand is the receiver") — it's a thin
// ctx-aware `symbol.sequence` that dispatches to the SEQUENCE's own
// `arrival/tagless-final/sort`. The per-primitive sort (APair → a sorted LIST, AVector → a
// sorted VECTOR; container-preserving by each term returning its own shape; default order is
// the elements' own `arrival/tagless-final/lte`, a comparator is a SRFI-95 `less?`) and the
// heap-charge both live ON the term (Option A). TOTALIC: a receiver with no sort algebra is a
// type error, never a silent coercion.
//
// SINGLE SOURCE: `srfi/index.ts` adds this to `allSrfi`, so `base-packs.ts` assembles it.
import * as z from "../../common/scheme-zod.js";
import { symbol } from "../../common/symbol.js";
import { EnvCapability } from "../../common/capability.js";
import { tf } from "../../values/tagless-final.js";

export default new EnvCapability("scheme/srfi-95", {
  symbols: {
    sort: symbol.sequence`sort: a sorted sequence (list→list, vector→vector); default order is the elements' own ≤; comparator is a SRFI-95 less?`(
      {
        // seq: term-dispatched (arrival/tagless-final/sort) purely within the scheme-value
        // universe (APair/AVector/AJSArray — all SchemeValue members), not host-blind —
        // z.value, matching the sibling term-dispatch receiver `length` in lists.ts.
        input: [z.value, z.custom<(a: unknown, b: unknown) => unknown>().optional()],
        // The sorted sequence — every concrete term impl returns a SchemeValue subtype
        // (APair|ANil for lists, AVector for vectors).
        output: [z.value],
      },
      (args, runCtx) => {
        const [seq, comparator] = args;
        const m = (seq as Record<string, unknown> | null | undefined)?.[tf("sort")];
        if (typeof m !== "function") {
          throw new TypeError(
            `sort: the ${seq == null ? String(seq) : typeof seq} operand does not support sort (no ${tf("sort")}).`,
          );
        }
        return (m as (...a: unknown[]) => unknown).call(seq, comparator, runCtx);
      },
    ),
  },
});
