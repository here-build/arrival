/**
 * Bridge — the R7RS error-object predicate surface + the native foundation pack roster.
 *
 * What lives here:
 *   1. `wrappedOps` / `exceptionsCapability` — the R7RS §6.11 error-object PREDICATES
 *      (error-object?/error-object-message/error-object-irritants/read-error?/
 *      file-error?), as a pack. The exception FORMS (raise/raise-continuable/
 *      with-exception-handler/error/guard) and their machinery
 *      (%raise/%current-handlers/%set-handlers!/make-error-object) live in
 *      `scheme/r7rs/exceptions` (env/r7rs/exceptions.ts) instead — that pack's own
 *      prelude is the only caller of that machinery.
 *   2. `GLOBAL_NATIVE_PACKS` — the native foundation roster (NATIVE_PACKS + the
 *      exceptions pack) the runtime bootstrap assembles onto global_env.
 *   3. the `coerceNumeric` re-export (home: op-helpers.ts).
 *
 * The numeric core (arithmetic/comparison/tower predicates/exactness conversions)
 * lives in the `scheme/numeric` pack (env/r7rs/numeric.ts), bound via `symbol.native`
 * — not here.
 *
 * bridge.ts has no `exec`/stdlib edge, making it a near-leaf — which is why
 * generator-exec.ts can import `GLOBAL_NATIVE_PACKS` from here without a cycle. The
 * bootstrap ASSEMBLY lives in `ensureBaseAssembled` (eval/generator-exec.ts), driven
 * by `exec`.
 */

import { R7RSError, R7RSFileError, R7RSReadError } from "./errors.js";
import { CONSTANT_CTX } from "./values/primitives/RunContext.js";
import { EnvCapability } from "./common/capability.js";
import { symbol } from "./common/symbol.js";
import * as z from "./common/scheme-zod.js";
import { NATIVE_PACKS } from "./env/native-packs.js";
import { APair } from "./values/primitives/APair.js";
import { nil } from "./values/primitives/ANil.js";
import { type ABool } from "./values/primitives/ABool.js";
import { AString } from "./values/primitives/AString.js";
import { schemeBool } from "./values/op-helpers.js";
import { type SchemeValue } from "./values/types.js";
import "./errors.js";

// `coerceNumeric` (+ the numeric coercion / provenance helpers) lives in the leaf
// `op-helpers.ts`. Re-exported here for the external importers (evaluator, tests)
// that still reach for it via `bridge.js`.
export { coerceNumeric } from "./values/op-helpers.js";

export const wrappedOps = {
  // ============================================================================
  // R7RS Exception Handling (Section 6.11) — the predicate surface
  // ============================================================================

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

// ============================================================================
// Environment Integration
// ============================================================================

// Sourced into `exceptionsCapability` below so the predicates assemble like every
// other domain — no imperative `applyToEnvironment` monolith.

/** The R7RS § 6.11 error-object predicates as a pack. DELIBERATELY dumb: one literal
 *  `symbol.native` declaration per verb, no filter/roster/Set indirection building the
 *  `symbols` object programmatically — this object IS the complete roster, read
 *  top-to-bottom, nothing to cross-reference. Each impl is `wrappedOps.<verb>` (the
 *  single source of the actual JS body — `wrappedOps` stays the public re-export other
 *  consumers import directly, see index.ts). Every input is representation-blind
 *  (`z.value`, matching each verb's own `unknown`-typed param) except the
 *  genuinely-boolean/string returns, which get the concrete codec so the contract
 *  documents them honestly. */
export const exceptionsCapability = new EnvCapability("scheme/exceptions", {
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

/** The full native foundation assembled onto global_env: the value-domain clusters +
 *  the numeric pack (both in NATIVE_PACKS) + the bridge's own exceptions pack. Consumed
 *  by `ensureBaseAssembled` (eval/generator-exec.ts) as the first step of the lazy
 *  runtime bootstrap. Exported (not local) because the assembly that uses it lives in
 *  generator-exec.ts, not here. */
export const GLOBAL_NATIVE_PACKS: readonly EnvCapability[] = [...NATIVE_PACKS, exceptionsCapability];

/**
 * `initBridge` — the public name for "ensure the runtime base is assembled," a thin
 * alias of the realm-cached `ensureBaseAssembled` (eval/generator-exec.ts). Keeps one
 * stable name for external callers (inhuman's cli.ts `await initBridge()`) and tests
 * that warm the base the same way. Idempotent and promise-cached: a second call awaits
 * the same settled promise. The static `bridge → generator-exec` edge is safe —
 * generator-exec imports the pack rosters back DYNAMICALLY, so no module-eval cycle closes.
 */
export { ensureBaseAssembled as initBridge } from "./eval/generator-exec.js";
