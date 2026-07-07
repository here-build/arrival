// @here.build/arrival/r7rs/exceptions — R7RS-small §6.11 exception handling:
// *current-exception-handlers*, raise, raise-continuable, with-exception-handler,
// error, and the guard derived syntax.
//
// The OPPOSITE face of the purity doors (r7rs/control for dynamics, the type
// packs for mutators): those doors name what arrival omits for provenance
// soundness; this pack supplies the exception forms it keeps. Built on the host
// try/catch/finally special forms + the `%raise`/`%current-handlers`/
// `%set-handlers!`/`make-error-object` machinery below, all owned here —
// `scheme/exceptions` (bridge.ts) is now just the R7RS predicate surface
// (error-object?/error-object-message/etc).
//
// SINGLE SOURCE: this module is the sole definition site for both the machinery
// and the derived forms — no cross-capability ordering dependency remains.
import { EnvCapability } from "../../common/capability.js";
import { symbol } from "../../common/symbol.js";
import * as z from "../../common/scheme-zod.js";
import { R7RSError } from "../../errors.js";
import { AString } from "../../values/primitives/AString.js";
import { nil, type ANil } from "../../values/primitives/ANil.js";
import { CONSTANT_CTX, type RunContext } from "../../values/primitives/RunContext.js";
import type { SchemeValue } from "../../values/types.js";
import { CallCtx } from "../../common/symbols/_bake.js";

// Per-run isolation. The handler stack must be fresh per top-level `exec()` call
// but shared across every nested scope/lambda/let WITHIN that call. A module-level
// global leaks across every env in the process (base stdlib packs lower ONCE onto
// the singleton `user_env`); keying by the env object doesn't help either (a bare
// `exec(src)` with no capabilities/env option evaluates against that same shared
// singleton, so concurrent bare calls share the identical env object too).
//
// `RunContext` (`makeRunContext()`, minted once per `exec()`, threaded by reference
// through every nested frame) is the one thing that's both fresh per call and
// stable within it — so a side `WeakMap<RunContext, stack>` gives exactly the
// isolation R7RS's dynamic-extent handler stack needs. The stack can't live ON the
// RunContext itself (its fields are constant-per-run; the stack varies by call
// depth) — the WeakMap is the correct split, not a workaround.
//
// FALLBACK: a genuinely direct, non-evaluator invocation (no ctx at all — e.g. a
// raw unit test) falls through to the shared `CONSTANT_CTX` bucket. `execExpr`
// (required `.scm` module evaluation) mints its own `runCtx`, so required modules
// get the same per-run isolation as top-level `exec()` calls.
const handlerStacks = new WeakMap<RunContext, unknown>();

const runKeyOf = (ctx: CallCtx | undefined): RunContext => ctx?.runCtx ?? CONSTANT_CTX;

export default new EnvCapability("scheme/r7rs/exceptions", {
  symbols: {
    // Throw the object directly (not wrapped in an Error with toString) — preserves
    // the original object type for R7RS exception handling.
    "%raise": symbol.native`%raise: throw obj directly (machinery — the R7RS forms build on this)`(
      // `obj` is genuinely ANY scheme value (raise accepts arbitrary data, R7RS §6.11) —
      // `z.value` is the typed, representation-blind replacement for `z.value` at this
      // kind of slot (scheme-zod.ts's own documented convention). Output is `z.never()`:
      // the impl's own declared return type is `never` — it always throws.
      { input: [z.value], output: [z.undefinedResult] },
      (obj) => {
        throw obj;
      },
    ),
    // Read/replace the handler stack (machinery; the R7RS forms push/pop through these
    // instead of mutating a scheme binding with `set!`). From scheme's perspective these
    // are ordinary zero/one-arg calls; the ctx channel is invisible to calling code.
    "%current-handlers": symbol.native`%current-handlers: read the exception-handler stack (machinery)`(
      // The stack is a proper scheme list (nil, or a pair of a handler procedure + the rest
      // of the stack) — scheme-zod has no dedicated "list of procedures" vocabulary item, so
      // `z.value` (representation-blind scheme-value identity) is the honest ceiling here.
      { input: [], output: [z.value] },
      function (): SchemeValue {
        // Opaque storage (native ops run no validation) — the boundary cast states what
        // every write below actually stores: a scheme value (nil, or a handler-stack pair).
        return (handlerStacks.get(runKeyOf(this)) ?? nil) as SchemeValue;
      },
    ),
    "%set-handlers!": symbol.native`%set-handlers!: replace the exception-handler stack (machinery)`(
      // Input is the same list shape `%current-handlers` reads (see above). Output is
      // ALWAYS `nil` (the impl's own `return nil`) — `z.nil` is the exact honest type here,
      // not merely a wide one.
      { input: [z.value], output: [z.nil] },
      function (handlers) {
        handlerStacks.set(runKeyOf(this), handlers);
        return nil;
      },
    ),
    "make-error-object": symbol.native`make-error-object: build an R7RS error object from a message and irritants`(
      // `message` is display-rendered via `.valueOf()`/`String()` regardless of scheme type
      // (see the impl) — `z.value`. `irritants` are carried through untouched (any scheme
      // values, stored as-is on the error object) — `z.value` for the rest too. Output is a
      // real validator (`instanceof R7RSError`): the impl always returns this ONE concrete
      // host `Error` subclass, never an arbitrary scheme value.
      {
        input: [z.string],
        inputRest: z.value,
        output: [z.error],
      },
      (message, ...irritants) => {
        const msg = message instanceof AString ? message.valueOf() : String(message);
        return new R7RSError(msg, ...irritants);
      },
    ),
  },
  prelude: `
    ;; -----------------------------------------------------------------------------
    ;; R7RS Exception Handling
    ;; -----------------------------------------------------------------------------
    
    ;; R7RS §6.11: raise invokes the current handler in the dynamic environment of
    ;; the call to raise, except that the current exception handler is the one that
    ;; was in place when THIS handler was installed (i.e. the rest of the stack).
    ;; So we POP the handler before invoking it — otherwise a raise inside the
    ;; handler re-reads the same car and recurs forever. If a non-continuable
    ;; handler returns, a secondary exception is raised in the handler's dynamic
    ;; environment (the popped stack still in place).
    (define (raise obj)
      (if (null? (%current-handlers))
          (%raise obj)
          (let ((handler (car (%current-handlers)))
                (rest (cdr (%current-handlers))))
            (%set-handlers! rest)
            (handler obj)
            ;; handler returned for a non-continuable exception → secondary raise,
            ;; still with the popped stack (rest) in place.
            (raise (make-error-object
                     "exception handler returned for non-continuable exception")))))
    
    ;; raise-continuable: same pop discipline, but the handler's return value is
    ;; returned to the call site of raise-continuable. Restore the stack on the way
    ;; out so the value flows back into the original dynamic environment.
    (define (raise-continuable obj)
      (if (null? (%current-handlers))
          (%raise obj)
          (let ((handler (car (%current-handlers)))
                (rest (%current-handlers)))
            (%set-handlers! (cdr rest))
            (try
              (handler obj)
              (finally
                (%set-handlers! rest))))))
    
    ;; with-exception-handler installs handler for the duration of thunk and removes
    ;; it on the way out — via finally, which restores the stack whether thunk
    ;; returns normally OR escapes via a thrown exception (e.g. a handler that exits
    ;; through guard's catch). No catch+re-raise here: re-raising would re-deliver an
    ;; exception the inner handler already saw to the outer handler (double delivery).
    (define (with-exception-handler handler thunk)
      (let ((old-handlers (%current-handlers)))
        (%set-handlers! (cons handler old-handlers))
        (try
          (thunk)
          (finally
            (%set-handlers! old-handlers)))))
    
    (define (error message . irritants)
      (raise (apply make-error-object message irritants)))
    
    (define-macro (guard clause-and-body . rest)
      (let* ((var (car clause-and-body))
             (clauses (cdr clause-and-body))
             (body rest))
        \`(try
           (begin ,@body)
           (catch (,var)
             (cond
               ,@clauses
               (else (raise ,var)))))))
`,
});
