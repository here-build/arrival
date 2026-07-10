// @here.build/arrival/r7rs/exceptions — R7RS-small §6.11 exception handling:
// *current-exception-handlers*, raise, raise-continuable, with-exception-handler,
// error, and the guard derived syntax.
//
// The OPPOSITE face of the purity doors (r7rs/control for dynamics, the type
// packs for mutators): those doors name what arrival omits for provenance
// soundness; this pack supplies the exception forms it keeps. Built on the host
// try/catch/finally special forms + the `%raise`/`%current-handlers`/
// `%set-handlers!`/`make-error-object` machinery below, all owned here —
// `scheme/exceptions` (error-objects.ts, the last survivor of the deleted
// bridge.ts monolith) is now just the R7RS predicate surface
// (error-object?/error-object-message/etc).
//
// SINGLE SOURCE: this module is the sole definition site for both the machinery
// and the derived forms — no cross-capability ordering dependency remains.
//
// docs/working-proposals/symbol-define-static-program-validation.md §4 (W4) —
// `symbol.define`/`symbol.defineSyntax` decomposition of this pack's former
// `prelude` text blob. THREE landed-machinery gaps surfaced migrating THIS pack
// specifically — all three are FIXED now (PRE-H2 machinery fix wave), upstream in
// `define-bake.ts`/`free-vars.ts`, not in this file:
//
//   (1) FIXED — `car`/`cdr` (and the whole `c[ad]+r` family) are NOT a
//       capability-declared export anywhere — `env/r7rs/lists.ts`'s own header
//       says so explicitly ("served by a resolver, not this pack") — they're
//       synthesized by a KERNEL-level fallback (`eval/Resolver.ts`'s `cxrUnfold`,
//       consulted only AFTER an ordinary env-lookup miss, never registered as a
//       per-capability `ResolverSpec`). `define-bake.ts` now recognizes the same
//       `CXR_RE` pattern directly in its bake FV allowlist (a local copy of the
//       same regex `static-validation/vocabulary.ts` and `eval/Resolver.ts`
//       already carry, per their documented local-copy convention) — a
//       `symbol.define` body referencing bare `car`/`cadr`/etc. bakes clean.
//   (2) FIXED — `free-vars.ts` now models the `try` special form (a `case "try"`
//       arm mirroring `static-validation/collect-references.ts`'s "try" arm 1:1):
//       the body walks in the outer scope, `catch`'s bound var scopes its handler
//       body, and both the `catch`/`finally` clause-marker heads are recognized as
//       structural literals — never added to the free-variable set (previously
//       they fell through the unmodeled-head default-arm application walk and
//       leaked in as unresolvable names).
//   (3) FIXED — `define-bake.ts`'s `buildDefineProcedure` now threads the
//       CALLER's `RunContext` into the scheme body it evaluates: `impl` declares
//       its second parameter (`runCtx`, matching `ANativeProcedure["arrival/
//       tagless-final/apply"]`'s `impl(args, runCtx)` invocation) and forwards it
//       into `call_function(closure, args, { runCtx })`. Verified empirically (a
//       tagged-WeakMap probe, removed before landing this file): a `symbol.define`
//       → `symbol.define` call boundary (e.g. `with-exception-handler`'s thunk
//       calling `raise-continuable`) used to observe TWO DIFFERENT `RunContext`-
//       shaped objects on either side of the crossing (neither the frozen
//       `CONSTANT_CTX` singleton). With the thread fixed, both sides see the SAME
//       `RunContext` — restoring the precondition a `WeakMap<RunContext, …>`-keyed
//       dynamic-extent slot needs. This affected every pack with per-run
//       dynamic-extent state touched across a `symbol.define` boundary, not just
//       this one.
//
// WORKAROUND STATUS (this pack only): gap (3)'s fix means the handler stack's
// `RunContext` keying below is now REVERTED to the textbook-correct
// `WeakMap<RunContext, …>` (see its declaration below) — no longer the
// module-level mutable slot this comment used to describe. Gaps (1)/(2)'s pack-
// authoring workaround is left AS-IS on purpose (a separate, optional cleanup, not
// a correctness fix): every `symbol.define` body below still avoids bare
// `car`/`cdr`/`cons`/`apply` and scheme-level `try`/`catch`/`finally`, routing
// through this capability's OWN machinery natives (`%handler-car`, `%with-restore`,
// etc.) instead. Now that gaps (1)/(2) are closed upstream, those bodies COULD fold
// back into plain `car`/`cdr`/`cons`/`try`/`catch`/`finally` — noted for a future
// pass, not done here (out of this fix wave's scope; the natives are correct and
// tested as they stand).
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

// Per-run isolation — REVERTED to the textbook-correct shape (gap (3), now fixed
// upstream in `define-bake.ts`'s `buildDefineProcedure`): the handler stack must
// be fresh per top-level `exec()` call but shared across every nested
// scope/lambda/let WITHIN that call. `WeakMap<RunContext, stack>` (`RunContext`
// minted once per `exec()`, threaded by reference through every nested frame) is
// exactly what the PRE-migration prelude-evaluated forms used, and what this pack
// used itself before gap (3) forced the module-level-slot workaround: with
// `buildDefineProcedure` now threading the caller's real `runCtx` all the way
// through `call_function`, a `symbol.define`→`symbol.define` call boundary (e.g.
// `with-exception-handler`'s thunk calling `raise-continuable`) observes the SAME
// `RunContext` on both sides, so the WeakMap no longer "forgets" a handler the
// moment it crosses that boundary. This closes the LIMIT the module-level slot
// conceded (concurrent `exec()` calls sharing one isolate could observe each
// other's handler stack) — each run's stack is now keyed to its own `RunContext`
// identity, isolated by construction, no shared-isolate caveat needed.
const handlersByRun = new WeakMap<RunContext, SchemeValue>();

// R7RS raise/raise-continuable/error carry ARBITRARY data (§6.11: "obj may be any
// object") — critically INCLUDING the R7RSError condition objects `error`/
// `make-error-object` construct. `z.value`'s `isSchemeValue` predicate is
// `instanceof AValue` (membrane.ts) — an `R7RSError` is a raw host `Error`
// subclass, deliberately NOT an `AValue` box (`z.error`'s own codec exists
// precisely because it isn't one), so `z.value` alone REJECTS a condition object.
// A bare `native` contract never enforced this (native contracts are types-only,
// design doc §1.2) — but `symbol.define`'s contract IS enforced at the call
// boundary, so this pack's own condition objects must be an explicit member of
// every slot that can carry a raised/returned value. Verified against the chibi
// R7RS conformance corpus: `(guard (exn (else exn)) (error "BOOM!" 1 2 3))`
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

    // ── the header's WORKAROUND natives (new in this migration) ─────────────────────
    // Handler-stack car/cdr/cons, specifically — never a general-purpose accessor.
    // Existing solely so the `symbol.define` bodies below never reference bare
    // `car`/`cdr`/`cons` (gap (1) above).
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
    // The finally-discipline, kept out of scheme-level `try`/`finally` (gap (2)
    // above): call `thunk` (0-arg), always call `restore` (0-arg) on the way out —
    // whether `thunk` returned normally or threw — and return/rethrow accordingly.
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
    // gap-(1) resolver-synth name), but depending on `scheme/lists` just for this
    // one splice would reintroduce the cross-capability ordering this pack's header
    // deliberately eliminated (bridge.ts's dissolution) — so the splice moves into
    // this native instead, reusing `make-error-object`'s own construction logic.
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
      // OUTPUT widened with `z.values` (W4-H4, the srfi-1 span/break/partition precedent):
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
      // receive/let-values/and-let*'s "binder" classification (§3.4) — NOT
      // "expression" (a boolean-transparent walk would report `var` unbound in
      // every clause referencing it).
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
