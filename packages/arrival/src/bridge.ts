/**
 * Bridge — the bootstrap assembler + the R7RS exception machinery.
 *
 * Historically this module bridged the Operator/Profunctor numeric system to the
 * Scheme runtime (the `wrapOperator` / `Operator` / `Codec` stack). That numeric core
 * has been carved into the `scheme/numeric` pack (env/r7rs/numeric.ts) and is bound
 * via `symbol.native`. What remains here:
 *   1. `initBridge` — assembles the native foundation (NATIVE_PACKS + the exceptions
 *      pack) onto global_env and the `.scm` base packs onto user_env;
 *   2. `wrappedOps` — the R7RS §6.11 exception verbs + the exception-handler stack;
 *   3. the `coerceNumeric` re-export (its home is op-helpers.ts).
 */

import { R7RSError, R7RSReadError, R7RSFileError, RaisedException } from "./errors.js";
import { CONSTANT_CTX } from "./values/primitives/RunContext.js";
import { isBridgeInitialized, markBridgeInitialized, setBootstrapComplete } from "./boot.js";
import { EnvCapability } from "./common/capability.js";
import { assembleEnv } from "./common/kernel.js";
import { BASE_PACKS } from "./env/base-packs.js";
import type { EvalSchemeInto, SchemeEnv } from "./common/scheme-env.js";
import type { Environment } from "./Environment.js";
// The value-domain primitive clusters AND the numeric core are assembled onto
// global_env by `initBridge` as live capability packs (NATIVE_PACKS). `wrappedOps`
// now keeps only the R7RS exception machinery.
import { NATIVE_PACKS } from "./env/native-packs.js";
import { env as userEnv, exec, global_env } from "./stdlib.js";
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
 *  the numeric pack (both in NATIVE_PACKS) + the bridge's own exceptions pack. */
const GLOBAL_NATIVE_PACKS = [...NATIVE_PACKS, exceptionsCapability];

/**
 * Initialize bridge by applying all wrapped operators to the global LIPS environment
 * and evaluating the bootstrap Scheme code.
 */
let bootstrapPromise: Promise<void> | null = null;

export function initBridge(): Promise<void> {
  if (isBridgeInitialized() && bootstrapPromise) return bootstrapPromise;
  // Set the realm-level flag at the TOP, before the prelude eval below — so the
  // re-entrant inner exec (a pack prelude) sees `initialized === true` and skips
  // its own self-init (no recursion). See boot.ts.
  markBridgeInitialized();

  // The whole native foundation — value-domain clusters + numbers + exceptions — is
  // now assembled onto global_env as capability packs in the async chain below; the
  // imperative `applyToEnvironment(global_env)` monolith is gone. Async native
  // application is fine: every public `exec` awaits bootstrap COMPLETION (boot.ts
  // whenBootstrapComplete), not just the started-flag, so a racing exec never observes
  // a half-assembled env. (Bootstrap's own prelude evals use stdlib's gate-free `exec`,
  // so the completion await is never re-entrant.)

  // The scheme stdlib loads by ASSEMBLING the base packs onto user_env — not by
  // exec-ing one hand-concatenated `BOOTSTRAP_SCHEME` string. `assembleEnv` runs
  // each pack's full contribution (prelude + symbols + resolvers) in C3 order, so
  // the packs are the SOLE source of the scheme surface: e.g. polyglot's `@`/`:key`
  // and arrival's `symbol->string` now land here via their owning capability rather
  // than via separate hand-wiring. `evalScheme` injects the evaluator (exec into the
  // assembling env). The base preludes are verified mutually order-independent (none
  // expands another's macro), so the C3 application order is immaterial to them.
  // skipBootstrapWait: this exec IS the bootstrap (a base-pack prelude eval), so it
  // must NOT await bootstrap completion — that would deadlock on the very promise it
  // is part of.
  const evalScheme: EvalSchemeInto = (env, src) =>
    exec(src as string, { env: env as Environment, skipBootstrapWait: true });

  // Evaluate bootstrap Scheme code asynchronously, then expose a curated set of
  // bootstrap-defined bindings in the inference plane. They live in user_env; copy the
  // values into inferenceEnv so inference-plane/showcase code can reach them:
  //   • threading macros ->/->>/~>/~>>  — pure code-rewrites.
  //   • SRFI-26 cut/cute               — partial application; expand to a lambda.
  //   • gensym                          — cut/cute call it at expansion time for
  //                                       capture-safe slot names, so it has to be
  //                                       reachable from an inference-plane (cut …) site.
  // All pure: a macro's expansion still evaluates under the inference env, so
  // none adds a capability. (Dynamic import avoids a static bridge<->inference-env
  // import cycle.)
  //
  // NOT copied: the hygienic syntax family (define-syntax / let-syntax /
  // letrec-syntax + syntax-rules). They evaluate fine in the FULL env (the chibi
  // R7RS suite drives them), but the LIPS pattern matcher misbehaves under the
  // inference env — a `(double 50)` use of a inference-plane-defined syntax-rules macro
  // fails "no matching syntax in macro (50)". Env-specific matcher issue, tracked
  // separately; define-macro (an evaluator special form) is the working path for
  // user macros in the inference plane today.
  //   • SRFI-1 (the missing third), incl. the safe head accessors first?/first-or — pure
  //     list procedures. first?/first-or (the falsy/default-on-empty twins of `first`, now
  //     resident in srfi-1) make (car (filter …)) on an empty match safe — a falsy #f, not
  //     loose car's truthy nil. `remove` is now
  //     the SOLE source of `remove` in the inference plane (it used to shadow a broken Ramda
  //     `remove`; Ramda has since been removed entirely, so this copy is what supplies it).
  //   • Composition + quantifiers compose/comp/pipe/flow (polyglot) and some/every
  //     (SRFI-1). The inference plane (inferenceEnv) is the totalic env where models
  //     author Scheme; this composition/quantifier vocabulary used to reach it via the
  //     Ramda spread. Ramda has since been removed entirely, so copying the bootstrap
  //     definitions over is what keeps the plane's compose/pipe/some/every — sourced from
  //     pure Scheme. Pure, capability-free.
  // Assemble the native foundation (value-domain clusters + numbers + exceptions) onto
  // global_env FIRST (symbol-only, no prelude — `lower()` needs no evalScheme), THEN the
  // .scm base packs onto user_env. Order matters: a base-pack prelude may call a native
  // primitive (e.g. `string-length`, `+`), which resolves through user_env → global_env,
  // so the natives must already be live there.
  bootstrapPromise = assembleEnv(
    global_env as unknown as SchemeEnv,
    GLOBAL_NATIVE_PACKS.map((pack) => pack.lower()),
  ).then(() =>
    assembleEnv(
      userEnv as unknown as SchemeEnv,
      BASE_PACKS.map((pack) => pack.lower({ evalScheme })),
    ).then(() => {
      // No third inference-plane assembly. The one non-R7RS binding the inference plane
      // adds — `nil` (the LIPS-dialect alias for '()) — now lives in the polyglot base
      // pack's prelude (env/polyglot.ts), assembled onto user_env in the BASE_PACKS step
      // above. The inference plane is a user_env child (inference-env.ts), so it inherits
      // `nil` for free — no `lips-compat` capability, no inference-only assembly. Everything
      // else the plane reaches (threading macros, SRFI families, native clusters) already
      // resolved by that same inheritance.
    }),
  );
  // Publish the COMPLETION promise so a public `exec` racing a fire-and-forget
  // `void initBridge()` (index.ts) awaits the full async assembly, not just the flag.
  setBootstrapComplete(bootstrapPromise);
  return bootstrapPromise;
}
