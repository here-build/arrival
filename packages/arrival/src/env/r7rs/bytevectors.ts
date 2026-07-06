/**
 * Bytevector value-domain ops (R7RS Section 6.9) extracted from the `wrappedOps`
 * bridge object. These are the non-mutating bytevector primitives plus the two
 * bridges to/from strings (`utf8->string` / `string->utf8`). They are polymorphic
 * by design — `bytevector?` and the `asBytevector` coercion accept boxed
 * `SchemeBytevector` as well as raw binary (`Uint8Array`/`ArrayBuffer`/`DataView`/
 * Node `Buffer`) that legitimately flows unboxed through the membrane from FFI.
 * The mutating ops (`bytevector-u8-set!` / `bytevector-copy!`) are intentionally
 * omitted under the purity invariant and doored in this pack. Bodies are
 * reproduced verbatim from `bridge.ts`; the only change is sourcing shared
 * helpers via `../op-helpers.js`.
 *
 * MIGRATED to the `symbol.native` API: each op declares a SCHEME-IDENTITY zod
 * contract (no codec, no validation — "zod for TYPES purely") and an impl bound
 * raw, exactly as the old `{ value }` form was. Native means the schema choice
 * cannot change runtime behavior; the bodies are reproduced byte-for-byte. The
 * bytevector args declare `z.sbytevector` (the op's semantic domain); the raw-binary
 * polymorphism stays a runtime property of `asBytevector`, unaffected by the types-only
 * schema. `bytevector?` keeps `z.unknown()` since it deliberately classifies ANY value.
 */

import "../../errors.js";
import { CONSTANT_CTX } from "../../values/primitives/RunContext.js";

import * as z from "../../common/scheme-zod.js";
import { symbol } from "../../common/symbol.js";
import { ABytevector } from "../../values/primitives/ABytevector.js";
import { AString } from "../../values/primitives/AString.js";
import { asBytevector, stringValue, toIndex, withInputProvenance } from "../../values/op-helpers.js";
import { EnvCapability } from "../../common/capability.js";

export default new EnvCapability("scheme/bytevectors", {
  symbols: {
    "bytevector?": symbol.native`bytevector?: #t iff the object is a bytevector (boxed or raw binary)`(
      { input: [z.value], output: [z.boolean] },
      (obj) => {
        // Polymorphic by design (NOT a transition shim): scheme producers mint
        // SchemeBytevector, but raw binary legitimately flows from FFI through the
        // membrane unboxed (membrane preserves Uint8Array identity), and a raw
        // Uint8Array/ArrayBuffer/DataView/Buffer genuinely IS bytevector-like. So the
        // predicate accepts boxed OR raw — mirroring asBytevector's coercion. (Vectors
        // differ: a raw JS array is an R7RS list, not a vector, so vector? is
        // instanceof-only — see the boxing plan's (a)/(b) disambiguation.)
        return (
          obj instanceof ABytevector ||
          obj instanceof Uint8Array ||
          obj instanceof ArrayBuffer ||
          obj instanceof DataView ||
          (typeof Buffer !== "undefined" && obj instanceof Buffer)
        );
      },
    ),

    "make-bytevector": symbol.native`make-bytevector: a bytevector of length k filled with byte`(
      { input: [z.schemeNumber, z.schemeNumber.optional()], output: [z.sbytevector] },
      (k, byte) => {
        const arr = new Uint8Array(toIndex(k));
        if (byte !== undefined) {
          arr.fill(toIndex(byte));
        }
        return withInputProvenance([byte], new ABytevector(CONSTANT_CTX, arr));
      },
    ),

    bytevector: symbol.native`bytevector: a bytevector built from the byte arguments`(
      // Wholly variadic + homogeneous (no distinct head, unlike for-each/string-map's
      // callable-then-rest split) — every argument is a byte, so the fix is a single
      // precise element schema, not an inputRest split. Each element flows through
      // toIndex(b) below, exactly like make-bytevector's byte/k args — z.schemeNumber
      // is that same op's own precedent for "this slot is a scheme number".
      { input: [], inputRest: z.schemeNumber, output: [z.sbytevector] },
      (...bytes) => withInputProvenance(bytes, new ABytevector(CONSTANT_CTX, new Uint8Array(bytes.map(toIndex)))),
    ),

    "bytevector-length": symbol.native`bytevector-length: number of bytes in the bytevector`(
      { input: [z.sbytevector], output: [z.number] },
      (bv) => asBytevector(bv, "bytevector-length").byteLength,
    ),

    "bytevector-u8-ref": symbol.native`bytevector-u8-ref: the byte at index k`(
      { input: [z.sbytevector, z.schemeNumber], output: [z.number] },
      (bv, k) => asBytevector(bv, "bytevector-u8-ref")[toIndex(k)],
    ),

    // ── PURITY DOORS — bytevector mutators OMITTED by design (R7RS §6.9) ─────────
    // A bytevector is a frozen entity; an in-place write would falsify the
    // construction-site provenance it carries. Doored here (errors-as-doors),
    // co-located with the pack that owns the type — dissolved from the deleted
    // core.ts manifesto. The non-mutating bytevector-copy below stays.
    "bytevector-u8-set!": symbol.notImplemented`bytevector-u8-set!: every value is frozen by design — mutating it after construction would falsify the provenance lineage it carries; construct a new value instead (bytevector-copy / a fresh bytevector)`,
    "bytevector-copy!": symbol.notImplemented`bytevector-copy!: every value is frozen by design — mutating its destination would falsify the provenance lineage it carries; construct a new value instead (bytevector-copy returns a fresh bytevector)`,

    "bytevector-copy": symbol.native`bytevector-copy: a fresh copy of the bytevector (or slice)`(
      { input: [z.sbytevector, z.schemeNumber.optional(), z.schemeNumber.optional()], output: [z.sbytevector] },
      (bv, start, end) => {
        const view = asBytevector(bv, "bytevector-copy");
        return withInputProvenance(
          [bv],
          new ABytevector(
            CONSTANT_CTX,
            view.slice(start === undefined ? 0 : toIndex(start), end === undefined ? view.byteLength : toIndex(end)),
          ),
        );
      },
    ),

    "bytevector-append": symbol.native`bytevector-append: concatenation of all bytevector arguments`(
      // Wholly variadic + homogeneous, same shape as bytevector above — every argument
      // IS a bytevector, so z.sbytevector (the semantic domain the sibling ops in this
      // file already declare for their bv args — bytevector-copy, utf8->string) is the
      // precise element schema. The raw-binary FFI polymorphism asBytevector tolerates
      // stays a runtime-only property, unaffected by this types-only schema (see the
      // module doc comment).
      { input: [], inputRest: z.sbytevector, output: [z.sbytevector] },
      (...bvs) => {
        const views = bvs.map((bv) => asBytevector(bv, "bytevector-append"));
        const totalLen = views.reduce((sum, v) => sum + v.byteLength, 0);
        const result = new Uint8Array(totalLen);
        let offset = 0;
        for (const view of views) {
          result.set(view, offset);
          offset += view.byteLength;
        }
        return withInputProvenance(bvs, new ABytevector(CONSTANT_CTX, result));
      },
    ),

    "utf8->string": symbol.native`utf8->string: decode a bytevector slice as UTF-8`(
      { input: [z.sbytevector, z.schemeNumber.optional(), z.schemeNumber.optional()], output: [z.string] },
      (bv, start, end) => {
        const view = asBytevector(bv, "utf8->string");
        return withInputProvenance(
          [bv],
          new AString(
            CONSTANT_CTX,
            new TextDecoder("utf-8").decode(
              view.subarray(
                start === undefined ? 0 : toIndex(start),
                end === undefined ? view.byteLength : toIndex(end),
              ),
            ),
          ),
        );
      },
    ),
    "string->utf8": symbol.native`string->utf8: encode a string slice as UTF-8 bytes`(
      { input: [z.string, z.schemeNumber.optional(), z.schemeNumber.optional()], output: [z.sbytevector] },
      (str, start, end) => {
        const s_str = stringValue(str);
        return withInputProvenance(
          [str],
          new ABytevector(
            CONSTANT_CTX,
            new TextEncoder().encode(
              s_str.slice(start === undefined ? 0 : toIndex(start), end === undefined ? s_str.length : toIndex(end)),
            ),
          ),
        );
      },
    ),
  },
});
