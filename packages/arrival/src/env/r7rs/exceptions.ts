// @here.build/arrival/r7rs/exceptions — R7RS-small §6.11 exception handling:
// *current-exception-handlers*, raise, raise-continuable, with-exception-handler,
// error, and the guard derived syntax.
//
// The OPPOSITE face of the purity doors (r7rs/control for dynamics, the type
// packs for mutators): those doors name what arrival omits for provenance
// soundness; this pack supplies the exception forms it keeps. Built on the host
// try/catch/finally special forms + the `%raise`/`%current-handlers`/
// `%set-handlers!`/`make-error-object` machinery below, all owned here —
// `scheme/exceptions` (error-objects.ts) is just the R7RS predicate surface
// (error-object?/error-object-message/etc).
//
// SINGLE SOURCE: this module is the sole definition site for both the machinery
// and the derived forms — no cross-capability ordering dependency remains.
//
// HANDLER-STACK LAW: the stack lives in a `WeakMap<RunContext, stack>` (declared
// below), never in a scheme binding or a module-level mutable slot. A
// `RunContext` is minted once per top-level `exec()` call and threaded BY
// REFERENCE through every nested scope/lambda/let within that call — including
// across a `symbol.define` → `symbol.define` call boundary (`define-bake.ts`'s
// `buildDefineProcedure` forwards the caller's real `runCtx` into
// `call_function`, so both sides of the boundary observe the SAME `RunContext`
// identity). That's what makes the WeakMap keying sound: the handler stack is
// fresh per top-level `exec()`, shared across every nested frame inside it, and
// isolated from any other concurrent `exec()` sharing the same isolate — each
// run's stack is keyed to its own `RunContext` identity, with no shared-isolate
// caveat needed.
//
// Every `symbol.define` body below still avoids bare `car`/`cdr`/`cons` and
// scheme-level `try`/`catch`/`finally`, routing instead through this
// capability's own machinery natives (`%handler-car`, `%handler-cdr`,
// `%with-restore`, etc.) — not because those forms are unsafe inside a
// `symbol.define` body (both are bakeable: `define-bake.ts`'s FV allowlist
// recognizes the `car`/`cdr` family as resolver-synthesized rather than
// capability exports, and `free-vars.ts` models `try`/`catch`/`finally` as a
// special form with `catch`'s bound var properly scoped to its handler body) —
// but because folding these bodies back onto the plain forms is a deferred
// cleanup, not done here; the dedicated machinery natives are correct and
// tested as they stand.
import { EnvCapability } from "../../common/capability.js";
import { symbol } from "../../common/symbol.js";
import * as z from "../../common/scheme-zod.js";
import { R7RSError } from "../../errors.js";
import { AString } from "../../values/primitives/AString.js";
import { ANil, nil } from "../../values/primitives/ANil.js";
import { APair } from "../../values/primitives/APair.js";
import { applyCallback, type CallResult } from "../../values/primitives/ACallable.js";
import type { RunContext } from "../../values/primitives/RunContext.js";
import type { SchemeValue } from "../../values/types.js";
import { schemeBool as bool } from "../../values/op-helpers.js";
import { to_array } from "../pack-helpers.js";
import invariant from "tiny-invariant";

// Per-run isolation, keyed by RunContext identity — see the file header's
// HANDLER-STACK LAW: fresh per top-level `exec()`, shared across every nested
// frame within it, isolated from any other concurrent `exec()` on the same
// isolate.
const handlersByRun = new WeakMap<RunContext, SchemeValue>();

// R7RS raise/raise-continuable/error carry ARBITRARY data (§6.11: "obj may be any
// object") — critically INCLUDING the R7RSError condition objects `error`/
// `make-error-object` construct. `z.value`'s `isSchemeValue` predicate is
// `instanceof AValue` (membrane.ts) — an `R7RSError` is a raw host `Error`
// subclass, deliberately NOT an `AValue` box (`z.error`'s own codec exists
// precisely because it isn't one), so `z.value` alone REJECTS a condition object.
// A bare `native` contract never enforced this (native contracts are types-only)
// — but `symbol.define`'s contract IS enforced at the call boundary, so this
// pack's own condition objects must be an explicit member of every slot that can
// carry a raised/returned value: `(guard (exn (else exn)) (error "BOOM!" 1 2 3))`
// round-trips a real R7RSError through exactly `raise`'s `obj` slot.
const raisable = z.union([z.value, z.error]);

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
    // are ordinary zero/one-arg calls.
    "%current-handlers": symbol.native`%current-handlers: read the exception-handler stack (machinery)`(
      // The stack is a proper scheme list (nil, or a pair of a handler procedure + the rest
      // of the stack) — scheme-zod has no dedicated "list of procedures" vocabulary item, so
      // `z.value` (representation-blind scheme-value identity) is the honest ceiling here.
      { input: [], output: [z.value] },
      // Non-arrow: `this.runCtx` is the CallCtx receiver `symbol.native` dispatches
      // with (the same convention `%push-handler` below already uses) — the WeakMap
      // key. Absent entry ⇒ this run has never pushed a handler yet ⇒ empty stack.
      function (): SchemeValue {
        return (handlersByRun.get(this.runCtx) ?? nil) as SchemeValue;
      },
    ),
    "%set-handlers!": symbol.native`%set-handlers!: replace the exception-handler stack (machinery)`(
      // Input is the same list shape `%current-handlers` reads (see above). Output is
      // ALWAYS `nil` (the impl's own `return nil`) — `z.nil` is the exact honest type here,
      // not merely a wide one.
      { input: [z.value], output: [z.nil] },
      function (handlers) {
        handlersByRun.set(this.runCtx, handlers as SchemeValue);
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

    // ── Handler-stack machinery ──────────────────────────────────────────────────
    // car/cdr/cons, specifically — never a general-purpose accessor. Existing
    // solely so the `symbol.define` bodies below never reference bare
    // `car`/`cdr`/`cons` directly (see the file header).
    "%handlers-empty?": symbol.native`%handlers-empty?: is the exception-handler stack empty (machinery)`(
      { input: [z.value], output: [z.boolean] },
      (stack) => bool(stack instanceof ANil),
    ),
    "%handler-car": symbol.native`%handler-car: the top handler of a non-empty exception-handler stack (machinery)`(
      { input: [z.value], output: [z.value] },
      (stack) => {
        invariant(stack instanceof APair, "%handler-car: the exception-handler stack is empty");
        return stack.car as SchemeValue;
      },
    ),
    "%handler-cdr": symbol.native`%handler-cdr: the exception-handler stack minus its top handler (machinery)`(
      { input: [z.value], output: [z.value] },
      (stack) => {
        invariant(stack instanceof APair, "%handler-cdr: the exception-handler stack is empty");
        return stack.cdr as SchemeValue;
      },
    ),
    "%push-handler": symbol.native`%push-handler: prepend handler onto the exception-handler stack (machinery)`(
      { input: [z.value, z.value], output: [z.value] },
      function (handler, stack) {
        return new APair(this.runCtx, handler as SchemeValue, stack as SchemeValue);
      },
    ),
    // The finally-discipline, kept out of scheme-level `try`/`finally` (see the
    // file header): call `thunk` (0-arg), always call `restore` (0-arg) on the
    // way out — whether `thunk` returned normally or threw — and return/rethrow
    // accordingly.
    "%with-restore": symbol.native`%with-restore: call thunk, always calling restore afterward — even if thunk throws (machinery)`(
      { input: [z.lambda, z.lambda], output: [z.value] },
      function (thunk, restore) {
        const runCtx = this.runCtx;
        const doRestore = (): CallResult => applyCallback(restore, [], runCtx);
        let result: unknown;
        try {
          result = applyCallback(thunk, [], runCtx);
        } catch (e) {
          doRestore();
          throw e;
        }
        if (result instanceof Promise) {
          return result.then(
            async (v) => {
              await doRestore();
              return v;
            },
            async (e) => {
              await doRestore();
              throw e;
            },
          ) as unknown as SchemeValue;
        }
        doRestore();
        return result as SchemeValue;
      },
    ),
    // `error`'s message+irritants forwarding needs a scheme-list → variadic-args
    // splice (i.e. `apply`) — `apply` IS a genuine `scheme/lists` export (not a
    // resolver-synthesized name like car/cdr), but depending on `scheme/lists`
    // just for this one splice would reintroduce a cross-capability ordering
    // dependency this pack's header states it has none of — so the splice moves
    // into this native instead, reusing `make-error-object`'s own construction
    // logic.
    "%error-object-from-irritants": symbol.native`%error-object-from-irritants: build an R7RS error object from a message and a scheme list of irritants (machinery)`(
      { input: [z.string, z.value], output: [z.error] },
      (message, irritantsList) => {
        const msg = message instanceof AString ? message.valueOf() : String(message);
        const irritants = to_array("error")(irritantsList as SchemeValue);
        return new R7RSError(msg, ...irritants);
      },
    ),

    // R7RS §6.11: raise invokes the current handler in the dynamic environment of
    // the call to raise, except that the current exception handler is the one that
    // was in place when THIS handler was installed (i.e. the rest of the stack).
    // So we POP the handler before invoking it — otherwise a raise inside the
    // handler re-reads the same car and recurs forever. If a non-continuable
    // handler returns, a secondary exception is raised in the handler's dynamic
    // environment (the popped stack still in place).
    raise: symbol.define`raise: invoke the current exception handler with obj (R7RS §6.11) — pops the handler first so a raise inside it can't loop on the same entry`(
      { input: [raisable], output: [z.undefinedResult] },
      `(lambda (obj)
         (if (%handlers-empty? (%current-handlers))
             (%raise obj)
             (let ((handler (%handler-car (%current-handlers)))
                   (rest (%handler-cdr (%current-handlers))))
               (%set-handlers! rest)
               (handler obj)
               ;; handler returned for a non-continuable exception → secondary raise,
               ;; still with the popped stack (rest) in place.
               (raise (make-error-object
                        "exception handler returned for non-continuable exception")))))`,
    ),

    // raise-continuable: same pop discipline, but the handler's return value is
    // returned to the call site of raise-continuable. Restore the stack on the way
    // out so the value flows back into the original dynamic environment.
    "raise-continuable": symbol.define`raise-continuable: like raise, but the handler's return value flows back to raise-continuable's own call site (R7RS §6.11)`(
      // OUTPUT widened with `z.values` (the srfi-1 span/break/partition precedent):
      // the handler is arbitrary user code and may legally return via `(values …)`, whose
      // `Values` box is a non-AValue orphan `z.value`/`z.error` both reject at the decode
      // boundary (scheme-zod's `values` doc). INPUT stays `raisable` — you cannot *raise*
      // multiple values, so the raise domain must not widen; only the return path does.
      { input: [raisable], output: [z.union([z.value, z.error, z.values])] },
      `(lambda (obj)
         (if (%handlers-empty? (%current-handlers))
             (%raise obj)
             (let ((handler (%handler-car (%current-handlers)))
                   (rest (%current-handlers)))
               (%set-handlers! (%handler-cdr rest))
               (%with-restore (lambda () (handler obj))
                               (lambda () (%set-handlers! rest))))))`,
    ),

    // with-exception-handler installs handler for the duration of thunk and removes
    // it on the way out — via the %with-restore finally-discipline, which restores
    // the stack whether thunk returns normally OR escapes via a thrown exception
    // (e.g. a handler that exits through guard's catch). No catch+re-raise here:
    // re-raising would re-deliver an exception the inner handler already saw to the
    // outer handler (double delivery).
    "with-exception-handler": symbol.define`with-exception-handler: install handler for the dynamic extent of thunk, removed on the way out (R7RS §6.11)`(
      // OUTPUT is `z.union([z.value, z.values])`: R7RS returns "the results of invoking
      // thunk", and thunk is arbitrary user code that may return via `(values …)` — the
      // same `Values`-orphan gap `z.value` misses (srfi-1 span/break/partition precedent).
      { input: [z.lambda, z.lambda], output: [z.union([z.value, z.values])] },
      `(lambda (handler thunk)
         (let ((old-handlers (%current-handlers)))
           (%set-handlers! (%push-handler handler old-handlers))
           (%with-restore thunk
                           (lambda () (%set-handlers! old-handlers)))))`,
    ),

    error: symbol.define`error: raise a new error object built from message and irritants (R7RS §6.11)`(
      { input: [z.string], inputRest: raisable, output: [z.undefinedResult] },
      `(lambda (message . irritants)
         (raise (%error-object-from-irritants message irritants)))`,
    ),

    guard: symbol.defineSyntax`guard: (guard (var clause…) body…) — evaluate body, dispatching a raised condition through clause with var bound to it (R7RS §6.11 derived syntax)`(
      // `var` is a FORMALS-position binder (bound across every clause), matching
      // `let-values`/`let*-values`'s own "binder" classification — NOT
      // "expression" (an expression-space walk would wrongly report `var`
      // unbound in every clause referencing it).
      `(lambda (clause-and-body . rest)
         (let* ((var (car clause-and-body))
                (clauses (cdr clause-and-body))
                (body rest))
           \`(try
              (begin ,@body)
              (catch (,var)
                (cond
                  ,@clauses
                  (else (raise ,var)))))))`,
      { macroAttribute: "binder" },
    ),
  },
});
