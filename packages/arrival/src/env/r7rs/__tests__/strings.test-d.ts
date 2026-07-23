// strings.test-d.ts — TYPE-LEVEL proofs for the `scheme/strings` 2026-07-05 Contract
// precision audit (see the sibling strings-contract-precision.test.ts for the RUNTIME
// proof against the REAL exported ops — NativeSymbolDef.in/.out erase to plain
// z.ZodTypeAny on any real export, mirroring numeric.test-d.ts's/symbol.test-d.ts's own
// established note, so every proof here is a SYNTHETIC contract mirroring each op's real
// declared shape, built from the SAME scheme-zod.ts schemas the fix maps to).
//
// HONEST CAVEAT (unlike numeric.test-d.ts's z.numberOrBigint case): none of this round's
// fixes introduce a brand-new scheme-zod.ts export — z.schemeChar/z.schemeString/z.pair/
// z.nil/z.value all already exist, and the DecodedArgs/DecodedArgsWithRest/DecodedReturn
// mechanism is already proven correct (symbol.test-d.ts). So, exactly like the sibling
// symbol.test-d.ts "2026-07-05 audit" section for for-each/string-map/string-for-each/
// filter/typecheck, these OLD-vs-NEW pairs compile/pass regardless of strings.ts's fix
// state — they PIN the intended decoded shape as a compile-checked spec (and would catch
// a regression in the shared mechanism itself), but the genuine RED-before/GREEN-after
// gate for a "swap which existing schema is plugged into an existing contract" fix lives
// in the runtime file, which probes actual value acceptance via zod's own safeParse.

import { describe, expectTypeOf, test } from "vitest";
import * as z from "../../../common/scheme-zod.js";
import { symbol } from "../../../common/symbol.js";
import { type DecodedArgs, type DecodedReturn } from "../../../common/symbols/_bake.js";
import type { AList, AListAlike, SchemeValue } from "../../../values/types.js";
import type { APair } from "../../../values/primitives/APair.js";
import type { ACharacter } from "../../../values/primitives/ACharacter.js";
import type { AString } from "../../../values/primitives/AString.js";

describe("scheme/strings Contract precision — array-element tightening (string / comparisons / string-append / concat)", () => {
  // OLD-shape row DELETED (2026-07-09 suite consolidation, [P16]
  // "env test-d museum rows") — decoded a retired synthetic schema, no reachable
  // production path. NEW-side rows below are the load-bearing proof.
  // INVARIANT: string's element schema decodes to ACharacter[], not unknown[] (the OLD
  // flat-unknown[] baseline row was already retired — see the [P16] removal note above)
  test("NEW `string` shape: z.array(z.schemeChar) decodes to ACharacter[], not unknown[]", () => {
    expectTypeOf<DecodedArgs<ReturnType<typeof z.array<typeof z.char>>, "scheme">>().toEqualTypeOf<ACharacter[]>();
  });

  // INVARIANT: comparison/string-append/concat's element schema decodes to AString[], not
  // unknown[]
  test("NEW comparison/string-append/concat shape: z.array(z.schemeString) decodes to AString[], not unknown[]", () => {
    expectTypeOf<DecodedArgs<ReturnType<typeof z.array<typeof z.string>>, "scheme">>().toEqualTypeOf<AString[]>();
  });
});

describe("scheme/strings Contract precision — list-shaped slots (string->list output / list->string input / join 2nd-arg / split output)", () => {
  const listSchema = z.union([z.pair, z.nil]);

  // OLD-shape row DELETED (same sweep/rationale as the array-element block above).
  // INVARIANT: string->list/split's list-shaped output decodes to APair|null
  test("NEW shape: [z.union([z.pair, z.nil])] decodes the OUTPUT to APair | null, not unknown (string->list / split) — nil's JS face is null, not ANil; AList is the scheme face", () => {
    expectTypeOf<DecodedReturn<[typeof listSchema]>>().toEqualTypeOf<[SchemeValue, SchemeValue] | null>();
  });

  // INVARIANT: list->string's list-shaped input decodes to [APair|null]
  test("NEW shape: [z.union([z.pair, z.nil])] decodes the INPUT to [APair | null], not [unknown] (list->string)", () => {
    expectTypeOf<DecodedArgs<[typeof listSchema]>>().toEqualTypeOf<[[SchemeValue, SchemeValue] | null]>();
  });

  // INVARIANT: join's second-arg slot decodes as [AString, AListAlike]
  test("NEW shape: join's 2nd-arg slot decodes to [AString, APair | ANil], not [AString, SchemeValue]", () => {
    // Explicit AList<SchemeValue, SchemeValue>, not bare AList — bare AList relies on its
    // default type params, which toEqualTypeOf can't reconcile against a computed type here
    // (a real expect-type limitation with defaulted generics, verified directly).
    expectTypeOf<DecodedArgs<[typeof z.string, typeof listSchema], "scheme">>().toEqualTypeOf<
      [AString, AListAlike]
    >();
  });
});

describe("scheme/strings Contract precision — regression guard: wrong-typed impls must NOT compile against the tightened shapes", () => {
  const RUN = false as boolean;

  // INVARIANT: a wrong-typed char-rest impl must NOT compile against string's tightened
  // contract (pins implementation, not behavior)
  test("string: a wrong-typed char rest element (raw string, not ACharacter) must NOT compile", () => {
    if (RUN) {
      symbol.native`s: proof`(
        { input: z.array(z.char), output: [z.string] },
        // @ts-expect-error — elements decode via z.schemeChar (ACharacter), annotating them string is wrong
        (...chars: string[]): AString => chars as unknown as AString,
      );
    }
    expectTypeOf<true>().toEqualTypeOf<true>();
  });

  // INVARIANT: a wrong-typed (bare-string) return must NOT compile against string->list's
  // tightened contract (pins implementation, not behavior)
  test("string->list: a wrong-typed return (bare string, not APair | ANil) must NOT compile", () => {
    if (RUN) {
      symbol.native`sl: proof`(
        { input: [z.string], output: [z.union([z.pair, z.nil])] },
        // @ts-expect-error — output decodes to APair | ANil, returning a string is wrong
        (str: AString): string => str.valueOf(),
      );
    }
    expectTypeOf<true>().toEqualTypeOf<true>();
  });

  // INVARIANT: a wrong-typed (string) param must NOT compile against list->string's
  // tightened contract (pins implementation, not behavior)
  test("list->string: a wrong-typed param (string, not APair | ANil) must NOT compile", () => {
    if (RUN) {
      symbol.native`ls: proof`(
        { input: [z.union([z.pair, z.nil])], output: [z.string] },
        // @ts-expect-error — arg decodes to APair | ANil, annotating it string is wrong
        (list: string): AString => list as unknown as AString,
      );
    }
    expectTypeOf<true>().toEqualTypeOf<true>();
  });
});
