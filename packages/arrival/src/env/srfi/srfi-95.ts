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
import dedent from "dedent";
import { resolveMethod, symbol, type MaybePromise } from "../../common/symbol.js";
import { EnvCapability } from "../../common/capability.js";
import { attachOffendingValue } from "../../errors.js";
import { tf } from "../../values/tagless-final.js";
import type { SchemeValue } from "../../values/types.js";

export default new EnvCapability("scheme/srfi-95", {
  symbols: {
    sort: symbol.sequence`sort: a sorted sequence (list→list, vector→vector); default order is the elements' own ≤; comparator is a SRFI-95 less?`(
      {
        // seq: representation-blind at the SCHEME level (any receiver answering the
        // arrival/tagless-final/sort protocol — APair/AVector/AJSArray, every SchemeValue
        // member this dispatch could ever see), not host-blind — z.value is the typed
        // replacement for z.unknown() at exactly this kind of native scheme-value slot
        // (scheme-zod.ts), matching the sibling term-dispatch receiver `length` (lists.ts).
        // comparator: a callable predicate, not bare unknown — AValue.ts's single source of
        // truth declares `arrival/tagless-final/sort`'s own param as exactly
        // `(a: unknown, b: unknown) => unknown` (mirrored by deriveSortCompare, op-helpers.ts),
        // so the contract states the SAME signature rather than a blanket z.value.
        input: [z.value, z.lambda.optional()],
        // output: the sorted sequence is a SchemeValue (APair | ANil for a list, AVector for a
        // vector) — z.value again, matching the term algebra's own declared return type.
        output: [z.value],
        // The z.custom optional comparator is unrepresentable to the harvest printer, collapsing the
        // whole signature to the degrade path `(...args: unknown[]) => unknown`. Author-assert the
        // real shape: seq + optional binary comparator. seq/return stay `unknown` ON PURPOSE — sort is
        // representation-agnostic (list→list, vector→vector), so a `List` narrowing would be false
        // (unlike find, whose schema IS list-only). The comparator mirrors the `(a,b)=>unknown`
        // AValue.ts declares for the sort protocol — the assertion states that shape, not an invention.
        type: dedent`
          {
            <T>(seq: List<T>, less?: (a: T, b: T) => unknown): List<T>;
            <T>(seq: readonly T[], less?: (a: T, b: T) => unknown): readonly T[];
          }
        `,
        // callbackRoles DECLARED (docs/PROVENANCE.md §2, Q4): pipe host with value egress —
        // shape underdetermines. less? is `control` (the ORDERING return; the merged
        // selector+decision role) — sort is the canonical host-schedule op (spec §5's
        // `(left-ordinal, right-ordinal, verdict)` record cites exactly this comparator's
        // verdicts). Roles align with LAMBDA arms: less? is arm 0 despite input position 1.
        callbackRoles: ["control"],
      },
      (args, runCtx) => {
        const [seq, comparator] = args;
        const m = resolveMethod(seq, tf("sort"));
        if (m === undefined) {
          throw attachOffendingValue(
            new TypeError(
              `sort: the ${seq == null ? String(seq) : typeof seq} operand does not support sort (no ${tf("sort")}).`,
            ),
            seq,
          );
        }
        // The per-primitive sort term algebra (module header) declares a SchemeValue return —
        // `resolveMethod`'s TermMethod is `unknown` (it resolves ANY term method, not sort's own
        // protocol specifically), so this states that documented invariant, not a blind widening.
        return m.call(seq, comparator, runCtx) as MaybePromise<SchemeValue>;
      },
    ),
  },
});
