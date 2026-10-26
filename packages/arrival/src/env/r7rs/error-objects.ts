/**
 * `scheme/exceptions` — the R7RS §6.11 ERROR-OBJECT PREDICATES as a native pack.
 *
 * What §6.11 splits into, and why across two packs:
 *   - THIS pack: the pure predicates over already-thrown values —
 *     `error-object?` / `error-object-message` / `error-object-irritants` /
 *     `read-error?` / `file-error?`. Plain natives over the `errors.ts` classes;
 *     no evaluator machinery, no prelude.
 *   - `scheme/r7rs/exceptions` (./exceptions.ts): the exception FORMS
 *     (raise/raise-continuable/with-exception-handler/error/guard) and their
 *     machinery (%raise/%current-handlers/…) — those need the scheme-layer
 *     prelude, so they ride the scheme pack phase, not this one.
 */

import { R7RSError, R7RSFileError, R7RSReadError } from "../../errors.js";
import { EnvCapability } from "../../common/capability.js";
import { APair } from "../../values/primitives/APair.js";
import { nil } from "../../values/primitives/ANil.js";
import { AString } from "../../values/primitives/AString.js";
import { schemeBool } from "../../values/op-helpers.js";
import { type SchemeValue } from "../../values/types.js";

/** DELIBERATELY dumb roster: one literal `symbol.native` declaration per verb, no
 *  filter/Set indirection — this object IS the complete roster, read top-to-bottom.
 *  Every input is representation-blind (`z.schemeValue`); the boolean/string returns
 *  get the concrete codec so the contract documents them honestly. */
export default EnvCapability.define("scheme/exceptions", {
  symbols: (symbol, z) => ({
    "error-object?": symbol.native`error-object?: #t iff obj is an R7RS error object`(
      { input: [z.schemeValue], output: [z.boolean] },
      function (obj) {
        return schemeBool(obj instanceof R7RSError);
      },
    ),
    "error-object-message": symbol.native`error-object-message: the error object's message string`(
      { input: [z.schemeValue], output: [z.string] },
      function (err) {
        // R7RS § 6.11: only defined over error objects (values from the `error` procedure) —
        // fail loudly rather than accept any thrown value that happens to expose a message.
        TypeError.invariant(err instanceof R7RSError, "error-object-message: argument is not an error object");
        return new AString(err.message);
      },
    ),
    "error-object-irritants": symbol.native`error-object-irritants: the error object's irritants as a list`(
      { input: [z.schemeValue], output: [z.schemeValue] },
      function (err) {
        if (!(err instanceof R7RSError)) return nil;
        let result: SchemeValue = nil;
        for (let i = err.irritants.length - 1; i >= 0; i--) {
          // R7RSError.irritants is unknown[]: host-side builders store JS values there too.
          result = new APair(err.irritants[i] as SchemeValue, result);
        }
        return result;
      },
    ),
    "read-error?": symbol.native`read-error?: #t iff obj is a read error`(
      { input: [z.schemeValue], output: [z.boolean] },
      function (obj) {
        return schemeBool(obj instanceof R7RSReadError);
      },
    ),
    "file-error?": symbol.native`file-error?: #t iff obj is a file error`(
      { input: [z.schemeValue], output: [z.boolean] },
      function (obj) {
        return schemeBool(obj instanceof R7RSFileError);
      },
    ),
  }),
});
