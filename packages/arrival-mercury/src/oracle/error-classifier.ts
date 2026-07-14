/**
 * The closed error taxonomy both worlds classify into, independently — the
 * "same error class, message may drift" half of the oracle's agreement law
 * (oracle-harness.md §2/§4.2). `runOracle` compares the CLASS, never the
 * message: the interpreter throws rich `ArrivalError` subclasses with a
 * `schemeStack`; the compiled artifact throws whatever V8/tsx surfaces
 * (`ReferenceError`, `TypeError`, the harness's own `error()` shim). The two
 * shapes are structurally unrelated by design, so equivalence lives in this
 * one shared vocabulary.
 *
 * Duck-typed throughout (`.name` / `.cause.name` / message shapes), NOT
 * `instanceof`: only `ArrivalError` is exported from the `@here.build/arrival`
 * barrel — `R7RSError`, `ExactOverflowError`, `PurityError`,
 * `UnboundVariableError` are internal (verified 2026-07-14), and a classifier
 * must not force a barrel-export change to read a name it can already see.
 */

export type ErrorClass =
  | "empty-list-access"
  | "unbound-variable"
  | "type-mismatch"
  | "division-by-zero"
  | "arity-mismatch"
  | "unsupported-form"
  | "exact-overflow" // the RATIO ruling's crash-on-overflow guarantee (constitution §7)
  | "prohibited-dynamics" // immutability/no-dynamics law (constitution §2.2): set!/call-cc/dynamic-wind family
  | "user-error" // an R7RS (error …) raise — the immutability-legal short-circuit probe
  | "other";

const nameOf = (e: unknown): string => (e instanceof Error ? e.name : "");
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const causeNameOf = (e: unknown): string => {
  const cause = e instanceof Error ? (e as { cause?: unknown }).cause : undefined;
  return cause instanceof Error ? cause.name : "";
};

/**
 * Interpreter-side classification. The trampoline (`failAndWrap`) rethrows
 * `ArrivalError` subclasses VERBATIM (class identity + `.name` preserved:
 * `UnboundVariableError`, `ExactOverflowError`, `PurityError`, …) and wraps
 * everything else into a plain `ArrivalError` with the original as `.cause` —
 * which is how an R7RS `(error …)` raise arrives: `ArrivalError` whose
 * `.cause.name === "R7RSError"` (probed live 2026-07-14). tiny-invariant
 * throws (`"Invariant failed: Division by zero"`, `AExact.ts:41`) arrive the
 * same wrapped way, so those classify by message shape.
 */
export function classifyInterpreterError(e: unknown): ErrorClass {
  const name = nameOf(e);
  if (name === "ExactOverflowError") return "exact-overflow";
  if (name === "PurityError") return "prohibited-dynamics";
  if (name === "UnboundVariableError") return "unbound-variable";
  // A number/string in call-head position, a value failing a builtin's zod
  // contract — the interpreter's "wrong kind of value" family.
  if (name === "NotCallableError" || name === "OutputContractError") return "type-mismatch";
  // (error "msg" irritants…): R7RSError (or a subclass, R7RSReadError/R7RSFileError)
  // escapes execState wrapped as ArrivalError{cause: R7RSError} — but classify the
  // bare shape too, in case a raise ever reaches us unwrapped.
  if (/^R7RS/.test(name) || /^R7RS/.test(causeNameOf(e))) return "user-error";
  const message = messageOf(e);
  if (/division by zero/i.test(message)) return "division-by-zero";
  if (/\barity\b|wrong number of arguments/i.test(message)) return "arity-mismatch";
  if (/(car|cdr)[^]*empty list|empty list[^]*(car|cdr)/i.test(message)) return "empty-list-access";
  return "other";
}

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
