// srfi-235 — RUNTIME proof that curry's contract is built via the `inputRest` field with a
// SchemeValue-precise rest schema, not a manually-authored `z.tuple(fixed, z.unknown())`.
//
// WHY A RUNTIME TEST (not just type-level): `symbol.native` bakes the authored `Contract<I,O,Rest>`
// into a `NativeSymbolDef`, which erases I/O/Rest to plain `z.ZodTypeAny` — so the real bound
// `curry` export can't be re-inspected at the TYPE level (see symbol.test-d.ts's repeated note on
// this same erasure). Nor does this migration change anything OBSERVABLE via the harvest printer:
// `z.value` is deliberately mapped to print as "unknown" too (schema-to-ts.ts's
// `IMAGE_BY_IDENTITY` — same as z.value's own printType test), and natives run NO runtime
// validation (bakeNative attaches schemas for inference/harvest only, never parses). curry's own
// impl (utils/functional.ts) is untouched and stays `(...args: unknown[])`-typed, which — by
// ordinary parameter contravariance — satisfies ANY rest schema's decoded type (unknown is the
// supertype of everything), so it type-checks identically before AND after this migration.
//
// The ONE place the fix is mechanically observable is the WIRED zod schema object itself:
// `normalizeInputVector` (symbols/_bake.ts) passes a contract's `inputRest` straight into
// `z.tuple(fixed, inputRest)` with no wrapping/cloning — so the baked def's `.in` rest slot is
// REFERENCE-EQUAL to whatever schema the contract declares. Today that's a freshly-constructed
// `z.unknown()` (structurally `{ type: "unknown" }`, not `z.value`); after the migration it is
// the exact `z.value` singleton `scheme-zod.ts` exports (structurally `{ type: "custom" }`,
// reference-equal to `z.value`). This test reads that wired schema off the REAL default export.
import { describe, expect, it } from "vitest";
import srfi235 from "../srfi-235.js";
import * as z from "../../../common/scheme-zod.js";
import type { NativeSymbolDef, SymbolDef } from "../../../common/symbol.js";

/** Read a normalized zod schema's internal `def` — same cast `type-layer/schema-to-ts.ts` already
 *  uses to introspect `_zod.def` (zod4's public `.def` mirrors this, but the shipped .d.ts doesn't
 *  type it, so every consumer in this codebase reaches it via `_zod` — mirrored here rather than
 *  inventing a second convention). */
function zodDef(schema: z.ZodTypeAny): { type?: string; items?: readonly z.ZodTypeAny[]; rest?: z.ZodTypeAny | null } {
  return (schema as { _zod?: { def?: unknown } })._zod?.def as never;
}

describe("srfi-235 — curry's contract: inputRest precision (input/inputRest, not a manual z.tuple(fixed, rest))", () => {
  // srfi-235.ts declares `symbols` as a plain object literal (not the activation-builder form),
  // so the function branch is unreachable here — narrowed defensively rather than cast, so a
  // future switch to the builder form fails this test loudly instead of silently miscompiling.
  const symbolsRec: Record<string, SymbolDef> =
    typeof srfi235.spec.symbols === "function"
      ? srfi235.spec.symbols({ configuration: {}, resources: {} } as never)
      : (srfi235.spec.symbols ?? {});
  const curryDef = symbolsRec.curry;

  it("curry is baked as a symbol.native def", () => {
    expect(curryDef && typeof curryDef === "object" && "kind" in curryDef && curryDef.kind).toBe("native");
  });

  it("curry's input schema is a fixed-head tuple with a REST slot", () => {
    const native = curryDef as NativeSymbolDef;
    const inDef = zodDef(native.in);
    expect(inDef.type).toBe("tuple");
    expect(inDef.items?.length).toBe(1); // the fixed `fn` head — exactly one position
    expect(inDef.rest).toBeTruthy(); // a rest slot exists (the variadic partial-application tail)
  });

  it("the rest slot is the z.value SchemeValue-identity singleton — NOT a bare z.unknown()", () => {
    const native = curryDef as NativeSymbolDef;
    const inDef = zodDef(native.in);
    // Reference-identity: normalizeInputVector splices a contract's `inputRest` field directly
    // into z.tuple(fixed, inputRest) with no wrapping, so migrating curry's contract to
    // `inputRest: z.value` makes this THE SAME singleton scheme-zod.ts exports. Today (pre-fix)
    // curry's rest is a manually-authored `z.unknown()` call inline in the contract's `input`
    // field — a structurally-"unknown", reference-DIFFERENT schema — so this assertion is RED
    // until the migration lands.
    expect(inDef.rest).toBe(z.value);
  });
});
