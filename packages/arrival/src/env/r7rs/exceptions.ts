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
// specifically (all verified against HEAD, none fixed here — this file's
// territory is this pack alone; `define-bake.ts`/`free-vars.ts` are read-only
// consumed machinery):
//
//   (1) `car`/`cdr` (and the whole `c[ad]+r` family) are NOT a capability-declared
//       export anywhere — `env/r7rs/lists.ts`'s own header says so explicitly
//       ("served by a resolver, not this pack") — they're synthesized by a
//       KERNEL-level fallback (`eval/Resolver.ts`'s `cxrUnfold`, consulted only
//       AFTER an ordinary env-lookup miss, never registered as a per-capability
//       `ResolverSpec`). `static-validation/vocabulary.ts` (W3) already re-derives
//       the same `CXR_RE` regex to special-case this for the VALIDATOR; the W1 bake
//       law in `define-bake.ts` (`resolverAnswers`) has NO equivalent — it only
//       probes `deps`' own declared `spec.resolvers`, and no capability anywhere
//       registers one for cxr. A `symbol.define` body referencing bare `car`/`cdr`
//       throws `DefineLocalityError` at bake, unconditionally, today.
//   (2) `free-vars.ts` does not model the `try` special form at all (confirmed:
//       no `case "try"` in its switch) — `try` itself only resolves because it is
//       ALSO a `KEYWORD_SYNTAX_BASELINE` entry, but a `try`'s `(catch (var) …)` /
//       `(finally …)` sub-clauses are walked as ORDINARY APPLICATIONS (the
//       `default: break` arm), so their `catch`/`finally` head symbols leak into
//       the free-variable set — and neither is bound anywhere (core.ts's keyword
//       list stops at `try` itself; `catch`/`finally` are pure syntactic markers
//       `evalTry` recognizes by NAME on the raw parsed form, mirroring how `else`/
//       `=>` are recognized in `cond` — but `cond`'s `else`/`=>` names ARE
//       special-cased out of `freeVars`'s walk (see its `case "cond"` arm); `try`
//       has no equivalent arm at all, so no such exclusion exists for it).
//   (3) `define-bake.ts`'s `buildDefineProcedure` does not thread the CALLER's
//       `RunContext` into the scheme body it evaluates: its `impl: (args) => {…}`
//       declares only ONE parameter, but `ANativeProcedure["arrival/tagless-final/
//       apply"]` invokes it as `impl(args, runCtx)` — the real per-call `runCtx` is
//       silently unbound inside the closure, and the subsequent `call_function
//       (closure, args)` call passes NO third argument. Verified empirically (a
//       tagged-WeakMap probe, removed before landing this file): a `symbol.define`
//       → `symbol.define` call boundary (e.g. `with-exception-handler`'s thunk
//       calling `raise-continuable`) observes TWO DIFFERENT `RunContext`-shaped
//       objects on either side of the crossing (neither the frozen `CONSTANT_CTX`
//       singleton — some other per-call identity is in play, not fully traced).
//       Consequence: a `WeakMap<RunContext, …>` keyed dynamic-extent slot — the
//       PRE-migration `raise`/`raise-continuable`/`with-exception-handler` used
//       exactly this, unchanged, and it worked, because prelude-evaluated code
//       never crossed a `call_function`/`ANativeProcedure` re-entry boundary —
//       cannot survive a `symbol.define`-to-`symbol.define` call, even within ONE
//       `exec()`. This affects every pack with per-run dynamic-extent state
//       touched across a `symbol.define` boundary, not just this one — filed for
//       the wave orchestrator, not fixed here.
//
// WORKAROUND (this pack only): every `symbol.define` body below is written using
// ONLY this capability's OWN machinery natives + `KEYWORD_SYNTAX_BASELINE` names —
// zero external `deps`, zero scheme-level `try`/`catch`/`finally`, zero bare
// `car`/`cdr`/`cons`/`apply` (closes gaps (1)/(2)). The handler stack itself drops
// its `RunContext` keying for a single module-level mutable slot (closes gap (3) —
// see the LIMIT note at its declaration below). Once all three gaps close
// upstream, the natives can fold back into plain `car`/`cdr`/`cons`/`try`/`catch`/
// `finally` in the bodies and the stack can go back to being `RunContext`-keyed —
// noted so a future pass can simplify, not because today's shape is wrong.
import { EnvCapability } from "../../common/capability.js";
import { symbol } from "../../common/symbol.js";
import * as z from "../../common/scheme-zod.js";
import { R7RSError } from "../../errors.js";
import { AString } from "../../values/primitives/AString.js";
import { ANil, nil } from "../../values/primitives/ANil.js";
import { APair } from "../../values/primitives/APair.js";
import { applyCallback, type CallResult } from "../../values/primitives/ACallable.js";
import type { SchemeValue } from "../../values/types.js";
import { schemeBool as bool } from "../../values/op-helpers.js";
import { to_array } from "../pack-helpers.js";
import invariant from "tiny-invariant";

// Per-run isolation — INTENDED design, currently DOWNGRADED (gap (3) above): the
// handler stack must be fresh per top-level `exec()` call but shared across every
// nested scope/lambda/let WITHIN that call. Textbook-correct is a
// `WeakMap<RunContext, stack>` (`RunContext` minted once per `exec()`, threaded by
// reference through every nested frame) — exactly what the PRE-migration
// prelude-evaluated forms used, verified working, because prelude code never
// crossed a `call_function`/`ANativeProcedure` re-entry boundary. Now that
// `raise`/`raise-continuable`/`with-exception-handler` are `symbol.define` bodies,
// EVERY interaction between them crosses that boundary, and gap (3) means the
// `RunContext` on either side of the crossing is not reliably the same object —
// so a `WeakMap<RunContext, …>` silently "forgets" a handler `with-exception-
// handler` just installed the moment `raise-continuable` reads it back.
//
// WORKAROUND: a single module-level mutable slot, no `RunContext` key. LIMIT this
// concedes, honestly: concurrent `exec()` calls sharing one isolate (the base
// packs lower ONCE onto a shared `user_env` singleton — see `env-roots.ts`) could
// observe each other's handler stack if BOTH are mid-flight inside a
// `with-exception-handler` dynamic extent at the same JS tick. `exec()`'s driving
// loop completes one top-level form before dispatching the next (verified against
// `execState`), so this is a narrow window — it only matters for genuinely
// concurrent, unrelated programs racing inside the SAME process on the SAME
// shared base env. Revert to the `WeakMap<RunContext, …>` this comment describes
// the moment `buildDefineProcedure` threads `runCtx` correctly (gap (3)).
let currentHandlerStack: unknown = nil;

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
      (): SchemeValue => currentHandlerStack as SchemeValue,
    ),
    "%set-handlers!": symbol.native`%set-handlers!: replace the exception-handler stack (machinery)`(
      // Input is the same list shape `%current-handlers` reads (see above). Output is
      // ALWAYS `nil` (the impl's own `return nil`) — `z.nil` is the exact honest type here,
      // not merely a wide one.
      { input: [z.value], output: [z.nil] },
      (handlers) => {
        currentHandlerStack = handlers;
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
      { input: [raisable], output: [raisable] },
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
      { input: [z.lambda, z.lambda], output: [z.value] },
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
