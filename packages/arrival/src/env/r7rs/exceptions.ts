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
import { nil, type ANil } from "../../values/primitives/ANil.js";
import { CONSTANT_CTX, type RunContext } from "../../values/primitives/RunContext.js";
import type { SchemeValue } from "../../values/types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Per-run isolation — the fix for the cross-request handler-stack leak.
// ─────────────────────────────────────────────────────────────────────────────
//
// This USED to be `let currentHandlers: unknown = nil;`, a single module-level mutable
// shared by EVERY env in the process. That is a real bug, not just an isolation nicety:
// this capability (like the rest of the base scheme stdlib — core/r7rs/srfi) is lowered
// EXACTLY ONCE per process, onto the singleton `user_env` (`eval/generator-exec.ts`'s
// `ensureBaseAssembled()`, gated by a cached `_baseAssembled` promise) — so a plain
// builder-form closure (`symbols: (activation) => ({...})`) would NOT have fixed this:
// the builder only runs once too, at that one shared `.lower()`. Nor does keying by the
// ENV OBJECT help in general: a bare `exec(src)` call with no `capabilities`/`env` option
// evaluates directly against that same shared `user_env` singleton with no per-call child
// scope, so two concurrent bare `exec()` calls share the identical env object as well.
//
// The one thing that IS both (a) fresh per top-level `exec()` call and (b) stable across
// every nested scope/lambda/let WITHIN that one call is `EvalContext.runCtx` — the
// `RunContext` `makeRunContext()` mints once per `exec()` (`values/primitives/RunContext.ts`),
// threaded by REFERENCE through every nested `{ ...ctx }` a frame builds. Keying a side
// WeakMap by that instance gives exactly the isolation R7RS's dynamic-extent handler stack
// needs: distinct across concurrent runs, shared across every scope inside one run (the
// `env.inherit()` case the original design called out). `RunContext.ts`'s own header notes
// the handler stack can't be stored ON a RunContext (it "VARIES by call depth", while
// RunContext's fields are `readonly`/constant-per-run) — a side WeakMap keyed BY the
// constant-per-run handle, holding the call-depth-varying stack, is the correct split, not
// a workaround. `ctx.runCtx` was scaffolded exactly for this migration (see its doc comment
// in eval/evaluator.ts: "ops read run-state off the holders today and migrate to ctx.runCtx
// ... at N2") — this is that migration landing, for this one holder.
//
// FALLBACK: `execGeneratorExpr` (used by `require`'s nested `.scm` module evaluation) does
// not mint a `runCtx`, so `ctx.runCtx` is `undefined` there; those calls (and any direct
// non-evaluator invocation, which carries no ctx at all) share ONE fallback bucket, keyed by
// `CONSTANT_CTX` — the package's existing "run-neutral" shared context singleton. That is
// EXACTLY today's pre-fix behavior for those call sites (one shared stack) — no regression,
// just not yet isolated; the remaining gap needs `runCtx` minted at that entry point too
// (`eval/generator-exec.ts`, outside this pack).
const handlerStacks = new WeakMap<RunContext, unknown>();

/** The minimal structural slice of `EvalContext` these machinery verbs need — NOT the full
 *  `EvalContext` (keeps this pack decoupled from evaluator.ts's evolving shape, mirroring
 *  `arrival-scheme-env-loader`'s `loader.ts` narrow ctx type for the same reason). */
interface HandlerCallCtx {
  runCtx?: RunContext;
}

/** Structural check for "does this look like the evaluator's appended ctx" — the same
 *  defensive shape `loader.ts`'s `popEvalContext` uses for its own `__withCtx` verbs, so a
 *  direct (non-evaluator) JS call degrades to the shared fallback bucket instead of
 *  mis-reading a real trailing scheme argument as ctx. */
function isEvalCtx(v: unknown): v is HandlerCallCtx {
  return typeof v === "object" && v !== null && ("runCtx" in v || "resolver" in v);
}

/** Pop the evaluator-appended ctx off a `__withCtx` impl's raw args (always the LAST
 *  element when present — the evaluator does `[...wrappedArgs, ctx]` unconditionally). */
function popCtx(args: unknown[]): HandlerCallCtx | undefined {
  const last = args.at(-1);
  if (isEvalCtx(last)) {
    args.pop();
    return last;
  }
  return undefined;
}

const runKeyOf = (ctx: HandlerCallCtx | undefined): RunContext => ctx?.runCtx ?? CONSTANT_CTX;

export default new EnvCapability("scheme/r7rs/exceptions", {
  symbols: {
    // Throw the object directly (not wrapped in an Error with toString) — preserves
    // the original object type for R7RS exception handling.
    "%raise": symbol.native`%raise: throw obj directly (machinery — the R7RS forms build on this)`(
      // `obj` is genuinely ANY scheme value (raise accepts arbitrary data, R7RS §6.11) —
      // `z.value` is the typed, representation-blind replacement for `z.unknown()` at this
      // kind of slot (scheme-zod.ts's own documented convention). Output is `z.never()`:
      // the impl's own declared return type is `never` — it always throws.
      { input: [z.value], output: [z.never()] },
      (obj: unknown): never => {
        throw obj;
      },
    ),
    // Read / replace the handler stack (machinery; the R7RS forms push/pop through these
    // instead of mutating a scheme binding with `set!`). `__withCtx: true` so each call
    // reads the invoking run's `RunContext` off the evaluator-appended ctx (see the
    // per-run-isolation block above) — from SCHEME's perspective these are still ordinary
    // zero/one-arg calls; the ctx channel is invisible to the calling scheme code.
    "%current-handlers": symbol.native`%current-handlers: read the exception-handler stack (machinery)`(
      // The stack is a proper scheme list (nil, or a pair of a handler procedure + the rest
      // of the stack) — scheme-zod has no dedicated "list of procedures" vocabulary item, so
      // `z.value` (the representation-blind scheme-value identity) is the richest honest
      // ceiling here, tighter than the old `z.unknown()` (host-blind).
      { input: [], output: [z.value] },
      Object.assign(
        (...args: unknown[]): SchemeValue => {
          const ctx = popCtx(args);
          // Opaque storage (native ops run no validation) — the boundary cast states what
          // every write below actually stores: a scheme value (nil, or a handler-stack pair).
          return (handlerStacks.get(runKeyOf(ctx)) ?? nil) as SchemeValue;
        },
        { __withCtx: true as const },
      ),
    ),
    "%set-handlers!": symbol.native`%set-handlers!: replace the exception-handler stack (machinery)`(
      // Input is the same list shape `%current-handlers` reads (see above). Output is
      // ALWAYS `nil` (the impl's own `return nil`) — `z.nil` is the exact honest type here,
      // not merely a wide one.
      { input: [z.value], output: [z.nil] },
      Object.assign(
        (...args: unknown[]): ANil => {
          const ctx = popCtx(args);
          const [handlers] = args;
          handlerStacks.set(runKeyOf(ctx), handlers);
          return nil;
        },
        { __withCtx: true as const },
      ),
    ),
    "make-error-object": symbol.native`make-error-object: build an R7RS error object from a message and irritants`(
      // `message` is display-rendered via `.valueOf()`/`String()` regardless of scheme type
      // (see the impl) — `z.value`. `irritants` are carried through untouched (any scheme
      // values, stored as-is on the error object) — `z.value` for the rest too. Output is a
      // real validator (`instanceof R7RSError`): the impl always returns this ONE concrete
      // host `Error` subclass, never an arbitrary scheme value.
      {
        input: [z.value],
        inputRest: z.value,
        output: [z.custom<R7RSError>((v) => v instanceof R7RSError)],
      },
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
