/**
 * `scheme/exceptions` — the R7RS §6.11 ERROR-OBJECT PREDICATES as a native pack.
 *
 * What §6.11 splits into, and why across two packs:
 *   - THIS pack: the pure predicates over already-thrown values —
 *     `error-object?` / `error-object-message` / `error-object-irritants` /
 *     `read-error?` / `file-error?`. Plain natives over the `errors.ts` classes;
 *     no evaluator machinery, no prelude — so they ride the NATIVE foundation
 *     (native-packs.ts roster, assembled onto global_env at bootstrap).
 *   - `scheme/r7rs/exceptions` (./exceptions.ts): the exception FORMS
 *     (raise/raise-continuable/with-exception-handler/error/guard) and their
 *     machinery (%raise/%current-handlers/…) — those need the scheme-layer
 *     prelude, so they ride the scheme pack phase, not this one.
 *
 * Lineage: this is the LAST survivor of `bridge.ts` — the LIPS-era JS↔interpreter
 * bridge monolith, carved down over ~93 commits (numerics → r7rs/numeric P1–P5,
 * exception forms → r7rs/exceptions, fl-interop/lips-compat dissolved). When the
 * predicates moved here, bridge.ts had nothing left and was deleted; its other
 * exports were always re-exports (`coerceNumeric` → values/op-helpers.ts,
 * `initBridge` → eval/generator-exec.ts `ensureBaseAssembled`) and index.ts now
 * points at the real homes.
 *
 * `wrappedOps` keeps its historical public name (index.ts re-export): the impl
 * table IS the API some external consumers import; each pack entry below binds
 * `wrappedOps.<verb>` so there is exactly one source of each JS body.
 */

import { R7RSError, R7RSFileError, R7RSReadError } from "../../errors.js";
import { CONSTANT_CTX } from "../../values/primitives/RunContext.js";
import { EnvCapability } from "../../common/capability.js";
import { symbol } from "../../common/symbol.js";
import * as z from "../../common/scheme-zod.js";
import { APair } from "../../values/primitives/APair.js";
import { nil } from "../../values/primitives/ANil.js";
import { type ABool } from "../../values/primitives/ABool.js";
import { AString } from "../../values/primitives/AString.js";
import { schemeBool } from "../../values/op-helpers.js";
import { type SchemeValue } from "../../values/types.js";

export const wrappedOps = {
  "error-object?"(obj: unknown): ABool {
    return schemeBool(obj instanceof R7RSError);
  },

  "error-object-message"(err: unknown): AString {
    // R7RS § 6.11: only defined over error objects (values from the `error` procedure) —
    // fail loudly rather than accept any thrown value that happens to expose a message.
    TypeError.invariant(err instanceof R7RSError, "error-object-message: argument is not an error object");
    return new AString(CONSTANT_CTX, err.message);
  },

  "error-object-irritants"(err: unknown): SchemeValue {
    if (err instanceof R7RSError) {
      let result: SchemeValue = nil;
      for (let i = err.irritants.length - 1; i >= 0; i--) {
        result = new APair(CONSTANT_CTX, err.irritants[i] as SchemeValue, result);
      }
      return result;
    }
    return nil;
  },

  "read-error?"(obj: unknown): ABool {
    return schemeBool(obj instanceof R7RSReadError);
  },

  "file-error?"(obj: unknown): ABool {
    return schemeBool(obj instanceof R7RSFileError);
  },
};

/** DELIBERATELY dumb roster: one literal `symbol.native` declaration per verb, no
 *  filter/Set indirection — this object IS the complete roster, read top-to-bottom.
 *  Every input is representation-blind (`z.value`, matching each verb's own
 *  `unknown`-typed param) except the genuinely-boolean/string returns, which get the
 *  concrete codec so the contract documents them honestly. */
export default new EnvCapability("scheme/exceptions", {
  symbols: {
    "error-object?": symbol.native`error-object?: #t iff obj is an R7RS error object`(
      { input: [z.value], output: [z.boolean] },
      wrappedOps["error-object?"],
    ),
    "error-object-message": symbol.native`error-object-message: the error object's message string`(
      { input: [z.value], output: [z.string] },
      wrappedOps["error-object-message"],
    ),
    "error-object-irritants": symbol.native`error-object-irritants: the error object's irritants as a list`(
      { input: [z.value], output: [z.value] },
      wrappedOps["error-object-irritants"],
    ),
    "read-error?": symbol.native`read-error?: #t iff obj is a read error`(
      { input: [z.value], output: [z.boolean] },
      wrappedOps["read-error?"],
    ),
    "file-error?": symbol.native`file-error?: #t iff obj is a file error`(
      { input: [z.value], output: [z.boolean] },
      wrappedOps["file-error?"],
    ),
  },
});
