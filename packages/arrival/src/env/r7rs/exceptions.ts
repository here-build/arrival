// @here.build/arrival/r7rs/exceptions — R7RS §6.11 exception handling.
//
// Lineage: R7RS-small (Shinn, Cowan & Gleckler, eds., 2013) §6.11 — the
// exception system: *current-exception-handlers*, raise, raise-continuable,
// with-exception-handler, error, and the guard derived syntax.
//
// These are the OPPOSITE face of the purity doors (now co-located in the packs that
// own them — r7rs/control for dynamics, the type packs for mutators): those doors
// name what R7RS arrival omits for provenance soundness;
// this pack supplies the exception forms it keeps. Built on the host try/catch/
// finally special forms + the `%raise`/`%current-handlers`/`%set-handlers!`/
// `make-error-object` machinery below — OWNED here (moved from bridge.ts's
// `scheme/exceptions` pack, whose prelude this WAS calling straight into with no
// explicit `deps` ever declaring that link — a roster-order accident, not a real
// dependency declaration). `scheme/exceptions` (bridge.ts) is now JUST the genuine
// R7RS predicate surface (error-object?/error-object-message/etc.); the exception
// FORMS and everything they need to run are self-contained in this ONE capability.
//
// SINGLE SOURCE: this module is the sole definition site for both the machinery
// and the derived forms — no cross-capability ordering dependency remains.
import { EnvCapability } from "../../common/capability.js";
import { symbol } from "../../common/symbol.js";
import * as z from "../../common/scheme-zod.js";
import { R7RSError } from "../../errors.js";
import { AString } from "../../values/primitives/AString.js";
import { nil } from "../../values/primitives/ANil.js";

// The R7RS exception handler stack — a module-level holder (the dynamic-holder family,
// alongside the evaluator's _dynamicCallSite/_currentRunEnv). Replaces the old set!'d
// `*current-exception-handlers*` scheme cell: the R7RS exception forms push/pop it via
// the `%current-handlers`/`%set-handlers!` primitives below, so NO scheme `set!` remains.
// Process-global (same dynamic visibility a deep `raise` needs); per-run isolation lands
// later when the dynamic holders thread per-run through the trampoline.
let currentHandlers: unknown = nil;

export default new EnvCapability("scheme/r7rs/exceptions", {
  symbols: {
    // Throw the object directly (not wrapped in an Error with toString) — preserves
    // the original object type for R7RS exception handling.
    "%raise": symbol.native`%raise: throw obj directly (machinery — the R7RS forms build on this)`(
      { input: [z.unknown()], output: [z.unknown()] },
      (obj: unknown): never => {
        throw obj;
      },
    ),
    // Read / replace the handler stack (machinery; the R7RS forms push/pop through these
    // instead of mutating a scheme binding with `set!`).
    "%current-handlers": symbol.native`%current-handlers: read the exception-handler stack (machinery)`(
      { input: [], output: [z.unknown()] },
      (): unknown => currentHandlers,
    ),
    "%set-handlers!": symbol.native`%set-handlers!: replace the exception-handler stack (machinery)`(
      { input: [z.unknown()], output: [z.unknown()] },
      (handlers: unknown): unknown => {
        currentHandlers = handlers;
        return nil;
      },
    ),
    "make-error-object": symbol.native`make-error-object: build an R7RS error object from a message and irritants`(
      { input: [z.unknown()], inputRest: z.unknown(), output: [z.unknown()] },
      (message: unknown, ...irritants: unknown[]): R7RSError => {
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
