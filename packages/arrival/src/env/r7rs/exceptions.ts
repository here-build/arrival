// @here.build/arrival/r7rs/exceptions — R7RS §6.11 exception handling.
//
// Lineage: R7RS-small (Shinn, Cowan & Gleckler, eds., 2013) §6.11 — the
// exception system: *current-exception-handlers*, raise, raise-continuable,
// with-exception-handler, error, and the guard derived syntax.
//
// These are the OPPOSITE face of the purity doors in core (`core.ts`): the doors
// name what R7RS arrival omits (dynamics + mutators) for provenance soundness;
// this pack supplies the exception forms it keeps. It depends on the host try /
// catch / finally + %raise primitives, on which the exception forms are built.
//
// SINGLE SOURCE: `base-packs.ts` assembles this capability's prelude and evals
// it (via initBridge's assembleEnv), so this module is the sole definition site.
import { EnvCapability } from "../capability.js";

export const EXCEPTIONS_SCM = `    ;; -----------------------------------------------------------------------------
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
`;

export default new EnvCapability("scheme/r7rs/exceptions", { prelude: EXCEPTIONS_SCM });
