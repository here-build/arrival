/**
 * Bytevector value-domain ops (R7RS Section 6.9): the non-mutating bytevector
 * primitives plus the two bridges to/from strings (`utf8->string` /
 * `string->utf8`). Polymorphic by design — `bytevector?` and the `asBytevector`
 * coercion accept boxed `SchemeBytevector` as well as raw binary (`Uint8Array`/
 * `ArrayBuffer`/`DataView`/Node `Buffer`) that legitimately flows unboxed through
 * the membrane from FFI. The mutating ops (`bytevector-u8-set!` /
 * `bytevector-copy!` / `bytevector-fill!`) are omitted under the purity
 * invariant and doored below.
 *
 * Each op declares a SCHEME-IDENTITY zod contract (no codec, no runtime
 * validation — "zod for TYPES purely") and an impl bound raw. The bytevector
 * args declare `z.bytevector` (the op's semantic domain); the raw-binary
 * polymorphism stays a runtime property of `asBytevector`, unaffected by the
 * types-only schema. `bytevector?` keeps `z.schemeValue` since it deliberately
 * classifies ANY value.
 */

import dedent from "dedent";
import invariant from "tiny-invariant";
import { ABytevector } from "../../values/primitives/ABytevector.js";
import { AString } from "../../values/primitives/AString.js";
import {
  asBytevector,
  assertAllocatable,
  schemeBool,
  stringValue,
  toIndex,
  withInputProvenance,
} from "../../values/op-helpers.js";
import { AExact } from "../../values/primitives/AExact.js";
import { EnvCapability } from "../../common/capability.js";
import { attachOffendingValue } from "../../errors.js";
import { sliceRange } from "../pack-helpers.js";

/** A byte is an exact integer in 0..255 — `Uint8Array` would otherwise wrap 256 → 0,
 *  -1 → 255 and truncate 1.5 → 1, silently minting a different byte than the one named. */
function byteValue(verb: string, b: unknown): number {
  const n = toIndex(b);
  if (!Number.isInteger(n) || n < 0 || n > 255) {
    throw attachOffendingValue(new RangeError(`${verb}: a byte is an exact integer in 0..255, got ${String(n)}`), b);
  }
  return n;
}

export default EnvCapability.define("scheme/bytevectors", {
  symbols: (symbol, z) => ({
    "bytevector?": symbol.native`bytevector?: #t iff the object is a bytevector (boxed or raw binary)`(
      {
        input: [z.schemeValue],
        output: [z.boolean],
        type: dedent`
          {
            (x: unknown): x is Uint8Array;
            <T>(x: T): x is Extract<T, Uint8Array>;
          }
        `,
      },
      function (obj) {
        // Polymorphic by design: scheme producers mint SchemeBytevector, but raw
        // binary legitimately flows from FFI through the membrane unboxed (it
        // preserves Uint8Array identity), and a raw Uint8Array/ArrayBuffer/
        // DataView/Buffer genuinely IS bytevector-like. The predicate accepts boxed
        // OR raw, mirroring asBytevector's coercion. (Vectors differ: a raw JS array
        // is an R7RS list, not a vector, so vector? is instanceof-only.)
        return schemeBool(
          obj instanceof ABytevector ||
            obj instanceof Uint8Array ||
            obj instanceof ArrayBuffer ||
            obj instanceof DataView ||
            (typeof Buffer !== "undefined" && obj instanceof Buffer),
        );
      },
    ),

    "make-bytevector": symbol.native`make-bytevector: a bytevector of length k filled with byte`(
      { input: [z.schemeNumber, z.schemeNumber.optional()], output: [z.bytevector] },
      function (k, byte) {
        const len = toIndex(k);
        // Allocation cap + non-negative-integer door BEFORE the typed array materializes
        // (a negative length otherwise leaks a raw RangeError, an oversized one kills the host).
        assertAllocatable(len, "make-bytevector");
        invariant(Number.isInteger(len), `make-bytevector: length must be an exact integer, got ${len}`);
        const arr = new Uint8Array(len);
        if (byte !== undefined) {
          arr.fill(byteValue("make-bytevector", byte));
        }
        return withInputProvenance(this.runCtx, [byte], new ABytevector(arr));
      },
    ),

    bytevector: symbol.native`bytevector: a bytevector built from the byte arguments`(
      // Wholly variadic + homogeneous (no distinct head, unlike for-each/string-map's
      // callable-then-rest split) — every argument is a byte, so the fix is a single
      // precise element schema, not an inputRest split. Each element flows through
      // toIndex(b) below, exactly like make-bytevector's byte/k args — z.schemeNumber
      // is that same op's own precedent for "this slot is a scheme number".
      { input: [], inputRest: z.schemeNumber, output: [z.bytevector] },
      function (...bytes) {
        return withInputProvenance(
          this.runCtx,
          bytes,
          new ABytevector(new Uint8Array(bytes.map((b) => byteValue("bytevector", b)))),
        );
      },
    ),

    "bytevector-length": symbol.native`bytevector-length: number of bytes in the bytevector`(
      { input: [z.bytevector], output: [z.number] },
      function (bv) {
        return new AExact(asBytevector(bv, "bytevector-length").byteLength);
      },
    ),

    "bytevector-u8-ref": symbol.native`bytevector-u8-ref: the byte at index k`(
      { input: [z.bytevector, z.schemeNumber], output: [z.number] },
      function (bv, k) {
        const view = asBytevector(bv, "bytevector-u8-ref");
        const idx = toIndex(k);
        if (!Number.isInteger(idx) || idx < 0 || idx >= view.byteLength) {
          throw new RangeError(
            `bytevector-u8-ref: index ${idx} out of range for a bytevector of length ${view.byteLength}`,
          );
        }
        return new AExact(view[idx]);
      },
    ),

    // ── PURITY DOORS — bytevector mutators OMITTED by design (R7RS §6.9) ─────────
    // A bytevector is a frozen entity; an in-place write would falsify the
    // construction-site provenance it carries. The non-mutating bytevector-copy
    // below stays.
    "bytevector-u8-set!": symbol.notImplemented`bytevector-u8-set!: every value is frozen by design — mutating it after construction would falsify the provenance lineage it carries; construct a new value instead (bytevector-copy / a fresh bytevector)`,
    "bytevector-copy!": symbol.notImplemented`bytevector-copy!: every value is frozen by design — mutating its destination would falsify the provenance lineage it carries; construct a new value instead (bytevector-copy returns a fresh bytevector)`,
    "bytevector-fill!": symbol.notImplemented`bytevector-fill!: every value is frozen by design — mutating it after construction would falsify the provenance lineage it carries; construct a new value instead (make-bytevector with the fill / bytevector-copy)`,

    "bytevector-copy": symbol.native`bytevector-copy: a fresh copy of the bytevector (or slice)`(
      { input: [z.bytevector, z.schemeNumber.optional(), z.schemeNumber.optional()], output: [z.bytevector] },
      function (bv, start, end) {
        const view = asBytevector(bv, "bytevector-copy");
        const range = sliceRange("bytevector-copy", view.byteLength, start, end, "bytevector");
        return withInputProvenance(this.runCtx, [bv], new ABytevector(view.slice(range.start, range.end)));
      },
    ),

    "bytevector-append": symbol.native`bytevector-append: concatenation of all bytevector arguments`(
      // Wholly variadic + homogeneous, same shape as bytevector above — every argument
      // IS a bytevector, so z.bytevector is the precise element schema. The raw-binary
      // FFI polymorphism asBytevector tolerates stays a runtime-only property,
      // unaffected by this types-only schema (see the module doc comment).
      { input: [], inputRest: z.bytevector, output: [z.bytevector] },
      function (...bvs) {
        const views = bvs.map((bv) => asBytevector(bv, "bytevector-append"));
        const totalLen = views.reduce((sum, v) => sum + v.byteLength, 0);
        const result = new Uint8Array(totalLen);
        let offset = 0;
        for (const view of views) {
          result.set(view, offset);
          offset += view.byteLength;
        }
        return withInputProvenance(this.runCtx, bvs, new ABytevector(result));
      },
    ),

    "utf8->string": symbol.native`utf8->string: decode a bytevector slice as UTF-8`(
      { input: [z.bytevector, z.schemeNumber.optional(), z.schemeNumber.optional()], output: [z.string] },
      function (bv, start, end) {
        const view = asBytevector(bv, "utf8->string");
        const range = sliceRange("utf8->string", view.byteLength, start, end, "bytevector");
        return withInputProvenance(
          this.runCtx,
          [bv],
          new AString(new TextDecoder("utf-8").decode(view.subarray(range.start, range.end))),
        );
      },
    ),
    "string->utf8": symbol.native`string->utf8: encode a string slice as UTF-8 bytes`(
      { input: [z.string, z.schemeNumber.optional(), z.schemeNumber.optional()], output: [z.bytevector] },
      function (str, start, end) {
        const s_str = stringValue(str);
        const range = sliceRange("string->utf8", s_str.length, start, end, "string");
        return withInputProvenance(
          this.runCtx,
          [str],
          new ABytevector(new TextEncoder().encode(s_str.slice(range.start, range.end))),
        );
      },
    ),
  }),
});
