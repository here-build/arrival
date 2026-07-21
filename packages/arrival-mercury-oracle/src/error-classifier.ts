/**
 * The closed error taxonomy both worlds classify into (oracle-harness.md §2/§4.2's
 * "same error class, message may drift" half of the agreement law). `runOracle`
 * compares the CLASS, never the message: the interpreter throws rich `ArrivalError`
 * subclasses, each declaring its own `"arrival/error-category"` field directly (see
 * `@inhuman.tools/arrival`'s errors.ts — `evalInterpreter` in `./harness.js` reads it
 * off the caught error, no classifier function needed on that side any more); the
 * compiled artifact throws whatever V8/tsx surfaces (`ReferenceError`, `TypeError`,
 * the harness's own `error()` shim), which has no such hierarchy to hang a field on,
 * so `classifyCompiledError` below still duck-types by name/message shape. The two
 * shapes are structurally unrelated by design; this union is the one shared
 * vocabulary between them.
 */
import type { ErrorClass } from "@inhuman.tools/arrival";
export type { ErrorClass };

const nameOf = (e: unknown): string => (e instanceof Error ? e.name : "");
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Compiled-side classification — two error populations flow through here
 * (oracle-harness.md §2's `prohibited-dynamics` note: "a compile-time Door
 * surfaces through evalCompiled as a classified throw, same path
 * unsupported-form already uses"):
 *
 * 1. COMPILE-time: doors from either subject. Greenfield doors carry the
 *    door-throw contract — the message BEGINS with the door code
 *    ("<category>/<slug>: …") — so slugs classify by prefix; mercury's legacy
 *    doors are plain `Error`s with teaching messages ("`case` is not yet
 *    desugared — rewrite as `cond`", "run-view: async `filter` is
 *    unsupported").
 * 2. RUN-time: whatever the executed artifact throws in-process — native
 *    `ReferenceError`/`TypeError`, the stage-0 runtime's `error()`
 *    (`.name === "SchemeUserError"`, src/runtime/stage0.ts), or the legacy
 *    preamble's shim (`.name === "OracleUserError"`, `COMPILED_PREAMBLE`).
 */
export function classifyCompiledError(e: unknown): ErrorClass {
  const name = nameOf(e);
  if (name === "OracleUserError" || name === "SchemeUserError") return "user-error";
  const message = messageOf(e);
  // The walker's unresolved-identifier door IS the compiled world's unbound
  // variable (its slug files under unsupported-form/, but the SEMANTIC class —
  // what the interpreter throws for the same program — is unbound-variable;
  // prefix-matched BEFORE the generic /unsupported/ sweep below).
  if (message.startsWith("unsupported-form/unresolved-identifier")) return "unbound-variable";
  // Gated on V8's actual unbound-identifier shape: a TDZ ReferenceError
  // ("Cannot access 'x' before initialization") or a future emitter bug must
  // land "other" (loud, never agrees), not false-agree as unbound-variable.
  if (e instanceof ReferenceError) return / is not defined/.test(message) ? "unbound-variable" : "other";
  // TypeError stays deliberately coarse (not-callable, bad-property-access):
  // a known both-throw false-agree seam. Phase-1's fuzzer stresses it;
  // tighten to message-shape tokens if it ever greens a real divergence.
  if (e instanceof TypeError) return "type-mismatch";
  // Scheme-identifier-bounded match: `-` and `!` are identifier characters in
  // Scheme, so a bare /set!/ would swallow `reset!`/`subset!` messages. The
  // boundary is "start-of-string or a non-identifier character" on both sides.
  const notIdent = String.raw`[^A-Za-z0-9!$%&*/:<=>?^_~+.@-]`;
  const dynamicsRe = new RegExp(
    String.raw`(?:^|${notIdent})(?:set!|set-car!|set-cdr!|call/cc|call-with-current-continuation|dynamic-wind)(?=$|${notIdent})|prohibited-dynamics`,
  );
  if (dynamicsRe.test(message)) return "prohibited-dynamics";
  if (/not yet desugared|unsupported|not supported/i.test(message)) return "unsupported-form";
  if (/division by zero/i.test(message)) return "division-by-zero";
  return "other";
}
