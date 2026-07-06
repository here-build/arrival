/**
 * Bridge — the R7RS error-object predicate surface + the native foundation pack roster.
 *
 * Historically this module bridged the Operator/Profunctor numeric system to the
 * Scheme runtime (the `wrapOperator` / `Operator` / `Codec` stack). That numeric core
 * has been carved into the `scheme/numeric` pack (env/r7rs/numeric.ts) and is bound
 * via `symbol.native`. What remains here:
 *   1. `wrappedOps` / `exceptionsCapability` — the genuine R7RS §6.11 PREDICATES
 *      (error-object?/error-object-message/error-object-irritants/read-error?/
 *      file-error?), as a pack. The exception FORMS (raise/raise-continuable/
 *      with-exception-handler/error/guard) and the machinery they need
 *      (%raise/%current-handlers/%set-handlers!/make-error-object) moved to
 *      `scheme/r7rs/exceptions` (env/r7rs/exceptions.ts) — that pack's OWN prelude
 *      was the only caller of that machinery, so it now owns it directly instead of
 *      depending on this pack via roster-order accident (no explicit `deps` ever
 *      declared the link).
 *   2. `GLOBAL_NATIVE_PACKS` — the native foundation roster (NATIVE_PACKS + the
 *      exceptions pack) that the runtime bootstrap assembles onto global_env;
 *   3. the `coerceNumeric` re-export (its home is op-helpers.ts).
 *
 * The bootstrap ASSEMBLY itself no longer lives here. The old `initBridge` ceremony
 * (a bespoke realm-flag dance + a separate eager call) is gone: the lazy, realm-cached
 * base assembly now lives in the one entry point that needs it — `ensureBaseAssembled`
 * in eval/generator-exec.ts, driven directly by `exec`. Dropping that function removed
 * this module's `exec`/stdlib edge, so bridge.ts is now a near-leaf (no generator-exec
 * cycle) — which is exactly why generator-exec.ts can import `GLOBAL_NATIVE_PACKS` here.
 */

import { R7RSError, R7RSFileError, R7RSReadError } from "./errors.js";
import { CONSTANT_CTX } from "./values/primitives/RunContext.js";
import { EnvCapability } from "./common/capability.js";
import { symbol } from "./common/symbol.js";
import * as z from "./common/scheme-zod.js";
// The value-domain primitive clusters AND the numeric core are assembled onto
// global_env from `GLOBAL_NATIVE_PACKS` below (NATIVE_PACKS + the exceptions pack).
// `wrappedOps` keeps only the R7RS error-object predicates.
import { NATIVE_PACKS } from "./env/native-packs.js";
import { APair } from "./values/primitives/APair.js";
import { nil } from "./values/primitives/ANil.js";
import "./errors.js";

// `coerceNumeric` (+ the numeric coercion / provenance helpers) lives in the leaf
// `op-helpers.ts`. Re-exported here for the external importers (evaluator, tests)
// that still reach for it via `bridge.js`.
export { coerceNumeric } from "./values/op-helpers.js";

// R7RSError / R7RSReadError / R7RSFileError relocated to errors.ts (the single error home).

export const wrappedOps = {
  // The entire numeric core (arithmetic / comparison / tower predicates / exactness
  // conversions / the inline misc ops) has been carved into the `scheme/numeric`
  // pack (env/r7rs/numeric.ts), bound via `symbol.native`. The exception FORMS +
  // machinery live in `scheme/r7rs/exceptions` (env/r7rs/exceptions.ts) now. What
  // remains here is JUST the R7RS § 6.11 error-object predicate surface — sourced
  // into `exceptionsCapability` below.

  // ============================================================================
  // R7RS Exception Handling (Section 6.11) — the predicate surface
  // ============================================================================

  "error-object?"(obj: unknown): boolean {
    return obj instanceof R7RSError;
  },

  "error-object-message"(err: unknown): string {
    // R7RS § 6.11: `error-object-message` is only defined over error objects
    // (values produced by the `error` procedure). The previous permissive
    // implementation returned `err.message` for any JS `Error` and stringified
    // anything else — meaning callers couldn't distinguish "real R7RS error"
    // from "some other thrown value happened to expose a message field."
    // Fail loudly instead.
    TypeError.invariant(err instanceof R7RSError, "error-object-message: argument is not an error object");
    return err.message;
  },

  "error-object-irritants"(err: unknown): unknown {
    if (err instanceof R7RSError) {
      // Convert JS array to Scheme list
      let result: unknown = nil;
      for (let i = err.irritants.length - 1; i >= 0; i--) {
        result = new APair(CONSTANT_CTX, err.irritants[i], result);
      }
      return result;
    }
    return nil;
  },

  "read-error?"(obj: unknown): boolean {
    return obj instanceof R7RSReadError;
  },

  "file-error?"(obj: unknown): boolean {
    return obj instanceof R7RSFileError;
  },
};

// ============================================================================
// Environment Integration
// ============================================================================

// The R7RS § 6.11 error-object PREDICATES — now the SOLE content of `wrappedOps`
// (the numeric core was carved into `scheme/numeric`; the exception FORMS + their
// machinery moved to `scheme/r7rs/exceptions`, env/r7rs/exceptions.ts). Sourced into
// `exceptionsCapability` below so they assemble like every other domain — no
// imperative `applyToEnvironment` monolith.

/** The R7RS § 6.11 error-object predicates as a pack. DELIBERATELY dumb: one literal
 *  `symbol.native` declaration per verb, no filter/roster/Set indirection building
 *  the `symbols` object programmatically — this object IS the complete roster, read
 *  top-to-bottom, nothing to cross-reference. Each impl is `wrappedOps.<verb>` (the
 *  single source of the actual JS body — `wrappedOps` stays exactly as-is, still the
 *  public re-export other consumers import directly, see index.ts). Every input is
 *  representation-blind (`z.unknown()`, matching each verb's own `unknown`-typed
 *  param) except the genuinely-boolean/string returns, which get the concrete codec
 *  so the contract documents them honestly. NOTHING else lives here — the exception
 *  FORMS (raise/guard/with-exception-handler/error) and the machinery they need
 *  (%raise/%current-handlers/%set-handlers!/make-error-object) are self-contained in
 *  `scheme/r7rs/exceptions` now, not split across two packs joined by roster order. */
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
 *  by `ensureBaseAssembled` (eval/generator-exec.ts), which lowers and applies it onto
 *  global_env as the first step of the lazy runtime bootstrap. Exported (not local)
 *  because the assembly that uses it lives in generator-exec.ts now, not here. */
export const GLOBAL_NATIVE_PACKS: readonly EnvCapability[] = [...NATIVE_PACKS, exceptionsCapability];

/**
 * `initBridge` — the public name for "ensure the runtime base is assembled," kept as a
 * thin alias of the realm-cached `ensureBaseAssembled` (eval/generator-exec.ts). The
 * bespoke bootstrap CEREMONY is gone (no realm-flag dance, no separate eager kick); this
 * is just the one trigger the lazy assembly exposes, so the load-bearing external callers
 * (inhuman's cli.ts `await initBridge()`) and the many tests that warm the base with
 * `await initBridge()` keep one stable name. Idempotent and promise-cached: a second call
 * awaits the same settled promise. The static `bridge → generator-exec` edge is safe —
 * generator-exec imports the pack rosters back DYNAMICALLY, so no module-eval cycle closes.
 */
export { ensureBaseAssembled as initBridge } from "./eval/generator-exec.js";
