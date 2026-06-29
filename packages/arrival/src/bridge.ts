/**
 * Bridge — the R7RS exception machinery + the native foundation pack roster.
 *
 * Historically this module bridged the Operator/Profunctor numeric system to the
 * Scheme runtime (the `wrapOperator` / `Operator` / `Codec` stack). That numeric core
 * has been carved into the `scheme/numeric` pack (env/r7rs/numeric.ts) and is bound
 * via `symbol.native`. What remains here:
 *   1. `wrappedOps` / `exceptionsCapability` — the R7RS §6.11 exception verbs + the
 *      exception-handler stack, as a pack;
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

import { R7RSError, R7RSReadError, R7RSFileError, RaisedException } from "./errors.js";
import { CONSTANT_CTX } from "./values/primitives/RunContext.js";
import { EnvCapability } from "./common/capability.js";
// The value-domain primitive clusters AND the numeric core are assembled onto
// global_env from `GLOBAL_NATIVE_PACKS` below (NATIVE_PACKS + the exceptions pack).
// `wrappedOps` keeps only the R7RS exception machinery.
import { NATIVE_PACKS } from "./env/native-packs.js";
import { AString } from "./values/primitives/AString.js";
import { APair } from "./values/primitives/APair.js";
import { nil } from "./values/primitives/ANil.js";
import "./errors.js";

// `coerceNumeric` (+ the numeric coercion / provenance helpers) lives in the leaf
// `op-helpers.ts`. Re-exported here for the external importers (evaluator, tests)
// that still reach for it via `bridge.js`.
export { coerceNumeric } from "./values/op-helpers.js";

// R7RSError / R7RSReadError / R7RSFileError / RaisedException relocated to errors.ts (the single error home).

// The R7RS exception handler stack — a module-level holder (the dynamic-holder family,
// alongside the evaluator's _dynamicCallSite/_currentRunEnv). Replaces the old set!'d
// `*current-exception-handlers*` scheme cell: the R7RS exception forms push/pop it via the
// `%current-handlers`/`%set-handlers!` primitives below, so NO scheme `set!` remains.
// Process-global like the cell was (same dynamic visibility, so a deep `raise` sees it);
// per-run isolation lands later when the dynamic holders thread per-run through the trampoline.
let currentHandlers: unknown = nil;

export const wrappedOps = {
  // The entire numeric core (arithmetic / comparison / tower predicates / exactness
  // conversions / the inline misc ops) has been carved into the `scheme/numeric`
  // pack (env/r7rs/numeric.ts), bound via `symbol.native`. What remains here is the
  // R7RS § 6.11 exception machinery — sourced into `exceptionsCapability` below.

  // ============================================================================
  // R7RS Exception Handling (Section 6.11)
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

  "make-error-object"(message: unknown, ...irritants: unknown[]): R7RSError {
    const msg = message instanceof AString ? message.valueOf() : String(message);
    return new R7RSError(msg, ...irritants);
  },

  "raise-exception"(obj: unknown): never {
    throw new RaisedException(obj, false);
  },

  "raise-continuable-exception"(obj: unknown): never {
    throw new RaisedException(obj, true);
  },

  "raised-exception?"(obj: unknown): boolean {
    return obj instanceof RaisedException;
  },

  "raised-exception-value"(exc: unknown): unknown {
    if (exc instanceof RaisedException) {
      return exc.value;
    }
    return exc;
  },

  "raised-exception-continuable?"(exc: unknown): boolean {
    if (exc instanceof RaisedException) {
      return exc.continuable;
    }
    return false;
  },

  // Throw the object directly (not wrapped in Error with toString)
  // This preserves the original object type for R7RS exception handling
  "%raise"(obj: unknown): never {
    throw obj;
  },

  // Read / replace the handler stack (machinery; the R7RS forms push/pop through these
  // instead of mutating a scheme binding with `set!`).
  "%current-handlers"(): unknown {
    return currentHandlers;
  },

  "%set-handlers!"(handlers: unknown): unknown {
    currentHandlers = handlers;
    return nil;
  },
};

// ============================================================================
// Environment Integration
// ============================================================================

// The R7RS § 6.11 exception verbs — now the SOLE content of `wrappedOps` (the numeric
// core was carved into the `scheme/numeric` pack). Sourced into `exceptionsCapability`
// below so they assemble like every other domain — no imperative `applyToEnvironment`
// monolith. The `EXCEPTION_VERBS` set is retained as the explicit roster of what this
// pack owns (and now matches `wrappedOps` in full).
const EXCEPTION_VERBS = new Set([
  "error-object?",
  "error-object-message",
  "error-object-irritants",
  "read-error?",
  "file-error?",
  "make-error-object",
  "raise-exception",
  "raise-continuable-exception",
  "raised-exception?",
  "raised-exception-value",
  "raised-exception-continuable?",
  "%raise",
  "%current-handlers",
  "%set-handlers!",
]);

const symbolsFrom = (entries: [string, unknown][]) => Object.fromEntries(entries.map(([k, v]) => [k, { value: v }]));

/** The R7RS § 6.11 exception verbs as a pack. The numeric core that used to share
 *  `wrappedOps` with these has been carved into the `scheme/numeric` pack (NATIVE_PACKS),
 *  so `wrappedOps` is now ALL exception verbs and the `EXCEPTION_VERBS` filter keeps them
 *  all — retained as documentation of the cut. */
export const exceptionsCapability = new EnvCapability("scheme/exceptions", {
  symbols: symbolsFrom(Object.entries(wrappedOps).filter(([k]) => EXCEPTION_VERBS.has(k))),
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
