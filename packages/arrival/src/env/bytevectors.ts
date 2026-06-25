/**
 * Bytevector value-domain ops (R7RS Section 6.9) extracted from the `wrappedOps`
 * bridge object. These are the non-mutating bytevector primitives plus the two
 * bridges to/from strings (`utf8->string` / `string->utf8`). They are polymorphic
 * by design — `bytevector?` and the `asBytevector` coercion accept boxed
 * `SchemeBytevector` as well as raw binary (`Uint8Array`/`ArrayBuffer`/`DataView`/
 * Node `Buffer`) that legitimately flows unboxed through the membrane from FFI.
 * The mutating ops (`bytevector-u8-set!` / `bytevector-copy!`) are intentionally
 * omitted under the purity invariant and doored in bootstrap. Bodies are
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

import "../errors.js";
import { CONSTANT_CTX } from "../values/primitives/RunContext.js";

import * as z from "../common/scheme-zod.js";
import { symbol } from "../common/symbol.js";
import { ABytevector } from "../values/primitives/ABytevector.js";
import { AString } from "../values/primitives/AString.js";
import {
  asBytevector,
  stringValue,
  toIndex,
  withInputProvenance,
} from "../values/op-helpers.js";
import { EnvCapability } from "../common/capability.js";

export default new EnvCapability("scheme/bytevectors", {
  symbols: {
    "bytevector?": symbol.native`bytevector?: #t iff the object is a bytevector (boxed or raw binary)`(
      { input: [z.unknown()], output: [z.boolean] },
      (obj: unknown): boolean => {
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
      (k: unknown, byte?: unknown): ABytevector => {
        const arr = new Uint8Array(toIndex(k));
        if (byte !== undefined) {
          arr.fill(toIndex(byte));
        }
        return withInputProvenance([byte], new ABytevector(CONSTANT_CTX, arr));
      },
    ),

    bytevector: symbol.native`bytevector: a bytevector built from the byte arguments`(
      { input: z.array(z.unknown()), output: [z.sbytevector] },
      (...bytes: unknown[]): ABytevector => {
        const result = new Uint8Array(bytes.length);
        for (const [i, b] of bytes.entries()) {
          result[i] = toIndex(b);
        }
        return withInputProvenance(bytes, new ABytevector(CONSTANT_CTX, result));
      },
    ),

    "bytevector-length": symbol.native`bytevector-length: number of bytes in the bytevector`(
      { input: [z.sbytevector], output: [z.number] },
      (bv: unknown): number => {
        const view = asBytevector(bv, "bytevector-length");
        return view.byteLength;
      },
    ),

    "bytevector-u8-ref": symbol.native`bytevector-u8-ref: the byte at index k`(
      { input: [z.sbytevector, z.schemeNumber], output: [z.number] },
      (bv: unknown, k: unknown): number => {
        const view = asBytevector(bv, "bytevector-u8-ref");
        return view[toIndex(k)];
      },
    ),

    // bytevector-u8-set! / bytevector-copy! — OMITTED by the purity invariant
    // (frozen entities); doored in core.ts. Non-mutating bytevector-copy stays.

    "bytevector-copy": symbol.native`bytevector-copy: a fresh copy of the bytevector (or slice)`(
      { input: [z.sbytevector, z.schemeNumber.optional(), z.schemeNumber.optional()], output: [z.sbytevector] },
      (bv: unknown, start?: unknown, end?: unknown): ABytevector => {
        const view = asBytevector(bv, "bytevector-copy");
        const s = start === undefined ? 0 : toIndex(start);
        const e = end === undefined ? view.byteLength : toIndex(end);
        return withInputProvenance([bv], new ABytevector(CONSTANT_CTX, view.slice(s, e)));
      },
    ),

    "bytevector-append": symbol.native`bytevector-append: concatenation of all bytevector arguments`(
      { input: z.array(z.unknown()), output: [z.sbytevector] },
      (...bvs: unknown[]): ABytevector => {
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
      { input: [z.sbytevector, z.schemeNumber.optional(), z.schemeNumber.optional()], output: [z.schemeString] },
      (bv: unknown, start?: unknown, end?: unknown): AString => {
        const view = asBytevector(bv, "utf8->string");
        const s = start === undefined ? 0 : toIndex(start);
        const e = end === undefined ? view.byteLength : toIndex(end);
        return withInputProvenance([bv], new AString(CONSTANT_CTX, new TextDecoder("utf-8").decode(view.subarray(s, e))));
      },
    ),

    "string->utf8": symbol.native`string->utf8: encode a string slice as UTF-8 bytes`(
      { input: [z.schemeString, z.schemeNumber.optional(), z.schemeNumber.optional()], output: [z.sbytevector] },
      (str: unknown, start?: unknown, end?: unknown): ABytevector => {
        const s_str = stringValue(str);
        const s = start === undefined ? 0 : toIndex(start);
        const e = end === undefined ? s_str.length : toIndex(end);
        return withInputProvenance([str], new ABytevector(CONSTANT_CTX, new TextEncoder().encode(s_str.slice(s, e))));
      },
    ),
  },
});
