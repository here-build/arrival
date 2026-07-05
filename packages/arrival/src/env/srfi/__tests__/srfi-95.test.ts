// srfi-95.test.ts — RUNTIME proof that `sort`'s Contract element precision lands on the
// REAL exported symbol.
//
// `symbol.sequence`'s factory pins the impl signature to `(args: unknown[], runCtx) =>
// unknown` regardless of the declared contract (unlike native/rosetta, it never threads
// `Impl<I,O>`), so there is no compile-time proof available on the impl body, and a
// `.test-d.ts` mechanism proof would be a synthetic mirror only (see symbol.test-d.ts's
// existing "2026-07-05 audit" section for that convention on other ops).
//
// `sort`'s fix (z.unknown() → z.value/callable) is ALSO not `.safeParse()`-observable:
// z.custom<T>() with no refinement is byte-identical to z.unknown() at runtime (both
// accept anything) — the only genuine, provable signal is STRUCTURAL: which zod schema
// kind is actually wired into the baked def. `._zod.def.type` distinguishes "unknown"
// from "custom" directly (verified against the installed zod 4.3.6 by hand before
// writing this).
import { describe, expect, it } from "vitest";
import srfi95Pack from "../srfi-95.js";
import { AEntity } from "../../../common/symbols/_bake.js";

function symbolsOf(pack: { spec: { symbols?: unknown } }): Record<string, AEntity> {
  return pack.spec.symbols as Record<string, AEntity>;
}

function contractDef(pack: { spec: { symbols?: unknown } }, name: string) {
  const def = symbolsOf(pack)[name];
  if (def === undefined) throw new Error(`pack: no symbol named ${name}`);
  if (def.kind !== "native" && def.kind !== "sequence") {
    throw new Error(`${name}: expected a native or sequence def (got ${def.kind})`);
  }
  return def;
}

/** `._zod.def.type` of a zod schema, unwrapping ONE `.optional()` layer if present
 *  (srfi-95's comparator slot is `.optional()`; the other two slots are bare). */
function schemaKind(s: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- introspecting zod's internal def, not public API
  const def = (s as any)._zod.def;
  return def.type === "optional" ? def.innerType._zod.def.type : def.type;
}

describe("2026-07-06 audit — scheme/srfi-95: sort's element precision (real exported op)", () => {
  it("seq (slot 0) is z.value (custom), not the old bare z.unknown()", () => {
    const def = contractDef(srfi95Pack, "sort");
    const tuple = (def.in as { _zod: { def: { items: unknown[] } } })._zod.def.items;
    expect(schemaKind(tuple[0])).toBe("custom");
  });

  it("comparator (slot 1, optional) is a callable custom schema, not the old bare z.unknown()", () => {
    const def = contractDef(srfi95Pack, "sort");
    const tuple = (def.in as { _zod: { def: { items: unknown[] } } })._zod.def.items;
    expect(schemaKind(tuple[1])).toBe("custom");
  });

  it("output is z.value (custom), not the old bare z.unknown()", () => {
    const def = contractDef(srfi95Pack, "sort");
    // 1-tuple output normalizes the same way as input — z.tuple([z.value]).
    const outTuple = (def.out as { _zod: { def: { items: unknown[] } } })._zod.def.items;
    expect(schemaKind(outTuple[0])).toBe("custom");
  });
});
